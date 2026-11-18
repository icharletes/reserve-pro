import { config } from 'dotenv';
import { defaultMigrationsDir, recreateTestDatabase } from '@reservepro/database/testing';

/** Base de datos propia de las pruebas e2e de la API (distinta de la del paquete database). */
export const API_TEST_DB = 'reservepro_api_test';

export default async function setup(): Promise<void> {
  config({ path: new URL('../../../.env', import.meta.url).pathname, quiet: true });
  const urls = await recreateTestDatabase(API_TEST_DB, defaultMigrationsDir());
  // Las pruebas construyen la app con estas URLs (rp_app para el runtime, rp_system para tareas de sistema).
  process.env['DATABASE_URL'] = urls.app;
  process.env['DATABASE_URL_SYSTEM'] = urls.system;
  process.env['DATABASE_URL_OWNER'] = urls.owner;
}
