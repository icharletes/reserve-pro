# ADR-015 — Portal público: backend (Fase 4A)

**Estado:** Aceptado · **Fecha:** 2026-11-19

## Rutas
- `GET /public/tenants/:slug`, `…/services?locationId`, `…/availability` y `POST …/reservations`.
- `POST /public/manage/{lookup,availability,cancel,reschedule}`.
- **Desviación del blueprint** (`/public/:slug`, `GET /public/reservations/:token`):
  - Se usa `/public/tenants/:slug` porque un slug como `manage` o `reservations` chocaría con las rutas de gestión.
  - **El token va SIEMPRE en el cuerpo de un POST**, nunca en la URL ni en la query: las URLs quedan en logs, historial y cabeceras `Referer`. El portal lo lee del fragmento (`#token=…`), que el navegador no envía al servidor.
- Están en la lista cerrada de endpoints públicos (`openapi.e2e.test.ts`). Todos tienen rate limit.

## La empresa nunca viene del navegador
- **Por slug:** `rp_resolve_tenant_by_slug` (SECURITY DEFINER, ya existente). Una empresa inactiva, inexistente o con el portal apagado (`public_booking_enabled`) responde el **mismo 404**.
- **Por token:** `rp_resolve_reservation_token(hash)`, nueva y también SECURITY DEFINER. Solo acepta el hash exacto de un token vigente, no revocado y de una empresa activa.
- Después, todo corre con `TenantDb.run({ tenantId })`, es decir, **con RLS**, igual que el panel.

## Mismo motor que el panel
- El motor ya no lee la sesión. Recibe un **`Actor`** explícito con:
  - empresa;
  - canal (`admin` | `public_web` | …);
  - tipo (`user` | `customer` | `system`);
  - filtro de visibilidad.
- Panel, portal y worker usan las mismas funciones (`createAs`, `transitionAs`, `cancelAs`, `rescheduleAs`): bloqueo, re-validación, EXCLUDE, idempotencia, eventos, outbox y auditoría.
- La idempotencia toma la empresa de la transacción (`rp_current_tenant()`), no de la sesión.
- **Diferencias del canal público:**
  - Solo recursos `is_bookable_online`.
  - Antelación mínima y máxima del servicio o de la empresa (el panel no tiene mínima).
  - Teléfono obligatorio.
  - Estado `pending` si el servicio o la empresa exigen confirmación.
  - Ámbito de idempotencia propio (`public.reservation.create`).

## Enlace de gestión (`reservation_access_tokens`, migración 0007)
- Es un token de 256 bits. **En la BD solo se guarda su SHA-256.**
- Se devuelve UNA vez, en el cuerpo de la respuesta de creación, con `Cache-Control: no-store`.
- **Alcances:** `view` siempre; `cancel` y `reschedule` según `self_service_actions`.
- **Vence al terminar la reserva.** Si se reprograma, el vencimiento se mueve con ella.
- **Un replay idempotente emite un enlace NUEVO:** el anterior no se puede reconstruir, porque solo existe su hash. Ambos siguen valiendo. Obtenerlo exige la misma `Idempotency-Key` (aleatoria del cliente) y el mismo cuerpo, durante 24 h.
- **No enumerable:** un token inventado, vencido o revocado recibe la misma respuesta (400 `LINK_INVALID`).
- **Sin datos personales:** la vista pública NO incluye nombre, teléfono ni email del cliente. Si alguien reserva con el teléfono de otra persona, el sistema reutiliza esa ficha (ADR-014), y el enlace no debe revelar sus datos.

## Políticas de autogestión
`selfServicePolicy()` decide **a la vez** lo que se muestra (`canCancel`, `canReschedule`, `policyNote`) y lo que se permite. Si una acción no se permite: 409 `POLICY_VIOLATION`.
- **Cancelar:**
  - requiere el alcance `cancel` y que esté activado en `self_service_actions`;
  - con `cancel_requires_approval` → "contacta al negocio";
  - debe quedar al menos `cancel_window_hours` antes del inicio.
- **Reprogramar:**
  - requiere su alcance;
  - debe quedar al menos `reschedule_window_hours` antes del inicio;
  - `reschedule_count < max_reschedules`.
  - Conserva el profesional (simplificación de §10 #6; la reasignación queda para después), y la propia reserva no cuenta como ocupada al buscar horarios.
- **Orden de comprobación:**
  - Reprogramar valida la política dentro de la misma transacción.
  - Cancelar la valida en una lectura previa. La `version` enviada protege de cambios intermedios.
- **Versión en vez de Idempotency-Key** en cancelar y reprogramar públicos, con la misma protección: un doble envío recibe 409 en vez de repetir la acción.

## Retenciones (`pending`)
- `hold_expires_at = ahora + pending_hold_minutes` (por defecto 30).
- **La retención vencida deja de ocupar de inmediato:**
  - la disponibilidad la ignora;
  - la escritura la libera (`expireHolds`) con los recursos bloqueados, antes de comprobar;
  - así no hay que esperar al worker para volver a ofrecer el horario.
- **Worker, cada minuto (`expire-holds`):**
  - `rp_system` solo **descubre** qué empresas tienen retenciones vencidas;
  - la liberación corre por empresa con RLS y con la misma función que el motor;
  - queda el evento `expired` (actor `system`) y el outbox.
  - Es idempotente: la condición se repite en el UPDATE, así que no toca una reserva confirmada entre medio.
- **Worker, a diario:** purga `idempotency_keys` vencidas (pendiente de ADR-014).

## Antiabuso
- **Rate limit:**
  - lectura: 120/min por IP;
  - disponibilidad: 60/min;
  - reservar: 10 cada 10 min por IP **y 5 por hora por teléfono** (nueva identidad `phone`; el límite cuenta intentos aunque fallen);
  - gestión: 30/min de lectura y 10 cada 10 min de escritura.
- **Acaparamiento:** como máximo `max_active_public_per_customer` (3) reservas futuras activas por cliente desde canales públicos. Las del personal no cuentan. Se cuentan **con el cliente bloqueado** (`FOR UPDATE`), así dos reservas simultáneas no se saltan el límite.
- **CAPTCHA (Turnstile):** diferido. Se activará con un verificador inyectable cuando haya un dominio público. Mientras tanto actúan los límites anteriores.

## Hallazgo de seguridad corregido (migración 0008)
- **El hueco:** la partición `audit_logs_default` no tenía RLS. Como las políticas de una tabla particionada solo se aplican al consultar el padre, `rp_app` podía leer la auditoría de **todas** las empresas consultando la partición directamente. La app no lo hacía, pero era un hueco en la defensa en profundidad.
- **La corrección:** se quitaron a `rp_app` todos los privilegios directos sobre la partición y se forzó RLS en ella.
- **Pruebas nuevas:**
  - **toda tabla con `tenant_id` tiene RLS habilitado y forzado** (antes no existía una prueba automática general);
  - la partición no se puede leer directamente.
- **Regla:** las particiones futuras deben crearse con el mismo tratamiento.
