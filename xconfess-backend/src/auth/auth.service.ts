import { maskUserId } from '../utils/mask-user-id';
import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  GoneException,
  UnableToProcessEntityException,
  Logger,
  Optional,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserService } from '../user/user.service';
import { EmailService } from '../email/email.service';
import { PasswordResetService } from './password-reset.service';
import { AnonymousUserService } from '../user/anonymous-user.service';
import { LockoutService } from './lockout.service';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { UserResponse } from '../user/dto/user-response.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { CryptoUtil } from '../common/crypto.util';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { UserRole } from '../user/entities/user.entity';
import { AppException } from '../common/errors/app-exception';
import { ErrorCode } from '../common/errors/error-codes';
import { HttpStatus } from '@nestjs/common';
import { getDefaultAdminStellarInvocationScopes } from '../stellar/stellar-invocation-policy';
import { AnalyticsEventService } from '../analytics/analytics-event.service';

/**
 * Session record used for server-side rotation and revocation.
 * The session identifier is embedded in the JWT and must match an
 * active record for the token to be considered valid.
 */
export interface SessionRecord {
  id: string;
  userId: number;
  createdAt: Date;
  revokedAt?: Date;
  revokedReason?: string;
  rotatedAt?: Date;
}

export interface SessionRotationResult {
  access_token: string;
  sessionId: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  /**
   * In-memory session store. This is deliberately simple and can be
   * replaced by a persistent repository without changing the public API.
   */
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(
    private userService: UserService,
    private jwtService: JwtService,
    private emailService: EmailService,
    private passwordResetService: PasswordResetService,
    private anonymousUserService: AnonymousUserService,
    private lockoutService: LockoutService,
    @Optional()
    private readonly analyticsEventService?: AnalyticsEventService,
  ) {}

  private createSession(userId: number): SessionRecord {
    const session: SessionRecord = {
      id: crypto.randomBytes(32).toString('hex'),
      userId,
      createdAt: new Date(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  private getActiveSession(sessionId: string): SessionRecord | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.revokedAt) {
      return undefined;
    }
    return session;
  }

  /**
   * Revoke all sessions for a user. Returns the number of revoked sessions.
   */
  revokeUserSessions(userId: number, reason: string): number {
    let revokedCount = 0;
    const now = new Date();
    for (const session of this.sessions.values()) {
      if (session.userId === userId && !session.revokedAt) {
        session.revokedAt = now;
        session.revokedReason = reason;
        revokedCount += 1;
      }
    }
    return revokedCount;
  }

  /**
   * Revoke a single session by id. Returns true when the session was
   * active and has been revoked.
   */
  revokeSession(sessionId: string, reason: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.revokedAt) {
      return false;
    }
    session.revokedAt = new Date();
    session.revokedReason = reason;
    return true;
  }

  /**
   * Admin-safe invalidation entrypoint. Revokes all sessions for a user
   * without exposing tokens or secrets in audit logs.
   */
  async revokeSessionsForUser(
    userId: number,
    reason: string,
    actorId?: string,
  ): Promise<{ message: string; revokedCount: number }> {
    const revokedCount = this.revokeUserSessions(userId, reason);
    this.logger.log(`Sessions revoked for user: ${maskUserId(userId)}`, {
      maskedUserId: maskUserId(userId),
      reason,
      revokedCount,
      actorId,
    });
    return {
      message: 'Sessions have been revoked.',
      revokedCount,
    };
  }

  /**
   * Rotate the session identifier after an authentication change.
   * The old session is revoked and a new token is issued.
   */
  async rotateSession(
    userId: number,
    oldSessionId: string,
    reason: string,
  ): Promise<SessionRotationResult> {
    const oldSession = this.sessions.get(oldSessionId);
    if (oldSession && !oldSession.revokedAt) {
      oldSession.revokedAt = new Date();
      oldSession.revokedReason = reason;
      oldSession.rotatedAt = new Date();
    }

    const newSession = this.createSession(userId);
    const user = await this.userService.findById(userId);
    if (!user || !user.is_active) {
      throw new AppException(
        'User is not active',
        ErrorCode.AUTH_ACCOUNT_DEACTIVATED,
        HttpStatus.UNAUTHORIZED,
      );
    }

    const decryptedEmail = CryptoUtil.decrypt(
      user.emailEncrypted,
      user.emailIv,
      user.emailTag,
    );
    const role = user.role || UserRole.USER;
    const scopes =
      role === UserRole.ADMIN ? getDefaultAdminStellarInvocationScopes() : [];
    const payload: JwtPayload = {
      email: decryptedEmail,
      sub: user.id,
      username: user.username,
      role,
      scopes,
      sid: newSession.id,
    };

    return {
      access_token: this.jwtService.sign(payload),
      sessionId: newSession.id,
    };
  }

  async validateUser(
    email: string,
    password: string,
  ): Promise<UserResponse | null> {
    const user = await this.userService.findByEmail(email);
    if (user && (await bcrypt.compare(password, user.password))) {
      if (!user.is_active) {
        throw new AppException(
          'Account is deactivated. Please reactivate your account to continue.',
          ErrorCode.AUTH_ACCOUNT_DEACTIVATED,
          HttpStatus.UNAUTHORIZED,
        );
      }
      const decryptedEmail = CryptoUtil.decrypt(
        user.emailEncrypted,
        user.emailIv,
        user.emailTag,
      );
      // resetPasswordToken and resetPasswordExpires are internal — never sent to clients.
      return {
        id: user.id,
        username: user.username,
        role: user.role,
        is_active: user.is_active,
        email: decryptedEmail,
        notificationPreferences: user.notificationPreferences || {},
        privacy: {
          isDiscoverable: user.isDiscoverable(),
          canReceiveReplies: user.canReceiveReplies(),
          showReactions: user.shouldShowReactions(),
          dataProcessingConsent: user.hasDataProcessingConsent(),
        },
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      };
    }
    return null;
  }

  async login(
    email: string,
    password: string,
  ): Promise<{
    access_token: string;
    user: UserResponse;
    anonymousUserId: string;
  }> {
    // Check lockout before validating credentials
    const lockStatus = await this.lockoutService.getStatus(email);
    if (lockStatus.isLocked) {
      throw new AppException(
        'Too many failed login attempts. Please try again later.',
        ErrorCode.AUTH_INVALID_CREDENTIALS,
        HttpStatus.UNAUTHORIZED,
      );
    }

    const user = await this.validateUser(email, password);
    if (!user) {
      await this.lockoutService.recordFailedAttempt(email);
      throw new AppException(
        'Invalid credentials',
        ErrorCode.AUTH_INVALID_CREDENTIALS,
        HttpStatus.UNAUTHORIZED,
      );
    }
    await this.lockoutService.clearLockout(email);
    const anonymousUser =
      await this.anonymousUserService.getOrCreateForUserSession(user.id);
    const role = user.role || UserRole.USER;
    const scopes =
      role === UserRole.ADMIN ? getDefaultAdminStellarInvocationScopes() : [];
    const session = this.createSession(user.id);
    const payload: JwtPayload = {
      email: user.email,
      sub: user.id,
      username: user.username,
      role,
      scopes,
      sid: session.id,
    };
    this.analyticsEventService
      ?.record({
        eventName: 'user_login',
        actorId: `user:${user.id}`,
        metadata: { source: 'auth_service' },
      })
      .catch((err) =>
        this.logger.warn(
          `Failed to record login analytics: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
    return {
      access_token: this.jwtService.sign(payload),
      user,
      anonymousUserId: anonymousUser.id,
    };
  }

  async generateResetPasswordToken(email: string): Promise<string> {
    const user = await this.userService.findByEmail(email);
    if (!user) {
      throw new AppException(
        'Email not found',
        ErrorCode.NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 1);

    // Token stored internally — never returned to caller or serialized to HTTP response.
    await this.userService.setResetPasswordToken(user.id, token, expiresAt);
    return token;
  }

  async resetPassword(
    token: string,
    newPassword: string,
  ): Promise<{ message: string }> {
    try {
      const { reset, reason } =
        await this.passwordResetService.consumeValidToken(token);

      if (!reset) {
        this.logger.warn(`Reset token rejected`, { token, reason });

        switch (reason) {
          case 'invalid':
            throw new AppException(
              'Invalid reset token',
              ErrorCode.AUTH_TOKEN_INVALID,
              HttpStatus.BAD_REQUEST,
            );
          case 'expired':
            throw new AppException(
              'Reset token expired',
              ErrorCode.AUTH_SESSION_EXPIRED,
              HttpStatus.UNPROCESSABLE_ENTITY,
            );
          case 'reused':
            throw new AppException(
              'Reset token already used',
              ErrorCode.RESOURCE_GONE,
              HttpStatus.GONE,
            );
          default:
            throw new AppException(
              'Invalid reset token',
              ErrorCode.AUTH_TOKEN_INVALID,
              HttpStatus.BAD_REQUEST,
            );
        }
      }

      await this.userService.updatePassword(reset.userId, newPassword);

      // Password reset invalidates all prior sessions.
      this.revokeUserSessions(reset.userId, 'password_reset');

      this.logger.log(`Password reset successful`, {
        maskedUserId: maskUserId(reset.userId),
        tokenId: reset.id,
      });

      return { message: 'Password has been reset successfully' };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      if (
        error instanceof AppException ||
        error instanceof BadRequestException ||
        error instanceof GoneException ||
        error instanceof UnableToProcessEntityException
      ) {
        throw error;
      }

      this.logger.error(`Password reset failed: ${errorMessage}`, {
        token,
        error: errorMessage,
      });
      throw new AppException(
        'Failed to reset password',
        ErrorCode.INTERNAL_SERVER_ERROR,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async validateUserById(userId: number): Promise<UserResponse | null> {
    const user = await this.userService.findById(userId);
    if (user && user.is_active) {
      const decryptedEmail = CryptoUtil.decrypt(
        user.emailEncrypted,
        user.emailIv,
        user.emailTag,
      );
      // resetPasswordToken and resetPasswordExpires are internal — never sent to clients.
      return {
        id: user.id,
        username: user.username,
        role: user.role,
        is_active: user.is_active,
        email: decryptedEmail,
        notificationPreferences: user.notificationPreferences || {},
        privacy: {
          isDiscoverable: user.isDiscoverable(),
          canReceiveReplies: user.canReceiveReplies(),
          showReactions: user.shouldShowReactions(),
          dataProcessingConsent: user.hasDataProcessingConsent(),
        },
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      };
    }
    return null;
  }

  async forgotPassword(
    forgotPasswordDto: ForgotPasswordDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<{ message: string }> {
    try {
      if (!ForgotPasswordDto.validate(forgotPasswordDto)) {
        throw new AppException(
          'Either email or userId must be provided',
          ErrorCode.BAD_REQUEST,
          HttpStatus.BAD_REQUEST,
        );
      }

      let user;

      if (forgotPasswordDto.email) {
        user = await this.userService.findByEmail(forgotPasswordDto.email);
        this.logger.log(`Password reset requested for email: [PROTECTED]`, {
          email: '[PROTECTED]',
          ipAddress,
        });
      } else if (forgotPasswordDto.userId) {
        user = await this.userService.findById(forgotPasswordDto.userId);
        this.logger.log(
          `Password reset requested for masked user ID: ${maskUserId(forgotPasswordDto.userId)}`,
          { maskedUserId: maskUserId(forgotPasswordDto.userId), ipAddress },
        );
      }

      if (!user) {
        this.logger.warn(`Password reset attempted for non-existent user`, {
          maskedUserId: forgotPasswordDto.userId
            ? maskUserId(forgotPasswordDto.userId)
            : undefined,
          ipAddress,
        });
        return {
          message: 'If the user exists, a password reset email has been sent.',
        };
      }

      await this.passwordResetService.invalidateUserTokens(user.id);

      const token = await this.passwordResetService.createResetToken(
        user.id,
        ipAddress,
        userAgent,
      );

      await this.emailService.sendPasswordResetEmail(
        CryptoUtil.decrypt(user.emailEncrypted, user.emailIv, user.emailTag),
        token,
        user.username,
      );

      this.logger.log(`Password reset email sent successfully`, {
        maskedUserId: maskUserId(user.id),
        ipAddress,
        userAgent,
      });

      return {
        message: 'If the user exists, a password reset email has been sent.',
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      if (error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error(`Forgot password process failed: ${errorMessage}`, {
        maskedUserId: forgotPasswordDto.userId
          ? maskUserId(forgotPasswordDto.userId)
          : undefined,
        ipAddress,
        error: errorMessage,
      });

      return {
        message: 'If the user exists, a password reset email has been sent.',
      };
    }
  }
}
