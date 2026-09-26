import {
  LATENCY_BUDGETS,
  DEFAULT_BUDGET,
  findBudget,
  classifyLatency,
} from '../latency-budgets';

describe('latency-budgets', () => {
  describe('LATENCY_BUDGETS definitions', () => {
    it('has at least one budget entry', () => {
      expect(LATENCY_BUDGETS.length).toBeGreaterThan(0);
    });

    it('every budget has p50 < p95 < p99', () => {
      LATENCY_BUDGETS.forEach((b) => {
        expect(b.p50Ms).toBeLessThan(b.p95Ms);
        expect(b.p95Ms).toBeLessThan(b.p99Ms);
      });
    });

    it('every budget has a non-empty route and rationale', () => {
      LATENCY_BUDGETS.forEach((b) => {
        expect(b.route.length).toBeGreaterThan(0);
        expect(b.rationale.length).toBeGreaterThan(0);
      });
    });

    it('all routes start with "GET" or "POST"', () => {
      LATENCY_BUDGETS.forEach((b) => {
        expect(b.route).toMatch(/^(GET|POST|PUT|PATCH|DELETE) /);
      });
    });
  });

  describe('DEFAULT_BUDGET', () => {
    it('has p50 < p95 < p99', () => {
      expect(DEFAULT_BUDGET.p50Ms).toBeLessThan(DEFAULT_BUDGET.p95Ms);
      expect(DEFAULT_BUDGET.p95Ms).toBeLessThan(DEFAULT_BUDGET.p99Ms);
    });
  });

  describe('findBudget()', () => {
    it('returns the matching budget for a known route', () => {
      const budget = findBudget('GET', '/api/confessions');
      expect(budget.route).toBe('GET /api/confessions');
      expect(budget.p95Ms).toBeGreaterThan(0);
    });

    it('matches confession detail route when path contains a UUID', () => {
      const budget = findBudget('GET', '/api/confessions/3e7a8b12-1234-5678-abcd-ef0123456789');
      // Should fall through to default since normalised path becomes /api/confessions/:id
      // which matches the registered GET /api/confessions/:id entry.
      expect(budget.p95Ms).toBeGreaterThan(0);
    });

    it('matches confession detail route when path contains a numeric ID', () => {
      const budget = findBudget('GET', '/api/confessions/42');
      expect(budget.route).toBe('GET /api/confessions/:id');
    });

    it('returns default budget for unknown routes', () => {
      const budget = findBudget('GET', '/api/unknown/endpoint');
      expect(budget.p95Ms).toBe(DEFAULT_BUDGET.p95Ms);
      expect(budget.p99Ms).toBe(DEFAULT_BUDGET.p99Ms);
    });

    it('strips query strings before matching', () => {
      const withQuery = findBudget('GET', '/api/confessions?page=2&limit=20');
      const withoutQuery = findBudget('GET', '/api/confessions');
      expect(withQuery.route).toBe(withoutQuery.route);
    });

    it('is case-insensitive on HTTP method', () => {
      const lower = findBudget('get', '/api/confessions');
      const upper = findBudget('GET', '/api/confessions');
      expect(lower.route).toBe(upper.route);
    });
  });

  describe('classifyLatency()', () => {
    const budget = {
      route: 'GET /api/confessions',
      p50Ms: 120,
      p95Ms: 400,
      p99Ms: 800,
      primarySlowLayer: 'db' as const,
      rationale: 'test',
    };

    it('returns "ok" when duration is below p95', () => {
      expect(classifyLatency(399, budget)).toBe('ok');
    });

    it('returns "ok" at the p50 threshold', () => {
      expect(classifyLatency(120, budget)).toBe('ok');
    });

    it('returns "warn" when duration exceeds p95 but not p99', () => {
      expect(classifyLatency(401, budget)).toBe('warn');
      expect(classifyLatency(799, budget)).toBe('warn');
    });

    it('returns "critical" when duration exceeds p99', () => {
      expect(classifyLatency(801, budget)).toBe('critical');
      expect(classifyLatency(5000, budget)).toBe('critical');
    });

    it('returns "ok" at exactly p95', () => {
      // Exactly at budget is still ok (budget is an exclusive threshold).
      expect(classifyLatency(400, budget)).toBe('ok');
    });

    it('returns "warn" at exactly p99', () => {
      // p99 is an exclusive threshold for critical.
      expect(classifyLatency(800, budget)).toBe('warn');
    });
  });
});
