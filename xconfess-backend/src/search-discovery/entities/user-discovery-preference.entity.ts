import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('user_discovery_preferences')
export class UserDiscoveryPreference {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'int', unique: true })
  @Index()
  userId: number;

  @Column({ name: 'personalization_opt_out', type: 'boolean', default: false })
  personalizationOptOut: boolean;

  @Column({ name: 'diversity_threshold', type: 'decimal', precision: 3, scale: 2, default: 0.35 })
  diversityThreshold: number;

  @Column('simple-array', { nullable: true })
  excludedCategories: string[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
