-- Análisis de costo y precio en su propia pantalla (Gerencia), fuera del registro de productos.
INSERT INTO core.navegacion (id, grupo, etiqueta, ruta, icono, permiso_id, orden, grupo_orden) VALUES
  ('n-analisis-precios', 'Gerencia', 'Análisis de precios', '/gerencia/analisis-precios', 'chart', 'costos.ver', 2, 4)
ON CONFLICT (id) DO NOTHING;
