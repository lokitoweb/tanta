-- =====================================================================
--  012 · Catálogo de seguridad base en una instalación nueva
--  Antes, roles, permisos, menú y parámetros solo los creaba la semilla de
--  demostración: un despliegue de producción (solo migraciones) quedaba sin
--  roles ni menú. Idempotente: no pisa lo que el administrador ya cambió.
--  Generado desde apps/api/db/seed.ts (misma fuente que la semilla).
-- =====================================================================

INSERT INTO core.permiso (id, grupo, descripcion) VALUES
  ('panel.ver', 'Panel', 'Ver el panel de inicio'),
  ('dashboard.ver', 'Gerencia', 'Ver dashboard de costos y márgenes'),
  ('costos.ver', 'Gerencia', 'Ver costo unitario, margen y markup'),
  ('maestros.ver', 'Maestros', 'Consultar productos, insumos y recetas'),
  ('maestros.editar', 'Maestros', 'Crear y editar maestros'),
  ('recetas.ver', 'Maestros', 'Consultar recetas sin columnas de costo'),
  ('recetas.editar', 'Maestros', 'Crear versiones de receta'),
  ('inventario.ver', 'Almacén', 'Consultar stock y kárdex'),
  ('inventario.mover', 'Almacén', 'Registrar bajas, ajustes y recepciones'),
  ('produccion.ver', 'Producción', 'Ver el tablero de órdenes'),
  ('produccion.ejecutar', 'Producción', 'Iniciar, cerrar y reportar merma'),
  ('pedidos.ver', 'Ventas', 'Ver pedidos'),
  ('pedidos.gestionar', 'Ventas', 'Cambiar estado y despachar pedidos'),
  ('ventas.registrar', 'Ventas', 'Registrar venta a terceros'),
  ('cobranza.ver', 'Cobranza', 'Ver cartera y deudas'),
  ('cobranza.registrar', 'Cobranza', 'Registrar pagos totales o parciales'),
  ('clientes.ver', 'Ventas', 'Ver ficha de clientes'),
  ('reportes.ver', 'Gerencia', 'Ver y exportar reportes'),
  ('usuarios.gestionar', 'Seguridad', 'Alta, baja y bloqueo de usuarios'),
  ('catalogo.ver', 'Cliente', 'Ver catálogo y precios de venta'),
  ('parametros.gestionar', 'Seguridad', 'Cambiar parámetros de negocio'),
  ('periodos.cerrar', 'Gerencia', 'Calcular y cerrar el período de costos'),
  ('config.gestionar', 'Seguridad', 'Configurar marca, app móvil, integraciones y legal'),
  ('roles.gestionar', 'Seguridad', 'Editar los permisos de cada rol')
ON CONFLICT (id) DO NOTHING;

INSERT INTO core.rol (id, nombre, corto, descripcion, perfil, icono, orden) VALUES
  ('SUPERADMIN', 'Superadministrador', 'Sistema', 'Configuración total del sistema', 'web', 'shield', 0),
  ('GERENTE', 'Gerente', 'Gerencia', 'Costos, rentabilidad y márgenes', 'web', 'chart', 1),
  ('ADMINISTRADOR', 'Administrador', 'Maestros', 'Productos, recetas, costos y usuarios', 'web', 'settings', 2),
  ('PRODUCCION', 'Producción', 'Producción', 'Órdenes de producción y merma', 'tablet', 'oven', 3),
  ('ALMACEN', 'Almacén', 'Almacén', 'Stock, bajas y kárdex', 'app', 'box', 4),
  ('VENDEDOR', 'Vendedor', 'Ventas', 'Despacho, ventas a terceros y cobranza', 'app', 'truck', 5),
  ('CLIENTE', 'Cliente', 'Cliente', 'Catálogo, pedidos y saldo', 'app', 'user', 6),
  ('SOPORTE', 'Soporte técnico', 'Soporte', 'Break-glass: sin datos de negocio', 'web', 'shield', 7)
ON CONFLICT (id) DO NOTHING;

-- Permisos por rol solo para roles recién creados: si un rol ya existía, su
-- configuración actual (editada desde Roles y permisos) se respeta.
INSERT INTO core.rol_permiso (rol_id, permiso_id)
SELECT v.rol, v.permiso FROM (VALUES
  ('SUPERADMIN', 'panel.ver'),
  ('SUPERADMIN', 'dashboard.ver'),
  ('SUPERADMIN', 'costos.ver'),
  ('SUPERADMIN', 'maestros.ver'),
  ('SUPERADMIN', 'maestros.editar'),
  ('SUPERADMIN', 'recetas.ver'),
  ('SUPERADMIN', 'recetas.editar'),
  ('SUPERADMIN', 'inventario.ver'),
  ('SUPERADMIN', 'inventario.mover'),
  ('SUPERADMIN', 'produccion.ver'),
  ('SUPERADMIN', 'produccion.ejecutar'),
  ('SUPERADMIN', 'pedidos.ver'),
  ('SUPERADMIN', 'pedidos.gestionar'),
  ('SUPERADMIN', 'ventas.registrar'),
  ('SUPERADMIN', 'cobranza.ver'),
  ('SUPERADMIN', 'cobranza.registrar'),
  ('SUPERADMIN', 'clientes.ver'),
  ('SUPERADMIN', 'reportes.ver'),
  ('SUPERADMIN', 'usuarios.gestionar'),
  ('SUPERADMIN', 'catalogo.ver'),
  ('SUPERADMIN', 'parametros.gestionar'),
  ('SUPERADMIN', 'periodos.cerrar'),
  ('SUPERADMIN', 'config.gestionar'),
  ('SUPERADMIN', 'roles.gestionar'),
  ('GERENTE', 'panel.ver'),
  ('GERENTE', 'dashboard.ver'),
  ('GERENTE', 'costos.ver'),
  ('GERENTE', 'reportes.ver'),
  ('GERENTE', 'maestros.ver'),
  ('GERENTE', 'inventario.ver'),
  ('GERENTE', 'pedidos.ver'),
  ('GERENTE', 'cobranza.ver'),
  ('GERENTE', 'periodos.cerrar'),
  ('ADMINISTRADOR', 'panel.ver'),
  ('ADMINISTRADOR', 'maestros.ver'),
  ('ADMINISTRADOR', 'maestros.editar'),
  ('ADMINISTRADOR', 'recetas.ver'),
  ('ADMINISTRADOR', 'recetas.editar'),
  ('ADMINISTRADOR', 'costos.ver'),
  ('ADMINISTRADOR', 'inventario.ver'),
  ('ADMINISTRADOR', 'usuarios.gestionar'),
  ('ADMINISTRADOR', 'reportes.ver'),
  ('ADMINISTRADOR', 'parametros.gestionar'),
  ('PRODUCCION', 'panel.ver'),
  ('PRODUCCION', 'produccion.ver'),
  ('PRODUCCION', 'produccion.ejecutar'),
  ('PRODUCCION', 'recetas.ver'),
  ('PRODUCCION', 'inventario.ver'),
  ('ALMACEN', 'panel.ver'),
  ('ALMACEN', 'inventario.ver'),
  ('ALMACEN', 'inventario.mover'),
  ('ALMACEN', 'recetas.ver'),
  ('VENDEDOR', 'panel.ver'),
  ('VENDEDOR', 'pedidos.ver'),
  ('VENDEDOR', 'pedidos.gestionar'),
  ('VENDEDOR', 'ventas.registrar'),
  ('VENDEDOR', 'cobranza.ver'),
  ('VENDEDOR', 'cobranza.registrar'),
  ('VENDEDOR', 'clientes.ver'),
  ('CLIENTE', 'panel.ver'),
  ('CLIENTE', 'catalogo.ver'),
  ('SOPORTE', 'panel.ver')
) AS v(rol, permiso)
WHERE NOT EXISTS (SELECT 1 FROM core.rol_permiso rp WHERE rp.rol_id = v.rol)
   OR v.rol = 'SUPERADMIN'
ON CONFLICT DO NOTHING;

INSERT INTO core.navegacion (id, grupo, etiqueta, ruta, icono, permiso_id, orden, grupo_orden) VALUES
  ('n-panel', 'Operación', 'Panel', '/panel', 'home', 'panel.ver', 1, 1),
  ('n-produccion', 'Operación', 'Producción', '/produccion', 'oven', 'produccion.ver', 2, 1),
  ('n-almacen', 'Operación', 'Almacén', '/almacen', 'box', 'inventario.ver', 3, 1),
  ('n-kardex', 'Operación', 'Kárdex', '/almacen/kardex', 'ledger', 'inventario.ver', 4, 1),
  ('n-pedidos', 'Comercial', 'Pedidos', '/ventas/pedidos', 'clipboard', 'pedidos.ver', 1, 2),
  ('n-cobranza', 'Comercial', 'Cobranza', '/ventas/cobranza', 'wallet', 'cobranza.ver', 2, 2),
  ('n-catalogo', 'Comercial', 'Catálogo', '/catalogo', 'bread', 'catalogo.ver', 3, 2),
  ('n-productos', 'Maestros', 'Productos', '/maestros/productos', 'bread', 'maestros.ver', 1, 3),
  ('n-insumos', 'Maestros', 'Insumos', '/maestros/insumos', 'sack', 'maestros.ver', 2, 3),
  ('n-recetas', 'Maestros', 'Recetas', '/maestros/recetas', 'recipe', 'recetas.ver', 3, 3),
  ('n-usuarios', 'Maestros', 'Usuarios y roles', '/seguridad/usuarios', 'shield', 'usuarios.gestionar', 4, 3),
  ('n-parametros', 'Maestros', 'Parámetros', '/seguridad/parametros', 'settings', 'parametros.gestionar', 5, 3),
  ('n-roles', 'Sistema', 'Roles y permisos', '/sistema/roles', 'shield', 'roles.gestionar', 1, 9),
  ('n-config', 'Sistema', 'Configuración', '/sistema/configuracion', 'settings', 'config.gestionar', 2, 9),
  ('n-dashboard', 'Gerencia', 'Costos y márgenes', '/gerencia/dashboard', 'chart', 'dashboard.ver', 1, 4),
  ('n-reportes', 'Gerencia', 'Reportes', '/gerencia/reportes', 'report', 'reportes.ver', 2, 4),
  ('n-periodos', 'Gerencia', 'Períodos de costo', '/gerencia/periodos', 'report', 'periodos.cerrar', 3, 4)
ON CONFLICT (id) DO NOTHING;

INSERT INTO core.parametro (clave, valor, tipo, descripcion) VALUES
  ('igv', '0.18', 'porcentaje', 'IGV vigente en Perú'),
  ('moneda', 'PEN', 'texto', 'Moneda del sistema'),
  ('margen_objetivo_global', '0.52', 'porcentaje', 'Margen objetivo por defecto'),
  ('permitir_saldo_negativo', 'false', 'booleano', 'Política estricta de inventario')
ON CONFLICT (clave) DO NOTHING;
