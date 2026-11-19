import { describe, expect, it, vi } from 'vitest';
import { PortalError, portalApi } from './api';
import {
  addDays,
  formatAddress,
  formatDuration,
  formatMoney,
  formatShortDay,
  formatTime,
  localDate,
  tokenFromHash,
} from './format';
import { applySecurityHeaders } from './security-headers';
import { loadTenant } from './server';

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456'; // 43 caracteres base64url

describe('token del fragmento', () => {
  it('lo lee de #token=… (con o sin más parámetros) y rechaza lo que no es un token', () => {
    expect(tokenFromHash(`#token=${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromHash(`#token=${TOKEN}&nueva=1`)).toBe(TOKEN);
    expect(tokenFromHash(`#nueva=1&token=${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromHash('#token=corto')).toBeNull();
    expect(tokenFromHash(`#token=${TOKEN}x`)).toBeNull();
    expect(tokenFromHash(`#token=${TOKEN.slice(0, 42)}<`)).toBeNull();
    expect(tokenFromHash('')).toBeNull();
  });
});

describe('formato en la zona del negocio', () => {
  it('hora y fecha local, con cambio de hora', () => {
    expect(formatTime('2027-07-05T13:00:00.000Z', 'America/Santiago')).toBe('09:00'); // invierno UTC-4
    expect(formatTime('2027-01-04T12:00:00.000Z', 'America/Santiago')).toBe('09:00'); // verano UTC-3
    // 01:30Z del martes es lunes por la noche en Santiago
    expect(localDate(new Date('2027-07-06T01:30:00Z'), 'America/Santiago')).toBe('2027-07-05');
    expect(addDays('2027-12-31', 1)).toBe('2028-01-01');
    expect(formatShortDay('2027-07-05')).toMatch(/lun.*5.*jul/i);
  });
  it('dinero sin coma flotante, duración y dirección', () => {
    expect(formatMoney('15000.00', 'CLP')).toBe('$15.000');
    expect(formatMoney('1234.50', 'USD')).toBe('$1.234,50 USD');
    expect(formatDuration(45)).toBe('45 min');
    expect(formatDuration(90)).toBe('1 h 30 min');
    expect(formatDuration(120)).toBe('2 h');
    expect(
      formatAddress({ line1: 'Av. Siempre Viva 742', city: 'Santiago', country: 'Chile' }),
    ).toBe('Av. Siempre Viva 742, Santiago');
  });
});

describe('cliente del portal', () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('el token va en el CUERPO (nunca en la URL) y la Idempotency-Key en la cabecera', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return json(400, { code: 'LINK_INVALID', detail: 'El enlace no es válido o ya expiró' });
    }) as unknown as typeof fetch;
    await expect(portalApi.lookup(TOKEN, f)).rejects.toMatchObject({ code: 'LINK_INVALID' });
    expect(calls[0]!.url).toBe('/api/v1/public/manage/lookup');
    expect(calls[0]!.url).not.toContain(TOKEN);
    expect(calls[0]!.init.body).toContain(TOKEN);
    expect(calls[0]!.init.credentials).toBe('omit');

    await portalApi.book('mi-negocio', {} as never, 'clave-intento-1234', f).catch(() => undefined);
    expect((calls[1]!.init.headers as Record<string, string>)['idempotency-key']).toBe(
      'clave-intento-1234',
    );
  });

  it('errores: 5xx genérico, 429 amable, red caída, y el mensaje de la API en 4xx', async () => {
    const respond = (r: Response | Error) =>
      (async () => {
        if (r instanceof Error) throw r;
        return r;
      }) as unknown as typeof fetch;
    const err = (r: Response | Error): Promise<PortalError> =>
      portalApi.lookup(TOKEN, respond(r)).then(
        () => {
          throw new Error('se esperaba un error');
        },
        (e: PortalError) => e,
      );
    expect((await err(json(500, { detail: 'stack interno' }))).message).not.toContain('stack');
    expect((await err(json(429, {}))).message).toMatch(/Demasiados intentos/);
    expect((await err(new TypeError('fetch failed'))).code).toBe('NETWORK_ERROR');
    expect(
      (await err(json(409, { code: 'POLICY_VIOLATION', detail: 'Fuera de plazo' }))).message,
    ).toBe('Fuera de plazo');
  });
});

describe('SSR', () => {
  it('reenvía la IP del visitante y trata 404/400 como "no existe"', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    expect(await loadTenant('no-existe', '203.0.113.7', f)).toBeNull();
    const [, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect((init.headers as Record<string, string>)['x-forwarded-for']).toBe('203.0.113.7');
    const boom = vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    await expect(loadTenant('x', undefined, boom)).rejects.toThrow(/503/);
  });

  it('una página puede endurecer el Referrer-Policy (no-referrer) y el middleware lo respeta', () => {
    const strict = new Headers({ 'Referrer-Policy': 'no-referrer' });
    applySecurityHeaders(strict);
    expect(strict.get('Referrer-Policy')).toBe('no-referrer');
    const normal = new Headers({ 'Referrer-Policy': 'unsafe-url' }); // una página NO puede relajarla
    applySecurityHeaders(normal);
    expect(normal.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });
});
