import type { ErrorCode } from '@reservepro/contracts';

export interface FieldError {
  path: string;
  message: string;
}

/**
 * Error de aplicación con código estable. El filtro global lo serializa como `application/problem+json`.
 * Los mensajes son para el cliente: nunca incluir secretos ni detalles internos.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly errors?: FieldError[],
    /** Si se indica, el filtro responde con la cabecera `Retry-After`. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  unauthenticated: (message = 'Debes iniciar sesión') =>
    new AppError(401, 'UNAUTHENTICATED', message),
  invalidCredentials: () =>
    new AppError(401, 'INVALID_CREDENTIALS', 'Email o contraseña incorrectos'),
  tokenInvalid: (message = 'Sesión inválida o expirada') =>
    new AppError(401, 'TOKEN_INVALID', message),
  forbidden: (message = 'No tienes permiso para realizar esta acción') =>
    new AppError(403, 'FORBIDDEN', message),
  tenantRequired: () => new AppError(403, 'TENANT_REQUIRED', 'Debes seleccionar una empresa'),
  csrf: () => new AppError(403, 'CSRF_REJECTED', 'Solicitud rechazada'),
  notFound: (what = 'Recurso') => new AppError(404, 'NOT_FOUND', `${what} no encontrado`),
  emailTaken: () => new AppError(409, 'EMAIL_TAKEN', 'Ya existe una cuenta con ese email'),
  slugTaken: () => new AppError(409, 'SLUG_TAKEN', 'Ese identificador ya está en uso'),
  duplicate: (field: string, message: string) =>
    new AppError(409, 'DUPLICATE', message, [{ path: field, message }]),
  inUse: (message: string) => new AppError(409, 'IN_USE', message),
  alreadyMember: () =>
    new AppError(409, 'ALREADY_MEMBER', 'Esa persona ya es miembro de la empresa'),
  alreadyInvited: () =>
    new AppError(409, 'ALREADY_INVITED', 'Ya existe una invitación pendiente para ese email'),
  invitationInvalid: () =>
    new AppError(400, 'INVITATION_INVALID', 'La invitación no es válida, ya fue usada o expiró'),
  lastOwner: () =>
    new AppError(409, 'LAST_OWNER', 'La empresa debe conservar al menos un propietario activo'),
  cannotModifySelf: () =>
    new AppError(
      409,
      'CANNOT_MODIFY_SELF',
      'No puedes cambiar tu propio estado ni tus propios roles',
    ),
  roleNotAllowed: () =>
    new AppError(
      403,
      'ROLE_NOT_ALLOWED',
      'No puedes otorgar ni gestionar permisos superiores a los tuyos',
    ),
  limitReached: (what: string) =>
    new AppError(409, 'LIMIT_REACHED', `Se alcanzó el límite de ${what}`),
  linkInvalid: () => new AppError(400, 'LINK_INVALID', 'El enlace no es válido o ya expiró'),
  currentPasswordWrong: () =>
    new AppError(400, 'INVALID_CREDENTIALS', 'La contraseña actual es incorrecta'),
  rateLimited: (retryAfterSeconds: number) =>
    new AppError(
      429,
      'RATE_LIMITED',
      'Demasiadas solicitudes. Intenta de nuevo en un momento',
      undefined,
      retryAfterSeconds,
    ),
  emailNotVerified: () =>
    new AppError(403, 'EMAIL_NOT_VERIFIED', 'Debes verificar tu email para realizar esta acción'),
  tooManyAttempts: () =>
    new AppError(429, 'TOO_MANY_ATTEMPTS', 'Demasiados intentos. Intenta de nuevo más tarde'),
  validation: (errors: FieldError[]) =>
    new AppError(400, 'VALIDATION_ERROR', 'Los datos enviados no son válidos', errors),
  internal: (message = 'Error interno') => new AppError(500, 'INTERNAL_ERROR', message),
};
