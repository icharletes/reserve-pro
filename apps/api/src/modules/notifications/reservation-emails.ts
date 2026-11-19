import type { EmailMessage } from '../../platform/email/email.module.js';
import { escapeHtml } from '../../platform/email/templates.js';

/**
 * Emails al CLIENTE sobre su reserva (puros: sin BD ni red, probados aparte). Siempre en la hora del negocio.
 * Los textos que vienen de personas (nombres, servicio, dirección) se escapan en el HTML; el asunto se limpia
 * de saltos de línea (inyección de cabeceras).
 */

export type ReservationEmailKind =
  | 'created_confirmed'
  | 'created_pending'
  | 'confirmed'
  | 'rescheduled'
  | 'cancelled'
  | 'expired'
  | 'reminder';

export interface ReservationEmailData {
  to: string;
  kind: ReservationEmailKind;
  customerFirstName: string;
  tenantName: string;
  code: string;
  serviceName: string;
  resourceName: string;
  locationName: string;
  locationAddress: string;
  startAt: Date;
  endAt: Date;
  timeZone: string;
  /** Hasta cuándo se retiene una solicitud pendiente. */
  holdExpiresAt?: Date | null;
  /** Enlace "Mi reserva" (con el token en el fragmento). Ausente en cancelaciones y vencimientos. */
  manageUrl?: string | null;
  /** Política vigente, para explicarla en el email. */
  cancelWindowHours: number;
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

export function formatWhen(start: Date, end: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat('es-CL', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(start);
  const hm = (d: Date) =>
    new Intl.DateTimeFormat('es-CL', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(d);
  return `${day}, de ${hm(start)} a ${hm(end)} h`;
}

const hm = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat('es-CL', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);

interface Copy {
  subject: string;
  intro: string;
  closing?: string;
}

function copy(d: ReservationEmailData): Copy {
  const at = `${d.tenantName}`;
  switch (d.kind) {
    case 'created_confirmed':
      return { subject: `Reserva confirmada en ${at}`, intro: 'Tu reserva quedó confirmada.' };
    case 'created_pending':
      return {
        subject: `Recibimos tu solicitud en ${at}`,
        intro:
          `Recibimos tu solicitud de reserva. ${d.tenantName} debe confirmarla` +
          (d.holdExpiresAt
            ? `; te guardamos el horario hasta las ${hm(d.holdExpiresAt, d.timeZone)} h.`
            : '.') +
          ' Te avisaremos por este medio.',
      };
    case 'confirmed':
      return {
        subject: `${at} confirmó tu reserva`,
        intro: '¡Buenas noticias! Tu reserva fue confirmada.',
      };
    case 'rescheduled':
      return {
        subject: `Cambió el horario de tu reserva en ${at}`,
        intro: 'Tu reserva tiene un nuevo horario.',
      };
    case 'cancelled':
      return {
        subject: `Reserva cancelada en ${at}`,
        intro: 'Tu reserva fue cancelada y el horario quedó libre.',
        closing: 'Si no pediste esta cancelación, contacta directamente al negocio.',
      };
    case 'expired':
      return {
        subject: `No pudimos confirmar tu reserva en ${at}`,
        intro: `${d.tenantName} no alcanzó a confirmar tu solicitud a tiempo, así que liberamos el horario.`,
        closing: 'Puedes volver a reservar cuando quieras.',
      };
    case 'reminder':
      return {
        subject: `Recordatorio: tu reserva en ${at}`,
        intro: 'Te recordamos tu próxima reserva.',
      };
  }
}

export function renderReservationEmail(d: ReservationEmailData): EmailMessage {
  const c = copy(d);
  const subject = oneLine(c.subject);
  const when = formatWhen(d.startAt, d.endAt, d.timeZone);
  const where = [d.locationName, d.locationAddress].filter(Boolean).join(', ');
  const rows: [string, string][] = [
    ['Servicio', d.serviceName],
    ['Cuándo', when],
    ['Con', d.resourceName],
    ['Dónde', where],
    ['Código', d.code],
  ];
  const manage = d.manageUrl
    ? {
        label: 'Ver o gestionar mi reserva',
        note: `Puedes cambiar el horario o cancelar hasta ${d.cancelWindowHours} h antes desde ese enlace. Es personal: no lo compartas.`,
      }
    : null;

  const text = [
    `Hola ${oneLine(d.customerFirstName)},`,
    '',
    c.intro,
    '',
    ...rows.map(([k, v]) => `${k}: ${oneLine(v)}`),
    '',
    ...(manage && d.manageUrl ? [`${manage.label}:`, d.manageUrl, '', manage.note, ''] : []),
    ...(c.closing ? [c.closing, ''] : []),
    `${d.tenantName}`,
  ].join('\n');

  const html = `<!doctype html><html lang="es"><body style="font-family:Arial,sans-serif;color:#222;max-width:560px">
<p>Hola ${escapeHtml(d.customerFirstName)},</p>
<p>${escapeHtml(c.intro)}</p>
<table style="border-collapse:collapse;margin:12px 0">
${rows
  .map(
    ([k, v]) =>
      `<tr><td style="color:#666;padding:4px 16px 4px 0;vertical-align:top">${escapeHtml(k)}</td><td style="padding:4px 0">${escapeHtml(v)}</td></tr>`,
  )
  .join('\n')}
</table>
${
  manage && d.manageUrl
    ? `<p><a href="${escapeHtml(d.manageUrl)}" style="background:#2b59c3;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${escapeHtml(manage.label)}</a></p>
<p style="color:#666;font-size:13px">${escapeHtml(manage.note)}</p>`
    : ''
}
${c.closing ? `<p>${escapeHtml(c.closing)}</p>` : ''}
<p style="color:#666;font-size:13px">${escapeHtml(d.tenantName)}</p>
</body></html>`;

  return { to: d.to, subject, text, html };
}
