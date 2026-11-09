-- =====================================================================
--  059 · Merma de proceso por defecto administrable (audio del cliente, 09/11/2026)
--  Antes: la web y la API ponían 3 % fijo a todo producto nuevo; la regla de negocio de Tanta es sin merma.
--  Ahora: parámetro «merma_proceso_defecto» (Parámetros) con que nace un producto y su primera receta.
--  Los productos que tenían el 3 % puesto por el código y aún no tienen receta pasan al valor del parámetro.
-- =====================================================================
INSERT INTO core.parametro (clave, valor, tipo, descripcion) VALUES
  ('merma_proceso_defecto', '0', 'porcentaje', 'Merma de proceso con que nace un producto nuevo y su primera receta (0.03 = 3 %). Cada receta puede tener la suya')
ON CONFLICT (clave) DO NOTHING;

UPDATE core.producto p SET merma_pct = (SELECT valor::numeric FROM core.parametro WHERE clave = 'merma_proceso_defecto')
WHERE p.merma_pct = 0.03 AND NOT EXISTS (SELECT 1 FROM core.receta r WHERE r.producto_id = p.id);
