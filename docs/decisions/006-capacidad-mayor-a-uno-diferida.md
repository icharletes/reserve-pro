# ADR-006 — Capacidad de recurso > 1 diferida

**Estado:** Aceptado · **Fecha:** 2026-11-18

## Contexto
La restricción `EXCLUDE USING gist` garantiza "ningún solape" (capacidad 1), pero no "máximo N simultáneos". Modelar N sobre intervalos arbitrarios exigiría un algoritmo de máxima concurrencia bajo lock.

## Decisión
- **MVP:** capacidad 1, garantizada por constraint. El campo `resources.capacity` existe, pero la app rechaza `capacity > 1` en recursos reservables por intervalo libre.
- **Posterior:** capacidad > 1 solo para **sesiones de horario fijo** (clases, talleres), con tabla `sessions` y `FOR UPDATE` de la sesión.
- No se implementa antes de validar demanda.

## Consecuencias
- (+) El MVP conserva la garantía más fuerte (constraint de BD) sin complejidad extra.
- (−) Negocios con salas/cupos múltiples quedan fuera del primer release.
