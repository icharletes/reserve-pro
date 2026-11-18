import type { Problem } from '@reservepro/contracts';

/** Error devuelto por la API (`application/problem+json`) o fallo de red/transporte. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** Código estable (`ERROR_CODES` de contracts) o `NETWORK_ERROR` / `INVALID_RESPONSE` / `UNKNOWN`. */
    readonly code: string,
    message: string,
    readonly errors: { path: string; message: string }[] = [],
    readonly requestId?: string,
    /** Segundos hasta poder reintentar (cabecera Retry-After de un 429). */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /** Mensaje de un campo concreto (para mostrarlo junto al input). */
  fieldError(path: string): string | undefined {
    return this.errors.find((e) => e.path === path)?.message;
  }

  static fromProblem(status: number, body: Partial<Problem>, retryAfter?: number): ApiError {
    return new ApiError(
      status,
      body.code ?? 'UNKNOWN',
      body.detail ?? body.title ?? 'Error',
      body.errors ?? [],
      body.requestId,
      retryAfter,
    );
  }
}
