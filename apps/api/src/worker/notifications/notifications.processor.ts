import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { type Job, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { AppConfig } from '../../config/app-config.js';
import {
  NotificationsService,
  type OutboxJob,
  type ReminderJob,
} from '../../modules/notifications/notifications.service.js';
import { LOGGER } from '../../platform/logging/logger.js';
import { DispatchService, type Enqueuer } from './dispatch.service.js';

export const NOTIFICATIONS_QUEUE = 'notifications';
export const JOB_PUBLISH_OUTBOX = 'publish-outbox';
export const JOB_SCAN_REMINDERS = 'scan-reminders';
export const JOB_OUTBOX_EVENT = 'outbox-event';
export const JOB_REMINDER = 'reminder';

/** Envíos: 6 intentos con espera exponencial desde 30 s (~30 min en total) antes de quedar "fallida". */
const SEND_OPTS = {
  attempts: 6,
  backoff: { type: 'exponential', delay: 30_000 },
  // Se conservan un día: mientras exista el job, encolar el mismo id no lo duplica.
  removeOnComplete: { age: 86_400 },
  removeOnFail: { age: 7 * 86_400 },
};

/**
 * Cola de comunicaciones (solo en el proceso worker, ADR-002). Dos tareas programadas:
 *  - publicar el outbox cada 5 s (latencia de un email de confirmación: segundos);
 *  - buscar recordatorios cada minuto.
 * Y los trabajos de envío, uno por evento o recordatorio.
 */
@Injectable()
export class NotificationsProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private connection: Redis | undefined;
  private queue: Queue | undefined;
  private worker: Worker | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly dispatch: DispatchService,
    private readonly notifications: NotificationsService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  private get prefix(): string {
    return this.config.env.QUEUE_PREFIX ?? `rp:${this.config.env.NODE_ENV}`;
  }

  /** Encola en BullMQ con ids estables (idempotente). */
  readonly enqueuer: Enqueuer = {
    outbox: async (jobId, job) => {
      await this.queue!.add(JOB_OUTBOX_EVENT, job, { ...SEND_OPTS, jobId });
    },
    reminder: async (jobId, job) => {
      await this.queue!.add(JOB_REMINDER, job, { ...SEND_OPTS, jobId });
    },
  };

  async onApplicationBootstrap(): Promise<void> {
    const url = this.config.env.REDIS_URL;
    if (!url) throw new Error('El worker requiere REDIS_URL');
    this.connection = new Redis(url, { maxRetriesPerRequest: null });
    const base = { connection: this.connection, prefix: this.prefix };
    this.queue = new Queue(NOTIFICATIONS_QUEUE, base);
    this.worker = new Worker(NOTIFICATIONS_QUEUE, (job) => this.process(job), {
      ...base,
      concurrency: this.config.env.WORKER_CONCURRENCY,
    });
    this.worker.on('failed', (job, err) =>
      this.logger.error({ jobId: job?.id, name: job?.name, err: err.message }, 'job fallido'),
    );
    this.worker.on('error', (err) => this.logger.error({ err: err.message }, 'error del worker'));

    const tick = { attempts: 1, removeOnComplete: 20, removeOnFail: 50 };
    await this.queue.upsertJobScheduler(
      'publish-outbox-every-5s',
      { every: 5_000 },
      { name: JOB_PUBLISH_OUTBOX, opts: tick },
    );
    await this.queue.upsertJobScheduler(
      'scan-reminders-every-minute',
      { pattern: '* * * * *', tz: 'UTC' },
      { name: JOB_SCAN_REMINDERS, opts: tick },
    );
    this.logger.info(
      { queue: NOTIFICATIONS_QUEUE, prefix: this.prefix },
      'worker de notificaciones listo',
    );
  }

  schedulers() {
    return this.queue!.getJobSchedulers();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case JOB_PUBLISH_OUTBOX:
        return this.dispatch.publishOutbox(this.enqueuer);
      case JOB_SCAN_REMINDERS:
        return this.dispatch.scanReminders(this.enqueuer);
      case JOB_OUTBOX_EVENT:
        return this.notifications.handleOutboxEvent(job.data as OutboxJob);
      case JOB_REMINDER:
        return this.notifications.handleReminder(job.data as ReminderJob);
      default:
        throw new Error(`job desconocido: ${job.name}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    await this.connection?.quit().catch(() => undefined);
  }
}
