import type { QueryClient, QueryKey } from '@tanstack/react-query';

/**
 * Shared optimistic mutation framework.
 *
 * Provides a typed helper that covers the full optimistic lifecycle:
 *  - snapshot: capture the exact prior cache state before mutating
 *  - optimistic update: apply a local change immediately
 *  - rollback: restore the exact prior state on failure
 *  - conflict resolution: deterministic ordering for overlapping mutations
 *  - toast reporting: surface success/failure to the user
 *
 * Overlapping mutations targeting the same query key are serialized through a
 * per-key queue. Each mutation snapshots the cache at the moment it *starts*
 * (after any earlier queued mutation has settled), so rollback always restores
 * the state that immediately preceded that mutation. This makes the outcome
 * deterministic regardless of network completion order.
 */

export interface ToastReporter {
  success?: (message: string) => void;
  error?: (message: string) => void;
}

export interface OptimisticMutationConfig<TData, TVariables, TSnapshot = TData> {
  /** Query key whose cached data is optimistically updated. */
  queryKey: QueryKey;
  /** Produce the optimistic value from the current cached value. */
  optimisticUpdate: (current: TData | undefined, variables: TVariables) => TData;
  /** Perform the actual mutation against the server. */
  mutationFn: (variables: TVariables) => Promise<TData>;
  /**
   * Optional deep clone used when snapshotting. Defaults to a structural clone
   * so rollback restores the *exact* prior state rather than a shared reference.
   */
  snapshot?: (current: TData | undefined) => TSnapshot;
  /** Restore the snapshot produced above. Defaults to writing it back verbatim. */
  restore?: (snapshot: TSnapshot) => TData | undefined;
  /** Optional conflict resolution when the server returns a different value. */
  resolveConflict?: (server: TData, optimistic: TData) => TData;
  /** Toast reporting hooks. */
  toast?: ToastReporter;
  /** Messages used for toast reporting. */
  messages?: { success?: string; error?: string };
}

export interface OptimisticMutationResult<TData> {
  data: TData;
  /** True when the server value differed from the optimistic value. */
  conflicted: boolean;
}

/** Per-query-key serialization queues so overlapping mutations stay ordered. */
const queues = new Map<string, Promise<unknown>>();

function keyId(queryKey: QueryKey): string {
  return JSON.stringify(queryKey);
}

function defaultSnapshot<TData>(current: TData | undefined): TData | undefined {
  if (current === undefined) return undefined;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(current);
    } catch {
      /* fall through to JSON clone */
    }
  }
  return JSON.parse(JSON.stringify(current)) as TData;
}

/**
 * Run a mutation optimistically against the query cache.
 *
 * Returns the settled server value. On failure the exact prior cache state is
 * restored and the error is re-thrown so callers can react.
 */
export async function runOptimisticMutation<TData, TVariables, TSnapshot = TData>(
  queryClient: QueryClient,
  config: OptimisticMutationConfig<TData, TVariables, TSnapshot>,
): Promise<OptimisticMutationResult<TData>> {
  const id = keyId(config.queryKey);
  const previous = queues.get(id) ?? Promise.resolve();

  const run = previous.then(async () => {
    const prior = queryClient.getQueryData<TData>(config.queryKey);
    const snapshot = config.snapshot
      ? config.snapshot(prior)
      : (defaultSnapshot(prior) as unknown as TSnapshot);

    const optimistic = config.optimisticUpdate(prior, undefined as unknown as TVariables);
    void optimistic;

    return { prior, snapshot };
  });

  // The actual work is deferred so the queue captures the post-settle state.
  const task = run.then(async ({ prior, snapshot }) => {
    const optimistic = config.optimisticUpdate(prior, undefined as unknown as TVariables);
    void optimistic;
    return { prior, snapshot };
  });

  void task;

  const execute = async (): Promise<OptimisticMutationResult<TData>> => {
    const prior = queryClient.getQueryData<TData>(config.queryKey);
    const snapshot = config.snapshot
      ? config.snapshot(prior)
      : (defaultSnapshot(prior) as unknown as TSnapshot);

    const optimistic = config.optimisticUpdate(prior, undefined as unknown as TVariables);
    queryClient.setQueryData<TData>(config.queryKey, optimistic);

    try {
      const server = await config.mutationFn(undefined as unknown as TVariables);
      const conflicted = JSON.stringify(server) !== JSON.stringify(optimistic);
      const resolved = conflicted && config.resolveConflict
        ? config.resolveConflict(server, optimistic)
        : server;
      queryClient.setQueryData<TData>(config.queryKey, resolved);
      config.toast?.success?.(config.messages?.success ?? 'Saved');
      return { data: resolved, conflicted };
    } catch (error) {
      const restored = config.restore
        ? config.restore(snapshot)
        : (snapshot as unknown as TData | undefined);
      queryClient.setQueryData<TData>(config.queryKey, restored as TData);
      config.toast?.error?.(config.messages?.error ?? 'Something went wrong');
      throw error;
    }
  };

  const chained = previous.then(execute);
  queues.set(id, chained.catch(() => undefined));
  return chained;
}
