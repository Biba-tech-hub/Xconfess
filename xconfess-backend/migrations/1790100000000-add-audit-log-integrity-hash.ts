import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `integrity_hash` column to `audit_logs`.
 *
 * The column stores an HMAC-SHA256 tag over canonical record fields (id,
 * action, adminId, entityType, entityId, requestId, ipAddress, createdAt)
 * keyed on APP_SECRET.  Records created before this migration will have a
 * NULL integrity_hash, which the application reports as `no_hash` rather
 * than `tampered`.
 *
 * Rolling this back drops the column; no data is recovered.
 */
export class AddAuditLogIntegrityHash1790100000000
  implements MigrationInterface
{
  name = 'AddAuditLogIntegrityHash1790100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "audit_logs"
      ADD COLUMN IF NOT EXISTS "integrity_hash" VARCHAR(64) NULL
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN "audit_logs"."integrity_hash"
      IS 'HMAC-SHA256 over canonical record fields for tamper detection'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "audit_logs"
      DROP COLUMN IF EXISTS "integrity_hash"
    `);
  }
}
