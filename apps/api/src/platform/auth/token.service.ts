import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import { AppConfig } from '../../config/app-config.js';
import { Errors } from '../../common/errors.js';

const ISSUER = 'reservepro';
const AUDIENCE = 'reservepro-api';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export interface AccessClaims {
  /** user id */
  sub: string;
  /** session id (familia de refresh tokens) */
  sid: string;
  /** tenant activo; ausente si el usuario aún no eligió empresa */
  tid?: string;
  /** membership id en el tenant activo */
  mid?: string;
}

@Injectable()
export class TokenService {
  private readonly key: Uint8Array;
  readonly accessTtlSeconds: number;
  readonly refreshTtlMs: number;

  constructor(config: AppConfig) {
    this.key = new TextEncoder().encode(config.env.JWT_ACCESS_SECRET);
    this.accessTtlSeconds = config.env.ACCESS_TOKEN_TTL_SECONDS;
    this.refreshTtlMs = config.env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
  }

  signAccess(claims: AccessClaims): Promise<string> {
    return new SignJWT({
      sid: claims.sid,
      ...(claims.tid ? { tid: claims.tid, mid: claims.mid } : {}),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.accessTtlSeconds}s`)
      .sign(this.key);
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    try {
      // `algorithms` fijo: evita ataques de confusión de algoritmo (alg=none, RS/HS).
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      });
      const { sub, sid, tid, mid } = payload as Record<string, unknown>;
      if (!isUuid(sub) || !isUuid(sid)) throw new Error('claims incompletos');
      if ((tid !== undefined) !== (mid !== undefined)) throw new Error('tid/mid inconsistentes');
      // Todos los ids deben ser UUID: así jamás llegan basura ni cadenas arbitrarias a una consulta.
      if (tid !== undefined && (!isUuid(tid) || !isUuid(mid))) throw new Error('tid/mid inválidos');
      return {
        sub,
        sid,
        ...(typeof tid === 'string' ? { tid } : {}),
        ...(typeof mid === 'string' ? { mid } : {}),
      };
    } catch {
      throw Errors.tokenInvalid();
    }
  }

  /** Token opaco de 256 bits. En la BD solo se guarda su SHA-256. */
  generateRefreshToken(): { token: string; hash: Uint8Array<ArrayBuffer> } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: TokenService.hashRefreshToken(token) };
  }

  /** Devuelve `Uint8Array<ArrayBuffer>` (lo que Prisma espera para columnas `bytea`). */
  static hashRefreshToken(token: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(createHash('sha256').update(token).digest());
  }
}
