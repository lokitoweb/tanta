-- =====================================================================
--  018 · Matriz de permisos según la Tabla 2 del PDF (● edita · ○ consulta)
--  Solo AGREGA permisos de consulta faltantes; no quita lo que el Superadmin ya ajustó.
-- =====================================================================
INSERT INTO core.rol_permiso (rol_id, permiso_id)
SELECT v.r, v.p FROM (VALUES
  ('ADMINISTRADOR','pedidos.ver'), ('ADMINISTRADOR','produccion.ver'), ('ADMINISTRADOR','cobranza.ver'),
  ('ADMINISTRADOR','dashboard.ver'), ('ADMINISTRADOR','catalogo.ver'),
  ('GERENTE','catalogo.ver'), ('GERENTE','recetas.ver'), ('GERENTE','produccion.ver'),
  ('PRODUCCION','catalogo.ver'),
  ('ALMACEN','catalogo.ver'), ('ALMACEN','produccion.ver'), ('ALMACEN','reportes.ver'),
  ('VENDEDOR','catalogo.ver'), ('VENDEDOR','reportes.ver'),
  ('CLIENTE','pedidos.crear')
) v(r, p)
WHERE EXISTS (SELECT 1 FROM core.rol WHERE id = v.r) AND EXISTS (SELECT 1 FROM core.permiso WHERE id = v.p)
ON CONFLICT DO NOTHING;
