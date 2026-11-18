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
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  unauthenticated: (message = 'Debes iniciar sesión') => new AppError(401, 'UNAUTHENTICATED', message),
  invalidCredentials: () => new AppError(401, 'INVALID_CREDENTIALS', 'Email o contraseña incorrectos'),
  tokenInvalid: (message = 'Sesión inválida o expirada') => new AppError(401, 'TOKEN_INVALID', message),
  forbidden: (message = 'No tienes permiso para realizar esta acción') => new AppError(403, 'FORBIDDEN', message),
  tenantRequired: () => new AppError(403, 'TENANT_REQUIRED', 'Debes seleccionar una empresa'),
  csrf: () => new AppError(403, 'CSRF_REJECTED', 'Solicitud rechazada'),
  notFound: (what = 'Recurso') => new AppError(404, 'NOT_FOUND', `${what} no encontrado`),
  emailTaken: () => new AppError(409, 'EMAIL_TAKEN', 'Ya existe una cuenta con ese email'),
  slugTaken: () => new AppError(409, 'SLUG_TAKEN', 'Ese identificador ya está en uso'),
  tooManyAttempts: () =>
    new AppError(429, 'TOO_MANY_ATTEMPTS', 'Demasiados intentos. Intenta de nuevo más tarde'),
  validation: (errors: FieldError[]) =>
    new AppError(400, 'VALIDATION_ERROR', 'Los datos enviados no son válidos', errors),
  internal: (message = 'Error interno') => new AppError(500, 'INTERNAL_ERROR', message),
};
