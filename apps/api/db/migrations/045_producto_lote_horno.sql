-- =====================================================================
--  045 · Producto: peso final medido y unidades por lote de horno (revisión del módulo Productos, 5-nov-2026)
--
--  · peso_final_g: se pesa el pan al salir del horno. La pérdida por cocción ya no se escribe:
--    se calcula = 1 − peso final ÷ peso de masa cruda.
--  · unidades_lote: cuántos panes entran al horno en una bandeja (lote de horno). Las horas de horno y
--    de mano de obra son POR ESE LOTE, así que su costo por pan = horas × tarifa ÷ unidades del lote.
--    Sin el dato, se usan las unidades esperadas de la receta (comportamiento anterior).
-- =====================================================================

ALTER TABLE core.producto
  ADD COLUMN IF NOT EXISTS peso_final_g  numeric(12,3) CHECK (peso_final_g IS NULL OR peso_final_g > 0),
  ADD COLUMN IF NOT EXISTS unidades_lote integer       CHECK (unidades_lote IS NULL OR unidades_lote > 0);

-- Peso final de los productos que ya tenían pérdida por cocción registrada.
UPDATE core.producto SET peso_final_g = round(peso_masa_g * (1 - perdida_coccion), 3)
WHERE peso_final_g IS NULL AND peso_masa_g > 0 AND coalesce(perdida_coccion, 0) > 0;

DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('core.recalcular_costos_base()'::regprocedure);
  IF position('unidades_lote' IN def) = 0 THEN
    -- Mano de obra por pan: horas hombre del lote × costo hora ÷ panes del lote de horno.
    def := replace(def,
'  UPDATE core.receta r SET mo_unitario = CASE WHEN r.unidades_esperadas > 0
      THEN p.horas_hombre_lote * coalesce(v_hora, 0) / r.unidades_esperadas ELSE 0 END',
'  UPDATE core.receta r SET mo_unitario = CASE WHEN coalesce(p.unidades_lote, r.unidades_esperadas) > 0
      THEN p.horas_hombre_lote * coalesce(v_hora, 0) / coalesce(p.unidades_lote, r.unidades_esperadas) ELSE 0 END');
    -- Horas de horno del mes: lotes de horno = unidades ÷ panes por lote.
    def := replace(def,
'  SELECT coalesce(sum(a.u / nullif(r.unidades_esperadas, 0) * p.horas_horno_lote), 0),',
'  SELECT coalesce(sum(a.u / nullif(coalesce(p.unidades_lote, r.unidades_esperadas), 0) * p.horas_horno_lote), 0),');
    -- CIF por pan: horno por lote de horno; masa por lote de receta; más la tarifa por unidad.
    def := replace(def,
'  UPDATE core.receta r SET cif_unitario = CASE WHEN r.unidades_esperadas > 0
      THEN (p.horas_horno_lote * t_h + r.masa_lote_kg * t_k) / r.unidades_esperadas + t_u ELSE t_u END',
'  UPDATE core.receta r SET cif_unitario = CASE WHEN r.unidades_esperadas > 0
      THEN p.horas_horno_lote * t_h / coalesce(p.unidades_lote, r.unidades_esperadas) + r.masa_lote_kg * t_k / r.unidades_esperadas + t_u ELSE t_u END');
    IF (length(def) - length(replace(def, 'unidades_lote', ''))) / length('unidades_lote') < 4 THEN
      RAISE EXCEPTION 'No se pudo aplicar el lote de horno al motor de costos';
    END IF;
    EXECUTE def;
  END IF;

  -- El cierre mensual cuenta las horas de horno con el mismo lote.
  def := pg_get_functiondef('core.cerrar_periodo(uuid, uuid)'::regprocedure);
  IF position('unidades_lote' IN def) = 0 THEN
    def := replace(def,
      'coalesce(o.cantidad_producida, o.cantidad) / nullif(r.unidades_esperadas, 0) * pr.horas_horno_lote',
      'coalesce(o.cantidad_producida, o.cantidad) / nullif(coalesce(pr.unidades_lote, r.unidades_esperadas), 0) * pr.horas_horno_lote');
    IF position('unidades_lote' IN def) = 0 THEN RAISE EXCEPTION 'No se pudo aplicar el lote de horno al cierre mensual'; END IF;
    EXECUTE def;
  END IF;
END $$;

SELECT core.recalcular_costos();
