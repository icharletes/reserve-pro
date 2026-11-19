import {
  type AvailabilityResponse,
  type CreatePublicReservationRequest,
  type CreatePublicReservationResponse,
  type PublicReservationView,
  type PublicServiceView,
  createPublicReservationResponse,
  publicAvailabilityResponse,
  publicReservationView,
  publicServiceView,
} from '@reservepro/contracts';

/** Error de la API con su código estable (problem+json). El mensaje ya viene en español y es apto para mostrar. */
export class PortalError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PortalError';
  }
}

interface Schema<T> {
  parse(data: unknown): T;
}

const BASE = '/api/v1/public';

/**
 * Cliente del portal (NAVEGADOR). Mismo origen: `/api` lo enruta el proxy (desarrollo) o el balanceador
 * (producción), así la CSP puede ser `connect-src 'self'`. El token de gestión viaja siempre en el CUERPO.
 * Cada respuesta se valida contra el contrato: si la API y el portal divergen, se nota de inmediato.
 */
async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  schema: Schema<T>,
  opts: { body?: unknown; headers?: Record<string, string>; fetchImpl?: typeof fetch } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(`${BASE}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...opts.headers,
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      credentials: 'omit', // el portal no usa cookies
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new PortalError(
      0,
      'NETWORK_ERROR',
      'No hay conexión. Revisa tu internet e inténtalo de nuevo.',
    );
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const p = (data ?? {}) as { code?: string; detail?: string };
    const message =
      res.status >= 500
        ? 'Tuvimos un problema. Inténtalo de nuevo en unos minutos.'
        : res.status === 429
          ? 'Demasiados intentos seguidos. Espera un momento e inténtalo de nuevo.'
          : (p.detail ?? 'No se pudo completar la acción.');
    throw new PortalError(res.status, p.code ?? 'ERROR', message);
  }
  return schema.parse(data);
}

const list = <T>(item: Schema<T>): Schema<T[]> => ({
  parse: (d) => {
    if (!Array.isArray(d)) throw new Error('se esperaba una lista');
    return d.map((x) => item.parse(x));
  },
});

const seg = encodeURIComponent;

export const portalApi = {
  services: (slug: string, locationId: string, fetchImpl?: typeof fetch) =>
    request<PublicServiceView[]>(
      'GET',
      `/tenants/${seg(slug)}/services?locationId=${seg(locationId)}`,
      list(publicServiceView),
      { fetchImpl },
    ),
  availability: (
    slug: string,
    q: { serviceId: string; locationId: string; from: string; resourceId?: string },
    fetchImpl?: typeof fetch,
  ) => {
    const qs = new URLSearchParams({
      serviceId: q.serviceId,
      locationId: q.locationId,
      from: q.from,
    });
    if (q.resourceId) qs.set('resourceId', q.resourceId);
    return request<AvailabilityResponse>(
      'GET',
      `/tenants/${seg(slug)}/availability?${qs}`,
      publicAvailabilityResponse,
      { fetchImpl },
    );
  },
  /** `idempotencyKey`: una por intención de reservar, reutilizada al reintentar (error de red, doble clic). */
  book: (
    slug: string,
    body: CreatePublicReservationRequest,
    idempotencyKey: string,
    fetchImpl?: typeof fetch,
  ) =>
    request<CreatePublicReservationResponse>(
      'POST',
      `/tenants/${seg(slug)}/reservations`,
      createPublicReservationResponse,
      { body, headers: { 'idempotency-key': idempotencyKey }, fetchImpl },
    ),
  lookup: (token: string, fetchImpl?: typeof fetch) =>
    request<PublicReservationView>('POST', '/manage/lookup', publicReservationView, {
      body: { token },
      fetchImpl,
    }),
  manageAvailability: (token: string, from: string, fetchImpl?: typeof fetch) =>
    request<AvailabilityResponse>('POST', '/manage/availability', publicAvailabilityResponse, {
      body: { token, from, days: 1 },
      fetchImpl,
    }),
  cancel: (token: string, version: number, reason: string | null, fetchImpl?: typeof fetch) =>
    request<PublicReservationView>('POST', '/manage/cancel', publicReservationView, {
      body: { token, version, reason },
      fetchImpl,
    }),
  reschedule: (token: string, version: number, startAt: string, fetchImpl?: typeof fetch) =>
    request<PublicReservationView>('POST', '/manage/reschedule', publicReservationView, {
      body: { token, version, startAt },
      fetchImpl,
    }),
};
export type PortalApi = typeof portalApi;
