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
- ☐ `apps/api` (NestJS): config, errores, auth, tenants, RBAC, auditoría.
- ☐ Esqueletos `apps/web` y `apps/admin`; CI.
