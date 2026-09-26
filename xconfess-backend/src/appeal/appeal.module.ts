import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Appeal } from './entities/appeal.entity';
import { AppealService } from './appeal.service';
import { AppealController } from './appeal.controller';
import { AuthModule } from '../auth/auth.module';
import { UserModule } from '../user/user.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Appeal]),
    AuthModule,
    UserModule,
  ],
  providers: [AppealService],
  controllers: [AppealController],
  exports: [AppealService],
})
export class AppealModule {}
