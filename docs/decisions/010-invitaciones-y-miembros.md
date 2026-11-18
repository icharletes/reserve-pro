# ADR-010 — Invitaciones, miembros y anti-escalada de privilegios

**Estado:** Aceptado · **Fecha:** 2026-11-18

## Invitaciones
- Token de **256 bits** aleatorio; en la BD solo su SHA-256 (`invitations.token_hash`). Nunca aparece en respuestas de la API, auditoría ni logs.
- **El token viaja en el cuerpo (POST), no en la URL**: `POST /invitations/preview` y `/accept`. Así no queda en logs de acceso ni de proxies. En el email el enlace usa el **fragmento** (`/accept-invitation#token=…`), que el navegador no envía al servidor.
- Vigencia 7 días. Una sola pendiente por email y empresa (índice parcial único `accepted_at IS NULL AND revoked_at IS NULL`). Revocar no borra (trazabilidad). Reenviar rota el token.
- Tope de **50 pendientes por empresa** (evita usar la plataforma como relé de correo).
- Token inexistente, usado, revocado, vencido o de empresa suspendida ⇒ **misma respuesta** (`INVITATION_INVALID`).
- Quien acepta aún no pertenece a la empresa, así que RLS no le dejaría leer la invitación: se resuelve con `rp_resolve_invitation(hash)` (`SECURITY DEFINER`, solo por hash exacto, datos mínimos). Misma técnica que `rp_resolve_tenant_by_slug`.
- Aceptar es **atómico**: el reclamo (`UPDATE … WHERE accepted_at IS NULL …`) y la creación de membresía van en una transacción; con 5 aceptaciones simultáneas solo una gana.
- **Cuenta nueva**: pide nombre y contraseña, crea la cuenta con `email_verified_at` (el token llegó al buzón) e inicia sesión. **Cuenta existente**: se une pero **no** se inicia sesión (un token no sustituye a la contraseña).
- El email de la cuenta es siempre el de la invitación; no puede cambiarse al aceptar.
- El correo se envía **después** del commit; si falla, la invitación existe (`emailSent:false`) y se reenvía. Detrás del puerto `EmailProvider` (SMTP/nodemailer; Mailpit en local). La Fase 5 lo envolverá con el outbox (ADR-005).

## Anti-escalada de privilegios
- Solo se puede **otorgar** un rol cuyos permisos sean subconjunto de los del actor, y solo **gestionar** a un miembro cuyos permisos actuales lo sean. El techo lo marca el propio actor: sin listas de excepciones por rol. Consecuencia: solo un propietario crea propietarios (el rol owner incluye `billing:manage`).
- La comparación aplica **implicación**: `x` implica `x:own` (por eso la plantilla `admin` no repite los `:own`). Sin esto, un admin no podía gestionar a un profesional (bug hallado por los tests).
- Nadie puede modificarse a sí mismo (`CANNOT_MODIFY_SELF`).
- **Último propietario:** la empresa nunca queda sin propietario activo, ni con operaciones simultáneas: se bloquean (`FOR UPDATE`, orden por id, sin deadlocks) los propietarios activos antes de decidir. Test: dos propietarios que se desactivan mutuamente a la vez.

## Paginación
Por cursor sobre `id` (keyset). **No** sobre `created_at`: Postgres guarda microsegundos y JS solo milisegundos, lo que repetiría filas. Los UUIDv7 son ordenables por tiempo.

## Riesgos abiertos
- **Abuso del envío de invitaciones** por cuentas desechables: falta verificación de email del propietario y rate limiting (pendiente Fase 1 / Fase 5).
- `ALREADY_MEMBER` / `ALREADY_INVITED` revelan a un administrador si un email es miembro/invitado de SU empresa; se considera aceptable (solo dentro de su empresa).
