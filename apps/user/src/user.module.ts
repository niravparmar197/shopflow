import { readFileSync } from 'node:fs';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtSignOptions } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AddressesController } from './addresses/addresses.controller';
import { AddressesService } from './addresses/addresses.service';
import {
  CommonModule,
  Env,
  JWT_AUDIENCE,
  JWT_ISSUER,
  postgresSsl,
} from '@app/common';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { TokenService } from './auth/token.service';
import { USER_ENTITIES } from './entities';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';

@Module({
  imports: [
    CommonModule.forRoot({ serviceName: 'user' }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        type: 'postgres',
        url: config.getOrThrow('DATABASE_URL', { infer: true }),
        ssl: postgresSsl(), // TLS to RDS on Stage 2 (off locally)
        entities: USER_ENTITIES,
        // Schema changes go through migrations only.
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature(USER_ENTITIES),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        privateKey: readFileSync(
          config.getOrThrow('JWT_PRIVATE_KEY_PATH', { infer: true }),
        ),
        publicKey: readFileSync(
          config.getOrThrow('JWT_PUBLIC_KEY_PATH', { infer: true }),
        ),
        signOptions: {
          algorithm: 'RS256',
          expiresIn: config.get('ACCESS_TOKEN_TTL', {
            infer: true,
          }) as JwtSignOptions['expiresIn'],
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
        },
      }),
    }),
  ],
  controllers: [AuthController, UsersController, AddressesController],
  providers: [AuthService, UsersService, TokenService, AddressesService],
})
export class UserModule {}
