import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { testUrls } from './urls.js';

/**
 * Recrea la base `reservepro_test` y aplica TODAS las migraciones SQL en orden.
 * Reproduce exactamente lo que ocurre en producción (mismos archivos, mismo rol dueño).
 */
export default async function setup(): Promise<void> {
  const urls = testUrls();

  const admin = new pg.Client({ connectionString: urls.admin });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `No se pudo conectar a PostgreSQL (${(err as Error).message}). ¿Docker está corriendo? Ejecuta: pnpm db:up`,
    );
  }
  await admin.query(`DROP DATABASE IF EXISTS ${urls.dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${urls.dbName}`);
  await admin.end();

  const owner = new pg.Client({ connectionString: urls.owner });
  await owner.connect();
  // Mismos privilegios que docker/postgres/init (son por base de datos).
  await owner.query(`
    GRANT USAGE ON SCHEMA public TO rp_app, rp_system;
    ALTER DEFAULT PRIVILEGES FOR ROLE rp_owner IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rp_app, rp_system;
  `);

  const dir = join(import.meta.dirname, '..', 'prisma', 'migrations');
  const migrations = readdirSync(dir)
    .filter((d) => statSync(join(dir, d)).isDirectory())
    .sort();
  for (const m of migrations) {
    await owner.query(readFileSync(join(dir, m, 'migration.sql'), 'utf8'));
  }
  await owner.end();
}
