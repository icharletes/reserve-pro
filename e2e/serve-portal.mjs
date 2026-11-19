// Sirve el portal COMPILADO como en producción: un "balanceador" mínimo envía /api a la API y el resto al
// servidor de Astro. Así el navegador habla con un único origen (CSP connect-src 'self'), igual que en producción.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORTAL_PORT ?? 4400);
const ASTRO_PORT = PORT + 1;
const API = new URL(process.env.API_URL ?? 'http://localhost:3100');

const astro = spawn(process.execPath, ['dist/server/entry.mjs'], {
  cwd: fileURLToPath(new URL('../apps/web/', import.meta.url)),
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(ASTRO_PORT), API_URL: API.origin },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const stop = () => astro.kill();
process.on('SIGTERM', stop).on('SIGINT', stop).on('exit', stop);

http
  .createServer((req, res) => {
    const toApi = req.url?.startsWith('/api/');
    const target = toApi ? API : new URL(`http://127.0.0.1:${ASTRO_PORT}`);
    const headers = { ...req.headers, host: target.host };
    if (toApi) headers['x-forwarded-for'] = req.socket.remoteAddress ?? '';
    const upstream = http.request(
      { hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502).end('upstream no disponible');
    });
    req.pipe(upstream);
  })
  .listen(PORT, () => process.stdout.write(`portal e2e en http://localhost:${PORT}\n`));
