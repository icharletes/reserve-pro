# ReservePro

Plataforma SaaS multiempresa de gestión de servicios, agendas y reservas.

- Especificación: [`reservepro_blueprint_claude.md`](reservepro_blueprint_claude.md)
- Arquitectura: [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md)
- Decisiones (ADR): [`docs/decisions/`](docs/decisions/README.md)

## Requisitos
Node ≥ 20.15, pnpm 9 (`corepack enable`), Docker Desktop.

## Puesta en marcha local
```bash
cp .env.example .env
pnpm install
pnpm db:up          # Postgres 16, Redis 7, Mailpit (UI en http://localhost:8025)
pnpm --filter @reservepro/database db:migrate   # aplica las migraciones a la base local
pnpm test           # 95 tests (requiere Docker arriba)
pnpm --filter @reservepro/api build && pnpm --filter @reservepro/api start   # API en http://localhost:3000
```
> Requiere **Node ≥ 22.12**. Salud: `GET /health` y `GET /health/ready`. API bajo `/api/v1`.

## Estructura
```
apps/        api (NestJS)                                  — web (Astro) y admin (Vue SPA) por crear
packages/    config, contracts, booking-domain, database   — ui, api-client por crear
docs/        architecture, decisions
```
