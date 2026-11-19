# ADR-014 — Motor de reservas (Fase 3A)

**Estado:** Aceptado · **Fecha:** 2026-11-19

## Garantía central: nunca una doble reserva
Tres capas, cada una suficiente por sí sola contra el caso que cubre:
1. **Bloqueo de recursos** dentro de la transacción: `SELECT … FROM resources WHERE id = ANY(…) ORDER BY id FOR UPDATE`. El orden fijo por id evita deadlocks; serializa a quienes compiten por el mismo recurso y permite que la asignación automática elija entre recursos de verdad libres.
2. **Re-validación bajo el bloqueo** con `checkFit` (`booking-domain/availability.ts`, puro): ventana de antelación, horario de trabajo (incluidos preparación y limpieza) y conflictos con reservas activas y bloqueos. La disponibilidad (`GET /availability`) es solo informativa: la escritura nunca confía en ella.
3. **`EXCLUDE USING gist` en `reservation_resources`** (migración 0006): PostgreSQL rechaza cualquier solape en un recurso de capacidad 1, aunque el código tuviera un bug. La API traduce el 23P01 a **409 `SLOT_UNAVAILABLE`**.

**Verificado por mutación:** quitando el bloqueo, la prueba de 50 peticiones simultáneas sigue dando exactamente 1 reserva y 49 respuestas 409 (actúa la capa 3). Así apareció un bug real: Prisma envuelve el 23P01 como su propio código `P2039`, y el traductor de errores tomaba ese código por un SQLSTATE, de modo que la barrera respondía 500. Ahora `pgCode` lee solo `meta.driverAdapterError.cause.originalCode` (`common/pg-errors.ts`, con pruebas unitarias).

Los deadlocks y errores de serialización (40P01/40001, P2034) **reintentan la transacción completa** (máx. 3). En la creación también se reintenta una violación de unicidad: puede ser un choque del código de reserva o el alta simultánea del mismo teléfono, y en el reintento se encuentra al cliente ya creado.

## Idempotencia (`POST /reservations`)
- Cabecera **`Idempotency-Key` obligatoria**: de 8 a 100 caracteres `[A-Za-z0-9_-]`, recomendado un UUID por intento. Sin ella, 400 `IDEMPOTENCY_KEY_REQUIRED`.
- La clave se registra **en la MISMA transacción** que la reserva (`INSERT … ON CONFLICT DO NOTHING`). Un duplicado simultáneo queda esperando en el índice único hasta que el primero termina, y entonces devuelve la respuesta guardada con la cabecera `Idempotent-Replayed: true`. Si el primero falla, la clave desaparece con el rollback y se puede reintentar: un 409 nunca "consume" la clave.
- Misma clave con **otro cuerpo** (hash SHA-256 de un JSON con claves ordenadas): 422 `IDEMPOTENCY_CONFLICT`. Las claves duran 24 h. *Pendiente:* purgarlas desde el worker, que necesita `rp_system`.
- Verificado: 20 reintentos simultáneos con la misma clave crean una sola reserva.
- Los cambios de estado no usan clave: los protege la **versión** (ver abajo), y un doble clic recibe 409 `VERSION_CONFLICT`.

## Reglas de negocio
- **El servidor calcula** fin, precio, moneda, duración y preparación/limpieza a partir del servicio. El navegador solo envía servicio, sucursal, recurso (opcional), inicio y cliente. Los campos de más se descartan. El inicio no admite segundos.
- **Snapshot:** `reservation_items` guarda nombre, duración, buffers y precio del momento de reservar. Cambiar el servicio después no altera reservas hechas, y **reprogramar conserva lo reservado**.
- **Ocupación** = `[inicio − preparación, fin + limpieza)`; debe caber entera en el horario de trabajo.
- **Ventana de reserva** (`bookingWindow`): el **panel** no tiene antelación mínima (atiende llamadas y clientes en el local), pero nunca permite el pasado, y admite hasta 365 días. Los **canales del cliente** (web, WhatsApp, API; Fase 4) usan la antelación del servicio o, si no tiene, la de la empresa. Fuera de la ventana: 422 `OUTSIDE_BOOKING_WINDOW`.
- **Asignación automática** (sin `resourceId`): entre los recursos que prestan el servicio en esa sucursal, activos y con `auto_assignable`, elige el **menos cargado ese día local**, luego el de menor `sortOrder` y después por id. Es determinista. Con `resourceId` explícito se puede reservar también un recurso no auto-asignable.
- **Estado inicial:** lo que crea el personal queda `confirmed`. Los canales del cliente quedan `pending` si el servicio lo exige (`requires_confirmation`) o la empresa no confirma automáticamente.
- **Cliente:** se indica por `id` o por sus datos. Con datos, **el teléfono identifica al cliente** dentro de la empresa: si ya existe se reutiliza **sin sobrescribir su ficha**, para que quien reserva no pueda cambiar los datos de otro cliente. Un cliente siempre tiene teléfono o email (`CHECK` en BD).

## Ciclo de vida
- Las transiciones salen de la máquina de estados de `booking-domain` (`pending → confirmed|cancelled`; `confirmed → in_progress|completed|cancelled|no_show`; `in_progress → completed`). Una transición inválida da 409 `INVALID_TRANSITION`.
- **Concurrencia optimista:** cada cambio envía `version`, y el `UPDATE … WHERE version = $v` la vuelve a exigir. Dos cambios simultáneos nunca se pisan: el segundo recibe 409 `VERSION_CONFLICT`.
- "No asistió" solo se puede marcar después de la hora de inicio. **Solo `cancelled` libera el horario**: un trigger de BD sincroniza `is_active`, y completadas y no-show siguen ocupando su tiempo pasado.
- Reprogramar: solo `pending`/`confirmed`. Admite nuevo inicio y opcionalmente otro recurso que preste el servicio en la sucursal; se excluye a sí misma al comprobar conflictos y suma `reschedule_count`. El límite de reprogramaciones (`max_reschedules`) se aplicará al autoservicio del cliente, no al personal.
- Cada cambio escribe, **en la misma transacción**:
  - un `reservation_event` (historial inmutable: `rp_app` no puede hacer UPDATE ni DELETE);
  - un `outbox_event` sin datos personales, para notificaciones (ADR-005);
  - la auditoría.

## Permisos y visibilidad
Con solo `reservations:read:own`, un profesional ve únicamente las reservas de su recurso: las demás dan 404, así no se revela que existen. Cambiar el estado de las suyas exige además `reservations:status`. La disponibilidad pide `reservations:create` o `reservations:reschedule`.

## Agenda frente a reservas (pendientes de ADR-013, resueltos)
- **Un bloqueo no puede pisar reservas activas** (409 `HAS_RESERVATIONS`). Se comprueba bajo el mismo bloqueo de recurso que el motor, así que no se cuela una reserva entre la comprobación y el alta. Es atómico: si un recurso choca, no se crea en ninguno.
- **Desactivar un recurso o una sucursal con reservas próximas** (pendiente/confirmada/en curso que aún no termina) da 409 `HAS_RESERVATIONS`: primero hay que reprogramarlas o cancelarlas.
- **`DELETE` de un recurso con reservas** da 409 `IN_USE` por la clave foránea, como se previó.
- **Cambiar el horario semanal con reservas ya hechas está permitido:** las reservas se mantienen. Es decisión del negocio (p. ej. reducir horario a partir de cierta fecha) y el calendario las muestra igual. Queda como mejora avisar en el panel de las reservas que quedan fuera del nuevo horario.

## Fuera de alcance (próximas fases)
- Panel de reservas (Fase 3B).
- Reservas públicas, retenciones (`hold_expires_at`) y su expiración en el worker, WhatsApp y autoservicio del cliente (Fase 4).
- Publicación del outbox, servicios múltiples por reserva y capacidad > 1 (ADR-006).
