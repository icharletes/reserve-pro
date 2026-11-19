-- ReservePro — Migración 0008: cierra un hueco de aislamiento en la auditoría.
--
-- En PostgreSQL las políticas RLS de una tabla particionada se aplican cuando se consulta el PADRE
-- (audit_logs), pero NO si se consulta la PARTICIÓN directamente. audit_logs_default heredó los permisos por
-- defecto (SELECT/INSERT para rp_app) sin RLS: `SELECT * FROM audit_logs_default` como rp_app y sin contexto
-- devolvía filas de todas las empresas. La app nunca la consultaba así, pero RLS existe justo para cuando algo
-- falla. Lo detectó la prueba "toda tabla con tenant_id tiene RLS forzado" (packages/database/test).
--
-- Doble cierre:
--  1) rp_app no tiene ningún privilegio directo sobre la partición (las inserciones por el padre se enrutan
--     igual: PostgreSQL solo verifica permisos sobre la tabla nombrada en la consulta);
--  2) además, RLS habilitado y forzado en la partición, por si alguien vuelve a otorgarlos.
-- REGLA para particiones futuras: crearlas con este mismo tratamiento.

REVOKE ALL ON audit_logs_default FROM rp_app;
SELECT rp_enable_tenant_rls('audit_logs_default');
