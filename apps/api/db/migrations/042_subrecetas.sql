-- =====================================================================
--  042 · Sub-recetas y productos intermedios (MAE-06 / PRO-13 / RN-09)
--
--  Un producto puede PRODUCIR un insumo (p. ej. el producto «Masa madre» produce el insumo
--  «Masa madre»). Así el intermedio tiene su propia receta, rendimiento y costo, y:
--   · su costo entra al costo de los panes que lo usan (el motor lo calcula primero);
--   · al cerrar su OP, el stock entra al almacén de INSUMOS (a costo real, con costo promedio);
--   · no se vende ni aparece en el catálogo.
--  La unidad de venta del producto intermedio = unidad de inventario del insumo (se valida en el API).
-- =====================================================================

ALTER TABLE core.producto ADD COLUMN IF NOT EXISTS insumo_id uuid REFERENCES core.insumo(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_producto_insumo ON core.producto (insumo_id) WHERE insumo_id IS NOT NULL;

-- Motor en dos pasadas: 1) costo de todos los productos (incluye intermedios); 2) el insumo intermedio
-- SIN stock toma el costo estándar de su receta (con stock manda su costo promedio del kárdex, como
-- cualquier insumo); 3) se recalcula para que los panes incorporen ese costo.
-- ponytail: dos pasadas cubren un nivel de anidamiento (masa madre → pan). Si hubiera sub-recetas de
-- sub-recetas, iterar hasta que no cambie ningún costo.
CREATE OR REPLACE FUNCTION core.recalcular_costos() RETURNS integer AS $$
DECLARE n integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('core.recalcular_costos'));
  PERFORM 1 FROM core.producto ORDER BY id FOR UPDATE;
  n := core.recalcular_costos_base();
  IF EXISTS (SELECT 1 FROM core.producto WHERE insumo_id IS NOT NULL) THEN
    UPDATE core.insumo i SET cpp = p.costo_unitario, actualizado_en = now()
    FROM core.producto p
    WHERE p.insumo_id = i.id AND i.stock <= 0 AND p.costo_unitario > 0 AND i.cpp IS DISTINCT FROM p.costo_unitario;
    n := core.recalcular_costos_base();
  END IF;
  RETURN n;
END $$ LANGUAGE plpgsql;
