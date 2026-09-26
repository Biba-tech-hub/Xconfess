import * as crypto from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditLog } from './audit-log.entity';

/**
 * Canonical field names covered by the HMAC integrity tag.
 *
 * These represent the *immutable event facts* of a record.  Mutable context
 * columns (metadata, notes) are intentionally excluded so that safe
 * administrative annotation does not invalidate existing integrity tags.
 *
 * Changing this list is a breaking change — existing integrity hashes will
 * no longer verify.  If you need to add fields, write a migration that
 * recomputes all existing hashes.
 */
const INTEGRITY_FIELDS = [
  'id',
  'action',
  'adminId',
  'entityType',
  'entityId',
  'requestId',
  'ipAddress',
] as const;

/**
 * AuditLogIntegrityService
 *
 * Computes and verifies HMAC-SHA256 integrity tags for audit log records.
 *
 * Design decisions:
 *  - APP_SECRET is used as the HMAC key (already required by the application).
 *  - The canonical message is a deterministic JSON string of fixed fields plus
 *    a `createdAt` ISO timestamp so records are replay-resistant (a copy of a
 *    record with a different timestamp will produce a different HMAC).
 *  - When APP_SECRET is absent (local dev without secrets), the service skips
 *    HMAC computation and logs a warning rather than crashing.
 *
 * Threat model:
 *  - Detects *database-level* tampering (direct SQL UPDATE/INSERT).
 *  - Does NOT protect against an attacker who has access to APP_SECRET AND
 *    the database simultaneously — that requires a separate signing key with
 *    stricter access controls, which is out of scope for this issue.
 */
@Injectable()
export class AuditLogIntegrityService {
  private readonly logger = new Logger(AuditLogIntegrityService.name);
  private readonly secret: string | undefined;

  constructor(private readonly configService: ConfigService) {
    const secret = this.configService.get<string>('APP_SECRET');
    if (!secret || secret.trim().length < 16) {
      this.logger.warn(
        'APP_SECRET is not set or is too short — audit log integrity tags will be skipped. ' +
          'Set APP_SECRET to a random string of at least 32 characters in production.',
      );
      this.secret = undefined;
    } else {
      this.secret = secret;
    }
  }

  /**
   * Compute the HMAC-SHA256 integrity tag for the provided field values.
   *
   * Returns `null` when APP_SECRET is not configured.
   */
  computeIntegrityHash(fields: {
    id: string;
    action: string;
    adminId: number | null;
    entityType: string | null;
    entityId: string | null;
    requestId: string | null;
    ipAddress: string | null;
    createdAt: string; // ISO-8601 timestamp
  }): string | null {
    if (!this.secret) {
      return null;
    }

    // Deterministic canonical form: always the same field order and null representation
    const canonical = JSON.stringify({
      id: fields.id,
      action: fields.action,
      adminId: fields.adminId ?? null,
      entityType: fields.entityType ?? null,
      entityId: fields.entityId ?? null,
      requestId: fields.requestId ?? null,
      ipAddress: fields.ipAddress ?? null,
      createdAt: fields.createdAt,
    });

    return crypto
      .createHmac('sha256', this.secret)
      .update(canonical, 'utf8')
      .digest('hex');
  }

  /**
   * Verify the integrity tag of an existing audit log record.
   *
   * Returns:
   *  - `'ok'`         — the computed HMAC matches the stored hash.
   *  - `'tampered'`   — the hashes differ; the record may have been modified.
   *  - `'no_hash'`    — the record has no stored hash (pre-dates this feature).
   *  - `'no_secret'`  — APP_SECRET is not configured; cannot verify.
   */
  verifyRecord(
    record: AuditLog,
  ): 'ok' | 'tampered' | 'no_hash' | 'no_secret' {
    if (!this.secret) {
      return 'no_secret';
    }

    if (!record.integrityHash) {
      return 'no_hash';
    }

    const expected = this.computeIntegrityHash({
      id: record.id,
      action: record.action,
      adminId: record.adminId,
      entityType: record.entityType,
      entityId: record.entityId,
      requestId: record.requestId,
      ipAddress: record.ipAddress,
      createdAt: record.createdAt.toISOString(),
    });

    if (!expected) {
      return 'no_secret';
    }

    // Use timing-safe comparison to prevent oracle attacks
    const expectedBuf = Buffer.from(expected, 'hex');
    const actualBuf = Buffer.from(record.integrityHash, 'hex');

    if (
      expectedBuf.length !== actualBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, actualBuf)
    ) {
      this.logger.warn(
        `Audit log integrity check FAILED for record id=${record.id} action=${record.action}. ` +
          'This record may have been tampered with.',
      );
      return 'tampered';
    }

    return 'ok';
  }

  /** Returns `true` when APP_SECRET is configured and HMAC can be computed. */
  get isConfigured(): boolean {
    return !!this.secret;
  }
}
