import { describe, expect, it } from 'vitest';
import { parsePublicSlug } from './slug';
import { SECURITY_HEADERS, applySecurityHeaders } from './security-headers';

describe('parsePublicSlug', () => {
  it.each([
    ['barberia-el-corte', 'barberia-el-corte'],
    ['Barberia-El-Corte', 'barberia-el-corte'], // se normaliza a minúsculas
    ['spa-lago-12', 'spa-lago-12'],
  ])('%j -> %j', (raw, expected) => expect(parsePublicSlug(raw)).toBe(expected));

  it.each([
    undefined,
    '',
    'a',
    '-abc',
    'abc-',
    'con espacios',
    'tilde-ñ',
    '../etc/passwd',
    'a'.repeat(60),
    '<script>',
    'x%00y',
  ])('rechaza %j (formato inválido)', (raw) => expect(parsePublicSlug(raw)).toBeNull());

  it.each(['admin', 'api', 'login', 'auth', 'webhooks', 'health', 'ADMIN', 'Api'])(
    'rechaza el nombre reservado del sistema %j',
    (raw) => expect(parsePublicSlug(raw)).toBeNull(),
  );
});

describe('cabeceras de seguridad', () => {
  it('se aplican todas a la respuesta', () => {
    const h = new Headers();
    applySecurityHeaders(h);
    for (const name of Object.keys(SECURITY_HEADERS)) expect(h.get(name), name).toBeTruthy();
  });
  it('impiden incrustar el portal en otro sitio y solo permiten recursos propios', () => {
    const csp = SECURITY_HEADERS['Content-Security-Policy']!;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/script-src[^;]*\*/);
    expect(SECURITY_HEADERS['X-Frame-Options']).toBe('DENY');
  });
  it('sobrescriben una cabecera previa en lugar de duplicarla', () => {
    const h = new Headers({ 'X-Frame-Options': 'ALLOWALL' });
    applySecurityHeaders(h);
    expect(h.get('X-Frame-Options')).toBe('DENY');
  });
});
