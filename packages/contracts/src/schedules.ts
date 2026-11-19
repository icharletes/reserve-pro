import { z } from 'zod';
import { uuid } from './common.js';

/** "HH:MM" de 00:00 a 24:00 (24:00 = fin del día). */
export const clock = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'Hora inválida (HH:MM, de 00:00 a 24:00)');
export const isoDate = z.iso.date('Fecha inválida (AAAA-MM-DD)');

export const clockToMinutes = (c: string): number => {
  const [h, m] = c.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

/** Día de la semana ISO: 1 = lunes … 7 = domingo. */
export const weekday = z.number().int().min(1).max(7);

const endAfterStart = (v: { start: string; end: string }) =>
  clockToMinutes(v.end) > clockToMinutes(v.start);
const ORDER_MSG = { message: 'La hora de fin debe ser posterior a la de inicio', path: ['end'] };

// --- Horario semanal de la sucursal -------------------------------------------------------------------
export const weeklyInterval = z
  .object({ weekday, start: clock, end: clock })
  .refine(endAfterStart, ORDER_MSG);
export type WeeklyInterval = z.infer<typeof weeklyInterval>;

export const setBusinessHoursRequest = z.object({ intervals: z.array(weeklyInterval).max(70) });
export type SetBusinessHoursRequest = z.infer<typeof setBusinessHoursRequest>;
export const businessHoursView = z.object({ intervals: z.array(weeklyInterval) });
export type BusinessHoursView = z.infer<typeof businessHoursView>;

// --- Horario semanal del recurso (con vigencia opcional) ------------------------------------------------
export const resourceInterval = z
  .object({
    weekday,
    start: clock,
    end: clock,
    validFrom: isoDate.nullable().optional(),
    validTo: isoDate.nullable().optional(),
  })
  .refine(endAfterStart, ORDER_MSG)
  .refine((v) => !v.validFrom || !v.validTo || v.validFrom <= v.validTo, {
    message: 'La vigencia termina antes de empezar',
    path: ['validTo'],
  });
export type ResourceInterval = z.infer<typeof resourceInterval>;

export const setResourceScheduleRequest = z.object({
  intervals: z.array(resourceInterval).max(100),
});
export type SetResourceScheduleRequest = z.infer<typeof setResourceScheduleRequest>;
export const resourceScheduleView = z.object({
  intervals: z.array(
    z.object({
      weekday,
      start: clock,
      end: clock,
      validFrom: isoDate.nullable(),
      validTo: isoDate.nullable(),
    }),
  ),
});
export type ResourceScheduleView = z.infer<typeof resourceScheduleView>;

// --- Excepciones por fecha ---------------------------------------------------------------------------------
const dayInterval = z.object({ start: clock, end: clock }).refine(endAfterStart, ORDER_MSG);

export const putOverrideRequest = z
  .object({
    closed: z.boolean(),
    intervals: z.array(dayInterval).max(6).default([]),
    reason: z.string().trim().max(200).nullable().optional(),
  })
  .refine((v) => (v.closed ? v.intervals.length === 0 : v.intervals.length > 0), {
    message: 'Un día cerrado no lleva tramos; un día abierto necesita al menos uno',
    path: ['intervals'],
  });
export type PutOverrideRequest = z.infer<typeof putOverrideRequest>;

export const overrideView = z.object({
  date: isoDate,
  closed: z.boolean(),
  intervals: z.array(z.object({ start: clock, end: clock })),
  reason: z.string().nullable(),
});
export type OverrideView = z.infer<typeof overrideView>;

export const overrideListQuery = z
  .object({ from: isoDate, to: isoDate })
  .refine((v) => v.from <= v.to, { message: 'El rango es inválido', path: ['to'] });
export type OverrideListQuery = z.infer<typeof overrideListQuery>;

// --- Feriados -----------------------------------------------------------------------------------------------
export const putHolidayRequest = z.object({ name: z.string().trim().min(2).max(100) });
export type PutHolidayRequest = z.infer<typeof putHolidayRequest>;
export const holidayView = z.object({ date: isoDate, name: z.string() });
export type HolidayView = z.infer<typeof holidayView>;
export const holidayListQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100) });
export type HolidayListQuery = z.infer<typeof holidayListQuery>;

// --- Bloqueos ---------------------------------------------------------------------------------------------------
export const BLOCK_KINDS = ['time_off', 'maintenance', 'manual', 'break'] as const;
export const blockKind = z.enum(BLOCK_KINDS);
export type BlockKind = z.infer<typeof blockKind>;

const instant = z.iso.datetime({
  offset: true,
  message: 'Fecha y hora inválidas (ISO 8601 con zona)',
});
const MAX_BLOCK_MS = 366 * 86_400_000;
const validSpan = (v: { startAt?: string | undefined; endAt?: string | undefined }) => {
  if (!v.startAt || !v.endAt) return true;
  const ms = Date.parse(v.endAt) - Date.parse(v.startAt);
  return ms > 0 && ms <= MAX_BLOCK_MS;
};
const SPAN_MSG = {
  message: 'El fin debe ser posterior al inicio y no superar 366 días',
  path: ['endAt'],
};

export const createBlocksRequest = z
  .object({
    resourceIds: z.array(uuid).min(1).max(100),
    kind: blockKind.default('manual'),
    startAt: instant,
    endAt: instant,
    reason: z.string().trim().max(200).nullable().optional(),
  })
  .refine(validSpan, SPAN_MSG);
export type CreateBlocksRequest = z.infer<typeof createBlocksRequest>;

export const updateBlockRequest = z
  .object({
    kind: blockKind,
    startAt: instant,
    endAt: instant,
    reason: z.string().trim().max(200).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Debe indicar al menos un campo' })
  .refine(validSpan, SPAN_MSG);
export type UpdateBlockRequest = z.infer<typeof updateBlockRequest>;

export const blockView = z.object({
  id: uuid,
  resourceId: uuid,
  kind: blockKind,
  startAt: z.string(),
  endAt: z.string(),
  reason: z.string().nullable(),
  createdAt: z.string(),
});
export type BlockView = z.infer<typeof blockView>;

export const blockListQuery = z.object({
  cursor: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  resourceId: uuid.optional(),
  locationId: uuid.optional(),
  /** Bloqueos que se solapan con [from, to). */
  from: instant.optional(),
  to: instant.optional(),
});
export type BlockListQuery = z.infer<typeof blockListQuery>;

// --- Calendario (solo lectura) --------------------------------------------------------------------------------
export const MAX_CALENDAR_DAYS = 31;

export const calendarQuery = z
  .object({ from: isoDate, to: isoDate, locationId: uuid.optional(), resourceId: uuid.optional() })
  .refine((v) => v.from <= v.to, { message: 'El rango es inválido', path: ['to'] })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 < MAX_CALENDAR_DAYS, {
    message: `El rango no puede superar ${MAX_CALENDAR_DAYS} días`,
    path: ['to'],
  });
export type CalendarQuery = z.infer<typeof calendarQuery>;

export const calendarResponse = z.object({
  from: isoDate,
  to: isoDate,
  resources: z.array(
    z.object({
      resourceId: uuid,
      name: z.string(),
      kind: z.string(),
      locationId: uuid,
      /** Zona horaria con la que se interpretó su horario de pared. */
      timezone: z.string(),
      /** Rangos de trabajo en UTC (ya con horario semanal, excepciones, feriados y cambio de hora aplicados). */
      working: z.array(z.object({ start: z.string(), end: z.string() })),
      blocks: z.array(
        z.object({
          id: uuid,
          kind: blockKind,
          start: z.string(),
          end: z.string(),
          reason: z.string().nullable(),
        }),
      ),
    }),
  ),
});
export type CalendarResponse = z.infer<typeof calendarResponse>;
