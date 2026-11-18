import { ApiError } from '@reservepro/api-client';
import { beforeEach, describe, expect, it } from 'vitest';
import { describeError } from '../lib/errors';
import { takeFragmentToken } from '../lib/fragment-token';
import { safeRedirect } from '../lib/safe-redirect';

describe('safeRedirect (anti open redirect)', () => {
  it.each([
    ['/members', '/members'],
    ['/audit?x=1', '/audit?x=1'],
    ['https://evil.com', '/'],
    ['//evil.com', '/'],
    ['/\\evil.com', '/'],
    ['javascript:alert(1)', '/'],
    ['members', '/'],
    ['/ok\nSet-Cookie: x', '/'],
    ['', '/'],
  ])('%j -> %j', (input, expected) => {
    expect(safeRedirect(input)).toBe(expected);
  });
  it('rechaza lo que no es texto o es demasiado largo', () => {
    expect(safeRedirect(undefined)).toBe('/');
    expect(safeRedirect(['/a'])).toBe('/');
    expect(safeRedirect(`/${'a'.repeat(600)}`)).toBe('/');
    expect(safeRedirect('//x', '/inicio')).toBe('/inicio');
  });
});

describe('takeFragmentToken', () => {
  const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
  beforeEach(() => window.history.replaceState(null, '', '/'));

  it('devuelve el token y lo BORRA de la URL, conservando ruta y query', () => {
    window.history.replaceState(null, '', `/accept-invitation?lang=es#token=${TOKEN}`);
    expect(takeFragmentToken()).toBe(TOKEN);
    expect(window.location.hash).toBe('');
    expect(window.location.pathname + window.location.search).toBe('/accept-invitation?lang=es');
    expect(window.location.href).not.toContain(TOKEN);
  });
  it('sin token o con uno demasiado corto devuelve null (y también limpia el fragmento)', () => {
    expect(takeFragmentToken()).toBeNull();
    window.history.replaceState(null, '', '/x#token=corto');
    expect(takeFragmentToken()).toBeNull();
    expect(window.location.hash).toBe('');
  });
  it('un segundo intento ya no encuentra el token', () => {
    window.history.replaceState(null, '', `/x#token=${TOKEN}`);
    takeFragmentToken();
    expect(takeFragmentToken()).toBeNull();
  });
});

describe('describeError', () => {
  it('traduce códigos conocidos', () => {
    expect(describeError(new ApiError(401, 'INVALID_CREDENTIALS', 'x'))).toMatch(/incorrectos/);
    expect(describeError(new ApiError(0, 'NETWORK_ERROR', 'x'))).toMatch(/conexión/);
    expect(describeError(new ApiError(403, 'EMAIL_NOT_VERIFIED', 'x'))).toMatch(
      /Verifica tu email/,
    );
  });
  it('429 muestra el tiempo de espera en unidades legibles', () => {
    expect(describeError(new ApiError(429, 'RATE_LIMITED', 'x', [], undefined, 30))).toContain(
      '30 segundos',
    );
    expect(describeError(new ApiError(429, 'RATE_LIMITED', 'x', [], undefined, 600))).toContain(
      '10 minutos',
    );
    expect(describeError(new ApiError(429, 'RATE_LIMITED', 'x', [], undefined, 7200))).toContain(
      '2 horas',
    );
    expect(describeError(new ApiError(429, 'RATE_LIMITED', 'x'))).toMatch(/un momento/);
  });
  it('un error 5xx NO muestra el detalle del servidor, solo el código de seguimiento', () => {
    const msg = describeError(
      new ApiError(
        500,
        'INTERNAL_ERROR',
        'SELECT * FROM users falló en db-prod-3',
        [],
        'req-abc-12345',
      ),
    );
    expect(msg).not.toContain('SELECT');
    expect(msg).not.toContain('db-prod');
    expect(msg).toContain('req-abc-12345');
  });
  it('un error que no es de la API da un mensaje genérico', () => {
    expect(describeError(new Error('secreto interno'))).not.toContain('secreto');
  });
});
