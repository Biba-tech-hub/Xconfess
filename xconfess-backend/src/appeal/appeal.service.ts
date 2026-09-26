import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, LessThan } from 'typeorm';
import { Appeal, AppealStatus } from './entities/appeal.entity';
import { CreateAppealDto, ResolveAppealDto, UserAppealView } from './dto/appeal.dto';

@Injectable()
export class AppealService {
  private readonly logger = new Logger(AppealService.name);
  private readonly SLA_HOURS = 48;
  private readonly MAX_EVIDENCE_ITEMS = 3;

  constructor(
    @InjectRepository(Appeal)
    private readonly appealRepo: Repository<Appeal>,
  ) {}

  async submitAppeal(userId: string, dto: CreateAppealDto): Promise<UserAppealView> {
    if (dto.evidenceUrls && dto.evidenceUrls.length > this.MAX_EVIDENCE_ITEMS) {
      throw new BadRequestException(`Maximum ${this.MAX_EVIDENCE_ITEMS} evidence items allowed per appeal`);
    }

    // Check for open duplicate appeal
    const activeAppeal = await this.appealRepo.findOne({
      where: {
        targetType: dto.targetType,
        targetId: dto.targetId,
        status: In([AppealStatus.SUBMITTED, AppealStatus.UNDER_REVIEW, AppealStatus.ESCALATED]),
      },
    });

    if (activeAppeal) {
      throw new ConflictException('An active appeal is already pending review for this item');
    }

    const slaDeadline = new Date(Date.now() + this.SLA_HOURS * 60 * 60 * 1000);
    const appeal = this.appealRepo.create({
      targetType: dto.targetType,
      targetId: dto.targetId,
      userId,
      reason: dto.reason,
      evidenceUrls: dto.evidenceUrls || [],
      status: AppealStatus.SUBMITTED,
      slaDeadline,
      statusExplanation: `Appeal submitted successfully. Review scheduled within ${this.SLA_HOURS}-hour SLA window.`,
      isEscalated: false,
    });

    const saved = await this.appealRepo.save(appeal);
    this.logger.log(`Appeal ${saved.id} created for ${dto.targetType}:${dto.targetId} by user ${userId}`);
    return this.toUserView(saved);
  }

  async getAppealForUser(userId: string, appealId: string): Promise<UserAppealView> {
    const appeal = await this.appealRepo.findOne({
      where: { id: appealId, userId },
    });
    if (!appeal) {
      throw new NotFoundException(`Appeal ${appealId} not found`);
    }
    return this.toUserView(appeal);
  }

  async listUserAppeals(userId: string): Promise<UserAppealView[]> {
    const appeals = await this.appealRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
    return appeals.map((a) => this.toUserView(a));
  }

  async assignReviewer(appealId: string, reviewerId: string): Promise<Appeal> {
    const appeal = await this.appealRepo.findOne({ where: { id: appealId } });
    if (!appeal) {
      throw new NotFoundException(`Appeal ${appealId} not found`);
    }

    appeal.assignedReviewerId = reviewerId;
    if (appeal.status === AppealStatus.SUBMITTED) {
      appeal.status = AppealStatus.UNDER_REVIEW;
      appeal.statusExplanation = 'Your appeal is currently actively under review by moderation staff.';
    }

    return this.appealRepo.save(appeal);
  }

  async escalateOverdueAppeals(): Promise<number> {
    const overdue = await this.appealRepo.find({
      where: {
        status: In([AppealStatus.SUBMITTED, AppealStatus.UNDER_REVIEW]),
        slaDeadline: LessThan(new Date()),
      },
    });

    if (overdue.length === 0) return 0;

    for (const item of overdue) {
      item.status = AppealStatus.ESCALATED;
      item.isEscalated = true;
      item.statusExplanation = 'Your appeal has exceeded standard SLA and is prioritized for expedited senior review.';
      await this.appealRepo.save(item);
    }

    this.logger.warn(`Escalated ${overdue.length} overdue appeals exceeding SLA deadline`);
    return overdue.length;
  }

  async getStaffQueue(onlyEscalated = false): Promise<Appeal[]> {
    await this.escalateOverdueAppeals();

    const query = this.appealRepo.createQueryBuilder('appeal');
    if (onlyEscalated) {
      query.where('appeal.isEscalated = :esc', { esc: true });
    } else {
      query.where('appeal.status IN (:...statuses)', {
        statuses: [AppealStatus.SUBMITTED, AppealStatus.UNDER_REVIEW, AppealStatus.ESCALATED],
      });
    }

    return query
      .orderBy('appeal.isEscalated', 'DESC')
      .addOrderBy('appeal.slaDeadline', 'ASC')
      .getMany();
  }

  async resolveAppeal(
    appealId: string,
    reviewerId: string,
    dto: ResolveAppealDto,
  ): Promise<Appeal> {
    const appeal = await this.appealRepo.findOne({ where: { id: appealId } });
    if (!appeal) {
      throw new NotFoundException(`Appeal ${appealId} not found`);
    }

    appeal.status = dto.decision === 'APPROVED' ? AppealStatus.APPROVED : AppealStatus.REJECTED;
    appeal.assignedReviewerId = reviewerId;
    appeal.statusExplanation = dto.statusExplanation;
    appeal.internalNotes = dto.internalNotes;
    appeal.resolvedAt = new Date();

    const saved = await this.appealRepo.save(appeal);
    this.logger.log(`Appeal ${appealId} resolved with decision ${appeal.status} by reviewer ${reviewerId}`);
    return saved;
  }

  private toUserView(appeal: Appeal): UserAppealView {
    return {
      id: appeal.id,
      targetType: appeal.targetType,
      targetId: appeal.targetId,
      status: appeal.status,
      statusExplanation: appeal.statusExplanation,
      slaDeadline: appeal.slaDeadline,
      isEscalated: appeal.isEscalated,
      createdAt: appeal.createdAt,
      resolvedAt: appeal.resolvedAt,
    };
  }
}
