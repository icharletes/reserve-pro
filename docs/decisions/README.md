# Architecture Decision Records (ADR)

Cada decisión técnica relevante se registra aquí. Formato: contexto → decisión → consecuencias.
Una decisión **no se borra**: si cambia, se crea un ADR nuevo que la reemplaza y se marca el anterior como `Reemplazado`.

| # | Título | Estado |
|---|---|---|
| [001](001-frontend-astro-portal-admin-spa.md) | Frontend: Astro para el portal, SPA Vue para el panel | Aceptado |
| [002](002-worker-como-entrypoint.md) | Worker como segundo entrypoint de `apps/api` | Aceptado |
| [003](003-prisma-y-sql-crudo.md) | Prisma para CRUD, SQL crudo para el motor de reservas | Aceptado |
| [004](004-multitenancy-rls.md) | Multi-tenancy: tenant_id + FK compuestas + RLS forzado | Aceptado |
| [005](005-outbox-transaccional.md) | Notificaciones mediante transactional outbox | Aceptado |
| [006](006-capacidad-mayor-a-uno-diferida.md) | Capacidad de recurso > 1 diferida | Aceptado |
| [007](007-supuestos-de-negocio-mvp.md) | Supuestos de negocio por defecto del MVP | Aceptado |
| [008](008-hosting-local-primero.md) | Hosting: desarrollo local en Docker; producción pendiente | Aceptado (parcial) |
| [009](009-stack-api-nestjs.md) | Stack de la API: NestJS 12 (ESM), TS 5.9, Zod propio, autorización fail-closed | Aceptado |
| [010](010-invitaciones-y-miembros.md) | Invitaciones, miembros y anti-escalada de privilegios | Aceptado |
| [011](011-rate-limiting-verificacion-contrasenas.md) | Rate limiting, verificación de email y gestión de contraseñas | Aceptado |
| [012](012-worker-frontends-calidad-ci.md) | Worker, cliente de API, frontends, calidad (lint/formato) y CI | Aceptado |
| [013](013-catalogo-y-agenda.md) | Catálogo y agenda (Fase 2): horarios en minutos, DST, EXCLUDE, reglas de resolución | Aceptado |
| [014](014-motor-de-reservas.md) | Motor de reservas (Fase 3A): bloqueo + re-validación + EXCLUDE, idempotencia, versión optimista | Aceptado |
| [015](015-portal-publico-backend.md) | Portal público, backend (Fase 4A): rutas, enlace de gestión con token, políticas, retenciones, antiabuso | Aceptado |
| [016](016-portal-publico-frontend.md) | Portal público, frontend (Fase 4B): páginas, token en el fragmento, E2E con Playwright | Aceptado |
