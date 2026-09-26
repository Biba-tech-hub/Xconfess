import { Injectable, Logger, ForbiddenException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import * as crypto from 'crypto';
import { ModerationEvidence, ChainOfCustodyAccessRecord } from './entities/moderation-evidence.entity';

export interface CaptureEvidenceDto {
  targetType: 'confession' | 'comment' | 'report' | 'appeal';
  targetId: string;
  action: 'created' | 'edited' | 'deleted' | 'appeal_filed' | 'appeal_resolved' | 'action_applied';
  content: string;
  actorId?: string;
  actorRole?: string;
  metadata?: Record<string, any>;
  retentionDays?: number;
  isLegalHold?: boolean;
}

export interface ChainOfCustodyExport {
  evidenceId: string;
  targetType: string;
  targetId: string;
  action: string;
  contentSnapshot: string;
  contentSha256: string;
  integrityVerified: boolean;
  actorId?: string;
  actorRole?: string;
  isLegalHold: boolean;
  retentionExpiresAt?: Date;
  accessLogs: ChainOfCustodyAccessRecord[];
  createdAt: Date;
}

@Injectable()
export class ModerationEvidenceService {
  private readonly logger = new Logger(ModerationEvidenceService.name);

  constructor(
    @InjectRepository(ModerationEvidence)
    private readonly evidenceRepository: Repository<ModerationEvidence>,
  ) {}

  public static hashContent(content: string): string {
    return crypto.createHash('sha256').update(content ?? '', 'utf8').digest('hex');
  }

  async captureEvidence(dto: CaptureEvidenceDto): Promise<ModerationEvidence> {
    const hash = ModerationEvidenceService.hashContent(dto.content);
    const retentionDays = dto.retentionDays ?? 90;
    const retentionExpiresAt = dto.isLegalHold
      ? undefined
      : new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);

    const evidence = this.evidenceRepository.create({
      targetType: dto.targetType,
      targetId: dto.targetId,
      action: dto.action,
      contentSnapshot: dto.content,
      contentSha256: hash,
      actorId: dto.actorId,
      actorRole: dto.actorRole,
      metadata: dto.metadata || {},
      isLegalHold: dto.isLegalHold ?? false,
      retentionExpiresAt,
      accessLogs: [
        {
          accessedBy: dto.actorId || 'system',
          role: dto.actorRole || 'system',
          timestamp: new Date().toISOString(),
          purpose: `Evidence captured for ${dto.action} on ${dto.targetType}:${dto.targetId}`,
        },
      ],
    });

    const saved = await this.evidenceRepository.save(evidence);
    this.logger.log(`Evidence captured: id=${saved.id} hash=${hash} target=${dto.targetType}:${dto.targetId}`);
    return saved;
  }

  async verifyEvidenceIntegrity(evidenceId: string): Promise<{ verified: boolean; expectedHash: string; computedHash: string }> {
    const evidence = await this.evidenceRepository.findOne({ where: { id: evidenceId } });
    if (!evidence) {
      throw new NotFoundException(`Evidence with ID ${evidenceId} not found`);
    }

    const computedHash = ModerationEvidenceService.hashContent(evidence.contentSnapshot);
    const verified = computedHash === evidence.contentSha256;
    return {
      verified,
      expectedHash: evidence.contentSha256,
      computedHash,
    };
  }

  async logChainOfCustodyAccess(
    evidenceId: string,
    accessedBy: string,
    role: string,
    purpose: string,
  ): Promise<ModerationEvidence> {
    const evidence = await this.evidenceRepository.findOne({ where: { id: evidenceId } });
    if (!evidence) {
      throw new NotFoundException(`Evidence with ID ${evidenceId} not found`);
    }

    const record: ChainOfCustodyAccessRecord = {
      accessedBy,
      role,
      timestamp: new Date().toISOString(),
      purpose,
    };

    evidence.accessLogs = [...(evidence.accessLogs || []), record];
    return this.evidenceRepository.save(evidence);
  }

  async exportChainOfCustody(
    evidenceId: string,
    requesterId: string,
    requesterRole: string,
    purpose: string,
  ): Promise<ChainOfCustodyExport> {
    const allowedRoles = ['admin', 'moderator', 'compliance'];
    if (!allowedRoles.includes(requesterRole)) {
      throw new ForbiddenException('Insufficient permissions to export chain of custody evidence');
    }

    const evidence = await this.evidenceRepository.findOne({ where: { id: evidenceId } });
    if (!evidence) {
      throw new NotFoundException(`Evidence with ID ${evidenceId} not found`);
    }

    // Record access
    await this.logChainOfCustodyAccess(evidenceId, requesterId, requesterRole, `Chain-of-custody export: ${purpose}`);

    const computedHash = ModerationEvidenceService.hashContent(evidence.contentSnapshot);
    const integrityVerified = computedHash === evidence.contentSha256;

    return {
      evidenceId: evidence.id,
      targetType: evidence.targetType,
      targetId: evidence.targetId,
      action: evidence.action,
      contentSnapshot: evidence.contentSnapshot,
      contentSha256: evidence.contentSha256,
      integrityVerified,
      actorId: evidence.actorId,
      actorRole: evidence.actorRole,
      isLegalHold: evidence.isLegalHold,
      retentionExpiresAt: evidence.retentionExpiresAt,
      accessLogs: evidence.accessLogs,
      createdAt: evidence.createdAt,
    };
  }

  async setLegalHold(
    evidenceId: string,
    actorId: string,
    actorRole: string,
    hold: boolean,
    reason: string,
  ): Promise<ModerationEvidence> {
    const allowedRoles = ['admin', 'compliance'];
    if (!allowedRoles.includes(actorRole)) {
      throw new ForbiddenException('Only admin or compliance roles may alter legal hold status');
    }

    const evidence = await this.evidenceRepository.findOne({ where: { id: evidenceId } });
    if (!evidence) {
      throw new NotFoundException(`Evidence with ID ${evidenceId} not found`);
    }

    evidence.isLegalHold = hold;
    if (hold) {
      evidence.retentionExpiresAt = undefined;
    }

    await this.logChainOfCustodyAccess(
      evidenceId,
      actorId,
      actorRole,
      `${hold ? 'Placed on' : 'Released from'} legal hold: ${reason}`,
    );

    return this.evidenceRepository.save(evidence);
  }

  async purgeExpiredEvidence(cutoffDate: Date = new Date()): Promise<number> {
    const expiredRecords = await this.evidenceRepository.find({
      where: {
        retentionExpiresAt: LessThan(cutoffDate),
        isLegalHold: false,
      },
    });

    if (expiredRecords.length === 0) {
      return 0;
    }

    const ids = expiredRecords.map((r) => r.id);
    await this.evidenceRepository.delete(ids);
    this.logger.log(`Purged ${ids.length} expired moderation evidence records complying with retention policy`);
    return ids.length;
  }
}
