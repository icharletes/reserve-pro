import { RESERVED_SLUGS, tenantSlug } from '@reservepro/contracts';

/**
 * Valida el segmento de la URL `/{slug}` ANTES de pedir nada a la API: descarta lo que jamás podría ser una
 * empresa (formato inválido o nombres reservados del sistema) y evita consultas inútiles o abusivas.
 * Devuelve el slug normalizado o null.
 */
export function parsePublicSlug(raw: string | undefined): string | null {
  if (!raw) return null;
  const slug = raw.toLowerCase();
  if (!tenantSlug.safeParse(slug).success) return null;
  if ((RESERVED_SLUGS as readonly string[]).includes(slug)) return null;
  return slug;
}
