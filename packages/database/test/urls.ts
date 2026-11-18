import { config } from 'dotenv';

config({ path: new URL('../../../.env', import.meta.url).pathname, quiet: true });

const TEST_DB = 'reservepro_test';

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

function need(name: string): string {
  const v = process.env[name];
  if (!v)
    throw new Error(`Falta ${name}. Copia .env.example a .env y levanta Docker (pnpm db:up).`);
  return v;
}

/** URLs de la base de pruebas, derivadas de las del entorno local (mismos roles, otra base). */
export function testUrls() {
  return {
    /** Conexión administrativa a la base `postgres` (para crear/borrar la base de pruebas). */
    admin: withDb(need('DATABASE_URL_OWNER'), 'postgres'),
    owner: withDb(need('DATABASE_URL_OWNER'), TEST_DB),
    app: withDb(need('DATABASE_URL'), TEST_DB),
    system: withDb(need('DATABASE_URL_SYSTEM'), TEST_DB),
    dbName: TEST_DB,
  };
}
