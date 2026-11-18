# ADR-001 — Frontend: Astro para el portal, SPA Vue para el panel

**Estado:** Aceptado · **Fecha:** 2026-11-18

## Contexto
El portal público (`/{slug}`) necesita SEO, buen rendimiento móvil y SSR por tenant/dominio. El panel administrativo es una aplicación autenticada con calendario, estado compartido, routing y guards.

## Decisión
- `apps/web`: **Astro** con islas Vue, solo para el portal público.
- `apps/admin`: **Vue 3 + Vite + Vue Router + Pinia** (SPA) para el panel y la consola SaaS.
- Componentes compartidos en `packages/ui`; contratos en `packages/contracts`; cliente en `packages/api-client`.
- Equipo: dos personas (usuario + Claude). Astro separado confirmado por el usuario.

## Consecuencias
- (+) Cada superficie usa la herramienta adecuada; el panel no arrastra el modelo de islas.
- (+) Sesión y despliegue del panel más simples (SPA estática contra la API).
- (−) Dos build targets y dos configuraciones de routing/auth.
- Ningún frontend contiene reglas de negocio: el backend es la autoridad.

## Alternativa descartada
Nuxt 3 para ambas superficies (un solo framework). Reversible sin afectar backend ni contratos.
