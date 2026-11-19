-- ReservePro — Migración 0007: reservas públicas (Fase 4). Ver ADR-015.
--
-- Enlaces de gestión para el cliente final (ver, cancelar, reprogramar SIN cuenta):
--  - token de 256 bits; en la BD solo su SHA-256 (una filtración de la tabla no permite usarlos);
--  - alcance limitado (scopes), vencimiento (como máximo, el fin de la reserva) y revocable;
--  - la resolución token -> empresa la hace una función SECURITY DEFINER que solo acepta el hash exacto
--    (no enumerable), igual que rp_resolve_invitation. Todo lo demás corre con RLS normal.

CREATE TABLE reservation_access_tokens (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  reservation_id  uuid NOT NULL,
  token_hash      bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  scopes          text[] NOT NULL
                  CHECK (cardinality(scopes) >= 1 AND scopes <@ ARRAY['view','cancel','reschedule']::text[]),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  last_used_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, reservation_id) REFERENCES reservations (tenant_id, id)
);
CREATE INDEX ix_rat_reservation ON reservation_access_tokens (tenant_id, reservation_id);
SELECT rp_enable_tenant_rls('reservation_access_tokens');

CREATE FUNCTION rp_resolve_reservation_token(p_token_hash bytea)
  RETURNS TABLE (tenant_id uuid, reservation_id uuid, token_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT a.tenant_id, a.reservation_id, a.id
    FROM reservation_access_tokens a
    JOIN tenants t ON t.id = a.tenant_id
    WHERE a.token_hash = p_token_hash
      AND a.revoked_at IS NULL
      AND a.expires_at > now()
      AND t.status = 'active'
  $$;
REVOKE ALL ON FUNCTION rp_resolve_reservation_token(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rp_resolve_reservation_token(bytea) TO rp_app, rp_system;

-- Configuración del portal público.
ALTER TABLE tenant_settings
  ADD COLUMN public_booking_enabled boolean NOT NULL DEFAULT true,
  -- anti-acaparamiento: reservas futuras activas hechas desde canales públicos por un mismo cliente
  ADD COLUMN max_active_public_per_customer int NOT NULL DEFAULT 3
      CHECK (max_active_public_per_customer BETWEEN 1 AND 50);

-- Barrido de retenciones vencidas (worker, rol rp_system): índice ya existente ix_reservations_holds.
