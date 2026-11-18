/**
 * Destino post-login seguro. Solo se acepta una RUTA INTERNA ("/algo"): rechaza URLs absolutas,
 * protocol-relative ("//evil.com") y esquemas ("javascript:"), que permitirían un open redirect.
 */
export function safeRedirect(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string' || value.length > 500) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;
  if (/[\u0000-\u001f]/.test(value)) return fallback;
  return value;
}
