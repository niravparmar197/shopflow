import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Request, Response } from 'express';
import { Env } from '@app/common';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import { TokenService } from './token.service';

const REFRESH_COOKIE = 'rt';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly users: UsersService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Post('signup')
  async signup(@Body() dto: SignupDto) {
    const user = await this.auth.signup(dto);
    return { user };
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.auth.validateCredentials(dto);
    const refreshToken = await this.tokens.issueRefreshToken(user.id);
    this.setRefreshCookie(res, refreshToken);
    return { user, ...(await this.tokens.signAccessToken(user)) };
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const raw = this.readRefreshCookie(req);
    if (!raw) throw new UnauthorizedException('Missing refresh token');

    const { userId, refreshToken } = await this.tokens.rotate(raw);
    const user = await this.users.findById(userId);
    if (!user?.isActive) {
      await this.tokens.revokeFamily(refreshToken);
      throw new UnauthorizedException('Invalid refresh token');
    }

    this.setRefreshCookie(res, refreshToken);
    return this.tokens.signAccessToken(user);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = this.readRefreshCookie(req);
    if (raw) await this.tokens.revokeFamily(raw);
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }

  private readRefreshCookie(req: Request): string | undefined {
    const value: unknown = (
      req.cookies as Record<string, unknown> | undefined
    )?.[REFRESH_COOKIE];
    return typeof value === 'string' && value ? value : undefined;
  }

  private setRefreshCookie(res: Response, token: string) {
    res.cookie(REFRESH_COOKIE, token, {
      ...this.cookieOptions(),
      maxAge: this.tokens.refreshTokenTtlMs,
    });
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true, // page scripts can't read it (XSS)
      secure: this.config.get('NODE_ENV', { infer: true }) === 'production',
      sameSite: 'strict', // not sent on cross-site requests (CSRF)
      path: '/v1/auth', // only sent to the auth routes
    };
  }
}
