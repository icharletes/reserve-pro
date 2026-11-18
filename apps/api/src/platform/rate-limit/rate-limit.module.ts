import { createHash } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  Global,
  Inject,
  Injectable,
  Module,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Logger } from 'pino';
import { AppConfig } from '../../config/app-config.js';
import { Errors } from '../../common/errors.js';
import type { AuthedRequest } from '../auth/principal.js';
import { LOGGER } from '../logging/logger.js';
import { RedisModule, RedisService } from '../redis/redis.module.js';

export type RateLimitBy = 'ip' | 'ip+email' | 'email' | 'user' | 'tenant';

export interface RateLimitRule {
  /** Nombre estable de la regla (forma parte de la clave). */
  name: string;
  limit: number;
  windowSec: number;
  by: RateLimitBy;
}

const RATE_LIMIT_KEY = 'reservepro:ratelimit';

/** Reglas por endpoint. Se evalúan ADEMÁS de la regla global por IP. */
export const RateLimit = (...rules: RateLimitRule[]) => SetMetadata(RATE_LIMIT_KEY, rules);

const PRE_AUTH: RateLimitBy[] = ['ip', 'ip+email', 'email'];
const POST_AUTH: RateLimitBy[] = ['user', 'tenant'];

/** Ventana fija atómica: INCR + PEXPIRE en un solo paso (sin carrera entre ambos). */
const LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {c, redis.call('PTTL', KEYS[1])}
`;

@Injectable()
export class RateLimitService {
  private readonly memory = new Map<string, { count: number; resetAt: number }>();
  private readonly prefix: string;

  constructor(
    private readonly redis: RedisService,
    private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    // El prefijo aísla entornos/pruebas que comparten el mismo Redis.
    this.prefix = `rl:${config.env.NODE_ENV}`;
  }

  get enabled(): boolean {
    return this.config.env.RATE_LIMIT_ENABLED;
  }

  /** Registra un intento. Lanza 429 con Retry-After si se supera el límite. */
  async consume(rule: RateLimitRule, req: AuthedRequest): Promise<void> {
    const identity = this.identity(rule.by, req);
    // Se hashea la identidad: Redis nunca guarda emails ni IPs en claro.
    const key = `${this.prefix}:${rule.name}:${rule.by}:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
    const windowMs = rule.windowSec * 1000;

    const { count, ttlMs } = await this.hit(key, windowMs);
    if (count > rule.limit) throw Errors.rateLimited(Math.max(1, Math.ceil(ttlMs / 1000)));
  }

  private identity(by: RateLimitBy, req: AuthedRequest): string {
    const ip = req.ip ?? 'unknown';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : '';
    switch (by) {
      case 'ip':
        return ip;
      case 'email':
        return email || ip; // sin email en el cuerpo se limita por IP
      case 'ip+email':
        return `${ip}|${email}`;
      case 'user':
        return req.principal?.userId ?? ip;
      case 'tenant':
        return req.principal?.tenantId ?? ip;
    }
  }

  private async hit(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }> {
    const client = this.redis.client;
    if (!client) return this.hitMemory(key, windowMs);
    try {
      const [count, ttl] = (await client.eval(LUA, 1, key, String(windowMs))) as [number, number];
      return { count, ttlMs: ttl > 0 ? ttl : windowMs };
    } catch (err) {
      // Si Redis cae se DEJA PASAR (fail-open): preferimos disponibilidad a bloquear a todos los usuarios.
      // Queda registrado para alertar; las defensas por cuenta (bloqueo de login) siguen activas.
      this.logger.error({ err: (err as Error).message }, 'rate limit: Redis no disponible, se omite el límite');
      return { count: 0, ttlMs: windowMs };
    }
  }

  private hitMemory(key: string, windowMs: number): { count: number; ttlMs: number } {
    const now = Date.now();
    const entry = this.memory.get(key);
    if (!entry || entry.resetAt <= now) {
      this.memory.set(key, { count: 1, resetAt: now + windowMs });
      if (this.memory.size > 10_000) this.sweep(now);
      return { count: 1, ttlMs: windowMs };
    }
    entry.count++;
    return { count: entry.count, ttlMs: entry.resetAt - now };
  }

  private sweep(now: number): void {
    for (const [k, v] of this.memory) if (v.resetAt <= now) this.memory.delete(k);
  }
}

abstract class BaseRateLimitGuard implements CanActivate {
  constructor(
    protected readonly reflector: Reflector,
    protected readonly service: RateLimitService,
    protected readonly config: AppConfig,
  ) {}
  protected abstract readonly phase: 'pre' | 'post';

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.service.enabled) return true;
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const declared = this.reflector.getAllAndOverride<RateLimitRule[] | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? [];

    const allowed = this.phase === 'pre' ? PRE_AUTH : POST_AUTH;
    const rules = declared.filter((r) => allowed.includes(r.by));
    if (this.phase === 'pre') {
      rules.unshift({ name: 'global', limit: this.config.env.RATE_LIMIT_GLOBAL_PER_MIN, windowSec: 60, by: 'ip' });
    }
    for (const rule of rules) await this.service.consume(rule, req);
    return true;
  }
}

/** Antes de autenticar: por IP / email. Barato (Redis) y protege la base de datos de las inundaciones. */
@Injectable()
export class PreAuthRateLimitGuard extends BaseRateLimitGuard {
  protected readonly phase = 'pre' as const;
  constructor(reflector: Reflector, service: RateLimitService, config: AppConfig) {
    super(reflector, service, config);
  }
}

/** Después de autenticar: por usuario / empresa. */
@Injectable()
export class PostAuthRateLimitGuard extends BaseRateLimitGuard {
  protected readonly phase = 'post' as const;
  constructor(reflector: Reflector, service: RateLimitService, config: AppConfig) {
    super(reflector, service, config);
  }
}

@Global()
@Module({
  imports: [RedisModule],
  providers: [RateLimitService, PreAuthRateLimitGuard, PostAuthRateLimitGuard],
  exports: [RateLimitService, PreAuthRateLimitGuard, PostAuthRateLimitGuard],
})
export class RateLimitModule {}
