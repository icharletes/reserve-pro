import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { config as loadDotenv } from 'dotenv';
import type { Logger } from 'pino';
import { LOGGER } from './platform/logging/logger.js';
import { WorkerModule } from './worker/worker.module.js';

// En local el .env vive en la raíz del monorepo; en producción las variables llegan por el entorno.
const rootEnv = new URL('../../../.env', import.meta.url).pathname;
if (existsSync(rootEnv)) loadDotenv({ path: rootEnv, quiet: true });

async function main(): Promise<void> {
  // Contexto sin servidor HTTP: el worker solo consume colas.
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error', 'warn'] });
  app.enableShutdownHooks(); // SIGTERM/SIGINT => cierre ordenado (termina el job en curso)
  app.get<Logger>(LOGGER).info('worker iniciado');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
