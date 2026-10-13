import { randomUUID } from 'node:crypto';
import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { Env, validateEnv } from './config/env.schema';
import { HealthModule } from './health/health.module';

// Caller-supplied ids end up in logs, so only accept short, plain values.
const CORRELATION_ID = /^[\w.-]{1,128}$/;

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
                // Reuse the caller's correlation id, or start a new one. It is
                // written back onto the request so proxies forward it, and
                // echoed to the client so they can quote it in bug reports.
                genReqId: (req, res) => {
                  const header = req.headers['x-correlation-id'];
                  const id =
                    typeof header === 'string' && CORRELATION_ID.test(header)
                      ? header
                      : randomUUID();
                  req.headers['x-correlation-id'] = id;
                  res.setHeader('x-correlation-id', id);
                  return id;
                },
                // Logs inside a request carry just `correlationId`; the full
                // request is only on the "request completed" line.
                quietReqLogger: true,
                customAttributeKeys: { reqId: 'correlationId' },
                redact: [
                  'req.headers.authorization',
                  'req.headers.cookie',
                  'res.headers["set-cookie"]',
                ],
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
