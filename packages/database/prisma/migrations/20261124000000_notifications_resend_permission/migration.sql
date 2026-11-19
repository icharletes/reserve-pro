-- ReservePro — Migración 0011: permiso para reintentar comunicaciones (Fase 5B).
-- Los roles de sistema se copian al crear cada empresa (ARCHITECTURE.md §3.1), así que un permiso nuevo NO llega
-- solo a las empresas existentes: se otorga aquí a los roles de sistema que lo tienen en las plantillas
-- (apps/api/src/platform/rbac/role-templates.ts). Los roles personalizados no se tocan: decide cada empresa.
INSERT INTO permissions (key, description)
VALUES ('notifications:resend', 'Reintentar el envío de comunicaciones')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (tenant_id, role_id, permission_key)
SELECT r.tenant_id, r.id, 'notifications:resend'
  FROM roles r
 WHERE r.is_system AND r.key IN ('owner', 'admin', 'manager', 'receptionist')
ON CONFLICT DO NOTHING;
