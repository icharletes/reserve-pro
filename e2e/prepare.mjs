// Base de datos PROPIA de las pruebas e2e (nunca la de desarrollo ni la de las otras suites).
import { defaultMigrationsDir, recreateTestDatabase } from '@reservepro/database/testing';

export const E2E_DB = 'reservepro_e2e_test';
await recreateTestDatabase(E2E_DB, defaultMigrationsDir());
process.stdout.write(`base ${E2E_DB} recreada con todas las migraciones\n`);
