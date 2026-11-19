import { Body, Controller, Get, Injectable, Patch } from '@nestjs/common';
import {
  type TenantSettingsView,
  type UpdateTenantSettingsRequest,
  tenantSettingsView,
  updateTenantSettingsRequest,
} from '@reservepro/contracts';
import type { Prisma, Tx } from '@reservepro/database';
import { ZodPipe } from '../../common/zod.pipe.js';
import { AuditService } from '../../platform/audit/audit.module.js';
import { TenantDb } from '../../platform/database/database.module.js';
import { ApiDoc } from '../../platform/openapi/api-doc.decorator.js';
import { RequirePermissions } from '../../platform/rbac/authz.decorators.js';

type Row = Prisma.tenant_settingsGetPayload<object>;

const actions = (r: Row) => (r.self_service_actions ?? {}) as Record<string, unknown>;

const toView = (r: Row): TenantSettingsView => ({
  publicBookingEnabled: r.public_booking_enabled,
  bookingMinNoticeMinutes: r.booking_min_notice_minutes,
  bookingMaxAdvanceDays: r.booking_max_advance_days,
  slotStepMinutes: r.slot_step_minutes as TenantSettingsView['slotStepMinutes'],
  autoConfirm: r.auto_confirm,
  pendingHoldMinutes: r.pending_hold_minutes,
  selfServiceCancel: actions(r)['cancel'] !== false,
  cancelWindowHours: r.cancel_window_hours,
  cancelRequiresApproval: r.cancel_requires_approval,
  selfServiceReschedule: actions(r)['reschedule'] !== false,
  rescheduleWindowHours: r.reschedule_window_hours,
  maxReschedules: r.max_reschedules,
  maxActivePublicPerCustomer: r.max_active_public_per_customer,
  customerEmailsEnabled: r.customer_emails_enabled,
  reminderHoursBefore: r.reminder_hours_before,
  updatedAt: r.updated_at.toISOString(),
});

/**
 * Configuración de reservas y comunicaciones de la empresa. Es la que leen el motor, el portal y el worker
 * (`loadSettings`): un cambio aplica a la siguiente operación, sin reiniciar nada. Auditada con antes/después.
 */
@Injectable()
export class TenantSettingsService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  /** La fila se crea al registrar la empresa; si faltara (datos antiguos), se crea con los valores por defecto. */
  private async row(tx: Tx): Promise<Row> {
    return (
      (await tx.tenant_settings.findFirst()) ??
      tx.tenant_settings.create({ data: { tenant_id: this.tdb.tenantId } })
    );
  }

  get(): Promise<TenantSettingsView> {
    return this.tdb.runAsPrincipal(async (tx) => toView(await this.row(tx)));
  }

  update(dto: UpdateTenantSettingsRequest): Promise<TenantSettingsView> {
    return this.tdb.runAsPrincipal(async (tx) => {
      const before = await this.row(tx);
      const merged = { ...actions(before) };
      if (dto.selfServiceCancel !== undefined) merged['cancel'] = dto.selfServiceCancel;
      if (dto.selfServiceReschedule !== undefined) merged['reschedule'] = dto.selfServiceReschedule;
      const map: Record<string, keyof Row> = {
        publicBookingEnabled: 'public_booking_enabled',
        bookingMinNoticeMinutes: 'booking_min_notice_minutes',
        bookingMaxAdvanceDays: 'booking_max_advance_days',
        slotStepMinutes: 'slot_step_minutes',
        autoConfirm: 'auto_confirm',
        pendingHoldMinutes: 'pending_hold_minutes',
        cancelWindowHours: 'cancel_window_hours',
        cancelRequiresApproval: 'cancel_requires_approval',
        rescheduleWindowHours: 'reschedule_window_hours',
        maxReschedules: 'max_reschedules',
        maxActivePublicPerCustomer: 'max_active_public_per_customer',
        customerEmailsEnabled: 'customer_emails_enabled',
        reminderHoursBefore: 'reminder_hours_before',
      };
      const data: Record<string, unknown> = {};
      for (const [k, col] of Object.entries(map)) {
        const v = (dto as Record<string, unknown>)[k];
        if (v !== undefined) data[col] = v;
      }
      if (dto.selfServiceCancel !== undefined || dto.selfServiceReschedule !== undefined) {
        data['self_service_actions'] = merged as Prisma.InputJsonValue;
      }
      const after = await tx.tenant_settings.update({
        where: { tenant_id: before.tenant_id },
        data: { ...data, updated_at: new Date() } as Prisma.tenant_settingsUpdateInput,
      });
      await this.audit.record(tx, {
        action: 'tenant.settings_updated',
        entityType: 'tenant_settings',
        entityId: before.tenant_id,
        before: toView(before) as unknown as Prisma.InputJsonValue,
        after: toView(after) as unknown as Prisma.InputJsonValue,
      });
      return toView(after);
    });
  }
}

@Controller('tenants/current/settings')
export class TenantSettingsController {
  constructor(private readonly settings: TenantSettingsService) {}

  @ApiDoc({
    summary: 'Configuración de reservas y comunicaciones',
    description:
      'Portal, antelación, confirmación, políticas de autogestión, recordatorios y emails.',
    response: tenantSettingsView,
  })
  @RequirePermissions('tenant:read')
  @Get()
  get() {
    return this.settings.get();
  }

  @ApiDoc({
    summary: 'Editar la configuración',
    description:
      'Actualización parcial: lo que no se envía no cambia. Aplica a la siguiente operación.',
    response: tenantSettingsView,
  })
  @RequirePermissions('tenant:update')
  @Patch()
  update(@Body(new ZodPipe(updateTenantSettingsRequest)) body: UpdateTenantSettingsRequest) {
    return this.settings.update(body);
  }
}
