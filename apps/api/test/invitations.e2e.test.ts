import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PASSWORD,
  type Auth,
  cookieValue,
  createTestApp,
  http,
  joinTenant,
  login,
  mailbox,
  ownerPool,
  register,
  tokenFrom,
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

const invite = (auth: Auth, email: string, roleKey = 'receptionist') =>
  http(app).post('/api/v1/tenants/current/invitations').set(auth).send({ email, roleKey });
const newEmail = () => `invitado-${randomUUID().slice(0, 8)}@example.test`;

describe('crear invitaciones (lado empresa)', () => {
  it('crea la invitación, envía el email con el token y NO devuelve el token en la API', async () => {
    const o = await register(app, { businessName: 'Salón Aurora' });
    const email = newEmail();
    const res = await invite(o.auth, email);

    expect(res.status).toBe(201);
    expect(res.body.emailSent).toBe(true);
    expect(res.body.invitation).toMatchObject({ email, roleKey: 'receptionist', expired: false });

    const mail = mailbox.last(email)!;
    const token = tokenFrom(mail);
    expect(mail.subject).toContain('Salón Aurora');
    expect(mail.text).toContain('#token='); // fragmento: no llega a logs de servidor
    expect(mail.text).not.toContain('?token=');

    // El token no aparece en la respuesta, ni en la BD (solo su hash), ni en la auditoría.
    expect(JSON.stringify(res.body)).not.toContain(token);
    const dump = await owner.query(
      `SELECT row_to_json(i)::text AS j FROM invitations i WHERE email=$1`,
      [email],
    );
    expect(dump.rows[0].j).not.toContain(token);
    const audit = await owner.query(
      `SELECT row_to_json(a)::text AS j FROM audit_logs a WHERE entity_type='invitation'`,
    );
    for (const r of audit.rows) expect(r.j).not.toContain(token);
  });

  it('escapa el HTML del nombre de la empresa en el email (sin inyección)', async () => {
    const o = await register(app, { businessName: 'Tienda <script>alert(1)</script> & Co' });
    const email = newEmail();
    await invite(o.auth, email);
    const mail = mailbox.last(email)!;
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });

  it('si el email falla, la invitación existe y puede reenviarse con un token NUEVO', async () => {
    const o = await register(app);
    const email = newEmail();
    mailbox.failNext();
    const res = await invite(o.auth, email);
    expect(res.status).toBe(201);
    expect(res.body.emailSent).toBe(false);
    expect(mailbox.last(email)).toBeUndefined();

    const resend = await http(app)
      .post(`/api/v1/tenants/current/invitations/${res.body.invitation.id}/resend`)
      .set(o.auth);
    expect(resend.status).toBe(200);
    expect(resend.body.emailSent).toBe(true);
    expect(mailbox.last(email)).toBeDefined();
  });

  it('reenviar invalida el token anterior', async () => {
    const o = await register(app);
    const email = newEmail();
    const created = await invite(o.auth, email);
    const oldToken = tokenFrom(mailbox.last(email));
    await http(app)
      .post(`/api/v1/tenants/current/invitations/${created.body.invitation.id}/resend`)
      .set(o.auth);
    const newToken = tokenFrom(mailbox.last(email));
    expect(newToken).not.toBe(oldToken);

    const old = await http(app).post('/api/v1/invitations/preview').send({ token: oldToken });
    expect(old.status).toBe(400);
    const fresh = await http(app).post('/api/v1/invitations/preview').send({ token: newToken });
    expect(fresh.status).toBe(200);
  });

  it('rechaza duplicado pendiente, miembro existente y rol inexistente', async () => {
    const o = await register(app);
    const email = newEmail();
    await invite(o.auth, email);
    const dup = await invite(o.auth, email);
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('ALREADY_INVITED');

    const member = await joinTenant(app, owner, o.tenantId, 'professional');
    const already = await invite(o.auth, member.email);
    expect(already.body.code).toBe('ALREADY_MEMBER');

    const badRole = await invite(o.auth, newEmail(), 'superjefe');
    expect(badRole.status).toBe(400);
    expect(badRole.body.errors[0].path).toBe('roleKey');
  });

  it('valida el email y el rol', async () => {
    const o = await register(app);
    expect((await invite(o.auth, 'no-es-email')).status).toBe(400);
    const res = await http(app).post('/api/v1/tenants/current/invitations').set(o.auth).send({});
    expect(res.status).toBe(400);
  });

  it('una invitación pendiente VENCIDA no bloquea reinvitar', async () => {
    const o = await register(app);
    const email = newEmail();
    await invite(o.auth, email);
    await owner.query(
      `UPDATE invitations SET expires_at = now() - interval '1 day' WHERE email=$1`,
      [email],
    );
    const again = await invite(o.auth, email);
    expect(again.status).toBe(201);
  });

  it('limita las invitaciones pendientes por empresa (anti-relé de correo)', async () => {
    const o = await register(app);
    const me = (
      await owner.query(`SELECT id FROM tenant_memberships WHERE tenant_id=$1`, [o.tenantId])
    ).rows[0].id;
    const roleId = (
      await owner.query(`SELECT id FROM roles WHERE tenant_id=$1 AND key='receptionist'`, [
        o.tenantId,
      ])
    ).rows[0].id;
    for (let i = 0; i < 50; i++) {
      await owner.query(
        `INSERT INTO invitations(id,tenant_id,email,role_id,token_hash,expires_at,invited_by)
         VALUES (gen_random_uuid(),$1,$2,$3,$4, now() + interval '7 days',$5)`,
        [
          o.tenantId,
          `bulk${i}@example.test`,
          roleId,
          Buffer.from(randomUUID().replace(/-/g, '') + 'xxxxxxxxxxxxxxxx'),
          me,
        ],
      );
    }
    const res = await invite(o.auth, newEmail());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LIMIT_REACHED');
  });
});

describe('permisos y anti-escalada al invitar', () => {
  it('un profesional o una recepcionista no pueden invitar ni ver miembros', async () => {
    const o = await register(app);
    const pro = await joinTenant(app, owner, o.tenantId, 'professional');
    const rec = await joinTenant(app, owner, o.tenantId, 'receptionist');
    expect((await invite(pro.auth, newEmail())).status).toBe(403);
    expect((await invite(rec.auth, newEmail())).status).toBe(403);
    expect((await http(app).get('/api/v1/tenants/current/members').set(rec.auth)).status).toBe(403);
    expect((await http(app).get('/api/v1/tenants/current/invitations').set(pro.auth)).status).toBe(
      403,
    );
  });

  it('un administrador NO puede invitar propietarios; un propietario sí', async () => {
    const o = await register(app);
    const admin = await joinTenant(app, owner, o.tenantId, 'admin');

    const denied = await invite(admin.auth, newEmail(), 'owner');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('ROLE_NOT_ALLOWED');

    expect((await invite(admin.auth, newEmail(), 'manager')).status).toBe(201); // ⊆ permisos del admin
    expect((await invite(o.auth, newEmail(), 'owner')).status).toBe(201);
  });
});

describe('listar y revocar', () => {
  it('lista solo las pendientes de SU empresa', async () => {
    const a = await register(app);
    const b = await register(app);
    const ea = newEmail();
    await invite(a.auth, ea);
    await invite(b.auth, newEmail());

    const list = await http(app).get('/api/v1/tenants/current/invitations').set(a.auth);
    expect(list.status).toBe(200);
    expect(list.body.map((i: { email: string }) => i.email)).toEqual([ea]);
  });

  it('revocar invalida el token y permite reinvitar', async () => {
    const o = await register(app);
    const email = newEmail();
    const created = await invite(o.auth, email);
    const token = tokenFrom(mailbox.last(email));

    expect(
      (
        await http(app)
          .delete(`/api/v1/tenants/current/invitations/${created.body.invitation.id}`)
          .set(o.auth)
      ).status,
    ).toBe(204);
    expect(
      (
        await http(app)
          .post('/api/v1/invitations/accept')
          .send({ token, fullName: 'Ana Gómez', password: PASSWORD })
      ).status,
    ).toBe(400);
    expect((await invite(o.auth, email)).status).toBe(201);
  });

  it('no se puede revocar ni reenviar la invitación de OTRA empresa (404)', async () => {
    const a = await register(app);
    const b = await register(app);
    const created = await invite(b.auth, newEmail());
    const id = created.body.invitation.id;
    expect(
      (await http(app).delete(`/api/v1/tenants/current/invitations/${id}`).set(a.auth)).status,
    ).toBe(404);
    expect(
      (await http(app).post(`/api/v1/tenants/current/invitations/${id}/resend`).set(a.auth)).status,
    ).toBe(404);
    const still = await owner.query(`SELECT revoked_at FROM invitations WHERE id=$1`, [id]);
    expect(still.rows[0].revoked_at).toBeNull();
  });

  it('un id que no es UUID da 400', async () => {
    const o = await register(app);
    expect(
      (await http(app).delete('/api/v1/tenants/current/invitations/abc').set(o.auth)).status,
    ).toBe(400);
  });
});

describe('aceptar invitación (lado invitado)', () => {
  it('preview muestra empresa y rol; token inválido, usado, revocado o vencido dan la MISMA respuesta', async () => {
    const o = await register(app, { businessName: 'Spa Lago' });
    const email = newEmail();
    await invite(o.auth, email, 'manager');
    const token = tokenFrom(mailbox.last(email));

    const ok = await http(app).post('/api/v1/invitations/preview').send({ token });
    expect(ok.body).toEqual({
      tenantName: 'Spa Lago',
      roleName: 'Gerente',
      email,
      accountExists: false,
    });

    const unknown = await http(app)
      .post('/api/v1/invitations/preview')
      .send({ token: 'x'.repeat(43) });
    await owner.query(
      `UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE email=$1`,
      [email],
    );
    const expired = await http(app).post('/api/v1/invitations/preview').send({ token });
    expect(unknown.status).toBe(400);
    expect(expired.status).toBe(400);
    expect(unknown.body.code).toBe('INVITATION_INVALID');
    expect(unknown.body.detail).toBe(expired.body.detail);
  });

  it('cuenta nueva: exige nombre y contraseña; crea cuenta, membresía con el rol y sesión', async () => {
    const o = await register(app);
    const email = newEmail();
    await invite(o.auth, email, 'manager');
    const token = tokenFrom(mailbox.last(email));

    const missing = await http(app).post('/api/v1/invitations/accept').send({ token });
    expect(missing.status).toBe(400);
    expect(missing.body.errors.map((e: { path: string }) => e.path).sort()).toEqual([
      'fullName',
      'password',
    ]);

    const res = await http(app)
      .post('/api/v1/invitations/accept')
      .send({ token, fullName: 'Marta Díaz', password: PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.outcome).toBe('account_created');
    expect(res.body.auth.activeTenantId).toBe(o.tenantId);
    expect(cookieValue(res.headers['set-cookie'])).toBeTruthy();

    const me = await http(app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${res.body.auth.accessToken}`);
    expect(me.body.roles).toEqual(['manager']);
    expect(me.body.tenant.id).toBe(o.tenantId);

    const user = await owner.query(
      `SELECT email_verified_at, password_hash FROM users WHERE email=$1`,
      [email],
    );
    expect(user.rows[0].email_verified_at).not.toBeNull(); // el token demostró el control del email
    expect(user.rows[0].password_hash).toMatch(/^\$argon2id\$/);

    const audit = await owner.query(
      `SELECT action FROM audit_logs WHERE tenant_id=$1 AND action='invitation.accepted'`,
      [o.tenantId],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('el email de la cuenta es SIEMPRE el de la invitación (no se puede cambiar al aceptar)', async () => {
    const o = await register(app);
    const email = newEmail();
    await invite(o.auth, email);
    const res = await http(app)
      .post('/api/v1/invitations/accept')
      .send({
        token: tokenFrom(mailbox.last(email)),
        fullName: 'Ana Pérez',
        password: PASSWORD,
        email: 'otro@example.test',
      });
    expect(res.status).toBe(201);
    expect(res.body.auth.user.email).toBe(email);
  });

  it('el token solo sirve UNA vez', async () => {
    const o = await register(app);
    const email = newEmail();
    await invite(o.auth, email);
    const token = tokenFrom(mailbox.last(email));
    expect(
      (
        await http(app)
          .post('/api/v1/invitations/accept')
          .send({ token, fullName: 'Ana Pérez', password: PASSWORD })
      ).status,
    ).toBe(201);
    const again = await http(app)
      .post('/api/v1/invitations/accept')
      .send({ token, fullName: 'Intruso', password: PASSWORD });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('INVITATION_INVALID');
  });

  it('cuenta existente: se une SIN iniciar sesión automática y luego ve ambas empresas', async () => {
    const a = await register(app);
    const b = await register(app);
    await invite(a.auth, b.email, 'professional'); // b ya tiene cuenta (y su propia empresa)
    const token = tokenFrom(mailbox.last(b.email));

    const pre = await http(app).post('/api/v1/invitations/preview').send({ token });
    expect(pre.body.accountExists).toBe(true);

    const res = await http(app).post('/api/v1/invitations/accept').send({ token });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('joined');
    expect(res.body.auth).toBeUndefined();
    expect(cookieValue(res.headers['set-cookie'])).toBeUndefined(); // un token no sustituye a la contraseña

    const l = await login(app, b.email);
    expect(l.body.memberships).toHaveLength(2);
  });

  it('cinco aceptaciones simultáneas del mismo token: solo una gana', async () => {
    const o = await register(app);
    const email = newEmail();
    await invite(o.auth, email);
    const token = tokenFrom(mailbox.last(email));
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        http(app)
          .post('/api/v1/invitations/accept')
          .send({ token, fullName: 'Ana Pérez', password: PASSWORD }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      results.filter((r) => r.status !== 201).every((r) => [400, 409].includes(r.status)),
    ).toBe(true);
    const members = await owner.query(
      `SELECT count(*)::int AS n FROM tenant_memberships m JOIN users u ON u.id=m.user_id WHERE u.email=$1`,
      [email],
    );
    expect(members.rows[0].n).toBe(1);
  });

  it('si ya era miembro, falla con 409 y la invitación NO se consume (transacción revertida)', async () => {
    const o = await register(app);
    const email = newEmail();
    await invite(o.auth, email);
    const token = tokenFrom(mailbox.last(email));
    // Se registra por otra vía y la empresa lo agrega directamente como miembro.
    const u = await register(app, { email });
    await owner.query(
      `INSERT INTO tenant_memberships(id,tenant_id,user_id) VALUES (gen_random_uuid(),$1,$2)`,
      [o.tenantId, u.body.user.id],
    );

    const res = await http(app).post('/api/v1/invitations/accept').send({ token });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_MEMBER');
    const inv = await owner.query(`SELECT accepted_at FROM invitations WHERE email=$1`, [email]);
    expect(inv.rows[0].accepted_at).toBeNull();
  });

  it('una empresa suspendida no admite nuevas incorporaciones', async () => {
    const o = await register(app);
    const email = newEmail();
    await invite(o.auth, email);
    const token = tokenFrom(mailbox.last(email));
    await owner.query(`UPDATE tenants SET status='suspended' WHERE id=$1`, [o.tenantId]);
    expect((await http(app).post('/api/v1/invitations/preview').send({ token })).status).toBe(400);
  });

  it('el token va en el cuerpo, nunca en la URL (GET con token no existe)', async () => {
    const res = await http(app).get(`/api/v1/invitations/${'a'.repeat(43)}`);
    expect(res.status).toBe(404);
  });
});
