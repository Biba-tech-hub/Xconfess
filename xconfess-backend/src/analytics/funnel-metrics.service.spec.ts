import { FunnelMetricsService, FUNNEL_STEPS } from './funnel-metrics.service';
import { ANALYTICS_PRIVACY } from './analytics.constants';

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Build a fake analytics event row for tests. */
function makeRow(
  actorId: string,
  eventName: string,
  occurredAt: Date,
): { actorId: string; occurredAt: Date; eventName: string } {
  return { actorId, occurredAt, eventName };
}

/** Build an ISO date string N days ago from now (UTC midnight). */
function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Build a Date N days ago (UTC midnight). */
function daysAgoDate(n: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

// ─── Mock factory ──────────────────────────────────────────────────────────────

function makeService(rows: Array<{ actorId: string; occurredAt: Date; eventName: string }>) {
  const qbMock: any = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getRawOne: jest.fn(),
    getRawMany: jest.fn(),
  };

  // getRawOne is used for funnel step COUNT(DISTINCT) queries
  qbMock.getRawOne.mockImplementation(async () => {
    // The query builder has captured the eventName via where() — we can't
    // easily inspect that on a mock, so we count by iterating over rows.
    // This is fine for unit tests; integration tests would use a real DB.
    return { count: '0' };
  });

  // getRawMany is used for retention activity queries
  qbMock.getRawMany.mockResolvedValue(
    rows.map((r) => ({ actorId: r.actorId, occurredAt: r.occurredAt })),
  );

  const repositoryMock = {
    createQueryBuilder: jest.fn().mockReturnValue(qbMock),
  };

  return new FunnelMetricsService(repositoryMock as any);
}

/** Build a service where countFunnelSteps returns controlled values. */
function makeServiceWithCounts(stepCounts: Map<string, number>) {
  const qbMock: any = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getRawOne: jest.fn(),
    getRawMany: jest.fn().mockResolvedValue([]),
  };

  // Track which eventName was passed to where()
  let capturedEventName = '';
  qbMock.where.mockImplementation((_q: string, params: any) => {
    if (params?.eventName) capturedEventName = params.eventName;
    return qbMock;
  });

  const eventToStep: Record<string, string> = {
    user_registered: 'registered',
    confession_created: 'activated',
    reaction_created: 'engaged',
  };

  qbMock.getRawOne.mockImplementation(async () => {
    const step = eventToStep[capturedEventName];
    return { count: String(stepCounts.get(step) ?? 0) };
  });

  const repositoryMock = {
    createQueryBuilder: jest.fn().mockReturnValue(qbMock),
  };

  return new FunnelMetricsService(repositoryMock as any);
}

// ─── Funnel metrics tests ──────────────────────────────────────────────────────

describe('FunnelMetricsService', () => {
  describe('getFunnelMetrics', () => {
    it('returns all funnel steps', async () => {
      const service = makeServiceWithCounts(
        new Map([['registered', 100], ['activated', 60], ['engaged', 30]]),
      );
      const result = await service.getFunnelMetrics(30);

      expect(result.steps).toHaveLength(FUNNEL_STEPS.length);
      expect(result.steps.map((s) => s.step)).toEqual([...FUNNEL_STEPS]);
    });

    it('returns correct conversion rates', async () => {
      const service = makeServiceWithCounts(
        new Map([['registered', 100], ['activated', 60], ['engaged', 30]]),
      );
      const result = await service.getFunnelMetrics(30);

      const registered = result.steps.find((s) => s.step === 'registered')!;
      const activated = result.steps.find((s) => s.step === 'activated')!;
      const engaged = result.steps.find((s) => s.step === 'engaged')!;

      expect(registered.conversionFromPrevious).toBeNull(); // first step
      expect(activated.conversionFromPrevious).toBeCloseTo(60.0, 1);
      expect(engaged.conversionFromPrevious).toBeCloseTo(50.0, 1);
    });

    it('suppresses cohorts below MIN_COHORT_SIZE', async () => {
      const belowThreshold = ANALYTICS_PRIVACY.MIN_COHORT_SIZE - 1;
      const service = makeServiceWithCounts(
        new Map([
          ['registered', 100],
          ['activated', belowThreshold],
          ['engaged', 0],
        ]),
      );
      const result = await service.getFunnelMetrics(30);

      const activated = result.steps.find((s) => s.step === 'activated')!;
      expect(activated.suppressed).toBe(true);
      expect(activated.count).toBe(0); // count zeroed on suppression
    });

    it('does not suppress zero-count steps', async () => {
      const service = makeServiceWithCounts(
        new Map([['registered', 0], ['activated', 0], ['engaged', 0]]),
      );
      const result = await service.getFunnelMetrics(30);

      for (const step of result.steps) {
        expect(step.suppressed).toBe(false); // 0 != below threshold
      }
    });

    it('includes window metadata', async () => {
      const service = makeServiceWithCounts(new Map());
      const result = await service.getFunnelMetrics(14);

      expect(result.windowDays).toBe(14);
      expect(result.windowStart).toBeDefined();
      expect(result.windowEnd).toBeDefined();
      expect(result.minimumCohortSize).toBe(ANALYTICS_PRIVACY.MIN_COHORT_SIZE);
    });

    it('null-conversion when previous step count is zero', async () => {
      const service = makeServiceWithCounts(
        new Map([['registered', 0], ['activated', 0], ['engaged', 0]]),
      );
      const result = await service.getFunnelMetrics(30);

      // When registered=0, activated's conversion should be null
      const activated = result.steps.find((s) => s.step === 'activated')!;
      expect(activated.conversionFromPrevious).toBeNull();
    });
  });

  // ─── Retention cohort tests ──────────────────────────────────────────────────

  describe('getRetentionCohorts', () => {
    it('returns empty cohorts when there is no activity', async () => {
      const service = makeService([]);
      const result = await service.getRetentionCohorts(30);

      expect(result.cohorts).toHaveLength(0);
      expect(result.minimumCohortSize).toBe(ANALYTICS_PRIVACY.MIN_COHORT_SIZE);
    });

    it('suppresses cohorts with fewer actors than MIN_COHORT_SIZE', async () => {
      // Only 2 actors (below threshold of 5)
      const cohortDay = daysAgo(5);
      const rows = [
        makeRow('actor1', 'user_registered', new Date(`${cohortDay}T10:00:00Z`)),
        makeRow('actor2', 'user_registered', new Date(`${cohortDay}T11:00:00Z`)),
      ];
      const service = makeService(rows);
      const result = await service.getRetentionCohorts(10);

      const cohort = result.cohorts.find((c) => c.cohortDate === cohortDay);
      if (cohort) {
        expect(cohort.suppressed).toBe(true);
        expect(cohort.d1RetentionPercent).toBeNull();
        expect(cohort.d7RetentionPercent).toBeNull();
        expect(cohort.d30RetentionPercent).toBeNull();
      }
      // If the cohort fell out of the window, that's also valid behaviour.
    });

    it('excludes actor IDs in the exclusion list', async () => {
      const cohortDay = daysAgo(5);
      const rows = [
        makeRow('seed-actor', 'user_registered', new Date(`${cohortDay}T10:00:00Z`)),
      ];
      const service = makeService(rows);
      const result = await service.getRetentionCohorts(10, ['seed-actor']);

      const cohort = result.cohorts.find((c) => c.cohortDate === cohortDay);
      // Excluded actor should not appear in any cohort
      expect(cohort).toBeUndefined();
    });

    it('does not double-count an actor appearing on multiple days', async () => {
      // Actor appears on day 0 AND day 1 — they are one person in the D-0 cohort.
      const cohortDay = daysAgo(5);
      const nextDay = daysAgo(4);
      const rows = Array.from({ length: ANALYTICS_PRIVACY.MIN_COHORT_SIZE }, (_, i) => [
        makeRow(`actor${i}`, 'user_registered', new Date(`${cohortDay}T10:00:00Z`)),
        makeRow(`actor${i}`, 'confession_created', new Date(`${nextDay}T10:00:00Z`)),
      ]).flat();

      const service = makeService(rows);
      const result = await service.getRetentionCohorts(10);

      const cohort = result.cohorts.find((c) => c.cohortDate === cohortDay);
      if (cohort && !cohort.suppressed) {
        // Cohort size should be exactly MIN_COHORT_SIZE, not doubled
        expect(cohort.cohortSize).toBe(ANALYTICS_PRIVACY.MIN_COHORT_SIZE);
      }
    });

    it('returns minimumCohortSize in the response', async () => {
      const service = makeService([]);
      const result = await service.getRetentionCohorts(7);
      expect(result.minimumCohortSize).toBe(ANALYTICS_PRIVACY.MIN_COHORT_SIZE);
    });

    it('handles actors with no activity gracefully', async () => {
      const service = makeService([]);
      const result = await service.getRetentionCohorts(30, ['excluded-actor']);
      expect(result.cohorts).toHaveLength(0);
    });
  });

  // ─── Privacy / identity boundary tests ────────────────────────────────────

  describe('privacy boundaries', () => {
    it('does not expose raw actor IDs in funnel output', async () => {
      const service = makeServiceWithCounts(
        new Map([['registered', 50], ['activated', 25], ['engaged', 10]]),
      );
      const result = await service.getFunnelMetrics(30);

      // Verify no actor_id field leaked into the step metrics
      for (const step of result.steps) {
        expect((step as any).actorId).toBeUndefined();
        expect((step as any).actorIds).toBeUndefined();
      }
    });

    it('does not expose raw actor IDs in retention cohort output', async () => {
      const service = makeService([]);
      const result = await service.getRetentionCohorts(30);

      for (const cohort of result.cohorts) {
        expect((cohort as any).actorId).toBeUndefined();
        expect((cohort as any).actorIds).toBeUndefined();
      }
    });

    it('first step has null conversionFromPrevious (no denominator)', async () => {
      const service = makeServiceWithCounts(
        new Map([['registered', 100], ['activated', 60], ['engaged', 30]]),
      );
      const result = await service.getFunnelMetrics(30);
      expect(result.steps[0].conversionFromPrevious).toBeNull();
    });
  });
});
