# ADR-007 — Supuestos de negocio por defecto del MVP

**Estado:** Aceptado · **Fecha:** 2026-11-18 · Cierra los pendientes del blueprint §20 con valores por defecto **configurables por tenant**.

| # | Pendiente | Supuesto |
|---|---|---|
| 1 | Varios servicios por reserva | El esquema soporta 1..n `reservation_items`; el MVP impone **1 servicio por reserva** |
| 2 | Elección de profesional | El cliente elige uno o "cualquiera" (auto-asignación determinista) |
| 3 | Capacidad > 1 | Ver ADR-006 |
| 4 | Confirmación del negocio | `auto_confirm = true`; por servicio `requires_confirmation` lo anula |
| 5 | Cancelación/reprogramación | Ventana 24 h; máx. 2 reprogramaciones; aprobación opcional |
| 6 | Reprogramación y recurso | Conserva recurso; si era auto-asignado y no está libre, reasigna |
| 7 | OTP para gestión web | No en MVP; token de alcance limitado y corta vida |
| 8 | Onboarding WhatsApp | Token manual en el piloto; Embedded Signup cuando Meta lo apruebe |
| 9 | Proveedor de email | Resend tras la interfaz `EmailProvider` |
| 10 | Hosting | Ver ADR-008 |
| 11 | Retención/privacidad | Consentimiento granular + anonimización bajo solicitud; plazos tras asesoría legal |
| 12 | Planes y cobro | Fase 8; el piloto sin cobro automatizado |

Decididos por Claude con la delegación del usuario ("la primera decídela tú").
