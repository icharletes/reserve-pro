-- ReservePro — Migración 0001: núcleo SaaS, acceso, RBAC, auditoría y herramientas de RLS.
-- Escrita a mano (ADR-003). Ver docs/architecture/ARCHITECTURE.md §2–§4 y ADR-004.
-- Se ejecuta como rp_owner. Los roles rp_app / rp_system los crea el entorno (docker init / DBA).

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Utilidades de tenancy
-- ---------------------------------------------------------------------------

-- Tenant activo de la transacción (set_config('app.tenant_id', $1, true)). Sin contexto => NULL => 0 filas.
CREATE FUNCTION rp_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- Usuario autenticado de la transacción; solo se usa para que un usuario lea SUS membresías al hacer login.
CREATE FUNCTION rp_current_user() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

-- Activa RLS forzado + política estándar de aislamiento en una tabla con columna tenant_id.
CREATE FUNCTION rp_enable_tenant_rls(tbl regclass) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (tenant_id = rp_current_tenant()) WITH CHECK (tenant_id = rp_current_tenant())',
    tbl);
END $$;

CREATE FUNCTION rp_set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

-- ---------------------------------------------------------------------------
-- Empresas
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id          uuid PRIMARY KEY,
  name        varchar(150) NOT NULL,
  legal_name  varchar(200),
  tax_id      varchar(30),
  slug        citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','cancelled')),
  timezone    varchar(60) NOT NULL DEFAULT 'America/Santiago',
  currency    char(3) NOT NULL DEFAULT 'CLP',
  plan_id     uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_tenants_updated BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION rp_set_updated_at();

CREATE TABLE tenant_settings (
  tenant_id                   uuid PRIMARY KEY REFERENCES tenants(id),
  booking_min_notice_minutes  int NOT NULL DEFAULT 60  CHECK (booking_min_notice_minutes >= 0),
  booking_max_advance_days    int NOT NULL DEFAULT 90  CHECK (booking_max_advance_days > 0),
  slot_step_minutes           int NOT NULL DEFAULT 15  CHECK (slot_step_minutes BETWEEN 5 AND 240),
  auto_confirm                boolean NOT NULL DEFAULT true,
  pending_hold_minutes        int NOT NULL DEFAULT 30  CHECK (pending_hold_minutes > 0),
  cancel_window_hours         int NOT NULL DEFAULT 24  CHECK (cancel_window_hours >= 0),
  cancel_requires_approval    boolean NOT NULL DEFAULT false,
  reschedule_window_hours     int NOT NULL DEFAULT 24  CHECK (reschedule_window_hours >= 0),
  max_reschedules             int NOT NULL DEFAULT 2   CHECK (max_reschedules >= 0),
  self_service_actions        jsonb NOT NULL DEFAULT '{"confirm":true,"cancel":true,"reschedule":true,"details":true}',
  branding                    jsonb NOT NULL DEFAULT '{}',
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_tenant_settings_updated BEFORE UPDATE ON tenant_settings FOR EACH ROW EXECUTE FUNCTION rp_set_updated_at();

-- Slugs que no pueden usarse como página pública (colisionan con rutas del sistema).
CREATE TABLE reserved_slugs (slug citext PRIMARY KEY);
INSERT INTO reserved_slugs (slug) VALUES
  ('admin'),('api'),('app'),('www'),('public'),('static'),('assets'),('login'),('register'),
  ('auth'),('webhooks'),('platform'),('health'),('status'),('support'),('help'),('docs');

-- ---------------------------------------------------------------------------
-- Usuarios y sesiones (globales; no tienen tenant_id)
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                 uuid PRIMARY KEY,
  email              citext NOT NULL UNIQUE,
  password_hash      text NOT NULL,                       -- argon2id
  full_name          varchar(150) NOT NULL,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  is_platform_admin  boolean NOT NULL DEFAULT false,
  email_verified_at  timestamptz,
  failed_logins      int NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION rp_set_updated_at();

CREATE TABLE refresh_tokens (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id),
  family_id    uuid NOT NULL,
  token_hash   bytea NOT NULL UNIQUE,                     -- SHA-256; jamás el token en claro
  active_tenant_id uuid REFERENCES tenants(id),             -- NO es "tenant_id": la tabla es global (por usuario), sin RLS
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  replaced_by  uuid,
  ip           inet,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_refresh_tokens_family ON refresh_tokens (family_id);
CREATE INDEX ix_refresh_tokens_user_active ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

CREATE TABLE password_reset_tokens (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id),
  token_hash  bytea NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Membresías y RBAC
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_memberships (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','disabled')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX ix_memberships_user ON tenant_memberships (user_id);
CREATE TRIGGER trg_memberships_updated BEFORE UPDATE ON tenant_memberships FOR EACH ROW EXECUTE FUNCTION rp_set_updated_at();

-- Catálogo global de permisos (sincronizado desde el código en cada deploy).
CREATE TABLE permissions (
  key          text PRIMARY KEY,
  description  text NOT NULL
);

CREATE TABLE roles (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  key         text NOT NULL,
  name        text NOT NULL,
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, key)
);

CREATE TABLE role_permissions (
  tenant_id       uuid NOT NULL,
  role_id         uuid NOT NULL,
  permission_key  text NOT NULL REFERENCES permissions(key),
  PRIMARY KEY (role_id, permission_key),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE membership_roles (
  tenant_id      uuid NOT NULL,
  membership_id  uuid NOT NULL,
  role_id        uuid NOT NULL,
  PRIMARY KEY (membership_id, role_id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, role_id)       REFERENCES roles (tenant_id, id)
);

CREATE TABLE invitations (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  email       citext NOT NULL,
  role_id     uuid NOT NULL,
  token_hash  bytea NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  invited_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, role_id)    REFERENCES roles (tenant_id, id),
  FOREIGN KEY (tenant_id, invited_by) REFERENCES tenant_memberships (tenant_id, id)
);
-- una sola invitación pendiente por email y empresa
CREATE UNIQUE INDEX uq_invitations_pending ON invitations (tenant_id, email) WHERE accepted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Auditoría (append-only, particionada por mes)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id           uuid NOT NULL,
  tenant_id    uuid,                                       -- NULL = acción de plataforma
  actor_type   text NOT NULL CHECK (actor_type IN ('user','customer','system','whatsapp','platform_admin')),
  actor_id     uuid,
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    uuid,
  before       jsonb,
  after        jsonb,
  request_id   text,
  ip           inet,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;
CREATE INDEX ix_audit_tenant_time   ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX ix_audit_tenant_entity ON audit_logs (tenant_id, entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- Tablas con columna tenant_id: política estándar.
SELECT rp_enable_tenant_rls('tenant_settings');
SELECT rp_enable_tenant_rls('roles');
SELECT rp_enable_tenant_rls('role_permissions');
SELECT rp_enable_tenant_rls('membership_roles');
SELECT rp_enable_tenant_rls('invitations');
SELECT rp_enable_tenant_rls('audit_logs');
SELECT rp_enable_tenant_rls('tenant_memberships');

-- Un usuario puede LEER sus propias membresías (para listar sus empresas al iniciar sesión,
-- cuando aún no hay tenant activo). Las políticas PERMISSIVE se combinan con OR.
CREATE POLICY own_memberships_read ON tenant_memberships FOR SELECT
  USING (user_id = rp_current_user());

-- tenants: la clave es `id`. El tenant activo solo ve su propia fila.
-- Alta de empresa: la app fija app.tenant_id = <nuevo id> ANTES de insertar (WITH CHECK lo exige).
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (id = rp_current_tenant()) WITH CHECK (id = rp_current_tenant());
-- Lectura por membresía propia (selector de empresa tras el login).
CREATE POLICY own_tenants_read ON tenants FOR SELECT
  USING (EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.tenant_id = tenants.id AND m.user_id = rp_current_user()));

-- Resolución pública por slug SIN contexto de tenant: devuelve solo lo imprescindible.
CREATE FUNCTION rp_resolve_tenant_by_slug(p_slug text)
  RETURNS TABLE (id uuid, status text, timezone text, currency text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT t.id, t.status, t.timezone::text, t.currency::text FROM tenants t WHERE t.slug = p_slug::citext $$;
REVOKE ALL ON FUNCTION rp_resolve_tenant_by_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rp_resolve_tenant_by_slug(text) TO rp_app, rp_system;

-- Tablas inmutables para el runtime: solo INSERT/SELECT.
REVOKE UPDATE, DELETE ON audit_logs, audit_logs_default FROM rp_app;

-- ---------------------------------------------------------------------------
-- Auditoría de RLS (la usa el test de catálogo en CI)
-- Lista tablas con columna tenant_id sin RLS habilitado+forzado o sin ninguna política.
-- ---------------------------------------------------------------------------
CREATE VIEW rp_rls_violations AS
SELECT c.relname AS table_name,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced,
       (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
WHERE c.relkind IN ('r','p')
  AND NOT c.relispartition
  AND EXISTS (SELECT 1 FROM pg_attribute a
              WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
  AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
       OR (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) = 0);
