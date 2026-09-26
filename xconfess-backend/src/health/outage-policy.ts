/**
 * Dependency outage classification and fallback policy.
 *
 * Classifies each named dependency into a tier and defines the degraded-mode
 * behaviour when that dependency is unavailable.  This is the single source of
 * truth that all modules should consult — it prevents individual services from
 * independently deciding how aggressive their retries should be.
 *
 * Fallback levels (from least to most impactful):
 *  - none     — dependency is critical; caller should return an error.
 *  - cached   — serve stale data from an in-process or Redis cache.
 *  - skip     — silently skip the operation (fire-and-forget like email/tips).
 *  - disabled — feature is disabled until the circuit closes.
 *
 * Issue: #96 — Design regional and dependency outage behavior
 */

export type FallbackLevel = 'none' | 'cached' | 'skip' | 'disabled';

export interface DependencyPolicy {
  /** Tier classification — critical deps must be up for core reads to work. */
  tier: 'critical' | 'optional';
  /** What callers should do when this dep is in degraded mode. */
  fallback: FallbackLevel;
  /**
   * Human-readable description of what degrades when this dep is down.
   * Surfaced in runbooks and the /health/status endpoint.
   */
  degradedBehavior: string;
  /**
   * Whether the API should return a distinct HTTP 503 with a
   * `Retry-After` header when this dep is unavailable.
   * False for `skip` and `disabled` fallbacks.
   */
  surfaceRetryable: boolean;
  /** Timeout in ms for a single attempt before counting as a failure. */
  timeoutMs: number;
}

/**
 * Default policies for all named dependencies in xConfess.
 *
 * To add a new dependency:
 * 1. Add an entry here.
 * 2. Register the circuit in CircuitBreakerService (usually in module init).
 * 3. Wrap the call site with isOpen() / recordSuccess() / recordFailure().
 */
export const DEPENDENCY_POLICIES: Record<string, DependencyPolicy> = {
  /**
   * Postgres — primary datastore.
   * All confession reads and user lookups require this.  No fallback.
   */
  postgres: {
    tier: 'critical',
    fallback: 'none',
    degradedBehavior:
      'All read and write operations fail with 503. The liveness probe stays green but the readiness probe returns 503.',
    surfaceRetryable: true,
    timeoutMs: 5_000,
  },

  /**
   * Redis — queue backend and optional caching layer.
   * Notifications, exports, and draft publishing degrade gracefully.
   */
  redis: {
    tier: 'optional',
    fallback: 'disabled',
    degradedBehavior:
      'BullMQ queues pause. Notifications and scheduled exports are queued in-memory until Redis recovers. ' +
      'Feed reads continue from Postgres.',
    surfaceRetryable: true,
    timeoutMs: 2_000,
  },

  /**
   * Email / SMTP — notification delivery channel.
   * Failures are logged and the notification record stays in the queue.
   */
  email: {
    tier: 'optional',
    fallback: 'skip',
    degradedBehavior:
      'Email delivery is skipped. The notification is retained in the database and will be retried ' +
      'when the circuit closes or via the DLQ retry mechanism.',
    surfaceRetryable: false,
    timeoutMs: 10_000,
  },

  /**
   * Stellar / Soroban RPC — on-chain anchoring and tipping.
   * Features degrade to "pending" state; confession creation still works.
   */
  'stellar-rpc': {
    tier: 'optional',
    fallback: 'cached',
    degradedBehavior:
      'On-chain anchoring and tipping are disabled. Confessions are saved locally and ' +
      'queued for reconciliation once the RPC endpoint recovers. ' +
      'The chain reconciliation worker will retry when the circuit closes.',
    surfaceRetryable: false,
    timeoutMs: 15_000,
  },
} as const;

/**
 * Returns the policy for a named dependency.
 * Falls back to a safe default if the dependency is not explicitly registered.
 */
export function getDependencyPolicy(name: string): DependencyPolicy {
  return (
    DEPENDENCY_POLICIES[name] ?? {
      tier: 'optional',
      fallback: 'skip',
      degradedBehavior: `Unknown dependency "${name}" — skipping by default.`,
      surfaceRetryable: false,
      timeoutMs: 5_000,
    }
  );
}

/**
 * Computes the overall system status from a map of dependency → up/down.
 *
 * Rules:
 *  - Any critical dep down  → 'down'
 *  - Any optional dep down  → 'degraded'
 *  - All up                 → 'ready'
 */
export function computeSystemStatus(
  depStatuses: Record<string, boolean>,
): 'ready' | 'degraded' | 'down' {
  for (const [name, isUp] of Object.entries(depStatuses)) {
    if (!isUp) {
      const policy = getDependencyPolicy(name);
      if (policy.tier === 'critical') return 'down';
    }
  }

  const anyOptionalDown = Object.entries(depStatuses).some(([name, isUp]) => {
    if (isUp) return false;
    return getDependencyPolicy(name).tier === 'optional';
  });

  return anyOptionalDown ? 'degraded' : 'ready';
}
