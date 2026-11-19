import { z } from 'zod';
import { phoneE164, uuid } from './common.js';
import { availabilityResponse } from './reservations.js';
import { isoDate } from './schedules.js';

/**
 * Contratos del PORTAL PÚBLICO (sin cuenta). Principios (ADR-015):
 *  - La empresa sale del slug de la URL o del token, nunca del cuerpo.
 *  - Nada de datos personales de terceros: una reserva pública NO devuelve los datos del cliente guardado.
 *  - El token de gestión viaja en el CUERPO (nunca en la URL ni en la query).
 */

const instant = z.iso.datetime({
  offset: true,
  message: 'Fecha y hora inválidas (ISO 8601 con zona)',
});
const email = z.string().trim().toLowerCase().max(254).pipe(z.email('Email inválido'));
/** Token de gestión: 256 bits en base64url. */
export const manageToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Enlace inválido');

export const publicLocationView = z.object({
  id: uuid,
  name: z.string(),
  address: z.record(z.string(), z.unknown()),
  phone: z.string().nullable(),
  timezone: z.string(),
});
export type PublicLocationView = z.infer<typeof publicLocationView>;

export const publicTenantView = z.object({
  name: z.string(),
  slug: z.string(),
  timezone: z.string(),
  currency: z.string(),
  locations: z.array(publicLocationView),
  policies: z.object({
    cancelWindowHours: z.number().int(),
    rescheduleWindowHours: z.number().int(),
    maxReschedules: z.number().int(),
  }),
});
export type PublicTenantView = z.infer<typeof publicTenantView>;

export const publicServicesQuery = z.object({ locationId: uuid });
export type PublicServicesQuery = z.infer<typeof publicServicesQuery>;

export const publicServiceView = z.object({
  id: uuid,
  name: z.string(),
  description: z.string().nullable(),
  categoryName: z.string().nullable(),
  durationMinutes: z.number().int(),
  price: z.string(),
  currency: z.string(),
  imageUrl: z.string().nullable(),
  /** Si true, la reserva queda pendiente hasta que el negocio la confirme. */
  requiresConfirmation: z.boolean(),
  resources: z.array(z.object({ id: uuid, name: z.string() })),
});
export type PublicServiceView = z.infer<typeof publicServiceView>;

export const publicAvailabilityQuery = z.object({
  serviceId: uuid,
  locationId: uuid,
  from: isoDate,
  days: z.coerce.number().int().min(1).max(7).default(1),
  resourceId: uuid.optional(),
});
export type PublicAvailabilityQuery = z.infer<typeof publicAvailabilityQuery>;
export const publicAvailabilityResponse = availabilityResponse;

export const createPublicReservationRequest = z.object({
  serviceId: uuid,
  locationId: uuid,
  /** null u omitido = "cualquiera disponible". */
  resourceId: uuid.nullable().optional(),
  startAt: instant,
  customer: z.object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().max(100).nullable().optional(),
    /** Obligatorio en el portal: identifica al cliente y limita el acaparamiento de horarios. */
    phoneE164,
    email: email.nullable().optional(),
  }),
  customerNotes: z.string().trim().max(1000).nullable().optional(),
});
export type CreatePublicReservationRequest = z.infer<typeof createPublicReservationRequest>;

export const publicReservationView = z.object({
  code: z.string(),
  status: z.enum(['pending', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show']),
  startAt: z.string(),
  endAt: z.string(),
  timeZone: z.string(),
  /** Hasta cuándo se retiene una reserva pendiente de confirmar (null si no aplica). */
  holdExpiresAt: z.string().nullable(),
  tenantName: z.string(),
  tenantSlug: z.string(),
  serviceId: uuid,
  serviceName: z.string(),
  durationMinutes: z.number().int(),
  totalAmount: z.string(),
  currency: z.string(),
  locationId: uuid,
  locationName: z.string(),
  locationAddress: z.record(z.string(), z.unknown()),
  resourceName: z.string(),
  /** Enviar en cancelar/reprogramar: si la reserva cambió mientras tanto, 409 VERSION_CONFLICT. */
  version: z.number().int(),
  /** Lo que el cliente puede hacer AHORA según las políticas de la empresa (el servidor lo vuelve a exigir). */
  canCancel: z.boolean(),
  canReschedule: z.boolean(),
  /** Explicación cuando una acción no está disponible (p. ej. fuera de plazo). */
  policyNote: z.string().nullable(),
});
export type PublicReservationView = z.infer<typeof publicReservationView>;

export const createPublicReservationResponse = z.object({
  reservation: publicReservationView,
  /** Secreto del enlace de gestión. Se muestra UNA vez: guardarlo solo en el fragmento de la URL (#token=…). */
  manageToken,
});
export type CreatePublicReservationResponse = z.infer<typeof createPublicReservationResponse>;

export const manageLookupRequest = z.object({ token: manageToken });
export type ManageLookupRequest = z.infer<typeof manageLookupRequest>;

export const manageCancelRequest = z.object({
  token: manageToken,
  version: z.number().int().min(1),
  reason: z.string().trim().max(300).nullable().optional(),
});
export type ManageCancelRequest = z.infer<typeof manageCancelRequest>;

export const manageRescheduleRequest = z.object({
  token: manageToken,
  version: z.number().int().min(1),
  startAt: instant,
});
export type ManageRescheduleRequest = z.infer<typeof manageRescheduleRequest>;

export const manageAvailabilityRequest = z.object({
  token: manageToken,
  from: isoDate,
  days: z.number().int().min(1).max(7).default(1),
});
export type ManageAvailabilityRequest = z.infer<typeof manageAvailabilityRequest>;
