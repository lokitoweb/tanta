-- Informe «modificaciones sistema tanta» (13/11):
-- 1) Recetas: si el producto declara cuántos panes salen de verdad por lote (N.° de unidades por lote), ese número
--    manda en el costo de insumos por pan y en la planificación; el cálculo por peso queda como referencia.
-- 2) Ofertas: cantidad limitada por promoción, aviso de «agotada» y el pedido de oferta separado del regular
--    (no pasa por producción y se cobra aparte).

DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('core.recalcular_costos_base()'::regprocedure);
  IF position('p.unidades_lote::numeric' IN def) = 0 THEN
    -- Unidades esperadas: las reales del producto; sin ellas, por peso de masa; sin peso, el rendimiento declarado.
    def := replace(def,
'    unidades_esperadas = CASE WHEN p.peso_masa_g > 0 THEN',
'    unidades_esperadas = CASE WHEN p.unidades_lote > 0 THEN p.unidades_lote::numeric WHEN p.peso_masa_g > 0 THEN');
    -- Costo de insumos por pan: lote ÷ unidades reales (la merma ya está en lo que realmente sale).
    def := replace(def,
'    costo_insumos   = CASE WHEN unidades_teoricas > 0 THEN costo_lote / unidades_teoricas ELSE 0 END,',
'    costo_insumos   = CASE WHEN (SELECT x.unidades_lote FROM core.producto x WHERE x.id = producto_id) > 0 AND unidades_esperadas > 0 THEN costo_lote / unidades_esperadas
                           WHEN unidades_teoricas > 0 THEN costo_lote / unidades_teoricas ELSE 0 END,');
    def := replace(def,
'    costo_con_merma = CASE WHEN unidades_teoricas > 0 THEN costo_lote / unidades_teoricas',
'    costo_con_merma = CASE WHEN (SELECT x.unidades_lote FROM core.producto x WHERE x.id = producto_id) > 0 AND unidades_esperadas > 0 THEN costo_lote / unidades_esperadas
                           WHEN unidades_teoricas > 0 THEN costo_lote / unidades_teoricas');
    IF position('p.unidades_lote::numeric' IN def) = 0
       OR (length(def) - length(replace(def, 'THEN costo_lote / unidades_esperadas', ''))) / length('THEN costo_lote / unidades_esperadas') <> 2 THEN
      RAISE EXCEPTION 'No se pudo aplicar las unidades reales al motor de costos';
    END IF;
    EXECUTE def;
  END IF;
END $$;

/* Ofertas: unidades ofrecidas (vacío = hasta agotar el stock) y cuándo se agotó (para avisar una sola vez). */
ALTER TABLE core.promocion
  ADD COLUMN cantidad   integer CHECK (cantidad IS NULL OR cantidad > 0),
  ADD COLUMN agotada_en timestamptz;

/* Pedido de oferta: solo productos terminados en promoción; no entra a producción y se cobra aparte del regular. */
ALTER TABLE core.pedido ADD COLUMN es_oferta boolean NOT NULL DEFAULT false;
UPDATE core.pedido p SET es_oferta = true
WHERE EXISTS (SELECT 1 FROM core.pedido_detalle d WHERE d.pedido_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM core.pedido_detalle d WHERE d.pedido_id = p.id AND d.promocion_id IS NULL);

SELECT core.recalcular_costos();
