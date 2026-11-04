-- =====================================================================
--  039 · Unidad de venta del producto desde el catálogo de unidades
--  Antes era texto libre en la API y una lista fija en la web (con "VASO", y la semilla usaba "PORCIÓN").
--  Ahora se elige del catálogo de unidades (Maestros → Catálogos), como los insumos.
-- =====================================================================
INSERT INTO core.unidad_medida (codigo, descripcion, familia, factor_a_patron, orden) VALUES
  ('PORCION', 'porción', 'CONTEO', 1, 20), ('DOCENA', 'docena', 'CONTEO', 12, 21), ('TORTA', 'torta entera', 'CONTEO', 1, 22)
ON CONFLICT (codigo) DO NOTHING;
UPDATE core.producto SET unidad = 'PORCION' WHERE unidad IN ('PORCIÓN', 'PORCIÓN ');
-- Lo que quede fuera del catálogo se vende por unidad.
UPDATE core.producto SET unidad = 'UNIDAD' WHERE unidad NOT IN (SELECT codigo FROM core.unidad_medida);
DO $$ BEGIN
  ALTER TABLE core.producto ADD CONSTRAINT fk_producto_unidad FOREIGN KEY (unidad) REFERENCES core.unidad_medida(codigo);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
