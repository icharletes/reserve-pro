import { z } from 'zod';
import { uuid } from './common.js';

// --- Configuración de reservas y comunicaciones de la empresa -------------------------------------------------
/**
 * Base SIN valores por defecto (ADR-013): el esquema de edición se deriva de aquí con `.partial()`, así un PATCH
 * que solo trae un campo no reinicia los demás. Los rangos coinciden con los CHECK de `tenant_settings`.
 */
const settingsFields = z.object({
  /** Portal público activado (si no, el negocio "no existe" para el público). */
  publicBookingEnabled: z.boolean(),
  /** Antelación mínima para reservar desde el portal, en minutos (0 = hasta el último momento). */
  bookingMinNoticeMinutes: z
    .number()
    .int()
    .min(0)
    .max(30 * 24 * 60),
  /** Hasta cuántos días adelante se puede reservar desde el portal. */
  bookingMaxAdvanceDays: z.number().int().min(1).max(730),
  /** Rejilla de horarios ofrecidos, en minutos. */
  slotStepMinutes: z.union([
    z.literal(5),
    z.literal(10),
    z.literal(15),
    z.literal(20),
    z.literal(30),
    z.literal(60),
  ]),
  /** Si false, las reservas del portal quedan pendientes hasta que el negocio las confirme. */
  autoConfirm: z.boolean(),
  /** Cuánto se retiene el horario de una reserva pendiente antes de liberarlo. */
  pendingHoldMinutes: z
    .number()
    .int()
    .min(5)
    .max(7 * 24 * 60),
  selfServiceCancel: z.boolean(),
  /** El cliente puede cancelar en línea hasta N horas antes. */
  cancelWindowHours: z.number().int().min(0).max(720),
  /** Si true, el cliente no cancela en línea: debe contactar al negocio. */
  cancelRequiresApproval: z.boolean(),
  selfServiceReschedule: z.boolean(),
  rescheduleWindowHours: z.number().int().min(0).max(720),
  maxReschedules: z.number().int().min(0).max(20),
  /** Anti-acaparamiento: reservas activas por cliente desde el portal. */
  maxActivePublicPerCustomer: z.number().int().min(1).max(50),
  /** Emails al cliente (confirmación, cambios, recordatorio). */
  customerEmailsEnabled: z.boolean(),
  /** Recordatorio N horas antes; null = sin recordatorio. */
  reminderHoursBefore: z.number().int().min(1).max(168).nullable(),
});

export const tenantSettingsView = settingsFields.extend({ updatedAt: z.string() });
export type TenantSettingsView = z.infer<typeof tenantSettingsView>;

export const updateTenantSettingsRequest = settingsFields
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Debe indicar al menos un campo' });
export type UpdateTenantSettingsRequest = z.infer<typeof updateTenantSettingsRequest>;

// --- Centro de comunicaciones ---------------------------------------------------------------------------------
export const NOTIFICATION_STATUSES = [
  'queued',
  'sending',
  'sent',
  'delivered',
  'read',
  'failed',
  'suppressed',
] as const;
export const notificationStatus = z.enum(NOTIFICATION_STATUSES);

export const notificationView = z.object({
  id: uuid,
  channel: z.string(),
  /** reservation.created_confirmed, reservation.reminder, … */
  type: z.string(),
  recipient: z.string(),
  subject: z.string().nullable(),
  status: notificationStatus,
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  reservationId: uuid.nullable(),
  reservationCode: z.string().nullable(),
  customerName: z.string().nullable(),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
});
export type NotificationView = z.infer<typeof notificationView>;

export const notificationListQuery = z.object({
  cursor: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: notificationStatus.optional(),
  reservationId: uuid.optional(),
});
export type NotificationListQuery = z.infer<typeof notificationListQuery>;
