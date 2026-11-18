import type { Request } from 'express';
import type { PermissionKey } from '@reservepro/contracts';

/** Identidad autenticada de la request, reconstruida desde la base de datos en cada llamada. */
export interface Principal {
  userId: string;
  email: string;
  fullName: string;
  isPlatformAdmin: boolean;
  /** El usuario demostró controlar su email (token recibido en su buzón). */
  emailVerified: boolean;
  /** Sesión = familia de refresh tokens. Revocarla invalida el access token de inmediato. */
  sessionId: string;
  /** null cuando el usuario aún no eligió empresa. */
  tenantId: string | null;
  membershipId: string | null;
  roles: string[];
  permissions: ReadonlySet<PermissionKey>;
}

export interface TenantPrincipal extends Principal {
  tenantId: string;
  membershipId: string;
}

export function hasTenant(p: Principal): p is TenantPrincipal {
  return p.tenantId !== null && p.membershipId !== null;
}

export type AuthedRequest = Request & { principal?: Principal };

declare module 'nestjs-cls' {
  interface ClsStore {
    principal?: Principal;
    ip?: string;
    userAgent?: string;
  }
}
