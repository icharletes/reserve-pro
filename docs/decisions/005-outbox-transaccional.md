# ADR-005 — Notificaciones mediante transactional outbox

**Estado:** Aceptado · **Fecha:** 2026-11-18

## Contexto
Si se confirma la reserva y luego falla la publicación a Redis, se pierde la notificación. No se acepta pérdida ni duplicados.

## Decisión
- El evento se escribe en `outbox_events` **en la misma transacción** que el cambio de negocio.
- Un publisher (worker, `rp_system`) lee pendientes con `FOR UPDATE SKIP LOCKED`, encola en BullMQ con `jobId = outbox.id` y marca `published_at`.
- El processor crea `notifications` con `UNIQUE (tenant_id, dedupe_key)`; los reintentos no duplican envíos.
- Consentimiento y preferencias se verifican **al enviar**.

## Consecuencias
- (+) Sin pérdida de eventos ante caídas entre commit y cola; reintentos seguros.
- (−) Latencia adicional del polling del publisher; mitigable con LISTEN/NOTIFY más adelante.
