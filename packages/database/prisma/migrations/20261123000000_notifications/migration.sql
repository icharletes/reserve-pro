-- ReservePro — Migración 0010: comunicaciones por email (Fase 5). Ver ARCHITECTURE.md §4.7 y §6.5, ADR-017.
--
-- Entrega fiable: outbox (misma transacción que el cambio) -> publisher -> cola -> notificación con
-- dedupe_key ÚNICO por empresa: un reintento del job nunca crea una segunda notificación.

CREATE TABLE notifications (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  reservation_id       uuid,
  customer_id          uuid,
  channel              text NOT NULL CHECK (channel IN ('email','whatsapp')),
  type                 text NOT NULL,           -- reservation.created, reservation.reminder, …
  recipient            varchar(254) NOT NULL,   -- dato personal: nunca se registra en logs
  subject              varchar(300),
  dedupe_key           text NOT NULL,           -- sha256(evento | canal | destinatario | tipo)
  reference_at         timestamptz,             -- recordatorios: la hora de inicio a la que se refieren
  status               text NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued','sending','sent','delivered','read','failed','suppressed')),
  attempts             int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error           varchar(500),
  provider_message_id  text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, dedupe_key),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, reservation_id) REFERENCES reservations (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id)    REFERENCES customers (tenant_id, id)
);
CREATE INDEX ix_notifications_tenant_status ON notifications (tenant_id, status, created_at DESC);
CREATE INDEX ix_notifications_reservation  ON notifications (tenant_id, reservation_id, created_at);
CREATE TRIGGER trg_notifications_updated BEFORE UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION rp_set_updated_at();

-- Consentimientos: HISTORIAL (append-only). El estado vigente es la última fila por (cliente, canal, finalidad).
CREATE TABLE notification_consents (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  customer_id       uuid NOT NULL,
  channel           text NOT NULL CHECK (channel IN ('email','whatsapp')),
  purpose           text NOT NULL CHECK (purpose IN ('transactional','marketing')),
  status            text NOT NULL CHECK (status IN ('granted','revoked')),
  source            text NOT NULL CHECK (source IN ('public_web','admin','whatsapp','email_link')),
  evidence_version  varchar(40),               -- versión del texto que vio la persona
  evidence_ip       inet,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id)
);
CREATE INDEX ix_consents_current ON notification_consents (tenant_id, customer_id, channel, purpose, occurred_at DESC);

SELECT rp_enable_tenant_rls('notifications');
SELECT rp_enable_tenant_rls('notification_consents');
REVOKE UPDATE, DELETE ON notification_consents FROM rp_app;

-- Configuración: recordatorio N horas antes (NULL = sin recordatorio) y emails al cliente activados.
ALTER TABLE tenant_settings
  ADD COLUMN reminder_hours_before int DEFAULT 24 CHECK (reminder_hours_before IS NULL OR reminder_hours_before BETWEEN 1 AND 168),
  ADD COLUMN customer_emails_enabled boolean NOT NULL DEFAULT true;
