import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { EntityManager, IsNull, MoreThan } from 'typeorm';
import { AccountToken, AccountTokenPurpose } from '../entities';

export const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

export interface IssuedToken {
  raw: string; // goes into the email link only
  expiresAt: Date;
}

/**
 * One-time link tokens (forgot password, verify email). Every method takes
 * the caller's transaction, so the token, the user change and the outbox
 * event commit together.
 */
@Injectable()
export class AccountTokensService {
  /** A new link. Older unused links of the same kind stop working. */
  async issue(
    em: EntityManager,
    userId: string,
    purpose: AccountTokenPurpose,
    ttlMs: number,
  ): Promise<IssuedToken> {
    const repo = em.getRepository(AccountToken);
    const now = new Date();
    await repo.update({ userId, purpose, usedAt: IsNull() }, { usedAt: now });

    const raw = randomBytes(32).toString('base64url'); // 256 bits
    const expiresAt = new Date(now.getTime() + ttlMs);
    await repo.insert({
      userId,
      purpose,
      tokenHash: sha256(raw),
      expiresAt,
      usedAt: null,
    });
    return { raw, expiresAt };
  }

  /** How many links of this kind were sent since `since` (for limits). */
  countSince(
    em: EntityManager,
    userId: string,
    purpose: AccountTokenPurpose,
    since: Date,
  ) {
    return em
      .getRepository(AccountToken)
      .count({ where: { userId, purpose, createdAt: MoreThan(since) } });
  }

  /** The newest link of this kind, used or not. */
  latest(em: EntityManager, userId: string, purpose: AccountTokenPurpose) {
    return em.getRepository(AccountToken).findOne({
      where: { userId, purpose },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Spends a link and returns its user id. The row lock makes a double
   * click safe: the second request waits, then sees the link as used.
   */
  async consume(
    em: EntityManager,
    raw: string,
    purpose: AccountTokenPurpose,
  ): Promise<string> {
    const token = await em
      .getRepository(AccountToken)
      .createQueryBuilder('t')
      .setLock('pessimistic_write')
      .where('t.token_hash = :hash', { hash: sha256(raw) })
      .getOne();

    // Same answer for "unknown", "other kind" and "used": nothing to learn.
    if (!token || token.purpose !== purpose || token.usedAt) {
      throw new BadRequestException({
        code: 'INVALID_TOKEN',
        message: 'This link is not valid. It may have been used already.',
      });
    }
    if (token.expiresAt < new Date()) {
      throw new BadRequestException({
        code: 'TOKEN_EXPIRED',
        message: 'This link has expired. Please ask for a new one.',
      });
    }

    token.usedAt = new Date();
    await em.getRepository(AccountToken).save(token);
    return token.userId;
  }
}
