-- =====================================================================
--  050 · Unidades sin duplicados
--  034 sembró GR/G «gramo» y UNID/UNIDAD «unidad» (alias de recetas antiguas): en los combos
--  salían dos «gramo» y dos «unidad». Se queda un código por unidad (G y UNIDAD) y las
--  referencias se pasan a él. Mismo factor y familia, así que ninguna cantidad cambia.
--  Desde aquí el API rechaza un nombre repetido en cualquier catálogo.
-- =====================================================================
UPDATE core.receta_detalle SET unidad_receta = 'G'      WHERE unidad_receta = 'GR';
UPDATE core.receta_detalle SET unidad_receta = 'UNIDAD' WHERE unidad_receta = 'UNID';
UPDATE core.insumo   SET unidad = 'G'      WHERE unidad = 'GR';
UPDATE core.insumo   SET unidad = 'UNIDAD' WHERE unidad = 'UNID';
UPDATE core.insumo   SET unidad_inventario = 'G'      WHERE unidad_inventario = 'GR';
UPDATE core.insumo   SET unidad_inventario = 'UNIDAD' WHERE unidad_inventario = 'UNID';
UPDATE core.producto SET unidad = 'G'      WHERE unidad = 'GR';
UPDATE core.producto SET unidad = 'UNIDAD' WHERE unidad = 'UNID';
DELETE FROM core.unidad_medida WHERE codigo IN ('GR', 'UNID');
