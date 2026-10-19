import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { AccountService } from '../account/account.service';
import { UsersService } from '../users/users.service';
import { BCRYPT_ROUNDS } from './bcrypt';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';

// Compared against when the email doesn't exist, so that path costs the same
// bcrypt time as a real check. Must be a valid hash at the same cost.
const DUMMY_HASH =
  '$2b$12$1UkMk9cN7nuQtSm41y4E3uLRx3ee8yEC1LLBi63ZVnQYlzgi/xE8O';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly account: AccountService,
    private readonly ds: DataSource,
  ) {}

  async signup(dto: SignupDto) {
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    // The user and the "verify your email" event commit together.
    const user = await this.ds.transaction(async (em) => {
      const created = await this.users.create(
        { email: dto.email, passwordHash, name: dto.name },
        em,
      );
      await this.account.requestVerification(em, created);
      return created;
    });
    return this.users.toPublic(user);
  }

  async validateCredentials(dto: LoginDto) {
    const user = await this.users.findByEmail(dto.email);
    const ok = await bcrypt.compare(
      dto.password,
      user?.passwordHash ?? DUMMY_HASH,
    );

    // Same error for "no such email", "wrong password" and "deactivated",
    // so callers can't find out which emails are registered.
    if (!user || !ok || !user.isActive) {
      throw new UnauthorizedException('Invalid email or password');
    }
    return this.users.toPublic(user);
  }
}
