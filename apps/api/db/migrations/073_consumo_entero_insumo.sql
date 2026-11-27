-- Insumos que se usan enteros (huevos y todo lo que se lleva por UNIDAD): al producir menos de un lote no se fracciona,
-- se redondea hacia arriba (0.25 huevo → 1 huevo). Cada insumo lo puede cambiar en Maestros → Insumos.
ALTER TABLE core.insumo ADD COLUMN IF NOT EXISTS consumo_entero boolean NOT NULL DEFAULT false;
UPDATE core.insumo SET consumo_entero = true WHERE unidad_inventario = 'UNIDAD';
