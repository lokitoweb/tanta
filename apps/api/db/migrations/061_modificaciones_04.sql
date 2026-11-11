-- =====================================================================
--  061 · Modificaciones del cliente 04 (Word + Excel BASE_DATOS-TANTA)
--  1. «Debería haber un estado para considerar o no en la suma del peso»: tipo_insumo.suma_peso (Catálogos → Tipos de
--     insumo). Antes dependía de «es empaque», que solo dice si Despacho puede usarlo.
--  2. CIF como en la hoja «COSTO INDIRECTO»: tarifa por hora de horno = costos del mes ÷ (horas diarias de horno ×
--     días trabajados). Con ambos parámetros en 0 se sigue usando la actividad real de los últimos 30 días.
--  3. «Costo promedio ponderado… en el kárdex valorizado y el costo de la receta»: las fórmulas siguen al kárdex.
--  4. Iniciada la producción de una fecha, los pedidos nuevos de clientes pasan a la siguiente fecha sin hoja.
--  5. Aviso cuando lo producido se aleja de lo solicitado (200 pedidos, 2,080 producidos).
-- =====================================================================
ALTER TABLE core.tipo_insumo ADD COLUMN suma_peso boolean NOT NULL DEFAULT true;
UPDATE core.tipo_insumo SET suma_peso = false WHERE es_empaque;

CREATE OR REPLACE FUNCTION core.peso_unitario_kg(p_insumo uuid) RETURNS numeric AS $$
  SELECT CASE
    WHEN NOT coalesce(t.suma_peso, true) THEN 0
    WHEN u.familia = 'MASA' THEN u.factor_a_patron
    WHEN u.familia = 'VOLUMEN' THEN u.factor_a_patron * i.equiv_kg
    ELSE i.equiv_kg END
  FROM core.insumo i
  JOIN core.unidad_medida u ON u.codigo = i.unidad
  LEFT JOIN core.tipo_insumo t ON t.codigo = i.tipo
  WHERE i.id = p_insumo
$$ LANGUAGE sql STABLE;

INSERT INTO core.parametro (clave, valor, tipo, descripcion) VALUES
  ('horas_horno_dia', '11', 'numero', 'Horas diarias de horno. Con los días trabajados da las horas de horno del mes para la tarifa de costos indirectos (0 = usar la producción real de los últimos 30 días)'),
  ('dias_trabajados_mes', '26', 'numero', 'Días trabajados al mes, para las horas de horno del mes (0 = usar la producción real)'),
  ('tolerancia_produccion', '0.10', 'porcentaje', 'Diferencia entre lo producido y lo solicitado a partir de la cual se pide confirmar antes de grabar la producción (0.10 = 10 %; 0 = no avisar)')
ON CONFLICT (clave) DO NOTHING;

UPDATE core.parametro SET valor = 'AUTOMATICO' WHERE clave = 'costo_insumo_formulas';
UPDATE core.insumo SET costo_formula = NULL WHERE costo_formula IS NOT NULL;

DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('core.recalcular_costos_base()'::regprocedure);
  IF position('horas_horno_dia' IN def) = 0 THEN
    def := replace(def, '  t_h := CASE WHEN v_h > 0',
      '  v_h := coalesce(nullif(coalesce((SELECT valor FROM core.parametro WHERE clave = ''horas_horno_dia''), ''0'')::numeric
                       * coalesce((SELECT valor FROM core.parametro WHERE clave = ''dias_trabajados_mes''), ''0'')::numeric, 0), v_h);
  t_h := CASE WHEN v_h > 0');
    IF position('horas_horno_dia' IN def) = 0 THEN RAISE EXCEPTION 'No se pudo cambiar la tarifa por hora de horno'; END IF;
    EXECUTE def;
  END IF;
END $$;

-- Primera fecha, desde la indicada, cuya producción aún no empezó (sin hoja de producción).
CREATE FUNCTION core.entrega_libre(p_fecha date) RETURNS date AS $$
  SELECT coalesce((SELECT min(d)::date FROM generate_series(p_fecha, p_fecha + 60, interval '1 day') d
                   WHERE NOT EXISTS (SELECT 1 FROM core.hoja_produccion h WHERE h.fecha = d::date)), p_fecha)
$$ LANGUAGE sql STABLE;

SELECT core.recalcular_costos();
