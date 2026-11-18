import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { type Job, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { AppConfig } from '../../config/app-config.js';
import { LOGGER } from '../../platform/logging/logger.js';
import { MaintenanceService } from './maintenance.service.js';

export const MAINTENANCE_QUEUE = 'maintenance';
export const JOB_PURGE_TOKENS = 'purge-expired-tokens';
const SCHEDULER_PURGE_TOKENS = 'purge-expired-tokens-daily';

/**
 * Cola de mantenimiento. Solo corre en el proceso worker (worker.ts), NUNCA en la API:
 * la API puede escalar a N réplicas sin duplicar trabajo programado.
 */
@Injectable()
export class MaintenanceProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private connection: Redis | undefined;
  private queue: Queue | undefined;
  private worker: Worker | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly maintenance: MaintenanceService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  get prefix(): string {
    return this.config.env.QUEUE_PREFIX ?? `rp:${this.config.env.NODE_ENV}`;
  }

  async onApplicationBootstrap(): Promise<void> {
    const url = this.config.env.REDIS_URL;
    if (!url) throw new Error('El worker requiere REDIS_URL');

    // BullMQ exige maxRetriesPerRequest=null en las conexiones de los workers (bloquea esperando trabajo).
    this.connection = new Redis(url, { maxRetriesPerRequest: null });
    const base = { connection: this.connection, prefix: this.prefix };

    this.queue = new Queue(MAINTENANCE_QUEUE, base);
    this.worker = new Worker(MAINTENANCE_QUEUE, (job) => this.process(job), {
      ...base,
      concurrency: this.config.env.WORKER_CONCURRENCY,
    });
    this.worker.on('failed', (job, err) => this.logger.error({ jobId: job?.id, name: job?.name, err: err.message }, 'job fallido'));
    this.worker.on('error', (err) => this.logger.error({ err: err.message }, 'error del worker'));

    // upsert => idempotente: con varias réplicas del worker el programador sigue siendo UNO.
    await this.queue.upsertJobScheduler(
      SCHEDULER_PURGE_TOKENS,
      { pattern: '0 3 * * *', tz: 'UTC' },
      {
        name: JOB_PURGE_TOKENS,
        opts: { attempts: 3, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: 50, removeOnFail: 200 },
      },
    );
    this.logger.info({ queue: MAINTENANCE_QUEUE, prefix: this.prefix }, 'worker de mantenimiento listo');
  }

  /** Despachador por nombre de job. Un nombre desconocido falla (no se ignora en silencio). */
  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case JOB_PURGE_TOKENS:
        return this.maintenance.purgeExpiredTokens();
      default:
        throw new Error(`job desconocido: ${job.name}`);
    }
  }

  /** Para tests y operación manual: encola una ejecución inmediata. */
  enqueue(name: string): Promise<Job> {
    if (!this.queue) throw new Error('worker no iniciado');
    return this.queue.add(name, {}, { removeOnComplete: 50, removeOnFail: 200 });
  }

  schedulers() {
    return this.queue!.getJobSchedulers();
  }

  async onModuleDestroy(): Promise<void> {
    // Cierre ordenado: el worker termina el job en curso antes de soltar la conexión.
    await this.worker?.close();
    await this.queue?.close();
    await this.connection?.quit().catch(() => undefined);
  }
}
