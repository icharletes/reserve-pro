import { z } from 'zod';

const DEV_SECRET_MARKER = 'dev-only';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    /** Rol rp_app: sujeto a RLS. Es la única conexión que usan las requests de tenant. */
    DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatoria'),
    /** Rol rp_system (BYPASSRLS): solo tareas de sistema. Opcional hasta que existan. */
    DATABASE_URL_SYSTEM: z.string().optional(),
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET debe tener al menos 32 caracteres'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    /** Redis: rate limiting y colas. Si falta, el rate limiting usa memoria local (solo válido con UNA instancia). */
    REDIS_URL: z.string().optional(),
    RATE_LIMIT_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
    /** Peticiones por minuto y por IP para TODA la API (red de seguridad general). */
    RATE_LIMIT_GLOBAL_PER_MIN: z.coerce.number().int().min(10).default(300),
    /** Saltos de proxy confiables para leer la IP real (X-Forwarded-For). 0 = ninguno (conexión directa). */
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
    /** Publica /api/v1/openapi.json. Por defecto solo fuera de producción. */
    OPENAPI_ENABLED: z.enum(['true', 'false']).optional().transform((v) => (v === undefined ? undefined : v === 'true')),
    /** Prefijo de las colas BullMQ en Redis: aísla entornos y pruebas que comparten el mismo Redis. */
    QUEUE_PREFIX: z.string().regex(/^[A-Za-z0-9:_-]+$/).optional(),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    MAIL_FROM: z.string().default('ReservePro <no-reply@reservepro.local>'),
    ADMIN_APP_URL: z.url().default('http://localhost:5173'),
    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
  })
  .refine((e) => !(e.NODE_ENV === 'production' && e.JWT_ACCESS_SECRET.includes(DEV_SECRET_MARKER)), {
    message: 'JWT_ACCESS_SECRET de desarrollo no puede usarse en producción',
    path: ['JWT_ACCESS_SECRET'],
  });

export type Env = z.infer<typeof schema>;

/** Valida el entorno al arrancar (fail-fast): una configuración inválida impide iniciar. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Configuración inválida:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
