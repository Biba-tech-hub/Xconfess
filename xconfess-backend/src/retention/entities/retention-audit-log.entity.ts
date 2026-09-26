import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { RetentionDomain } from '../retention-policy.types';

@Entity('retention_audit_logs')
@Index(['domain', 'createdAt'])
export class RetentionAuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 50 })
  domain: RetentionDomain;

  @Column({ type: 'varchar', length: 50 })
  action: 'purge' | 'anonymize' | 'hold_placed' | 'hold_released';

  @Column({ name: 'is_dry_run', type: 'boolean', default: false })
  isDryRun: boolean;

  @Column({ name: 'scanned_count', type: 'int', default: 0 })
  scannedCount: number;

  @Column({ name: 'purged_count', type: 'int', default: 0 })
  purgedCount: number;

  @Column({ name: 'held_count', type: 'int', default: 0 })
  heldCount: number;

  @Column({ name: 'cutoff_date', type: 'timestamp' })
  cutoffDate: Date;

  @Column({ name: 'executed_by', type: 'varchar', length: 128 })
  executedBy: string;

  @Column('json', { nullable: true })
  metadata?: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;
}
