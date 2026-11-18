import {
  type AcceptInvitationRequest,
  type AuthResponse,
  type ChangePasswordRequest,
  type CreateInvitationRequest,
  type ForgotPasswordRequest,
  type LoginRequest,
  type RegisterRequest,
  type ResetPasswordRequest,
  type UpdateMemberRequest,
  type UpdateTenantRequest,
  acceptInvitationResponse,
  auditLogView,
  authResponse,
  createInvitationResponse,
  invitationPreview,
  invitationView,
  meResponse,
  memberView,
  pageOf,
  roleView,
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

interface RequestOptions<T> {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** false en endpoints públicos: no envía el token ni intenta refrescar ante un 401. */
  auth?: boolean;
  schema?: z.ZodType<T>;
  csrf?: boolean;
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

    const headers: Record<string, string> = { accept: 'application/json' };
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
}
