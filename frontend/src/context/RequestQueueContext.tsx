import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

/**
 * Request queue with offline/reconnect resilience.
 *
 * - In-flight and queued mutations are persisted to localStorage so they
 *   survive reloads and network loss.
 * - Online/offline state is tracked and exposed to consumers.
 * - Safe (idempotent) operations are replayed automatically on reconnect.
 * - Unsafe operations are never silently replayed; they require an explicit
 *   user action via `retryUnsafe`.
 * - Duplicate submissions are prevented by de-duplicating on a caller-supplied
 *   idempotency key.
 */

export type RequestStatus = 'pending' | 'in-flight' | 'failed' | 'succeeded';

export interface QueuedRequest<T = unknown> {
  /** Stable idempotency key used to prevent duplicate submissions. */
  id: string;
  /** Whether the operation is safe to replay automatically. */
  safe: boolean;
  status: RequestStatus;
  /** Serialized payload; must be JSON-serializable for persistence. */
  payload: T;
  /** Number of attempts made so far. */
  attempts: number;
  /** Last error message, if any. */
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RequestQueueContextValue {
  isOnline: boolean;
  /** True when we were offline and have just regained connectivity. */
  isReconnecting: boolean;
  /** Requests waiting to be sent (pending or failed). */
  queued: QueuedRequest[];
  /** Requests currently being sent. */
  inFlight: QueuedRequest[];
  /** Unsafe requests that failed and require explicit user retry. */
  needsAttention: QueuedRequest[];
  /** Enqueue a request. Returns false if a duplicate id is already tracked. */
  enqueue: <T>(request: {
    id: string;
    safe: boolean;
    payload: T;
  }) => boolean;
  /** Explicitly retry an unsafe request after user confirmation. */
  retryUnsafe: (id: string) => void;
  /** Discard a queued request. */
  discard: (id: string) => void;
  /** Clear all succeeded requests from state. */
  clearSucceeded: () => void;
}

const STORAGE_KEY = 'request-queue:v1';
const MAX_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 1000;

const RequestQueueContext = createContext<RequestQueueContextValue | null>(null);

function loadPersisted(): QueuedRequest[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Any request that was in-flight when the page unloaded is treated as
    // pending again so it can be re-evaluated on reconnect.
    return parsed.map((item: QueuedRequest) => ({
      ...item,
      status: item.status === 'in-flight' ? 'pending' : item.status,
    }));
  } catch {
    return [];
  }
}

function persist(requests: QueuedRequest[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(requests));
  } catch {
    // Persistence is best-effort; ignore quota/serialization errors.
  }
}

export interface RequestQueueProviderProps {
  children: React.ReactNode;
  /**
   * Executes a request. Should throw on failure. Provided by the app so the
   * queue stays transport-agnostic.
   */
  executor?: (request: QueuedRequest) => Promise<void>;
}

export function RequestQueueProvider({
  children,
  executor,
}: RequestQueueProviderProps) {
  const [requests, setRequests] = useState<QueuedRequest[]>(() => loadPersisted());
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const [isReconnecting, setIsReconnecting] = useState(false);
  const processingRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Persist on every change so state survives reloads.
  useEffect(() => {
    persist(requests);
  }, [requests]);

  // Reconnect detection.
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleOnline = () => {
      setIsOnline(true);
      setIsReconnecting(true);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(() => setIsReconnecting(false), 4000);
    };
    const handleOffline = () => {
      setIsOnline(false);
      setIsReconnecting(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, []);

  const updateRequest = useCallback(
    (id: string, patch: Partial<QueuedRequest>) => {
      setRequests((prev) =>
        prev.map((req) =>
          req.id === id ? { ...req, ...patch, updatedAt: Date.now() } : req,
        ),
      );
    },
    [],
  );

  const enqueue = useCallback<RequestQueueContextValue['enqueue']>(
    ({ id, safe, payload }) => {
      let accepted = false;
      setRequests((prev) => {
        // Duplicate submission prevention: ignore ids already tracked.
        if (prev.some((req) => req.id === id)) {
          return prev;
        }
        accepted = true;
        const now = Date.now();
        return [
          ...prev,
          {
            id,
            safe,
            payload,
            status: 'pending',
            attempts: 0,
            createdAt: now,
            updatedAt: now,
          },
        ];
      });
      return accepted;
    },
    [],
  );

  const retryUnsafe = useCallback(
    (id: string) => {
      updateRequest(id, { status: 'pending', error: undefined });
    },
    [updateRequest],
  );

  const discard = useCallback((id: string) => {
    setRequests((prev) => prev.filter((req) => req.id !== id));
  }, []);

  const clearSucceeded = useCallback(() => {
    setRequests((prev) => prev.filter((req) => req.status !== 'succeeded'));
  }, []);

  // Process the queue. Safe requests are replayed automatically; unsafe
  // requests are only sent when explicitly marked pending by the user.
  useEffect(() => {
    if (!executor || !isOnline || processingRef.current) return;

    const next = requests.find(
      (req) =>
        req.status === 'pending' &&
        (req.safe || req.attempts === 0) &&
        req.attempts < MAX_ATTEMPTS,
    );
    if (!next) return;

    processingRef.current = true;
    updateRequest(next.id, { status: 'in-flight', attempts: next.attempts + 1 });

    executor(next)
      .then(() => {
        updateRequest(next.id, { status: 'succeeded', error: undefined });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const attempts = next.attempts + 1;
        // Unsafe operations are never silently replayed: mark failed and
        // surface them for explicit user action.
        const canAutoRetry = next.safe && attempts < MAX_ATTEMPTS;
        updateRequest(next.id, {
          status: canAutoRetry ? 'pending' : 'failed',
          error: message,
        });
        if (canAutoRetry) {
          const delay = BASE_RETRY_DELAY_MS * 2 ** (attempts - 1);
          setTimeout(() => {
            processingRef.current = false;
            setRequests((prev) => [...prev]);
          }, delay);
          return;
        }
      })
      .finally(() => {
        processingRef.current = false;
      });
  }, [requests, isOnline, executor, updateRequest]);

  const value = useMemo<RequestQueueContextValue>(() => {
    const queued = requests.filter(
      (req) => req.status === 'pending' || req.status === 'failed',
    );
    const inFlight = requests.filter((req) => req.status === 'in-flight');
    const needsAttention = requests.filter(
      (req) => req.status === 'failed' && !req.safe,
    );
    return {
      isOnline,
      isReconnecting,
      queued,
      inFlight,
      needsAttention,
      enqueue,
      retryUnsafe,
      discard,
      clearSucceeded,
    };
  }, [
    requests,
    isOnline,
    isReconnecting,
    enqueue,
    retryUnsafe,
    discard,
    clearSucceeded,
  ]);

  return (
    <RequestQueueContext.Provider value={value}>
      {children}
    </RequestQueueContext.Provider>
  );
}

export function useRequestQueue(): RequestQueueContextValue {
  const ctx = useContext(RequestQueueContext);
  if (!ctx) {
    throw new Error('useRequestQueue must be used within a RequestQueueProvider');
  }
  return ctx;
}

export default RequestQueueContext;
