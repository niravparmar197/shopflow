import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { Env, validateEnv } from './config/env.schema';
import { HealthModule } from './health/health.module';

export interface CommonModuleOptions {
  /** Folder name under apps/, used to locate the service's .env file. */
  serviceName: string;
}

@Module({})
export class CommonModule {
  static forRoot({ serviceName }: CommonModuleOptions): DynamicModule {
    return {
      module: CommonModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          cache: true,
          envFilePath: [`apps/${serviceName}/.env`, '.env'],
          validate: validateEnv,
        }),
        LoggerModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (config: ConfigService<Env, true>) => {
            const isDev =
              config.get('NODE_ENV', { infer: true }) === 'development';
            return {
              pinoHttp: {
                name: config.get('SERVICE_NAME', { infer: true }),
                level: config.get('LOG_LEVEL', { infer: true }),
                autoLogging: {
                  ignore: (req) => req.url?.startsWith('/health') ?? false,
                },
                transport: isDev
                  ? { target: 'pino-pretty', options: { singleLine: true } }
                  : undefined,
              },
            };
          },
        }),
        HealthModule,
      ],
      exports: [ConfigModule, LoggerModule],
    };
  }
}
