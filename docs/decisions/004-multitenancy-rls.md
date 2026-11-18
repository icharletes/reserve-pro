# ADR-004 — Multi-tenancy: tenant_id + FK compuestas + RLS forzado

**Estado:** Aceptado · **Fecha:** 2026-11-18

## Contexto
Prioridad no negociable #1: aislamiento estricto de datos por tenant. Estrategia del blueprint: BD y esquema compartidos.

## Decisión
Tres capas independientes:
1. **Aplicación:** `TenantContext` (AsyncLocalStorage) + guards. El tenant sale del claim `tid` del token validado contra la membresía; nunca de un header/body libre.
2. **Integridad:** `UNIQUE (tenant_id, id)` en cada tabla y FK compuestas `(tenant_id, x_id)`.
3. **RLS** con `ENABLE` + `FORCE ROW LEVEL SECURITY`, contexto vía `set_config('app.tenant_id', $1, true)` dentro de cada transacción (compatible con PgBouncer en modo transaction). Sin contexto ⇒ cero filas (falla cerrado).

Roles de BD: `rp_owner` (migraciones), `rp_app` (runtime, sujeto a RLS), `rp_system` (BYPASSRLS, acotado: outbox, resolución de webhooks, expiración de holds, consola SaaS).

## Consecuencias
- (+) Un bug de aplicación no basta para filtrar datos entre empresas.
- (−) Toda consulta debe correr dentro de una transacción con contexto; `rp_system` es el punto de mayor riesgo y se usa solo desde `SystemPrismaService` revisado.
- CI: test de catálogo (toda tabla con `tenant_id` debe tener RLS forzado y política) + suite de fuga entre tenants.
