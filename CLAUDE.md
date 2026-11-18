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
**Fase 1 (Fundamentos) completa.** Pendiente solo lo operativo: ejecutar el workflow en GitHub real y proteger `main`.
- ✔ Monorepo, Docker, `booking-domain` (máquina de estados), `contracts`, `database` (migraciones 0001–0004, RLS, `withTenant`).
- ✔ `apps/api`: auth (register/login/refresh con rotación/logout/switch-tenant/me), verificación de email, recuperar/cambiar contraseña, RBAC fail-closed (38 permisos, 5 roles), invitaciones y miembros (anti-escalada, último propietario), auditoría (escritura y consulta), rate limiting con Redis, OpenAPI generado, health.
- ✔ Worker (`worker.ts`, BullMQ): purga diaria de tokens vencidos.
- ✔ `packages/api-client`, `apps/admin` (Vue), `apps/web` (Astro SSR).
- ✔ ESLint (reglas de arquitectura y seguridad) + Prettier + CI + Dependabot.
- 317 pruebas. Rendimiento medido: `docs/architecture/PERFORMANCE.md` (~300 req/s por instancia en endpoints autenticados).
- **Siguiente: Fase 2 (catálogo y agenda)**: sucursales, servicios, recursos, horarios, bloqueos, calendario.

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
