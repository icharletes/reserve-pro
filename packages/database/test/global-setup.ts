import { defaultMigrationsDir, recreateTestDatabase } from '../src/testing.js';
import { testUrls } from './urls.js';

/** Recrea `reservepro_test` y aplica TODAS las migraciones SQL (ver src/testing.ts). */
export default async function setup(): Promise<void> {
  await recreateTestDatabase(testUrls().dbName, defaultMigrationsDir());
}
