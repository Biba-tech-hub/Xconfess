import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { LockoutService } from './lockout.service';
import { CacheModule } from '../cache/cache.module';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';
import { PasswordResetService } from './password-reset.service';
import { StepUpService } from './step-up.service';
import { StepUpGuard } from './guards/step-up.guard';
import { UserModule } from '../user/user.module';
import { EmailModule } from '../email/email.module';
import { PasswordReset } from './entities/password-reset.entity';
import { Session } from './entities/session.entity';
import { SessionService } from './session.service';
import { SessionRevocationSubscriber } from './session-revocation.subscriber';

@Module({
  imports: [
    forwardRef(() => UserModule),
    CacheModule,
    EmailModule,
    PassportModule,
    TypeOrmModule.forFeature([PasswordReset, Session]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get('JWT_SECRET'),
        signOptions: { expiresIn: '1d' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    LockoutService,
    AuthService,
    JwtStrategy,
    PasswordResetService,
    StepUpService,
    StepUpGuard,
    OptionalJwtAuthGuard,
    SessionService,
    SessionRevocationSubscriber,
  ],
  exports: [
    AuthService,
    LockoutService,
    JwtModule,
    StepUpService,
    StepUpGuard,
    OptionalJwtAuthGuard,
    SessionService,
  ],
})
export class AuthModule {}
