# ADR-012 — Worker, cliente de API, frontends, calidad (lint/formato) y CI

**Estado:** Aceptado · **Fecha:** 2026-11-18

## Worker (BullMQ)
- Mismo código y módulos que la API, otro punto de entrada (`worker.ts`, ADR-002): `NestFactory.createApplicationContext`, sin servidor HTTP, cierre ordenado con SIGTERM.
- Las colas viven **solo en el worker**, nunca en la API: la API escala a N réplicas sin duplicar trabajo programado. Prefijo de cola por entorno (`QUEUE_PREFIX`).
- Programador **idempotente** (`upsertJobScheduler`): varias réplicas del worker comparten UN solo programador.
- Primera tarea: purga diaria (03:00 UTC) de tokens vencidos, por lotes de 1 000, con 7 días de gracia. Opera sobre tablas **globales** (sin RLS). Los trabajos de tenant futuros deben llevar `tenantId` en el payload y usar `TenantDb.run({ tenantId }, …)`.
- Un job con nombre desconocido **falla** (no se ignora en silencio).

## Cliente de API (`packages/api-client`)
- Escrito a mano y tipado con los contratos Zod (más simple y estricto que generarlo desde OpenAPI; el OpenAPI sigue publicándose para terceros). **Valida cada respuesta** contra el esquema: detecta divergencias API/cliente en ejecución.
- Access token **solo en memoria** (jamás `localStorage`; una regla de lint lo impide en el panel). Refresh por cookie HttpOnly. Ante un 401: un único refresh con exclusión mutua (5 peticiones simultáneas ⇒ 1 refresh) y un único reintento; sin bucle infinito.
- Los errores 5xx y las respuestas no JSON nunca exponen detalle al usuario; solo el `requestId` de seguimiento.

## Panel (`apps/admin`) y portal (`apps/web`)
- Panel: SPA Vue. En desarrollo comparte **origen** con la API vía proxy de Vite (`/api`), de modo que la cookie del refresh es first-party y no hace falta CORS; en producción lo mismo con el balanceador. Los tokens de los emails se leen del fragmento (`#`) y **se borran de la URL**; `safeRedirect` impide el open redirect; `bootstrap()` degrada a visitante si la API no responde.
- Portal: Astro 7 SSR. Valida el slug (formato y `RESERVED_SLUGS`) **antes** de consultar nada; CSP, `X-Frame-Options`, etc. en todas las respuestas; `noindex` mientras sea un marcador; `checkOrigin`. `RESERVED_SLUGS` vive en `contracts` y un test lo compara con la tabla `reserved_slugs`.
- **Limitación conocida:** `astro check` no funciona (dependencia beta de `@astrojs/check` con `emnapi` incompatible). El typecheck del portal usa `astro sync` + `tsc` (cubre los `.ts`) y `astro build` valida las plantillas `.astro`. Reevaluar al actualizar Astro.
- Astro 7 exige **Node ≥ 22.23.4** (el proyecto usa 22.23.5).

## Calidad: ESLint + Prettier
- ESLint 10 + `typescript-eslint` + `eslint-plugin-vue`, **con `--max-warnings 0`**. Reglas con tipos (`no-floating-promises`, `no-misused-promises`) en código de producción.
- **Las reglas de arquitectura se hacen cumplir con lint** y están verificadas con violaciones reales: límites de dependencias entre paquetes (booking-domain puro; contracts solo zod; el navegador no importa código de servidor ni imports "por dentro" de otros paquetes), prohibición de `$queryRawUnsafe`/`$executeRawUnsafe` (inyección SQL), de `localStorage`/`sessionStorage` en el panel y de `v-html` (XSS).
- Trampa de flat config: si varios bloques definen `no-restricted-imports`, **el último reemplaza a los anteriores** (no se combinan). Por eso todos usan el helper `restrict()`, que siempre incluye los imports profundos. Esto se descubrió porque se probaron las reglas con archivos que las incumplían: 4 de 9 no detectaban nada.
- `eslint-config-prettier` va al final: un único dueño del estilo.

## CI (GitHub Actions)
- Servicios reales: PostgreSQL 16 (con el mismo script de roles que Docker Compose) y Redis con `noeviction`. Pasos: lint, formato, tipos, build, pruebas, **schema.prisma coincide con las migraciones** (`db pull` sin diff) y **OpenAPI al día**. Permisos mínimos (`contents: read`), concurrencia con cancelación, timeouts.
- Auditoría de dependencias como job informativo (`continue-on-error`). Dependabot semanal agrupado; ignora Prisma (fijado a mano) y TypeScript mayor (ver ADR-009).
- **Pendiente de validar en GitHub:** el workflow no se ha ejecutado en un runner real; sus pasos se reprodujeron localmente uno a uno (incluido el script de roles contra un Postgres nuevo).
- Pendiente: fijar las acciones por SHA, y proteger la rama `main` exigiendo este check.
