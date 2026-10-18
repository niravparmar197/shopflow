import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { DataSource, EntityManager } from 'typeorm';
import {
  type EmailVerificationRequestedV1,
  type PasswordChangedV1,
  type PasswordResetRequestedV1,
  UserEvents,
} from '@app/events';
import { OutboxService } from '@app/kafka';
import { BCRYPT_ROUNDS } from '../auth/bcrypt';
import { TokenService } from '../auth/token.service';
import { AccountTokenPurpose, User } from '../entities';
import { type PublicUser, UsersService } from '../users/users.service';
import { AccountTokensService } from './account-tokens.service';
import type { UpdateProfileDto } from './dto/account.dto';

const MINUTE_MS = 60_000;
export const RESET_TTL_MS = 30 * MINUTE_MS;
export const VERIFY_TTL_MS = 24 * 60 * MINUTE_MS;
/** Reset emails per account per hour (more requests are ignored quietly). */
const RESETS_PER_HOUR = 3;
/** Gap between two "send the verify email again" clicks. */
const RESEND_GAP_MS = MINUTE_MS;

/**
 * Account self-service (Phase 2 P3): forgot / reset password, verify email,
 * change password, edit profile. Emails go out as events through the
 * outbox: the change and its event commit together, and the notification
 * service sends the email.
 */
@Injectable()
export class AccountService {
  constructor(
    private readonly ds: DataSource,
    private readonly users: UsersService,
    private readonly tokens: AccountTokensService,
    private readonly refreshTokens: TokenService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Always "ok" for the caller, whether the email exists or not, so the
   * form can't be used to find out who has an account.
   */
  async forgotPassword(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (!user?.isActive) return;

    await this.ds.transaction(async (em) => {
      await this.lockAccount(em, user.id);
      const recent = await this.tokens.countSince(
        em,
        user.id,
        AccountTokenPurpose.PASSWORD_RESET,
        new Date(Date.now() - 60 * MINUTE_MS),
      );
      // Stops someone from flooding a person's inbox with reset emails.
      if (recent >= RESETS_PER_HOUR) return;

      const { raw, expiresAt } = await this.tokens.issue(
        em,
        user.id,
        AccountTokenPurpose.PASSWORD_RESET,
        RESET_TTL_MS,
      );
      await this.addEvent<PasswordResetRequestedV1>(
        em,
        UserEvents.PASSWORD_RESET_REQUESTED,
        { ...recipient(user), token: raw, expiresAt: expiresAt.toISOString() },
      );
    });
  }

  /** Sets a new password from a reset link and logs out every device. */
  async resetPassword(rawToken: string, password: string): Promise<void> {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await this.ds.transaction(async (em) => {
      const userId = await this.tokens.consume(
        em,
        rawToken,
        AccountTokenPurpose.PASSWORD_RESET,
      );
      const user = await em.getRepository(User).findOneByOrFail({
        id: userId,
      });
      user.passwordHash = passwordHash;
      // The link came by email, so the user owns this inbox.
      user.emailVerifiedAt ??= new Date();
      await em.getRepository(User).save(user);
      await this.refreshTokens.revokeAllForUser(em, userId);
      await this.addEvent<PasswordChangedV1>(em, UserEvents.PASSWORD_CHANGED, {
        ...recipient(user),
        via: 'RESET',
      });
    });
  }

  /** Marks the email as verified. Opening the link twice is fine. */
  async verifyEmail(rawToken: string): Promise<PublicUser> {
    return this.ds.transaction(async (em) => {
      const userId = await this.tokens.consume(
        em,
        rawToken,
        AccountTokenPurpose.EMAIL_VERIFY,
      );
      const repo = em.getRepository(User);
      const user = await repo.findOneByOrFail({ id: userId });
      if (!user.emailVerifiedAt) {
        user.emailVerifiedAt = new Date();
        await repo.save(user);
      }
      return this.users.toPublic(user);
    });
  }

  /** Sends the verify email (signup, or "send it again"). */
  async requestVerification(em: EntityManager, user: User): Promise<void> {
    const { raw, expiresAt } = await this.tokens.issue(
      em,
      user.id,
      AccountTokenPurpose.EMAIL_VERIFY,
      VERIFY_TTL_MS,
    );
    await this.addEvent<EmailVerificationRequestedV1>(
      em,
      UserEvents.EMAIL_VERIFICATION_REQUESTED,
      { ...recipient(user), token: raw, expiresAt: expiresAt.toISOString() },
    );
  }

  async resendVerification(userId: string): Promise<void> {
    await this.ds.transaction(async (em) => {
      await this.lockAccount(em, userId);
      const user = await em.getRepository(User).findOneBy({ id: userId });
      if (!user) throw new NotFoundException('User not found');
      if (user.emailVerifiedAt) {
        throw new ConflictException({
          code: 'ALREADY_VERIFIED',
          message: 'Your email is already verified',
        });
      }
      const last = await this.tokens.latest(
        em,
        userId,
        AccountTokenPurpose.EMAIL_VERIFY,
      );
      if (last && Date.now() - last.createdAt.getTime() < RESEND_GAP_MS) {
        throw new HttpException(
          {
            code: 'RESEND_TOO_SOON',
            message: 'We just sent it. Please wait a minute and try again.',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      await this.requestVerification(em, user);
    });
  }

  /**
   * Changes the password from the account page. Other devices are logged
   * out; this one (its refresh token family) stays logged in.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    keepFamilyId?: string,
  ): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user?.isActive) throw new NotFoundException('User not found');

    // 400, not 401: a 401 would make the web app think the session ended.
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw new BadRequestException({
        code: 'WRONG_PASSWORD',
        message: 'Your current password is not correct',
      });
    }
    if (currentPassword === newPassword) {
      throw new BadRequestException({
        code: 'SAME_PASSWORD',
        message: 'Please choose a password you are not using now',
      });
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.ds.transaction(async (em) => {
      await em.getRepository(User).update({ id: userId }, { passwordHash });
      await this.refreshTokens.revokeAllForUser(em, userId, keepFamilyId);
      await this.addEvent<PasswordChangedV1>(em, UserEvents.PASSWORD_CHANGED, {
        ...recipient(user),
        via: 'CHANGE',
      });
    });
  }

  async updateProfile(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<PublicUser> {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundException('User not found');
    if (dto.fullName !== undefined) user.fullName = dto.fullName;
    if (dto.phone !== undefined) user.phone = dto.phone;
    await this.ds.getRepository(User).save(user);
    return this.users.toPublic(user);
  }

  /** One account's token work at a time (limits stay exact under races). */
  private lockAccount(em: EntityManager, userId: string) {
    return em.query(
      `SELECT pg_advisory_xact_lock(hashtext('account:' || $1::text))`,
      [userId],
    );
  }

  private addEvent<T extends { userId: string }>(
    em: EntityManager,
    eventType: string,
    data: T,
  ) {
    return this.outbox.add(em, {
      aggregateType: 'user',
      aggregateId: data.userId, // the Kafka key
      eventType,
      data,
    });
  }
}

const recipient = (user: User) => ({
  userId: user.id,
  email: user.email,
  fullName: user.fullName,
});
