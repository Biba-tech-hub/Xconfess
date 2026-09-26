/**
 * Per-endpoint latency budgets for xConfess backend.
 *
 * Each critical endpoint has documented p50 / p95 / p99 thresholds (in ms).
 * These budgets are used by the LatencyBudgetInterceptor to:
 *   1. Warn when a real request exceeds a p95 budget.
 *   2. Surface p50/p95/p99 deltas in CI benchmark reports.
 *
 * Budgets were set from the PERFORMANCE_BASELINE.md measurements plus a
 * 20 % headroom for cache-warm conditions.  They must be reviewed with
 * product owners before any milestone release.
 *
 * See docs/performance-workload-profiles.md for review cadence details.
 */

/** Dependency layer that contributed to a slow request. */
export type SlowLayer = 'db' | 'cache' | 'queue' | 'external' | 'unknown';

/** Latency percentile thresholds in milliseconds. */
export interface LatencyBudget {
  /** Route pattern, e.g. "GET /api/confessions" */
  route: string;
  /** p50 (median) threshold in ms. */
  p50Ms: number;
  /** p95 threshold in ms — warn when a live request exceeds this. */
  p95Ms: number;
  /** p99 threshold in ms — critical alert. */
  p99Ms: number;
  /** Expected slow layer when budget is exceeded (aids triage). */
  primarySlowLayer: SlowLayer;
  /** Human note on why this budget was set. */
  rationale: string;
}

/**
 * Canonical budget definitions for all critical endpoints.
 *
 * Routes that are not listed fall back to the DEFAULT_BUDGET.
 */
export const LATENCY_BUDGETS: readonly LatencyBudget[] = [
  {
    route: 'GET /api/confessions',
    p50Ms: 120,
    p95Ms: 400,
    p99Ms: 800,
    primarySlowLayer: 'db',
    rationale:
      'Public feed — cache-warm p50 target 120 ms; 400 ms p95 before user-perceived lag',
  },
  {
    route: 'GET /api/confessions/:id',
    p50Ms: 60,
    p95Ms: 200,
    p99Ms: 400,
    primarySlowLayer: 'cache',
    rationale: 'Single confession detail; Redis cache-hit target < 60 ms',
  },
  {
    route: 'POST /api/confessions',
    p50Ms: 150,
    p95Ms: 350,
    p99Ms: 600,
    primarySlowLayer: 'db',
    rationale: 'Write includes encryption + DB insert; 350 ms p95 acceptable',
  },
  {
    route: 'GET /api/reactions',
    p50Ms: 80,
    p95Ms: 250,
    p99Ms: 500,
    primarySlowLayer: 'cache',
    rationale: 'Reaction counts; cached per confession, fast path < 80 ms',
  },
  {
    route: 'POST /api/reactions',
    p50Ms: 100,
    p95Ms: 300,
    p99Ms: 600,
    primarySlowLayer: 'db',
    rationale: 'Upsert + cache invalidation; 300 ms p95',
  },
  {
    route: 'GET /api/confessions/search',
    p50Ms: 200,
    p95Ms: 600,
    p99Ms: 1200,
    primarySlowLayer: 'db',
    rationale:
      'Full-text search with pg tsvector; higher budget due to FTS overhead',
  },
  {
    route: 'GET /api/confessions/trending',
    p50Ms: 80,
    p95Ms: 200,
    p99Ms: 400,
    primarySlowLayer: 'cache',
    rationale: 'Trending list is aggressively cached (120 s TTL)',
  },
  {
    route: 'POST /api/comments',
    p50Ms: 120,
    p95Ms: 300,
    p99Ms: 500,
    primarySlowLayer: 'db',
    rationale: 'Comment insert + notification enqueue',
  },
  {
    route: 'GET /api/notifications',
    p50Ms: 100,
    p95Ms: 300,
    p99Ms: 600,
    primarySlowLayer: 'db',
    rationale: 'Authenticated read; user-scoped query',
  },
  {
    route: 'GET /api/health/ready',
    p50Ms: 30,
    p95Ms: 100,
    p99Ms: 200,
    primarySlowLayer: 'db',
    rationale: 'Health probe must be fast to avoid k8s restarts',
  },
] as const;

/** Fallback budget for endpoints not listed in LATENCY_BUDGETS. */
export const DEFAULT_BUDGET: Omit<LatencyBudget, 'route' | 'rationale'> = {
  p50Ms: 200,
  p95Ms: 500,
  p99Ms: 1000,
  primarySlowLayer: 'unknown',
};

/**
 * Find the budget for a given HTTP method + path combination.
 * Normalises `:param` placeholders in both the registered route and the
 * incoming path so that `/api/confessions/abc123` matches the
 * `GET /api/confessions/:id` entry.
 *
 * @returns The matched LatencyBudget, or a synthetic one built from DEFAULT_BUDGET.
 */
export function findBudget(method: string, path: string): LatencyBudget {
  const normalisedPath = normalisePath(path);
  const candidate = `${method.toUpperCase()} ${normalisedPath}`;

  for (const budget of LATENCY_BUDGETS) {
    if (routeMatches(budget.route, candidate)) {
      return budget;
    }
  }

  return {
    route: candidate,
    ...DEFAULT_BUDGET,
    rationale: 'Default budget — no specific entry defined',
  };
}

/**
 * Classify the outcome of a request against its latency budget.
 *
 * @returns 'ok' | 'warn' | 'critical'
 */
export function classifyLatency(
  durationMs: number,
  budget: LatencyBudget,
): 'ok' | 'warn' | 'critical' {
  if (durationMs > budget.p99Ms) return 'critical';
  if (durationMs > budget.p95Ms) return 'warn';
  return 'ok';
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Replace path segments that look like IDs (UUIDs, numbers, slugs) with `:id`.
 * This lets `/api/confessions/abc-123` match `GET /api/confessions/:id`.
 */
function normalisePath(path: string): string {
  // Remove query string.
  const [pathname] = path.split('?');
  return pathname.replace(
    /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    '/:id',
  ).replace(/\/\d+\b/g, '/:id');
}

/**
 * Check whether a route template (e.g. "GET /api/confessions/:id") matches
 * a normalised request string (e.g. "GET /api/confessions/:id").
 */
function routeMatches(template: string, normalised: string): boolean {
  // Both sides already normalised — exact match is sufficient.
  return template === normalised;
}
