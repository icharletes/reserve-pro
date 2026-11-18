-- ReservePro — Migración 0004: verificación de email.
-- Tabla global (por usuario, sin tenant_id => sin RLS), igual que password_reset_tokens.
-- Solo se guarda el SHA-256 del token; el token en claro viaja únicamente por email.

CREATE TABLE email_verification_tokens (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id),
  token_hash  bytea NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_email_verification_user ON email_verification_tokens (user_id);

-- Faltaba el índice por usuario en los tokens de recuperación de contraseña (invalidar los anteriores).
CREATE INDEX ix_password_reset_user ON password_reset_tokens (user_id);
