import { Controller, Get, NotFoundException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ApiError,
  CurrentUser,
  JwtAuthGuard,
  type JwtPayload,
} from '@app/common';
import { UsersService } from './users.service';

@ApiTags('Users')
@ApiBearerAuth()
@ApiError(401, 'UNAUTHORIZED (missing or expired token)')
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** Your profile */
  @Get('me')
  async me(@CurrentUser() jwt: JwtPayload) {
    const user = await this.users.findById(jwt.sub);
    if (!user) throw new NotFoundException('User not found');
    return { user: this.users.toPublic(user) };
  }
}
