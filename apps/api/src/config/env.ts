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
