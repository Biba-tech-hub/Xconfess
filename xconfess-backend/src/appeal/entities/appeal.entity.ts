import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum AppealStatus {
  SUBMITTED = 'SUBMITTED',
  UNDER_REVIEW = 'UNDER_REVIEW',
  ESCALATED = 'ESCALATED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

@Entity('moderation_appeals')
@Index(['targetType', 'targetId'])
@Index(['userId'])
@Index(['status', 'slaDeadline'])
export class Appeal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'target_type', type: 'varchar', length: 50 })
  targetType: 'confession' | 'comment' | 'report';

  @Column({ name: 'target_id', type: 'varchar', length: 128 })
  targetId: string;

  @Column({ name: 'user_id', type: 'varchar', length: 128 })
  userId: string;

  @Column('text')
  reason: string;

  @Column('simple-array', { nullable: true })
  evidenceUrls: string[];

  @Column({
    type: 'enum',
    enum: AppealStatus,
    default: AppealStatus.SUBMITTED,
  })
  status: AppealStatus;

  @Column({ name: 'sla_deadline', type: 'timestamp' })
  slaDeadline: Date;

  @Column({ name: 'assigned_reviewer_id', type: 'varchar', nullable: true })
  assignedReviewerId?: string;

  @Column('text', { name: 'internal_notes', nullable: true })
  internalNotes?: string;

  @Column('text', { name: 'status_explanation' })
  statusExplanation: string;

  @Column({ name: 'is_escalated', default: false })
  isEscalated: boolean;

  @Column({ name: 'resolved_at', type: 'timestamp', nullable: true })
  resolvedAt?: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
