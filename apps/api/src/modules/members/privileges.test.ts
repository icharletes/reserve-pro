import { describe, expect, it } from 'vitest';
import { ROLE_TEMPLATES } from '../../platform/rbac/role-templates.js';
import { canHold, withImplied } from './privileges.js';

const perms = (key: string) => new Set(ROLE_TEMPLATES.find((t) => t.key === key)!.permissions);
const matrix = (actor: string, target: string) => canHold(perms(actor), perms(target));

describe('implicación de permisos', () => {
  it('x implica x:own, pero x:own no implica x', () => {
    expect(withImplied(['reservations:read']).has('reservations:read:own')).toBe(true);
    expect(withImplied(['reservations:read:own']).has('reservations:read')).toBe(false);
  });
  it('no inventa permisos sin relación', () => {
    expect(withImplied(['services:write']).size).toBe(1);
  });
});

describe('matriz de quién puede otorgar/gestionar qué rol (derivada de las plantillas reales)', () => {
  it.each([
    // actor, objetivo, esperado
    ['owner', 'owner', true],
    ['owner', 'admin', true],
    ['owner', 'professional', true],
    ['admin', 'owner', false], // el admin no tiene billing:manage
    ['admin', 'admin', true],
    ['admin', 'manager', true],
    ['admin', 'receptionist', true],
    ['admin', 'professional', true], // requiere la implicación x → x:own
    ['manager', 'admin', false],
    ['manager', 'owner', false],
    ['manager', 'receptionist', true],
    ['receptionist', 'manager', false],
    ['receptionist', 'admin', false],
    ['professional', 'receptionist', false],
    ['professional', 'owner', false],
    ['professional', 'professional', true],
  ] as const)('%s → %s = %s', (actor, target, expected) => {
    expect(matrix(actor, target)).toBe(expected);
  });

  it('solo el propietario puede otorgar el rol owner', () => {
    const grantors = ROLE_TEMPLATES.filter((t) => matrix(t.key, 'owner')).map((t) => t.key);
    expect(grantors).toEqual(['owner']);
  });

  it('ningún rol no propietario puede otorgar un rol con billing:manage', () => {
    for (const t of ROLE_TEMPLATES.filter((r) => r.key !== 'owner')) {
      expect(canHold(new Set(t.permissions), ['billing:manage'])).toBe(false);
    }
  });
});
