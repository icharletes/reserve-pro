# ADR-002 — Worker como segundo entrypoint de `apps/api`

**Estado:** Aceptado · **Fecha:** 2026-11-18 · **Desvía el blueprint §4** (`apps/worker`)

## Contexto
El blueprint prevé `apps/worker` separado. Pero el worker procesa interacciones de WhatsApp que ejecutan casos de uso de `reservations` y `availability`. Un paquete aparte obligaría a duplicar el backend o extraerlo casi entero a un paquete compartido.

## Decisión
`apps/api` expone dos entrypoints sobre los mismos módulos: `main.ts` (HTTP) y `worker.ts` (procesadores BullMQ, `worker.module.ts`). Se despliegan como **procesos/contenedores distintos**.

## Consecuencias
- (+) Cero duplicación; un solo lugar para los casos de uso.
- (+) Operativamente sigue siendo un worker separado (escala y falla de forma independiente).
- (−) El worker comparte base de código con la API; los processors solo invocan casos de uso, sin lógica propia.
- Reversible: si el worker crece, se extrae a `apps/worker` consumiendo los módulos como paquete.
