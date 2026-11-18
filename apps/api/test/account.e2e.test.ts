import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PASSWORD,
  cookieValue,
  createTestApp,
  http,
  login,
  mailbox,
  ownerPool,
  register,
  tokenFrom,
  waitForMail,
} from './helpers.js';

let app: INestApplication;
let owner: pg.Pool;

beforeAll(async () => {
  app = await createTestApp();
  owner = ownerPool();
});
afterAll(async () => {
  await app.close();
  await owner.end();
});

const NEW_PASSWORD = 'Otra-Clave-Muy-Segura-9';
const post = (path: string) => http(app).post(`/api/v1${path}`);
const forgot = (email: string) => post('/auth/forgot-password').send({ email });
const reset = (token: string, password = NEW_PASSWORD) => post('/auth/reset-password').send({ token, password });

describe('verificación de email', () => {
  it('la cuenta nace sin verificar, recibe el enlace y no puede invitar hasta verificar', async () => {
    const o = await register(app, { verified: false });
    expect(o.body.user.emailVerified).toBe(false);
    const me = await http(app).get('/api/v1/me').set(o.auth);
    expect(me.body.user.emailVerified).toBe(false);

    const mail = await waitForMail(o.email, (m) => m.subject.includes('Confirma'));
    expect(mail.text).toContain('/verify-email#token=');
    expect(mail.text).not.toContain('?token=');

    const blocked = await http(app)
      .post('/api/v1/tenants/current/invitations')
      .set(o.auth)
      .send({ email: `x-${randomUUID().slice(0, 6)}@example.test`, roleKey: 'receptionist' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('EMAIL_NOT_VERIFIED');

    // Verificar desbloquea la acción, y el endpoint de lectura siguió funcionando todo el tiempo.
    expect((await post('/auth/verify-email').send({ token: tokenFrom(mail) })).status).toBe(204);
    expect((await http(app).get('/api/v1/me').set(o.auth)).body.user.emailVerified).toBe(true);
    const ok = await http(app)
      .post('/api/v1/tenants/current/invitations')
      .set(o.auth)
      .send({ email: `y-${randomUUID().slice(0, 6)}@example.test`, roleKey: 'receptionist' });
    expect(ok.status).toBe(201);
  });

  it('el token solo sirve una vez; uno inventado o vencido da LINK_INVALID', async () => {
    const o = await register(app, { verified: false });
    const token = tokenFrom(await waitForMail(o.email));
    expect((await post('/auth/verify-email').send({ token })).status).toBe(204);

    const again = await post('/auth/verify-email').send({ token });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('LINK_INVALID');
    expect((await post('/auth/verify-email').send({ token: 'x'.repeat(43) })).body.code).toBe('LINK_INVALID');

    const p = await register(app, { verified: false });
    const t2 = tokenFrom(await waitForMail(p.email));
    await owner.query(`UPDATE email_verification_tokens SET expires_at = now() - interval '1 minute' WHERE user_id=$1`, [p.body.user.id]);
    expect((await post('/auth/verify-email').send({ token: t2 })).body.code).toBe('LINK_INVALID');
  });

  it('cinco verificaciones simultáneas del mismo token: solo una gana', async () => {
    const o = await register(app, { verified: false });
    const token = tokenFrom(await waitForMail(o.email));
    const res = await Promise.all(Array.from({ length: 5 }, () => post('/auth/verify-email').send({ token })));
    expect(res.filter((r) => r.status === 204)).toHaveLength(1);
  });

  it('reenviar invalida el enlace anterior; si ya está verificada no envía nada', async () => {
    const o = await register(app, { verified: false });
    const old = tokenFrom(await waitForMail(o.email));
    expect((await post('/auth/resend-verification').set(o.auth)).status).toBe(204);
    await new Promise((r) => setTimeout(r, 150));
    const fresh = tokenFrom(mailbox.last(o.email));
    expect(fresh).not.toBe(old);
    expect((await post('/auth/verify-email').send({ token: old })).body.code).toBe('LINK_INVALID');
    expect((await post('/auth/verify-email').send({ token: fresh })).status).toBe(204);

    const before = mailbox.sent.length;
    expect((await post('/auth/resend-verification').set(o.auth)).status).toBe(204);
    await new Promise((r) => setTimeout(r, 150));
    expect(mailbox.sent.length).toBe(before);
    expect((await post('/auth/resend-verification')).status).toBe(401);
  });

  it('en la BD solo hay hashes de token, nunca el token', async () => {
    const o = await register(app, { verified: false });
    const token = tokenFrom(await waitForMail(o.email));
    const dump = await owner.query(`SELECT row_to_json(t)::text AS j FROM email_verification_tokens t WHERE user_id=$1`, [o.body.user.id]);
    expect(dump.rows[0].j).not.toContain(token);
  });
});

describe('recuperar contraseña', () => {
  it('responde IGUAL (202) exista o no la cuenta, y solo envía correo si existe', async () => {
    const o = await register(app);
    const real = await forgot(o.email);
    const ghost = `fantasma-${randomUUID().slice(0, 6)}@example.test`;
    const fake = await forgot(ghost);
    expect(real.status).toBe(202);
    expect(fake.status).toBe(202);
    expect(real.body).toEqual(fake.body);

    await waitForMail(o.email, (m) => m.subject.includes('Restablece'));
    await new Promise((r) => setTimeout(r, 150));
    expect(mailbox.last(ghost)).toBeUndefined();
  });

  it('una cuenta desactivada tampoco recibe correo (y no se revela)', async () => {
    const o = await register(app);
    await owner.query(`UPDATE users SET status='disabled' WHERE email=$1`, [o.email]);
    const before = mailbox.sent.filter((m) => m.to === o.email).length;
    expect((await forgot(o.email)).status).toBe(202);
    await new Promise((r) => setTimeout(r, 150));
    expect(mailbox.sent.filter((m) => m.to === o.email).length).toBe(before);
  });

  it('restablece la contraseña, cierra TODAS las sesiones y avisa por correo', async () => {
    const o = await register(app);
    const session2 = await login(app, o.email);
    expect((await http(app).get('/api/v1/me').set(o.auth)).status).toBe(200);

    await forgot(o.email);
    const token = tokenFrom(await waitForMail(o.email, (m) => m.subject.includes('Restablece')));
    expect(token).toBeTruthy();
    expect((await reset(token)).status).toBe(204);

    // Sesiones anteriores muertas (access y refresh) en TODOS los dispositivos.
    expect((await http(app).get('/api/v1/me').set(o.auth)).status).toBe(401);
    expect((await http(app).get('/api/v1/me').set(session2.auth)).status).toBe(401);
    const refresh = await post('/auth/refresh').set('x-rp-csrf', '1').set('Cookie', `rp_refresh=${o.refresh}`);
    expect(refresh.status).toBe(401);

    // La contraseña vieja ya no sirve; la nueva sí.
    expect((await login(app, o.email)).res.status).toBe(401);
    expect((await login(app, o.email, { password: NEW_PASSWORD })).res.status).toBe(200);

    const notice = await waitForMail(o.email, (m) => m.subject.includes('fue cambiada'));
    expect(notice.text).toContain('Si no fuiste tú');
    expect(notice.text).not.toContain(NEW_PASSWORD);
  });

  it('el enlace sirve una vez; uno nuevo invalida el anterior; uno vencido no sirve', async () => {
    const o = await register(app);
    await forgot(o.email);
    const first = tokenFrom(await waitForMail(o.email, (m) => m.subject.includes('Restablece')));
    await forgot(o.email); // pide otro: el primero queda sin efecto
    await new Promise((r) => setTimeout(r, 150));
    const second = tokenFrom(mailbox.last(o.email));
    expect(second).not.toBe(first);
    expect((await reset(first)).body.code).toBe('LINK_INVALID');
    expect((await reset(second)).status).toBe(204);
    expect((await reset(second, 'Y-otra-mas-1234567')).body.code).toBe('LINK_INVALID');

    const p = await register(app);
    await forgot(p.email);
    const t = tokenFrom(await waitForMail(p.email, (m) => m.subject.includes('Restablece')));
    await owner.query(`UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute' WHERE user_id=$1`, [p.body.user.id]);
    expect((await reset(t)).body.code).toBe('LINK_INVALID');
  });

  it('una contraseña débil se rechaza SIN consumir el enlace', async () => {
    const o = await register(app);
    await forgot(o.email);
    const token = tokenFrom(await waitForMail(o.email, (m) => m.subject.includes('Restablece')));
    const weak = await reset(token, 'corta');
    expect(weak.status).toBe(400);
    expect(weak.body.code).toBe('VALIDATION_ERROR');
    expect((await reset(token)).status).toBe(204); // el mismo enlace aún funciona
  });

  it('desbloquea una cuenta bloqueada por intentos fallidos', async () => {
    const o = await register(app);
    for (let i = 0; i < 5; i++) await login(app, o.email, { password: 'incorrecta-123456' });
    expect((await login(app, o.email)).res.status).toBe(429);
    await forgot(o.email);
    const token = tokenFrom(await waitForMail(o.email, (m) => m.subject.includes('Restablece')));
    await reset(token);
    expect((await login(app, o.email, { password: NEW_PASSWORD })).res.status).toBe(200);
  });

  it('el enlace de recuperación también verifica el email (demuestra control del buzón)', async () => {
    const o = await register(app, { verified: false });
    await forgot(o.email);
    const token = tokenFrom(await waitForMail(o.email, (m) => m.subject.includes('Restablece')));
    await reset(token);
    const l = await login(app, o.email, { password: NEW_PASSWORD });
    expect(l.body.user.emailVerified).toBe(true);
  });

  it('el token no queda en la BD en claro', async () => {
    const o = await register(app);
    await forgot(o.email);
    const token = tokenFrom(await waitForMail(o.email, (m) => m.subject.includes('Restablece')));
    const dump = await owner.query(`SELECT row_to_json(t)::text AS j FROM password_reset_tokens t WHERE user_id=$1`, [o.body.user.id]);
    expect(dump.rows[0].j).not.toContain(token);
  });
});

describe('cambiar contraseña (autenticado)', () => {
  it('exige la contraseña actual correcta: error 400 y NO 401 (el cliente no debe cerrar sesión)', async () => {
    const o = await register(app);
    const res = await post('/auth/change-password').set(o.auth).send({ currentPassword: 'equivocada-123456', newPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
    expect((await http(app).get('/api/v1/me').set(o.auth)).status).toBe(200);
  });

  it('rechaza una nueva igual a la actual o débil', async () => {
    const o = await register(app);
    expect((await post('/auth/change-password').set(o.auth).send({ currentPassword: PASSWORD, newPassword: PASSWORD })).status).toBe(400);
    expect((await post('/auth/change-password').set(o.auth).send({ currentPassword: PASSWORD, newPassword: 'corta' })).status).toBe(400);
  });

  it('cambia la contraseña, conserva ESTA sesión y cierra las demás', async () => {
    const o = await register(app);
    const other = await login(app, o.email);
    const res = await post('/auth/change-password').set(o.auth).send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(204);

    expect((await http(app).get('/api/v1/me').set(o.auth)).status).toBe(200); // la actual sigue
    expect((await http(app).get('/api/v1/me').set(other.auth)).status).toBe(401); // la otra, cerrada
    expect((await login(app, o.email)).res.status).toBe(401);
    expect((await login(app, o.email, { password: NEW_PASSWORD })).res.status).toBe(200);
    await waitForMail(o.email, (m) => m.subject.includes('fue cambiada'));
  });

  it('exige autenticación', async () => {
    expect((await post('/auth/change-password').send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(401);
  });
});

describe('cookie de la sesión actual tras cambiar contraseña', () => {
  it('el refresh de la sesión conservada sigue funcionando', async () => {
    const o = await register(app);
    await post('/auth/change-password').set(o.auth).send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    const res = await post('/auth/refresh').set('x-rp-csrf', '1').set('Cookie', `rp_refresh=${o.refresh}`);
    expect(res.status).toBe(200);
    expect(cookieValue(res.headers['set-cookie'])).toBeTruthy();
  });
});
