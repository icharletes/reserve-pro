import { z } from 'zod';
import { phoneE164, uuid } from './common.js';
import { isoDate } from './schedules.js';

const email = z.string().trim().toLowerCase().max(254).pipe(z.email('Email inválido'));
const instant = z.iso.datetime({
  offset: true,
  message: 'Fecha y hora inválidas (ISO 8601 con zona)',
});

// --- Clientes ------------------------------------------------------------------------------------------
/** Base SIN valores por defecto (ADR-013): los esquemas de edición se derivan de aquí. */
const customerFields = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().max(100).nullable(),
  /** Formato internacional E.164 (+56912345678). El panel normaliza antes de enviar. */
  phoneE164: phoneE164.nullable(),
  email: email.nullable(),
  internalNotes: z.string().trim().max(2000).nullable(),
});
const contactable = (v: {
  phoneE164?: string | null | undefined;
  email?: string | null | undefined;
}) => !!(v.phoneE164 || v.email);
const CONTACT_MSG = { message: 'Indica al menos un teléfono o un email', path: ['phoneE164'] };

export const createCustomerRequest = customerFields
  .partial({ lastName: true, phoneE164: true, email: true, internalNotes: true })
  .refine(contactable, CONTACT_MSG);
export type CreateCustomerRequest = z.infer<typeof createCustomerRequest>;

export const updateCustomerRequest = customerFields
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Debe indicar al menos un campo' });
export type UpdateCustomerRequest = z.infer<typeof updateCustomerRequest>;

export const customerView = z.object({
  id: uuid,
  firstName: z.string(),
  lastName: z.string().nullable(),
  phoneE164: z.string().nullable(),
  email: z.string().nullable(),
  internalNotes: z.string().nullable(),
  createdAt: z.string(),
});
export type CustomerView = z.infer<typeof customerView>;

export const customerListQuery = z.object({
  cursor: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Busca por nombre, teléfono o email. */
  q: z.string().trim().min(1).max(100).optional(),
});
export type CustomerListQuery = z.infer<typeof customerListQuery>;

// --- Disponibilidad ----------------------------------------------------------------------------------------
export const availabilityQuery = z.object({
  serviceId: uuid,
  locationId: uuid,
  /** Fecha local (de la sucursal) desde la que buscar. */
  from: isoDate,
  days: z.coerce.number().int().min(1).max(14).default(1),
  /** Opcional: solo ese recurso. Sin él, todos los recursos compatibles. */
  resourceId: uuid.optional(),
});
export type AvailabilityQuery = z.infer<typeof availabilityQuery>;

export const availabilityResponse = z.object({
  timezone: z.string(),
  stepMinutes: z.number().int(),
  resources: z.array(
    z.object({
      resourceId: uuid,
      name: z.string(),
      slots: z.array(z.object({ start: z.string(), end: z.string() })),
    }),
  ),
});
export type AvailabilityResponse = z.infer<typeof availabilityResponse>;

// --- Reservas ------------------------------------------------------------------------------------------------
export const RESERVATION_STATUSES = [
  'pending',
  'confirmed',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
] as const;
export const reservationStatus = z.enum(RESERVATION_STATUSES);
export type ReservationStatusValue = z.infer<typeof reservationStatus>;

/** El cliente se indica por id (existente) o por sus datos (se reutiliza si ya existe ese teléfono). */
const customerRef = z.union([z.object({ id: uuid }).strict(), createCustomerRequest]);

export const createReservationRequest = z.object({
  serviceId: uuid,
  locationId: uuid,
  /** null u omitido = asignación automática entre los recursos compatibles libres. */
  resourceId: uuid.nullable().optional(),
  /** Inicio de la ventana visible del cliente. Precio, duración y fin los calcula el servidor. */
  startAt: instant,
  customer: customerRef,
  customerNotes: z.string().trim().max(1000).nullable().optional(),
  internalNotes: z.string().trim().max(2000).nullable().optional(),
});
export type CreateReservationRequest = z.infer<typeof createReservationRequest>;

export const reservationView = z.object({
  id: uuid,
  code: z.string(),
  status: reservationStatus,
  source: z.string(),
  locationId: uuid,
  customer: z.object({
    id: uuid,
    firstName: z.string(),
    lastName: z.string().nullable(),
    phoneE164: z.string().nullable(),
    email: z.string().nullable(),
  }),
  startAt: z.string(),
  endAt: z.string(),
  timeZone: z.string(),
  totalAmount: z.string(),
  currency: z.string(),
  paidAmount: z.string(),
  rescheduleCount: z.number().int(),
  customerNotes: z.string().nullable(),
  internalNotes: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancellationReason: z.string().nullable(),
  /** Enviar en cada cambio: si otro usuario la modificó antes, la API responde 409 VERSION_CONFLICT. */
  version: z.number().int(),
  items: z.array(
    z.object({
      serviceId: uuid,
      serviceName: z.string(),
      durationMinutes: z.number().int(),
      unitPrice: z.string(),
      startAt: z.string(),
      endAt: z.string(),
    }),
  ),
  resources: z.array(
    z.object({ resourceId: uuid, occupyStart: z.string(), occupyEnd: z.string() }),
  ),
  createdAt: z.string(),
});
export type ReservationView = z.infer<typeof reservationView>;

export const reservationListQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Reservas que empiezan en [from, to). */
  from: instant.optional(),
  to: instant.optional(),
  status: reservationStatus.optional(),
  resourceId: uuid.optional(),
  locationId: uuid.optional(),
  customerId: uuid.optional(),
});
export type ReservationListQuery = z.infer<typeof reservationListQuery>;

const versioned = { version: z.number().int().min(1) };
export const confirmReservationRequest = z.object(versioned);
export type ConfirmReservationRequest = z.infer<typeof confirmReservationRequest>;
export const cancelReservationRequest = z.object({
  ...versioned,
  reason: z.string().trim().max(300).nullable().optional(),
});
export type CancelReservationRequest = z.infer<typeof cancelReservationRequest>;
export const changeStatusRequest = z.object({
  ...versioned,
  status: z.enum(['in_progress', 'completed', 'no_show']),
});
export type ChangeStatusRequest = z.infer<typeof changeStatusRequest>;
export const rescheduleReservationRequest = z.object({
  ...versioned,
  startAt: instant,
  /** Opcional: cambiar de recurso. Sin él, se mantiene el actual. */
  resourceId: uuid.optional(),
});
export type RescheduleReservationRequest = z.infer<typeof rescheduleReservationRequest>;

export const reservationEventView = z.object({
  id: uuid,
  type: z.string(),
  actorType: z.string(),
  actorId: uuid.nullable(),
  payload: z.unknown(),
  occurredAt: z.string(),
});
export type ReservationEventView = z.infer<typeof reservationEventView>;
