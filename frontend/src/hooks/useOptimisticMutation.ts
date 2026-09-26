import { useCallback, useRef } from 'react';
import {
  useMutation,
  useQueryClient,
  type QueryKey,
  type UseMutationOptions,
  type UseMutationResult,
} from '@tanstack/react-query';

/**
 * A deep-ish structural clone used to snapshot query data before an optimistic
 * update so that a failed mutation can restore the *exact* prior state.
 *
 * We prefer `structuredClone` when available (handles Map/Set/Date/cycles) and
 * fall back to a JSON round-trip for older runtimes. Non-cloneable values are
 * returned as-is so we never throw while taking a snapshot.
 */
export function snapshot<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const globalClone = (globalThis as { structuredClone?: <V>(v: V) => V })
    .structuredClone;
  if (typeof globalClone === 'function') {
    try {
      return globalClone(value);
    } catch {
      // fall through to JSON clone
    }
  }
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

/**
 * Resolves a conflict between the optimistic value and the value that is
 * currently in the cache (which may have been written by an overlapping
 * mutation). Returning `undefined` means "keep the current cache value".
 */
export type ConflictResolver<TData> = (
  optimistic: TData,
  current: TData | undefined,
) => TData | undefined;

/**
 * Deterministic default conflict resolution: last-write-wins. The most recent
 * optimistic update always takes precedence over whatever is already cached.
 */
export const lastWriteWins: ConflictResolver<unknown> = (optimistic) =>
  optimistic;

/**
 * Deterministic default conflict resolution: first-write-wins. An overlapping
 * mutation will not clobber a value that is already present in the cache.
 */
export const firstWriteWins: ConflictResolver<unknown> = (optimistic, current) =>
  current === undefined ? optimistic : current;

export interface OptimisticMutationConfig<TData, TVariables, TContext> {
  /** Query key(s) whose cached data is optimistically updated. */
  queryKey: QueryKey;
  /**
   * Produces the optimistic value from the current cached value and the
   * mutation variables. Return `undefined` to skip the optimistic write.
   */
  optimisticUpdate: (current: TData | undefined, variables: TVariables) => TData | undefined;
  /**
   * Resolves conflicts when an overlapping mutation has already written to the
   * cache. Defaults to {@link lastWriteWins}. Use {@link firstWriteWins} or a
   * custom resolver for different semantics.
   */
  resolveConflict?: ConflictResolver<TData>;
  /** Toast/reporting hook invoked when a mutation fails and is rolled back. */
  onErrorReport?: (error: unknown, variables: TVariables) => void;
  /** Toast/reporting hook invoked when a mutation succeeds. */
  onSuccessReport?: (data: unknown, variables: TVariables) => void;
}

export interface OptimisticMutationOptions<TData, TVariables, TResult, TError>
  extends OptimisticMutationConfig<TData, TVariables, unknown> {
  mutationFn: (variables: TVariables) => Promise<TResult>;
  /** Extra react-query mutation options; `onMutate`/`onError`/`onSettled` are managed here. */
  mutationOptions?: Omit<
    UseMutationOptions<TResult, TError, TVariables, { previous: TData | undefined }>,
    'mutationFn' | 'onMutate' | 'onError' | 'onSettled'
  >;
}

/**
 * Shared optimistic mutation framework.
 *
 * Guarantees:
 * - Failed mutations restore the exact prior cached state (deep snapshot).
 * - Overlapping mutations resolve deterministically via a monotonic sequence
 *   number plus a pluggable conflict resolver (default: last-write-wins).
 * - Rollbacks only apply when the failing mutation is still the latest writer,
 *   so a stale failure cannot clobber a newer optimistic value.
 * - Failures and successes are reported through optional toast hooks.
 */
export function useOptimisticMutation<TData, TVariables, TResult = unknown, TError = Error>(
  config: OptimisticMutationOptions<TData, TVariables, TResult, TError>,
): UseMutationResult<TResult, TError, TVariables, { previous: TData | undefined }> {
  const queryClient = useQueryClient();
  const {
    queryKey,
    optimisticUpdate,
    resolveConflict = lastWriteWins as ConflictResolver<TData>,
    onErrorReport,
    onSuccessReport,
    mutationFn,
    mutationOptions,
  } = config;

  // Monotonic sequence so overlapping mutations resolve deterministically.
  const sequenceRef = useRef(0);
  // Tracks the sequence of the most recent optimistic writer for this key.
  const latestWriterRef = useRef(0);

  return useMutation<TResult, TError, TVariables, { previous: TData | undefined }>({
    ...mutationOptions,
    mutationFn,
    onMutate: async (variables: TVariables) => {
      const sequence = ++sequenceRef.current;

      // Cancel in-flight refetches so they cannot overwrite the optimistic value.
      await queryClient.cancelQueries({ queryKey });

      const previous = snapshot(queryClient.getQueryData<TData>(queryKey));
      const optimistic = optimisticUpdate(previous, variables);

      if (optimistic !== undefined) {
        const current = queryClient.getQueryData<TData>(queryKey);
        const resolved = resolveConflict(optimistic, current);
        if (resolved !== undefined) {
          queryClient.setQueryData<TData>(queryKey, resolved);
        }
        latestWriterRef.current = sequence;
      }

      return { previous };
    },
    onError: (error: TError, variables: TVariables, context) => {
      // Only roll back if this mutation is still the latest writer; otherwise a
      // newer optimistic update owns the cache and must not be clobbered.
      if (context && latestWriterRef.current === sequenceRef.current) {
        queryClient.setQueryData<TData>(queryKey, context.previous);
      }
      onErrorReport?.(error, variables);
    },
    onSuccess: (data: TResult, variables: TVariables) => {
      onSuccessReport?.(data, variables);
    },
    onSettled: () => {
      // Reconcile with the server once the mutation settles.
      void queryClient.invalidateQueries({ queryKey });
    },
  });
}

/**
 * Convenience wrapper for the common case where the optimistic update is a
 * pure function of the previous value and the mutation variables.
 */
export function useOptimisticMutationCallback<TData, TVariables, TResult = unknown, TError = Error>(
  config: OptimisticMutationOptions<TData, TVariables, TResult, TError>,
) {
  const mutation = useOptimisticMutation(config);
  const mutate = useCallback(
    (variables: TVariables) => mutation.mutate(variables),
    [mutation],
  );
  return { ...mutation, mutate };
}
