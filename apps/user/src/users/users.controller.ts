import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ApiError,
  CurrentUser,
  JwtAuthGuard,
  type JwtPayload,
} from '@app/common';
import { AccountService } from '../account/account.service';
import { UpdateProfileDto } from '../account/dto/account.dto';
import { UsersService } from './users.service';

@ApiTags('Users')
@ApiBearerAuth()
@ApiError(401, 'UNAUTHORIZED (missing or expired token)')
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly account: AccountService,
  ) {}

  /** Your profile */
  @Get('me')
  async me(@CurrentUser() jwt: JwtPayload) {
    const user = await this.users.findById(jwt.sub);
    if (!user) throw new NotFoundException('User not found');
    return { user: this.users.toPublic(user) };
  }

  /** Edit your name and phone (email changes are not supported) */
  @Patch('me')
  @ApiError(400, 'BAD_REQUEST (name 2-80, phone 10 digits)')
  async updateMe(
    @CurrentUser() jwt: JwtPayload,
    @Body() dto: UpdateProfileDto,
  ) {
    return { user: await this.account.updateProfile(jwt.sub, dto) };
  }

  /** Send the verify email again (once a minute) */
  @Post('me/verify-email')
  @HttpCode(202)
  @ApiAcceptedResponse({ description: 'Email sent' })
  @ApiError(409, 'ALREADY_VERIFIED')
  @ApiError(429, 'RESEND_TOO_SOON (one per minute)')
  async resendVerification(@CurrentUser() jwt: JwtPayload) {
    await this.account.resendVerification(jwt.sub);
    return {};
  }
}
