/**
 * Catálogo de permisos (ARCHITECTURE.md §3). Fuente única: el backend lo sincroniza a la tabla
 * `permissions` en cada arranque y el panel lo usa para mostrar/ocultar acciones.
 * La autorización real SIEMPRE se aplica en el backend.
 */
export const PERMISSIONS = {
  'tenant:read': 'Ver datos de la empresa',
  'tenant:update': 'Editar datos y configuración de la empresa',
  'members:read': 'Ver miembros del equipo',
  'members:invite': 'Invitar miembros',
  'members:update': 'Editar o desactivar miembros',
  'roles:manage': 'Gestionar roles y permisos',
  'locations:read': 'Ver sucursales',
  'locations:write': 'Crear y editar sucursales',
  'services:read': 'Ver servicios',
  'services:write': 'Crear y editar servicios',
  'resources:read': 'Ver profesionales y recursos',
  'resources:write': 'Crear y editar profesionales y recursos',
  'schedules:read': 'Ver horarios',
  'schedules:write': 'Editar horarios',
  'blocks:read': 'Ver bloqueos',
  'blocks:write': 'Crear y editar bloqueos',
  'customers:read': 'Ver clientes',
  'customers:write': 'Crear y editar clientes',
  'customers:export': 'Exportar datos de clientes',
  'customers:erase': 'Anonimizar o eliminar clientes',
  'reservations:read': 'Ver todas las reservas',
  'reservations:read:own': 'Ver solo las reservas propias',
  'reservations:create': 'Crear reservas',
  'reservations:update': 'Editar reservas',
  'reservations:confirm': 'Confirmar reservas',
  'reservations:cancel': 'Cancelar reservas',
  'reservations:reschedule': 'Reprogramar reservas',
  'reservations:status': 'Cambiar el estado de una reserva',
  'calendar:read': 'Ver el calendario completo',
  'calendar:read:own': 'Ver solo el calendario propio',
  'notifications:read': 'Ver el centro de comunicaciones',
  'integrations:read': 'Ver integraciones',
  'integrations:manage': 'Gestionar integraciones (WhatsApp, email)',
  'consents:read': 'Ver consentimientos',
  'consents:write': 'Registrar consentimientos',
  'reports:read': 'Ver reportes',
  'audit:read': 'Ver la auditoría',
  'billing:manage': 'Gestionar plan y facturación',
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

export function isPermissionKey(value: string): value is PermissionKey {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, value);
}
