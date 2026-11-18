import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { Errors } from './errors.js';

/** Valida y transforma el valor con un esquema Zod de `@reservepro/contracts`. Uso: `@Body(new ZodPipe(schema))`. */
@Injectable()
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  /** `schema` es público: el generador de OpenAPI lo lee para documentar la petición sin duplicarla. */
  constructor(readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw Errors.validation(
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
}
