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
**Fases 1 y 2 completas** (rama `fase-2-catalogo-agenda`, ver PR). Siguiente: **Fase 3, motor de reservas** (la más crítica; ver ARCHITECTURE.md §6).
- ✔ Fase 1: monorepo, auth, RBAC, invitaciones, rate limiting, OpenAPI, worker, panel y portal, lint y CI.
- ✔ Fase 2 (ADR-013): catálogo (sucursales, categorías, servicios, recursos), agenda (horarios semanales, excepciones, feriados, bloqueos) y calendario de solo lectura; resolución de horarios con DST en `booking-domain`; pantallas del panel.
- 529 pruebas. Rendimiento medido: `docs/architecture/PERFORMANCE.md`.
- **Fase 3 debe recordar** (ADR-013): bloqueos vs. reservas, desactivar con reservas futuras, cambio de horario con reservas hechas, y que `DELETE` pasará a dar `IN_USE` por FK.

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
- Horarios: minutos de pared 0–1440 y días ISO 1–7; la resolución a UTC vive solo en `booking-domain/schedule.ts`.
- Scripts que editan archivos con `str.replace`: **verificar que el patrón coincidió** (assert). Prettier reformatea el texto y un reemplazo que no coincide falla en silencio.
- `main` está protegida: todo cambio va por rama + pull request + CI en verde.
