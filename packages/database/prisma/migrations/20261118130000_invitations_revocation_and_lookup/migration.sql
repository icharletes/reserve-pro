-- ReservePro — Migración 0003: revocación de invitaciones y resolución segura por token.

-- 1) Las invitaciones se REVOCAN (no se borran): queda trazabilidad de quién invitó a quién.
ALTER TABLE invitations ADD COLUMN revoked_at timestamptz;

-- 2) Una sola invitación PENDIENTE por email y empresa. Pendiente = ni aceptada ni revocada.
--    (Antes ignoraba la revocación, lo que habría impedido reinvitar a alguien tras revocarle la invitación.)
DROP INDEX uq_invitations_pending;
CREATE UNIQUE INDEX uq_invitations_pending ON invitations (tenant_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- 3) Resolución por token SIN contexto de tenant: quien acepta todavía no pertenece a la empresa, así que
--    RLS no le dejaría leer la invitación. La función devuelve solo lo necesario y solo para el hash exacto
--    de un token de 256 bits (no enumerable). Mismo patrón que rp_resolve_tenant_by_slug.
CREATE FUNCTION rp_resolve_invitation(p_token_hash bytea)
  RETURNS TABLE (
    id uuid, tenant_id uuid, tenant_name text, tenant_status text,
    email text, role_id uuid, role_name text,
    expires_at timestamptz, accepted_at timestamptz, revoked_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT i.id, i.tenant_id, t.name::text, t.status, i.email::text, i.role_id, r.name,
           i.expires_at, i.accepted_at, i.revoked_at
    FROM invitations i
    JOIN tenants t ON t.id = i.tenant_id
    JOIN roles   r ON r.tenant_id = i.tenant_id AND r.id = i.role_id
    WHERE i.token_hash = p_token_hash
  $$;
REVOKE ALL ON FUNCTION rp_resolve_invitation(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rp_resolve_invitation(bytea) TO rp_app, rp_system;
