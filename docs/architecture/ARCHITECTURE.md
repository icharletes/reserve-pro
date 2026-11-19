# ReservePro — Arquitectura técnica definitiva (v1.0, para aprobación)

> Estado: **propuesta para revisión**. No existe código aún (el repo solo contiene `reservepro_blueprint_claude.md`).
> Fuente: blueprint v. inicial. Este documento lo **concreta y, donde se indica, lo corrige** (ver §1.3).
> Convención: código, tablas y endpoints en inglés; UI en español.

---

## 0. Resumen ejecutivo

| Tema | Decisión |
|---|---|
| Estilo | Monolito modular NestJS + proceso worker (mismo código, segundo entrypoint) |
| Frontend | `apps/web` Astro+Vue (portal público SSR) y `apps/admin` Vue 3 SPA (panel). Ver ADR-001 |
| Multi-tenant | BD y esquema compartidos, `tenant_id` en todo, **FK compuestas + RLS forzado + contexto por transacción** |
| Autoridad de tenant | Claim `tid` en el access token, validado contra membresía; nunca un header libre |
| RBAC | Catálogo de permisos en código, roles materializados por tenant, `super_admin` fuera del modelo de tenants |
| Anti doble reserva | Bloqueo ordenado de filas de recurso + **constraint `EXCLUDE USING gist`** como última barrera + idempotencia |
| Notificaciones | Transactional outbox → BullMQ; dedupe por clave única |
| WhatsApp | Un WABA/número por tenant; webhook → `webhook_events` (dedupe) → worker |
| ORM | Prisma para CRUD; **SQL crudo** para el motor de reservas, RLS y constraints (Prisma no los soporta) |

---

## 1. Monorepo

### 1.1 Estructura final

```text
reservepro/
├── apps/
│   ├── api/                      # NestJS: HTTP (main.ts) y worker (worker.ts)
│   │   └── src/
│   │       ├── main.ts           # bootstrap HTTP
│   │       ├── worker.ts         # bootstrap BullMQ processors (mismos módulos)
│   │       ├── app.module.ts / worker.module.ts
│   │       ├── common/           # filters, interceptors, pipes, decorators, errores
│   │       ├── platform/         # infraestructura transversal (ver §5)
│   │       └── modules/          # módulos de negocio (ver §5)
│   ├── web/                      # Astro + Vue islands: portal público /{slug}
│   └── admin/                    # Vue 3 + Vite + Vue Router + Pinia: panel y consola SaaS
├── packages/
│   ├── database/                 # schema.prisma, migraciones SQL, seeds, extensión de tenancy
│   ├── contracts/                # Zod schemas + tipos inferidos (fusiona shared-types + validation)
│   ├── api-client/               # cliente tipado generado desde OpenAPI
│   ├── booking-domain/           # funciones PURAS: generación de slots, máquina de estados, políticas
│   ├── ui/                       # componentes Vue reutilizables (web + admin)
│   └── config/                   # tsconfig, eslint (con boundaries), prettier, vitest base
├── docs/{product,architecture,database,api,security,decisions}/
├── docker/  docker-compose.yml  pnpm-workspace.yaml  turbo.json  CLAUDE.md  README.md
```

### 1.2 Reglas de dependencia (se aplican con ESLint `boundaries` + `turbo` en CI)

```text
apps/*  →  packages/*            (nunca al revés)
booking-domain  →  (nada; sin Nest, sin Prisma, sin I/O)
contracts       →  (solo zod)
database        →  (solo prisma/pg)
api             →  database, contracts, booking-domain
web / admin     →  contracts, api-client, ui          (NUNCA database ni booking-domain)
```

`booking-domain` puro es la pieza clave de testeabilidad: el motor de slots, políticas de cancelación y máquina de estados se prueban con property-based tests (fast-check) sin base de datos.

### 1.3 Desviaciones del blueprint (justificadas)

| Blueprint | Propuesta | Motivo |
|---|---|---|
| `apps/worker` separado | Segundo entrypoint de `apps/api` (`worker.ts`) | El worker procesa interacciones de WhatsApp que ejecutan casos de uso de `reservations` y `availability`. Un paquete separado obligaría a duplicar o a extraer el 80 % del backend. Se despliega como contenedor distinto: sigue siendo "worker separado" operativamente. |
| `database/` raíz | `packages/database` | Prisma Client y la extensión de tenancy se importan desde código TS; debe ser un paquete del workspace. |
| `shared-types` + `validation` | `contracts` | Con Zod los tipos se infieren del esquema; mantener dos paquetes genera deriva. |
| Panel dentro de Astro | `apps/admin` SPA | Ver ADR-001. Si se prefiere Astro para todo, el cambio no afecta al resto de la arquitectura. |
| `booking-domain` (nuevo) | — | Aísla la lógica crítica y pura. |

### 1.4 Tooling

pnpm workspaces + Turborepo (cache de `build`, `lint`, `test`, `typecheck`). TypeScript `strict` + `noUncheckedIndexedAccess`. Node LTS fijado en `.nvmrc`/`engines`. Docker Compose local: `postgres:16` (con `btree_gist`, `citext`, `pg_trgm`), `redis:7`, `mailpit` (email local), `pgbouncer` opcional para reproducir el pooling de producción. CI: lint → typecheck → unit → integration (Testcontainers Postgres) → e2e Playwright → comprobación de migraciones.

---

## 2. Estrategia multi-tenant

### 2.1 Modelo
Esquema compartido; **toda** tabla de negocio lleva `tenant_id uuid NOT NULL`. Tres capas de defensa independientes (si falla una, las otras contienen el daño):

1. **Aplicación**: `TenantContext` (AsyncLocalStorage vía `nestjs-cls`) + guards. El `tenantId` nunca sale del body/query.
2. **Integridad referencial**: FK compuestas `(tenant_id, x_id) → (tenant_id, id)`. Imposible referenciar una fila de otro tenant, aunque haya un bug de aplicación.
3. **RLS en PostgreSQL con `FORCE ROW LEVEL SECURITY`**: aunque una query olvide el `WHERE tenant_id`, la BD no devuelve filas ajenas.

### 2.2 Resolución del tenant activo
- Login → el usuario obtiene sus membresías. El access token JWT (10–15 min) incluye `sub` (user), `sid` (sesión), `tid` (tenant activo), `mid` (membership).
- Cambiar de empresa = `POST /auth/switch-tenant {tenantId}` → backend valida membresía activa y emite nuevo token. **No** existe `X-Tenant-Id` libre.
- Endpoints públicos: el tenant se resuelve por `slug` (o dominio propio) en el servidor; el contexto se fija igual que en el flujo autenticado.
- Jobs: el payload incluye `tenantId`; el processor llama a `TenantContext.run(tenantId, …)` y **valida que el recurso referenciado pertenece al tenant** (RLS lo garantiza igualmente).
- Webhooks entrantes (sin tenant): se resuelve por `phone_number_id → whatsapp_accounts` usando el rol de sistema (§2.4), luego se entra al contexto del tenant.

### 2.3 Cómo se aplica RLS con Prisma y pooling
Cada request autenticado/público ejecuta su trabajo dentro de **una transacción** donde la primera sentencia es:

```sql
SELECT set_config('app.tenant_id', $1, true);   -- true = LOCAL a la transacción
```

Se implementa con una **Prisma Client Extension** (`$allOperations` envuelve en `$transaction` interactiva) expuesta como `TenantPrismaService`. Usar `SET LOCAL` (no `SET` de sesión) es lo que hace el esquema **seguro con PgBouncer en modo transaction** y evita fugas de contexto entre conexiones del pool.

Política estándar (generada por una función helper en migraciones, para no repetirla a mano):

```sql
ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservations FORCE  ROW LEVEL SECURITY;   -- aplica también al dueño de la tabla
CREATE POLICY tenant_isolation ON reservations
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
```

Si el contexto no está definido, `NULLIF(...)` da `NULL` y la comparación no devuelve filas: **falla cerrado**.

### 2.4 Roles de base de datos

| Rol | Uso | RLS |
|---|---|---|
| `rp_owner` | Migraciones (dueño del esquema). Solo CI/deploy. | Bypass (dueño) |
| `rp_app` | API y worker en operación normal | **Aplica** (sin `BYPASSRLS`, no superuser) |
| `rp_system` | Tareas acotadas cross-tenant: publisher del outbox, resolución de webhooks por `phone_number_id`, expiración de holds, consola SaaS | `BYPASSRLS`, con `GRANT` mínimo por tabla |

`rp_system` es el punto de mayor riesgo: se usa solo desde un `SystemPrismaService` explícito, con código revisado y auditado, nunca desde controladores de tenant.

### 2.5 Controles automáticos (CI)
- **Test de catálogo**: consulta `information_schema` y falla si existe una tabla con columna `tenant_id` sin RLS habilitado/forzado o sin política, o sin FK compuestas a sus padres tenant-scoped.
- **Suite de fuga**: para cada endpoint de listado/detalle, autenticar como tenant A e intentar leer/mutar ids de B → esperar 404 (no 403, para no filtrar existencia).
- Test de worker: un job con `tenantId=A` y `reservationId` de B no puede operar.

### 2.6 Tablas globales (sin `tenant_id`)
`users`, `refresh_tokens`, `permissions`, `plans`, `webhook_events` (hasta resolver tenant), `tenants` (acceso por slug/ids vía función `SECURITY DEFINER` o rol de sistema). Todo lo demás es tenant-scoped.

---

## 3. RBAC

### 3.1 Principios
- Autorización por **permiso**, no por rol: `@RequirePermissions('reservations:cancel')`.
- Catálogo de permisos definido **en código** (`permissions.catalog.ts`) y sincronizado a la tabla `permissions` en cada deploy.
- Los **roles son por tenant**: al crear la empresa se materializan los roles de sistema (`owner`, `admin`, `manager`, `receptionist`, `professional`) copiando plantillas versionadas en código. Permite roles personalizados después sin cambiar el modelo, y mantiene las FK compuestas limpias. Una migración de datos sincroniza roles de sistema cuando cambia la plantilla.
- `super_admin` **no es un rol de tenant**: es `users.is_platform_admin`, con guard y rutas separadas (`/api/v1/platform/*`), usa `rp_system`, y toda acción se audita con `tenant_id` objetivo.
- Alcance `own`: `professional` ve solo reservas de su recurso (`resources.membership_id = mid`). Se modela como permisos con sufijo (`reservations:read:own`) y el servicio aplica el filtro; no es un `if` suelto en controladores.
- Permisos efectivos = unión de permisos de los roles de la membresía; se cachean en Redis (TTL corto, invalidación al cambiar roles/estado de membresía). Desactivar un usuario revoca sesiones (`refresh_tokens.revoked_at`) y su `sid`.

### 3.2 Catálogo inicial de permisos
```
tenant:read  tenant:update  members:read  members:invite  members:update  roles:manage
locations:read|write   services:read|write   resources:read|write
schedules:read|write   blocks:read|write
customers:read|write|export|erase
reservations:read | reservations:read:own | reservations:create | reservations:update
reservations:confirm | reservations:cancel | reservations:reschedule | reservations:status
calendar:read | calendar:read:own
notifications:read   integrations:read|manage   consents:read|write
reports:read   audit:read   billing:manage
```

### 3.3 Matriz por defecto
| Permiso (grupo) | owner | admin | manager | receptionist | professional |
|---|---|---|---|---|---|
| tenant / members / roles / integrations / billing | ✔ | ✔ (sin billing) | – | – | – |
| catálogo (locations/services/resources/schedules/blocks) | ✔ | ✔ | ✔ | lectura | lectura propia |
| customers (rw) | ✔ | ✔ | ✔ | ✔ | lectura de sus clientes |
| customers export/erase | ✔ | ✔ | – | – | – |
| reservations (todas) | ✔ | ✔ | ✔ | ✔ | solo `:own` |
| reports / audit | ✔ | ✔ | reports | – | – |

### 3.4 Modelo de datos RBAC
`permissions(key PK)`, `roles(id, tenant_id, key, name, is_system)`, `role_permissions(tenant_id, role_id, permission_key)`, `membership_roles(tenant_id, membership_id, role_id)`. Ver DDL en §4.

---

## 4. Modelo relacional PostgreSQL

### 4.1 Convenciones
- PK `uuid` (UUIDv7 generado en la app → inserciones ordenadas por tiempo, mejor localidad de índice que v4).
- Todo tenant-scoped: `tenant_id`, `UNIQUE (tenant_id, id)` (ancla para FK compuestas), `created_at/updated_at timestamptz`.
- Enumeraciones como `text` + `CHECK` (migrar valores es trivial; los `ENUM` de PG son incómodos de alterar).
- Dinero `numeric(12,2)` + `currency char(3)`. Instantes `timestamptz` en UTC. Horarios recurrentes como `time` **local** + zona IANA (§7.5).
- `ON DELETE RESTRICT` en todo lo histórico. Borrado lógico (`deleted_at`/`is_active`) en catálogo; las reservas **no se borran**.
- Extensiones: `btree_gist`, `citext`, `pg_trgm`, `pgcrypto`.

### 4.2 Diagrama (resumen)

```text
tenants ─┬─ tenant_settings (1:1)
         ├─ tenant_memberships ── users
         │        └─ membership_roles ── roles ── role_permissions ── permissions
         ├─ locations ─┬─ resources ── resource_schedules
         │             ├─ business_hours
         │             └─ service_locations ── services ── service_categories
         ├─ services ── service_resources ── resources
         ├─ availability_blocks / schedule_overrides / holidays
         ├─ customers ── notification_consents / notification_preferences
         ├─ reservations ─┬─ reservation_items (snapshots)
         │                ├─ reservation_resources  ◄── EXCLUDE gist (anti doble reserva)
         │                ├─ reservation_events (append-only)
         │                └─ reservation_access_tokens
         ├─ notifications / whatsapp_messages / notification_templates
         ├─ whatsapp_accounts / whatsapp_templates / whatsapp_flow_sessions
         ├─ outbox_events / idempotency_keys / audit_logs
```

### 4.3 DDL — núcleo SaaS y acceso

```sql
CREATE TABLE tenants (
  id          uuid PRIMARY KEY,
  name        varchar(150) NOT NULL,
  legal_name  varchar(200),
  tax_id      varchar(30),
  slug        citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{1,48})[a-z0-9]$'),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','cancelled')),
  timezone    varchar(60) NOT NULL DEFAULT 'America/Santiago',
  currency    char(3) NOT NULL DEFAULT 'CLP',
  plan_id     uuid,                       -- fase 8
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- slugs reservados (admin, api, app, www, public, static…) se validan en la app y con tabla `reserved_slugs`.

CREATE TABLE tenant_settings (
  tenant_id                    uuid PRIMARY KEY REFERENCES tenants(id),
  booking_min_notice_minutes   int  NOT NULL DEFAULT 60  CHECK (booking_min_notice_minutes >= 0),
  booking_max_advance_days     int  NOT NULL DEFAULT 90  CHECK (booking_max_advance_days > 0),
  slot_step_minutes            int  NOT NULL DEFAULT 15  CHECK (slot_step_minutes BETWEEN 5 AND 240),
  auto_confirm                 boolean NOT NULL DEFAULT true,
  pending_hold_minutes         int  NOT NULL DEFAULT 30,
  cancel_window_hours          int  NOT NULL DEFAULT 24,
  cancel_requires_approval     boolean NOT NULL DEFAULT false,
  reschedule_window_hours      int  NOT NULL DEFAULT 24,
  max_reschedules              int  NOT NULL DEFAULT 2,
  self_service_actions         jsonb NOT NULL DEFAULT '{"confirm":true,"cancel":true,"reschedule":true,"details":true}',
  branding                     jsonb NOT NULL DEFAULT '{}',
  updated_at                   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY, email citext NOT NULL UNIQUE, password_hash text NOT NULL,   -- argon2id
  full_name varchar(150) NOT NULL, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  is_platform_admin boolean NOT NULL DEFAULT false, email_verified_at timestamptz,
  failed_logins int NOT NULL DEFAULT 0, locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (            -- rotación + detección de reutilización por familia
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  family_id uuid NOT NULL, token_hash bytea NOT NULL UNIQUE,       -- SHA-256, jamás el token
  active_tenant_id uuid REFERENCES tenants(id),   -- global por usuario: no se llama tenant_id para no confundirla con tablas RLS
  expires_at timestamptz NOT NULL, revoked_at timestamptz, replaced_by uuid,
  ip inet, user_agent text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON refresh_tokens (family_id);
CREATE INDEX ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

CREATE TABLE tenant_memberships (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, user_id)
);

CREATE TABLE permissions (key text PRIMARY KEY, description text NOT NULL);
CREATE TABLE roles (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
  key text NOT NULL, name text NOT NULL, is_system boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, key)
);
CREATE TABLE role_permissions (
  tenant_id uuid NOT NULL, role_id uuid NOT NULL, permission_key text NOT NULL REFERENCES permissions(key),
  PRIMARY KEY (role_id, permission_key),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE membership_roles (
  tenant_id uuid NOT NULL, membership_id uuid NOT NULL, role_id uuid NOT NULL,
  PRIMARY KEY (membership_id, role_id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, role_id)       REFERENCES roles (tenant_id, id)
);
CREATE TABLE invitations (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), email citext NOT NULL,
  role_id uuid NOT NULL, token_hash bytea NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
  accepted_at timestamptz, invited_by uuid NOT NULL,
  UNIQUE (tenant_id, id), FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id)
);
```

### 4.4 DDL — catálogo y agenda

> **Actualización (Fase 2, ADR-013):** el DDL de abajo es el borrador inicial. La implementación real difiere en: horarios como
> `start_minute`/`end_minute` (0–1440) en lugar de `time`; `weekday` ISO 1–7 (no 0–6); `name` como `citext` único por empresa;
> restricciones `EXCLUDE` contra solapes; `holidays` como tabla propia; excepciones con `is_closed` + tramo 0–1440. La fuente
> de verdad es `packages/database/prisma/migrations/`.



```sql
CREATE TABLE locations (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
  name varchar(150) NOT NULL, address jsonb NOT NULL DEFAULT '{}', phone varchar(30), email citext,
  timezone varchar(60),                       -- NULL = hereda del tenant
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE service_categories (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), name varchar(100) NOT NULL, sort_order int NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id)
);

CREATE TABLE services (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), category_id uuid,
  name varchar(150) NOT NULL, description text,
  duration_minutes   int NOT NULL CHECK (duration_minutes > 0),
  buffer_before_min  int NOT NULL DEFAULT 0 CHECK (buffer_before_min >= 0),
  buffer_after_min   int NOT NULL DEFAULT 0 CHECK (buffer_after_min  >= 0),
  price numeric(12,2) NOT NULL CHECK (price >= 0), currency char(3) NOT NULL,
  min_notice_minutes int, max_advance_days int,            -- NULL = hereda del tenant
  requires_confirmation boolean,                           -- NULL = hereda auto_confirm
  is_active boolean NOT NULL DEFAULT true, image_url text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), FOREIGN KEY (tenant_id, category_id) REFERENCES service_categories (tenant_id, id)
);

CREATE TABLE service_locations (
  tenant_id uuid NOT NULL, service_id uuid NOT NULL, location_id uuid NOT NULL,
  PRIMARY KEY (service_id, location_id),
  FOREIGN KEY (tenant_id, service_id)  REFERENCES services  (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
);

CREATE TABLE resources (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), location_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('staff','room','equipment','vehicle','space')),
  name varchar(150) NOT NULL, capacity int NOT NULL DEFAULT 1 CHECK (capacity >= 1),
  membership_id uuid,                    -- vincula un profesional con su usuario
  is_bookable_online boolean NOT NULL DEFAULT true, auto_assignable boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true, sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id)   REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships (tenant_id, id)
);

-- compatibilidad servicio <-> recurso. role_index permite servicios con varios recursos (p.ej. 1 staff + 1 room)
CREATE TABLE service_resources (
  tenant_id uuid NOT NULL, service_id uuid NOT NULL, resource_id uuid NOT NULL,
  requirement_slot smallint NOT NULL DEFAULT 1,
  PRIMARY KEY (service_id, resource_id),
  FOREIGN KEY (tenant_id, service_id)  REFERENCES services  (tenant_id, id),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources (tenant_id, id)
);

-- horarios semanales (hora LOCAL del tenant/sucursal; la conversión a UTC la hace el dominio)
CREATE TABLE business_hours (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, location_id uuid NOT NULL,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6), start_time time NOT NULL, end_time time NOT NULL,
  CHECK (end_time > start_time), FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
);
CREATE TABLE resource_schedules (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, resource_id uuid NOT NULL,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6), start_time time NOT NULL, end_time time NOT NULL,
  valid_from date, valid_to date, CHECK (end_time > start_time),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources (tenant_id, id)
);
-- excepciones por fecha: abrir horario extra o cerrar un día (feriado, vacaciones)
CREATE TABLE schedule_overrides (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, location_id uuid, resource_id uuid,
  on_date date NOT NULL, is_closed boolean NOT NULL DEFAULT false, start_time time, end_time time, reason text,
  CHECK (is_closed OR (start_time IS NOT NULL AND end_time > start_time)),
  CHECK (location_id IS NOT NULL OR resource_id IS NOT NULL)
);
-- bloqueos puntuales en instantes UTC (ausencias, mantenimiento, bloqueo manual, descansos puntuales)
CREATE TABLE availability_blocks (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, resource_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('time_off','maintenance','manual','break')),
  start_at timestamptz NOT NULL, end_at timestamptz NOT NULL, reason text, created_by uuid,
  CHECK (end_at > start_at), UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources (tenant_id, id)
);
```
Un bloqueo "de toda la sucursal" se expande a una fila por recurso al crearlo (simplifica consultas y el bloqueo transaccional).

### 4.5 DDL — clientes

```sql
CREATE TABLE customers (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
  first_name varchar(100) NOT NULL, last_name varchar(100),
  phone_e164 varchar(16) CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'), email citext,
  internal_notes text, anonymized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX uq_customers_tenant_phone ON customers (tenant_id, phone_e164) WHERE phone_e164 IS NOT NULL AND anonymized_at IS NULL;
CREATE INDEX ix_customers_tenant_email ON customers (tenant_id, email);
CREATE INDEX ix_customers_name_trgm ON customers USING gin ((first_name || ' ' || coalesce(last_name,'')) gin_trgm_ops);
```
El cliente es **por tenant** (el mismo teléfono en dos empresas son dos filas distintas): evita fugas entre negocios y simplifica la eliminación por solicitud.

### 4.6 DDL — reservas (núcleo)

```sql
CREATE TABLE reservations (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,                                  -- legible (p.ej. RP-7K3M9Q); NO es credencial
  location_id uuid NOT NULL, customer_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','confirmed','in_progress','completed','cancelled','no_show')),
  source text NOT NULL CHECK (source IN ('public_web','admin','whatsapp','api')),
  start_at timestamptz NOT NULL, end_at timestamptz NOT NULL,    -- ventana visible al cliente
  time_zone varchar(60) NOT NULL,                                -- snapshot de la zona usada
  total_amount numeric(12,2) NOT NULL CHECK (total_amount >= 0), currency char(3) NOT NULL,
  paid_amount  numeric(12,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),   -- separado del importe reservado
  reschedule_count int NOT NULL DEFAULT 0, hold_expires_at timestamptz,
  customer_notes text, internal_notes text,
  cancelled_at timestamptz, cancelled_by_type text, cancellation_reason text,
  version int NOT NULL DEFAULT 1,                                -- optimistic locking
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id)
);

CREATE TABLE reservation_items (            -- SNAPSHOT del servicio al momento de reservar
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, reservation_id uuid NOT NULL, service_id uuid NOT NULL,
  service_name varchar(150) NOT NULL, duration_minutes int NOT NULL, buffer_before_min int NOT NULL, buffer_after_min int NOT NULL,
  unit_price numeric(12,2) NOT NULL, currency char(3) NOT NULL,
  start_at timestamptz NOT NULL, end_at timestamptz NOT NULL, position smallint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, reservation_id) REFERENCES reservations (tenant_id, id),
  FOREIGN KEY (tenant_id, service_id)     REFERENCES services     (tenant_id, id)
);

CREATE TABLE reservation_resources (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, reservation_id uuid NOT NULL, reservation_item_id uuid NOT NULL, resource_id uuid NOT NULL,
  units int NOT NULL DEFAULT 1 CHECK (units >= 1),
  occupy_start timestamptz NOT NULL,         -- start_at - buffer_before
  occupy_end   timestamptz NOT NULL,         -- end_at   + buffer_after
  is_exclusive boolean NOT NULL,             -- true si resources.capacity = 1 al reservar
  is_active    boolean NOT NULL DEFAULT true,-- false cuando la reserva se cancela (trigger, ver abajo)
  CHECK (occupy_end > occupy_start),
  FOREIGN KEY (tenant_id, reservation_id)      REFERENCES reservations      (tenant_id, id),
  FOREIGN KEY (tenant_id, reservation_item_id) REFERENCES reservation_items (tenant_id, id),
  FOREIGN KEY (tenant_id, resource_id)         REFERENCES resources         (tenant_id, id),
  -- ★ ÚLTIMA BARRERA contra doble reserva (recursos de capacidad 1)
  CONSTRAINT rr_no_overlap_exclusive EXCLUDE USING gist (
      resource_id WITH =,
      tstzrange(occupy_start, occupy_end, '[)') WITH &&
  ) WHERE (is_exclusive AND is_active)
);
CREATE INDEX ix_rr_resource_time ON reservation_resources (tenant_id, resource_id, occupy_start) WHERE is_active;

-- is_active se sincroniza con el estado de la reserva EN LA BD, no en la app (no puede divergir)
CREATE FUNCTION sync_reservation_resources_active() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE reservation_resources SET is_active = (NEW.status <> 'cancelled')
     WHERE tenant_id = NEW.tenant_id AND reservation_id = NEW.id;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_sync_rr_active AFTER UPDATE OF status ON reservations
  FOR EACH ROW EXECUTE FUNCTION sync_reservation_resources_active();
```

Notas de diseño:
- `completed` y `no_show` siguen ocupando (son pasadas; no afecta y preserva el histórico de ocupación). Solo `cancelled` libera.
- Si un cancelado se "reactiva", el `UPDATE` de `is_active=true` puede violar el constraint → se mapea a `SLOT_UNAVAILABLE`. Correcto y deseable.
- Holds: una reserva `pending` con `hold_expires_at` ocupa el recurso; un job de `rp_system` la pasa a `cancelled` (`reason='hold_expired'`) al vencer.
- **Capacidad > 1**: el constraint no aplica (`is_exclusive=false`). Ver §6.6.

```sql
CREATE TABLE reservation_events (            -- append-only
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, reservation_id uuid NOT NULL,
  type text NOT NULL,                        -- reservation.created|confirmed|cancelled|rescheduled|status_changed|...
  actor_type text NOT NULL CHECK (actor_type IN ('user','customer','system','whatsapp')),
  actor_id uuid, channel text, payload jsonb NOT NULL DEFAULT '{}', occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, reservation_id) REFERENCES reservations (tenant_id, id)
);
REVOKE UPDATE, DELETE ON reservation_events FROM rp_app;     -- inmutable para la app

CREATE TABLE reservation_access_tokens (      -- enlaces de autogestión
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, reservation_id uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE,           -- SHA-256 de un token de 256 bits; el token solo viaja en el enlace
  scope text[] NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz, last_used_at timestamptz,
  FOREIGN KEY (tenant_id, reservation_id) REFERENCES reservations (tenant_id, id)
);

CREATE TABLE idempotency_keys (
  tenant_id uuid NOT NULL, scope text NOT NULL, key text NOT NULL, request_hash bytea NOT NULL,
  status text NOT NULL CHECK (status IN ('in_progress','completed')), response_code int, response_body jsonb,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope, key)
);
```

### 4.7 DDL — comunicaciones, integraciones, control

```sql
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, aggregate_type text NOT NULL, aggregate_id uuid NOT NULL,
  type text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz, attempts int NOT NULL DEFAULT 0, last_error text
);
CREATE INDEX ix_outbox_pending ON outbox_events (created_at) WHERE published_at IS NULL;

CREATE TABLE notifications (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, reservation_id uuid, customer_id uuid,
  channel text NOT NULL CHECK (channel IN ('email','whatsapp')), type text NOT NULL, recipient text NOT NULL,
  dedupe_key text NOT NULL,                              -- hash(evento, canal, destinatario, tipo)
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','delivered','read','failed','suppressed')),
  attempts int NOT NULL DEFAULT 0, last_error text, provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, dedupe_key)
);
CREATE INDEX ix_notifications_tenant_status ON notifications (tenant_id, status, created_at DESC);

CREATE TABLE notification_consents (          -- historial; el estado vigente = última fila por (cliente, canal, finalidad)
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, customer_id uuid NOT NULL,
  channel text NOT NULL, purpose text NOT NULL CHECK (purpose IN ('transactional','marketing')),
  status text NOT NULL CHECK (status IN ('granted','revoked')), source text NOT NULL,
  evidence_version text, evidence_ip inet, occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE whatsapp_accounts (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL UNIQUE, waba_id text NOT NULL, phone_number_id text NOT NULL UNIQUE,
  display_phone text, status text NOT NULL DEFAULT 'pending',
  access_token_enc bytea NOT NULL, key_version smallint NOT NULL,      -- cifrado envolvente (AES-256-GCM, clave en KMS/secret manager)
  connected_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE whatsapp_templates (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, name text NOT NULL, language text NOT NULL,
  category text NOT NULL, status text NOT NULL, provider_template_id text, UNIQUE (tenant_id, name, language));
CREATE TABLE whatsapp_messages (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, notification_id uuid, direction text NOT NULL,
  provider_message_id text, status text NOT NULL, error_code text, payload jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_message_id));
CREATE TABLE whatsapp_flow_sessions (          -- estado de la conversación de autogestión
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, customer_id uuid NOT NULL, reservation_id uuid NOT NULL,
  state text NOT NULL, context jsonb NOT NULL DEFAULT '{}', expires_at timestamptz NOT NULL);
CREATE TABLE webhook_events (                  -- global: dedupe antes de conocer el tenant
  id uuid PRIMARY KEY, provider text NOT NULL, external_id text NOT NULL, tenant_id uuid, payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, error text, UNIQUE (provider, external_id));

CREATE TABLE audit_logs (                      -- append-only; particionable por mes
  id uuid NOT NULL, tenant_id uuid, actor_type text NOT NULL, actor_id uuid, action text NOT NULL,
  entity_type text NOT NULL, entity_id uuid, before jsonb, after jsonb, request_id text, ip inet,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX ON audit_logs (tenant_id, entity_type, entity_id);
```
Las tablas `notification_templates`, `notification_preferences`, `plans`, `saas_subscriptions` siguen el mismo patrón y se definen en su fase.

### 4.8 Índices clave (resumen)

| Tabla | Índice | Para qué |
|---|---|---|
| reservations | `(tenant_id, start_at)`, `(tenant_id, status, start_at)`, `(tenant_id, customer_id, start_at DESC)`, `(tenant_id, location_id, start_at)` | calendario, listados, historial por cliente |
| reservations | parcial `(hold_expires_at) WHERE status='pending' AND hold_expires_at IS NOT NULL` | job de expiración |
| reservation_resources | GiST de exclusión + `(tenant_id, resource_id, occupy_start) WHERE is_active` | integridad + lectura de ocupación |
| availability_blocks | `(tenant_id, resource_id, start_at, end_at)` | slots |
| resource_schedules / business_hours | `(tenant_id, resource_id, weekday)` / `(tenant_id, location_id, weekday)` | slots |
| customers | únicos/trgm de §4.5 | dedupe por teléfono, búsqueda |
| notifications | `(tenant_id, dedupe_key)` único; `(tenant_id, status, created_at)` | idempotencia y centro de comunicaciones |
| outbox_events | parcial por `published_at IS NULL` | publisher |
| webhook_events | `(provider, external_id)` único | dedupe |
| audit_logs / reservation_events | `(tenant_id, …, created_at)` | consulta de historial |

Validar con `EXPLAIN (ANALYZE, BUFFERS)` sobre datos sintéticos (≥ 1 M reservas) antes de añadir índices adicionales.

---

## 5. Estructura de módulos NestJS

### 5.1 Capas transversales (`platform/`)
`config` (validación de env con Zod, fail-fast) · `database` (Prisma + `TenantPrismaService` + `SystemPrismaService`) · `tenancy` (TenantContext, guard) · `auth` (Argon2id, JWT, refresh rotation) · `rbac` (decorators, guard, caché de permisos) · `audit` (interceptor + servicio) · `idempotency` · `outbox` (writer + publisher) · `queues` (BullMQ) · `crypto` (cifrado envolvente de secretos) · `observability` (pino con `request_id`/`tenant_id`, OpenTelemetry, health) · `rate-limit` (Redis).

### 5.2 Módulos de negocio (`modules/`)
Cada módulo: `domain/` (reglas, sin Nest/Prisma) · `application/` (casos de uso) · `infrastructure/` (repositorios Prisma/SQL, adaptadores) · `presentation/` (controllers + DTOs Zod). No se fuerza hexagonal ceremonial: un CRUD simple puede ser controller → servicio → repositorio.

| Módulo | Responsabilidad | Depende de |
|---|---|---|
| `users`, `memberships`, `tenants` | cuentas, empresas, invitaciones, settings | auth, rbac |
| `locations`, `services`, `resources` | catálogo | tenants |
| `schedules` | horarios, overrides, feriados, bloqueos | resources, locations |
| `availability` | cálculo de slots (usa `booking-domain`); **solo lectura** | schedules, services, reservations (query) |
| `customers` | clientes, consentimientos, retención | — |
| `reservations` | casos de uso de escritura transaccional, máquina de estados, eventos | availability, services, customers, outbox, idempotency |
| `public-booking` | fachada del portal: resuelve slug, throttling, tokens de gestión | reservations, availability |
| `calendar` | vistas agregadas de lectura para el panel | reservations, schedules |
| `notifications` | orquestación multicanal, plantillas, dedupe, consentimiento | customers, outbox |
| `whatsapp` | cliente Cloud API, webhook, flow de autogestión, onboarding | notifications, reservations |
| `reports` | consultas agregadas (read-only) | — |
| `audit`, `platform-admin` | consulta de auditoría; consola SaaS (`rp_system`) | — |
| `billing` | fase 8 | — |

Reglas: ningún módulo lee tablas de otro directamente (usa su servicio exportado o eventos); `reservations` es el **único** escritor de `reservations*`; el `availability` nunca escribe.

### 5.3 Pipeline de una request
`RateLimit → Auth(JWT) → TenantContext → Rbac → Zod validation → Idempotency (si aplica) → Handler (en tx con set_config) → Audit → Problem+JSON (errores)`.

### 5.4 Contratos de API (complementan el blueprint §12)
- Prefijo `/api/v1`; OpenAPI generado desde Zod (`nestjs-zod`); `api-client` generado desde ese OpenAPI (CI falla si el cliente está desactualizado).
- Errores `application/problem+json` con `code` estable (`SLOT_UNAVAILABLE`, `OUTSIDE_BOOKING_WINDOW`, `INVALID_TRANSITION`, `IDEMPOTENCY_CONFLICT`…).
- Paginación por cursor; filtros y orden con lista blanca; `Idempotency-Key` obligatorio en `POST` de reservas, cancelación y reprogramación públicas.
- `If-Match: <version>` (o `version` en body) en `PATCH`/acciones sobre reservas → 409 si cambió.
- Rutas de plataforma separadas: `/api/v1/platform/*`.
- Webhooks: `GET/POST /webhooks/whatsapp` fuera del prefijo versionado; verifican `X-Hub-Signature-256` con el **raw body**; responden 200 rápido tras persistir en `webhook_events`.

---

## 6. Motor de reservas y concurrencia

### 6.1 Separación lectura / escritura
- **Lectura (`GET /availability`)**: calcula slots con funciones puras de `booking-domain` a partir de datos cargados en bloque (horarios, overrides, bloqueos, ocupación del rango). Sin locks. Puede cachearse segundos en Redis; es **informativa**, nunca autoridad.
- **Escritura**: re-valida todo dentro de la transacción con locks. Nada de lo que devolvió la lectura se confía.

### 6.2 Algoritmo de creación (`CreateReservationUseCase`)
```
 1  Idempotencia: INSERT ... ON CONFLICT en idempotency_keys.
      · existe 'completed' con mismo request_hash → devolver respuesta guardada
      · existe con distinto hash → 422 IDEMPOTENCY_CONFLICT
      · existe 'in_progress' → 409 (reintentar)
 2  Resolver en servidor: tenant (slug), servicio activo, sucursal ofrecida, duración, buffers, precio,
    ventana min/max de anticipación, zona horaria. (Se ignora cualquier precio/duración/tenant del cliente.)
 3  BEGIN  (READ COMMITTED);  set_config('app.tenant_id', …, true)
 4  Candidatos: recursos compatibles, activos, reservables. Si el cliente eligió uno → solo ese.
 5  LOCK:  SELECT id, capacity FROM resources
          WHERE tenant_id=$1 AND id = ANY($2) ORDER BY id FOR UPDATE;      -- orden fijo ⇒ sin deadlocks
 6  Re-validar bajo lock, en este orden:
      a) dentro de horario (business_hours ∩ resource_schedules ± overrides, convertido a UTC)
      b) sin availability_blocks que solapen [occupy_start, occupy_end)
      c) sin reservation_resources activas solapadas (capacidad 1) — el constraint lo garantiza igualmente
    Auto-asignación: tomar el primer candidato libre según estrategia determinista
    (menor carga del día, luego sort_order, luego id).
 7  INSERT customer (upsert por teléfono) → reservation → items(snapshots) → reservation_resources
    → reservation_events('reservation.created') → outbox_events('reservation.created')
 8  COMMIT. Marcar idempotency 'completed' con la respuesta (misma tx).
 9  Errores:
      23P01 (exclusion_violation)        → 409 SLOT_UNAVAILABLE (el cliente reelige)
      40001 / 40P01 (serialización/deadlock) → reintento ≤3 con backoff + jitter, re-validando
      23505 sobre idempotency            → ver paso 1
```

### 6.3 Por qué esta combinación
| Mecanismo | Qué protege | Qué NO protege |
|---|---|---|
| `FOR UPDATE` ordenado sobre `resources` | Serializa escritores del **mismo recurso**; permite validar bloqueos/horarios sin carrera; funciona para capacidad > 1 | Un bug que olvide el lock |
| `EXCLUDE USING gist` | Solapamiento de reservas en capacidad 1 **aunque el lock falte** (defensa en profundidad) | Solapamiento con `availability_blocks` (otra tabla) ni capacidad > 1 |
| Idempotency-Key | Doble clic / reintento de red / webhooks repetidos | Dos intentos distintos con distinta clave (los cubren lock + constraint) |
| `version` (optimistic) | Ediciones concurrentes de una misma reserva | — |

Se elige `READ COMMITTED` + locks explícitos en lugar de `SERIALIZABLE`: es más predecible, evita abortos masivos bajo contención y el constraint cubre la invariante principal.

### 6.4 Reprogramación y cancelación
- **Reprogramar**: mismo bloqueo del/los recurso(s) **destino**; comprobar `reschedule_count < max_reschedules`, ventana (`reschedule_window_hours`) y política; `UPDATE reservations … WHERE id=$1 AND version=$2`; actualizar `reservation_items`/`reservation_resources` (el constraint no choca con la propia fila porque se actualiza, no se inserta); evento `reservation.rescheduled` + outbox. Por defecto conserva recurso; reasigna solo si el recurso original era auto-asignado y ya no está libre (decisión §10).
- **Cancelar**: `UPDATE … SET status='cancelled' WHERE id=$1 AND status IN ('pending','confirmed') AND version=$2`; el trigger libera `is_active`. Si `cancel_requires_approval`, se crea solicitud pendiente y **no** se libera hasta aprobarla (blueprint §8).
- Transiciones permitidas (única fuente: `booking-domain/state-machine.ts`, replicada como `CHECK` solo de valores):

| Desde → Hacia | pending | confirmed | in_progress | completed | cancelled | no_show |
|---|---|---|---|---|---|---|
| **pending** | – | ✔ | – | – | ✔ | – |
| **confirmed** | – | – | ✔ | ✔ | ✔ | ✔ |
| **in_progress** | – | – | – | ✔ | – | – |
| completed / cancelled / no_show | terminales (correcciones excepcionales requieren permiso y evento de auditoría) |

### 6.5 Outbox y entrega fiable
- El evento se escribe **en la misma transacción** que el cambio de negocio.
- Publisher (en el worker, `rp_system`): `SELECT … FROM outbox_events WHERE published_at IS NULL ORDER BY created_at LIMIT n FOR UPDATE SKIP LOCKED` → encolar en BullMQ con `jobId = outbox.id` (idempotente) → marcar `published_at`. Si el proceso muere entre encolar y marcar, el reintento no duplica el job (mismo `jobId`).
- El processor crea `notifications` con `dedupe_key` único → un reintento no puede duplicar el envío. Se verifica consentimiento y preferencias **al enviar**, no al encolar.
- Recordatorios (24 h / 2 h): job repetible que busca reservas `confirmed` en la ventana y genera notificaciones con `dedupe_key` que incluye el tipo de recordatorio y la `start_at` (si se reprograma, corresponde un recordatorio nuevo).

### 6.6 Capacidad > 1 (decisión de alcance)
El constraint de exclusión no modela "máximo N simultáneos". Propuesta:
- **MVP: capacidad 1** garantizada por constraint. El campo `capacity` existe pero la app rechaza `capacity > 1` en recursos reservables por intervalo libre.
- **Fase 3b / posterior**: capacidad > 1 solo para **sesiones de horario fijo** (clases, talleres): tabla `sessions(resource_id, start_at, end_at, capacity)` y reservas contra la sesión, con `SELECT … FOR UPDATE` de la sesión y `CHECK`/contador de cupos. Evita el problema de "máxima concurrencia en un intervalo arbitrario", que exigiría un algoritmo de barrido bajo lock.
- No se implementa antes de validar demanda.

### 6.7 Zonas horarias y DST
Persistir UTC; horarios recurrentes en hora local + zona IANA del tenant/sucursal. El dominio convierte con una librería con soporte IANA (Luxon o Temporal polyfill) **por fecha concreta**, no con offsets fijos. Casos obligatorios en tests: cambio de hora en Chile (hora inexistente / repetida), reservas que cruzan medianoche, tenant en otra zona que el servidor, sucursal con zona propia.

### 6.8 Pruebas del motor (criterios de aceptación de la Fase 3)
1. **Carrera**: 50 requests paralelas al mismo recurso/horario ⇒ exactamente 1 éxito, 49 `SLOT_UNAVAILABLE`, 0 errores 500.
2. **Auto-asignación**: N requests paralelas con M recursos ⇒ ≤ M reservas, sin solapes.
3. **Idempotencia**: misma clave 20 veces en paralelo ⇒ 1 reserva, 20 respuestas idénticas.
4. **Constraint como red de seguridad**: test que inserta saltándose los locks y comprueba que PostgreSQL rechaza el solape.
5. **Bloqueo vs reserva** concurrentes sobre el mismo recurso ⇒ no coexisten.
6. **Property-based** del generador de slots: ningún slot se solapa con ocupación/bloqueos; todo slot cabe en horario; invariantes bajo DST.
7. Cancelación libera el slot; reprogramación no deja el recurso doblemente ocupado.

---

## 7. Seguridad (resumen de decisiones)

- **Sesión**: access JWT corto + refresh opaco rotado en cookie `HttpOnly; Secure; SameSite=Lax`, con detección de reutilización por `family_id` (reuso ⇒ revocar familia). API y SPA bajo el mismo sitio (`app.` / `api.` o proxy `/api`) + header personalizado anti-CSRF.
- **Contraseñas**: Argon2id; bloqueo progresivo y rate limit en login/forgot.
- **Enlaces de gestión públicos**: token de 256 bits aleatorio; se guarda solo el hash; alcance limitado (`view`, `cancel`, `reschedule`), expiración corta (≤ hora de la reserva), revocable; las respuestas de token inválido/inexistente son idénticas (no enumerable). OTP opcional por política del tenant.
- **WhatsApp**: la autoridad es el número verificado por Meta + la sesión de flujo (`whatsapp_flow_sessions`) ligada a la reserva; cada botón lleva un `id` opaco de un solo uso. Firma del webhook obligatoria; dedupe por `webhook_events`.
- **Secretos**: tokens de proveedores con cifrado envolvente; `key_version` permite rotación; nunca en logs ni en respuestas (redaction en pino).
- **Anti-abuso en público**: rate limit por IP + por tenant + por teléfono; CAPTCHA (Turnstile) activable; límite de reservas `pending` por teléfono para evitar acaparar slots.
- **Privacidad (Ley 21.719 / datos personales)**: consentimientos auditables; endpoint de exportación/anonimización (`customers:export|erase`) que anonimiza sin romper integridad de reservas; retención configurable. Validar con asesoría legal antes de producción.
- **Auditoría**: toda mutación administrativa y toda acción de autogestión; tabla append-only.
- **Backups**: PITR en el PostgreSQL administrado + prueba de restauración trimestral documentada.

---

## 8. Riesgos y mitigaciones

| # | Riesgo | Prob. | Impacto | Mitigación |
|---|---|---|---|---|
| R1 | **Aprobación de Meta** (Tech Provider, Embedded Signup, plantillas Utility) con plazos fuera de control | Alta | Alto | Iniciar el trámite **en la Fase 1**. Fallback para el piloto: tenants conectan su WABA con token manual. Lanzar el MVP con email aunque WhatsApp aún no esté aprobado. |
| R2 | Doble reserva por bug en la app | Media | Crítico | Lock + constraint + pruebas de carrera en CI; el constraint es la red de seguridad. |
| R3 | **Fuga entre tenants** (olvidar contexto, join mal hecho, endpoint público) | Media | Crítico | FK compuestas, RLS forzado, test de catálogo y suite de fuga en CI, `rp_app` sin bypass. |
| R4 | RLS + Prisma + pooling mal configurado (contexto filtrado entre conexiones) | Media | Crítico | `set_config(..., true)` dentro de transacción siempre; test con PgBouncer transaction mode; prohibir `$queryRaw` fuera de `TenantPrismaService`. |
| R5 | Limitaciones de Prisma (rangos, constraints GiST, RLS, FK compuestas) | Cierta | Medio | Migraciones SQL escritas a mano versionadas; motor de reservas en SQL crudo tipado; revisar si Kysely para el path crítico. Ver ADR-003. |
| R6 | Zonas horarias / DST incorrectas | Media | Alto | Dominio puro con tests de DST; zona IANA explícita; snapshot de `time_zone` en la reserva. |
| R7 | Notificación perdida o duplicada | Media | Alto | Outbox + `jobId` + `dedupe_key` único; reconciliación periódica; alertas por cola atascada. |
| R8 | Abuso de endpoints públicos (scraping de disponibilidad, acaparar slots, spam de WhatsApp) | Alta | Medio | Rate limits, CAPTCHA, límites por teléfono, holds con expiración, caché de disponibilidad. |
| R9 | Reglas de autogestión mal definidas (decisiones pendientes §20 del blueprint) | Alta | Medio | Políticas parametrizables en `tenant_settings`; valores por defecto seguros (§10); no bloquear la fase 1–3. |
| R10 | Alcance excesivo ("calendario + WhatsApp + reportes + billing") | Alta | Alto | MVP escalonado (§9): primer release vendible sin WhatsApp interactivo ni billing. |
| R11 | Cumplimiento de datos personales / consentimientos | Media | Alto | Consentimiento granular desde el día 1; asesoría legal antes de producción; no almacenar datos clínicos. |
| R12 | Rendimiento del cálculo de slots (muchos recursos × días) | Media | Medio | Carga en bloque, funciones puras, caché corto, límite de rango (≤ 31 días por consulta), benchmark con datos sintéticos en Fase 3. |
| R13 | Complejidad del worker compartido (acoplamiento API/worker) | Baja | Medio | Mismos módulos, composición distinta (`worker.module.ts`); sin lógica en processors más allá de invocar casos de uso. |
| R14 | Deriva entre frontend y backend (contratos) | Media | Medio | Contratos Zod únicos + `api-client` generado; test de contrato en CI. |
| R15 | Roles de sistema por tenant desincronizados tras cambiar plantillas | Baja | Medio | Migración de datos que sincroniza; test que compara roles del tenant vs plantilla. |

---

## 9. Plan de desarrollo por fases

Cada fase termina con: código + migraciones + tests + docs/ADR actualizados + demo. Se avanza solo con la fase anterior en verde.

### Fase 0 — Cierre técnico (≈ 1 semana)
- Aprobar este documento. ADRs: 001 (frontend), 002 (worker como entrypoint), 003 (Prisma + SQL crudo), 004 (RLS+tenancy), 005 (outbox), 006 (capacidad >1 diferida).
- Cerrar decisiones por defecto de §10. Iniciar trámite Meta. Elegir hosting (Postgres administrado con PITR, Redis).
- **Salida**: ADRs firmados, `CLAUDE.md`, backlog priorizado.

### Fase 1 — Fundamentos (≈ 3–4 semanas)
- Monorepo, tooling, Docker Compose, CI.
- `packages/database`: Prisma, migración 0001 (extensiones, roles, tablas SaaS/acceso), helper de RLS, extensión de tenancy.
- NestJS: config, logging, errores Problem+JSON, auth (registro, login, refresh, logout, reset), tenants, memberships, invitaciones, RBAC, auditoría.
- Esqueleto `admin` (login, selector de empresa) y `web` (página por slug vacía).
- **Salida**: suite de fuga multi-tenant en verde; test de catálogo RLS en CI; `docker compose up` levanta todo.

### Fase 2 — Catálogo y agenda (≈ 3 semanas)
- Sucursales, servicios, categorías, recursos, compatibilidades, horarios, overrides, feriados, bloqueos. CRUD + UI de panel.
- Calendario administrativo de **solo lectura** (FullCalendar o alternativa; evaluar antes).
- **Salida**: un negocio configurable completo desde el panel.

### Fase 3 — Motor de reservas (≈ 4 semanas, la más crítica)
- `booking-domain` (slots, estados, políticas) con property tests.
- `availability` (lectura) y `reservations` (escritura transaccional, idempotencia, eventos, outbox escrito).
- Creación/confirmación/cancelación/reprogramación desde panel; calendario editable.
- **Salida**: los 7 criterios de §6.8 en verde en CI.

### Fase 4 — Portal público (≈ 3 semanas)
- Astro SSR por slug, flujo de reserva, página de gestión por token, rate limiting, CAPTCHA opcional, a11y y responsive. E2E Playwright.
- **Salida**: un cliente real reserva de extremo a extremo. **← primer hito demostrable.**

### Fase 5 — Comunicaciones por email (≈ 2–3 semanas)
- Publisher del outbox, BullMQ, `notifications`, plantillas, consentimientos, preferencias, email (Resend vía adaptador), recordatorios, centro de comunicaciones.
- **Salida (MVP vendible v0.1)**: reservas online + panel + emails + recordatorios. Se puede piloteaer con clientes reales.

### Fase 6 — WhatsApp (≈ 4–5 semanas, depende de Meta)
- 6a: cuenta por tenant (token cifrado), envío de plantillas, estados (`sent/delivered/read/failed`), webhook firmado y deduplicado.
- 6b: autogestión: confirmar, cancelar (política/aprobación), reprogramar con re-validación, sesiones de flujo, auditoría, pruebas de seguridad.
- **Salida (MVP completo)**: alcance del blueprint §19.

### Fase 7 — Reportes y endurecimiento (≈ 3 semanas)
- Reportes de §14 (importe reservado ≠ cobrado), observabilidad (métricas/trazas/alertas), carga y `EXPLAIN`, backups + restauración probada, pentest básico, revisión legal de privacidad.
- **Salida**: checklist de producción firmado.

### Fase 8 — Comercialización SaaS
- Planes y límites (enforcement en backend), suscripciones, facturación SaaS, consola global, onboarding autoservicio, dominios propios, pagos de reservas (si se prioriza).

> Estimaciones orientativas para 1–2 desarrolladores full-stack con apoyo de IA; el camino crítico es **Fase 3** y el externo es **Meta (R1)**.

---

## 10. Decisiones por defecto propuestas (cierran los pendientes del blueprint §20)

| # | Pendiente | Supuesto por defecto (configurable) |
|---|---|---|
| 1 | Varios servicios por reserva | Esquema soporta `reservation_items` 1..n; **MVP: 1 servicio por reserva** (API/UI lo imponen) |
| 2 | Elección de profesional | Ambos: elegir o "cualquiera" (auto-asignación determinista) |
| 3 | Capacidad > 1 | Diferida; MVP capacidad 1 (§6.6) |
| 4 | Confirmación del negocio | `auto_confirm = true` por defecto; por servicio `requires_confirmation` lo anula |
| 5 | Políticas de cancelación | Ventana 24 h, máx. 2 reprogramaciones, aprobación opcional |
| 6 | Reprogramación y recurso | Conserva recurso; si era auto-asignado y no está libre, reasigna |
| 7 | OTP para gestión web | No en MVP; token de alcance limitado; OTP activable luego |
| 8 | Onboarding WhatsApp | Token manual para el piloto; Embedded Signup cuando Meta lo apruebe |
| 9 | Proveedor de email | Resend tras interfaz `EmailProvider`; dominio de envío por tenant en fase posterior |
| 10 | Hosting | PostgreSQL administrado con PITR + Redis administrado (proveedor por decidir) |
| 11 | Retención/privacidad | Consentimiento granular + anonimización bajo solicitud; plazos tras asesoría legal |
| 12 | Planes y cobro | Fase 8; el MVP piloto sin cobro automatizado |

---

## 11. ADR-001 — Frontend (resumen)

**Contexto.** El portal público necesita SEO, rendimiento móvil y SSR por tenant/dominio; el panel es una aplicación autenticada con calendario, estado compartido y routing.
**Decisión.** Astro + islas Vue solo para el portal; panel como SPA Vue 3 independiente (`apps/admin`). Componentes compartidos en `packages/ui`.
**Consecuencias.** (+) cada superficie usa la herramienta adecuada, cookies de sesión y despliegue más simples para el panel; (−) dos build targets. **Alternativa**: Nuxt 3 para ambas superficies (un solo framework, algo menos de rendimiento en el portal). Reversible sin afectar backend ni contratos.

---

## 12. Qué NO se hace aún (anti-sobreingeniería)
Microservicios, event sourcing completo, CQRS con almacenes separados, sharding, base por tenant, Kubernetes, marketplace, app móvil, campañas de marketing, calendarios externos, IA. Se reevalúan con datos de uso real.
