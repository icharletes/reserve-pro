import { Global, Module } from '@nestjs/common';
import { type Env, loadEnv } from './env.js';

/** Configuración validada e inmutable, inyectable por tipo. */
export class AppConfig {
  constructor(readonly env: Readonly<Env>) {}

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }
}

@Global()
@Module({
  providers: [
    {
      provide: AppConfig,
      // Lee process.env al construir el módulo (las pruebas fijan el entorno antes de crear la app).
      useFactory: () => new AppConfig(Object.freeze(loadEnv())),
    },
  ],
  exports: [AppConfig],
})
export class ConfigModule {}
