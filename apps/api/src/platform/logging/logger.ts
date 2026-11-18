import { Global, Module } from '@nestjs/common';
import { type Logger, pino } from 'pino';
import { AppConfig } from '../../config/app-config.js';

export const LOGGER = Symbol('LOGGER');

/** Campos que jamás deben aparecer en logs (contraseñas, tokens, cookies, cabeceras de auth). */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'password_hash',
  '*.password_hash',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'token',
  '*.token',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
];

export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: { service: 'reservepro-api' },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { singleLine: true } } } : {}),
  });
}

@Global()
@Module({
  providers: [
    {
      provide: LOGGER,
      inject: [AppConfig],
      useFactory: (config: AppConfig) =>
        createLogger(config.env.LOG_LEVEL, config.env.NODE_ENV === 'development'),
    },
  ],
  exports: [LOGGER],
})
export class LoggingModule {}
