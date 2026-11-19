import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@reservepro/contracts';

export const AUTHZ_KEY = 'reservepro:authz';

export type AuthzMeta =
  | { kind: 'public' }
  | { kind: 'authenticated' }
  | { kind: 'permissions'; permissions: readonly PermissionKey[]; mode: 'all' | 'any' };

/**
 * TODO endpoint debe declarar explícitamente su política. Si falta, el guard rechaza la petición
 * (falla cerrado): es imposible exponer un endpoint por olvido.
 */

/** Sin autenticación (registro, login, portal público, webhooks con firma propia). */
export const Public = () => SetMetadata(AUTHZ_KEY, { kind: 'public' } satisfies AuthzMeta);

/** Usuario autenticado; NO exige empresa activa ni permisos (p.ej. /me, cambiar de empresa). */
export const Authenticated = () =>
  SetMetadata(AUTHZ_KEY, { kind: 'authenticated' } satisfies AuthzMeta);

/** Exige empresa activa y TODOS los permisos indicados. */
export const RequirePermissions = (...permissions: PermissionKey[]) =>
  SetMetadata(AUTHZ_KEY, { kind: 'permissions', permissions, mode: 'all' } satisfies AuthzMeta);

/**
 * Exige empresa activa y AL MENOS UNO de los permisos (p. ej. `calendar:read` o `calendar:read:own`).
 * El servicio debe aplicar después el alcance que corresponda al permiso que sí tiene.
 */
export const RequireAnyPermission = (...permissions: PermissionKey[]) =>
  SetMetadata(AUTHZ_KEY, { kind: 'permissions', permissions, mode: 'any' } satisfies AuthzMeta);

export const VERIFIED_EMAIL_KEY = 'reservepro:verified-email';

/**
 * Exige además que el usuario haya verificado su email. Se usa en acciones que pueden abusarse desde
 * cuentas desechables (p.ej. enviar invitaciones por correo a terceros).
 */
export const RequireVerifiedEmail = () => SetMetadata(VERIFIED_EMAIL_KEY, true);
