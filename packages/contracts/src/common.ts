import { z } from 'zod';

/** Teléfono en formato E.164 (mismo patrón que el CHECK de customers.phone_e164). */
export const phoneE164 = z.string().regex(/^\+[1-9][0-9]{6,14}$/, 'Teléfono en formato internacional (+56...)');

/** Slug público de una empresa (mismo patrón que el CHECK de tenants.slug). */
export const tenantSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/);

export const uuid = z.string().uuid();

/** Paginación por cursor, común a los listados. */
export const cursorPage = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** Cuerpo de error `application/problem+json` con código estable. */
export const problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
  requestId: z.string().optional(),
});
export type Problem = z.infer<typeof problem>;

export const ERROR_CODES = [
  'SLOT_UNAVAILABLE',
  'OUTSIDE_BOOKING_WINDOW',
  'INVALID_TRANSITION',
  'IDEMPOTENCY_CONFLICT',
  'VERSION_CONFLICT',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'TOKEN_INVALID',
  'TENANT_REQUIRED',
  'CSRF_REJECTED',
  'EMAIL_TAKEN',
  'SLUG_TAKEN',
  'TOO_MANY_ATTEMPTS',
  'INTERNAL_ERROR',
  'ALREADY_MEMBER',
  'INVITATION_INVALID',
  'LAST_OWNER',
  'CANNOT_MODIFY_SELF',
  'ROLE_NOT_ALLOWED',
  'LIMIT_REACHED',
  'ALREADY_INVITED',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
