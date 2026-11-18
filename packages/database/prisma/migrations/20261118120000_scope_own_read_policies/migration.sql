-- ReservePro — Migración 0002: acotar las políticas "lectura de lo propio".
--
-- PROBLEMA (detectado por la suite e2e de la API): `own_memberships_read` y `own_tenants_read` existen para
-- que un usuario liste SUS empresas al iniciar sesión (cuando aún no hay tenant activo). Pero, al combinarse
-- (OR) con `tenant_isolation`, seguían vigentes DENTRO de una sesión con tenant activo: una consulta sin WHERE
-- sobre `tenants` devolvía todas las empresas del usuario, no solo la activa. No era una fuga hacia terceros,
-- pero rompía la garantía "con tenant activo, solo se ve ese tenant".
--
-- SOLUCIÓN: estas políticas solo aplican cuando NO hay tenant activo (rp_current_tenant() IS NULL).
-- Con tenant activo manda únicamente `tenant_isolation`. Lo garantiza la base de datos, no la disciplina de la app.

DROP POLICY own_memberships_read ON tenant_memberships;
CREATE POLICY own_memberships_read ON tenant_memberships FOR SELECT
  USING (rp_current_tenant() IS NULL AND user_id = rp_current_user());

DROP POLICY own_tenants_read ON tenants;
CREATE POLICY own_tenants_read ON tenants FOR SELECT
  USING (
    rp_current_tenant() IS NULL
    AND EXISTS (
      SELECT 1 FROM tenant_memberships m
      WHERE m.tenant_id = tenants.id AND m.user_id = rp_current_user()
    )
  );
