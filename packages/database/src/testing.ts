import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

/**
 * Utilidades SOLO para pruebas (subpath `@reservepro/database/testing`).
 * Recrean una base de datos aparte y aplican las migraciones SQL reales con el rol dueño,
 * de modo que las pruebas corren contra el mismo esquema, RLS y roles que producción.
 */

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta ${name}. Copia .env.example a .env y levanta Docker (pnpm db:up).`);
  return v;
}

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

export interface TestDatabaseUrls {
  admin: string;
  owner: string;
  app: string;
  system: string;
  dbName: string;
}

export function testDatabaseUrls(dbName: string): TestDatabaseUrls {
  return {
    admin: withDb(need('DATABASE_URL_OWNER'), 'postgres'),
    owner: withDb(need('DATABASE_URL_OWNER'), dbName),
    app: withDb(need('DATABASE_URL'), dbName),
    system: withDb(need('DATABASE_URL_SYSTEM'), dbName),
    dbName,
  };
}

/** Borra y recrea `dbName`, y aplica todas las migraciones en orden. */
export async function recreateTestDatabase(dbName: string, migrationsDir: string): Promise<TestDatabaseUrls> {
  if (!/^[a-z_][a-z0-9_]*$/.test(dbName) || !dbName.endsWith('_test')) {
    // Evita borrar por error una base real: el nombre debe terminar en _test.
    throw new Error(`Nombre de base de pruebas inválido: ${dbName}`);
  }
  const urls = testDatabaseUrls(dbName);

  const admin = new pg.Client({ connectionString: urls.admin });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `No se pudo conectar a PostgreSQL (${(err as Error).message}). ¿Docker está corriendo? Ejecuta: pnpm db:up`,
    );
  }
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const owner = new pg.Client({ connectionString: urls.owner });
  await owner.connect();
  // Mismos privilegios que docker/postgres/init (son por base de datos).
  await owner.query(`
    GRANT USAGE ON SCHEMA public TO rp_app, rp_system;
    ALTER DEFAULT PRIVILEGES FOR ROLE rp_owner IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rp_app, rp_system;
  `);
  const migrations = readdirSync(migrationsDir)
    .filter((d) => statSync(join(migrationsDir, d)).isDirectory())
    .sort();
  for (const m of migrations) {
    await owner.query(readFileSync(join(migrationsDir, m, 'migration.sql'), 'utf8'));
  }
  await owner.end();
  return urls;
}

/** Ruta de las migraciones del paquete, resuelta desde este archivo (src/ o dist/). */
export function defaultMigrationsDir(): string {
  return join(import.meta.dirname, '..', 'prisma', 'migrations');
}
