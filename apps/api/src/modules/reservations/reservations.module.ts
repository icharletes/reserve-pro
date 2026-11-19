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
  type CancelReservationRequest,
  type ChangeStatusRequest,
  type ConfirmReservationRequest,
  type CreateReservationRequest,
  type ReservationListQuery,
  type RescheduleReservationRequest,
  cancelReservationRequest,
  changeStatusRequest,
  confirmReservationRequest,
  createReservationRequest,
  pageOf,
  reservationEventView,
  reservationListQuery,
  reservationView,
  rescheduleReservationRequest,
  uuid,
} from '@reservepro/contracts';
import { ZodPipe } from '../../common/zod.pipe.js';
import {
  IdempotencyService,
  requireIdempotencyKey,
} from '../../platform/idempotency/idempotency.js';
import { ApiDoc } from '../../platform/openapi/api-doc.decorator.js';
import { RequireAnyPermission, RequirePermissions } from '../../platform/rbac/authz.decorators.js';
import { AvailabilityController, AvailabilityService } from './availability.js';
import { CustomersController, CustomersService } from './customers.js';
import { ReservationsService } from './reservations.service.js';

const idParam = new ZodPipe(uuid);
const VERSION_409 =
  'La reserva cambió mientras tanto (VERSION_CONFLICT) o la transición no está permitida (INVALID_TRANSITION)';

@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @ApiDoc({
    summary: 'Listar reservas',
    description:
      'Ordenadas por inicio. Filtros: rango `from`/`to` (inicio), estado, sucursal, recurso y cliente. ' +
      'Con solo `reservations:read:own` se ven únicamente las reservas del recurso vinculado al propio usuario.',
    response: pageOf(reservationView),
  })
  @RequireAnyPermission('reservations:read', 'reservations:read:own')
  @Get()
  list(@Query(new ZodPipe(reservationListQuery)) q: ReservationListQuery) {
    return this.reservations.list(q);
  }

  @ApiDoc({
    summary: 'Ver una reserva',
    response: reservationView,
    errors: { 404: 'Reserva no encontrada' },
  })
  @RequireAnyPermission('reservations:read', 'reservations:read:own')
  @Get(':id')
  get(@Param('id', idParam) id: string) {
    return this.reservations.get(id);
  }

  @ApiDoc({
    summary: 'Historial de una reserva',
    response: z.array(reservationEventView),
    errors: { 404: 'Reserva no encontrada' },
  })
  @RequireAnyPermission('reservations:read', 'reservations:read:own')
  @Get(':id/events')
  events(@Param('id', idParam) id: string) {
    return this.reservations.events(id);
  }

  @ApiDoc({
    summary: 'Crear una reserva',
    description:
      'Exige la cabecera `Idempotency-Key` (un identificador nuevo por intento, p. ej. un UUID): repetir la petición con la misma ' +
      'clave y el mismo cuerpo devuelve la MISMA reserva (cabecera `Idempotent-Replayed: true`) en vez de crear otra. ' +
      'Precio, duración y fin los calcula el servidor. Sin `resourceId`, se asigna automáticamente el recurso libre menos cargado.',
    response: reservationView,
    errors: {
      400: 'Datos inválidos, falta Idempotency-Key, o el servicio no se ofrece en esa sucursal',
      409: 'El horario no está disponible (SLOT_UNAVAILABLE) o la misma clave se está procesando',
      422: 'Fuera de la ventana de reserva, o Idempotency-Key reutilizada con otros datos',
    },
  })
  @RequirePermissions('reservations:create')
  @Post()
  @HttpCode(201)
  async create(
    @Body(new ZodPipe(createReservationRequest)) body: CreateReservationRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { view, replayed } = await this.reservations.create(body, requireIdempotencyKey(key));
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    return view;
  }

  @ApiDoc({
    summary: 'Confirmar una reserva pendiente',
    response: reservationView,
    errors: { 404: 'Reserva no encontrada', 409: VERSION_409 },
  })
  @RequirePermissions('reservations:confirm')
  @Post(':id/confirm')
  @HttpCode(200)
  confirm(
    @Param('id', idParam) id: string,
    @Body(new ZodPipe(confirmReservationRequest)) body: ConfirmReservationRequest,
  ) {
    return this.reservations.confirm(id, body.version);
  }

  @ApiDoc({
    summary: 'Cancelar una reserva',
    description: 'Libera el horario de inmediato (lo garantiza la base de datos).',
    response: reservationView,
    errors: { 404: 'Reserva no encontrada', 409: VERSION_409 },
  })
  @RequirePermissions('reservations:cancel')
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @Param('id', idParam) id: string,
    @Body(new ZodPipe(cancelReservationRequest)) body: CancelReservationRequest,
  ) {
    return this.reservations.cancel(id, body);
  }

  @ApiDoc({
    summary: 'Cambiar el estado (en curso, completada, no asistió)',
    response: reservationView,
    errors: { 404: 'Reserva no encontrada', 409: VERSION_409 },
  })
  @RequirePermissions('reservations:status')
  @Post(':id/status')
  @HttpCode(200)
  changeStatus(
    @Param('id', idParam) id: string,
    @Body(new ZodPipe(changeStatusRequest)) body: ChangeStatusRequest,
  ) {
    return this.reservations.changeStatus(id, body);
  }

  @ApiDoc({
    summary: 'Reprogramar una reserva',
    description:
      'Nuevo inicio y, opcionalmente, otro recurso. Conserva la duración y el precio reservados.',
    response: reservationView,
    errors: {
      400: 'El recurso no presta el servicio en esa sucursal',
      404: 'Reserva no encontrada',
      409: 'Horario no disponible, o la reserva cambió o no se puede reprogramar',
      422: 'Fuera de la ventana de reserva',
    },
  })
  @RequirePermissions('reservations:reschedule')
  @Post(':id/reschedule')
  @HttpCode(200)
  reschedule(
    @Param('id', idParam) id: string,
    @Body(new ZodPipe(rescheduleReservationRequest)) body: RescheduleReservationRequest,
  ) {
    return this.reservations.reschedule(id, body);
  }
}

@Module({
  controllers: [CustomersController, AvailabilityController, ReservationsController],
  providers: [CustomersService, AvailabilityService, ReservationsService, IdempotencyService],
})
export class ReservationsModule {}
