import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from './audit-log.entity';
import { AuditLogService } from './audit-log.service';
import { AuditLogRedactionService } from './audit-log-redaction.service';
import { AuditLogIntegrityService } from './audit-log-integrity.service';

@Module({
  imports: [TypeOrmModule.forFeature([AuditLog])],
  providers: [AuditLogService, AuditLogRedactionService, AuditLogIntegrityService],
  exports: [AuditLogService, AuditLogRedactionService, AuditLogIntegrityService],
})
export class AuditLogModule {}
