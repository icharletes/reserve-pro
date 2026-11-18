import { randomBytes } from 'node:crypto';

/** Convierte un nombre comercial en un slug válido para `tenants.slug` (^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$). */
export function slugify(input: string): string {
  const base = input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita tildes
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  if (base.length === 0) return 'negocio';
  return base.length < 3 ? `${base}-app` : base;
}

/** Variante con sufijo aleatorio corto para resolver colisiones. */
export function withRandomSuffix(slug: string): string {
  return `${slug}-${randomBytes(2).toString('hex')}`;
}
