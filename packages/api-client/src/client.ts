import {
  type AcceptInvitationRequest,
  type AuthResponse,
  type AvailabilityQuery,
  type CalendarQuery,
  type CancelReservationRequest,
  type ChangeStatusRequest,
  type CreateCustomerRequest,
  type CreateReservationRequest,
  type CustomerListQuery,
  type ReservationListQuery,
  type RescheduleReservationRequest,
  type UpdateCustomerRequest,
  type ChangePasswordRequest,
  type CreateBlocksRequest,
  type CreateCategoryRequest,
  type CreateInvitationRequest,
  type CreateLocationRequest,
  type CreateResourceRequest,
  type CreateServiceRequest,
  type ForgotPasswordRequest,
  type LoginRequest,
  type PutHolidayRequest,
  type PutOverrideRequest,
  type RegisterRequest,
  type ResetPasswordRequest,
  type ResourceListQuery,
  type ServiceListQuery,
  type SetBusinessHoursRequest,
  type SetResourceScheduleRequest,
  type SetServiceLocationsRequest,
  type SetServiceResourcesRequest,
  type UpdateBlockRequest,
  type UpdateCategoryRequest,
  type UpdateLocationRequest,
  type UpdateMemberRequest,
  type UpdateResourceRequest,
  type UpdateServiceRequest,
  type UpdateTenantRequest,
  acceptInvitationResponse,
  auditLogView,
  authResponse,
  availabilityResponse,
  customerView,
  reservationEventView,
  reservationView,
  blockView,
  businessHoursView,
  calendarResponse,
  categoryView,
  createInvitationResponse,
  holidayView,
  invitationPreview,
  invitationView,
  locationView,
  meResponse,
  memberView,
  overrideView,
  pageOf,
  resourceScheduleView,
  resourceView,
  roleView,
  serviceView,
  tenantView,
} from '@reservepro/contracts';
import { z } from 'zod';
import { ApiError } from './errors.js';

export interface ApiClientOptions {
  /** Por defecto `/api/v1` (mismo origen: en desarrollo, el proxy de Vite; en producción, el balanceador). */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Se invoca cuando la sesión no pudo recuperarse (refresh fallido): el panel debe ir al login. */
  onAuthLost?: () => void;
  /** Valida cada respuesta con el esquema del contrato (detecta divergencias API/cliente). Por defecto true. */
  validateResponses?: boolean;
}

/** Parámetros comunes de los listados paginados del catálogo. */
export type ListQuery = {
  cursor?: string;
  limit?: number;
  q?: string;
  isActive?: boolean;
};

/** Codifica un id o fecha para usarlo como segmento de ruta (nunca se concatena crudo). */
const seg = (v: string): string => encodeURIComponent(v);

interface RequestOptions<T> {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** false en endpoints públicos: no envía el token ni intenta refrescar ante un 401. */
  auth?: boolean;
  schema?: z.ZodType<T>;
  csrf?: boolean;
  /** Cabeceras extra (p. ej. `Idempotency-Key`). Nunca para el token: lo gestiona el cliente. */
  headers?: Record<string, string>;
}

/**
 * Cliente HTTP de la API.
 *  - El access token vive SOLO en memoria (nunca en localStorage: un XSS no podría robarlo de ahí).
 *  - El refresh token es una cookie HttpOnly que el navegador envía solo (`credentials: 'include'`).
 *  - Ante un 401 intenta UN refresh (con exclusión mutua: N peticiones simultáneas => 1 solo refresh) y reintenta.
 */
export class ApiClient {
  private accessToken: string | null = null;
  private refreshing: Promise<boolean> | null = null;
  private readonly base: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: ApiClientOptions = {}) {
    this.base = (options.baseUrl ?? '/api/v1').replace(/\/$/, '');
    this.doFetch = options.fetch ?? ((...a) => fetch(...a));
  }

  get isAuthenticated(): boolean {
    return this.accessToken !== null;
  }
  setAccessToken(token: string | null): void {
    this.accessToken = token;
  }

  // ---------------------------------------------------------------------------------------------
  // Núcleo
  // ---------------------------------------------------------------------------------------------
  async request<T>(method: string, path: string, opts: RequestOptions<T> = {}): Promise<T> {
    const auth = opts.auth ?? true;
    const res = await this.send(method, path, opts, auth);
    if (res.status === 401 && auth && (await this.refreshSession())) {
      return this.parse(await this.send(method, path, opts, auth), opts.schema);
    }
    if (res.status === 401 && auth) this.options.onAuthLost?.();
    return this.parse(res, opts.schema);
  }

  private async send(
    method: string,
    path: string,
    opts: RequestOptions<unknown>,
    auth: boolean,
  ): Promise<Response> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {}))
      if (v !== undefined) qs.set(k, String(v));
    const url = `${this.base}${path}${qs.size > 0 ? `?${qs}` : ''}`;

    const headers: Record<string, string> = { ...opts.headers, accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (auth && this.accessToken) headers['authorization'] = `Bearer ${this.accessToken}`;
    if (opts.csrf) headers['x-rp-csrf'] = '1'; // fuerza preflight CORS: otro sitio no puede enviarla

    try {
      return await this.doFetch(url, {
        method,
        headers,
        credentials: 'include',
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR', 'No se pudo conectar con el servidor');
    }
  }

  private async parse<T>(res: Response, schema?: z.ZodType<T>): Promise<T> {
    if (res.status === 204) return undefined as T;
    const retryAfter = res.headers.get('retry-after');
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // Respuesta no JSON (p.ej. HTML de un proxy 502): se informa sin exponer su contenido.
      throw new ApiError(
        res.status,
        'UNKNOWN',
        `Respuesta inesperada del servidor (${res.status})`,
      );
    }
    if (!res.ok) {
      throw ApiError.fromProblem(
        res.status,
        (json ?? {}) as Record<string, never>,
        retryAfter ? Number(retryAfter) : undefined,
      );
    }
    if (schema && (this.options.validateResponses ?? true)) {
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        throw new ApiError(
          res.status,
          'INVALID_RESPONSE',
          'La respuesta no cumple el contrato esperado',
        );
      }
      return parsed.data;
    }
    return json as T;
  }

  /** Un solo refresh a la vez; todas las peticiones en vuelo esperan el mismo resultado. */
  private refreshSession(): Promise<boolean> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<boolean> {
    try {
      const auth = await this.request('POST', '/auth/refresh', {
        auth: false,
        csrf: true,
        schema: authResponse,
      });
      this.accessToken = auth.accessToken;
      return true;
    } catch {
      this.accessToken = null;
      return false;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------------------------
  private async authenticated(p: Promise<AuthResponse>): Promise<AuthResponse> {
    const r = await p;
    this.accessToken = r.accessToken;
    return r;
  }

  register = (body: RegisterRequest) =>
    this.authenticated(
      this.request('POST', '/auth/register', { body, auth: false, schema: authResponse }),
    );
  login = (body: LoginRequest) =>
    this.authenticated(
      this.request('POST', '/auth/login', { body, auth: false, schema: authResponse }),
    );
  /** Restaura la sesión al abrir la app (usa la cookie). Devuelve null si no hay sesión. */
  async restoreSession(): Promise<AuthResponse | null> {
    try {
      return await this.authenticated(
        this.request('POST', '/auth/refresh', { auth: false, csrf: true, schema: authResponse }),
      );
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return null;
      throw e;
    }
  }
  switchTenant = (tenantId: string) =>
    this.authenticated(
      this.request('POST', '/auth/switch-tenant', { body: { tenantId }, schema: authResponse }),
    );
  async logout(): Promise<void> {
    try {
      await this.request('POST', '/auth/logout', { auth: false, csrf: true });
    } finally {
      this.accessToken = null;
    }
  }
  forgotPassword = (body: ForgotPasswordRequest) =>
    this.request<void>('POST', '/auth/forgot-password', { body, auth: false });
  resetPassword = (body: ResetPasswordRequest) =>
    this.request<void>('POST', '/auth/reset-password', { body, auth: false });
  changePassword = (body: ChangePasswordRequest) =>
    this.request<void>('POST', '/auth/change-password', { body });
  verifyEmail = (token: string) =>
    this.request<void>('POST', '/auth/verify-email', { body: { token }, auth: false });
  resendVerification = () => this.request<void>('POST', '/auth/resend-verification');
  me = () => this.request('GET', '/me', { schema: meResponse });

  // ---------------------------------------------------------------------------------------------
  // Empresa, miembros e invitaciones
  // ---------------------------------------------------------------------------------------------
  getTenant = () => this.request('GET', '/tenants/current', { schema: tenantView });
  updateTenant = (body: UpdateTenantRequest) =>
    this.request('PATCH', '/tenants/current', { body, schema: tenantView });

  listMembers = (q: { cursor?: string; limit?: number } = {}) =>
    this.request('GET', '/tenants/current/members', { query: q, schema: pageOf(memberView) });
  updateMember = (id: string, body: UpdateMemberRequest) =>
    this.request('PATCH', `/tenants/current/members/${encodeURIComponent(id)}`, {
      body,
      schema: memberView,
    });
  listRoles = () => this.request('GET', '/tenants/current/roles', { schema: z.array(roleView) });

  createInvitation = (body: CreateInvitationRequest) =>
    this.request('POST', '/tenants/current/invitations', {
      body,
      schema: createInvitationResponse,
    });
  listInvitations = () =>
    this.request('GET', '/tenants/current/invitations', { schema: z.array(invitationView) });
  resendInvitation = (id: string) =>
    this.request('POST', `/tenants/current/invitations/${encodeURIComponent(id)}/resend`, {
      schema: createInvitationResponse,
    });
  revokeInvitation = (id: string) =>
    this.request<void>('DELETE', `/tenants/current/invitations/${encodeURIComponent(id)}`);

  previewInvitation = (token: string) =>
    this.request('POST', '/invitations/preview', {
      body: { token },
      auth: false,
      schema: invitationPreview,
    });
  async acceptInvitation(body: AcceptInvitationRequest) {
    const r = await this.request('POST', '/invitations/accept', {
      body,
      auth: false,
      schema: acceptInvitationResponse,
    });
    if (r.auth) this.accessToken = r.auth.accessToken;
    return r;
  }

  listAuditLogs = (
    q: {
      cursor?: string;
      limit?: number;
      action?: string;
      entityType?: string;
      entityId?: string;
      actorId?: string;
      from?: string;
      to?: string;
    } = {},
  ) =>
    this.request('GET', '/tenants/current/audit-logs', { query: q, schema: pageOf(auditLogView) });

  // ---------------------------------------------------------------------------------------------
  // Catálogo: sucursales, categorías, servicios y recursos
  // ---------------------------------------------------------------------------------------------
  listLocations = (q: ListQuery = {}) =>
    this.request('GET', '/locations', { query: q, schema: pageOf(locationView) });
  getLocation = (id: string) =>
    this.request('GET', `/locations/${seg(id)}`, { schema: locationView });
  createLocation = (body: CreateLocationRequest) =>
    this.request('POST', '/locations', { body, schema: locationView });
  updateLocation = (id: string, body: UpdateLocationRequest) =>
    this.request('PATCH', `/locations/${seg(id)}`, { body, schema: locationView });
  deleteLocation = (id: string) => this.request<void>('DELETE', `/locations/${seg(id)}`);

  listCategories = (q: ListQuery = {}) =>
    this.request('GET', '/service-categories', { query: q, schema: pageOf(categoryView) });
  createCategory = (body: CreateCategoryRequest) =>
    this.request('POST', '/service-categories', { body, schema: categoryView });
  updateCategory = (id: string, body: UpdateCategoryRequest) =>
    this.request('PATCH', `/service-categories/${seg(id)}`, { body, schema: categoryView });
  deleteCategory = (id: string) => this.request<void>('DELETE', `/service-categories/${seg(id)}`);

  listServices = (q: ServiceListQuery | ListQuery = {}) =>
    this.request('GET', '/services', { query: q, schema: pageOf(serviceView) });
  getService = (id: string) => this.request('GET', `/services/${seg(id)}`, { schema: serviceView });
  createService = (body: CreateServiceRequest) =>
    this.request('POST', '/services', { body, schema: serviceView });
  updateService = (id: string, body: UpdateServiceRequest) =>
    this.request('PATCH', `/services/${seg(id)}`, { body, schema: serviceView });
  deleteService = (id: string) => this.request<void>('DELETE', `/services/${seg(id)}`);
  setServiceLocations = (id: string, body: SetServiceLocationsRequest) =>
    this.request('PUT', `/services/${seg(id)}/locations`, { body, schema: serviceView });
  setServiceResources = (id: string, body: SetServiceResourcesRequest) =>
    this.request('PUT', `/services/${seg(id)}/resources`, { body, schema: serviceView });

  listResources = (q: ResourceListQuery | ListQuery = {}) =>
    this.request('GET', '/resources', { query: q, schema: pageOf(resourceView) });
  getResource = (id: string) =>
    this.request('GET', `/resources/${seg(id)}`, { schema: resourceView });
  createResource = (body: CreateResourceRequest) =>
    this.request('POST', '/resources', { body, schema: resourceView });
  updateResource = (id: string, body: UpdateResourceRequest) =>
    this.request('PATCH', `/resources/${seg(id)}`, { body, schema: resourceView });
  deleteResource = (id: string) => this.request<void>('DELETE', `/resources/${seg(id)}`);

  // ---------------------------------------------------------------------------------------------
  // Agenda: horarios, excepciones, feriados, bloqueos y calendario
  // ---------------------------------------------------------------------------------------------
  getBusinessHours = (locationId: string) =>
    this.request('GET', `/locations/${seg(locationId)}/business-hours`, {
      schema: businessHoursView,
    });
  setBusinessHours = (locationId: string, body: SetBusinessHoursRequest) =>
    this.request('PUT', `/locations/${seg(locationId)}/business-hours`, {
      body,
      schema: businessHoursView,
    });
  getResourceSchedule = (resourceId: string) =>
    this.request('GET', `/resources/${seg(resourceId)}/schedule`, { schema: resourceScheduleView });
  setResourceSchedule = (resourceId: string, body: SetResourceScheduleRequest) =>
    this.request('PUT', `/resources/${seg(resourceId)}/schedule`, {
      body,
      schema: resourceScheduleView,
    });

  listOverrides = (
    scope: 'locations' | 'resources',
    id: string,
    range: { from: string; to: string },
  ) =>
    this.request('GET', `/${scope}/${seg(id)}/overrides`, {
      query: range,
      schema: z.array(overrideView),
    });
  putOverride = (
    scope: 'locations' | 'resources',
    id: string,
    date: string,
    body: PutOverrideRequest,
  ) =>
    this.request('PUT', `/${scope}/${seg(id)}/overrides/${seg(date)}`, {
      body,
      schema: overrideView,
    });
  deleteOverride = (scope: 'locations' | 'resources', id: string, date: string) =>
    this.request<void>('DELETE', `/${scope}/${seg(id)}/overrides/${seg(date)}`);

  listHolidays = (year: number) =>
    this.request('GET', '/holidays', { query: { year }, schema: z.array(holidayView) });
  putHoliday = (date: string, body: PutHolidayRequest) =>
    this.request('PUT', `/holidays/${seg(date)}`, { body, schema: holidayView });
  deleteHoliday = (date: string) => this.request<void>('DELETE', `/holidays/${seg(date)}`);

  listBlocks = (
    q: {
      cursor?: string;
      limit?: number;
      resourceId?: string;
      locationId?: string;
      from?: string;
      to?: string;
    } = {},
  ) => this.request('GET', '/blocks', { query: q, schema: pageOf(blockView) });
  createBlocks = (body: CreateBlocksRequest) =>
    this.request('POST', '/blocks', { body, schema: z.array(blockView) });
  updateBlock = (id: string, body: UpdateBlockRequest) =>
    this.request('PATCH', `/blocks/${seg(id)}`, { body, schema: blockView });
  deleteBlock = (id: string) => this.request<void>('DELETE', `/blocks/${seg(id)}`);

  getCalendar = (q: CalendarQuery) =>
    this.request('GET', '/calendar', { query: q, schema: calendarResponse });

  // ---------------------------------------------------------------------------------------------
  // Clientes, disponibilidad y reservas
  // ---------------------------------------------------------------------------------------------
  listCustomers = (q: Partial<CustomerListQuery> = {}) =>
    this.request('GET', '/customers', { query: q, schema: pageOf(customerView) });
  getCustomer = (id: string) =>
    this.request('GET', `/customers/${seg(id)}`, { schema: customerView });
  createCustomer = (body: CreateCustomerRequest) =>
    this.request('POST', '/customers', { body, schema: customerView });
  updateCustomer = (id: string, body: UpdateCustomerRequest) =>
    this.request('PATCH', `/customers/${seg(id)}`, { body, schema: customerView });

  getAvailability = (
    q: Partial<AvailabilityQuery> & Pick<AvailabilityQuery, 'serviceId' | 'locationId' | 'from'>,
  ) => this.request('GET', '/availability', { query: q, schema: availabilityResponse });

  listReservations = (q: Partial<ReservationListQuery> = {}) =>
    this.request('GET', '/reservations', { query: q, schema: pageOf(reservationView) });
  getReservation = (id: string) =>
    this.request('GET', `/reservations/${seg(id)}`, { schema: reservationView });
  listReservationEvents = (id: string) =>
    this.request('GET', `/reservations/${seg(id)}/events`, {
      schema: z.array(reservationEventView),
    });
  /**
   * `idempotencyKey`: generarla UNA vez por intención de reservar y REUTILIZARLA al reintentar (error de red,
   * doble clic). Así un reintento devuelve la misma reserva en vez de crear otra.
   */
  createReservation = (body: CreateReservationRequest, idempotencyKey: string) =>
    this.request('POST', '/reservations', {
      body,
      schema: reservationView,
      headers: { 'idempotency-key': idempotencyKey },
    });
  confirmReservation = (id: string, version: number) =>
    this.request('POST', `/reservations/${seg(id)}/confirm`, {
      body: { version },
      schema: reservationView,
    });
  cancelReservation = (id: string, body: CancelReservationRequest) =>
    this.request('POST', `/reservations/${seg(id)}/cancel`, { body, schema: reservationView });
  changeReservationStatus = (id: string, body: ChangeStatusRequest) =>
    this.request('POST', `/reservations/${seg(id)}/status`, { body, schema: reservationView });
  rescheduleReservation = (id: string, body: RescheduleReservationRequest) =>
    this.request('POST', `/reservations/${seg(id)}/reschedule`, {
      body,
      schema: reservationView,
    });
}
