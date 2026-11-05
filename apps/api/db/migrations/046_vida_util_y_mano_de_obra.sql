-- =====================================================================
--  046 · Vida útil del producto y mano de obra por tiempo de horneado (revisión del módulo Productos)
--
--  · producto.vida_util_dias: días que el pan se puede vender desde que sale del horno.
--    La fecha de producción y la de vencimiento son de cada horneada (orden de producción), no del
--    producto: al cerrar la OP, fecha_produccion = día de cierre y vence_en = ese día + vida útil.
--  · Mano de obra: como explicó el dueño, se paga por el tiempo del horno («si el horno trabaja media
--    hora y la hora del panadero cuesta S/ 10, la mano de obra es S/ 5»). Si no hay horas hombre
--    propias registradas, se usa el tiempo de horneado del lote.
-- =====================================================================

ALTER TABLE core.producto ADD COLUMN IF NOT EXISTS vida_util_dias integer CHECK (vida_util_dias IS NULL OR vida_util_dias BETWEEN 0 AND 3650);
ALTER TABLE core.orden_produccion
  ADD COLUMN IF NOT EXISTS fecha_produccion date,
  ADD COLUMN IF NOT EXISTS vence_en date;

DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('core.recalcular_costos_base()'::regprocedure);
  IF position('nullif(p.horas_hombre_lote, 0), p.horas_horno_lote' IN def) = 0 THEN
    def := replace(def,
      'THEN p.horas_hombre_lote * coalesce(v_hora, 0) / coalesce(p.unidades_lote, r.unidades_esperadas) ELSE 0 END',
      'THEN coalesce(nullif(p.horas_hombre_lote, 0), p.horas_horno_lote, 0) * coalesce(v_hora, 0) / coalesce(p.unidades_lote, r.unidades_esperadas) ELSE 0 END');
    IF position('nullif(p.horas_hombre_lote, 0), p.horas_horno_lote' IN def) = 0 THEN
      RAISE EXCEPTION 'No se pudo aplicar la mano de obra por horneado al motor de costos';
    END IF;
    EXECUTE def;
  END IF;
END $$;

SELECT core.recalcular_costos();
