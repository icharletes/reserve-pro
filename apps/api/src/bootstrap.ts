import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { AppConfig } from './config/app-config.js';
import { LOGGER } from './platform/logging/logger.js';
import type { AuthedRequest } from './platform/auth/principal.js';

export const API_PREFIX = 'api/v1';
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Configuración HTTP compartida por `main.ts` y por las pruebas e2e (mismo comportamiento en ambos).
 * Debe llamarse ANTES de `app.init()` / `app.listen()`.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(AppConfig);
  const logger = app.get<Logger>(LOGGER);

  // Sin esto, detrás de un proxy/balanceador TODOS los clientes compartirían la IP del proxy (y el rate limit).
  app.getHttpAdapter().getInstance().set('trust proxy', config.env.TRUST_PROXY);
  app.setGlobalPrefix(API_PREFIX, { exclude: ['health', 'health/ready'] });
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: config.env.CORS_ORIGINS,
    credentials: true,
    allowedHeaders: ['content-type', 'authorization', 'x-request-id', 'x-rp-csrf', 'idempotency-key'],
    exposedHeaders: ['x-request-id'],
    maxAge: 600,
  });

  // Id de request (se acepta el del cliente solo si tiene forma segura) + log de acceso al terminar.
  app.use((req: Request & { id?: string }, res: Response, next: NextFunction) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', req.id);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const p = (req as AuthedRequest).principal;
      logger.info(
        {
          requestId: req.id,
          method: req.method,
          path: req.originalUrl.split('?')[0], // nunca se loguea la query string (puede llevar tokens)
          status: res.statusCode,
          ms: Number(process.hrtime.bigint() - started) / 1e6,
          userId: p?.userId,
          tenantId: p?.tenantId ?? undefined,
        },
        'request',
      );
    });
    next();
  });

  app.enableShutdownHooks();
}
