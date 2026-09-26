import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RetentionService } from './retention.service';
import { RetentionController } from './retention.controller';
import { LegalHold } from './entities/legal-hold.entity';
import { RetentionAuditLog } from './entities/retention-audit-log.entity';
import { AuthModule } from '../auth/auth.module';
import { UserModule } from '../user/user.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([LegalHold, RetentionAuditLog]),
    AuthModule,
    UserModule,
  ],
  providers: [RetentionService],
  controllers: [RetentionController],
  exports: [RetentionService],
})
export class RetentionModule {}
