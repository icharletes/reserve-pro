# ADR-009 — Stack de la API: NestJS 12 (ESM), TypeScript 5.9, validación con Zod propia

**Estado:** Aceptado · **Fecha:** 2026-11-18

## Contexto
Al crear `apps/api` hubo que fijar versiones y herramientas. El monorepo es 100 % ESM (`"type": "module"`).

## Decisiones
- **NestJS 12.5.1** (ESM nativo; encaja con el monorepo). Express como plataforma.
- **TypeScript 5.9.3** en todo el workspace. TS 7 emite metadata de decoradores, pero `typescript-eslint` aún declara soporte solo hasta TS `<6.1`, y necesitamos lint en CI.
- **Sin `nestjs-zod`:** no declara compatibilidad con Nest 12. Se usa un `ZodPipe` propio (~15 líneas) con los esquemas de `@reservepro/contracts`. OpenAPI se generará desde esos esquemas (`z.toJSONSchema` de Zod 4) en una fase posterior.
- **Pruebas con Vitest + `unplugin-swc`:** el DI de Nest necesita `emitDecoratorMetadata`, que esbuild/oxc no emiten. El build de producción usa `tsc`.
- **Sin `nestjs-pino`:** `pino` directo con redacción de campos sensibles (menos capas sobre Nest 12).
- **Auth:** `jose` (HS256, `algorithms` fijado) + `argon2` (Argon2id, parámetros OWASP). Refresh opaco con rotación y detección de reutilización.

## Autorización fail-closed
Todo endpoint debe declarar `@Public()`, `@Authenticated()` o `@RequirePermissions(...)`. Si falta, `AuthGuard` rechaza con 500 **antes** de ejecutar el handler. Hay un test con un controlador deliberadamente sin decorar.

## El principal se reconstruye desde la BD en cada request
El `AuthGuard` no confía solo en el JWT: verifica sesión, usuario, empresa y membresía activos. Desactivar un usuario, una membresía o una empresa, o cerrar sesión, tiene efecto inmediato. Coste: 1–2 consultas por request. Mitigación futura: caché corta en Redis con invalidación activa (no antes de medir).

## Consecuencias
- (+) Todo ESM, sin dependencias dudosas sobre Nest 12, seguridad verificable por tests.
- (−) Cuando salga soporte de lint para TS 7 se podrá reevaluar la versión.
- (−) `/tenants/current` y similares usan `runAsPrincipal` solo con `tenantId`; las lecturas "propias" entre empresas solo existen sin tenant activo (migración 0002).
