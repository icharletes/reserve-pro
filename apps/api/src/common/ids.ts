import { randomBytes } from 'node:crypto';

/**
 * UUIDv7 (RFC 9562): 48 bits de timestamp en ms + aleatorio. Al ser ordenable por tiempo mejora la
 * localidad de los índices B-tree frente a UUIDv4 en tablas que crecen mucho (reservas, auditoría).
 */
export function uuidv7(now: number = Date.now()): string {
  const b = Buffer.alloc(16);
  b.writeUIntBE(now, 0, 6);
  randomBytes(10).copy(b, 6);
  b[6] = (b[6]! & 0x0f) | 0x70; // versión 7
  b[8] = (b[8]! & 0x3f) | 0x80; // variante RFC 4122
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
