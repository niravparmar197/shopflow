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
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { CookieOptions, Request, Response } from 'express';
import { ApiError, Env } from '@app/common';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import { TokenService } from './token.service';

const REFRESH_COOKIE = 'rt';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly users: UsersService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Create an account (role: customer) */
  @Post('signup')
  @ApiCreatedResponse({ description: '{ user } (no token: log in next)' })
  @ApiError(
    400,
    'BAD_REQUEST (validation: email, password 8-72 with a letter and a digit, name)',
  )
  @ApiError(409, 'CONFLICT (email is already registered)')
  async signup(@Body() dto: SignupDto) {
    const user = await this.auth.signup(dto);
    return { user };
  }

  /**
   * Log in. Returns an access token for the Authorize button, and sets the
   * refresh token as an httpOnly cookie (path /v1/auth).
   */
  @Post('login')
  @HttpCode(200)
  @ApiOkResponse({ description: '{ user, accessToken, ... }' })
  @ApiError(401, 'UNAUTHORIZED (invalid email or password)')
  @ApiError(429, 'RATE_LIMITED (5 login attempts per minute per IP)')
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.auth.validateCredentials(dto);
    const refreshToken = await this.tokens.issueRefreshToken(user.id);
    this.setRefreshCookie(res, refreshToken);
    return { user, ...(await this.tokens.signAccessToken(user)) };
  }

  /**
   * A new access token from the refresh cookie. The refresh token rotates;
   * reusing an old one revokes the whole family (stolen-token detection).
   */
  @Post('refresh')
  @HttpCode(200)
  @ApiCookieAuth('rt')
  @ApiError(401, 'UNAUTHORIZED (missing, expired, or reused refresh token)')
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

  /** Revoke the refresh token family and clear the cookie */
  @Post('logout')
  @HttpCode(204)
  @ApiCookieAuth('rt')
  @ApiNoContentResponse({ description: 'Logged out' })
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
