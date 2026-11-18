import { createHash, randomBytes } from 'node:crypto';

/**
 * Tokens de un solo uso (invitaciones, verificación de email, recuperación de contraseña):
 * 256 bits aleatorios; en la BD solo se guarda su SHA-256, así que una filtración de la tabla no
 * permite usarlos. `Uint8Array<ArrayBuffer>` es el tipo que Prisma espera para columnas `bytea`.
 */
export function generateOneTimeToken(): { token: string; hash: Uint8Array<ArrayBuffer> } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashOneTimeToken(token) };
}

export function hashOneTimeToken(token: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(createHash('sha256').update(token).digest());
}
