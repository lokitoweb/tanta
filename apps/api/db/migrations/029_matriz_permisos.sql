-- =====================================================================
--  029 · Matriz de permisos del INF-TEC-001 (hoja Actores_Permisos)
--  Ajusta cada rol a la matriz: C = crear · L = consultar · M = modificar · A = anular · P = aprobar
-- =====================================================================

INSERT INTO core.permiso (id, grupo, descripcion) VALUES
  ('usuarios.ver', 'Seguridad', 'Consultar usuarios y sus roles (solo lectura)')
ON CONFLICT (id) DO NOTHING;

-- Fila 1: el Gerente consulta usuarios; quien los gestiona también los ve.
-- Fila 3: Producción y Almacén consultan insumos y recetas.
-- Fila 5: el Vendedor crea y modifica clientes; el Gerente los consulta.
-- Fila 10: el Administrador registra compras.
-- Fila 12: el Vendedor consulta el kárdex de productos (sin costos).
-- Fila 14: Almacén consulta el despacho de pedidos.
INSERT INTO core.rol_permiso (rol_id, permiso_id)
SELECT r, p FROM (VALUES
  ('SUPERADMIN','usuarios.ver'), ('ADMINISTRADOR','usuarios.ver'), ('GERENTE','usuarios.ver'),
  ('PRODUCCION','maestros.ver'), ('ALMACEN','maestros.ver'),
  ('VENDEDOR','clientes.gestionar'), ('GERENTE','clientes.ver'),
  ('ADMINISTRADOR','compras.registrar'),
  ('VENDEDOR','inventario.ver'),
  ('ALMACEN','pedidos.ver')) v(r, p)
WHERE EXISTS (SELECT 1 FROM core.rol WHERE id = r)
ON CONFLICT DO NOTHING;

-- Fila 6: Almacén solo consulta proveedores (los mantiene el Administrador).
DELETE FROM core.rol_permiso WHERE rol_id = 'ALMACEN' AND permiso_id = 'proveedores.gestionar';

UPDATE core.navegacion SET permiso_id = 'usuarios.ver' WHERE id = 'n-usuarios';
