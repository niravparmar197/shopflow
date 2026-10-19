import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { CookieOptions, Request, Response } from 'express';
import {
  ApiError,
  CurrentUser,
  Env,
  JwtAuthGuard,
  type JwtPayload,
} from '@app/common';
import { AccountService } from '../account/account.service';
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  VerifyEmailDto,
} from '../account/dto/account.dto';
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
    private readonly account: AccountService,
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

  /**
   * Emails a reset link (valid 30 min) if the account exists. Always 202,
   * so the answer doesn't tell who has an account.
   */
  @Post('forgot-password')
  @HttpCode(202)
  @ApiAcceptedResponse({ description: 'Email sent if the account exists' })
  @ApiError(429, 'RATE_LIMITED (5 per minute per IP)')
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.account.forgotPassword(dto.email);
    return {};
  }

  /** New password from a reset link. Logs out every device. */
  @Post('reset-password')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Password changed; log in again' })
  @ApiError(400, 'INVALID_TOKEN, TOKEN_EXPIRED, or a weak password')
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.account.resetPassword(dto.token, dto.password);
  }

  /** Confirms the email address from the signup link. */
  @Post('verify-email')
  @HttpCode(200)
  @ApiOkResponse({ description: '{ user } with emailVerifiedAt set' })
  @ApiError(400, 'INVALID_TOKEN or TOKEN_EXPIRED')
  async verifyEmail(@Body() dto: VerifyEmailDto) {
    return { user: await this.account.verifyEmail(dto.token) };
  }

  /**
   * Change the password (logged in). Lives under /auth so the refresh
   * cookie comes along: this login stays, other devices are logged out.
   */
  @Post('change-password')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiNoContentResponse({ description: 'Password changed' })
  @ApiError(400, 'WRONG_PASSWORD, SAME_PASSWORD, or a weak password')
  @ApiError(401, 'UNAUTHORIZED (missing or expired token)')
  async changePassword(
    @CurrentUser() jwt: JwtPayload,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ) {
    const raw = this.readRefreshCookie(req);
    const family = raw ? await this.tokens.familyOf(raw) : undefined;
    await this.account.changePassword(
      jwt.sub,
      dto.currentPassword,
      dto.newPassword,
      family,
    );
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
