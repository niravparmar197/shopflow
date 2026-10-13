import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { UserController } from './user.controller';
import { UserService } from './user.service';

@Module({
  imports: [CommonModule.forRoot({ serviceName: 'user' })],
  controllers: [UserController],
  providers: [UserService],
})
export class UserModule {}
