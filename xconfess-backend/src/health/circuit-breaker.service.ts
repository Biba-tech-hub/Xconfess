/**
 * Circuit breaker and dependency outage management.
 *
 * Implements a classic three-state circuit breaker (CLOSED → OPEN → HALF_OPEN)
 * for each named external dependency (postgres, redis, email, stellar-rpc).
 *
 * Behaviour summary:
 *  - CLOSED  — requests pass through; failures are counted.
 *  - OPEN    — requests are rejected immediately (fast-fail) for `resetTimeoutMs`.
 *              Prevents retry storms and lets the dependency recover.
 *  - HALF_OPEN — one probe is allowed through; success closes the circuit,
 *                failure reopens it and resets the cooldown timer.
 *
 * Each dependency also has a `degradedMode` flag that callers can read
 * to decide whether to serve partial / cached responses instead of failing.
 *
 * Issue: #96 — Design regional and dependency outage behavior
 */

import { Injectable, Logger } from '@nestjs/common';

/** Public status that maps to the health controller `degraded` state. */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** Classification used to decide fallback depth. */
export type DependencyTier = 'critical' | 'optional';

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before the circuit opens. Default 5. */
  failureThreshold?: number;
  /** Time in ms to wait before moving OPEN → HALF_OPEN. Default 30_000. */
  resetTimeoutMs?: number;
  /** Whether the dependency is critical (database, schema) or optional (redis, email, stellar). */
  tier?: DependencyTier;
}

export interface CircuitStatus {
  name: string;
  state: CircuitState;
  tier: DependencyTier;
  failureCount: number;
  lastFailureAt: Date | null;
  lastSuccessAt: Date | null;
  /** True when state is OPEN or HALF_OPEN — callers should use fallback paths. */
  degradedMode: boolean;
}

interface CircuitEntry {
  state: CircuitState;
  failureCount: number;
  lastFailureAt: Date | null;
  lastSuccessAt: Date | null;
  openedAt: Date | null;
  options: Required<CircuitBreakerOptions>;
}

/**
 * Global circuit breaker registry.  Registered once per process.
 * Inject this service wherever you need to guard an external call.
 *
 * @example
 * constructor(private readonly cb: CircuitBreakerService) {}
 *
 * async sendEmail(payload: EmailPayload) {
 *   if (this.cb.isOpen('email')) {
 *     this.logger.warn('email circuit open — skipping send');
 *     return; // graceful no-op
 *   }
 *   try {
 *     await this.mailer.send(payload);
 *     this.cb.recordSuccess('email');
 *   } catch (err) {
 *     this.cb.recordFailure('email');
 *     throw err;
 *   }
 * }
 */
@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private readonly circuits = new Map<string, CircuitEntry>();

  /**
   * Register a circuit for a named dependency.
   * Safe to call multiple times; existing state is preserved.
   */
  register(name: string, options: CircuitBreakerOptions = {}): void {
    if (this.circuits.has(name)) return;

    const resolved: Required<CircuitBreakerOptions> = {
      failureThreshold: options.failureThreshold ?? 5,
      resetTimeoutMs: options.resetTimeoutMs ?? 30_000,
      tier: options.tier ?? 'optional',
    };

    this.circuits.set(name, {
      state: 'CLOSED',
      failureCount: 0,
      lastFailureAt: null,
      lastSuccessAt: null,
      openedAt: null,
      options: resolved,
    });

    this.logger.log(
      `Circuit registered: ${name} (tier=${resolved.tier}, threshold=${resolved.failureThreshold}, resetMs=${resolved.resetTimeoutMs})`,
    );
  }

  /**
   * Returns true when the circuit is OPEN (requests should be rejected).
   * Automatically transitions OPEN → HALF_OPEN once the reset timeout has elapsed.
   */
  isOpen(name: string): boolean {
    const entry = this.getOrDefault(name);
    if (entry.state === 'CLOSED') return false;

    if (entry.state === 'OPEN') {
      const elapsed = Date.now() - (entry.openedAt?.getTime() ?? 0);
      if (elapsed >= entry.options.resetTimeoutMs) {
        entry.state = 'HALF_OPEN';
        this.logger.log(`Circuit half-opened: ${name} — probing dependency`);
        return false; // allow the probe through
      }
      return true;
    }

    // HALF_OPEN: allow exactly one probe
    return false;
  }

  /**
   * Record a successful call.  Resets the failure counter and closes the circuit.
   */
  recordSuccess(name: string): void {
    const entry = this.getOrDefault(name);
    if (entry.state !== 'CLOSED') {
      this.logger.log(`Circuit closed: ${name} — dependency recovered`);
    }
    entry.state = 'CLOSED';
    entry.failureCount = 0;
    entry.openedAt = null;
    entry.lastSuccessAt = new Date();
  }

  /**
   * Record a failed call.  Opens the circuit once the failure threshold is reached.
   */
  recordFailure(name: string): void {
    const entry = this.getOrDefault(name);
    entry.failureCount += 1;
    entry.lastFailureAt = new Date();

    if (
      entry.state === 'HALF_OPEN' ||
      entry.failureCount >= entry.options.failureThreshold
    ) {
      if (entry.state !== 'OPEN') {
        this.logger.warn(
          `Circuit opened: ${name} — ${entry.failureCount} failure(s); fast-failing for ${entry.options.resetTimeoutMs}ms`,
        );
      }
      entry.state = 'OPEN';
      entry.openedAt = new Date();
    }
  }

  /** Snapshot of all registered circuits — used by health endpoints and dashboards. */
  getAll(): CircuitStatus[] {
    return Array.from(this.circuits.entries()).map(([name, entry]) => ({
      name,
      state: entry.state,
      tier: entry.options.tier,
      failureCount: entry.failureCount,
      lastFailureAt: entry.lastFailureAt,
      lastSuccessAt: entry.lastSuccessAt,
      degradedMode: entry.state !== 'CLOSED',
    }));
  }

  /** Single-circuit snapshot. */
  getStatus(name: string): CircuitStatus | null {
    const entry = this.circuits.get(name);
    if (!entry) return null;
    return {
      name,
      state: entry.state,
      tier: entry.options.tier,
      failureCount: entry.failureCount,
      lastFailureAt: entry.lastFailureAt,
      lastSuccessAt: entry.lastSuccessAt,
      degradedMode: entry.state !== 'CLOSED',
    };
  }

  /**
   * Manually reset a circuit (useful during maintenance windows or runbooks).
   */
  reset(name: string): void {
    const entry = this.circuits.get(name);
    if (!entry) return;
    entry.state = 'CLOSED';
    entry.failureCount = 0;
    entry.openedAt = null;
    this.logger.log(`Circuit manually reset: ${name}`);
  }

  private getOrDefault(name: string): CircuitEntry {
    if (!this.circuits.has(name)) {
      this.register(name); // auto-register with defaults
    }
    return this.circuits.get(name)!;
  }
}
