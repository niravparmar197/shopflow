import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';
import { User } from '../entities';

export type PublicUser = Omit<User, 'passwordHash' | 'refreshTokens'>;

const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly repo: Repository<User>,
  ) {}

  findByEmail(email: string) {
    return this.repo.findOne({ where: { email } });
  }

  findById(id: string) {
    return this.repo.findOne({ where: { id } });
  }

  /** Pass `em` to create the user inside the caller's transaction. */
  async create(
    data: { email: string; passwordHash: string; name: string },
    em?: EntityManager,
  ) {
    const repo = em ? em.getRepository(User) : this.repo;
    try {
      return await repo.save(
        repo.create({
          email: data.email,
          passwordHash: data.passwordHash,
          fullName: data.name,
        }),
      );
    } catch (err) {
      // No "does this email exist?" check first: two signups at the same
      // moment could both pass it. The unique index is the real guard.
      if (
        err instanceof QueryFailedError &&
        (err.driverError as { code?: string }).code === PG_UNIQUE_VIOLATION
      ) {
        throw new ConflictException('Email is already registered');
      }
      throw err;
    }
  }

  toPublic(user: User): PublicUser {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash, refreshTokens, ...rest } = user;
    return rest;
  }
}
