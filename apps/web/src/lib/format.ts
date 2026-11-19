/**
 * Formato de fechas, horas y dinero del portal. Siempre en la zona horaria del NEGOCIO (la de la sucursal), no la
 * del visitante: quien reserva desde otro país ve la hora a la que tiene que presentarse.
 */

const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(timezone: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timezone}|${JSON.stringify(opts)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('es-CL', { timeZone: timezone, ...opts });
    cache.set(key, f);
  }
  return f;
}

/** 'HH:MM' (24 h) en la zona indicada. */
export function formatTime(iso: string, timezone: string): string {
  const parts = fmt(timezone, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}

/** 'lunes 7 de diciembre' en la zona indicada. */
export function formatLongDate(iso: string, timezone: string): string {
  return fmt(timezone, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));
}

/** Fecha de calendario 'YYYY-MM-DD' -> 'lun 7 dic' (sin zona: es una fecha, no un instante). */
export function formatShortDay(date: string): string {
  return fmt('UTC', { weekday: 'short', day: 'numeric', month: 'short' })
    .format(new Date(`${date}T12:00:00Z`))
    .replace(/\./g, '');
}

/** Fecha local 'YYYY-MM-DD' de un instante en la zona indicada. */
export function localDate(at: Date, timezone: string): string {
  const p = fmt(timezone, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const ZERO_DECIMAL = new Set(['CLP', 'PYG', 'JPY', 'KRW']);

/** Precio decimal en texto ('15000.00') con separadores locales, sin pasar por coma flotante. */
export function formatMoney(amount: string, currency: string): string {
  const [int = '0', dec = '00'] = amount.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return ZERO_DECIMAL.has(currency) && /^0*$/.test(dec)
    ? `$${grouped}`
    : `$${grouped},${dec.padEnd(2, '0').slice(0, 2)} ${currency}`;
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Dirección de una sucursal (objeto libre del panel) en una línea. */
export function formatAddress(a: Record<string, unknown>): string {
  return ['line1', 'line2', 'city', 'region']
    .map((k) => a[k])
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .join(', ');
}

/** Lee el token del fragmento `#token=…` (el fragmento nunca se envía al servidor ni aparece en Referer). */
export function tokenFromHash(hash: string): string | null {
  const m = /(?:^#|&)token=([A-Za-z0-9_-]{43})(?:&|$)/.exec(hash);
  return m ? m[1]! : null;
}
