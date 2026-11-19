import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { type PrismaClient, createSystemClient } from '@reservepro/database';
import { AppConfig } from '../../config/app-config.js';

/**
 * Conexión con el rol `rp_system` (BYPASSRLS). SOLO en el worker y SOLO para DESCUBRIR trabajo entre empresas
 * (qué empresas tienen retenciones vencidas) o borrar filas técnicas vencidas. El trabajo de negocio en sí
 * se hace después con `TenantDb.run({ tenantId })`, es decir, con RLS, igual que una request.
 */
@Injectable()
export class SystemDb implements OnModuleDestroy {
  private instance: PrismaClient | undefined;

  constructor(private readonly config: AppConfig) {}

  get client(): PrismaClient {
    const url = this.config.env.DATABASE_URL_SYSTEM;
    if (!url) throw new Error('El worker requiere DATABASE_URL_SYSTEM (rol rp_system)');
    this.instance ??= createSystemClient(url, { max: 2 });
    return this.instance;
  }

  async onModuleDestroy(): Promise<void> {
    await this.instance?.$disconnect();
  }
}
