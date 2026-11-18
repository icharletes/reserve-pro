import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';

/** Parámetros Argon2id recomendados por OWASP (m=19 MiB, t=2, p=1). */
const OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class PasswordService {
  /** Hash falso precalculado: permite igualar el tiempo de respuesta cuando el email no existe. */
  private dummyHash: Promise<string> | undefined;

  hash(plain: string): Promise<string> {
    return argon2.hash(plain, OPTIONS);
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false; // hash corrupto o formato desconocido: nunca autenticar
    }
  }

  /** Consume el mismo tiempo que una verificación real (mitiga enumeración de usuarios por timing). */
  async verifyDummy(plain: string): Promise<void> {
    this.dummyHash ??= argon2.hash('reservepro-dummy-password', OPTIONS);
    await argon2.verify(await this.dummyHash, plain).catch(() => false);
  }

  /** ¿El hash fue generado con parámetros más débiles que los actuales? (para re-hash transparente). */
  needsRehash(hash: string): boolean {
    return argon2.needsRehash(hash, OPTIONS);
  }
}
