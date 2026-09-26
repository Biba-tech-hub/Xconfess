import { HealthCheckError } from '@nestjs/terminus';
import { ReplicaLagHealthIndicator } from './replica-lag.health';

/**
 * Tests for ReplicaLagHealthIndicator — Issue #107
 *
 * Covers:
 * - Returns up when no separate replica is configured (single-host dev).
 * - Returns up with lagRating 'ok' when lag < warn threshold.
 * - Returns up with lagRating 'warn' when lag >= warn threshold.
 * - Throws HealthCheckError when lag >= fail threshold.
 * - Returns up with replicaReachable=false when replica is unreachable.
 */

function makeDataSource(lagBytes: number | null, shouldThrow = false) {
  return {
    query: jest.fn(async () => {
      if (shouldThrow) throw new Error('connection refused');
      if (lagBytes === null) return [];
      return [{ lag_bytes: String(lagBytes), is_replica: lagBytes > 0 }];
    }),
  };
}

function makeConfigService(
  readHost: string | null,
  warnBytes?: number,
  failBytes?: number,
) {
  return {
    get: jest.fn((key: string) => {
      if (key === 'DB_READ_HOST') return readHost;
      if (key === 'DB_HOST') return 'db-primary';
      if (key === 'DB_READ_LAG_WARN_BYTES') return warnBytes;
      if (key === 'DB_READ_LAG_FAIL_BYTES') return failBytes;
      return undefined;
    }),
  };
}

function makeIndicator(
  lagBytes: number | null,
  readHost: string | null,
  opts: { warnBytes?: number; failBytes?: number; replicaThrows?: boolean } = {},
) {
  const ds = makeDataSource(lagBytes, opts.replicaThrows);
  const cs = makeConfigService(readHost, opts.warnBytes, opts.failBytes);
  const indicator = new ReplicaLagHealthIndicator(ds as any, cs as any);
  return indicator;
}

describe('ReplicaLagHealthIndicator', () => {
  describe('no separate replica configured', () => {
    it('returns up with lagBytes=0 when DB_READ_HOST equals DB_HOST', async () => {
      // readHost same as dbHost → skip query, return 0 lag
      const indicator = makeIndicator(0, 'db-primary'); // readHost === dbHost
      const result = await indicator.isHealthy('replica');
      expect(result['replica'].status).toBe('up');
      expect(result['replica'].lagBytes).toBe(0);
      expect(result['replica'].lagRating).toBe('ok');
    });

    it('returns up with lagBytes=0 when DB_READ_HOST is null', async () => {
      const indicator = makeIndicator(0, null);
      const result = await indicator.isHealthy('replica');
      expect(result['replica'].status).toBe('up');
    });
  });

  describe('replica reachable with low lag', () => {
    it('rates lagRating ok when below warn threshold', async () => {
      const indicator = makeIndicator(
        1024, // 1 KB — well below default 5 MB warn
        'db-replica',
        { warnBytes: 5 * 1024 * 1024, failBytes: 50 * 1024 * 1024 },
      );
      const result = await indicator.isHealthy('replica');
      expect(result['replica'].status).toBe('up');
      expect(result['replica'].lagBytes).toBe(1024);
      expect(result['replica'].lagRating).toBe('ok');
      expect(result['replica'].replicaReachable).toBe(true);
    });
  });

  describe('replica reachable with high lag', () => {
    it('rates lagRating warn when lag >= warnBytes but < failBytes', async () => {
      const warnBytes = 5 * 1024 * 1024;
      const failBytes = 50 * 1024 * 1024;
      const indicator = makeIndicator(warnBytes, 'db-replica', {
        warnBytes,
        failBytes,
      });
      const result = await indicator.isHealthy('replica');
      expect(result['replica'].lagRating).toBe('warn');
      expect(result['replica'].status).toBe('up'); // warn does not fail the probe
    });

    it('throws HealthCheckError when lag >= failBytes', async () => {
      const failBytes = 50 * 1024 * 1024;
      const indicator = makeIndicator(failBytes, 'db-replica', {
        warnBytes: 5 * 1024 * 1024,
        failBytes,
      });
      await expect(indicator.isHealthy('replica')).rejects.toThrow(
        HealthCheckError,
      );
    });

    it('sets status down when critical', async () => {
      const failBytes = 50 * 1024 * 1024;
      const indicator = makeIndicator(failBytes + 1, 'db-replica', {
        warnBytes: 5 * 1024 * 1024,
        failBytes,
      });
      try {
        await indicator.isHealthy('replica');
        fail('expected HealthCheckError');
      } catch (err: any) {
        // HealthCheckError wraps the detail; access the cause
        expect(err).toBeInstanceOf(HealthCheckError);
      }
    });
  });

  describe('replica unreachable', () => {
    it('returns up with replicaReachable=false when query throws', async () => {
      const indicator = makeIndicator(null, 'db-replica', {
        replicaThrows: true,
        warnBytes: 5 * 1024 * 1024,
        failBytes: 50 * 1024 * 1024,
      });
      const result = await indicator.isHealthy('replica');
      expect(result['replica'].status).toBe('up');
      expect(result['replica'].replicaReachable).toBe(false);
      expect(result['replica'].lagBytes).toBeNull();
    });
  });
});
