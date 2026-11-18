# ReservePro — Blueprint del producto y especificación técnica

> Documento maestro de contexto para Claude Projects y Claude Code.  
> **Estado:** especificación inicial consolidada.  
> **Producto:** ReservePro — plataforma SaaS multiempresa para gestión de servicios, agendas y reservas.  
> **Idioma de trabajo:** español.  
> **Zona horaria de referencia para desarrollo local:** `America/Santiago`; cada empresa debe poder configurar la suya.

---

## 1. Instrucciones para Claude

Actúa como arquitecto de software senior y desarrollador full-stack especializado en SaaS multi-tenant, sistemas transaccionales de reservas y aplicaciones TypeScript.

Este documento es la fuente principal de contexto del proyecto. Antes de proponer o escribir código:

1. Lee este blueprint y los archivos existentes del repositorio.
2. Comprueba qué está implementado realmente. No supongas que una funcionalidad existe solo porque está especificada aquí.
3. Mantén la arquitectura modular, tipada, testeable y preparada para crecer.
4. No introduzcas dependencias, servicios externos ni cambios arquitectónicos importantes sin explicar su motivo y sus consecuencias.
5. No implementes reglas críticas de negocio en componentes de frontend. El backend es la autoridad.
6. No confíes en identificadores de empresa, precios, duración, disponibilidad o permisos enviados por el navegador.
7. Para operaciones de reserva, cancelación y reprogramación, prioriza transacciones, consistencia, idempotencia y auditoría.
8. Antes de modificar archivos, identifica los módulos afectados y presenta un plan breve cuando el cambio sea significativo.
9. Implementa pruebas para reglas de negocio, aislamiento entre empresas y concurrencia.
10. Mantén documentación técnica actualizada cuando cambien contratos, decisiones o esquemas.

### Forma de trabajo

- Trabaja por fases pequeñas y verificables.
- No generes todo el sistema de una sola vez.
- Primero define contratos, modelo de datos y reglas; después implementa.
- Usa migraciones versionadas. Nunca modifiques la base de datos de producción manualmente.
- No inventes variables de entorno, endpoints ni capacidades de proveedores. Documenta los valores pendientes.
- Usa nombres consistentes en inglés para código, tablas, endpoints y variables; la interfaz para usuarios finales estará en español inicialmente.
- Si falta una decisión importante, señala el supuesto y propone la opción más segura. Pregunta solo cuando la decisión bloquee el trabajo.
- No expongas secretos, tokens, credenciales ni datos personales en logs.

### Prioridades no negociables

1. Aislamiento estricto de datos por tenant.
2. Integridad del calendario y prevención de doble reserva.
3. Seguridad de los flujos públicos y de autogestión por WhatsApp.
4. Consistencia entre base de datos, eventos y notificaciones.
5. Experiencia sencilla para el cliente y el administrador.
6. Arquitectura extensible sin sobreingeniería prematura.

---

## 2. Visión del producto

ReservePro es una plataforma SaaS multiempresa que permite a distintos negocios publicar servicios, administrar profesionales y recursos, configurar horarios, recibir reservas y automatizar la comunicación con sus clientes.

### Tipos de negocio objetivo

- Peluquerías y barberías.
- Centros de estética y bienestar.
- Consultas y profesionales independientes.
- Centros médicos y odontológicos, considerando requisitos regulatorios adicionales si se aborda ese mercado.
- Arriendo de salas, boxes y espacios.
- Servicios técnicos y mantenimiento.
- Asesorías, capacitaciones y clases.
- Negocios que necesiten reservar personas, espacios, equipos o recursos.

### Propuesta de valor

- Reservas online disponibles las 24 horas.
- Agenda centralizada por sucursal, profesional y recurso.
- Menos coordinación manual por teléfono o mensajería.
- Confirmaciones, recordatorios, cancelaciones y reprogramaciones automatizadas.
- Autogestión de reservas desde un enlace web o WhatsApp.
- Panel administrativo y reportes operativos.

### Superficies principales

1. **Portal público de reservas:** página de cada empresa para consultar servicios, disponibilidad y reservar sin crear una cuenta.
2. **Panel administrativo:** administración de agenda, servicios, recursos, clientes, configuración y reportes.
3. **Centro de comunicaciones:** email, WhatsApp, plantillas, preferencias e historial.
4. **Consola SaaS:** administración global de tenants, planes, límites y estado de las cuentas. Se implementará progresivamente.

---

## 3. Stack tecnológico propuesto

| Capa | Tecnología |
|---|---|
| Monorepo | pnpm workspaces + Turborepo |
| Frontend | Astro + Vue 3 + TypeScript |
| Renderizado | Astro híbrido; islas Vue para interacciones |
| Backend | NestJS + TypeScript |
| API | REST versionada + OpenAPI/Swagger |
| Base de datos | PostgreSQL |
| ORM | Prisma |
| Cache y colas | Redis + BullMQ |
| Validación compartida | Zod, con estrategia consistente entre frontend y backend |
| Calendario | FullCalendar o alternativa evaluada antes de integrar |
| Email | Proveedor desacoplado, por ejemplo Resend |
| WhatsApp | Meta WhatsApp Business Platform Cloud API |
| Pruebas | Vitest/Jest según configuración NestJS + Playwright |
| Infraestructura local | Docker Compose |
| Observabilidad | Logs estructurados, métricas, trazas y alertas |

### Criterios técnicos

- TypeScript estricto.
- CSS propio organizado por componentes y módulos. Tailwind puede evaluarse, pero no es obligatorio.
- Evitar que los componentes Astro/Vue contengan reglas de negocio.
- El backend calcula duración, precio, disponibilidad y permisos.
- Mantener adaptadores para proveedores externos, para evitar acoplar el dominio a una sola plataforma.
- No introducir microservicios en el MVP. Comenzar con un monolito modular y un worker separado.
- Usar UTC para persistencia de instantes y la zona horaria IANA del tenant para reglas y presentación.

---

## 4. Arquitectura general

```text
reservepro/
├── apps/
│   ├── web/                 # Astro + Vue: portal público y panel
│   ├── api/                 # NestJS: API REST y dominio
│   └── worker/              # Procesamiento asíncrono BullMQ
├── packages/
│   ├── shared-types/        # Tipos y contratos compartidos
│   ├── validation/          # Esquemas de validación compartidos
│   ├── api-client/          # Cliente tipado de API
│   ├── ui/                  # Componentes reutilizables
│   └── config/              # Configuración TS, lint y tooling
├── database/
│   ├── prisma/
│   ├── migrations/
│   └── seeds/
├── docs/
│   ├── product/
│   ├── architecture/
│   ├── database/
│   ├── api/
│   ├── security/
│   └── decisions/
├── docker/
├── docker-compose.yml
├── pnpm-workspace.yaml
├── turbo.json
├── package.json
├── CLAUDE.md
└── README.md
```

### Módulos NestJS previstos

- `auth`
- `users`
- `tenants`
- `memberships`
- `roles-permissions`
- `locations`
- `services`
- `resources`
- `schedules`
- `availability`
- `customers`
- `reservations`
- `calendar`
- `notifications`
- `integrations`
- `whatsapp`
- `reports`
- `audit`
- `billing` (fase posterior)

### Principio de arquitectura

Mantener separación clara entre:

- **Presentación:** componentes, páginas, formularios y estado visual.
- **Aplicación:** casos de uso y orquestación.
- **Dominio:** reglas de negocio, entidades, políticas y validaciones críticas.
- **Infraestructura:** Prisma, PostgreSQL, Redis, Meta API, email y proveedores externos.

No es obligatorio implementar una arquitectura hexagonal ceremonial en cada módulo; aplicar separación donde reduzca acoplamiento y facilite pruebas.

---

## 5. Modelo SaaS multi-tenant

ReservePro será multiempresa desde el inicio.

### Estrategia

Usar una base de datos compartida y esquema compartido, con `tenant_id` en todas las entidades pertenecientes a una empresa.

### Reglas obligatorias

- Un usuario puede pertenecer a una o varias empresas.
- La relación usuario-empresa se representa mediante `tenant_memberships`.
- Un usuario puede tener roles diferentes en cada empresa.
- El tenant activo se resuelve desde la sesión y la membresía validada en backend.
- Nunca confiar en un `tenant_id` enviado libremente por el frontend.
- Todas las consultas y mutaciones de datos de negocio deben estar acotadas al tenant.
- Las relaciones entre entidades deben impedir referencias cruzadas entre tenants.
- Considerar PostgreSQL Row Level Security (RLS) como defensa adicional.
- Los workers deben conservar y validar el contexto del tenant al procesar jobs.
- Las tareas administrativas globales deben estar separadas de las operaciones de tenant.
- Usar UUID como identificadores públicos internos.

### Roles iniciales

- `super_admin`: administración global de ReservePro.
- `owner`: propietario de una empresa.
- `admin`: administración de la empresa.
- `manager`: gestión operativa.
- `professional`: acceso a su agenda y reservas asignadas.
- `receptionist`: gestión de agenda y clientes según permisos.

Implementar RBAC por permisos, no solo condicionales dispersos por rol.

---

## 6. Módulos funcionales

### 6.1 Empresas y configuración

Cada tenant podrá configurar:

- Nombre comercial y razón social, si aplica.
- Identificador tributario, si aplica.
- Logo, colores y datos de contacto.
- Slug y página pública.
- Dominio propio en una fase posterior.
- Zona horaria IANA.
- Moneda.
- Sucursales.
- Horarios generales.
- Políticas de cancelación y reprogramación.
- Anticipación mínima y máxima para reservar.
- Estado de la cuenta y plan SaaS.

### 6.2 Usuarios, membresías y permisos

- Registro e inicio de sesión.
- Recuperación de contraseña.
- Gestión de sesiones y refresh tokens.
- Invitación de colaboradores.
- Membresía por empresa.
- Roles y permisos.
- Desactivación de usuarios y revocación de sesiones.
- Auditoría de acciones administrativas.

### 6.3 Sucursales

- Nombre y dirección.
- Datos de contacto.
- Zona horaria opcional si se requiere operar en una zona diferente a la empresa.
- Horarios de atención.
- Recursos y servicios disponibles.
- Estado activo/inactivo.

### 6.4 Servicios

Cada servicio tendrá, como mínimo:

- Nombre y descripción.
- Categoría.
- Duración.
- Precio y moneda.
- Tiempo de preparación y limpieza, si aplica.
- Estado activo/inactivo.
- Sucursales donde se ofrece.
- Profesionales o recursos compatibles.
- Anticipación mínima y máxima.
- Reglas de reserva y cancelación.
- Imagen opcional.

El backend debe calcular el precio y duración aplicables. Nunca aceptar esos valores como autoridad desde el navegador.

### 6.5 Profesionales y recursos

Modelo flexible para administrar:

- Personas/profesionales.
- Salas y boxes.
- Equipos.
- Vehículos.
- Espacios y otros recursos reservables.

Atributos:

- Nombre y tipo.
- Sucursal.
- Servicios compatibles.
- Capacidad.
- Horarios y disponibilidad.
- Bloqueos y ausencias.
- Estado activo/inactivo.

La asignación debe soportar servicios que requieran uno o varios recursos.

### 6.6 Horarios, agenda y bloqueos

- Horarios semanales recurrentes.
- Excepciones por fecha.
- Descansos.
- Feriados.
- Ausencias de profesionales.
- Bloqueos manuales.
- Bloqueos por mantenimiento.
- Vistas día, semana y mes.
- Filtros por sucursal, profesional, recurso y estado.
- Reprogramación desde el calendario.
- Historial de cambios.

### 6.7 Clientes

- Nombre y apellidos.
- Teléfono normalizado en formato internacional.
- Email.
- Datos adicionales opcionales.
- Historial de reservas.
- Notas internas.
- Preferencias de comunicación.
- Consentimientos por canal y finalidad.
- Solicitud de actualización o eliminación conforme a las políticas de retención aplicables.

No almacenar información sensible innecesaria. Si se incorporan datos clínicos u otras categorías sensibles, se requiere una evaluación legal y técnica específica.

---

## 7. Motor de disponibilidad y reservas

Este es uno de los componentes más críticos del producto.

### Flujo de reserva pública

1. El cliente entra a la página pública de una empresa.
2. Selecciona servicio.
3. Selecciona sucursal, si corresponde.
4. Selecciona profesional o deja que el sistema asigne uno compatible.
5. Selecciona fecha y hora disponibles.
6. Ingresa sus datos.
7. El backend vuelve a validar disponibilidad.
8. El backend calcula duración, precio, recursos y hora final.
9. Se crea la reserva dentro de una transacción.
10. Se registra el evento de dominio/outbox.
11. Se envían las notificaciones asíncronas.

### Reglas de disponibilidad

La disponibilidad debe considerar:

- Horario de la empresa y sucursal.
- Horario del profesional/recurso.
- Duración del servicio.
- Preparación y limpieza.
- Descansos y bloqueos.
- Feriados y excepciones.
- Reservas existentes.
- Compatibilidad entre servicio y recurso.
- Capacidad de los recursos.
- Anticipación mínima y máxima.
- Zona horaria del tenant.

### Concurrencia

No basta con consultar disponibilidad y luego insertar una reserva. Dos clientes podrían seleccionar el mismo horario simultáneamente.

Implementar protección transaccional en PostgreSQL:

- Transacciones para reservar y asignar recursos.
- Restricciones de exclusión con rangos `tstzrange` y GiST cuando aplique a recursos de capacidad 1.
- Estrategia específica para recursos con capacidad superior a 1.
- Reintentos controlados ante conflictos.
- Claves de idempotencia en creación de reservas.
- La disponibilidad se vuelve a comprobar dentro de la operación de escritura.

### Estados de reserva

- `pending`
- `confirmed`
- `in_progress`
- `completed`
- `cancelled`
- `no_show`

Definir una máquina de estados y transiciones permitidas. No permitir cambios arbitrarios de estado.

### Datos históricos

- No borrar reservas para corregir errores operativos.
- Registrar eventos y cambios.
- Guardar snapshots de nombre del servicio, duración y precio en los ítems de reserva, para preservar el historial aunque el catálogo cambie.
- Separar el importe reservado del importe efectivamente pagado.

---

## 8. Autogestión de reservas desde WhatsApp

Esta funcionalidad forma parte del alcance principal del MVP.

### Objetivo

El cliente podrá confirmar, cancelar o reprogramar una reserva directamente desde WhatsApp, sujeto a las políticas configuradas por la empresa.

### Experiencia del cliente

Ejemplo de recordatorio:

> Hola, {{nombre}}. Te recordamos tu reserva de {{servicio}} para el {{fecha}} a las {{hora}}.  
> ¿Qué deseas hacer?

Acciones disponibles, según configuración:

- Confirmar reserva.
- Cambiar horario.
- Cancelar reserva.
- Consultar detalles.

### Flujo de reprogramación

1. El cliente selecciona “Cambiar horario”.
2. Meta envía la interacción al webhook de ReservePro.
3. El backend valida el número remitente, la reserva y el contexto de gestión.
4. El backend consulta nuevamente disponibilidad.
5. Se presentan opciones disponibles mediante mensajes interactivos compatibles.
6. El cliente selecciona una opción.
7. El backend valida que la opción siga disponible.
8. La reserva se actualiza transaccionalmente.
9. Se registra `reservation.rescheduled`.
10. Se envía confirmación al cliente y se notifica al negocio.
11. Se actualiza la agenda y el historial.

### Flujo de cancelación

1. El cliente selecciona “Cancelar reserva”.
2. El backend valida identidad y política de cancelación.
3. Si la política permite cancelación automática, se cancela transaccionalmente.
4. Si requiere aprobación, se crea una solicitud pendiente para el administrador.
5. Se registra el evento y se notifica el resultado.
6. Se libera la disponibilidad únicamente cuando la cancelación queda efectiva.

### Reglas de autogestión

- Verificar el número de WhatsApp asociado al cliente.
- Usar identificadores opacos y tokens seguros, de alcance limitado y con vencimiento cuando se utilicen enlaces de gestión.
- No usar IDs secuenciales como credenciales.
- No permitir acceder a reservas de terceros.
- Respetar ventanas límite de cancelación y reprogramación.
- Configurar cantidad máxima de reprogramaciones.
- Volver a validar disponibilidad antes de confirmar.
- Evitar doble procesamiento de interacciones y webhooks.
- Registrar canal, actor, fecha, acción y resultado.
- Permitir que la empresa desactive cada acción por separado.

### Restricción de WhatsApp

La integración debe utilizar la plataforma oficial WhatsApp Business Cloud API de Meta. Fuera de la ventana de atención de 24 horas iniciada por un mensaje del cliente, se deben usar plantillas aprobadas cuando corresponda. Las plantillas transaccionales deben mantener contenido estrictamente operativo para poder clasificarse como Utility; contenido promocional puede cambiar la categoría.

La disponibilidad de botones, listas y tipos de mensajes depende de las capacidades vigentes de Meta y de las plantillas aprobadas. No diseñar el sistema suponiendo que cualquier interacción se puede enviar como mensaje libre.

---

## 9. Integración WhatsApp Business Platform

### Enfoque multiempresa

Cada tenant conecta su propia cuenta/número de WhatsApp Business. No utilizar un único número compartido para todos los negocios.

Evaluar Meta Embedded Signup para facilitar la conexión de cuentas de cada empresa. ReservePro deberá cumplir los requisitos aplicables como Tech Provider/partner y los permisos/revisiones que Meta exija. No asumir que la conexión estará disponible sin configuración y aprobación de Meta.

### Configuración administrativa

Ruta propuesta: `Panel > Integraciones > WhatsApp`

- Conectar cuenta.
- Mostrar número conectado.
- Estado de conexión.
- Sincronizar plantillas.
- Ver estado de aprobación de plantillas.
- Activar/desactivar tipos de notificación.
- Enviar mensaje de prueba.
- Ver historial de mensajes.
- Ver errores y reintentos.
- Desconectar cuenta.

### Plantillas iniciales

- `booking_received`
- `booking_confirmed`
- `booking_cancelled`
- `booking_rescheduled`
- `booking_reminder_24h`
- `booking_reminder_2h`
- `booking_completed`
- `booking_management_options`

Usar categoría Utility cuando el contenido sea estrictamente transaccional y Meta lo apruebe. Las plantillas deben sincronizarse desde Meta; no asumir que una plantilla local está aprobada.

### Consentimiento

No asumir que disponer del teléfono implica consentimiento para recibir mensajes por WhatsApp.

Registrar consentimiento granular y revocable, con:

- Cliente.
- Tenant.
- Canal.
- Finalidad/tipo de comunicación.
- Estado.
- Fecha y hora.
- Fuente/origen.
- Evidencia o versión del texto aceptado.
- Fecha de revocación.

Separar comunicaciones operativas de marketing. Respetar bajas y preferencias del cliente.

### Seguridad de credenciales

- Cifrar tokens en reposo.
- Nunca devolver tokens al frontend.
- Nunca escribir tokens en logs.
- Rotar credenciales cuando corresponda.
- Limitar permisos y acceso interno.
- Verificar autenticidad de webhooks según mecanismos oficiales de Meta.
- Validar y deduplicar notificaciones entrantes.

### Eventos de WhatsApp

Procesar estados:

- `sent`
- `delivered`
- `read`
- `failed`

Guardar `provider_message_id`, código de error y timestamps disponibles.

Documentación oficial de referencia:
- https://developers.facebook.com/documentation/business-messaging/whatsapp/overview
- https://developers.facebook.com/docs/whatsapp/api/messages/message-templates/interactive-message-templates

Verificar siempre la documentación y precios vigentes de Meta antes de implementar o estimar costos.

---

## 10. Centro de comunicaciones y notificaciones

Unificar email y WhatsApp bajo un servicio de notificaciones desacoplado.

### Eventos que pueden generar notificaciones

- Reserva recibida.
- Reserva confirmada.
- Reserva cancelada.
- Reserva reprogramada.
- Recordatorio 24 horas antes.
- Recordatorio 2 horas antes.
- Reserva completada.
- Solicitud de cancelación pendiente.
- Cambio administrativo de una reserva.

### Arquitectura fiable

Usar patrón transactional outbox:

1. La transacción de negocio modifica la reserva y escribe un evento en `outbox_events`.
2. Un proceso publica eventos pendientes en BullMQ.
3. El worker ejecuta el envío por el canal correspondiente.
4. Se registra el resultado.
5. Los webhooks del proveedor actualizan estados de entrega.
6. Los errores reintentables se procesan con backoff.
7. Los errores permanentes quedan registrados para revisión.

Evitar depender de una llamada a Redis después del commit sin mecanismo de recuperación: se podría guardar la reserva y perder la notificación si el proceso falla entre ambas operaciones.

### Idempotencia

Cada notificación debe tener una clave única basada en evento, canal, destinatario y versión/tipo de mensaje, para evitar envíos duplicados por reintentos.

---

## 11. Modelo de datos inicial

El modelo definitivo debe revisarse antes de generar migraciones. Todas las tablas tenant-scoped deben tener `tenant_id` y restricciones/relaciones que impidan cruces entre empresas.

### Tablas principales

**SaaS y acceso**
- `tenants`
- `tenant_settings`
- `tenant_domains`
- `users`
- `tenant_memberships`
- `roles`
- `permissions`
- `role_permissions`
- `membership_roles` o mecanismo equivalente según diseño RBAC

**Operación**
- `locations`
- `service_categories`
- `services`
- `resources`
- `service_resources`
- `resource_schedules`
- `business_hours`
- `availability_blocks`
- `customers`
- `reservations`
- `reservation_items`
- `reservation_resources`
- `reservation_events`

**Comunicaciones**
- `notification_preferences`
- `notification_consents`
- `notification_templates`
- `notification_events`
- `notifications`
- `whatsapp_accounts`
- `whatsapp_templates`
- `whatsapp_messages`
- `outbox_events`

**Control**
- `audit_logs`
- `idempotency_keys`

**Futuro**
- `payments`
- `payment_transactions`
- `saas_subscriptions`
- `saas_invoices`

### Reglas del esquema

- UUID como PK.
- `created_at` y `updated_at` donde corresponda.
- `tenant_id` en cada entidad tenant-scoped.
- FK compuestas cuando sea necesario para garantizar que las referencias pertenecen al mismo tenant.
- Índices compuestos que comiencen por `tenant_id` para consultas tenant-scoped.
- Índices parciales para estados activos cuando aporten valor.
- Restricciones `CHECK` para invariantes simples.
- Evitar borrado en cascada de reservas y eventos históricos.
- Dinero con `NUMERIC`, nunca `FLOAT`.
- Teléfonos normalizados en formato internacional.
- Timestamps de eventos como `TIMESTAMPTZ`.

### Ejemplo de tabla tenants

```sql
CREATE TABLE tenants (
    id UUID PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    timezone VARCHAR(60) NOT NULL DEFAULT 'America/Santiago',
    currency CHAR(3) NOT NULL DEFAULT 'CLP',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Índices iniciales orientativos

```sql
CREATE INDEX idx_reservations_tenant_start
    ON reservations (tenant_id, start_at);

CREATE INDEX idx_reservations_tenant_status
    ON reservations (tenant_id, status);

CREATE INDEX idx_customers_tenant_email
    ON customers (tenant_id, email);

CREATE INDEX idx_services_tenant_active
    ON services (tenant_id, is_active);
```

Estos índices son un punto de partida. Confirmar consultas reales con `EXPLAIN (ANALYZE, BUFFERS)` antes de optimizar.

---

## 12. API REST propuesta

Prefijo: `/api/v1`

### Autenticación

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `POST /auth/forgot-password`
- `POST /auth/reset-password`

### Empresas y usuarios

- `POST /tenants`
- `GET /tenants/current`
- `PATCH /tenants/current`
- `GET /tenants/current/members`
- `POST /tenants/current/invitations`
- `PATCH /tenants/current/members/:id`

### Catálogo y recursos

- CRUD `/services`
- CRUD `/service-categories`
- CRUD `/resources`
- CRUD `/locations`
- CRUD `/schedules`
- CRUD `/availability-blocks`

### Clientes y reservas

- CRUD `/customers`
- `GET /availability`
- CRUD `/reservations`
- `POST /reservations/:id/confirm`
- `POST /reservations/:id/cancel`
- `POST /reservations/:id/reschedule`
- `GET /reservations/:id/events`

### Portal público

- `GET /public/:slug`
- `GET /public/:slug/services`
- `GET /public/:slug/locations`
- `GET /public/:slug/availability`
- `POST /public/:slug/reservations`
- `GET /public/reservations/:token`
- `POST /public/reservations/:token/cancel`
- `POST /public/reservations/:token/reschedule`

Los endpoints públicos deben usar rate limiting, validación estricta y tokens seguros cuando expongan gestión de reservas.

### Integraciones y notificaciones

- `POST /integrations/whatsapp/connect`
- `GET /integrations/whatsapp/status`
- `POST /integrations/whatsapp/disconnect`
- `GET /integrations/whatsapp/templates`
- `POST /integrations/whatsapp/test`
- `GET /notifications`
- `GET /notifications/:id`
- `GET /webhooks/whatsapp` (verificación según protocolo Meta)
- `POST /webhooks/whatsapp` (eventos entrantes y estados)

### Reportes

- `GET /reports/reservations`
- `GET /reports/services`
- `GET /reports/resources`
- `GET /reports/customers`

### Contratos API

- Validar payloads.
- Paginación y filtros explícitos.
- Ordenamiento por campos permitidos.
- Errores consistentes.
- Documentación OpenAPI.
- Autorización por tenant y permiso.
- Idempotencia en operaciones sensibles.
- No devolver campos internos ni secretos.

---

## 13. Seguridad, privacidad y cumplimiento

Controles mínimos:

- HTTPS obligatorio.
- Hash de contraseñas con Argon2id.
- Access tokens de vida corta.
- Refresh token rotation y revocación.
- Cookies `HttpOnly`, `Secure` y `SameSite` cuando se use autenticación por cookie.
- Protección CSRF según el mecanismo de autenticación.
- RBAC aplicado en backend.
- Aislamiento tenant en cada query y mutation.
- RLS como defensa adicional si se implementa correctamente.
- Rate limiting y protección antiabuso en endpoints públicos.
- Validación de webhooks.
- Cifrado de secretos y tokens de proveedores.
- Auditoría de acciones críticas.
- Backups automáticos y pruebas periódicas de restauración.
- Logs sin contraseñas, tokens ni datos sensibles.
- Política de retención y eliminación de datos.
- Procedimientos para incidentes y revocación de credenciales.

Para operación en Chile, evaluar las obligaciones aplicables de protección de datos personales, incluida la Ley 21.719 y su calendario de entrada en vigencia. No tratar este blueprint como asesoría legal: validar el diseño y los textos de consentimiento con asesoría especializada antes del lanzamiento.

---

## 14. Reportes y métricas

Reportes iniciales:

- Total de reservas por período.
- Reservas por estado.
- Cancelaciones y no-show.
- Servicios más solicitados.
- Ocupación por profesional/recurso.
- Demanda por día y franja horaria.
- Clientes nuevos y recurrentes.
- Rendimiento por sucursal.

Distinguir claramente:

- Valor total de reservas.
- Valor de reservas completadas.
- Dinero efectivamente cobrado.
- Cancelaciones y devoluciones.

No presentar importes reservados como ingresos cobrados.

---

## 15. Pagos y modelo comercial SaaS

Los pagos no son requisito del primer MVP, pero la arquitectura debe permitir incorporarlos sin rehacer reservas.

Distinguir dos conceptos:

1. **Suscripción SaaS:** lo que cada empresa paga a ReservePro por utilizar la plataforma.
2. **Pago de reserva:** lo que el cliente paga al negocio por el servicio reservado.

Fase posterior:
- Integración con Webpay, Mercado Pago u otro proveedor disponible.
- Estados de pago.
- Reembolsos.
- Conciliación.
- Webhooks de pago.
- Planes SaaS, límites y facturación.

Planes comerciales posibles, aún sin precios definidos:
- Starter
- Professional
- Enterprise

Los límites podrían considerar sucursales, profesionales/recursos, volumen de reservas, reportes, integraciones y dominio propio.

---

## 16. Interfaz y experiencia de usuario

### Portal público

Ruta conceptual: `reservepro.cl/{slug}`

Debe permitir:

- Ver información del negocio.
- Explorar servicios y precios.
- Elegir sucursal.
- Elegir profesional o asignación automática.
- Consultar horarios disponibles.
- Ingresar datos de contacto.
- Confirmar reserva.
- Recibir confirmación.
- Gestionar la reserva mediante enlace seguro o WhatsApp.

Diseño responsive y accesible. Reducir pasos innecesarios.

### Panel administrativo

Secciones iniciales:

- Dashboard.
- Calendario.
- Reservas.
- Clientes.
- Servicios.
- Profesionales y recursos.
- Sucursales.
- Horarios y bloqueos.
- Comunicaciones.
- Integraciones.
- Reportes.
- Configuración.

### Centro de comunicaciones

Debe mostrar:

- Canal.
- Destinatario.
- Reserva relacionada.
- Tipo de evento.
- Estado del envío.
- Fecha y hora.
- Error y reintentos.
- Historial de WhatsApp y email.

---

## 17. Pruebas y criterios de aceptación

### Pruebas críticas

**Multi-tenancy**
- Un usuario de Tenant A no puede consultar, modificar ni inferir datos de Tenant B.
- Las relaciones entre entidades no pueden cruzar tenants.
- Los jobs de un tenant no pueden operar sobre otro.

**Reservas**
- No se puede reservar un servicio inactivo.
- No se puede reservar fuera de horario.
- No se puede reservar durante un bloqueo.
- No se puede duplicar una reserva incompatible.
- Dos solicitudes concurrentes para el mismo recurso/horario no pueden confirmar ambas.
- El precio y duración son calculados por backend.
- La idempotencia evita duplicados.

**Autogestión**
- Un cliente no puede cancelar una reserva ajena.
- Una reserva fuera de la ventana de cancelación respeta la política configurada.
- La reprogramación vuelve a comprobar disponibilidad.
- La selección de un horario que dejó de estar disponible se rechaza de forma segura.
- Webhooks duplicados no repiten operaciones.
- Toda acción queda auditada.

**Notificaciones**
- El evento no se pierde si falla la publicación a la cola.
- Los reintentos no duplican mensajes.
- Los estados del proveedor se reflejan correctamente.
- Un consentimiento revocado impide nuevos mensajes de la finalidad correspondiente.

### Herramientas

- Unit tests para reglas de dominio.
- Integration tests con PostgreSQL real o entorno de prueba equivalente.
- Tests de concurrencia para reservas.
- E2E con Playwright para portal y panel.
- Tests de contratos API.
- Tests de webhook con payloads válidos, inválidos y duplicados.

---

## 18. Roadmap de implementación

### Fase 0 — Definición técnica

- Confirmar alcance del MVP.
- Cerrar modelo de datos.
- Definir RBAC y tenant context.
- Definir contratos API.
- Crear ADR para decisiones relevantes.

### Fase 1 — Fundamentos

- Monorepo.
- Docker Compose.
- PostgreSQL y Prisma.
- NestJS.
- Astro/Vue.
- Auth.
- Tenants y memberships.
- RBAC.
- Auditoría inicial.
- CI y pruebas base.

### Fase 2 — Catálogo y agenda

- Sucursales.
- Servicios.
- Profesionales y recursos.
- Horarios.
- Excepciones y bloqueos.
- Calendario administrativo.

### Fase 3 — Motor de reservas

- Disponibilidad.
- Asignación de recursos.
- Creación transaccional.
- Idempotencia.
- Estados y eventos.
- Pruebas de concurrencia.

### Fase 4 — Portal público

- Página por tenant.
- Selección de servicio.
- Disponibilidad.
- Formulario de cliente.
- Confirmación.
- Gestión mediante token seguro.

### Fase 5 — Comunicaciones

- Transactional outbox.
- BullMQ worker.
- Email.
- WhatsApp Cloud API.
- Consentimientos.
- Plantillas.
- Confirmaciones, cancelaciones y cambios.
- Recordatorios.
- Estados y reintentos.

### Fase 6 — Autogestión por WhatsApp

- Webhook de interacciones.
- Confirmar reserva.
- Cancelar reserva.
- Consultar disponibilidad.
- Reprogramar reserva.
- Validación de políticas.
- Auditoría y pruebas de seguridad.

### Fase 7 — Reportes y endurecimiento

- Reportes operativos.
- Pruebas E2E.
- Seguridad.
- Observabilidad.
- Backups y restauración.
- Optimización de consultas.

### Fase 8 — Comercialización SaaS

- Planes.
- Límites por plan.
- Suscripciones.
- Facturación SaaS.
- Consola global.
- Pagos online de reservas, si se priorizan.

---

## 19. Alcance recomendado del MVP

### Incluido

- SaaS multi-tenant.
- Autenticación y roles.
- Empresas y sucursales.
- Servicios.
- Profesionales y recursos.
- Horarios, bloqueos y disponibilidad.
- Portal público de reservas.
- Panel administrativo y calendario.
- Clientes e historial.
- Confirmación, cancelación y reprogramación desde el panel.
- Email transaccional.
- WhatsApp Cloud API por empresa, sujeto a aprobación/configuración de Meta.
- Confirmaciones y recordatorios.
- Cancelación y reprogramación por WhatsApp, sujetas a políticas.
- Centro de comunicaciones.
- Auditoría.
- Reportes básicos.
- Pruebas de aislamiento y concurrencia.

### Fuera del primer MVP

- Marketplace público de negocios.
- Aplicación móvil nativa.
- Campañas masivas de marketing por WhatsApp.
- Bandeja de atención humana omnicanal completa.
- Pagos y reembolsos complejos.
- Suscripciones SaaS automatizadas, salvo que sean requisito comercial de lanzamiento.
- Integraciones complejas con calendarios externos.
- Analítica avanzada e IA.

---

## 20. Decisiones pendientes que deben cerrarse antes de producción

1. Si una reserva puede incluir varios servicios en una sola visita.
2. Si el cliente puede elegir profesional o permitir asignación automática.
3. Cómo se modelarán recursos con capacidad mayor a uno.
4. Si se permiten reservas sin confirmación del negocio o siempre quedan pendientes.
5. Reglas exactas de cancelación y reprogramación.
6. Si una reprogramación conserva el mismo profesional/recurso o permite reasignación.
7. Si se exigirá verificación OTP para gestionar reservas desde la web.
8. Método de onboarding de WhatsApp: Embedded Signup y requisitos de Meta.
9. Proveedor de email y estrategia de dominios/remitentes.
10. Hosting y servicios administrados de PostgreSQL y Redis.
11. Política de retención, privacidad y consentimiento.
12. Modelo de planes, límites y cobro SaaS.

No bloquear el desarrollo de fundamentos por decisiones que puedan posponerse. Documentar supuestos y aislar las partes configurables.

---

## 21. Primer encargo recomendado para Claude Code

No comenzar construyendo todas las funcionalidades.

Primero:

1. Inspecciona el repositorio y detecta si ya existe código.
2. Propón la estructura del monorepo y explica las decisiones.
3. Diseña el modelo relacional inicial, con foco en tenant isolation y reservas.
4. Define el contexto de tenant y RBAC.
5. Define el contrato inicial de API.
6. Identifica los riesgos de concurrencia del motor de reservas.
7. Propón las migraciones iniciales y estrategia de pruebas.
8. Presenta un plan de implementación por entregables pequeños.

Después de aprobar el diseño, implementar únicamente la **Fase 1 — Fundamentos**, con código funcional, migraciones, Docker, pruebas y documentación.

---

## 22. Principio rector

ReservePro debe ser una plataforma de reservas confiable, no solo un calendario con formularios. La integridad de disponibilidad, el aislamiento multiempresa, la trazabilidad de cada cambio y la autogestión segura del cliente son el núcleo del producto.

Toda decisión técnica debe proteger esos principios y mantener el producto suficientemente simple para lanzar un MVP comercial.
