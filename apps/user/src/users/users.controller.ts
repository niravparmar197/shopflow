import { Controller, Get, NotFoundException, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, type JwtPayload } from '@app/common';
import { UsersService } from './users.service';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  async me(@CurrentUser() jwt: JwtPayload) {
    const user = await this.users.findById(jwt.sub);
    if (!user) throw new NotFoundException('User not found');
    return { user: this.users.toPublic(user) };
  }
}
