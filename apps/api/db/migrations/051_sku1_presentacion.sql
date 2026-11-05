-- =====================================================================
--  051 · SKU #1 con presentación de venta
--  Todos los SKU del producto (#1, #2, #3…) eligen del mismo catálogo «Presentaciones de venta».
--  El SKU #1 guarda su presentación aquí; el precio del producto sigue siendo el de UNA unidad
--  (el motor de costos y el margen trabajan por unidad): precio del SKU #1 = precio_con_igv × equivalencia.
-- =====================================================================
ALTER TABLE core.producto
  ADD COLUMN IF NOT EXISTS presentacion_codigo text NOT NULL DEFAULT 'UNID' REFERENCES core.presentacion_venta(codigo);
