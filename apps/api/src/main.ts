import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { config as loadDotenv } from 'dotenv';
import type { Logger } from 'pino';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';
import { AppConfig } from './config/app-config.js';
import { LOGGER } from './platform/logging/logger.js';

// En local el .env vive en la raíz del monorepo; en producción las variables llegan por el entorno.
const rootEnv = new URL('../../../.env', import.meta.url).pathname;
if (existsSync(rootEnv)) loadDotenv({ path: rootEnv, quiet: true });

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  configureApp(app);
  const { env } = app.get(AppConfig);
  await app.listen(env.API_PORT);
  app.get<Logger>(LOGGER).info({ port: env.API_PORT }, 'API escuchando');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
