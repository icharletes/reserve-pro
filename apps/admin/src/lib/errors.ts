import { ApiError } from '@reservepro/api-client';

const MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: 'Email o contraseña incorrectos.',
  TOO_MANY_ATTEMPTS: 'Cuenta bloqueada temporalmente por demasiados intentos. Intenta de nuevo más tarde o restablece tu contraseña.',
  NETWORK_ERROR: 'No hay conexión con el servidor. Revisa tu internet e inténtalo de nuevo.',
  EMAIL_NOT_VERIFIED: 'Verifica tu email para realizar esta acción.',
  LINK_INVALID: 'El enlace no es válido o ya expiró. Solicita uno nuevo.',
  INVITATION_INVALID: 'La invitación no es válida, ya fue usada o expiró. Pide que te inviten de nuevo.',
  EMAIL_TAKEN: 'Ya existe una cuenta con ese email.',
  SLUG_TAKEN: 'Ese identificador de empresa ya está en uso.',
  ALREADY_MEMBER: 'Esa persona ya es miembro de la empresa.',
  ALREADY_INVITED: 'Ya hay una invitación pendiente para ese email.',
  LIMIT_REACHED: 'Se alcanzó el límite de invitaciones pendientes. Revoca alguna e inténtalo de nuevo.',
  ROLE_NOT_ALLOWED: 'No puedes otorgar ni gestionar permisos superiores a los tuyos.',
  LAST_OWNER: 'La empresa debe conservar al menos un propietario activo.',
  CANNOT_MODIFY_SELF: 'No puedes cambiar tu propio estado ni tus propios roles.',
  FORBIDDEN: 'No tienes permiso para realizar esta acción.',
};

/**
 * Texto para mostrar al usuario. Los errores 5xx NUNCA muestran el detalle del servidor: solo un mensaje
 * genérico y el código de seguimiento (requestId) para que soporte pueda localizar el caso.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Ocurrió un error inesperado. Inténtalo de nuevo.';
  if (err.code === 'RATE_LIMITED') {
    return err.retryAfter ? `Demasiadas solicitudes. Intenta de nuevo en ${formatWait(err.retryAfter)}.` : 'Demasiadas solicitudes. Intenta de nuevo en un momento.';
  }
  const known = MESSAGES[err.code];
  if (known) return known;
  if (err.status >= 500 || err.status === 0) {
    return `Ocurrió un error en el servidor.${err.requestId ? ` Código de seguimiento: ${err.requestId}.` : ''}`;
  }
  return err.message || 'No se pudo completar la acción.';
}

function formatWait(seconds: number): string {
  if (seconds < 90) return `${seconds} segundos`;
  if (seconds < 5400) return `${Math.ceil(seconds / 60)} minutos`;
  return `${Math.ceil(seconds / 3600)} horas`;
}
