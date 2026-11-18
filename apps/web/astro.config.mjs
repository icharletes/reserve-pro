import node from '@astrojs/node';
import vue from '@astrojs/vue';
import { defineConfig } from 'astro/config';

// SSR: cada negocio se resuelve por slug (o dominio propio, más adelante) en el servidor, para SEO y para
// no exponer datos de un tenant que no existe. Las islas Vue solo se hidratan donde hay interacción.
export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [vue()],
  server: { port: 4321, host: false },
  security: { checkOrigin: true },
  vite: {
    // En desarrollo el navegador habla con la API por el mismo origen (sin CORS; cookies first-party).
    server: { proxy: { '/api': { target: process.env.API_URL ?? 'http://localhost:3000' } } },
  },
});
