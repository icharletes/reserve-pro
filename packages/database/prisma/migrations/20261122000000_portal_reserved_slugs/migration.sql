-- ReservePro — Migración 0009: slugs reservados por rutas del portal público (Fase 4B).
-- Un negocio llamado "mi-reserva" taparía la página de gestión de reservas. Debe coincidir con
-- RESERVED_SLUGS de @reservepro/contracts (lo comprueba una prueba).
INSERT INTO reserved_slugs (slug) VALUES ('mi-reserva'), ('reservas') ON CONFLICT DO NOTHING;
