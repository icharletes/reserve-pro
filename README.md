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
pnpm test
```

## Estructura
```
apps/        api (NestJS), web (Astro), admin (Vue SPA)   — por crear en la Fase 1
packages/    config, contracts, booking-domain             — ui, database, api-client por crear
docs/        architecture, decisions
```
