import {
  type PublicServiceView,
  type PublicTenantView,
  publicServiceView,
  publicTenantView,
} from '@reservepro/contracts';

/**
 * Lectura del negocio desde el SERVIDOR del portal (SSR), para SEO y para responder 404 de verdad cuando el
 * negocio no existe. Habla con la API por la red interna (`API_URL`).
 *
 * Reenvía la IP del visitante en `X-Forwarded-For`: si no, el rate limit por IP de la API vería a todos los
 * visitantes como uno solo (el servidor del portal). En producción la API debe confiar en el portal como proxy
 * (`TRUST_PROXY`); si no confía, ignora la cabecera y limita por la IP del portal (más estricto, nunca más laxo).
 */
async function get(path: string, clientIp: string | undefined, fetchImpl: typeof fetch) {
  const base = (process.env['API_URL'] ?? 'http://localhost:3000').replace(/\/$/, '');
  return fetchImpl(`${base}/api/v1/public${path}`, {
    headers: { accept: 'application/json', ...(clientIp ? { 'x-forwarded-for': clientIp } : {}) },
    signal: AbortSignal.timeout(5_000),
  });
}

export async function loadTenant(
  slug: string,
  clientIp: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<PublicTenantView | null> {
  const res = await get(`/tenants/${encodeURIComponent(slug)}`, clientIp, fetchImpl);
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`API respondió ${res.status} al cargar el negocio`);
  return publicTenantView.parse(await res.json());
}

/** Servicios de una sucursal, para pintarlos ya en el HTML (SEO y sin parpadeo). Si falla, el navegador los pide. */
export async function loadServices(
  slug: string,
  locationId: string,
  clientIp: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<PublicServiceView[] | null> {
  try {
    const res = await get(
      `/tenants/${encodeURIComponent(slug)}/services?locationId=${encodeURIComponent(locationId)}`,
      clientIp,
      fetchImpl,
    );
    if (!res.ok) return null;
    const data: unknown = await res.json();
    return Array.isArray(data) ? data.map((s) => publicServiceView.parse(s)) : null;
  } catch {
    return null;
  }
}
