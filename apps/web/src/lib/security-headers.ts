/**
 * Cabeceras de seguridad para TODAS las respuestas del portal.
 * - CSP: solo recursos propios; `frame-ancestors 'none'` impide incrustarlo en otro sitio (clickjacking).
 *   Los scripts inline de las islas de Astro requieren 'unsafe-inline' hasta que se migre a nonces.
 * - connect-src 'self': el navegador solo puede hablar con el propio origen (la API va detrás del mismo dominio).
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

export function applySecurityHeaders(headers: Headers): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
}
