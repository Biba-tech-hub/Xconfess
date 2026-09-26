import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AuditLogIntegrityService } from './audit-log-integrity.service';
import { AuditLog, AuditActionType } from './audit-log.entity';

function makeRecord(overrides: Partial<AuditLog> = {}): AuditLog {
  const record = new AuditLog();
  record.id = 'test-uuid-1234';
  record.action = AuditActionType.FAILED_LOGIN;
  record.adminId = null;
  record.entityType = 'user';
  record.entityId = 'entity-123';
  record.requestId = 'req-abc';
  record.ipAddress = '127.0.0.1';
  record.createdAt = new Date('2026-01-01T00:00:00.000Z');
  record.integrityHash = null;
  Object.assign(record, overrides);
  return record;
}

describe('AuditLogIntegrityService', () => {
  let service: AuditLogIntegrityService;

  const validSecret = 'a-valid-app-secret-for-testing-32chars';

  async function buildService(secret?: string) {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditLogIntegrityService,
        {
          provide: ConfigService,
          useValue: { get: () => secret },
        },
      ],
    }).compile();
    return module.get<AuditLogIntegrityService>(AuditLogIntegrityService);
  }

  describe('when APP_SECRET is configured', () => {
    beforeEach(async () => {
      service = await buildService(validSecret);
    });

    it('computeIntegrityHash returns a 64-char hex string', () => {
      const hash = service.computeIntegrityHash({
        id: 'id-1',
        action: 'failed_login',
        adminId: null,
        entityType: null,
        entityId: null,
        requestId: null,
        ipAddress: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces the same hash for identical inputs (deterministic)', () => {
      const input = {
        id: 'id-1',
        action: 'failed_login',
        adminId: 42,
        entityType: 'user',
        entityId: 'u-99',
        requestId: 'req-1',
        ipAddress: '10.0.0.1',
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      const h1 = service.computeIntegrityHash(input);
      const h2 = service.computeIntegrityHash(input);
      expect(h1).toBe(h2);
    });

    it('produces different hashes when any field changes', () => {
      const base = {
        id: 'id-1',
        action: 'failed_login',
        adminId: null,
        entityType: null,
        entityId: null,
        requestId: null,
        ipAddress: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      const h1 = service.computeIntegrityHash(base);
      const h2 = service.computeIntegrityHash({ ...base, ipAddress: '1.2.3.4' });
      expect(h1).not.toBe(h2);
    });

    it('verifyRecord returns "ok" for a valid record', () => {
      const record = makeRecord();
      const hash = service.computeIntegrityHash({
        id: record.id,
        action: record.action,
        adminId: record.adminId,
        entityType: record.entityType,
        entityId: record.entityId,
        requestId: record.requestId,
        ipAddress: record.ipAddress,
        createdAt: record.createdAt.toISOString(),
      });
      record.integrityHash = hash;
      expect(service.verifyRecord(record)).toBe('ok');
    });

    it('verifyRecord returns "tampered" when the stored hash does not match', () => {
      const record = makeRecord({ integrityHash: 'a'.repeat(64) });
      expect(service.verifyRecord(record)).toBe('tampered');
    });

    it('verifyRecord returns "no_hash" when integrityHash is null', () => {
      const record = makeRecord({ integrityHash: null });
      expect(service.verifyRecord(record)).toBe('no_hash');
    });

    it('isConfigured returns true', () => {
      expect(service.isConfigured).toBe(true);
    });
  });

  describe('when APP_SECRET is not configured', () => {
    beforeEach(async () => {
      service = await buildService(undefined);
    });

    it('computeIntegrityHash returns null', () => {
      const hash = service.computeIntegrityHash({
        id: 'id-1',
        action: 'failed_login',
        adminId: null,
        entityType: null,
        entityId: null,
        requestId: null,
        ipAddress: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      expect(hash).toBeNull();
    });

    it('verifyRecord returns "no_secret"', () => {
      const record = makeRecord({ integrityHash: 'a'.repeat(64) });
      expect(service.verifyRecord(record)).toBe('no_secret');
    });

    it('isConfigured returns false', () => {
      expect(service.isConfigured).toBe(false);
    });
  });
});
