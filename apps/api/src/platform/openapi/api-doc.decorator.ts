import { SetMetadata } from '@nestjs/common';
import type { ZodType } from 'zod';

export const API_DOC_KEY = 'reservepro:apidoc';

export interface ApiDocMeta {
  summary: string;
  description?: string;
  /** Esquema de la respuesta exitosa; `null` si no hay cuerpo (204). Obligatorio: nada queda sin documentar. */
  response: ZodType | null;
  /** Errores específicos de la ruta, por estado HTTP (además de los que se deducen de la autorización). */
  errors?: Record<number, string>;
}

/**
 * Documenta un endpoint. La petición (cuerpo, query, parámetros) NO se repite aquí: se lee de los
 * `ZodPipe` del propio método, así que no puede divergir del código. Un test falla si una ruta no la usa.
 */
export const ApiDoc = (meta: ApiDocMeta) => SetMetadata(API_DOC_KEY, meta);
