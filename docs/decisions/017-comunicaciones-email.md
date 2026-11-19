# ADR-017 — Comunicaciones por email (Fase 5A)

**Estado:** Aceptado · **Fecha:** 2026-11-19

## Flujo (ARCHITECTURE.md §6.5)
1. **El cambio de negocio escribe un `outbox_event`** en la misma transacción (ya desde la Fase 3). Si la reserva se revierte, el evento también.
2. **El publisher**, en el worker cada 5 s, con el rol `rp_system`:
   - toma pendientes con `FOR UPDATE SKIP LOCKED`, así varias réplicas no se pisan;
   - los encola en BullMQ con **`jobId = outbox.id`**;
   - los marca publicados en la misma transacción.
   - Si muere entre encolar y marcar, reencola con el mismo id y BullMQ lo ignora. Si encolar falla, se revierte y quedan pendientes.
3. **El envío** (`NotificationsService`) corre **por empresa y con RLS**:
   - registra la notificación con `dedupe_key = sha256(evento | canal | destinatario | tipo)`, única por empresa;
   - envía fuera de la transacción y marca `sent` o `failed`.
   - Un reintento encuentra la fila: si ya se envió, no se repite (verificado por mutación). Si falló, se reintenta sobre la misma fila.
   - BullMQ: 6 intentos con espera exponencial desde 30 s.
   - Solo si el proceso muere *entre* enviar y marcar podría repetirse un email: se prefiere a perderlo ("al menos una vez").
4. **`rp_system` solo descubre** (qué eventos o qué reservas). No lee ni envía datos personales: eso ocurre con RLS.

## Qué email recibe el cliente
| Evento | Email | Enlace "Mi reserva" |
|---|---|---|
| creada (confirmada) | Reserva confirmada | sí |
| creada (pendiente) | Recibimos tu solicitud (hasta cuándo se retiene) | sí |
| pasa a confirmada | El negocio confirmó tu reserva | sí |
| reprogramada | Cambió el horario | sí |
| cancelada | Reserva cancelada | no |
| retención vencida | No pudimos confirmar tu reserva | no |
| recordatorio | Recordatorio | sí |

- En curso, completada y no asistió **no** envían nada.
- Un aviso "positivo" de una reserva ya cancelada (por ejemplo, cancelada segundos después) no se envía.
- **Cada email con enlace emite un enlace NUEVO** (`issueAccessToken`, compartido con el portal), porque en la BD solo existen hashes. Los anteriores siguen valiendo hasta que la reserva termina.
- Todo en la hora del negocio. Los textos de personas se escapan en el HTML y el asunto se limpia de saltos de línea (prueba de inyección).

## Recordatorios
- Cada minuto: reservas **confirmadas** que empiezan en las próximas `reminder_hours_before` horas (24 por defecto; `NULL` = sin recordatorio).
- Solo de clientes con email.
- **Sin recordatorio previo para ESE inicio** (`notifications.reference_at`).
- **Si se reprograma**, el recordatorio del horario viejo queda obsoleto (se comprueba al enviar) y el nuevo horario tiene el suyo.
- **No se recuerda lo reservado ya dentro de la ventana**: quien reserva para dentro de 5 h acaba de recibir la confirmación.

## Consentimiento y preferencias (se comprueban AL ENVIAR)
- **Al reservar en el portal** se registra el consentimiento **transaccional** (email si lo dio y WhatsApp por el teléfono) con la **versión del texto mostrado** (`portal-2026-11`) y la IP. Es historial append-only: `rp_app` no puede editarlo ni borrarlo.
- **El estado vigente es la última fila.** Si el cliente revocó el consentimiento, la notificación queda `suppressed` y no se envía. Sin filas (cliente creado en el panel), el transaccional se permite: es parte de prestar el servicio.
- **Marketing nunca se asume.** Requiere una casilla explícita, fuera del MVP.
- **Interruptor por empresa:** `customer_emails_enabled`.
- **Validar con asesoría legal** (Ley 21.719) antes de producción.

## Privacidad y operación
- `notifications.recipient` es un dato personal: no aparece en logs. Los logs llevan ids, empresa y tipo.
- **Los errores del proveedor se guardan sin direcciones**: se reemplazan por `<email>`, porque los SMTP suelen incluirlas.
- **Proveedor:** el mismo puerto `EmailProvider`. Hoy SMTP (Mailpit en local). Resend u otro cuando se decida el hosting (ADR-008).
- **`PORTAL_URL`** (nueva variable de entorno): base de los enlaces "Mi reserva" en los emails.
- **Pruebas:** el worker real de las pruebas usa un buzón falso. Antes despachaba por SMTP los eventos de la base de pruebas, y así se detectó.

## Panel (Fase 5B)
- **Configuración** (`GET/PATCH /tenants/current/settings`; leer con `tenant:read`, editar con `tenant:update`):
  - portal activado, antelación mínima y máxima, rejilla de horarios;
  - confirmación automática y retención de las pendientes;
  - qué puede hacer el cliente desde su enlace y con qué plazos;
  - máximo de cambios, antiabuso, emails y recordatorio.
  - Es una edición **parcial** (esquema base sin defaults, ADR-013). La pantalla solo envía lo que cambió.
  - Auditada con antes y después. Aplica a la siguiente operación: motor, portal y worker leen la misma fila.
- **Centro de comunicaciones** (`GET /notifications`, permiso `notifications:read`): qué se envió, a quién, para qué reserva, estado, intentos y error (sin direcciones).
  - El detalle de cada reserva muestra sus mensajes.
- **Reintento manual** (`POST /notifications/:id/retry`, permiso nuevo **`notifications:resend`**): solo para las `failed`, tras agotar los automáticos.
  - **La API no envía:** deja la fila `queued` y un evento `notification.retry` en el outbox, en la misma transacción.
  - El worker reintenta sobre la misma fila (misma `dedupe_key`): si entretanto se envió, no se repite.
- **Permiso nuevo en empresas existentes:** los roles se copian al crear cada empresa, así que la migración 0011 otorga `notifications:resend` a los roles **de sistema** (propietario, administrador, gerente, recepción) de las empresas existentes. Los roles personalizados no se tocan.
- **`VITE_PORTAL_URL`** (panel): base del enlace a la página pública del negocio.

## Fuera de alcance (Fase 5B y siguientes)
- Avisos al negocio (nueva reserva pública).
- Plantillas editables por empresa.
- Baja con un clic desde el email.
- Estados `delivered`/`read` vía webhooks del proveedor.
