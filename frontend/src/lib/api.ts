import { getToken } from './auth';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/api';

const PENDING_KEY = 'handsoff.pendingMutations';
const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/**
 * Operations that are safe to replay automatically after a reconnect because
 * they are idempotent (GET-like reads or PUT/DELETE with stable semantics).
 * Unsafe operations (POST/PATCH) must never be silently replayed.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 500;

export type ConnectionState = 'online' | 'offline' | 'reconnecting';

export interface PendingMutation {
  id: string;
  method: string;
  path: string;
  body?: unknown;
  idempotencyKey: string;
  createdAt: number;
  attempts: number;
  safe: boolean;
}

export interface ApiError extends Error {
  status?: number;
  offline?: boolean;
}

type ConnectionListener = (state: ConnectionState) => void;
type PendingListener = (pending: PendingMutation[]) => void;

const connectionListeners = new Set<ConnectionListener>();
const pendingListeners = new Set<PendingListener>();

let connectionState: ConnectionState =
  typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'online';

function readPending(): PendingMutation[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as PendingMutation[]) : [];
  } catch {
    return [];
  }
}

function writePending(pending: PendingMutation[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    /* storage unavailable; keep in-memory only */
  }
  pendingListeners.forEach((listener) => listener(pending));
}

function setConnectionState(next: ConnectionState): void {
  if (connectionState === next) return;
  connectionState = next;
  connectionListeners.forEach((listener) => listener(next));
}

export function getConnectionState(): ConnectionState {
  return connectionState;
}

export function subscribeConnection(listener: ConnectionListener): () => void {
  connectionListeners.add(listener);
  listener(connectionState);
  return () => connectionListeners.delete(listener);
}

export function getPendingMutations(): PendingMutation[] {
  return readPending();
}

export function subscribePending(listener: PendingListener): () => void {
  pendingListeners.add(listener);
  listener(readPending());
  return () => pendingListeners.delete(listener);
}

function createIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeError(message: string, status?: number, offline?: boolean): ApiError {
  const error = new Error(message) as ApiError;
  error.status = status;
  error.offline = offline;
  return error;
}

async function performRequest(mutation: PendingMutation): Promise<Response> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [IDEMPOTENCY_HEADER]: mutation.idempotencyKey,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  return fetch(`${API_BASE}${mutation.path}`, {
    method: mutation.method,
    headers,
    body: mutation.body === undefined ? undefined : JSON.stringify(mutation.body),
  });
}

/**
 * Attempt a mutation with a bounded retry policy. Only safe (idempotent)
 * operations are retried automatically; unsafe operations fail fast so the
 * caller can require explicit user confirmation before replaying.
 */
async function requestWithRetry(mutation: PendingMutation): Promise<Response> {
  let lastError: ApiError | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setConnectionState('offline');
      throw makeError('Network unavailable', undefined, true);
    }

    try {
      const response = await performRequest(mutation);
      if (response.status >= 500 && mutation.safe && attempt < MAX_RETRIES) {
        await delay(BASE_RETRY_DELAY_MS * 2 ** attempt);
        continue;
      }
      return response;
    } catch (error) {
      lastError = makeError((error as Error).message, undefined, true);
      if (!mutation.safe || attempt >= MAX_RETRIES) throw lastError;
      await delay(BASE_RETRY_DELAY_MS * 2 ** attempt);
    }
  }

  throw lastError ?? makeError('Request failed');
}

function enqueue(mutation: PendingMutation): void {
  const pending = readPending();
  if (pending.some((item) => item.idempotencyKey === mutation.idempotencyKey)) return;
  writePending([...pending, mutation]);
}

function dequeue(idempotencyKey: string): void {
  writePending(readPending().filter((item) => item.idempotencyKey !== idempotencyKey));
}

/**
 * Replay pending mutations after a reconnect. Safe operations are retried
 * automatically; unsafe operations are left queued for explicit user action.
 */
export async function replayPendingMutations(): Promise<void> {
  const pending = readPending();
  for (const mutation of pending) {
    if (!mutation.safe) continue;
    try {
      const response = await requestWithRetry({ ...mutation, attempts: mutation.attempts + 1 });
      if (response.ok) dequeue(mutation.idempotencyKey);
    } catch {
      /* keep queued for a later reconnect */
    }
  }
}

/**
 * Explicitly replay a single unsafe mutation after the user confirms it.
 */
export async function replayMutation(idempotencyKey: string): Promise<Response> {
  const mutation = readPending().find((item) => item.idempotencyKey === idempotencyKey);
  if (!mutation) throw makeError('No pending mutation to replay', 404);
  const response = await requestWithRetry({ ...mutation, attempts: mutation.attempts + 1 });
  if (response.ok) dequeue(idempotencyKey);
  return response;
}

export function discardMutation(idempotencyKey: string): void {
  dequeue(idempotencyKey);
}

function handleOnline(): void {
  setConnectionState('reconnecting');
  void replayPendingMutations().finally(() => setConnectionState('online'));
}

function handleOffline(): void {
  setConnectionState('offline');
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);
}

/**
 * Core request helper. Persists in-flight mutations so they survive reloads,
 * attaches an idempotency key to prevent duplicate submissions, and applies
 * the safe/unsafe retry policy.
 */
export async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const mutation: PendingMutation = {
    id: createIdempotencyKey(),
    method: method.toUpperCase(),
    path,
    body,
    idempotencyKey: createIdempotencyKey(),
    createdAt: Date.now(),
    attempts: 0,
    safe: isSafeMethod(method),
  };

  enqueue(mutation);

  try {
    const response = await requestWithRetry(mutation);
    if (!response.ok) {
      throw makeError(`Request failed with status ${response.status}`, response.status);
    }
    dequeue(mutation.idempotencyKey);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  } catch (error) {
    const apiError = error as ApiError;
    if (apiError.offline) {
      setConnectionState('offline');
      // Unsafe mutations stay queued for explicit replay; safe ones are retried
      // automatically on reconnect.
      if (mutation.safe) {
        void replayPendingMutations();
      }
    } else {
      dequeue(mutation.idempotencyKey);
    }
    throw apiError;
  }
}

export const api = {
  get: <T>(path: string) => apiRequest<T>('GET', path),
  post: <T>(path: string, body?: unknown) => apiRequest<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => apiRequest<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>('PATCH', path, body),
  delete: <T>(path: string) => apiRequest<T>('DELETE', path),
};
