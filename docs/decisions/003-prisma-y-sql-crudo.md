# ADR-003 — Prisma para CRUD, SQL crudo para el motor de reservas

**Estado:** Aceptado · **Fecha:** 2026-11-18

## Contexto
El blueprint fija Prisma. Prisma no soporta nativamente rangos (`tstzrange`), constraints `EXCLUDE USING gist`, políticas RLS, triggers ni `FOR UPDATE` ordenado de forma ergonómica.

## Decisión
- **Prisma** para el modelo, el cliente tipado y el CRUD ordinario.
- **Migraciones SQL escritas a mano** y versionadas (Prisma Migrate con SQL personalizado) para extensiones, roles, RLS, constraints GiST y triggers. Nunca se modifica la BD manualmente.
- El **camino crítico de escritura de reservas** usa SQL crudo parametrizado dentro de `TenantPrismaService` (nunca `$queryRaw` fuera de él).
- Esquema y migraciones viven en `packages/database`.

### Notas de implementación (Fase 1)
- Se fija **Prisma 7.10.1**; requiere Node ≥ 20.19 (proyecto en Node 22). Prisma 7 usa `prisma.config.ts` y adaptador `@prisma/adapter-pg`.
- Flujo: SQL de la migración escrito a mano → `prisma migrate deploy` → `prisma db pull` para regenerar `schema.prisma` → `prisma generate`.
- Modelos en **snake_case**, idénticos a las tablas (sin `@map`), para evitar errores de mapeo.
- El cliente generado (`src/generated`) no se versiona.

## Consecuencias
- (+) Se conserva el DX de Prisma sin renunciar a las garantías de PostgreSQL.
- (−) Dos "idiomas" de acceso a datos; requiere disciplina y tests de integración contra Postgres real.
- Si el SQL crudo crece demasiado, evaluar Kysely para ese camino (nuevo ADR).
