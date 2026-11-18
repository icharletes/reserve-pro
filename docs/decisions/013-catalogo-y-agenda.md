# ADR-013 — Catálogo y agenda (Fase 2)

**Estado:** Aceptado · **Fecha:** 2026-11-19

## Modelo de horarios
- Los horarios son **hora de pared local en minutos desde medianoche** (`start_minute`/`end_minute`, 0–1440), no el tipo `time`: `time` no puede expresar 24:00 y es ambiguo con zonas horarias. Los días son **ISO-8601** (1 = lunes … 7 = domingo). *Esto sustituye a `time` y `0..6` del esquema borrador de ARCHITECTURE.md §4.4.*
- Se interpretan en la **zona horaria de la sucursal** (la propia o, si no tiene, la de la empresa) y se convierten a instantes UTC **por fecha concreta** (no con un desfase fijo), de modo que el cambio de hora (DST) sale bien. Un día con cambio de hora dura 23 o 25 horas reales; la hora inexistente se desplaza hacia adelante y la repetida usa su primera ocurrencia.
- **Los solapes se impiden en la base de datos** con `EXCLUDE USING gist` (horario de sucursal, horario de recurso con vigencia, excepciones). La API los valida antes para dar un 400 con el índice del tramo, y **bloquea la fila** (sucursal/recurso) mientras reemplaza el horario: dos administradores editando a la vez no producen errores 500 ni un horario mezclado. Los tramos pueden *tocarse* (09–13 y 13–18) pero no pisarse.
- Un **día cerrado** se guarda como un tramo 0–1440 con `is_closed`: así la misma restricción de exclusión impide mezclar "cerrado" con tramos abiertos el mismo día, sin lógica adicional.

## Reglas de resolución (código: `booking-domain/src/schedule.ts`, puro y probado)
- **Sucursal**, por día: excepción de la sucursal > feriado de la empresa > horario semanal.
- **Recurso**: excepción del recurso > su horario semanal (si tiene algún tramo vigente ese día) > sigue a la sucursal. Un recurso con horario propio trabaja **solo** en esos días (un día sin tramo = libre aunque la sucursal abra).
- El horario efectivo del recurso **siempre se intersecta** con el de la sucursal: nadie trabaja con el local cerrado.
- Una sucursal desactivada no atiende. Esta misma función alimentará el cálculo de disponibilidad de la Fase 3.

## Catálogo
- **Dinero como texto decimal** (`"12990"`, `"49.50"`), nunca número JSON (pérdida de precisión). **La moneda la fija el servidor** (la de la empresa al crear); el cliente no la envía.
- Nombres únicos por empresa **sin distinguir mayúsculas** (`citext`); el de un recurso, único por sucursal. Un usuario es, como mucho, un recurso (`uq_resources_membership`) y solo `kind = staff` puede vincularse.
- **Capacidad = 1** en el MVP (ADR-006); la columna existe para no migrar.
- La **sucursal y el tipo de un recurso son inmutables** (cambiarlos invalidaría horarios y vínculos): se crea otro.
- Los vínculos servicio↔sucursal↔recurso son coherentes: un recurso solo puede prestar un servicio ofrecido en **su** sucursal; al quitar una sucursal de un servicio se desvinculan sus recursos en la misma transacción.
- **Baja:** se prefiere desactivar. `DELETE` solo funciona si nada lo referencia (409 `IN_USE`); borra primero su configuración (horarios, vínculos, bloqueos) dentro de la misma transacción, así que un fallo no deja nada a medias. Cuando existan reservas (Fase 3) el `DELETE` fallará automáticamente por la clave foránea.

## Bug de diseño evitado (y su prueba)
Derivar el esquema de **edición** del de **creación** con `.partial()` conserva los `default()`: un `PATCH {name}` reiniciaba en silencio `address`, `isBookableOnline`, `sortOrder`, `bufferBefore`… Los esquemas de edición se derivan ahora de un esquema base **sin defaults** y hay pruebas de regresión por entidad. Regla: *nunca derivar un esquema de edición de uno con `default()`*.

## Calendario
Solo lectura: por recurso activo, sus rangos de trabajo (UTC) y bloqueos entre dos fechas locales (máx. 31 días). Permiso **cualquiera de** `calendar:read` / `calendar:read:own` (nuevo `@RequireAnyPermission`): con solo el segundo, un profesional ve únicamente el recurso vinculado a su usuario, y los demás le dan 404 (no se revela que existen). En el panel, cada celda se muestra en la **hora local del recurso**.

## Límites conocidos / pendientes para la Fase 3
- **Bloqueos vs. reservas:** hoy no existen reservas. Al crear o ampliar un bloqueo hay que comprobar contra las reservas del recurso bajo el mismo lock de recurso del motor (ver comentario en `blocks.ts`). Lo mismo al desactivar un recurso/sucursal/servicio con reservas futuras, y al cambiar el horario con reservas ya hechas.
- Los listados se ordenan por creación (cursor sobre UUIDv7), no por nombre.
- Las horas de un bloqueo se ingresan en la **zona del navegador**, no en la de la sucursal.
- El cambio de moneda de la empresa no actualiza los servicios ya creados (cada uno conserva la suya).
- Los feriados se cargan a mano (sin calendario oficial precargado).

## Verificación
Pruebas contra PostgreSQL real (restricciones y RLS), propiedades con zonas como Lord Howe (DST de 30 min) y **pruebas de mutación manuales**: se rompió a propósito cada regla de resolución y las pruebas lo detectaron. Una prueba de contrato valida que las respuestas reales cumplen los esquemas que usa el cliente del panel.
