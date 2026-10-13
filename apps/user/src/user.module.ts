import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommonModule, Env } from '@app/common';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { USER_ENTITIES } from './entities';
import { UsersService } from './users/users.service';

@Module({
  imports: [
    CommonModule.forRoot({ serviceName: 'user' }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        type: 'postgres',
        url: config.getOrThrow('DATABASE_URL', { infer: true }),
        entities: USER_ENTITIES,
        // Schema changes go through migrations only.
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature(USER_ENTITIES),
  ],
  controllers: [AuthController],
  providers: [AuthService, UsersService],
})
export class UserModule {}
