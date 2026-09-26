import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export interface ChainOfCustodyAccessRecord {
  accessedBy: string;
  role: string;
  timestamp: string;
  purpose: string;
}

@Entity('moderation_evidence')
@Index(['targetType', 'targetId'])
@Index(['retentionExpiresAt', 'isLegalHold'])
export class ModerationEvidence {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'target_type', type: 'varchar', length: 50 })
  targetType: 'confession' | 'comment' | 'report' | 'appeal';

  @Column({ name: 'target_id', type: 'varchar', length: 128 })
  targetId: string;

  @Column({ name: 'action', type: 'varchar', length: 50 })
  action: 'created' | 'edited' | 'deleted' | 'appeal_filed' | 'appeal_resolved' | 'action_applied';

  @Column('text')
  contentSnapshot: string;

  @Column({ name: 'content_sha256', type: 'varchar', length: 64 })
  contentSha256: string;

  @Column({ name: 'actor_id', type: 'varchar', nullable: true })
  actorId?: string;

  @Column({ name: 'actor_role', type: 'varchar', nullable: true })
  actorRole?: string;

  @Column('json', { nullable: true })
  metadata?: Record<string, any>;

  @Column({ name: 'is_legal_hold', default: false })
  isLegalHold: boolean;

  @Column({ name: 'retention_expires_at', type: 'timestamp', nullable: true })
  retentionExpiresAt?: Date;

  @Column('json', { default: () => "'[]'" })
  accessLogs: ChainOfCustodyAccessRecord[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
