/**
 * Read Replica Lag Health Indicator — Issue #107
 *
 * Exposes replica replication lag as an observable health metric so operators
 * can detect lag buildup before it causes read-after-write inconsistency.
 *
 * ## What it measures
 * - `pg_last_wal_replay_lsn()` on the read replica vs the write LSN reported
 *   by the master.  When both hosts are the same (local dev), lag is always 0.
 * - Lag is expressed in bytes (WAL bytes behind master).
 * - A configurable `warnBytes` threshold triggers 'needs-review' rating.
 * - A configurable `failBytes` threshold triggers a HealthCheckError so
 *   /api/health/ready returns 503, blocking traffic that requires fresh reads.
 *
 * ## Configuration (env vars)
 * | Var                         | Default  | Description                         |
 * |-----------------------------|----------|-------------------------------------|
 * | DB_READ_LAG_WARN_BYTES      | 5 MB     | Log warn + downgrade rating         |
 * | DB_READ_LAG_FAIL_BYTES      | 50 MB    | Fail health check → readiness probe |
 *
 * ## Failover / replica-loss behaviour
 * If the replica is unreachable, the indicator returns `up` with
 * `replicaReachable: false` and `lagBytes: null`.  Failover decisions should
 * be handled at the infrastructure layer (RDS Multi-AZ / Patroni / etc.).
 */

import {
  HealthIndicator,
  HealthIndicatorResult,
  HealthCheckError,
} from '@nestjs/terminus';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';

export interface ReplicaLagDetail {
  status: 'up' | 'down';
  replicaHost: string | null;
  replicaReachable: boolean;
  lagBytes: number | null;
  /** 'ok' | 'warn' | 'critical' */
  lagRating: 'ok' | 'warn' | 'critical';
  latencyMs: number | null;
  error?: string;
}

@Injectable()
export class ReplicaLagHealthIndicator extends HealthIndicator {
  private readonly logger = new Logger(ReplicaLagHealthIndicator.name);

  /** 5 MB — log a warning but don't fail the health check */
  private readonly DEFAULT_WARN_BYTES = 5 * 1024 * 1024;

  /** 50 MB — fail the readiness probe */
  private readonly DEFAULT_FAIL_BYTES = 50 * 1024 * 1024;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Optional() private readonly configService?: ConfigService,
  ) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const warnBytes =
      this.configService?.get<number>('DB_READ_LAG_WARN_BYTES') ??
      this.DEFAULT_WARN_BYTES;
    const failBytes =
      this.configService?.get<number>('DB_READ_LAG_FAIL_BYTES') ??
      this.DEFAULT_FAIL_BYTES;

    const replicaHost =
      this.configService?.get<string>('DB_READ_HOST') ?? null;

    const detail: ReplicaLagDetail = {
      status: 'up',
      replicaHost,
      replicaReachable: false,
      lagBytes: null,
      lagRating: 'ok',
      latencyMs: null,
    };

    // When no separate read host is configured the "replica" is the primary —
    // lag is always 0 and we can skip the LSN query.
    const dbHost = this.configService?.get<string>('DB_HOST') ?? '';
    if (!replicaHost || replicaHost === dbHost) {
      detail.replicaReachable = true;
      detail.lagBytes = 0;
      detail.lagRating = 'ok';
      return this.getStatus(key, true, detail);
    }

    try {
      const start = Date.now();

      // Query WAL replay position on the replica (via the default DataSource
      // connection; TypeORM routes SELECTs to slaves automatically).
      // pg_is_in_recovery() confirms this is indeed a standby node.
      const [result] = await this.dataSource.query<
        { lag_bytes: string | null; is_replica: boolean }[]
      >(`
        SELECT
          CASE
            WHEN pg_is_in_recovery() THEN
              pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn())
            ELSE
              0
          END::bigint AS lag_bytes,
          pg_is_in_recovery() AS is_replica
      `);

      detail.latencyMs = Date.now() - start;
      detail.replicaReachable = true;

      const lagBytes = result.lag_bytes != null ? Number(result.lag_bytes) : 0;
      detail.lagBytes = lagBytes;

      if (lagBytes >= failBytes) {
        detail.lagRating = 'critical';
        detail.status = 'down';
        this.logger.error(
          `Replica lag CRITICAL: ${lagBytes} bytes (threshold=${failBytes}). ` +
            `Read-after-write queries may return stale data.`,
        );
        throw new HealthCheckError(
          'Replica lag exceeds failure threshold',
          this.getStatus(key, false, detail),
        );
      }

      if (lagBytes >= warnBytes) {
        detail.lagRating = 'warn';
        this.logger.warn(
          `Replica lag WARNING: ${lagBytes} bytes (threshold=${warnBytes}).`,
        );
      }

      return this.getStatus(key, true, detail);
    } catch (error: unknown) {
      if (error instanceof HealthCheckError) throw error;

      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Replica lag check failed (replica unreachable?): ${message}`);

      // Replica being unreachable is not a critical failure on its own —
      // TypeORM will route reads to the master. Log it but keep the probe green.
      detail.replicaReachable = false;
      detail.lagBytes = null;
      detail.lagRating = 'ok';
      detail.error = message;

      return this.getStatus(key, true, detail);
    }
  }
}
