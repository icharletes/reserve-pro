-- ReservePro — Migración 0005: catálogo (sucursales, servicios, recursos) y agenda (horarios, excepciones,
-- feriados y bloqueos). Ver docs/architecture/ARCHITECTURE.md §4.4 y ADR-013.
--
-- Convenciones de esta migración:
--  * Toda tabla lleva tenant_id, UNIQUE (tenant_id, id) y FK COMPUESTAS (tenant_id, x_id): imposible referenciar
--    filas de otra empresa. RLS forzado vía rp_enable_tenant_rls (ADR-004).
--  * Los horarios son hora LOCAL de pared en MINUTOS desde medianoche (0..1440): sin el tipo `time` (ambiguo con
--    24:00 y zonas horarias) y sin depender del DST. La conversión a instantes UTC la hace el dominio.
--  * weekday es ISO-8601: 1 = lunes … 7 = domingo.
--  * Los solapes se impiden en la BASE DE DATOS con EXCLUDE USING gist (no solo en la aplicación).

-- ---------------------------------------------------------------------------
-- Sucursales
-- ---------------------------------------------------------------------------
CREATE TABLE locations (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  name        citext NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
  address     jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(address::text) <= 2000),
  phone       varchar(30),
  email       citext CHECK (email IS NULL OR char_length(email) <= 254),
  timezone    varchar(60),                      -- NULL = hereda la zona horaria de la empresa
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)                      -- citext: sin duplicados por mayúsculas
);
CREATE TRIGGER trg_locations_updated BEFORE UPDATE ON locations FOR EACH ROW EXECUTE FUNCTION rp_set_updated_at();

-- ---------------------------------------------------------------------------
-- Servicios
-- ---------------------------------------------------------------------------
CREATE TABLE service_categories (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  name        citext NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);
CREATE TRIGGER trg_service_categories_updated BEFORE UPDATE ON service_categories FOR EACH ROW EXECUTE FUNCTION rp_set_updated_at();

CREATE TABLE services (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  category_id           uuid,
  name                  citext NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
  description           text CHECK (description IS NULL OR char_length(description) <= 2000),
  duration_minutes      int NOT NULL CHECK (duration_minutes BETWEEN 1 AND 1440),
  buffer_before_minutes int NOT NULL DEFAULT 0 CHECK (buffer_before_minutes BETWEEN 0 AND 240),
  buffer_after_minutes  int NOT NULL DEFAULT 0 CHECK (buffer_after_minutes  BETWEEN 0 AND 240),
  price                 numeric(12,2) NOT NULL CHECK (price >= 0),
  currency              char(3) NOT NULL,       -- la fija el servidor (moneda de la empresa al crear); no viene del cliente
  min_notice_minutes    int CHECK (min_notice_minutes IS NULL OR min_notice_minutes >= 0),
  max_advance_days      int CHECK (max_advance_days IS NULL OR max_advance_days BETWEEN 1 AND 730),
  requires_confirmation boolean,                -- NULL = hereda tenant_settings.auto_confirm
  image_url             varchar(500),
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id, category_id) REFERENCES service_categories (tenant_id, id)
);
CREATE INDEX ix_services_tenant_active ON services (tenant_id, is_active);
CREATE TRIGGER trg_services_updated BEFORE UPDATE ON services FOR EACH ROW EXECUTE FUNCTION rp_set_updated_at();

CREATE TABLE service_locations (
  tenant_id    uuid NOT NULL,
  service_id   uuid NOT NULL,
  location_id  uuid NOT NULL,
  PRIMARY KEY (service_id, location_id),
  FOREIGN KEY (tenant_id, service_id)  REFERENCES services  (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
);
CREATE INDEX ix_service_locations_location ON service_locations (tenant_id, location_id);

-- ---------------------------------------------------------------------------
-- Profesionales y recursos
-- ---------------------------------------------------------------------------
CREATE TABLE resources (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  location_id         uuid NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('staff','room','equipment','vehicle','space')),
  name                citext NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
  capacity            int NOT NULL DEFAULT 1 CHECK (capacity >= 1),   -- el MVP solo admite 1 (ADR-006); lo valida la API
  membership_id       uuid,                                           -- vincula un profesional con su usuario
  is_bookable_online  boolean NOT NULL DEFAULT true,
  auto_assignable     boolean NOT NULL DEFAULT true,
  is_active           boolean NOT NULL DEFAULT true,
  sort_order          int NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, location_id, name),
  CHECK (membership_id IS NULL OR kind = 'staff'),                    -- solo una persona se vincula a un usuario
  FOREIGN KEY (tenant_id, location_id)   REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships (tenant_id, id)
);
-- un usuario es, como mucho, UN recurso de la empresa (su agenda personal)
CREATE UNIQUE INDEX uq_resources_membership ON resources (tenant_id, membership_id) WHERE membership_id IS NOT NULL;
CREATE INDEX ix_resources_location ON resources (tenant_id, location_id, is_active);
CREATE TRIGGER trg_resources_updated BEFORE UPDATE ON resources FOR EACH ROW EXECUTE FUNCTION rp_set_updated_at();

-- Compatibilidad servicio <-> recurso (qué recursos pueden prestar qué servicios).
CREATE TABLE service_resources (
  tenant_id         uuid NOT NULL,
  service_id        uuid NOT NULL,
  resource_id       uuid NOT NULL,
  requirement_slot  smallint NOT NULL DEFAULT 1,   -- permite servicios con varios recursos (p.ej. 1 staff + 1 sala)
  PRIMARY KEY (service_id, resource_id),
  FOREIGN KEY (tenant_id, service_id)  REFERENCES services  (tenant_id, id),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources (tenant_id, id)
);
CREATE INDEX ix_service_resources_resource ON service_resources (tenant_id, resource_id);

-- ---------------------------------------------------------------------------
-- Horarios semanales
-- ---------------------------------------------------------------------------
CREATE TABLE business_hours (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  location_id   uuid NOT NULL,
  weekday       smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_minute  smallint NOT NULL CHECK (start_minute >= 0),
  end_minute    smallint NOT NULL CHECK (end_minute <= 1440),
  CHECK (start_minute < end_minute),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id),
  -- Dos tramos del mismo día de la misma sucursal no pueden solaparse (tocarse sí: 09-13 y 13-18).
  CONSTRAINT business_hours_no_overlap EXCLUDE USING gist (
    location_id WITH =, weekday WITH =, int4range(start_minute::int, end_minute::int) WITH &&
  )
);
CREATE INDEX ix_business_hours_location ON business_hours (tenant_id, location_id, weekday);

CREATE TABLE resource_schedules (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  resource_id   uuid NOT NULL,
  weekday       smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_minute  smallint NOT NULL CHECK (start_minute >= 0),
  end_minute    smallint NOT NULL CHECK (end_minute <= 1440),
  valid_from    date,                                -- NULL = sin límite inferior
  valid_to      date,                                -- NULL = sin límite superior
  CHECK (start_minute < end_minute),
  CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_from <= valid_to),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources (tenant_id, id),
  -- Solape = mismo recurso + mismo día + tramos que se pisan + vigencias que se pisan.
  CONSTRAINT resource_schedules_no_overlap EXCLUDE USING gist (
    resource_id WITH =, weekday WITH =,
    int4range(start_minute::int, end_minute::int) WITH &&,
    daterange(valid_from, valid_to, '[]') WITH &&
  )
);
CREATE INDEX ix_resource_schedules_resource ON resource_schedules (tenant_id, resource_id, weekday);

-- ---------------------------------------------------------------------------
-- Excepciones por fecha (de una sucursal o de un recurso) y feriados
-- ---------------------------------------------------------------------------
-- Un día cerrado se guarda como un tramo 0-1440 con is_closed. Así la MISMA restricción de exclusión impide
-- mezclar "cerrado" con tramos abiertos el mismo día, sin lógica extra.
CREATE TABLE schedule_overrides (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  location_id   uuid,
  resource_id   uuid,
  on_date       date NOT NULL,
  is_closed     boolean NOT NULL DEFAULT false,
  start_minute  smallint NOT NULL CHECK (start_minute >= 0),
  end_minute    smallint NOT NULL CHECK (end_minute <= 1440),
  reason        varchar(200),
  CHECK (num_nonnulls(location_id, resource_id) = 1),                  -- de una sucursal O de un recurso
  CHECK (start_minute < end_minute),
  CHECK (NOT is_closed OR (start_minute = 0 AND end_minute = 1440)),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources (tenant_id, id),
  CONSTRAINT schedule_overrides_no_overlap EXCLUDE USING gist (
    (COALESCE(resource_id, location_id)) WITH =, on_date WITH =, int4range(start_minute::int, end_minute::int) WITH &&
  )
);
CREATE INDEX ix_schedule_overrides_date ON schedule_overrides (tenant_id, on_date);

CREATE TABLE holidays (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  on_date    date NOT NULL,
  name       varchar(100) NOT NULL CHECK (char_length(name) >= 2),
  PRIMARY KEY (tenant_id, on_date)
);

-- ---------------------------------------------------------------------------
-- Bloqueos puntuales (ausencias, mantenimiento…) en instantes UTC
-- ---------------------------------------------------------------------------
CREATE TABLE availability_blocks (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  resource_id  uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('time_off','maintenance','manual','break')),
  start_at     timestamptz NOT NULL,
  end_at       timestamptz NOT NULL,
  reason       varchar(200),
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  CHECK (end_at - start_at <= interval '366 days'),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources (tenant_id, id)
);
CREATE INDEX ix_blocks_resource_time ON availability_blocks (tenant_id, resource_id, start_at, end_at);

-- ---------------------------------------------------------------------------
-- RLS en TODAS las tablas con tenant_id (un test de catálogo lo verifica)
-- ---------------------------------------------------------------------------
SELECT rp_enable_tenant_rls('locations');
SELECT rp_enable_tenant_rls('service_categories');
SELECT rp_enable_tenant_rls('services');
SELECT rp_enable_tenant_rls('service_locations');
SELECT rp_enable_tenant_rls('resources');
SELECT rp_enable_tenant_rls('service_resources');
SELECT rp_enable_tenant_rls('business_hours');
SELECT rp_enable_tenant_rls('resource_schedules');
SELECT rp_enable_tenant_rls('schedule_overrides');
SELECT rp_enable_tenant_rls('holidays');
SELECT rp_enable_tenant_rls('availability_blocks');
