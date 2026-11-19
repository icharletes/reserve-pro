# ReservePro — guía para Claude Code

Documento maestro: `reservepro_blueprint_claude.md`. Arquitectura vigente: `docs/architecture/ARCHITECTURE.md`. Decisiones: `docs/decisions/`.

## Reglas
- El backend es la autoridad: precio, duración, disponibilidad, permisos y `tenant_id` nunca se aceptan del navegador.
- Aislamiento por tenant es prioridad #1: FK compuestas + RLS forzado (ADR-004). Toda tabla con `tenant_id` necesita política RLS.
- Reservas/cancelaciones/reprogramaciones: transacción + lock ordenado + constraint GiST + idempotencia.
- Migraciones SQL versionadas; nunca tocar la BD manualmente.
- Código, tablas y endpoints en inglés; UI en español.
- No añadir dependencias ni cambios de arquitectura sin explicar motivo y consecuencias (y ADR si es relevante).
- No loguear secretos, tokens ni datos personales.
- Trabajar por fases pequeñas y verificables; no construir todo de una vez.

## Dependencias entre paquetes
`apps/* → packages/*`. `booking-domain` y `contracts` no dependen de nada del repo. `web`/`admin` nunca importan `database` ni `booking-domain`.

## Comandos
```
pnpm install            pnpm db:up / db:down / db:reset   (Postgres, Redis, Mailpit)
pnpm build|typecheck|test   (turbo)        pnpm lint | pnpm format:check | pnpm format
pnpm --filter @reservepro/api openapi:generate     (regenerar docs/api/openapi.json tras tocar endpoints)
pnpm --filter @reservepro/api start | start:worker (API y worker)      pnpm --filter @reservepro/admin dev
pnpm test:e2e   (Playwright; recrea reservepro_e2e_test; en Mac usa el Chrome instalado)
pnpm --filter @reservepro/database db:migrate      (aplicar migraciones; luego `prisma db pull` + `generate`)
```
Antes de dar algo por terminado: `pnpm exec eslint . --max-warnings 0 && pnpm format:check && pnpm typecheck && pnpm build && pnpm test`.
Entorno: **Node ≥ 22.23.4** (Astro 7; Prisma exige ≥ 20.19) (Prisma 7 exige ≥ 20.19; Node 20 está fuera de soporte), pnpm 9 (corepack). Copiar `.env.example` a `.env`.
- Node 22 está en `~/.local/node-v22.23.5` (binario oficial, sin tocar el Node global). Anteponer a PATH:
  `export PATH=$HOME/.local/node-v22.23.5/bin:$PATH`
- Mac Intel: si vitest falla con `@rolldown/binding-*`, ejecutar `pnpm install --force`.
- Prisma fijado en **7.10.1** (la etiqueta `latest` de npm apunta a un RC 8; no usarla).
- `packages/database`: `pnpm --filter @reservepro/database test` recrea `reservepro_test` y exige Docker arriba (`pnpm db:up`).
- Modelos Prisma en snake_case, 1:1 con la BD (decisión: evitar errores de mapeo).
- Toda consulta de tenant va por `withTenant(db, {tenantId}, tx => …)`; nunca por el cliente suelto.

## Estado
**Fases 1–5 completas** (5B en rama `fase-5b-panel-comunicaciones`). **MVP vendible v0.1** (ARCHITECTURE.md §9). Siguiente: decidir hosting de producción (ADR-008) y piloto, o Fase 6 (WhatsApp).
- ✔ Fase 1: monorepo, auth, RBAC, invitaciones, rate limiting, OpenAPI, worker, panel y portal, lint y CI.
- ✔ Fase 2 (ADR-013): catálogo (sucursales, categorías, servicios, recursos), agenda (horarios semanales, excepciones, feriados, bloqueos) y calendario de solo lectura; resolución de horarios con DST en `booking-domain`; pantallas del panel.
- ✔ Fase 3A (ADR-014): clientes, disponibilidad, reservas (bloqueo + re-validación + EXCLUDE), idempotencia, versión optimista, eventos/outbox, calendario con reservas, agenda vs reservas.
- ✔ Fase 3B: panel de reservas (lista, nueva, detalle con acciones/reprogramar/historial), clientes, reservas en calendario e inicio.
- ✔ Fase 4A (ADR-015): API pública por slug, enlace de gestión (token en el cuerpo), políticas de autogestión, retenciones con barrido del worker, antiabuso por teléfono; RLS forzado verificado en TODAS las tablas.
- ✔ Fase 4B (ADR-016): portal `/{slug}` (SSR + isla de reserva) y `/mi-reserva#token=…`; E2E Playwright escritorio+móvil.
- ✔ Fase 5A (ADR-017): outbox → BullMQ → email deduplicado al cliente (con enlace de gestión nuevo), recordatorio 24 h, consentimiento transaccional versionado.
- ✔ Fase 5B: pantalla de Configuración (políticas, portal, recordatorio, emails) y centro de Comunicaciones con reintento manual (`notifications:resend`).
- 681 pruebas + 10 E2E (`pnpm test:e2e`). Rendimiento medido: `docs/architecture/PERFORMANCE.md`.
- Pendientes: CAPTCHA (Turnstile) en el portal; `Promise.all` dentro de transacciones en código antiguo (`blocks.ts`) → secuencial (pg@9 lo prohibirá).

## Reglas de código de la API
- Todo endpoint declara `@Public()`, `@Authenticated()` o `@RequirePermissions()`; sin eso no se ejecuta.
- Datos de negocio solo vía `TenantDb.runAsPrincipal(tx => …)` (solo `tenantId`; nunca `userId` con tenant activo). `TenantDb.global` solo para tablas sin RLS.
- Auditoría con `AuditService.record(tx, …)` dentro de la MISMA transacción del cambio.
- Imports con extensión `.js` (ESM). Tests e2e: `apps/api/test/`, base propia `reservepro_api_test`.
- Build: `turbo` ejecuta `generate` (Prisma) antes de `build`/`typecheck`/`test`.
- Anti-escalada: para otorgar un rol o gestionar un miembro usar `canHold(actor.permissions, permisosObjetivo)` (`modules/members/privileges.ts`); nunca comparar por nombre de rol.
- Los tokens secretos (invitaciones, refresh) viajan en cuerpo o cookie, nunca en la URL; en BD solo su SHA-256.
- Tests de API con email: usar `mailbox` y `tokenFrom()` de `test/helpers.ts`; el token se lee del correo, jamás de la respuesta.
- Lint: las reglas de arquitectura (`eslint.config.mjs`) son parte del diseño: booking-domain puro, el navegador no importa código de servidor, nada de `$queryRawUnsafe`, `localStorage` ni `v-html`. Si añades un bloque con `no-restricted-imports`, usa el helper `restrict()` (flat config: el último bloque REEMPLAZA a los anteriores).
- Todo endpoint nuevo: `@ApiDoc` + política de autorización; un test falla si falta. Todo POST público necesita `@RateLimit`. Tras cambiar endpoints, regenerar OpenAPI.
- `astro check` no funciona (dependencia beta); el portal usa `astro sync` + `tsc` y `astro build`.
- Medir antes de optimizar; no cachear la identidad (rompería la desactivación inmediata). Ver PERFORMANCE.md.
- Esquemas de EDICIÓN (`update*Request`): derivarlos de un esquema base SIN `default()`, nunca de el de creación con `.partial()` (reiniciaba campos en silencio, ADR-013).
- Permiso NUEVO: añadirlo al catálogo, a las plantillas de rol Y con una migración a los roles de sistema de las empresas existentes (ver 0011).
- Las tablas PARTICIONADAS no heredan RLS al consultar la partición: `REVOKE ALL` a `rp_app` + `rp_enable_tenant_rls` en cada partición (migración 0008).
- El motor recibe un `Actor` (empresa, canal, tipo); nunca lee la sesión dentro. Portal y worker usan `*As(actor, …)`.
- Emails al cliente: SOLO desde el worker (`NotificationsService`), nunca desde la request. Dedupe por `dedupe_key`; `rp_system` solo para descubrir trabajo, el envío con RLS. Pruebas del worker real: buzón falso.
- Reservas: toda escritura por `ReservationsService` (lock de recursos → `checkFit` → insert; EXCLUDE de respaldo). SQLSTATE con `pgCode()` (`common/pg-errors.ts`): Prisma envuelve los errores de PG en sus propios códigos P20xx.
- Dentro de una transacción, consultas **secuenciales** (no `Promise.all`: una sola conexión).
- Horarios: minutos de pared 0–1440 y días ISO 1–7; la resolución a UTC vive solo en `booking-domain/schedule.ts`.
- Scripts que editan archivos con `str.replace`: **verificar que el patrón coincidió** (assert). Prettier reformatea el texto y un reemplazo que no coincide falla en silencio.
- `main` está protegida: todo cambio va por rama + pull request + CI en verde.
