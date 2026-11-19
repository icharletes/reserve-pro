import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppConfig } from '../src/config/app-config.js';
import {
  NotificationsService,
  type OutboxJob,
  type ReminderJob,
} from '../src/modules/notifications/notifications.service.js';
import { TenantDb } from '../src/platform/database/database.module.js';
import type { EmailMessage, EmailProvider } from '../src/platform/email/email.module.js';
import { LOGGER } from '../src/platform/logging/logger.js';
import { SystemDb } from '../src/worker/maintenance/system-db.js';
import { DispatchService } from '../src/worker/notifications/dispatch.service.js';
import { client, hours, mkLocation, mkResource, mkService } from './catalog-helpers.js';
import { createTestApp, http, ownerPool, register } from './helpers.js';

/** Buzón propio de esta suite (el envío lo hace el worker, no la API). */
class Outbox implements EmailProvider {
  sent: EmailMessage[] = [];
  failures = 0;
  async send(m: EmailMessage): Promise<void> {
    if (this.failures > 0) {
      this.failures--;
      throw new Error('550 rechazado para carla@example.test (simulado)');
    }
    this.sent.push(m);
  }
  to(addr: string) {
    return this.sent.filter((m) => m.to === addr);
  }
}

let app: INestApplication;
let owner: pg.Pool;
let system: SystemDb;
let dispatch: DispatchService;
let notifications: NotificationsService;
const mail = new Outbox();
/** Lo que el publisher encoló (en vez de BullMQ). */
let queued: { jobId: string; kind: 'outbox' | 'reminder'; job: OutboxJob | ReminderJob }[] = [];
const enqueuer = {
  outbox: async (jobId: string, job: OutboxJob) => {
    queued.push({ jobId, kind: 'outbox', job });
  },
  reminder: async (jobId: string, job: ReminderJob) => {
    queued.push({ jobId, kind: 'reminder', job });
  },
};

beforeAll(async () => {
  app = await createTestApp();
  owner = ownerPool();
  // Las piezas del worker, armadas con las de esta app (ver public.e2e: un solo ClsModule por proceso).
  system = new SystemDb(app.get(AppConfig));
  dispatch = new DispatchService(system, app.get(LOGGER));
  notifications = new NotificationsService(
    app.get(TenantDb),
    app.get(AppConfig),
    mail,
    app.get(LOGGER),
  );
});
afterAll(async () => {
  await system.onModuleDestroy();
  await app.close();
  await owner.end();
});
beforeEach(() => {
  queued = [];
});

/** Publica el outbox y procesa SOLO los eventos de `tenantId` (otras suites corren en paralelo). */
async function pump(tenantId: string) {
  const from = queued.length; // solo lo publicado en ESTA llamada
  await dispatch.publishOutbox(enqueuer);
  const mine = queued.slice(from).filter((q) => q.kind === 'outbox' && q.job.tenantId === tenantId);
  const results = [];
  for (const q of mine) results.push(await notifications.handleOutboxEvent(q.job as OutboxJob));
  return { jobs: mine, results };
}

function mondayAhead(minDays: number): string {
  const d = new Date(Date.now() + minDays * 86_400_000);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7));
  return d.toISOString().slice(0, 10);
}
const DAY = mondayAhead(14);
let phoneSeq = 60_000_000;

async function business(serviceExtra: object = {}) {
  const t = await register(app);
  const slug = t.body.memberships[0]!.tenantSlug;
  const c = client(app, t.auth);
  const loc = await mkLocation(c, 'Centro', {
    address: { line1: 'Av. Providencia 1234', city: 'Santiago' },
  });
  await c.put(`/locations/${loc.id}/business-hours`, {
    intervals: hours([1, 2, 3, 4, 5, 6, 7], '08:00', '20:00'),
  });
  const ana = await mkResource(c, loc.id, 'Ana');
  const svc = await mkService(c, 'Corte', { durationMinutes: 60, price: '15000', ...serviceExtra });
  await c.put(`/services/${svc.id}/locations`, { locationIds: [loc.id] });
  await c.put(`/services/${svc.id}/resources`, { resourceIds: [ana.id] });
  const settings = (sql: string) =>
    owner.query(`UPDATE tenant_settings SET ${sql} WHERE tenant_id = $1`, [t.tenantId]);
  return { ...t, slug, c, loc, ana, svc, settings };
}
type Biz = Awaited<ReturnType<typeof business>>;

async function firstSlots(b: Biz, day = DAY): Promise<string[]> {
  const res = await http(app).get(
    `/api/v1/public/tenants/${b.slug}/availability?serviceId=${b.svc.id}&locationId=${b.loc.id}&from=${day}`,
  );
  return res.body.resources[0].slots.map((s: { start: string }) => s.start);
}
async function bookPublic(b: Biz, email: string | null, startAt?: string) {
  const res = await http(app)
    .post(`/api/v1/public/tenants/${b.slug}/reservations`)
    .set('Idempotency-Key', randomUUID())
    .send({
      serviceId: b.svc.id,
      locationId: b.loc.id,
      startAt: startAt ?? (await firstSlots(b))[0],
      customer: { firstName: 'Carla', phoneE164: `+569${phoneSeq++}`, ...(email ? { email } : {}) },
    });
  if (res.status !== 201) throw new Error(`book ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { reservation: { code: string; version: number }; manageToken: string };
}
const linkIn = (m: EmailMessage) => /mi-reserva#token=([A-Za-z0-9_-]{43})/.exec(m.text)?.[1];

describe('del outbox al email', () => {
  it('reserva confirmada => email con enlace de gestión NUEVO y válido; el evento no se vuelve a publicar', async () => {
    const b = await business();
    const email = `c-${randomUUID().slice(0, 6)}@example.test`;
    const r = await bookPublic(b, email);
    const { jobs, results } = await pump(b.tenantId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.jobId).toBe((jobs[0]!.job as OutboxJob).outboxId); // jobId = outbox.id (idempotente)
    expect(results).toEqual(['sent']);

    const [m] = mail.to(email);
    expect(m!.subject).toBe(`Reserva confirmada en ${b.body.memberships[0]!.tenantName}`);
    expect(m!.text).toContain(r.reservation.code);
    expect(m!.text).toContain('Av. Providencia 1234');
    const token = linkIn(m!)!;
    expect(token).not.toBe(r.manageToken); // el del email es otro enlace (solo existe su hash)
    const look = await http(app).post('/api/v1/public/manage/lookup').send({ token });
    expect(look.body.code).toBe(r.reservation.code);

    const { rows } = await owner.query(
      `SELECT status, attempts, recipient, sent_at FROM notifications WHERE tenant_id = $1`,
      [b.tenantId],
    );
    expect(rows).toEqual([
      expect.objectContaining({ status: 'sent', attempts: 1, recipient: email }),
    ]);
    expect((await pump(b.tenantId)).jobs).toHaveLength(0); // ya publicado
  });

  it('un job repetido (reintento de BullMQ) NO envía dos veces', async () => {
    const b = await business();
    const email = `d-${randomUUID().slice(0, 6)}@example.test`;
    await bookPublic(b, email);
    const { jobs } = await pump(b.tenantId);
    expect(await notifications.handleOutboxEvent(jobs[0]!.job as OutboxJob)).toBe('duplicate');
    expect(mail.to(email)).toHaveLength(1);
  });

  it('si el envío falla: queda "failed" sin datos personales, se reintenta y se envía UNA vez', async () => {
    const b = await business();
    const email = `f-${randomUUID().slice(0, 6)}@example.test`;
    await bookPublic(b, email);
    await dispatch.publishOutbox(enqueuer);
    const job = queued.find((q) => q.job.tenantId === b.tenantId)!.job as OutboxJob;
    mail.failures = 1;
    await expect(notifications.handleOutboxEvent(job)).rejects.toThrow(/550/);
    const failed = await owner.query(
      `SELECT status, last_error FROM notifications WHERE tenant_id = $1`,
      [b.tenantId],
    );
    expect(failed.rows[0].status).toBe('failed');
    expect(failed.rows[0].last_error).toContain('<email>');
    expect(failed.rows[0].last_error).not.toContain('@example.test');
    expect(await notifications.handleOutboxEvent(job)).toBe('sent');
    expect(mail.to(email)).toHaveLength(1);
    const after = await owner.query(
      `SELECT status, attempts FROM notifications WHERE tenant_id = $1`,
      [b.tenantId],
    );
    expect(after.rows[0]).toEqual({ status: 'sent', attempts: 2 });
  });

  it('cliente sin email, emails desactivados o consentimiento revocado: no se envía', async () => {
    const b = await business();
    await bookPublic(b, null);
    expect((await pump(b.tenantId)).results).toEqual(['skipped']);

    const revoked = `r-${randomUUID().slice(0, 6)}@example.test`;
    const free = await firstSlots(b);
    await bookPublic(b, revoked, free[4]);
    await owner.query(
      `INSERT INTO notification_consents (id, tenant_id, customer_id, channel, purpose, status, source)
       SELECT gen_random_uuid(), tenant_id, id, 'email', 'transactional', 'revoked', 'admin'
         FROM customers WHERE tenant_id = $1 AND email = $2`,
      [b.tenantId, revoked],
    );
    expect((await pump(b.tenantId)).results).toEqual(['suppressed']);
    expect(mail.to(revoked)).toHaveLength(0);

    await b.settings('customer_emails_enabled = false');
    const off = `o-${randomUUID().slice(0, 6)}@example.test`;
    await bookPublic(b, off, free[8]);
    expect((await pump(b.tenantId)).results).toEqual(['skipped']);
    expect(mail.to(off)).toHaveLength(0);
  });

  it('se registra el consentimiento transaccional con versión del texto (e IP) al reservar en el portal', async () => {
    const b = await business();
    await bookPublic(b, `k-${randomUUID().slice(0, 6)}@example.test`);
    const { rows } = await owner.query(
      `SELECT channel, purpose, status, source, evidence_version FROM notification_consents
        WHERE tenant_id = $1 ORDER BY channel`,
      [b.tenantId],
    );
    expect(rows).toEqual([
      {
        channel: 'email',
        purpose: 'transactional',
        status: 'granted',
        source: 'public_web',
        evidence_version: 'portal-2026-11',
      },
      {
        channel: 'whatsapp',
        purpose: 'transactional',
        status: 'granted',
        source: 'public_web',
        evidence_version: 'portal-2026-11',
      },
    ]);
  });
});

describe('ciclo de vida por email', () => {
  it('solicitud pendiente -> el negocio confirma -> el cliente cambia el horario -> cancela', async () => {
    const b = await business({ requiresConfirmation: true });
    const email = `v-${randomUUID().slice(0, 6)}@example.test`;
    const r = await bookPublic(b, email);
    await pump(b.tenantId);
    const id = (await b.c.get('/reservations')).body.items[0].id;
    await b.c.post(`/reservations/${id}/confirm`, { version: 1 });
    await pump(b.tenantId);
    const free = await firstSlots(b);
    const moved = await http(app)
      .post('/api/v1/public/manage/reschedule')
      .send({ token: r.manageToken, version: 2, startAt: free[6] });
    expect(moved.status).toBe(200);
    await pump(b.tenantId);
    await http(app).post('/api/v1/public/manage/cancel').send({ token: r.manageToken, version: 3 });
    await pump(b.tenantId);

    const subjects = mail.to(email).map((m) => m.subject.split(' en ')[0]!.split(' confirmó')[0]);
    expect(subjects).toEqual([
      'Recibimos tu solicitud',
      b.body.memberships[0]!.tenantName, // "<negocio> confirmó tu reserva"
      'Cambió el horario de tu reserva',
      'Reserva cancelada',
    ]);
    const [pending, , rescheduled, cancelled] = mail.to(email);
    expect(pending!.text).toMatch(/te guardamos el horario hasta las \d\d:\d\d h/);
    expect(linkIn(rescheduled!)).toBeTruthy();
    expect(linkIn(cancelled!)).toBeUndefined(); // nada que gestionar
  });

  it('cambios internos (en curso, completada) no envían email', async () => {
    const b = await business();
    const email = `i-${randomUUID().slice(0, 6)}@example.test`;
    await bookPublic(b, email);
    await pump(b.tenantId);
    const id = (await b.c.get('/reservations')).body.items[0].id;
    await b.c.post(`/reservations/${id}/status`, { version: 1, status: 'in_progress' });
    expect((await pump(b.tenantId)).results).toEqual(['skipped']);
    expect(mail.to(email)).toHaveLength(1);
  });
});

describe('recordatorios', () => {
  /** Reserva que empieza en ~`hoursAhead` h y fue creada hace `createdAgoH` h (se ajusta en BD). */
  async function upcoming(b: Biz, email: string, hoursAhead: number, createdAgoH: number) {
    // Se reserva lejos y luego se acerca en la BD (el portal no admite reservar a menos de 1 h).
    await bookPublic(b, email);
    await pump(b.tenantId);
    const start = new Date(Math.ceil((Date.now() + hoursAhead * 3_600_000) / 60_000) * 60_000);
    await owner.query(
      `WITH r AS (UPDATE reservations SET start_at = $2, end_at = $2::timestamptz + interval '1 hour',
                   created_at = now() - make_interval(hours => $3)
                   WHERE tenant_id = $1 AND customer_id = (SELECT id FROM customers WHERE tenant_id = $1 AND email = $4)
                   RETURNING id)
       UPDATE reservation_resources SET occupy_start = $2, occupy_end = $2::timestamptz + interval '1 hour'
        WHERE reservation_id IN (SELECT id FROM r)`,
      [b.tenantId, start, createdAgoH, email],
    );
    return start;
  }
  const mineReminders = (tenantId: string) =>
    queued.filter((q) => q.kind === 'reminder' && q.job.tenantId === tenantId);

  it('24 h antes: uno solo por reserva y por horario; si se reprograma, el viejo queda obsoleto', async () => {
    const b = await business();
    const email = `rem-${randomUUID().slice(0, 6)}@example.test`;
    await upcoming(b, email, 20, 72);
    await dispatch.scanReminders(enqueuer);
    const [first] = mineReminders(b.tenantId);
    expect(first).toBeDefined();
    expect(first!.jobId).toMatch(/^reminder-[0-9a-f-]+-\d+$/); // sin ':' (BullMQ)
    expect(await notifications.handleReminder(first!.job as ReminderJob)).toBe('sent');
    const reminder = mail.to(email).at(-1)!;
    expect(reminder.subject).toMatch(/^Recordatorio/);
    expect(linkIn(reminder)).toBeTruthy();

    queued = [];
    await dispatch.scanReminders(enqueuer);
    expect(mineReminders(b.tenantId)).toHaveLength(0); // ya enviado para ese inicio

    // se mueve la reserva: el job viejo (con el inicio anterior) ya no aplica
    await owner.query(
      `UPDATE reservations SET start_at = start_at + interval '2 hours', end_at = end_at + interval '2 hours' WHERE tenant_id = $1`,
      [b.tenantId],
    );
    expect(await notifications.handleReminder(first!.job as ReminderJob)).toBe('skipped');
    await dispatch.scanReminders(enqueuer);
    expect(mineReminders(b.tenantId)).toHaveLength(1); // y el nuevo horario tiene el suyo
  });

  it('no se recuerda lo reservado ya dentro de la ventana, ni si el negocio los desactivó', async () => {
    const b = await business();
    const late = `late-${randomUUID().slice(0, 6)}@example.test`;
    await upcoming(b, late, 5, 2); // creada hace 2 h para dentro de 5 h: dentro de la ventana de 24 h
    await dispatch.scanReminders(enqueuer);
    expect(mineReminders(b.tenantId)).toHaveLength(0);

    const c = await business();
    await c.settings('reminder_hours_before = NULL');
    await upcoming(c, `off-${randomUUID().slice(0, 6)}@example.test`, 20, 72);
    await dispatch.scanReminders(enqueuer);
    expect(mineReminders(c.tenantId)).toHaveLength(0);
  });
});

describe('centro de comunicaciones (panel)', () => {
  it('lista lo enviado con su estado; una fallida se reintenta UNA vez desde el panel', async () => {
    const b = await business();
    const email = `p-${randomUUID().slice(0, 6)}@example.test`;
    const r = await bookPublic(b, email);
    await dispatch.publishOutbox(enqueuer);
    const job = queued.find((q) => q.job.tenantId === b.tenantId)!.job as OutboxJob;
    // se agotan los intentos automáticos (simulado: un fallo y no se reintenta)
    mail.failures = 1;
    await expect(notifications.handleOutboxEvent(job)).rejects.toThrow();

    const list = await b.c.get('/notifications?status=failed');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    const n = list.body.items[0];
    expect(n).toMatchObject({
      channel: 'email',
      type: 'reservation.created_confirmed',
      recipient: email,
      status: 'failed',
      attempts: 1,
      reservationCode: r.reservation.code,
      customerName: 'Carla',
    });
    expect(n.subject).toMatch(/^Reserva confirmada/);

    // sent no se puede reintentar; failed sí -> queda "en cola" y deja un evento para el worker
    const retry = await b.c.post(`/notifications/${n.id}/retry`);
    expect(retry.status).toBe(202);
    expect(retry.body.status).toBe('queued');
    expect((await b.c.post(`/notifications/${n.id}/retry`)).status).toBe(409);

    const { results } = await pump(b.tenantId);
    expect(results).toEqual(['sent']);
    expect(mail.to(email)).toHaveLength(1);
    const after = (await b.c.get(`/notifications?reservationId=${n.reservationId}`)).body.items;
    expect(after).toEqual([expect.objectContaining({ id: n.id, status: 'sent', attempts: 2 })]);
    // repetir el evento de reintento no reenvía
    expect(await notifications.retry(b.tenantId, n.id)).toBe('duplicate');
  });

  it('aislamiento y permisos: otra empresa no ve ni reintenta; un profesional no entra', async () => {
    const a = await business();
    await bookPublic(a, `iso-${randomUUID().slice(0, 6)}@example.test`);
    await pump(a.tenantId);
    const id = (await a.c.get('/notifications')).body.items[0].id;
    const other = await business();
    expect((await other.c.get('/notifications')).body.items).toHaveLength(0);
    expect((await other.c.post(`/notifications/${id}/retry`)).status).toBe(404);
    const { joinTenant } = await import('./helpers.js');
    const pro = await joinTenant(app, owner, a.tenantId, 'professional');
    expect((await client(app, pro.auth).get('/notifications')).status).toBe(403);
  });
});
