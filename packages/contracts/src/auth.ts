import { z } from 'zod';
import { tenantSlug, uuid } from './common.js';

export const password = z
  .string()
  .min(10, 'La contraseña debe tener al menos 10 caracteres')
  .max(128, 'La contraseña no puede superar 128 caracteres');

const email = z.string().trim().toLowerCase().max(254).pipe(z.email('Email inválido'));

/** Zona horaria IANA válida (p.ej. America/Santiago). */
export const ianaTimezone = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Zona horaria IANA inválida' },
);

export const registerRequest = z.object({
  email,
  password,
  fullName: z.string().trim().min(2).max(150),
  businessName: z.string().trim().min(2).max(150),
  /** Opcional: si se omite se genera desde el nombre del negocio. */
  slug: tenantSlug.optional(),
  timezone: ianaTimezone.default('America/Santiago'),
  currency: z.string().length(3).toUpperCase().default('CLP'),
});
export type RegisterRequest = z.infer<typeof registerRequest>;

export const loginRequest = z.object({
  email,
  // No se aplica la política de longitud al iniciar sesión (solo no vacía y acotada).
  password: z.string().min(1).max(128),
  /** Opcional: empresa a activar. Si se omite y hay una sola, se activa; si hay varias, el cliente elige. */
  tenantId: uuid.optional(),
});
export type LoginRequest = z.infer<typeof loginRequest>;

export const switchTenantRequest = z.object({ tenantId: uuid });
export type SwitchTenantRequest = z.infer<typeof switchTenantRequest>;

export const membershipSummary = z.object({
  membershipId: uuid,
  tenantId: uuid,
  tenantName: z.string(),
  tenantSlug: z.string(),
});
export type MembershipSummary = z.infer<typeof membershipSummary>;

export const authResponse = z.object({
  accessToken: z.string(),
  /** Segundos de vida del access token. */
  expiresIn: z.number().int(),
  user: z.object({ id: uuid, email: z.string(), fullName: z.string() }),
  /** Empresa activa del token; null si el usuario debe elegir una. */
  activeTenantId: uuid.nullable(),
  memberships: z.array(membershipSummary),
});
export type AuthResponse = z.infer<typeof authResponse>;

export const meResponse = z.object({
  user: z.object({ id: uuid, email: z.string(), fullName: z.string(), isPlatformAdmin: z.boolean() }),
  tenant: z
    .object({ id: uuid, name: z.string(), slug: z.string(), timezone: z.string(), currency: z.string() })
    .nullable(),
  membershipId: uuid.nullable(),
  roles: z.array(z.string()),
  permissions: z.array(z.string()),
});
export type MeResponse = z.infer<typeof meResponse>;
