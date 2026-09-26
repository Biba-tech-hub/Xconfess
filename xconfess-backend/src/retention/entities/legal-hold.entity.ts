import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { RetentionDomain } from '../retention-policy.types';

@Entity('retention_legal_holds')
@Index(['domain', 'entityId'], { unique: true })
export class LegalHold {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 50 })
  domain: RetentionDomain;

  @Column({ name: 'entity_id', type: 'varchar', length: 128 })
  entityId: string;

  @Column('text')
  reason: string;

  @Column({ name: 'placed_by', type: 'varchar', length: 128 })
  placedBy: string;

  @CreateDateColumn()
  createdAt: Date;
}
