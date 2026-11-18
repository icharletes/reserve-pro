import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants.js';
import { z } from 'zod';
import { ERROR_CODES, problem } from '@reservepro/contracts';
import { AppConfig } from '../../config/app-config.js';
import { Errors } from '../../common/errors.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { RATE_LIMIT_KEY, type RateLimitRule } from '../rate-limit/rate-limit.module.js';
import { AUTHZ_KEY, type AuthzMeta, Public, VERIFIED_EMAIL_KEY } from '../rbac/authz.decorators.js';
import { API_DOC_KEY, type ApiDocMeta } from './api-doc.decorator.js';

// Valores de RouteParamtypes de Nest (enum interno): BODY=3, QUERY=4, PARAM=5.
const BODY = 3;
const QUERY = 4;
const PARAM = 5;
const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const; // índice = RequestMethod de Nest

type Json = Record<string, unknown>;

export interface RouteInfo {
  cls: new () => object;
  fn: (...args: never[]) => unknown;
  controller: string;
  handler: string;
  method: (typeof HTTP_METHODS)[number];
  path: string;
  doc: ApiDocMeta | undefined;
}

function toSchema(schema: z.ZodType, io: 'input' | 'output'): Json {
  const json = z.toJSONSchema(schema, {
    io,
    unrepresentable: 'any',
    target: 'draft-2020-12',
  }) as Json;
  delete json['$schema'];
  return json;
}

const sortKeys = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(sortKeys) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Json)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    ) as T;
  }
  return value;
};

@Injectable()
export class OpenApiService {
  constructor(private readonly discovery: DiscoveryService) {}

  /** Todas las rutas HTTP registradas (salvo la del propio documento). */
  routes(): RouteInfo[] {
    const out: RouteInfo[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const cls = wrapper.metatype as (new (...a: never[]) => object) | null;
      if (!cls || cls === OpenApiController) continue;
      const prefix = String(Reflect.getMetadata(PATH_METADATA, cls) ?? '');
      for (const handler of Object.getOwnPropertyNames(cls.prototype)) {
        const fn = (cls.prototype as Record<string, unknown>)[handler];
        if (typeof fn !== 'function') continue;
        const methodIdx = Reflect.getMetadata(METHOD_METADATA, fn) as number | undefined;
        if (methodIdx === undefined) continue;
        const sub = String(Reflect.getMetadata(PATH_METADATA, fn) ?? '');
        const path = `/${[prefix, sub].filter((p) => p && p !== '/').join('/')}`.replace(
          /\/+/g,
          '/',
        );
        out.push({
          cls: cls as unknown as new () => object,
          // `typeof fn === 'function'` lo estrecha a `Function`; para Reflect basta con una firma genérica.
          fn: fn as RouteInfo['fn'],
          controller: cls.name,
          handler,
          method: HTTP_METHODS[methodIdx] ?? 'get',
          path,
          doc: (Reflect.getMetadata(API_DOC_KEY, fn) ?? Reflect.getMetadata(API_DOC_KEY, cls)) as
            ApiDocMeta | undefined,
        });
      }
    }
    return out;
  }

  build(): Json {
    const paths: Record<string, Record<string, unknown>> = {};
    const tags = new Set<string>();

    for (const r of this.routes()) {
      const { cls, fn } = r;
      const authz = (Reflect.getMetadata(AUTHZ_KEY, fn) ?? Reflect.getMetadata(AUTHZ_KEY, cls)) as
        AuthzMeta | undefined;
      const needsVerified = Boolean(
        Reflect.getMetadata(VERIFIED_EMAIL_KEY, fn) ?? Reflect.getMetadata(VERIFIED_EMAIL_KEY, cls),
      );
      const limits = (Reflect.getMetadata(RATE_LIMIT_KEY, fn) ??
        Reflect.getMetadata(RATE_LIMIT_KEY, cls) ??
        []) as RateLimitRule[];
      const doc = r.doc;
      const tag = r.controller.replace(/Controller$/, '');
      tags.add(tag);

      // --- Petición: se lee de los ZodPipe del método (cero duplicación) ---
      const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, cls, r.handler) ?? {}) as Record<
        string,
        { index: number; data?: string; pipes?: unknown[] }
      >;
      const parameters: Json[] = [];
      let requestBody: Json | undefined;
      for (const [key, arg] of Object.entries(args)) {
        const type = Number(key.split(':')[0]);
        const pipe = (arg.pipes ?? []).find((p): p is ZodPipe<unknown> => p instanceof ZodPipe);
        if (type === BODY && pipe) {
          requestBody = {
            required: true,
            content: { 'application/json': { schema: toSchema(pipe.schema, 'input') } },
          };
        } else if (type === QUERY && pipe) {
          const obj = toSchema(pipe.schema, 'input') as { properties?: Json; required?: string[] };
          for (const [name, schema] of Object.entries(obj.properties ?? {})) {
            parameters.push({
              name,
              in: 'query',
              required: obj.required?.includes(name) ?? false,
              schema,
            });
          }
        } else if (type === PARAM && arg.data) {
          parameters.push({
            name: arg.data,
            in: 'path',
            required: true,
            schema: pipe ? toSchema(pipe.schema, 'input') : { type: 'string' },
          });
        }
      }

      // --- Respuestas ---
      const successStatus =
        (Reflect.getMetadata(HTTP_CODE_METADATA, fn) as number | undefined) ??
        (r.method === 'post' ? 201 : 200);
      const responses: Record<string, Json> = {
        [String(successStatus)]:
          doc?.response == null
            ? { description: 'Sin contenido' }
            : {
                description: 'Correcto',
                content: { 'application/json': { schema: toSchema(doc.response, 'output') } },
              },
      };
      const err = (status: number, description: string) => {
        responses[String(status)] = {
          description,
          content: {
            'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } },
          },
        };
      };
      if (requestBody || parameters.length > 0) err(400, 'Datos inválidos (VALIDATION_ERROR)');
      if (authz && authz.kind !== 'public')
        err(401, 'No autenticado o sesión inválida (UNAUTHENTICATED / TOKEN_INVALID)');
      if (authz?.kind === 'permissions')
        err(403, 'Sin permiso o sin empresa activa (FORBIDDEN / TENANT_REQUIRED)');
      err(429, 'Demasiadas solicitudes (RATE_LIMITED). Incluye Retry-After');
      err(500, 'Error interno (INTERNAL_ERROR)');
      for (const [status, description] of Object.entries(doc?.errors ?? {}))
        err(Number(status), description);

      const pathKey = r.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      (paths[pathKey] ??= {})[r.method] = {
        operationId: `${tag}_${r.handler}`,
        tags: [tag],
        summary: doc?.summary ?? '(sin documentar)',
        ...(doc?.description ? { description: doc.description } : {}),
        security: authz?.kind === 'public' ? [] : [{ bearerAuth: [] }],
        ...(parameters.length > 0 ? { parameters } : {}),
        ...(requestBody ? { requestBody } : {}),
        responses,
        'x-authorization': authz?.kind ?? 'undeclared',
        ...(authz?.kind === 'permissions' ? { 'x-permissions': [...authz.permissions] } : {}),
        ...(needsVerified ? { 'x-requires-verified-email': true } : {}),
        ...(limits.length > 0 ? { 'x-rate-limits': limits } : {}),
        ...(r.controller === 'HealthController' ? { servers: [{ url: '/' }] } : {}),
      };
    }

    return sortKeys({
      openapi: '3.1.0',
      info: {
        title: 'ReservePro API',
        version: '0.1.0',
        description:
          'API REST de ReservePro. Generada automáticamente desde los contratos (Zod) y los metadatos de autorización: ' +
          'no se edita a mano. Autenticación: `Authorization: Bearer <accessToken>`. El refresh token viaja en una cookie ' +
          'HttpOnly (`rp_refresh`, ruta /api/v1/auth) y las rutas que lo usan exigen la cabecera `x-rp-csrf: 1`.',
      },
      servers: [{ url: '/api/v1' }],
      tags: [...tags].sort().map((name) => ({ name })),
      paths,
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
        schemas: {
          Problem: {
            ...toSchema(problem, 'output'),
            description: `RFC 9457 application/problem+json. Códigos estables: ${ERROR_CODES.join(', ')}`,
          },
        },
      },
    });
  }
}

/** Publica el documento. Por defecto solo fuera de producción (OPENAPI_ENABLED lo anula). */
@Controller('openapi.json')
export class OpenApiController {
  constructor(
    private readonly openapi: OpenApiService,
    private readonly config: AppConfig,
  ) {}

  @Public()
  @Get()
  get() {
    const enabled = this.config.env.OPENAPI_ENABLED ?? !this.config.isProduction;
    if (!enabled) throw Errors.notFound();
    return this.openapi.build();
  }
}

@Module({
  imports: [DiscoveryModule],
  controllers: [OpenApiController],
  providers: [OpenApiService],
  exports: [OpenApiService],
})
export class OpenApiModule {}
