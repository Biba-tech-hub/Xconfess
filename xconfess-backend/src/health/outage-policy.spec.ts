import {
  computeSystemStatus,
  getDependencyPolicy,
  DEPENDENCY_POLICIES,
} from './outage-policy';

describe('outage-policy', () => {
  describe('getDependencyPolicy', () => {
    it('returns the correct policy for known dependencies', () => {
      expect(getDependencyPolicy('postgres').tier).toBe('critical');
      expect(getDependencyPolicy('redis').tier).toBe('optional');
      expect(getDependencyPolicy('email').fallback).toBe('skip');
      expect(getDependencyPolicy('stellar-rpc').fallback).toBe('cached');
    });

    it('returns a safe default for unknown dependencies', () => {
      const policy = getDependencyPolicy('unknown-service');
      expect(policy.tier).toBe('optional');
      expect(policy.fallback).toBe('skip');
      expect(policy.surfaceRetryable).toBe(false);
    });
  });

  describe('computeSystemStatus', () => {
    it('returns "ready" when all dependencies are up', () => {
      const statuses = {
        postgres: true,
        redis: true,
        email: true,
        'stellar-rpc': true,
      };
      expect(computeSystemStatus(statuses)).toBe('ready');
    });

    it('returns "down" when a critical dependency is down', () => {
      expect(
        computeSystemStatus({ postgres: false, redis: true, email: true }),
      ).toBe('down');
    });

    it('returns "degraded" when only optional dependencies are down', () => {
      expect(
        computeSystemStatus({ postgres: true, redis: false, email: true }),
      ).toBe('degraded');
    });

    it('returns "degraded" when multiple optional deps are down', () => {
      expect(
        computeSystemStatus({
          postgres: true,
          redis: false,
          email: false,
          'stellar-rpc': false,
        }),
      ).toBe('degraded');
    });

    it('returns "down" even if optional deps are up when critical is down', () => {
      expect(
        computeSystemStatus({
          postgres: false,
          redis: true,
          email: true,
          'stellar-rpc': true,
        }),
      ).toBe('down');
    });
  });

  describe('DEPENDENCY_POLICIES', () => {
    it('all policies have required fields', () => {
      for (const [name, policy] of Object.entries(DEPENDENCY_POLICIES)) {
        expect(['critical', 'optional']).toContain(policy.tier);
        expect(['none', 'cached', 'skip', 'disabled']).toContain(
          policy.fallback,
        );
        expect(typeof policy.degradedBehavior).toBe('string');
        expect(policy.degradedBehavior.length).toBeGreaterThan(0);
        expect(typeof policy.surfaceRetryable).toBe('boolean');
        expect(policy.timeoutMs).toBeGreaterThan(0);
        void name; // used for context only
      }
    });

    it('critical deps never use skip fallback', () => {
      for (const policy of Object.values(DEPENDENCY_POLICIES)) {
        if (policy.tier === 'critical') {
          expect(policy.fallback).not.toBe('skip');
        }
      }
    });
  });
});
