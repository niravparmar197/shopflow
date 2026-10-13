import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { Env, JwtPayload } from '@app/common';
import { RefreshToken } from '../entities';
import { PublicUser } from '../users/users.service';

const DAY_MS = 24 * 60 * 60 * 1000;

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

export interface AccessToken {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number; // seconds
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
    private readonly dataSource: DataSource,
    @InjectRepository(RefreshToken)
    private readonly repo: Repository<RefreshToken>,
  ) {}

  get refreshTokenTtlMs() {
    return this.config.get('REFRESH_TOKEN_DAYS', { infer: true }) * DAY_MS;
  }

  async signAccessToken(
    user: Pick<PublicUser, 'id' | 'email' | 'role'>,
  ): Promise<AccessToken> {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };
    const accessToken = await this.jwt.signAsync(payload);
    // Read the lifetime back from the token so it always matches ACCESS_TOKEN_TTL.
    const { iat, exp } = this.jwt.decode<{ iat: number; exp: number }>(
      accessToken,
    );
    return { accessToken, tokenType: 'Bearer', expiresIn: exp - iat };
  }

  /** Starts a new family on login; rotation passes the existing family. */
  async issueRefreshToken(
    userId: string,
    familyId: string = randomUUID(),
    em?: EntityManager,
  ) {
    const raw = randomBytes(48).toString('base64url'); // sent to the client only
    const repo = em ? em.getRepository(RefreshToken) : this.repo;
    await repo.save(
      repo.create({
        userId,
        familyId,
        tokenHash: sha256(raw), // only the hash is stored
        expiresAt: new Date(Date.now() + this.refreshTokenTtlMs),
        revokedAt: null,
      }),
    );
    return raw;
  }

  /** Spends a refresh token and issues the next one in its family. */
  async rotate(
    rawToken: string,
  ): Promise<{ userId: string; refreshToken: string }> {
    const result = await this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(RefreshToken);

      // Row lock: a second refresh with the same token waits for the first,
      // then sees it as already spent.
      const token = await repo
        .createQueryBuilder('t')
        .setLock('pessimistic_write')
        .where('t.token_hash = :hash', { hash: sha256(rawToken) })
        .getOne();

      if (!token) return { error: 'Invalid refresh token' } as const;

      if (token.revokedAt) {
        // A spent token came back: it may have been stolen, so end the family.
        await this.revokeFamilyWith(repo, token.familyId);
        return { error: 'Refresh token reuse detected' } as const;
      }

      if (token.expiresAt < new Date()) {
        return { error: 'Refresh token expired' } as const;
      }

      token.revokedAt = new Date();
      await repo.save(token);
      const refreshToken = await this.issueRefreshToken(
        token.userId,
        token.familyId,
        em,
      );
      return { userId: token.userId, refreshToken };
    });

    // Throw only after the transaction commits. Throwing inside it would
    // roll back the family revoke and leave a stolen family alive.
    if ('error' in result) throw new UnauthorizedException(result.error);
    return result;
  }

  async revokeFamily(rawToken: string) {
    const token = await this.repo.findOne({
      where: { tokenHash: sha256(rawToken) },
    });
    if (token) await this.revokeFamilyWith(this.repo, token.familyId);
  }

  private revokeFamilyWith(repo: Repository<RefreshToken>, familyId: string) {
    return repo.update(
      { familyId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
  }
}
