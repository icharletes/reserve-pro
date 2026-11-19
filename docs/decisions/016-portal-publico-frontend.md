# ADR-016 — Portal público: frontend y pruebas E2E (Fase 4B)

**Estado:** Aceptado · **Fecha:** 2026-11-19

## Páginas
- **`/{slug}` (SSR):**
  - Astro pide el negocio a la API **desde el servidor**. Si no existe, está inactivo o no tiene reservas en línea, responde 404 de verdad (mismo 404 en todos los casos).
  - Con una sola sucursal, los servicios ya vienen en el HTML (SEO, sin parpadeo).
  - El flujo es una isla Vue (`BookingFlow`): sucursal → servicio → profesional ("cualquiera" o uno concreto) → día y hora → datos → confirmar.
  - El foco acompaña a cada paso, que se anuncia con su título.
- **`/mi-reserva#token=…`:**
  - Ver, cambiar horario y cancelar.
  - El token va en el **fragmento**: el navegador no lo envía al servidor ni en `Referer`.
  - La página responde con `Referrer-Policy: no-referrer` y `Cache-Control: no-store`. El middleware deja que una página **endurezca** el referer, nunca que lo relaje.
  - Tras reservar se llega con `&nueva=1`, que muestra el aviso "guarda este enlace" y se borra de la URL (`history.replaceState`) para no repetirlo.
- **Slugs reservados:** `mi-reserva` y `reservas` (contracts y migración 0009). La prueba de sincronía entre código y BD ya existía.

## Reglas
- **Horas en la zona del negocio**, no la del visitante: la E2E corre con el navegador en Madrid a propósito.
- **El navegador habla con un solo origen** (`/api` detrás del mismo dominio), por eso la CSP es `connect-src 'self'`. Sin cookies (`credentials: 'omit'`).
- **Idempotency-Key** por intención de reservar, reutilizada al reintentar lo mismo (mismo patrón que el panel).
- **Errores esperados:**
  - 409 `SLOT_UNAVAILABLE`: vuelve al paso del horario con aviso y recarga los horarios.
  - `VERSION_CONFLICT`: recarga la reserva.
  - 5xx: mensaje genérico, sin detalles internos.
- **El SSR reenvía la IP del visitante** (`X-Forwarded-For`). Si no, el rate limit por IP de la API vería a todos los visitantes como uno solo. En producción la API debe confiar en el portal como proxy (`TRUST_PROXY`). Si no confía, limita por la IP del portal: más estricto, nunca más laxo.
- **`normalizePhone`** pasó a `@reservepro/contracts`, compartida por el panel y el portal.
- **Tipos de los `.vue` del portal:** `astro check` no funciona (dependencia beta), así que el `typecheck` añade `vue-tsc`, la misma herramienta del panel. Se verificó que detecta un error introducido a propósito.

## Pruebas de extremo a extremo (Playwright)
- **Paquete `e2e/`.** Dependencias nuevas:
  - `@playwright/test` **1.64.1**, fijada y con más de un mes publicada;
  - `pg` y `dotenv`, ya presentes en el repo.
  - Ninguna llega a producción. La arquitectura ya preveía Playwright en esta fase (§9).
- **Arranca todo como en producción:**
  - la API compilada;
  - el portal compilado detrás de un "balanceador" mínimo (`serve-portal.mjs`: `/api` → API, resto → Astro);
  - una base propia, `reservepro_e2e_test`, recreada con todas las migraciones antes de cada ejecución.
  - Puertos 3100/4400: no choca con el entorno de desarrollo levantado.
- **Escritorio y móvil (Pixel 7). Cubre:**
  - reservar, abrir el enlace en frío, cambiar el horario y cancelar;
  - horario tomado por otra persona entre medio;
  - 404 y enlace inválido;
  - cabeceras de seguridad;
  - política fuera de plazo.
  - Los casos de plazo usan un negocio con plazos de 1000 h, así no dependen de la hora a la que corran.
- **Navegador:**
  - en CI, el Chromium de Playwright (`playwright install --with-deps chromium`);
  - en local, el **Chrome instalado**, porque Playwright 1.64 ya no publica Chromium para macOS 13. Se puede elegir otro con `E2E_CHANNEL`.
- Se ejecuta con `pnpm test:e2e`. No está en `pnpm test` (necesita navegador); la CI lo corre en un paso propio.

## Pendientes conocidos
- **El enlace de gestión solo se muestra en pantalla.** El email con el enlace y los recordatorios llegan en la Fase 5. Mientras tanto, si el cliente lo pierde, el negocio gestiona la reserva desde el panel.
- **El panel aún no tiene pantalla de configuración** de políticas (plazos, confirmación, máximo de cambios ni portal activo). Hoy solo hay valores por defecto.
- **CAPTCHA (Turnstile)**: diferido (ADR-015).
- **Dominio propio por negocio**: más adelante.
