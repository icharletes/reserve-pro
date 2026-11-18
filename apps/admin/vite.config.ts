import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    // El panel y la API comparten ORIGEN en desarrollo: la cookie HttpOnly del refresh token es "first-party"
    // y no hace falta CORS. En producción lo mismo se logra con el balanceador (/api -> API).
    proxy: {
      '/api': { target: process.env['API_URL'] ?? 'http://localhost:3000', changeOrigin: false },
    },
  },
  test: { environment: 'jsdom', include: ['src/**/*.test.ts'], globals: false },
});
