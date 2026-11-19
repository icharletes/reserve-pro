-- ReservePro — Migración 0006: clientes, reservas, idempotencia y outbox (Fase 3, motor de reservas).
-- Ver docs/architecture/ARCHITECTURE.md §4.5-§4.7 y §6, y ADR-014.
--
-- GARANTÍA CENTRAL: dos reservas activas NUNCA ocupan el mismo recurso (capacidad 1) en tiempos que se solapan.
-- La impone PostgreSQL (EXCLUDE USING gist en reservation_resources), no la aplicación: aunque el código tuviera un
-- bug o se saltara el bloqueo, la base de datos rechaza el solape.

-- ---------------------------------------------------------------------------
-- Clientes (por empresa: el mismo teléfono en dos empresas son dos clientes distintos)
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  first_name      varchar(100) NOT NULL CHECK (char_length(first_name) >= 1),
  last_name       varchar(100),
  phone_e164      varchar(16) CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  email           citext CHECK (email IS NULL OR char_length(email) <= 254),
  internal_notes  text CHECK (internal_notes IS NULL OR char_length(internal_notes) <= 2000),
  anonymized_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- todo cliente es contactable (teléfono o email), salvo que se haya anonimizado
  CHECK (anonymized_at IS NOT NULL OR phone_e164 IS NOT NULL OR email IS NOT NULL)
);
CREATE UNIQUE INDEX uq_customers_phone ON customers (tenant_id, phone_e164) WHERE phone_e164 IS NOT NULL AND anonymized_at IS NULL;
CREATE INDEX ix_customers_email ON customers (tenant_id, email);
CREATE INDEX ix_customers_name_trgm ON customers USING gin ((lower(first_name || ' ' || coalesce(last_name, ''))) gin_trgm_ops);
CREATE TRIGGER trg_customers_updated BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION rp_set_updated_at();

-- ---------------------------------------------------------------------------
-- Reservas
-- ---------------------------------------------------------------------------
CREATE TABLE reservations (
  id                        uuid PRIMARY KEY,
  tenant_id                 uuid NOT NULL REFERENCES tenants(id),
  code                      varchar(12) NOT NULL,         -- legible para humanos (RP-XXXXXX); NO es una credencial
  location_id               uuid NOT NULL,
  customer_id               uuid NOT NULL,
  status                    text NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','confirmed','in_progress','completed','cancelled','no_show')),
  source                    text NOT NULL CHECK (source IN ('admin','public_web','whatsapp','api')),
  start_at                  timestamptz NOT NULL,           -- ventana que ve el cliente (sin preparación/limpieza)
  end_at                    timestamptz NOT NULL,
  time_zone                 varchar(60) NOT NULL,           -- zona con que se reservó (snapshot)
  total_amount              numeric(12,2) NOT NULL CHECK (total_amount >= 0),
  currency                  char(3) NOT NULL,
  paid_amount               numeric(12,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),  -- separado de lo reservado
  reschedule_count          int NOT NULL DEFAULT 0 CHECK (reschedule_count >= 0),
  hold_expires_at           timestamptz,
  customer_notes            varchar(1000),
  internal_notes            varchar(2000),
  cancelled_at              timestamptz,
  cancelled_by_type         text CHECK (cancelled_by_type IS NULL OR cancelled_by_type IN ('user','customer','system')),
  cancellation_reason       varchar(300),
  version                   int NOT NULL DEFAULT 1,         -- control de concurrencia optimista
  created_by_membership_id  uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  -- cancelada <=> tiene fecha de cancelación (en ambos sentidos)
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, location_id)              REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id)              REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by_membership_id) REFERENCES tenant_memberships (tenant_id, id)
);
CREATE INDEX ix_reservations_start    ON reservations (tenant_id, start_at);
CREATE INDEX ix_reservations_status   ON reservations (tenant_id, status, start_at);
CREATE INDEX ix_reservations_customer ON reservations (tenant_id, customer_id, start_at DESC);
CREATE INDEX ix_reservations_location ON reservations (tenant_id, location_id, start_at);
CREATE INDEX ix_reservations_holds    ON reservations (hold_expires_at) WHERE status = 'pending' AND hold_expires_at IS NOT NULL;
CREATE TRIGGER trg_reservations_updated BEFORE UPDATE ON reservations FOR EACH ROW EXECUTE FUNCTION rp_set_updated_at();

-- Lo reservado, con SNAPSHOT del servicio: el historial se conserva aunque el catálogo cambie después.
CREATE TABLE reservation_items (
  id                     uuid PRIMARY KEY,
  tenant_id              uuid NOT NULL,
  reservation_id         uuid NOT NULL,
  service_id             uuid NOT NULL,
  service_name           varchar(100) NOT NULL,
  duration_minutes       int NOT NULL CHECK (duration_minutes > 0),
  buffer_before_minutes  int NOT NULL CHECK (buffer_before_minutes >= 0),
  buffer_after_minutes   int NOT NULL CHECK (buffer_after_minutes >= 0),
  unit_price             numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  currency               char(3) NOT NULL,
  start_at               timestamptz NOT NULL,
  end_at                 timestamptz NOT NULL,
  position               smallint NOT NULL DEFAULT 1,
  CHECK (end_at > start_at),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, reservation_id) REFERENCES reservations (tenant_id, id),
  FOREIGN KEY (tenant_id, service_id)     REFERENCES services (tenant_id, id)
);
CREATE INDEX ix_reservation_items_reservation ON reservation_items (tenant_id, reservation_id);

-- Ocupación real de cada recurso: incluye preparación y limpieza (occupy_* abarca los buffers).
CREATE TABLE reservation_resources (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL,
  reservation_id       uuid NOT NULL,
  reservation_item_id  uuid NOT NULL,
  resource_id          uuid NOT NULL,
  units                int NOT NULL DEFAULT 1 CHECK (units >= 1),
  occupy_start         timestamptz NOT NULL,
  occupy_end           timestamptz NOT NULL,
  is_exclusive         boolean NOT NULL,                  -- capacidad 1 al reservar (ADR-006: único caso del MVP)
  is_active            boolean NOT NULL DEFAULT true,     -- false si la reserva se cancela (lo mantiene el trigger)
  CHECK (occupy_end > occupy_start),
  FOREIGN KEY (tenant_id, reservation_id)      REFERENCES reservations (tenant_id, id),
  FOREIGN KEY (tenant_id, reservation_item_id) REFERENCES reservation_items (tenant_id, id),
  FOREIGN KEY (tenant_id, resource_id)         REFERENCES resources (tenant_id, id),
  -- ★ ÚLTIMA BARRERA contra la doble reserva
  CONSTRAINT rr_no_overlap_exclusive EXCLUDE USING gist (
    resource_id WITH =,
    tstzrange(occupy_start, occupy_end, '[)') WITH &&
  ) WHERE (is_exclusive AND is_active)
);
CREATE INDEX ix_rr_resource_time ON reservation_resources (tenant_id, resource_id, occupy_start) WHERE is_active;
CREATE INDEX ix_rr_reservation   ON reservation_resources (tenant_id, reservation_id);

-- is_active se sincroniza con el estado de la reserva EN LA BASE DE DATOS: no puede divergir.
-- Solo 'cancelled' libera el recurso (completed/no_show siguen ocupando su tiempo pasado).
CREATE FUNCTION rp_sync_reservation_resources_active() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE reservation_resources
       SET is_active = (NEW.status <> 'cancelled')
     WHERE tenant_id = NEW.tenant_id AND reservation_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_reservations_sync_rr AFTER UPDATE OF status ON reservations
  FOR EACH ROW EXECUTE FUNCTION rp_sync_reservation_resources_active();

-- Historial inmutable de cada reserva.
CREATE TABLE reservation_events (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  reservation_id  uuid NOT NULL,
  type            text NOT NULL,
  actor_type      text NOT NULL CHECK (actor_type IN ('user','customer','system','whatsapp')),
  actor_id        uuid,
  channel         text,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, reservation_id) REFERENCES reservations (tenant_id, id)
);
CREATE INDEX ix_reservation_events ON reservation_events (tenant_id, reservation_id, occurred_at);

-- ---------------------------------------------------------------------------
-- Idempotencia: el mismo Idempotency-Key + mismo cuerpo devuelve la MISMA respuesta (doble clic, reintentos)
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  scope          text NOT NULL,
  key            varchar(100) NOT NULL,
  request_hash   bytea NOT NULL,
  status         text NOT NULL CHECK (status IN ('in_progress','completed')),
  response_code  int,
  response_body  jsonb,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope, key)
);
CREATE INDEX ix_idempotency_expires ON idempotency_keys (expires_at);

-- ---------------------------------------------------------------------------
-- Transactional outbox (ADR-005): el evento se escribe en la MISMA transacción que el cambio de negocio
-- ---------------------------------------------------------------------------
CREATE TABLE outbox_events (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  aggregate_type  text NOT NULL,
  aggregate_id    uuid NOT NULL,
  type            text NOT NULL,
  payload         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz,
  attempts        int NOT NULL DEFAULT 0,
  last_error      text
);
CREATE INDEX ix_outbox_pending ON outbox_events (created_at) WHERE published_at IS NULL;

-- ---------------------------------------------------------------------------
-- RLS en todas las tablas nuevas; inmutabilidad del historial para el runtime
-- ---------------------------------------------------------------------------
SELECT rp_enable_tenant_rls('customers');
SELECT rp_enable_tenant_rls('reservations');
SELECT rp_enable_tenant_rls('reservation_items');
SELECT rp_enable_tenant_rls('reservation_resources');
SELECT rp_enable_tenant_rls('reservation_events');
SELECT rp_enable_tenant_rls('idempotency_keys');
SELECT rp_enable_tenant_rls('outbox_events');

REVOKE UPDATE, DELETE ON reservation_events FROM rp_app;
