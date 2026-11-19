import { z } from 'zod';
import { ianaTimezone } from './auth.js';
import { uuid } from './common.js';

/** Nombre de catálogo: se guarda sin duplicados por empresa, sin distinguir mayúsculas (citext). */
export const catalogName = z
  .string()
  .trim()
  .min(2, 'Mínimo 2 caracteres')
  .max(100, 'Máximo 100 caracteres');

/** Dinero como TEXTO decimal ("12990" o "12990.50"): un número JSON de coma flotante perdería precisión. */
export const money = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, 'Monto inválido (hasta 2 decimales)');

const optionalText = (max: number) => z.string().trim().max(max).nullable();

/** Filtro booleano de query string ("true"/"false"). */
export const queryBool = z.enum(['true', 'false']).transform((v) => v === 'true');

export const catalogListQuery = z.object({
  cursor: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Búsqueda por nombre (contiene, sin distinguir mayúsculas). */
  q: z.string().trim().min(1).max(100).optional(),
  isActive: queryBool.optional(),
});
export type CatalogListQuery = z.infer<typeof catalogListQuery>;

// --- Sucursales -------------------------------------------------------------------------------------
export const address = z
  .object({
    line1: z.string().trim().max(150),
    line2: z.string().trim().max(150),
    city: z.string().trim().max(100),
    region: z.string().trim().max(100),
    postalCode: z.string().trim().max(20),
    country: z.string().trim().max(100),
  })
  .partial()
  .strict();
export type Address = z.infer<typeof address>;

/**
 * IMPORTANTE (esquemas de edición): se derivan de un esquema BASE sin valores por defecto. Derivarlos de los de
 * creación con `.partial()` conservaría los `default()` y un PATCH {name} reiniciaría en silencio el resto de campos.
 */
const locationFields = z.object({
  name: catalogName,
  address,
  phone: optionalText(30),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()).nullable(),
  /** null/omitido = hereda la zona horaria de la empresa. */
  timezone: ianaTimezone.nullable(),
});

export const createLocationRequest = locationFields.extend({
  address: address.default({}),
  phone: locationFields.shape.phone.optional(),
  email: locationFields.shape.email.optional(),
  timezone: locationFields.shape.timezone.optional(),
});
export type CreateLocationRequest = z.infer<typeof createLocationRequest>;

export const updateLocationRequest = locationFields
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'Debe indicar al menos un campo' });
export type UpdateLocationRequest = z.infer<typeof updateLocationRequest>;

export const locationView = z.object({
  id: uuid,
  name: z.string(),
  address: address,
  phone: z.string().nullable(),
  email: z.string().nullable(),
  timezone: z.string().nullable(),
  /** Zona horaria resuelta: la propia o, si no tiene, la de la empresa. */
  effectiveTimezone: z.string(),
  isActive: z.boolean(),
  createdAt: z.string(),
});
export type LocationView = z.infer<typeof locationView>;

// --- Categorías de servicio -------------------------------------------------------------------------
const categoryFields = z.object({
  name: catalogName,
  sortOrder: z.number().int().min(0).max(10_000),
});
export const createCategoryRequest = categoryFields.extend({
  sortOrder: categoryFields.shape.sortOrder.default(0),
});
export type CreateCategoryRequest = z.infer<typeof createCategoryRequest>;
export const updateCategoryRequest = categoryFields
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Debe indicar al menos un campo' });
export type UpdateCategoryRequest = z.infer<typeof updateCategoryRequest>;
export const categoryView = z.object({ id: uuid, name: z.string(), sortOrder: z.number().int() });
export type CategoryView = z.infer<typeof categoryView>;

// --- Servicios ----------------------------------------------------------------------------------------
const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .pipe(z.url({ protocol: /^https$/, message: 'Debe ser una URL https' }));

const serviceFields = z.object({
  name: catalogName,
  description: optionalText(2000),
  categoryId: uuid.nullable(),
  durationMinutes: z.number().int().min(1).max(1440),
  bufferBeforeMinutes: z.number().int().min(0).max(240),
  bufferAfterMinutes: z.number().int().min(0).max(240),
  /** La moneda NO se envía: la fija el servidor (moneda de la empresa). */
  price: money,
  minNoticeMinutes: z.number().int().min(0).max(525_600).nullable(),
  maxAdvanceDays: z.number().int().min(1).max(730).nullable(),
  requiresConfirmation: z.boolean().nullable(),
  imageUrl: httpsUrl.nullable(),
});

export const createServiceRequest = z.object({
  name: serviceFields.shape.name,
  description: serviceFields.shape.description.optional(),
  categoryId: serviceFields.shape.categoryId.optional(),
  durationMinutes: serviceFields.shape.durationMinutes,
  bufferBeforeMinutes: serviceFields.shape.bufferBeforeMinutes.default(0),
  bufferAfterMinutes: serviceFields.shape.bufferAfterMinutes.default(0),
  price: serviceFields.shape.price,
  minNoticeMinutes: serviceFields.shape.minNoticeMinutes.optional(),
  maxAdvanceDays: serviceFields.shape.maxAdvanceDays.optional(),
  requiresConfirmation: serviceFields.shape.requiresConfirmation.optional(),
  imageUrl: serviceFields.shape.imageUrl.optional(),
});
export type CreateServiceRequest = z.infer<typeof createServiceRequest>;

export const updateServiceRequest = serviceFields
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'Debe indicar al menos un campo' });
export type UpdateServiceRequest = z.infer<typeof updateServiceRequest>;

export const serviceView = z.object({
  id: uuid,
  name: z.string(),
  description: z.string().nullable(),
  categoryId: uuid.nullable(),
  durationMinutes: z.number().int(),
  bufferBeforeMinutes: z.number().int(),
  bufferAfterMinutes: z.number().int(),
  price: z.string(),
  currency: z.string(),
  minNoticeMinutes: z.number().int().nullable(),
  maxAdvanceDays: z.number().int().nullable(),
  requiresConfirmation: z.boolean().nullable(),
  imageUrl: z.string().nullable(),
  isActive: z.boolean(),
  locationIds: z.array(uuid),
  resourceIds: z.array(uuid),
  createdAt: z.string(),
});
export type ServiceView = z.infer<typeof serviceView>;

export const serviceListQuery = catalogListQuery.extend({
  categoryId: uuid.optional(),
  locationId: uuid.optional(),
});
export type ServiceListQuery = z.infer<typeof serviceListQuery>;

export const setServiceLocationsRequest = z.object({ locationIds: z.array(uuid).max(100) });
export type SetServiceLocationsRequest = z.infer<typeof setServiceLocationsRequest>;
export const setServiceResourcesRequest = z.object({ resourceIds: z.array(uuid).max(200) });
export type SetServiceResourcesRequest = z.infer<typeof setServiceResourcesRequest>;

// --- Profesionales y recursos --------------------------------------------------------------------------
export const RESOURCE_KINDS = ['staff', 'room', 'equipment', 'vehicle', 'space'] as const;
export const resourceKind = z.enum(RESOURCE_KINDS);
export type ResourceKind = z.infer<typeof resourceKind>;

const resourceFields = z.object({
  locationId: uuid,
  kind: resourceKind,
  name: catalogName,
  /** MVP: capacidad 1 (ADR-006). El campo existe para no migrar luego. */
  capacity: z.literal(1),
  /** Solo para kind=staff: vincula al profesional con su usuario (para ver su agenda propia). */
  membershipId: uuid.nullable(),
  isBookableOnline: z.boolean(),
  autoAssignable: z.boolean(),
  sortOrder: z.number().int().min(0).max(10_000),
});

export const createResourceRequest = z.object({
  locationId: resourceFields.shape.locationId,
  kind: resourceFields.shape.kind,
  name: resourceFields.shape.name,
  capacity: resourceFields.shape.capacity.default(1),
  membershipId: resourceFields.shape.membershipId.optional(),
  isBookableOnline: resourceFields.shape.isBookableOnline.default(true),
  autoAssignable: resourceFields.shape.autoAssignable.default(true),
  sortOrder: resourceFields.shape.sortOrder.default(0),
});
export type CreateResourceRequest = z.infer<typeof createResourceRequest>;

/** La sucursal y el tipo de un recurso son inmutables (cambiarlos invalidaría horarios y vínculos): se crea otro. */
export const updateResourceRequest = resourceFields
  .omit({ locationId: true, kind: true })
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'Debe indicar al menos un campo' });
export type UpdateResourceRequest = z.infer<typeof updateResourceRequest>;

export const resourceView = z.object({
  id: uuid,
  locationId: uuid,
  kind: resourceKind,
  name: z.string(),
  capacity: z.number().int(),
  membershipId: uuid.nullable(),
  isBookableOnline: z.boolean(),
  autoAssignable: z.boolean(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: z.string(),
});
export type ResourceView = z.infer<typeof resourceView>;

export const resourceListQuery = catalogListQuery.extend({
  locationId: uuid.optional(),
  kind: resourceKind.optional(),
});
export type ResourceListQuery = z.infer<typeof resourceListQuery>;
