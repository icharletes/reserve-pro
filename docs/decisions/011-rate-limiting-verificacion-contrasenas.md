# ADR-011 — Rate limiting, verificación de email y gestión de contraseñas

**Estado:** Aceptado · **Fecha:** 2026-11-18

## Rate limiting (Redis)
- Contador de **ventana fija atómico** (Lua: `INCR` + `PEXPIRE` en un paso). Implementación propia en vez de `@nestjs/throttler`: necesitamos claves por IP, email, usuario y empresa, y decidir qué pasa si Redis cae. Límite de la ventana fija: una ráfaga puede llegar a 2× en el cambio de ventana; aceptable para anti-abuso (no es facturación).
- **Dos guards**: *antes* de autenticar (IP / email: barato, protege la BD de inundaciones) y *después* (usuario / empresa). Orden global: límite IP → AuthGuard → límite usuario → PermissionsGuard.
- Regla general **300 req/min por IP** para toda la API, más reglas por endpoint (login 20/min por IP y 10/15 min por IP+email; registro 5/h; forgot-password 3/h por email; invitaciones 30/h por usuario y 100/día por empresa…).
- Las claves usan **SHA-256 de la identidad**: Redis nunca guarda emails ni IPs en claro. 429 `application/problem+json` con `Retry-After`.
- **Fail-open** si Redis cae: se registra el error y se deja pasar (preferimos disponibilidad a bloquear a todos). Las defensas por cuenta (bloqueo de login) no dependen de Redis. `/health/ready` informa `redis: down` (503). Sin `REDIS_URL` usa memoria local (solo válido con una instancia).
- **`TRUST_PROXY`** (saltos de proxy confiables; 0 por defecto). Con 0, `X-Forwarded-For` se ignora: un atacante no puede reiniciar su contador cambiando de "IP". Detrás de un balanceador hay que fijarlo, o todos los clientes compartirían la IP del proxy. Probado en ambos sentidos.

## Verificación de email
- La cuenta nace **sin verificar**. Hasta verificar puede usar la app, pero `@RequireVerifiedEmail()` bloquea acciones abusables (hoy: enviar invitaciones a terceros) con `EMAIL_NOT_VERIFIED`. Cierra el riesgo "cuenta desechable usada como relé de correo" del ADR-010.
- Aceptar una invitación o restablecer la contraseña **verifican** el email: el token llegó al buzón.

## Recuperación y cambio de contraseña
- `forgot-password` responde **siempre 202**, exista o no la cuenta; el correo sale en **segundo plano** para igualar tiempos (la latencia del SMTP delataría la cuenta). Un nuevo enlace invalida los anteriores. Vigencia 1 h; verificación 24 h.
- `reset-password` es atómico (un solo uso), **cierra TODAS las sesiones**, desbloquea la cuenta y envía un aviso de seguridad. Una contraseña débil se rechaza **sin consumir** el enlace.
- `change-password` exige la actual y cierra las **otras** sesiones, conservando la actual. Una contraseña actual incorrecta devuelve **400** (no 401) para que el cliente no interprete "sesión caducada" y cierre sesión.
- Tokens: 256 bits, solo el SHA-256 en BD, en el fragmento (#) del enlace y en el cuerpo de las peticiones; nunca en la URL.

## Auditoría
`GET /tenants/current/audit-logs` (permiso `audit:read`: propietario y administrador): filtros por acción, entidad, actor y fechas; más reciente primero; cursor por `id` (UUIDv7).
Los eventos de seguridad de cuenta (cambio de contraseña, etc.) son **globales al usuario**, no de una empresa, así que no van a `audit_logs` (que es por tenant): se registran en el log estructurado. Pendiente: tabla de eventos de seguridad de plataforma.

## Riesgos abiertos
- Un atacante con muchas IPs y emails distintos puede eludir los límites por IP; CAPTCHA (Turnstile) queda como capa adicional en endpoints públicos.
- Fixed-window: ráfagas de hasta 2× en el borde de la ventana.
