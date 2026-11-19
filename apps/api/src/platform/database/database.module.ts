import { Global, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  type PrismaClient,
  type TenantContext,
  type Tx,
  createPrismaClient,
  withTenant,
  withUser,
} from '@reservepro/database';
import { AppConfig } from '../../config/app-config.js';
import { Errors } from '../../common/errors.js';

/** Dueño del pool de conexiones del rol `rp_app` (sujeto a RLS). */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(config: AppConfig) {
    this.client = createPrismaClient(config.env.DATABASE_URL);
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}

/**
 * ÚNICA vía para consultar datos de negocio. Toda consulta corre en una transacción con el contexto
 * de tenant fijado en PostgreSQL (RLS). Ver ADR-004.
 */
@Injectable()
export class TenantDb {
  constructor(
    private readonly database: DatabaseService,
    private readonly cls: ClsService,
  ) {}

  /** Contexto explícito (login, registro, guards). */
  run<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.database.client, ctx, fn);
  }

  /** Solo contexto de usuario: lista las empresas y membresías propias (sin tenant activo). */
  asUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withUser(this.database.client, userId, fn);
  }

  /** Contexto del principal autenticado de la request actual. */
  runAsPrincipal<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const p = this.cls.get('principal');
    if (!p) throw Errors.unauthenticated();
    if (!p.tenantId) throw Errors.tenantRequired();
    // Solo tenantId (mínimo privilegio): con tenant activo NO se habilitan las lecturas "propias" entre empresas.
    return withTenant(this.database.client, { tenantId: p.tenantId }, fn);
  }

  /** Empresa activa del principal (para rellenar `tenant_id` al crear filas; RLS lo vuelve a exigir). */
  get tenantId(): string {
    const p = this.cls.get('principal');
    if (!p) throw Errors.unauthenticated();
    if (!p.tenantId) throw Errors.tenantRequired();
    return p.tenantId;
  }

  /** Membresía del principal en la empresa activa (autoría informativa de registros). */
  get membershipId(): string | null {
    return this.cls.get('principal')?.membershipId ?? null;
  }

  /**
   * Cliente SIN contexto de tenant. Solo para tablas globales sin RLS (users, refresh_tokens,
   * permissions, reserved_slugs). Sobre tablas de tenant devuelve 0 filas (RLS falla cerrado).
   */
  get global(): PrismaClient {
    return this.database.client;
  }
}

@Global()
@Module({
  providers: [DatabaseService, TenantDb],
  exports: [DatabaseService, TenantDb],
})
export class DatabaseModule {}
