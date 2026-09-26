import { QueryClient } from '@tanstack/react-query';

/**
 * Centralized query key factory for dashboard feature areas.
 *
 * Keys are hierarchical so that invalidation can target a precise slice of the
 * cache (e.g. a single feature detail) without nuking unrelated data. Route-level
 * owners seed these keys; child views read from them instead of refetching.
 */
export const queryKeys = {
  all: ['dashboard'] as const,

  dashboard: () => [...queryKeys.all, 'overview'] as const,

  features: {
    all: () => [...queryKeys.all, 'features'] as const,
    list: (filters?: Record<string, unknown>) =>
      [...queryKeys.features.all(), 'list', filters ?? {}] as const,
    detail: (featureId: string) =>
      [...queryKeys.features.all(), 'detail', featureId] as const,
  },
};

/**
 * Invalidation rules: mutations should invalidate only the precise keys they
 * affect. Broad `queryKeys.all` invalidation is reserved for cross-cutting
 * changes (e.g. auth/session) where every dashboard view is genuinely stale.
 */
export const invalidationRules = {
  /** A single feature changed: refresh its detail and any list that may show it. */
  feature: (featureId: string) => [
    queryKeys.features.detail(featureId),
    queryKeys.features.all(),
  ],

  /** The feature collection changed (create/delete): refresh lists only. */
  featureList: () => [queryKeys.features.all()],

  /** Dashboard aggregates depend on feature data: refresh overview + lists. */
  dashboard: () => [queryKeys.dashboard(), queryKeys.features.all()],
};

/**
 * Hydration boundaries: route-level owners seed the cache with these defaults so
 * child views can read immediately without triggering a duplicate fetch.
 */
export const hydrationDefaults = {
  staleTime: 30_000,
  gcTime: 5 * 60_000,
  refetchOnWindowFocus: false,
} as const;

/**
 * Error ownership: each route/feature declares where loading and error states
 * are surfaced. Keeping this explicit prevents errors from being swallowed by
 * an unrelated boundary and keeps loading/error UI accessible.
 */
export const errorOwnership = {
  dashboard: 'route',
  features: 'route',
  featureDetail: 'feature',
} as const;

export type ErrorOwner = (typeof errorOwnership)[keyof typeof errorOwnership];

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: hydrationDefaults.staleTime,
      gcTime: hydrationDefaults.gcTime,
      refetchOnWindowFocus: hydrationDefaults.refetchOnWindowFocus,
      retry: 1,
    },
    mutations: {
      retry: 0,
    },
  },
});
