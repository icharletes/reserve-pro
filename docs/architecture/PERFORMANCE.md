# Rendimiento medido (línea base de la Fase 1)

> Medición hecha el 2026-11-18 sobre el **build de producción** (`node dist/main.js`), una sola instancia,
> contra PostgreSQL 16 y Redis 7 en Docker Desktop, en un Mac Intel. **Cliente de carga y servidor en la misma
> máquina**: las cifras sirven para comparar cambios entre sí y para dimensionar, no como garantía de producción.
> Método: generador propio mínimo (`http` de Node, keep-alive), 6–8 s por prueba.

## Resultados

| Escenario                                    | Conexiones | Req/s | p50     | p95     | p99     |
| -------------------------------------------- | ---------- | ----- | ------- | ------- | ------- |
| `GET /health` (sin BD)                       | 16         | 3 393 | 4,2 ms  | 7,7 ms  | 10,1 ms |
| `GET /health/ready` (`SELECT 1` + Redis)     | 16         | 1 928 | 8,2 ms  | 10,9 ms | 13,8 ms |
| `GET /tenants/current` (autenticado)         | 1          | 87    | 11,2 ms | 14,1 ms | 16,8 ms |
| `GET /tenants/current` (autenticado)         | 4          | 252   | 15,5 ms | 18,3 ms | 20,6 ms |
| `GET /tenants/current` (autenticado)         | 10         | 289   | 33,7 ms | 42,7 ms | 65,1 ms |
| `GET /tenants/current` (autenticado)         | 16         | 303   | 51,7 ms | 63,7 ms | 80,2 ms |
| `GET /tenants/current` (autenticado)         | 32         | 297   | 103 ms  | 133 ms  | 196 ms  |
| `GET /tenants/current` + rate limit (Redis)  | 16         | 250   | 60,7 ms | 87,1 ms | 123 ms  |
| `GET /health` + rate limit (Redis)           | 16         | 3 336 | 4,4 ms  | 7,2 ms  | 8,8 ms  |

## Lectura

- **Sin carga, un endpoint autenticado tarda ~11 ms.** Con carga el rendimiento se **satura en ~300 req/s por
  instancia** (a partir de ~10 conexiones simultáneas; más conexiones solo aumentan la latencia por cola).
- El coste está en la **doble transacción por request**: el `AuthGuard` reconstruye la identidad desde la BD
  (membresía + permisos + sesión activa) y luego el handler abre la suya. Cada transacción interactiva de Prisma
  son varios viajes (`BEGIN`, `set_config`, consultas, `COMMIT`). Un `SELECT 1` simple rinde 6× más, así que no
  es la base de datos en sí sino el número de viajes.
- **Rate limiting:** coste de ~0,2 ms en rutas públicas (un solo viaje a Redis, Lua atómico). En rutas
  autenticadas baja el máximo ~15 % porque su ventana de latencia ya está dominada por la base de datos.
- 300 req/s ≈ 26 millones de peticiones/día por instancia: **holgado para el MVP**, y la API es sin estado
  (escala horizontalmente). El pool de `rp_app` es de 10 conexiones por proceso; con N réplicas, dimensionar
  `max_connections` de PostgreSQL (o usar un pooler) en consecuencia.

## Decisión: NO se añade caché todavía

Cachear la identidad en Redis duplicaría el rendimiento, pero **rompe la garantía actual** de que desactivar un
usuario, una membresía o una empresa, o cerrar sesión, surte efecto en la siguiente petición (ADR-009). Solo se
hará si las cifras reales de producción lo justifican, y con invalidación activa.

## Palancas, en orden de menor a mayor riesgo

1. **Menos viajes por transacción:** fijar el contexto de tenant dentro de la primera consulta (en lugar de un
   `set_config` aparte) y evitar la transacción del guard cuando solo se leen datos de identidad. Sin cambio de
   garantías.
2. **Pooler** (PgBouncer, modo transaction; ya es compatible con `set_config(..., true)`), para poder subir el
   número de réplicas sin agotar `max_connections`.
3. **Caché de identidad con TTL de segundos + invalidación activa** (Redis pub/sub por `userId`/`tenantId`).
   Solo si 1 y 2 no bastan.

## Cómo repetir la medición

Arrancar `pnpm --filter @reservepro/api build` y `node dist/main.js` (con `RATE_LIMIT_GLOBAL_PER_MIN` alto para no
medir el límite), registrar un usuario y pasar su access token al generador. Repetir tras cada cambio relevante
en el camino de autenticación y anotar la fecha y el hardware.
