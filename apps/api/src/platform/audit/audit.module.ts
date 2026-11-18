import { Global, Injectable, Module } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Prisma, Tx } from '@reservepro/database';
import { uuidv7 } from '../../common/ids.js';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  /** Por defecto, el tenant del principal. Obligatorio si no hay principal (registro). */
  tenantId?: string;
  actorType?: 'user' | 'customer' | 'system' | 'whatsapp' | 'platform_admin';
  actorId?: string;
}

/**
 * Registra auditoría DENTRO de la misma transacción que el cambio de negocio: si la operación se
 * revierte, la auditoría también; si se confirma, la auditoría siempre existe. La tabla es append-only.
 * Quien llama es responsable de no incluir secretos en before/after.
 */
@Injectable()
export class AuditService {
  constructor(private readonly cls: ClsService) {}

  async record(tx: Tx, entry: AuditEntry): Promise<void> {
    const principal = this.cls.get('principal');
    const tenantId = entry.tenantId ?? principal?.tenantId ?? undefined;
    if (!tenantId) throw new Error('AuditService.record: falta tenantId (acciones de plataforma usan rp_system)');

    await tx.audit_logs.create({
      data: {
        id: uuidv7(),
        tenant_id: tenantId,
        actor_type: entry.actorType ?? 'user',
        actor_id: entry.actorId ?? principal?.userId ?? null,
        action: entry.action,
        entity_type: entry.entityType,
        entity_id: entry.entityId ?? null,
        before: entry.before ?? undefined,
        after: entry.after ?? undefined,
        request_id: this.cls.getId() ?? null,
        ip: this.cls.get('ip') ?? null,
      },
    });
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
