import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

// .env vive en la raíz del monorepo.
config({ path: '../../.env', quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // Las migraciones corren SIEMPRE con el rol dueño (rp_owner), nunca con rp_app.
    url: process.env['DATABASE_URL_OWNER'] ?? '',
  },
});
