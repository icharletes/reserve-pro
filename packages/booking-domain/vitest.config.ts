import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Las pruebas de propiedades ejecutan cientos de casos con zonas horarias (Luxon). Con el pipeline completo en
  // paralelo (bases de datos, builds) pueden tardar varias veces más que sueltas: 5 s es un límite demasiado justo.
  test: { testTimeout: 30_000 },
});
