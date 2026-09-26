import { Module, Global } from '@nestjs/common';
import { QueryAnalyzer } from './query-analyzer';
import { MigrationVerificationService } from './migration-verification.service';
import { DatabasePoolObservabilityService } from './database-pool-observability.service';

@Global()
@Module({
  providers: [QueryAnalyzer, MigrationVerificationService, DatabasePoolObservabilityService],
  exports: [QueryAnalyzer, MigrationVerificationService, DatabasePoolObservabilityService],
})
export class DatabaseModule {}

