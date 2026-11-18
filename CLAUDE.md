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
pnpm build|typecheck|test   (turbo)
```
Entorno: **Node ≥ 22.12** (Prisma 7 exige ≥ 20.19; Node 20 está fuera de soporte), pnpm 9 (corepack). Copiar `.env.example` a `.env`.
- Node 22 está en `~/.local/node-v22.23.5` (binario oficial, sin tocar el Node global). Anteponer a PATH:
  `export PATH=$HOME/.local/node-v22.23.5/bin:$PATH`
- Mac Intel: si vitest falla con `@rolldown/binding-*`, ejecutar `pnpm install --force`.
- Prisma fijado en **7.10.1** (la etiqueta `latest` de npm apunta a un RC 8; no usarla).
- `packages/database`: `pnpm --filter @reservepro/database test` recrea `reservepro_test` y exige Docker arriba (`pnpm db:up`).
- Modelos Prisma en snake_case, 1:1 con la BD (decisión: evitar errores de mapeo).
- Toda consulta de tenant va por `withTenant(db, {tenantId}, tx => …)`; nunca por el cliente suelto.

## Estado
Fase 0 cerrada (ADRs). Fase 1 en curso:
- ✔ Monorepo, Docker, `booking-domain`, `contracts`.
- ✔ `packages/database`: migración 0001 (SaaS, acceso, RBAC, auditoría, RLS), `withTenant`/`withUser`, 23 tests de aislamiento.
- ✔ `apps/api` (NestJS 12): config validada, errores Problem+JSON, auth (register/login/refresh con rotación/logout/switch-tenant/me), RBAC fail-closed con 38 permisos y 5 roles, auditoría transaccional, tenants (GET/PATCH current), health. 60 tests e2e + unitarios.
- ✔ Migración 0002: políticas "propias" solo sin tenant activo (bug de aislamiento hallado por el e2e).
- ✔ Invitaciones (crear/listar/reenviar/revocar, preview y aceptar con token en el cuerpo) y miembros (listar paginado, cambiar estado y roles, roles de la empresa) con anti-escalada y protección del último propietario (ADR-010). Email por SMTP/Mailpit tras el puerto `EmailProvider`. 163 tests en total.
- ☐ Pendiente Fase 1: recuperación de contraseña, consulta de auditoría, rate limiting (Redis), verificación de email del propietario (anti-abuso de invitaciones), OpenAPI, entrypoint `worker.ts`, esqueletos `apps/web` y `apps/admin`, CI (GitHub Actions) y lint (ESLint + boundaries).

## Reglas de código de la API
- Todo endpoint declara `@Public()`, `@Authenticated()` o `@RequirePermissions()`; sin eso no se ejecuta.
- Datos de negocio solo vía `TenantDb.runAsPrincipal(tx => …)` (solo `tenantId`; nunca `userId` con tenant activo). `TenantDb.global` solo para tablas sin RLS.
- Auditoría con `AuditService.record(tx, …)` dentro de la MISMA transacción del cambio.
- Imports con extensión `.js` (ESM). Tests e2e: `apps/api/test/`, base propia `reservepro_api_test`.
- Build: `turbo` ejecuta `generate` (Prisma) antes de `build`/`typecheck`/`test`.
- Anti-escalada: para otorgar un rol o gestionar un miembro usar `canHold(actor.permissions, permisosObjetivo)` (`modules/members/privileges.ts`); nunca comparar por nombre de rol.
- Los tokens secretos (invitaciones, refresh) viajan en cuerpo o cookie, nunca en la URL; en BD solo su SHA-256.
- Tests de API con email: usar `mailbox` y `tokenFrom()` de `test/helpers.ts`; el token se lee del correo, jamás de la respuesta.
