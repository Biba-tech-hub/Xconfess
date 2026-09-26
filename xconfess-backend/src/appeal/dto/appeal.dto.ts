import { AppealStatus } from '../entities/appeal.entity';

export class CreateAppealDto {
  targetType: 'confession' | 'comment' | 'report';
  targetId: string;
  reason: string;
  evidenceUrls?: string[];
}

export class ResolveAppealDto {
  decision: 'APPROVED' | 'REJECTED';
  statusExplanation: string;
  internalNotes?: string;
}

export interface UserAppealView {
  id: string;
  targetType: string;
  targetId: string;
  status: AppealStatus;
  statusExplanation: string;
  slaDeadline: Date;
  isEscalated: boolean;
  createdAt: Date;
  resolvedAt?: Date;
}
