import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface DatabasePoolMetrics {
  status: 'healthy' | 'warning' | 'critical' | 'outage';
  classification: 'NORMAL' | 'POOL_SATURATION' | 'LOCK_CONTENTION' | 'OUTAGE';
  pool: {
    totalConnections: number;
    activeConnections: number;
    idleConnections: number;
    maxConnections: number;
    utilizationPercent: number;
  };
  locks: {
    waitingLocksCount: number;
    maxWaitDurationMs: number;
    blockedQueriesCount: number;
    sampleBlockedQueries: Array<{ waitDurationMs: number; sanitizedQuery: string }>;
  };
  transactions: {
    longestRunningDurationSec: number;
    idleInTransactionCount: number;
  };
  operatorDiagnostics: {
    message: string;
    actionableHint: string;
    thresholds: {
      poolUtilizationWarningPercent: number;
      lockWaitWarningMs: number;
    };
  };
  timestamp: string;
}

@Injectable()
export class DatabasePoolObservabilityService {
  private readonly logger = new Logger(DatabasePoolObservabilityService.name);

  // Warning thresholds
  private readonly POOL_UTILIZATION_WARN_THRESHOLD = 80;
  private readonly LOCK_WAIT_WARN_MS = 3000;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  public static sanitizeQuery(queryText: string): string {
    if (!queryText) return '';
    // Scrub string literals ('...')
    let sanitized = queryText.replace(/'(?:[^'\\]|\\.)*'/g, "'<REDACTED>'");
    // Scrub numbers
    sanitized = sanitized.replace(/\b\d+\b/g, '?');
    // Scrub common credential/token parameters
    sanitized = sanitized.replace(/(password|token|secret|key)\s*=\s*[^,\s;]+/gi, '$1=<REDACTED>');
    return sanitized.trim();
  }

  async getPoolAndLockMetrics(): Promise<DatabasePoolMetrics> {
    const timestamp = new Date().toISOString();

    try {
      // 1. Check connection and latency
      const start = Date.now();
      await this.dataSource.query('SELECT 1');
      const pingDuration = Date.now() - start;

      // 2. Fetch pool connections from pg_stat_activity and pg_settings
      const [poolStats] = await this.dataSource.query<any[]>(`
        SELECT
          (SELECT count(*) FROM pg_stat_activity)::int AS total,
          (SELECT count(*) FROM pg_stat_activity WHERE state = 'active')::int AS active,
          (SELECT count(*) FROM pg_stat_activity WHERE state = 'idle')::int AS idle,
          (SELECT count(*) FROM pg_stat_activity WHERE state = 'idle in transaction')::int AS idle_in_tx,
          (SELECT setting FROM pg_settings WHERE name = 'max_connections')::int AS max_conn
      `);

      const totalConnections = poolStats?.total || 0;
      const activeConnections = poolStats?.active || 0;
      const idleConnections = poolStats?.idle || 0;
      const idleInTransactionCount = poolStats?.idle_in_tx || 0;
      const maxConnections = poolStats?.max_conn || 100;
      const utilizationPercent = Math.round((activeConnections / Math.max(maxConnections, 1)) * 100);

      // 3. Inspect locks and contention from pg_locks
      let waitingLocksCount = 0;
      let maxWaitDurationMs = 0;
      let blockedQueriesCount = 0;
      const sampleBlockedQueries: Array<{ waitDurationMs: number; sanitizedQuery: string }> = [];

      try {
        const lockStats = await this.dataSource.query<any[]>(`
          SELECT
            count(*) as count,
            COALESCE(MAX(EXTRACT(EPOCH FROM (clock_timestamp() - state_change)) * 1000), 0) as max_wait_ms
          FROM pg_stat_activity
          WHERE wait_event_type = 'Lock'
        `);

        waitingLocksCount = Number(lockStats[0]?.count) || 0;
        maxWaitDurationMs = Math.round(Number(lockStats[0]?.max_wait_ms) || 0);

        // Fetch sample blocked queries safely with parameters redacted
        const blockedRows = await this.dataSource.query<any[]>(`
          SELECT
            query,
            EXTRACT(EPOCH FROM (clock_timestamp() - state_change)) * 1000 as wait_ms
          FROM pg_stat_activity
          WHERE wait_event_type = 'Lock'
          LIMIT 5
        `);

        blockedQueriesCount = blockedRows.length;
        for (const row of blockedRows) {
          sampleBlockedQueries.push({
            waitDurationMs: Math.round(Number(row.wait_ms) || 0),
            sanitizedQuery: DatabasePoolObservabilityService.sanitizeQuery(row.query),
          });
        }
      } catch {
        // Fallback for non-privileged or mocked testing environments
      }

      // 4. Inspect longest running transactions
      let longestRunningDurationSec = 0;
      try {
        const [txRow] = await this.dataSource.query<any[]>(`
          SELECT COALESCE(MAX(EXTRACT(EPOCH FROM (clock_timestamp() - xact_start))), 0) as max_tx_sec
          FROM pg_stat_activity
          WHERE state != 'idle' AND xact_start IS NOT NULL
        `);
        longestRunningDurationSec = Math.round(Number(txRow?.max_tx_sec) || 0);
      } catch {}

      // 5. Determine classification and actionable operator diagnostics
      let status: 'healthy' | 'warning' | 'critical' = 'healthy';
      let classification: 'NORMAL' | 'POOL_SATURATION' | 'LOCK_CONTENTION' = 'NORMAL';
      let message = 'Database connection pool and locks operating within nominal thresholds.';
      let actionableHint = 'No action required.';

      if (waitingLocksCount > 0 || maxWaitDurationMs > this.LOCK_WAIT_WARN_MS) {
        status = maxWaitDurationMs > 10000 ? 'critical' : 'warning';
        classification = 'LOCK_CONTENTION';
        message = `Lock contention detected: ${waitingLocksCount} queries waiting for locks (max wait: ${maxWaitDurationMs}ms).`;
        actionableHint =
          'Inspect long-running write transactions, review foreign-key lock cascades, and consider statement timeouts.';
      } else if (utilizationPercent >= this.POOL_UTILIZATION_WARN_THRESHOLD) {
        status = utilizationPercent >= 95 ? 'critical' : 'warning';
        classification = 'POOL_SATURATION';
        message = `Connection pool saturation: ${utilizationPercent}% active capacity utilized (${activeConnections}/${maxConnections}).`;
        actionableHint =
          'Increase max_connections, configure PgBouncer connection pooling, or investigate unclosed idle connections in transaction.';
      }

      return {
        status,
        classification,
        pool: {
          totalConnections,
          activeConnections,
          idleConnections,
          maxConnections,
          utilizationPercent,
        },
        locks: {
          waitingLocksCount,
          maxWaitDurationMs,
          blockedQueriesCount,
          sampleBlockedQueries,
        },
        transactions: {
          longestRunningDurationSec,
          idleInTransactionCount,
        },
        operatorDiagnostics: {
          message,
          actionableHint,
          thresholds: {
            poolUtilizationWarningPercent: this.POOL_UTILIZATION_WARN_THRESHOLD,
            lockWaitWarningMs: this.LOCK_WAIT_WARN_MS,
          },
        },
        timestamp,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Database outage detected during pool observability check: ${errorMsg}`);

      return {
        status: 'outage',
        classification: 'OUTAGE',
        pool: {
          totalConnections: 0,
          activeConnections: 0,
          idleConnections: 0,
          maxConnections: 0,
          utilizationPercent: 0,
        },
        locks: {
          waitingLocksCount: 0,
          maxWaitDurationMs: 0,
          blockedQueriesCount: 0,
          sampleBlockedQueries: [],
        },
        transactions: {
          longestRunningDurationSec: 0,
          idleInTransactionCount: 0,
        },
        operatorDiagnostics: {
          message: `Database server is unreachable or failing: ${errorMsg}`,
          actionableHint:
            'Check PostgreSQL service status, network partition, database credentials, and host availability.',
          thresholds: {
            poolUtilizationWarningPercent: this.POOL_UTILIZATION_WARN_THRESHOLD,
            lockWaitWarningMs: this.LOCK_WAIT_WARN_MS,
          },
        },
        timestamp,
      };
    }
  }
}
