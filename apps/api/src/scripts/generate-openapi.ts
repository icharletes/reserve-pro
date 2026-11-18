import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { config as loadDotenv } from 'dotenv';
import { AppModule } from '../app.module.js';
import { OpenApiService } from '../platform/openapi/openapi.service.js';

/**
 * Genera `docs/api/openapi.json` a partir del código. Uso: `pnpm --filter @reservepro/api openapi:generate`.
 * Arranca el contexto de la app (necesita la base de datos local por la sincronización de permisos).
 */
loadDotenv({ path: new URL('../../../../.env', import.meta.url).pathname, quiet: true });
process.env['LOG_LEVEL'] ??= 'silent';
process.env['RATE_LIMIT_ENABLED'] = 'false';

const out = new URL('../../../../docs/api/openapi.json', import.meta.url).pathname;
const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
const doc = app.get(OpenApiService).build();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
await app.close();
console.log(`OpenAPI escrito en ${out} (${Object.keys(doc['paths'] as object).length} rutas)`);
