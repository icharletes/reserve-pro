import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { AppConfig } from '../../config/app-config.js';
import { LOGGER } from '../logging/logger.js';

/**
 * Conexión compartida a Redis para el camino de las requests (rate limiting, caché).
 * Falla RÁPIDO: sin cola offline y con timeout corto, para que una caída de Redis nunca congele la API.
 * `client` es null cuando no hay REDIS_URL (desarrollo sin Redis).
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  readonly client: Redis | null;

  constructor(
    config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    const url = config.env.REDIS_URL;
    if (!url) {
      this.client = null;
      logger.warn(
        'REDIS_URL no definida: el rate limiting usará memoria local (solo válido con una instancia)',
      );
      return;
    }
    this.client = new Redis(url, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: 500,
      retryStrategy: (times) => Math.min(times * 200, 2_000),
    });
    this.client.on('error', (err) => this.logger.warn({ err: err.message }, 'error de Redis'));
  }

  /** Espera a que la conexión esté lista (máx. 3 s) para que las primeras peticiones ya cuenten. */
  async onModuleInit(): Promise<void> {
    const c = this.client;
    if (!c || c.status === 'ready') return;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      c.once('ready', done);
      setTimeout(done, 3_000).unref();
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }

  async ping(): Promise<boolean> {
    if (!this.client) return true; // sin Redis configurado no es una dependencia
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
}

@Global()
@Module({ providers: [RedisService], exports: [RedisService] })
export class RedisModule {}
