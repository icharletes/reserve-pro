import { PERMISSION_KEYS } from '@reservepro/contracts';
import type { Tx } from '@reservepro/database';

/** ¿Todos los permisos de `needed` están en `held`? */
export function isSubset(needed: Iterable<string>, held: ReadonlySet<string>): boolean {
  for (const p of needed) if (!held.has(p)) return false;
  return true;
}

/**
 * Implicación de permisos: tener `x` implica tener su variante restringida `x:own`
 * (quien puede ver TODAS las reservas puede, con más razón, ver las propias).
 * Por eso la plantilla `admin` no repite los `:own`. Solo se usa para COMPARAR privilegios.
 */
export function withImplied(perms: Iterable<string>): Set<string> {
  const out = new Set(perms);
  for (const p of PERMISSION_KEYS) {
    if (p.endsWith(':own')) {
      const broader = p.slice(0, -':own'.length);
      if (out.has(broader)) out.add(p);
    }
  }
  return out;
}

/** Permisos efectivos de un conjunto de roles (unión), leídos bajo el contexto de tenant de `tx`. */
export async function permissionsOfRoles(tx: Tx, roleIds: string[]): Promise<Set<string>> {
  if (roleIds.length === 0) return new Set();
  const rows = await tx.role_permissions.findMany({
    where: { role_id: { in: roleIds } },
    select: { permission_key: true },
  });
  return new Set(rows.map((r) => r.permission_key));
}

/**
 * Anti-escalada de privilegios. Reglas (ARCHITECTURE.md §3):
 *  - Solo se puede OTORGAR un rol cuyos permisos sean un subconjunto de los del actor.
 *    (Un administrador no puede crear propietarios: el rol owner incluye billing:manage, que él no tiene.)
 *  - Solo se puede GESTIONAR a un miembro cuyos permisos actuales sean un subconjunto de los del actor.
 * Así el techo de privilegios lo marca el propio actor, sin listas de excepciones por rol.
 */
export const canHold = (actor: ReadonlySet<string>, needed: Iterable<string>): boolean =>
  isSubset(withImplied(needed), withImplied(actor));
