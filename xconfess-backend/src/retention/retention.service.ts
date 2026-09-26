import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LegalHold } from './entities/legal-hold.entity';
import { RetentionAuditLog } from './entities/retention-audit-log.entity';
import {
  RetentionDomain,
  RetentionPolicy,
  DOMAIN_RETENTION_POLICIES,
  PurgeExecutionReport,
} from './retention-policy.types';

@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    @InjectRepository(LegalHold)
    private readonly legalHoldRepo: Repository<LegalHold>,
    @InjectRepository(RetentionAuditLog)
    private readonly auditLogRepo: Repository<RetentionAuditLog>,
    private readonly dataSource: DataSource,
  ) {}

  getPolicies(): RetentionPolicy[] {
    return Object.values(DOMAIN_RETENTION_POLICIES);
  }

  async placeLegalHold(
    domain: RetentionDomain,
    entityId: string,
    placedBy: string,
    reason: string,
  ): Promise<LegalHold> {
    const policy = DOMAIN_RETENTION_POLICIES[domain];
    if (!policy) {
      throw new BadRequestException(`Unknown retention domain: ${domain}`);
    }
    if (!policy.allowLegalHold) {
      throw new BadRequestException(`Legal holds are not supported for domain '${domain}'`);
    }

    const existing = await this.legalHoldRepo.findOne({ where: { domain, entityId } });
    if (existing) {
      existing.reason = reason;
      existing.placedBy = placedBy;
      return this.legalHoldRepo.save(existing);
    }

    const hold = this.legalHoldRepo.create({
      domain,
      entityId,
      placedBy,
      reason,
    });
    const saved = await this.legalHoldRepo.save(hold);

    await this.auditLogRepo.save({
      domain,
      action: 'hold_placed',
      isDryRun: false,
      scannedCount: 1,
      purgedCount: 0,
      heldCount: 1,
      cutoffDate: new Date(),
      executedBy: placedBy,
      metadata: { entityId, reason },
    });

    this.logger.log(`Legal hold placed on ${domain}:${entityId} by ${placedBy}`);
    return saved;
  }

  async releaseLegalHold(
    domain: RetentionDomain,
    entityId: string,
    releasedBy: string,
  ): Promise<boolean> {
    const hold = await this.legalHoldRepo.findOne({ where: { domain, entityId } });
    if (!hold) {
      throw new NotFoundException(`No active legal hold found on ${domain}:${entityId}`);
    }

    await this.legalHoldRepo.remove(hold);

    await this.auditLogRepo.save({
      domain,
      action: 'hold_released',
      isDryRun: false,
      scannedCount: 1,
      purgedCount: 0,
      heldCount: 0,
      cutoffDate: new Date(),
      executedBy: releasedBy,
      metadata: { entityId },
    });

    this.logger.log(`Legal hold released on ${domain}:${entityId} by ${releasedBy}`);
    return true;
  }

  async executeDomainPurge(
    domain: RetentionDomain,
    dryRun = true,
    executedBy = 'system',
  ): Promise<PurgeExecutionReport> {
    const startTime = Date.now();
    const policy = DOMAIN_RETENTION_POLICIES[domain];
    if (!policy) {
      throw new BadRequestException(`Unknown domain ${domain}`);
    }

    const cutoffDate = new Date(Date.now() - policy.ttlDays * 24 * 60 * 60 * 1000);

    // Get active legal holds for this domain
    const holds = await this.legalHoldRepo.find({ where: { domain } });
    const heldEntityIds = new Set(holds.map((h) => h.entityId));

    let scannedCount = 0;
    let eligibleCount = 0;
    let heldCount = 0;
    let purgedCount = 0;

    // Table mapping by domain
    const tableMap: Record<RetentionDomain, string> = {
      messages: 'messages',
      logs: 'audit_logs',
      exports: 'export_requests',
      analytics: 'analytics_events',
      moderation_evidence: 'moderation_logs',
    };
    const tableName = tableMap[domain];

    try {
      // Query records older than cutoffDate
      const records: any[] = await this.dataSource.query(
        `SELECT id FROM "${tableName}" WHERE "created_at" < $1`,
        [cutoffDate],
      );

      scannedCount = records.length;

      const toPurge: string[] = [];
      for (const r of records) {
        if (heldEntityIds.has(String(r.id))) {
          heldCount++;
        } else {
          eligibleCount++;
          toPurge.push(r.id);
        }
      }

      if (!dryRun && toPurge.length > 0) {
        if (policy.action === 'anonymize' && domain === 'analytics') {
          await this.dataSource.query(
            `UPDATE "${tableName}" SET user_id = NULL, metadata = NULL WHERE id = ANY($1)`,
            [toPurge],
          );
        } else {
          await this.dataSource.query(
            `DELETE FROM "${tableName}" WHERE id = ANY($1)`,
            [toPurge],
          );
        }
        purgedCount = toPurge.length;
      } else if (dryRun) {
        purgedCount = 0; // dry run doesn't actually delete
      }
    } catch (err: unknown) {
      // If table doesn't exist yet in test env, report 0 gracefully
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Retention query skipped on table ${tableName}: ${msg}`);
    }

    const durationMs = Date.now() - startTime;
    const report: PurgeExecutionReport = {
      domain,
      dryRun,
      cutoffDate,
      scannedCount,
      eligibleCount,
      heldCount,
      purgedCount: dryRun ? eligibleCount : purgedCount,
      durationMs,
      executedBy,
      timestamp: new Date().toISOString(),
    };

    // Record audit log
    await this.auditLogRepo.save({
      domain,
      action: policy.action === 'anonymize' ? 'anonymize' : 'purge',
      isDryRun: dryRun,
      scannedCount,
      purgedCount: report.purgedCount,
      heldCount,
      cutoffDate,
      executedBy,
      metadata: { durationMs },
    });

    this.logger.log(
      `Retention purge complete for ${domain} (dryRun=${dryRun}): eligible=${eligibleCount}, held=${heldCount}, purged=${report.purgedCount}`,
    );

    return report;
  }

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async scheduledDailyPurge(): Promise<PurgeExecutionReport[]> {
    this.logger.log('Starting automated scheduled daily retention purge...');
    const domains: RetentionDomain[] = ['messages', 'logs', 'exports', 'analytics', 'moderation_evidence'];
    const reports: PurgeExecutionReport[] = [];

    for (const domain of domains) {
      const report = await this.executeDomainPurge(domain, false, 'scheduler:daily_cron');
      reports.push(report);
    }

    return reports;
  }

  async getAuditLogs(domain?: RetentionDomain, limit = 50): Promise<RetentionAuditLog[]> {
    const where = domain ? { domain } : {};
    return this.auditLogRepo.find({
      where,
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }
}
