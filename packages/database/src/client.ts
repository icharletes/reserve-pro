import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.js';

export interface CreateClientOptions {
  /** Tamaño máximo del pool de conexiones. */
  max?: number;
}

/**
 * Crea un PrismaClient contra la URL indicada.
 *
 * IMPORTANTE (ADR-004): para tráfico de tenants se debe usar la URL del rol `rp_app`
 * (sujeto a RLS). Nunca usar el rol dueño (`rp_owner`) ni `rp_system` en el camino
 * de una request de tenant.
 */
export function createPrismaClient(connectionString: string, options: CreateClientOptions = {}): PrismaClient {
  if (!connectionString) {
    throw new Error('createPrismaClient: connectionString vacío (¿falta DATABASE_URL?)');
  }
  const adapter = new PrismaPg({ connectionString, max: options.max ?? 10 });
  return new PrismaClient({ adapter });
}

/**
 * Cliente del rol `rp_system` (BYPASSRLS). Solo para tareas acotadas cross-tenant:
 * publisher del outbox, resolución de webhooks por phone_number_id, expiración de holds
 * y consola SaaS. Está separado a propósito para que su uso sea visible en revisiones.
 */
export function createSystemClient(connectionString: string, options: CreateClientOptions = {}): PrismaClient {
  return createPrismaClient(connectionString, { max: options.max ?? 5 });
}
