import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Response } from 'express';
import type { Logger } from 'pino';
import type { ErrorCode } from '@reservepro/contracts';
import { LOGGER } from '../platform/logging/logger.js';
import { AppError } from './errors.js';

const STATUS_CODES: Record<number, ErrorCode> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  413: 'VALIDATION_ERROR',
  429: 'TOO_MANY_ATTEMPTS',
};

/** Serializa TODOS los errores como RFC 9457 `application/problem+json` con código estable y requestId. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly cls: ClsService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const requestId = this.cls.getId();

    let status = 500;
    let code: ErrorCode = 'INTERNAL_ERROR';
    let detail = 'Error interno';
    let errors: AppError['errors'];

    if (exception instanceof AppError) {
      status = exception.status;
      code = exception.code;
      detail = exception.message;
      errors = exception.errors;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = STATUS_CODES[status] ?? 'INTERNAL_ERROR';
      // Mensajes de Nest (rutas inexistentes, JSON inválido…) son seguros; no exponen datos internos.
      detail = status >= 500 ? 'Error interno' : exception.message;
    }

    if (status >= 500) {
      // El detalle real solo va al log (con requestId para correlacionar), nunca al cliente.
      this.logger.error({ err: exception, requestId }, 'unhandled error');
    }

    res
      .status(status)
      .type('application/problem+json')
      .json({
        type: `https://reservepro.cl/errors/${code.toLowerCase()}`,
        title: code,
        status,
        code,
        detail,
        requestId,
        ...(errors ? { errors } : {}),
      });
  }
}
