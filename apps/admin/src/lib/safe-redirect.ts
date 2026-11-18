/**
 * Destino post-login seguro. Solo se acepta una RUTA INTERNA ("/algo"): rechaza URLs absolutas,
 * protocol-relative ("//evil.com") y esquemas ("javascript:"), que permitirían un open redirect.
 */
export function safeRedirect(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string' || value.length > 500) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;
  // Sin caracteres de control (saltos de línea, NUL…): evitan inyección de cabeceras y trucos de parseo.
  if ([...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return fallback;
  return value;
}
