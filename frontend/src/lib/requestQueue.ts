/**
 * Resilient offline / reconnect request queue.
 *
 * Responsibilities:
 *  - Persist in-flight mutations so they survive reloads and network loss.
 *  - Detect offline / reconnect transitions and expose them to the UI.
 *  - Apply a retry policy that distinguishes safe (idempotent) operations
 *    from unsafe ones.
 *  - Never silently replay unsafe mutations; they require explicit user action.
 *  - Prevent duplicate submissions of the same logical operation.
 */

export type RequestStatus =
  | 'pending'
  | 'in-flight'
  | 'succeeded'
  | 'failed'
  | 'awaiting-confirmation';

export type ConnectionState = 'online' | 'offline' | 'reconnecting';

export interface QueuedRequest<T = unknown> {
  /** Stable idempotency key; also used to dedupe submissions. */
  id: string;
  /** Logical operation name, e.g. 'createComment'. */
  operation: string;
  /** Whether the operation is safe to replay automatically. */
  idempotent: boolean;
  payload: T;
  status: RequestStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 15_000,
};

export interface RequestQueueOptions {
  storageKey?: string;
  retryPolicy?: RetryPolicy;
  /** Executes a request; resolves on success, rejects on failure. */
  executor: (request: QueuedRequest) => Promise<void>;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable storage for tests / SSR. */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
}

export interface QueueSnapshot {
  connection: ConnectionState;
  pending: number;
  inFlight: number;
  awaitingConfirmation: number;
  failed: number;
}

type Listener = (snapshot: QueueSnapshot) => void;

const DEFAULT_STORAGE_KEY = 'handsoff.requestQueue.v1';

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

/**
 * Compute the backoff delay for a given attempt using exponential backoff
 * with a cap. Attempts are 1-based.
 */
export function backoffDelay(attempt: number, policy: RetryPolicy): number {
  const exp = Math.max(0, attempt - 1);
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exp);
}

export class RequestQueue {
  private requests = new Map<string, QueuedRequest>();
  private listeners = new Set<Listener>();
  private connection: ConnectionState = 'online';
  private readonly storageKey: string;
  private readonly retryPolicy: RetryPolicy;
  private readonly executor: (request: QueuedRequest) => Promise<void>;
  private readonly now: () => number;
  private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  private draining = false;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: RequestQueueOptions) {
    this.storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.executor = options.executor;
    this.now = options.now ?? (() => Date.now());
    this.storage = options.storage ?? (isBrowser() ? window.localStorage : null);
    this.restore();
  }

  // --- persistence -------------------------------------------------------

  private restore(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as QueuedRequest[];
      for (const request of parsed) {
        // Anything that was mid-flight when we lost the page is now pending
        // again; unsafe operations must be confirmed before replay.
        const status: RequestStatus =
          request.status === 'in-flight'
            ? request.idempotent
              ? 'pending'
              : 'awaiting-confirmation'
            : request.status;
        this.requests.set(request.id, { ...request, status });
      }
    } catch {
      // Corrupt storage should never break the app; start clean.
      this.requests.clear();
    }
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.storageKey, JSON.stringify([...this.requests.values()]));
    } catch {
      // Storage may be full or unavailable; persistence is best-effort.
    }
  }

  // --- connection state --------------------------------------------------

  setConnection(state: ConnectionState): void {
    if (this.connection === state) return;
    this.connection = state;
    this.emit();
    if (state === 'online') {
      void this.drain();
    }
  }

  getConnection(): ConnectionState {
    return this.connection;
  }

  /**
   * Attach browser online/offline listeners. Returns a cleanup function.
   */
  attachNetworkListeners(target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): () => void {
    const onOnline = () => this.setConnection('online');
    const onOffline = () => this.setConnection('offline');
    target.addEventListener('online', onOnline);
    target.addEventListener('offline', onOffline);
    this.setConnection(isBrowser() && navigator.onLine === false ? 'offline' : 'online');
    return () => {
      target.removeEventListener('online', onOnline);
      target.removeEventListener('offline', onOffline);
    };
  }

  // --- subscription ------------------------------------------------------

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): QueueSnapshot {
    let pending = 0;
    let inFlight = 0;
    let awaitingConfirmation = 0;
    let failed = 0;
    for (const request of this.requests.values()) {
      if (request.status === 'pending') pending += 1;
      else if (request.status === 'in-flight') inFlight += 1;
      else if (request.status === 'awaiting-confirmation') awaitingConfirmation += 1;
      else if (request.status === 'failed') failed += 1;
    }
    return { connection: this.connection, pending, inFlight, awaitingConfirmation, failed };
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const listener of this.listeners) listener(snap);
  }

  // --- enqueue / dedupe --------------------------------------------------

  /**
   * Enqueue a mutation. Returns false when a request with the same id is
   * already tracked, preventing duplicate submissions.
   */
  enqueue<T>(request: Omit<QueuedRequest<T>, 'status' | 'attempts' | 'createdAt' | 'updatedAt'>): boolean {
    if (this.requests.has(request.id)) return false;
    const timestamp = this.now();
    const queued: QueuedRequest = {
      ...request,
      status: 'pending',
      attempts: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.requests.set(queued.id, queued);
    this.persist();
    this.emit();
    void this.drain();
    return true;
  }

  get(id: string): QueuedRequest | undefined {
    return this.requests.get(id);
  }

  list(): QueuedRequest[] {
    return [...this.requests.values()];
  }

  // --- explicit user actions --------------------------------------------

  /**
   * Explicitly confirm replay of an unsafe mutation that was paused while
   * offline. This is the only path that resumes an unsafe request.
   */
  confirm(id: string): boolean {
    const request = this.requests.get(id);
    if (!request || request.status !== 'awaiting-confirmation') return false;
    request.status = 'pending';
    request.attempts = 0;
    request.updatedAt = this.now();
    this.persist();
    this.emit();
    void this.drain();
    return true;
  }

  /** Discard a request without replaying it. */
  discard(id: string): boolean {
    const request = this.requests.get(id);
    if (!request) return false;
    this.clearTimer(id);
    this.requests.delete(id);
    this.persist();
    this.emit();
    return true;
  }

  // --- draining / retry --------------------------------------------------

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  private scheduleRetry(request: QueuedRequest): void {
    const delay = backoffDelay(request.attempts, this.retryPolicy);
    this.clearTimer(request.id);
    const timer = setTimeout(() => {
      this.timers.delete(request.id);
      void this.drain();
    }, delay);
    this.timers.set(request.id, timer);
  }

  async drain(): Promise<void> {
    if (this.draining) return;
    if (this.connection !== 'online') return;
    this.draining = true;
    try {
      for (const request of [...this.requests.values()]) {
        if (request.status !== 'pending') continue;
        if (this.connection !== 'online') break;
        await this.run(request);
      }
    } finally {
      this.draining = false;
    }
  }

  private async run(request: QueuedRequest): Promise<void> {
    request.status = 'in-flight';
    request.attempts += 1;
    request.updatedAt = this.now();
    this.persist();
    this.emit();

    try {
      await this.executor(request);
      request.status = 'succeeded';
      request.updatedAt = this.now();
      this.requests.delete(request.id);
      this.persist();
      this.emit();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      request.lastError = message;
      request.updatedAt = this.now();

      if (!request.idempotent) {
        // Unsafe mutations are never silently replayed.
        request.status = 'awaiting-confirmation';
      } else if (request.attempts >= this.retryPolicy.maxAttempts) {
        request.status = 'failed';
      } else {
        request.status = 'pending';
        this.scheduleRetry(request);
      }
      this.persist();
      this.emit();
    }
  }

  /** Clear all tracked requests and timers (used on logout). */
  reset(): void {
    for (const id of this.timers.keys()) this.clearTimer(id);
    this.requests.clear();
    this.persist();
    this.emit();
  }
}
