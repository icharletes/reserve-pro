import type { Tx } from '@reservepro/database';
import { uuidv7 } from '../../common/ids.js';
import { generateOneTimeToken } from '../../common/tokens.js';
import type { BookingSettings } from '../reservations/booking-context.js';

export type Scope = 'view' | 'cancel' | 'reschedule';

/** Alcances del enlace según lo que la empresa permite autogestionar. */
export function allScopes(s: BookingSettings): Scope[] {
  const a = (s.self_service_actions ?? {}) as Record<string, unknown>;
  return [
    'view',
    ...(a['cancel'] !== false ? (['cancel'] as const) : []),
    ...(a['reschedule'] !== false ? (['reschedule'] as const) : []),
  ];
}

/**
 * Emite un enlace de gestión NUEVO para una reserva (ADR-015): 256 bits, en la BD solo su hash, vence cuando la
 * reserva termina. Devuelve el secreto: quien llama lo entrega UNA vez (respuesta al reservar, o un email).
 */
export async function issueAccessToken(
  tx: Tx,
  tenantId: string,
  reservationId: string,
  settings: BookingSettings,
): Promise<string> {
  const r = await tx.reservations.findFirstOrThrow({
    where: { id: reservationId },
    select: { end_at: true },
  });
  const { token, hash } = generateOneTimeToken();
  await tx.reservation_access_tokens.create({
    data: {
      id: uuidv7(),
      tenant_id: tenantId,
      reservation_id: reservationId,
      token_hash: hash,
      scopes: allScopes(settings),
      expires_at: r.end_at,
    },
  });
  return token;
}

export const manageUrl = (portalUrl: string, token: string): string =>
  `${portalUrl.replace(/\/$/, '')}/mi-reserva#token=${token}`;
