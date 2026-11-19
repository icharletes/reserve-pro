import type { PermissionKey, ReservationStatusValue } from '@reservepro/contracts';
import { formatClock, localParts } from './schedule-format';

/**
 * Utilidades PURAS de las pantallas de reservas. La autoridad es el servidor: estas reglas solo deciden qué
 * botones mostrar; si divergieran, la API responde 409 y el panel muestra el mensaje.
 */

export const STATUS_LABELS: Record<ReservationStatusValue, string> = {
  pending: 'Pendiente',
  confirmed: 'Confirmada',
  in_progress: 'En curso',
  completed: 'Completada',
  cancelled: 'Cancelada',
  no_show: 'No asistió',
};
export const statusLabel = (s: string): string => STATUS_LABELS[s as ReservationStatusValue] ?? s;

/**
 * Copia de la máquina de estados de `@reservepro/booking-domain` (el panel no puede importar código de
 * servidor; ver eslint.config.mjs). Una prueba la compara con el código fuente del dominio.
 */
export const TRANSITIONS: Readonly<
  Record<ReservationStatusValue, readonly ReservationStatusValue[]>
> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['in_progress', 'completed', 'cancelled', 'no_show'],
  in_progress: ['completed'],
  completed: [],
  cancelled: [],
  no_show: [],
};

export type ReservationAction =
  'confirm' | 'cancel' | 'in_progress' | 'completed' | 'no_show' | 'reschedule';

/** Acciones que tiene sentido ofrecer para una reserva, según su estado, la hora y los permisos. */
export function availableActions(
  r: { status: string; startAt: string },
  can: (permission: PermissionKey) => boolean,
  now: Date = new Date(),
): ReservationAction[] {
  const next = TRANSITIONS[r.status as ReservationStatusValue] ?? [];
  const started = new Date(r.startAt).getTime() <= now.getTime();
  const out: ReservationAction[] = [];
  if (next.includes('confirmed') && can('reservations:confirm')) out.push('confirm');
  if ((r.status === 'pending' || r.status === 'confirmed') && can('reservations:reschedule'))
    out.push('reschedule');
  if (can('reservations:status')) {
    if (next.includes('in_progress')) out.push('in_progress');
    if (next.includes('completed')) out.push('completed');
    if (next.includes('no_show') && started) out.push('no_show');
  }
  if (next.includes('cancelled') && can('reservations:cancel')) out.push('cancel');
  return out;
}

const WD = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

/** 'lun 05/07/2027 09:00' en la zona horaria indicada (la de la sucursal, no la del navegador). */
export function formatLocalDateTime(iso: string, timezone: string): string {
  const { date, minute } = localParts(iso, timezone);
  const wd = WD[new Date(`${date}T00:00:00Z`).getUTCDay()];
  return `${wd} ${date.slice(8)}/${date.slice(5, 7)}/${date.slice(0, 4)} ${formatClock(minute)}`;
}

/**
 * Instante UTC de la medianoche local de `date` en `timezone` (para filtrar por "día de la sucursal").
 * Se corrige el desfase dos veces: basta incluso el día de un cambio de hora.
 */
export function zonedMidnight(date: string, timezone: string): Date {
  let t = Date.parse(`${date}T00:00:00Z`);
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(t).toISOString(), timezone);
    const shownAsUtc = Date.parse(`${p.date}T00:00:00Z`) + p.minute * 60_000;
    t -= shownAsUtc - Date.parse(`${date}T00:00:00Z`);
  }
  // Si las 00:00 no existen ese día (el reloj salta de 24:00 a 01:00), el cálculo cae en el día anterior:
  // el día empieza en el primer instante que ya tiene esa fecha local.
  const p = localParts(new Date(t).toISOString(), timezone);
  if (p.date < date) t += (1440 - p.minute) * 60_000;
  return new Date(t);
}

/** 'HH:MM' en la zona horaria indicada. */
export const formatLocalTime = (iso: string, timezone: string): string =>
  formatClock(localParts(iso, timezone).minute);

const PHONE_SEPARATORS = /[\s().-]/g;
const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * Teléfono a E.164 (+56912345678). Sin prefijo internacional se asume el del país por defecto. Devuelve null
 * si no parece un número válido (el servidor vuelve a validarlo).
 */
export function normalizePhone(input: string, defaultCountryCode = '56'): string | null {
  const raw = input.trim().replace(PHONE_SEPARATORS, '');
  if (raw === '') return null;
  let e164: string;
  if (raw.startsWith('+')) e164 = raw;
  else if (raw.startsWith('00')) e164 = `+${raw.slice(2)}`;
  else if (raw.startsWith(defaultCountryCode) && raw.length > defaultCountryCode.length + 8)
    e164 = `+${raw}`;
  else e164 = `+${defaultCountryCode}${raw.replace(/^0+/, '')}`;
  return E164.test(e164) ? e164 : null;
}

/** Identificador nuevo para `Idempotency-Key`: uno por INTENCIÓN de reservar, reutilizado en los reintentos. */
export const newIdempotencyKey = (): string => crypto.randomUUID();

export const customerName = (c: { firstName: string; lastName: string | null }): string =>
  [c.firstName, c.lastName].filter(Boolean).join(' ');

const ZERO_DECIMAL = new Set(['CLP', 'PYG', 'JPY', 'KRW']);

/** Precio decimal en texto ('15000.00') a formato local con moneda, sin pasar por coma flotante. */
export function formatMoney(amount: string, currency: string): string {
  const [int = '0', dec = '00'] = amount.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return ZERO_DECIMAL.has(currency) && /^0*$/.test(dec)
    ? `$${grouped} ${currency}`
    : `$${grouped},${dec.padEnd(2, '0').slice(0, 2)} ${currency}`;
}
