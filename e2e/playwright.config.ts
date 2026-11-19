import { defineConfig, devices } from '@playwright/test';
import { config } from 'dotenv';

config({ path: new URL('../.env', import.meta.url).pathname, quiet: true });

const withDb = (url: string | undefined, db: string) => {
  if (!url) throw new Error('Falta la URL de la base de datos en .env (copia .env.example)');
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};
const DB = 'reservepro_e2e_test'; // la recrea prepare.mjs antes de cada ejecución
const API_PORT = 3100; // distintos de los de desarrollo: se puede probar con el entorno local levantado
const PORTAL_PORT = 4400;
export const API_BASE = `http://localhost:${API_PORT}/api/v1`;
/** Solo para preparar casos que el panel aún no permite configurar (p. ej. plazos de cancelación). */
export const OWNER_DB_URL = withDb(process.env['DATABASE_URL_OWNER'], DB);

/**
 * Navegador: en CI, el Chromium de Playwright; en local, el Chrome instalado (Playwright ya no publica Chromium
 * para macOS 13). `E2E_CHANNEL` permite elegir otro.
 */
const channel = process.env['CI'] ? undefined : (process.env['E2E_CHANNEL'] ?? 'chrome');

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  timeout: 60_000,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORTAL_PORT}`,
    locale: 'es-CL',
    timezoneId: 'Europe/Madrid', // a propósito distinta: el portal debe mostrar la hora del NEGOCIO
    trace: 'retain-on-failure',
    ...(channel ? { channel } : {}),
  },
  projects: [
    { name: 'escritorio', use: { ...devices['Desktop Chrome'], ...(channel ? { channel } : {}) } },
    { name: 'movil', use: { ...devices['Pixel 7'], ...(channel ? { channel } : {}) } },
  ],
  webServer: [
    {
      name: 'api',
      command: 'node dist/main.js',
      cwd: '../apps/api',
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...(process.env as Record<string, string>),
        NODE_ENV: 'test',
        API_PORT: String(API_PORT),
        DATABASE_URL: withDb(process.env['DATABASE_URL'], DB),
        DATABASE_URL_SYSTEM: withDb(process.env['DATABASE_URL_SYSTEM'], DB),
        RATE_LIMIT_ENABLED: 'false', // el rate limit se prueba en la suite de la API
        LOG_LEVEL: 'warn',
        CORS_ORIGINS: `http://localhost:${PORTAL_PORT}`,
      },
    },
    {
      name: 'portal',
      command: 'node serve-portal.mjs',
      url: `http://localhost:${PORTAL_PORT}/`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...(process.env as Record<string, string>),
        PORTAL_PORT: String(PORTAL_PORT),
        API_URL: `http://localhost:${API_PORT}`,
      },
    },
  ],
});
