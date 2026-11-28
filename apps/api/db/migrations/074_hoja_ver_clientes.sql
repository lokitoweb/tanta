-- Hoja de producción: ver una columna por cliente tiene su propio permiso en el grupo Producción
-- (antes dependía de «Ver pedidos», que además abre el módulo de Pedidos).
INSERT INTO core.permiso (id, grupo, descripcion) VALUES
  ('produccion.ver_clientes', 'Producción', 'Ver pedidos de clientes en tablas de hoja de producción')
ON CONFLICT (id) DO NOTHING;

-- Nadie pierde lo que ve hoy: lo reciben los roles que ya tienen «Ver pedidos».
INSERT INTO core.rol_permiso (rol_id, permiso_id)
SELECT rol_id, 'produccion.ver_clientes' FROM core.rol_permiso WHERE permiso_id = 'pedidos.ver'
ON CONFLICT DO NOTHING;
