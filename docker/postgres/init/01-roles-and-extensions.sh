#!/bin/bash
# Se ejecuta UNA vez al crear el volumen de Postgres (solo desarrollo local).
# Crea los roles descritos en docs/architecture/ARCHITECTURE.md §2.4 y las extensiones requeridas.
#   rp_owner  -> creado por la imagen (POSTGRES_USER); dueño del esquema, ejecuta migraciones.
#   rp_app    -> runtime de API/worker. SUJETO a RLS (NOBYPASSRLS, no superuser).
#   rp_system -> tareas cross-tenant acotadas. BYPASSRLS. Uso restringido.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE ROLE rp_app    LOGIN PASSWORD '${RP_APP_PASSWORD}'    NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  CREATE ROLE rp_system LOGIN PASSWORD '${RP_SYSTEM_PASSWORD}' NOSUPERUSER BYPASSRLS   NOCREATEDB NOCREATEROLE;

  CREATE EXTENSION IF NOT EXISTS btree_gist;
  CREATE EXTENSION IF NOT EXISTS citext;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;

  GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO rp_app, rp_system;
  GRANT USAGE ON SCHEMA public TO rp_app, rp_system;

  -- Toda tabla futura creada por rp_owner queda accesible a los roles de runtime.
  -- (Los REVOKE puntuales, p.ej. tablas append-only, van en cada migración.)
  ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_USER} IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rp_app, rp_system;
  ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_USER} IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO rp_app, rp_system;
EOSQL
