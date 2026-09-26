import {
  CHAOS_EXPERIMENTS,
  getExperiment,
  assertStagingEnvironment,
  ChaosExperiment,
} from './chaos-experiments';

describe('chaos-experiments catalogue', () => {
  it('exports at least 5 experiments', () => {
    expect(CHAOS_EXPERIMENTS.length).toBeGreaterThanOrEqual(5);
  });

  it('every experiment has a unique ID', () => {
    const ids = CHAOS_EXPERIMENTS.map((e) => e.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  describe('experiment structure', () => {
    test.each(CHAOS_EXPERIMENTS)(
      'experiment $id has all required fields',
      (exp: ChaosExperiment) => {
        expect(exp.id).toBeTruthy();
        expect(exp.title).toBeTruthy();
        expect(exp.target).toBeTruthy();
        expect(exp.hypothesis.length).toBeGreaterThan(20);
        expect(exp.preconditions.length).toBeGreaterThan(0);
        expect(exp.injectionSteps.length).toBeGreaterThan(0);
        expect(exp.metrics.length).toBeGreaterThan(0);
        expect(exp.abortCondition.length).toBeGreaterThan(10);
        expect(exp.recoverySteps.length).toBeGreaterThan(0);
        expect(exp.remediationOnFailure.length).toBeGreaterThan(10);
        expect(exp.durationSecs).toBeGreaterThan(0);
      },
    );

    test.each(CHAOS_EXPERIMENTS)(
      'experiment $id metrics have expected and method fields',
      (exp: ChaosExperiment) => {
        for (const metric of exp.metrics) {
          expect(metric.name).toBeTruthy();
          expect(metric.expected.length).toBeGreaterThan(5);
          expect(metric.method.length).toBeGreaterThan(5);
        }
      },
    );

    test.each(CHAOS_EXPERIMENTS)(
      'experiment $id preconditions mention staging safety',
      (exp: ChaosExperiment) => {
        const mentionsStaging = exp.preconditions.some(
          (p) => /staging|production|NODE_ENV/i.test(p),
        );
        expect(mentionsStaging).toBe(true);
      },
    );
  });

  describe('getExperiment', () => {
    it('returns the correct experiment by ID', () => {
      const exp = getExperiment('exp-01-postgres-loss');
      expect(exp).toBeDefined();
      expect(exp!.target).toBe('postgres');
    });

    it('returns undefined for an unknown ID', () => {
      expect(getExperiment('nonexistent')).toBeUndefined();
    });
  });

  describe('assertStagingEnvironment', () => {
    const originalEnv = process.env;

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('throws when NODE_ENV is production', () => {
      process.env.NODE_ENV = 'production';
      expect(() => assertStagingEnvironment()).toThrow(/production/i);
    });

    it('throws when DATABASE_URL matches a production hostname', () => {
      process.env.NODE_ENV = 'staging';
      process.env.DATABASE_URL = 'postgres://user:pass@myapp.render.com/db';
      expect(() => assertStagingEnvironment()).toThrow(/production/i);
    });

    it('does not throw in staging with a safe DATABASE_URL', () => {
      process.env.NODE_ENV = 'staging';
      process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/testdb';
      expect(() => assertStagingEnvironment()).not.toThrow();
    });

    it('does not throw when NODE_ENV is test', () => {
      process.env.NODE_ENV = 'test';
      process.env.DATABASE_URL = '';
      expect(() => assertStagingEnvironment()).not.toThrow();
    });
  });
});
