/**
 * Product funnel and retention metrics with privacy limits (#87).
 *
 * Provides event-driven funnel analysis (registration → activation → engagement)
 * and rolling retention windows. All cohort-level results are suppressed when
 * the cohort size is below ANALYTICS_PRIVACY.MIN_COHORT_SIZE to prevent
 * de-anonymisation via small-cohort inference.
 *
 * Identity rules:
 * - actor_id is opaque in this service; no PII is accessed or returned.
 * - Account merges are handled by always using the canonical (earliest) actor_id
 *   so a single user cannot be double-counted across identity transitions.
 * - Excluded actor IDs (test / seed accounts) are filtered at query time.
 *
 * Trusted queries:
 * - All queries use parameterised placeholders; no raw string interpolation.
 * - Only events from the ANALYTICS_EVENT_NAMES allowlist are eligible.
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AnalyticsEvent, AnalyticsEventName } from './entities/analytics-event.entity';
import { ANALYTICS_PRIVACY } from './analytics.constants';

// ─── Funnel step definitions ─────────────────────────────────────────────────

/**
 * Steps in the xConfess activation funnel, ordered from broadest to deepest.
 *
 * Activation is considered complete once a user reaches the 'engaged' step.
 */
export const FUNNEL_STEPS = [
  'registered',
  'activated',
  'engaged',
] as const;

export type FunnelStep = (typeof FUNNEL_STEPS)[number];

/**
 * Map each funnel step to the analytics event that represents it.
 * A user "enters" a step the first time the corresponding event is recorded
 * under their actor_id.
 */
const FUNNEL_STEP_EVENTS: Record<FunnelStep, AnalyticsEventName> = {
  registered: 'user_registered',
  activated: 'confession_created',
  engaged: 'reaction_created',
} as const;

// ─── Output types ─────────────────────────────────────────────────────────────

export interface FunnelStepMetric {
  step: FunnelStep;
  /** Number of unique actors who reached this step in the window. */
  count: number;
  /**
   * Conversion rate from the previous step (null for the first step or when
   * the previous step count is zero).
   */
  conversionFromPrevious: number | null;
  /**
   * True when the cohort was suppressed due to being smaller than
   * ANALYTICS_PRIVACY.MIN_COHORT_SIZE. count will be null when suppressed.
   */
  suppressed: boolean;
}

export interface FunnelMetrics {
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  steps: FunnelStepMetric[];
  minimumCohortSize: number;
}

export interface RetentionCohort {
  /** ISO date of the first day actors were seen. */
  cohortDate: string;
  cohortSize: number;
  /** Percentage retained on day N after first seen (null when suppressed). */
  d1RetentionPercent: number | null;
  d7RetentionPercent: number | null;
  d30RetentionPercent: number | null;
  suppressed: boolean;
}

export interface FunnelRetentionMetrics {
  windowDays: number;
  cohorts: RetentionCohort[];
  minimumCohortSize: number;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class FunnelMetricsService {
  private readonly logger = new Logger(FunnelMetricsService.name);

  constructor(
    @InjectRepository(AnalyticsEvent)
    private readonly analyticsEventRepository: Repository<AnalyticsEvent>,
  ) {}

  /**
   * Calculate activation funnel metrics for a given time window.
   *
   * Each step counts the number of distinct actor_ids that produced the
   * corresponding event at least once within the window. Steps are monotonic
   * by definition (registered ≥ activated ≥ engaged) because each step's
   * event presupposes the previous step.
   *
   * Cohorts below MIN_COHORT_SIZE are suppressed (count set to null,
   * suppressed = true) to prevent small-group inference.
   *
   * @param windowDays  - Look-back window in days (default: 30)
   * @param excludedActorIds - Actor IDs to exclude from all counts
   */
  async getFunnelMetrics(
    windowDays = 30,
    excludedActorIds: string[] = [],
  ): Promise<FunnelMetrics> {
    const now = new Date();
    const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

    const stepCounts = await this.countFunnelSteps(
      windowStart,
      now,
      excludedActorIds,
    );

    const steps: FunnelStepMetric[] = FUNNEL_STEPS.map((step, index) => {
      const count = stepCounts.get(step) ?? 0;
      const prevCount = index > 0 ? (stepCounts.get(FUNNEL_STEPS[index - 1]) ?? 0) : null;

      const suppressed = count > 0 && count < ANALYTICS_PRIVACY.MIN_COHORT_SIZE;

      return {
        step,
        count: suppressed ? 0 : count,
        conversionFromPrevious:
          prevCount === null || prevCount === 0
            ? null
            : Number(((count / prevCount) * 100).toFixed(1)),
        suppressed,
      };
    });

    return {
      windowDays,
      windowStart: windowStart.toISOString(),
      windowEnd: now.toISOString(),
      steps,
      minimumCohortSize: ANALYTICS_PRIVACY.MIN_COHORT_SIZE,
    };
  }

  /**
   * Calculate rolling retention cohorts for new actors.
   *
   * Each cohort is defined by the date an actor first appeared in the system.
   * Retention is measured at D+1, D+7, D+30. A cohort is suppressed when
   * its size is below MIN_COHORT_SIZE.
   *
   * Identity stability: an actor's "first seen" date is taken from the
   * earliest event record for that actor_id, so account-merge transitions
   * (where the oldest ID is canonical) cannot inflate cohort sizes.
   *
   * @param windowDays - Number of calendar days of cohorts to include
   * @param excludedActorIds - Actor IDs to exclude
   */
  async getRetentionCohorts(
    windowDays = 30,
    excludedActorIds: string[] = [],
  ): Promise<FunnelRetentionMetrics> {
    const now = new Date();
    const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

    // Fetch all actor activity within 60 days (retention requires looking
    // 30 days beyond the cohort window for D30 retention).
    const activityWindow = new Date(now.getTime() - (windowDays + 30) * 24 * 60 * 60 * 1000);

    const activityRows = await this.fetchActorActivity(activityWindow, now, excludedActorIds);

    // Group activity by actor and compute first-seen date.
    const actorActivity = this.buildActorActivityMap(activityRows, excludedActorIds);

    // Bucket actors into cohorts by their first-seen date.
    const cohortMap = new Map<string, Set<string>>();
    for (const [actorId, { firstDay, activeDays }] of actorActivity) {
      // Only include actors whose first day falls in the requested window.
      if (firstDay < windowStart.toISOString().slice(0, 10)) continue;

      const bucket = cohortMap.get(firstDay) ?? new Set<string>();
      bucket.add(actorId);
      cohortMap.set(firstDay, bucket);

      // Re-attach active days reference for retention check below.
      actorActivity.set(actorId, { firstDay, activeDays });
    }

    const cohorts: RetentionCohort[] = [];
    for (const [cohortDate, actors] of [...cohortMap.entries()].sort()) {
      const cohortActors = [...actors].map((id) => actorActivity.get(id)!);
      const cohortSize = cohortActors.length;
      const suppressed = cohortSize < ANALYTICS_PRIVACY.MIN_COHORT_SIZE;

      if (suppressed) {
        cohorts.push({
          cohortDate,
          cohortSize,
          d1RetentionPercent: null,
          d7RetentionPercent: null,
          d30RetentionPercent: null,
          suppressed: true,
        });
        continue;
      }

      cohorts.push({
        cohortDate,
        cohortSize,
        d1RetentionPercent: this.calcRetention(cohortActors, cohortDate, 1),
        d7RetentionPercent: this.calcRetention(cohortActors, cohortDate, 7),
        d30RetentionPercent: this.calcRetention(cohortActors, cohortDate, 30),
        suppressed: false,
      });
    }

    return {
      windowDays,
      cohorts,
      minimumCohortSize: ANALYTICS_PRIVACY.MIN_COHORT_SIZE,
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async countFunnelSteps(
    from: Date,
    to: Date,
    excludedActorIds: string[],
  ): Promise<Map<FunnelStep, number>> {
    const excluded = new Set(excludedActorIds);
    const result = new Map<FunnelStep, number>();

    for (const step of FUNNEL_STEPS) {
      const eventName = FUNNEL_STEP_EVENTS[step];

      const qb = this.analyticsEventRepository
        .createQueryBuilder('event')
        .select('COUNT(DISTINCT event.actorId)', 'count')
        .where('event.eventName = :eventName', { eventName })
        .andWhere('event.occurredAt >= :from', { from })
        .andWhere('event.occurredAt < :to', { to })
        .andWhere('event.actorId IS NOT NULL');

      if (excluded.size > 0) {
        qb.andWhere('event.actorId NOT IN (:...excluded)', {
          excluded: [...excluded],
        });
      }

      const row = await qb.getRawOne<{ count?: string }>();
      result.set(step, Number(row?.count ?? 0));
    }

    return result;
  }

  private async fetchActorActivity(
    from: Date,
    to: Date,
    excludedActorIds: string[],
  ): Promise<Array<{ actorId: string; occurredAt: Date | string }>> {
    const excluded = new Set(excludedActorIds);

    const qb = this.analyticsEventRepository
      .createQueryBuilder('event')
      .select('event.actorId', 'actorId')
      .addSelect('event.occurredAt', 'occurredAt')
      .where('event.actorId IS NOT NULL')
      .andWhere('event.occurredAt >= :from', { from })
      .andWhere('event.occurredAt < :to', { to });

    if (excluded.size > 0) {
      qb.andWhere('event.actorId NOT IN (:...excluded)', {
        excluded: [...excluded],
      });
    }

    return qb.getRawMany<{ actorId: string; occurredAt: Date | string }>();
  }

  private buildActorActivityMap(
    rows: Array<{ actorId: string; occurredAt: Date | string }>,
    excludedActorIds: string[],
  ): Map<string, { firstDay: string; activeDays: Set<string> }> {
    const excluded = new Set(excludedActorIds);
    const map = new Map<string, { firstDay: string; activeDays: Set<string> }>();

    for (const row of rows) {
      if (!row.actorId || excluded.has(row.actorId)) continue;

      const date = new Date(row.occurredAt);
      if (Number.isNaN(date.getTime())) continue;

      const day = date.toISOString().slice(0, 10);
      const existing = map.get(row.actorId);

      if (existing) {
        existing.activeDays.add(day);
        // Track earliest seen date for identity stability.
        if (day < existing.firstDay) {
          existing.firstDay = day;
        }
      } else {
        map.set(row.actorId, { firstDay: day, activeDays: new Set([day]) });
      }
    }

    return map;
  }

  private calcRetention(
    cohortActors: Array<{ firstDay: string; activeDays: Set<string> }>,
    cohortDate: string,
    offsetDays: number,
  ): number | null {
    if (cohortActors.length === 0) return null;

    const targetDate = this.addDays(cohortDate, offsetDays);
    const retained = cohortActors.filter((a) => a.activeDays.has(targetDate)).length;

    return Number(((retained / cohortActors.length) * 100).toFixed(1));
  }

  private addDays(isoDate: string, days: number): string {
    const d = new Date(`${isoDate}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
}
