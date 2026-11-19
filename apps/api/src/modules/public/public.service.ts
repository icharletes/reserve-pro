import { isIP } from 'node:net';
import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type {
  CreatePublicReservationRequest,
  CreatePublicReservationResponse,
  ManageAvailabilityRequest,
  ManageCancelRequest,
  ManageRescheduleRequest,
  PublicAvailabilityQuery,
  PublicReservationView,
  PublicServiceView,
  PublicTenantView,
  AvailabilityResponse,
} from '@reservepro/contracts';
import type { Tx } from '@reservepro/database';
import { Errors } from '../../common/errors.js';
import { uuidv7 } from '../../common/ids.js';
import { hashOneTimeToken } from '../../common/tokens.js';
import { type Scope, allScopes, issueAccessToken } from './access-tokens.js';
import { TenantDb } from '../../platform/database/database.module.js';
import type { Actor } from '../reservations/actor.js';
import { AvailabilityService } from '../reservations/availability.js';
import { type BookingSettings, loadSettings } from '../reservations/booking-context.js';
import {
  type ReservationRow,
  ReservationsService,
  reservationInclude,
} from '../reservations/reservations.service.js';

const HOUR = 3_600_000;
/** Versión del texto de privacidad que ve quien reserva (apps/web BookingFlow). Cambiarla si cambia el texto. */
export const CONSENT_TEXT_VERSION = 'portal-2026-11';

const customerActor = (tenantId: string, reservationId?: string): Actor => ({
  tenantId,
  source: 'public_web',
  type: 'customer',
  userId: null,
  membershipId: null,
  // Con un token, el cliente solo "ve" SU reserva: cualquier otro id da 404.
  scope: reservationId ? { id: reservationId } : {},
});

const actions = (s: BookingSettings) => {
  const a = (s.self_service_actions ?? {}) as Record<string, unknown>;
  return { cancel: a['cancel'] !== false, reschedule: a['reschedule'] !== false };
};

/** Qué puede hacer el cliente AHORA con su reserva. La misma función decide lo que se muestra y lo que se permite. */
export function selfServicePolicy(
  r: { status: string; start_at: Date; reschedule_count: number },
  settings: BookingSettings,
  scopes: readonly string[],
  now: Date = new Date(),
): { canCancel: boolean; canReschedule: boolean; note: string | null } {
  if (r.status !== 'pending' && r.status !== 'confirmed') {
    return { canCancel: false, canReschedule: false, note: null };
  }
  const left = r.start_at.getTime() - now.getTime();
  const act = actions(settings);
  const notes: string[] = [];

  let canCancel = scopes.includes('cancel') && act.cancel;
  if (canCancel && settings.cancel_requires_approval) {
    canCancel = false;
    notes.push('Para cancelar, contacta al negocio.');
  } else if (canCancel && left < settings.cancel_window_hours * HOUR) {
    canCancel = false;
    notes.push(
      `Las cancelaciones en línea se aceptan hasta ${settings.cancel_window_hours} h antes. Contacta al negocio.`,
    );
  }
  let canReschedule = scopes.includes('reschedule') && act.reschedule;
  if (canReschedule && r.reschedule_count >= settings.max_reschedules) {
    canReschedule = false;
    notes.push('Esta reserva ya alcanzó el máximo de cambios de horario.');
  } else if (canReschedule && left < settings.reschedule_window_hours * HOUR) {
    canReschedule = false;
    notes.push(
      `Los cambios de horario en línea se aceptan hasta ${settings.reschedule_window_hours} h antes.`,
    );
  }
  return { canCancel, canReschedule, note: notes.length ? notes.join(' ') : null };
}

/**
 * Portal público (ADR-015). Sin sesión: la empresa sale del slug o del token, y cada operación corre con RLS
 * fijado a esa empresa. Las reservas usan el MISMO motor que el panel (`ReservationsService.*As`).
 */
@Injectable()
export class PublicService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly reservations: ReservationsService,
    private readonly availabilityService: AvailabilityService,
    private readonly cls: ClsService,
  ) {}

  /**
   * Evidencia del consentimiento para mensajes TRANSACCIONALES de esta reserva (confirmación, cambios,
   * recordatorio) por los canales que la persona dio. Historial append-only: versión del texto mostrado e IP.
   * Marketing nunca se asume (requeriría una casilla explícita, fuera del MVP).
   */
  private async recordConsent(
    tx: Tx,
    tenantId: string,
    reservationId: string,
    dto: CreatePublicReservationRequest,
  ): Promise<void> {
    const r = await tx.reservations.findFirstOrThrow({
      where: { id: reservationId },
      select: { customer_id: true },
    });
    const ip = this.cls.get<string | undefined>('ip');
    const channels = ['whatsapp', ...(dto.customer.email ? ['email'] : [])];
    await tx.notification_consents.createMany({
      data: channels.map((channel) => ({
        id: uuidv7(),
        tenant_id: tenantId,
        customer_id: r.customer_id,
        channel,
        purpose: 'transactional',
        status: 'granted',
        source: 'public_web',
        evidence_version: CONSENT_TEXT_VERSION,
        evidence_ip: ip && isIP(ip) ? ip : null,
      })),
    });
  }

  // --- empresa ------------------------------------------------------------------------------------------------

  /** Empresa activa con el portal habilitado; si no, 404 (igual que si no existiera: no se revela nada). */
  private async tenantBySlug(slug: string): Promise<string> {
    const rows = await this.tdb.global.$queryRaw<
      { id: string; status: string }[]
    >`SELECT id, status FROM rp_resolve_tenant_by_slug(${slug})`;
    const t = rows[0];
    if (!t || t.status !== 'active') throw Errors.notFound('Negocio');
    const settings = await this.tdb.run({ tenantId: t.id }, (tx) => loadSettings(tx));
    if (!settings.public_booking_enabled) throw Errors.notFound('Negocio');
    return t.id;
  }

  async tenant(slug: string): Promise<PublicTenantView> {
    const tenantId = await this.tenantBySlug(slug);
    return this.tdb.run({ tenantId }, async (tx) => {
      const t = await tx.tenants.findFirstOrThrow();
      const settings = await loadSettings(tx);
      // Solo sucursales que tienen algo reservable online.
      const locations = await tx.locations.findMany({
        where: {
          is_active: true,
          resources: { some: { is_active: true, is_bookable_online: true } },
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      });
      return {
        name: t.name,
        slug: t.slug,
        timezone: t.timezone,
        currency: t.currency,
        locations: locations.map((l) => ({
          id: l.id,
          name: l.name,
          address: (l.address ?? {}) as Record<string, unknown>,
          phone: l.phone,
          timezone: l.timezone ?? t.timezone,
        })),
        policies: {
          cancelWindowHours: settings.cancel_window_hours,
          rescheduleWindowHours: settings.reschedule_window_hours,
          maxReschedules: settings.max_reschedules,
        },
      };
    });
  }

  async services(slug: string, locationId: string): Promise<PublicServiceView[]> {
    const tenantId = await this.tenantBySlug(slug);
    return this.tdb.run({ tenantId }, async (tx) => {
      const location = await tx.locations.findFirst({ where: { id: locationId, is_active: true } });
      if (!location) throw Errors.notFound('Sucursal');
      const settings = await loadSettings(tx);
      const bookable = { location_id: locationId, is_active: true, is_bookable_online: true };
      const rows = await tx.services.findMany({
        where: {
          is_active: true,
          service_locations: { some: { location_id: locationId } },
          service_resources: { some: { resources: bookable } },
        },
        include: {
          service_categories: { select: { name: true } },
          service_resources: {
            where: { resources: bookable },
            select: { resources: { select: { id: true, name: true, sort_order: true } } },
          },
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      });
      return rows.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        categoryName: s.service_categories?.name ?? null,
        durationMinutes: s.duration_minutes,
        price: s.price.toFixed(2),
        currency: s.currency,
        imageUrl: s.image_url,
        requiresConfirmation: s.requires_confirmation ?? !settings.auto_confirm,
        resources: s.service_resources
          .map((r) => r.resources)
          .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
          .map((r) => ({ id: r.id, name: r.name })),
      }));
    });
  }

  async availability(slug: string, q: PublicAvailabilityQuery): Promise<AvailabilityResponse> {
    const tenantId = await this.tenantBySlug(slug);
    return this.availabilityService.get(q, { tenantId, source: 'public_web', onlineOnly: true });
  }

  // --- reservar ----------------------------------------------------------------------------------------------

  async create(
    slug: string,
    dto: CreatePublicReservationRequest,
    idempotencyKey: string,
  ): Promise<{ body: CreatePublicReservationResponse; replayed: boolean }> {
    const tenantId = await this.tenantBySlug(slug);
    const settings = await this.tdb.run({ tenantId }, (tx) => loadSettings(tx));
    const result = await this.reservations.createAs(
      customerActor(tenantId),
      {
        serviceId: dto.serviceId,
        locationId: dto.locationId,
        resourceId: dto.resourceId ?? null,
        startAt: dto.startAt,
        customer: {
          firstName: dto.customer.firstName,
          lastName: dto.customer.lastName ?? null,
          phoneE164: dto.customer.phoneE164,
          email: dto.customer.email ?? null,
        },
        customerNotes: dto.customerNotes ?? null,
      },
      idempotencyKey,
      {
        idempotencyScope: 'public.reservation.create',
        onlineOnly: true,
        maxActivePerCustomer: settings.max_active_public_per_customer,
        // En la MISMA transacción: el enlace de gestión. Al repetir la petición (replay) se emite uno NUEVO: el
        // anterior no se puede reconstruir porque en la BD solo está su hash.
        after: async (tx, reservationId, replayed) => {
          if (!replayed) await this.recordConsent(tx, tenantId, reservationId, dto);
          const token = await issueAccessToken(tx, tenantId, reservationId, settings);
          return { token, view: await this.view(tx, reservationId, settings, allScopes(settings)) };
        },
      },
    );
    return {
      body: { reservation: result.extra.view, manageToken: result.extra.token },
      replayed: result.replayed,
    };
  }

  private async view(
    tx: Tx,
    reservationId: string,
    settings: BookingSettings,
    scopes: readonly string[],
  ): Promise<PublicReservationView> {
    const r: ReservationRow = await tx.reservations.findFirstOrThrow({
      where: { id: reservationId },
      include: reservationInclude,
    });
    const tenant = await tx.tenants.findFirstOrThrow({ select: { name: true, slug: true } });
    const location = await tx.locations.findFirstOrThrow({ where: { id: r.location_id } });
    const resource = await tx.resources.findFirst({
      where: { id: r.reservation_resources[0]?.resource_id ?? '' },
      select: { name: true },
    });
    const item = r.reservation_items[0]!;
    const policy = selfServicePolicy(r, settings, scopes);
    return {
      code: r.code,
      status: r.status as PublicReservationView['status'],
      startAt: r.start_at.toISOString(),
      endAt: r.end_at.toISOString(),
      timeZone: r.time_zone,
      holdExpiresAt: r.hold_expires_at?.toISOString() ?? null,
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      serviceId: item.service_id,
      serviceName: item.service_name,
      durationMinutes: item.duration_minutes,
      totalAmount: r.total_amount.toFixed(2),
      currency: r.currency,
      locationId: location.id,
      locationName: location.name,
      locationAddress: (location.address ?? {}) as Record<string, unknown>,
      resourceName: resource?.name ?? '',
      version: r.version,
      canCancel: policy.canCancel,
      canReschedule: policy.canReschedule,
      policyNote: policy.note,
    };
  }

  // --- gestionar con el enlace ---------------------------------------------------------------------------------

  /**
   * Token -> empresa y reserva. Inexistente, vencido, revocado o de una empresa inactiva responden IGUAL
   * (400 LINK_INVALID): no se puede distinguir un token casi válido de uno inventado.
   */
  private async resolve(
    token: string,
  ): Promise<{ tenantId: string; reservationId: string; tokenId: string }> {
    const rows = await this.tdb.global.$queryRaw<
      { tenant_id: string; reservation_id: string; token_id: string }[]
    >`SELECT tenant_id, reservation_id, token_id FROM rp_resolve_reservation_token(${hashOneTimeToken(token)})`;
    const r = rows[0];
    if (!r) throw Errors.linkInvalid();
    return { tenantId: r.tenant_id, reservationId: r.reservation_id, tokenId: r.token_id };
  }

  private async scopesOf(tx: Tx, tokenId: string): Promise<Scope[]> {
    const t = await tx.reservation_access_tokens.update({
      where: { id: tokenId },
      data: { last_used_at: new Date() },
      select: { scopes: true },
    });
    return t.scopes as Scope[];
  }

  async lookup(token: string): Promise<PublicReservationView> {
    const ref = await this.resolve(token);
    return this.tdb.run({ tenantId: ref.tenantId }, async (tx) => {
      const scopes = await this.scopesOf(tx, ref.tokenId);
      return this.view(tx, ref.reservationId, await loadSettings(tx), scopes);
    });
  }

  async manageAvailability(dto: ManageAvailabilityRequest): Promise<AvailabilityResponse> {
    const ref = await this.resolve(dto.token);
    const r = await this.tdb.run({ tenantId: ref.tenantId }, (tx) =>
      tx.reservations.findFirstOrThrow({
        where: { id: ref.reservationId },
        include: reservationInclude,
      }),
    );
    // El cambio de horario conserva el profesional/recurso; la propia reserva no cuenta como ocupada.
    return this.availabilityService.get(
      {
        serviceId: r.reservation_items[0]!.service_id,
        locationId: r.location_id,
        from: dto.from,
        days: dto.days,
        resourceId: r.reservation_resources[0]!.resource_id,
      },
      { tenantId: ref.tenantId, source: 'public_web', excludeReservationId: r.id },
    );
  }

  /** Comprueba el alcance del token y la política vigente; si no se permite, 409 POLICY_VIOLATION. */
  private async assertAllowed(
    tx: Tx,
    ref: { tokenId: string },
    row: ReservationRow,
    what: 'cancel' | 'reschedule',
  ) {
    const scopes = await this.scopesOf(tx, ref.tokenId);
    const policy = selfServicePolicy(row, await loadSettings(tx), scopes);
    const ok = what === 'cancel' ? policy.canCancel : policy.canReschedule;
    if (!ok) {
      throw Errors.policyViolation(
        policy.note ??
          (what === 'cancel'
            ? 'Esta reserva ya no se puede cancelar en línea.'
            : 'Esta reserva ya no se puede cambiar de horario en línea.'),
      );
    }
  }

  async cancel(dto: ManageCancelRequest): Promise<PublicReservationView> {
    const ref = await this.resolve(dto.token);
    const actor = customerActor(ref.tenantId, ref.reservationId);
    // La política se comprueba en su propia transacción (lectura); la versión enviada protege del resto: si la
    // reserva cambió entre medio, el UPDATE con `version` falla y se responde 409.
    await this.tdb.run({ tenantId: ref.tenantId }, async (tx) => {
      const row = await tx.reservations.findFirst({
        where: { id: ref.reservationId },
        include: reservationInclude,
      });
      if (!row) throw Errors.linkInvalid();
      if (row.version !== dto.version) throw Errors.versionConflict();
      await this.assertAllowed(tx, ref, row, 'cancel');
    });
    await this.reservations.cancelAs(actor, ref.reservationId, dto.version, dto.reason ?? null);
    return this.lookup(dto.token);
  }

  async reschedule(dto: ManageRescheduleRequest): Promise<PublicReservationView> {
    const ref = await this.resolve(dto.token);
    await this.reservations.rescheduleAs(
      customerActor(ref.tenantId, ref.reservationId),
      ref.reservationId,
      dto.version,
      dto.startAt,
      undefined, // el cliente no cambia de profesional
      {
        // Aquí la política se comprueba DENTRO de la transacción de la reprogramación.
        guard: (row, tx) => this.assertAllowed(tx, ref, row, 'reschedule'),
        // El enlace vence con la reserva: si se mueve, también su vencimiento.
        after: async (tx, _row, _start, end) => {
          await tx.reservation_access_tokens.updateMany({
            where: { reservation_id: ref.reservationId, revoked_at: null },
            data: { expires_at: end },
          });
        },
      },
    );
    return this.lookup(dto.token);
  }
}
