# ADR-008 — Hosting: desarrollo local en Docker; producción pendiente

**Estado:** Aceptado (parcial) · **Fecha:** 2026-11-18

## Decisión
- **Fases 1–3:** todo en local con Docker Compose (`postgres:16`, `redis:7` con `noeviction`, `mailpit`).
- **Producción: sin decidir.** Opción recomendada: PostgreSQL administrado con PITR y pooler + apps en un PaaS + Redis administrado de precio fijo. AWS en São Paulo queda como destino de escala.
- Se decide antes del primer despliegue (≈ Fase 4).

## Requisitos que el proveedor debe cumplir (verificar antes de contratar)
- PITR y backups automáticos.
- Pooler en modo transaction (la tenancy usa `set_config` local a la transacción).
- Extensiones `btree_gist`, `citext`, `pg_trgm`.
- Poder crear `rp_system` con `BYPASSRLS`.
- Redis con política `noeviction` y precio fijo (BullMQ consulta constantemente).
