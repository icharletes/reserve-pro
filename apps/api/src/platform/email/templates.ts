import type { EmailMessage } from './email.module.js';

/** Escapa texto que proviene de usuarios antes de insertarlo en HTML (nombre de empresa, de la persona…). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface InvitationEmailData {
  to: string;
  tenantName: string;
  inviterName: string;
  roleName: string;
  acceptUrl: string;
  expiresInDays: number;
}

export function renderInvitationEmail(d: InvitationEmailData): EmailMessage {
  // El asunto es texto plano: se eliminan saltos de línea para impedir inyección de cabeceras.
  const subject = `${d.inviterName} te invitó a ${d.tenantName} en ReservePro`.replace(
    /[\r\n]+/g,
    ' ',
  );
  const text = [
    `Hola,`,
    ``,
    `${d.inviterName} te invitó a unirte a "${d.tenantName}" en ReservePro con el rol de ${d.roleName}.`,
    ``,
    `Acepta la invitación aquí:`,
    d.acceptUrl,
    ``,
    `El enlace vence en ${d.expiresInDays} días. Si no esperabas este mensaje, puedes ignorarlo.`,
  ].join('\n');

  const html = `<!doctype html><html lang="es"><body style="font-family:Arial,sans-serif;color:#222">
<p>Hola,</p>
<p><strong>${escapeHtml(d.inviterName)}</strong> te invitó a unirte a <strong>${escapeHtml(d.tenantName)}</strong> en ReservePro con el rol de ${escapeHtml(d.roleName)}.</p>
<p><a href="${escapeHtml(d.acceptUrl)}" style="background:#2b59c3;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Aceptar invitación</a></p>
<p style="color:#666;font-size:13px">El enlace vence en ${d.expiresInDays} días. Si no esperabas este mensaje, puedes ignorarlo.</p>
</body></html>`;

  return { to: d.to, subject, text, html };
}

export interface ActionEmailData {
  to: string;
  subject: string;
  /** Párrafos de texto plano (se escapan en el HTML). */
  paragraphs: string[];
  /** Botón de acción opcional. */
  action?: { label: string; url: string };
  footer?: string;
}

/** Plantilla genérica para correos transaccionales (verificación, recuperación, avisos de seguridad). */
export function renderActionEmail(d: ActionEmailData): EmailMessage {
  const subject = d.subject.replace(/[\r\n]+/g, ' ');
  const text = [
    ...d.paragraphs.flatMap((p) => [p, '']),
    ...(d.action ? [`${d.action.label}:`, d.action.url, ''] : []),
    ...(d.footer ? [d.footer] : []),
  ].join('\n');
  const html = `<!doctype html><html lang="es"><body style="font-family:Arial,sans-serif;color:#222">
${d.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')}
${d.action ? `<p><a href="${escapeHtml(d.action.url)}" style="background:#2b59c3;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${escapeHtml(d.action.label)}</a></p>` : ''}
${d.footer ? `<p style="color:#666;font-size:13px">${escapeHtml(d.footer)}</p>` : ''}
</body></html>`;
  return { to: d.to, subject, text, html };
}
