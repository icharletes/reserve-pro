import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Module,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import {
  type CreatePublicReservationRequest,
  type ManageAvailabilityRequest,
  type ManageCancelRequest,
  type ManageLookupRequest,
  type ManageRescheduleRequest,
  type PublicAvailabilityQuery,
  type PublicServicesQuery,
  createPublicReservationRequest,
  createPublicReservationResponse,
  manageAvailabilityRequest,
  manageCancelRequest,
  manageLookupRequest,
  manageRescheduleRequest,
  publicAvailabilityQuery,
  publicAvailabilityResponse,
  publicReservationView,
  publicServiceView,
  publicServicesQuery,
  publicTenantView,
  tenantSlug,
} from '@reservepro/contracts';
import { ZodPipe } from '../../common/zod.pipe.js';
import {
  IdempotencyService,
  requireIdempotencyKey,
} from '../../platform/idempotency/idempotency.js';
import { ApiDoc } from '../../platform/openapi/api-doc.decorator.js';
import { RateLimit } from '../../platform/rate-limit/rate-limit.module.js';
import { Public } from '../../platform/rbac/authz.decorators.js';
import { AvailabilityService } from '../reservations/availability.js';
import { ReservationsService } from '../reservations/reservations.service.js';
import { PublicService } from './public.service.js';

const slugParam = new ZodPipe(tenantSlug);
const NOT_FOUND = 'El negocio no existe, no está activo o no tiene reservas en línea';
const LINK = 'Enlace inválido, vencido o revocado (LINK_INVALID; siempre la misma respuesta)';

/**
 * Portal público de reservas (ADR-015). Rutas bajo `/public/tenants/:slug` (no `/public/:slug`: un slug como
 * "manage" chocaría con las rutas de gestión) y `/public/manage/*`, donde el token va SIEMPRE en el cuerpo.
 */
@Controller('public')
export class PublicController {
  constructor(private readonly portal: PublicService) {}

  @Public()
  @RateLimit({ name: 'public-read', limit: 120, windowSec: 60, by: 'ip' })
  @ApiDoc({
    summary: 'Datos públicos de un negocio',
    description:
      'Nombre, zona horaria, moneda, sucursales con reservas en línea y políticas de cancelación.',
    response: publicTenantView,
    errors: { 404: NOT_FOUND },
  })
  @Get('tenants/:slug')
  tenant(@Param('slug', slugParam) slug: string) {
    return this.portal.tenant(slug);
  }

  @Public()
  @RateLimit({ name: 'public-read', limit: 120, windowSec: 60, by: 'ip' })
  @ApiDoc({
    summary: 'Servicios reservables en línea de una sucursal',
    response: z.array(publicServiceView),
    errors: { 404: `${NOT_FOUND}, o la sucursal no existe` },
  })
  @Get('tenants/:slug/services')
  services(
    @Param('slug', slugParam) slug: string,
    @Query(new ZodPipe(publicServicesQuery)) q: PublicServicesQuery,
  ) {
    return this.portal.services(slug, q.locationId);
  }

  @Public()
  @RateLimit({ name: 'public-availability', limit: 60, windowSec: 60, by: 'ip' })
  @ApiDoc({
    summary: 'Horarios disponibles (portal)',
    description:
      'Como la disponibilidad del panel, pero con la antelación mínima y máxima de los canales públicos y solo recursos reservables en línea. Máximo 7 días por consulta.',
    response: publicAvailabilityResponse,
    errors: { 400: 'El servicio no se ofrece en esa sucursal', 404: NOT_FOUND },
  })
  @Get('tenants/:slug/availability')
  availability(
    @Param('slug', slugParam) slug: string,
    @Query(new ZodPipe(publicAvailabilityQuery)) q: PublicAvailabilityQuery,
  ) {
    return this.portal.availability(slug, q);
  }

  @Public()
  @RateLimit(
    { name: 'public-book-ip', limit: 10, windowSec: 600, by: 'ip' },
    { name: 'public-book-phone', limit: 5, windowSec: 3600, by: 'phone' },
  )
  @ApiDoc({
    summary: 'Reservar (portal)',
    description:
      'Exige `Idempotency-Key`. Devuelve la reserva y `manageToken`, el secreto del enlace de gestión: se muestra una sola vez y debe ' +
      'guardarse solo en el fragmento de la URL (`#token=…`). Repetir la petición con la misma clave devuelve la misma reserva con un enlace nuevo. ' +
      'Según la configuración del negocio, la reserva queda confirmada o pendiente (retenida hasta `holdExpiresAt`).',
    response: createPublicReservationResponse,
    errors: {
      400: 'Datos inválidos o falta Idempotency-Key',
      404: NOT_FOUND,
      409: 'Horario no disponible (SLOT_UNAVAILABLE) o demasiadas reservas activas para ese teléfono (LIMIT_REACHED)',
      422: 'Fuera de la antelación permitida, o Idempotency-Key reutilizada con otros datos',
    },
  })
  @Post('tenants/:slug/reservations')
  @HttpCode(201)
  async create(
    @Param('slug', slugParam) slug: string,
    @Body(new ZodPipe(createPublicReservationRequest)) body: CreatePublicReservationRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const out = await this.portal.create(slug, body, requireIdempotencyKey(key));
    if (out.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.setHeader('Cache-Control', 'no-store'); // la respuesta lleva un secreto
    return out.body;
  }

  @Public()
  @RateLimit({ name: 'public-manage-read', limit: 30, windowSec: 60, by: 'ip' })
  @ApiDoc({
    summary: 'Ver mi reserva (enlace de gestión)',
    description:
      'El token va en el cuerpo, nunca en la URL. Incluye qué acciones permite hoy la política del negocio.',
    response: publicReservationView,
    errors: { 400: LINK },
  })
  @Post('manage/lookup')
  @HttpCode(200)
  lookup(@Body(new ZodPipe(manageLookupRequest)) body: ManageLookupRequest) {
    return this.portal.lookup(body.token);
  }

  @Public()
  @RateLimit({ name: 'public-manage-read', limit: 30, windowSec: 60, by: 'ip' })
  @ApiDoc({
    summary: 'Horarios para cambiar mi reserva',
    description: 'Mismo profesional/recurso; la propia reserva no cuenta como ocupada.',
    response: publicAvailabilityResponse,
    errors: { 400: LINK },
  })
  @Post('manage/availability')
  @HttpCode(200)
  manageAvailability(
    @Body(new ZodPipe(manageAvailabilityRequest)) body: ManageAvailabilityRequest,
  ) {
    return this.portal.manageAvailability(body);
  }

  @Public()
  @RateLimit({ name: 'public-manage-write', limit: 10, windowSec: 600, by: 'ip' })
  @ApiDoc({
    summary: 'Cancelar mi reserva',
    response: publicReservationView,
    errors: {
      400: LINK,
      409: 'Fuera de plazo o no permitido por el negocio (POLICY_VIOLATION), ya cancelada (INVALID_TRANSITION) o cambió (VERSION_CONFLICT)',
    },
  })
  @Post('manage/cancel')
  @HttpCode(200)
  cancel(@Body(new ZodPipe(manageCancelRequest)) body: ManageCancelRequest) {
    return this.portal.cancel(body);
  }

  @Public()
  @RateLimit({ name: 'public-manage-write', limit: 10, windowSec: 600, by: 'ip' })
  @ApiDoc({
    summary: 'Cambiar el horario de mi reserva',
    description: 'Conserva servicio, duración, precio y profesional.',
    response: publicReservationView,
    errors: {
      400: LINK,
      409: 'Horario no disponible, fuera de plazo o máximo de cambios alcanzado, o la reserva cambió',
      422: 'Fuera de la antelación permitida',
    },
  })
  @Post('manage/reschedule')
  @HttpCode(200)
  reschedule(@Body(new ZodPipe(manageRescheduleRequest)) body: ManageRescheduleRequest) {
    return this.portal.reschedule(body);
  }
}

@Module({
  controllers: [PublicController],
  providers: [PublicService, ReservationsService, AvailabilityService, IdempotencyService],
})
export class PublicModule {}
