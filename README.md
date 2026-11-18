# ReservePro

Plataforma SaaS multiempresa de gestión de servicios, agendas y reservas.

- Especificación: [`reservepro_blueprint_claude.md`](reservepro_blueprint_claude.md)
- Arquitectura: [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md)
- Decisiones (ADR): [`docs/decisions/`](docs/decisions/README.md)

## Requisitos
Node ≥ 22.23.4, pnpm 9 (`corepack enable`), Docker Desktop.

## Puesta en marcha local
```bash
cp .env.example .env
pnpm install
pnpm db:up          # Postgres 16, Redis 7, Mailpit (UI en http://localhost:8025)
pnpm --filter @reservepro/database db:migrate   # aplica las migraciones a la base local
pnpm test           # 317 pruebas (requiere Docker arriba)
pnpm lint && pnpm format:check
pnpm --filter @reservepro/api build && pnpm --filter @reservepro/api start   # API en http://localhost:3000
pnpm --filter @reservepro/api start:worker   # worker (BullMQ)
pnpm --filter @reservepro/admin dev          # panel en http://localhost:5173 (proxy a la API)
pnpm --filter @reservepro/web dev            # portal en http://localhost:4321
```
> Requiere **Node ≥ 22.23.4**. Salud: `GET /health` y `GET /health/ready`. API bajo `/api/v1`.

## Estructura
```
apps/        api (NestJS: API + worker), admin (Vue SPA), web (Astro SSR)
packages/    config, contracts, booking-domain, database, api-client
docs/        architecture, decisions
```
