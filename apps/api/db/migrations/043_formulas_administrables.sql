-- =====================================================================
--  043 · Fórmulas administrables (decisión del dueño, 4-nov-2026)
--
--  1. Merma: rige el PDF del dueño (§5.2): «Costo con merma = Costo de insumos × (1 + % de merma)».
--     Costo de insumos = costo del lote ÷ unidades teóricas (sin merma). El parámetro formula_merma
--     permite volver a la del Excel (RN-07: ÷ (1 − merma)) sin tocar código.
--     Las unidades esperadas por lote (planificación de producción, RN-07) no cambian.
--  2. Base de prorrateo del CIF (cif_base_prorrateo): antes el motor la ignoraba. Ahora:
--     UNIDADES      → cada concepto por su base (horas de horno, kg de masa o unidades) — Excel RN-13/14;
--     COSTO_INSUMOS → el CIF del mes en proporción al costo de insumos de cada pan — PDF §5.2.
--  3. Costo del insumo al verificar una compra (informe de compras RN-14, «por confirmar»):
--     metodo_costo_insumo = PROMEDIO (ponderado, por defecto) o ULTIMO (último costo de compra).
-- =====================================================================

INSERT INTO core.parametro (clave, valor, tipo, descripcion) VALUES
  ('formula_merma', 'MULTIPLICAR', 'texto', 'Costo con merma: MULTIPLICAR = insumos × (1 + merma) (PDF del dueño) · DIVIDIR = insumos ÷ (1 − merma) (Excel RN-07)'),
  ('metodo_costo_insumo', 'PROMEDIO', 'texto', 'Costo del insumo al verificar una compra: PROMEDIO (ponderado) o ULTIMO (último costo de compra)')
ON CONFLICT (clave) DO NOTHING;
UPDATE core.parametro SET descripcion = 'Reparto del CIF: UNIDADES = cada concepto por su base (horas de horno, kg de masa o unidades) · COSTO_INSUMOS = en proporción al costo de insumos'
WHERE clave = 'cif_base_prorrateo';

DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('core.recalcular_costos_base()'::regprocedure);
  IF position('v_formula' IN def) = 0 THEN
    def := replace(def, '  v_hora numeric;  v_n integer;',
'  v_hora numeric;  v_n integer;
  v_formula text := coalesce((SELECT upper(valor) FROM core.parametro WHERE clave = ''formula_merma''), ''MULTIPLICAR'');
  v_base_cif text := coalesce((SELECT upper(valor) FROM core.parametro WHERE clave = ''cif_base_prorrateo''), ''UNIDADES'');
  v_costo_act numeric;');

    def := replace(def,
'    costo_insumos   = CASE WHEN unidades_esperadas > 0 THEN costo_lote / unidades_esperadas ELSE 0 END,
    costo_con_merma = CASE WHEN unidades_esperadas > 0 THEN costo_lote / unidades_esperadas ELSE 0 END;',
'    -- Costo de insumos por unidad SIN merma (lote ÷ unidades teóricas); la merma se aplica según formula_merma.
    costo_insumos   = CASE WHEN unidades_teoricas > 0 THEN costo_lote / unidades_teoricas ELSE 0 END,
    costo_con_merma = CASE WHEN unidades_teoricas > 0 THEN costo_lote / unidades_teoricas
                             * CASE WHEN v_formula = ''DIVIDIR'' THEN 1 / nullif(1 - merma_estandar, 0) ELSE 1 + merma_estandar END
                           ELSE 0 END;');

    def := replace(def,
'      THEN (p.horas_horno_lote * t_h + r.masa_lote_kg * t_k) / r.unidades_esperadas + t_u ELSE t_u END
  FROM core.producto p WHERE p.id = r.producto_id;',
'      THEN (p.horas_horno_lote * t_h + r.masa_lote_kg * t_k) / r.unidades_esperadas + t_u ELSE t_u END
  FROM core.producto p WHERE p.id = r.producto_id;
  -- Base COSTO_INSUMOS: CIF del mes × (costo de insumos del pan ÷ costo de insumos de toda la actividad).
  IF v_base_cif = ''COSTO_INSUMOS'' THEN
    SELECT coalesce(sum(a.u * r.costo_con_merma), 0) INTO v_costo_act
    FROM _act a JOIN core.receta r ON r.producto_id = a.producto_id AND r.estado = ''VIGENTE'';
    UPDATE core.receta r SET cif_unitario = CASE WHEN v_costo_act > 0
        THEN r.costo_con_merma * (v_cif_h + v_cif_k + v_cif_u) / v_costo_act ELSE 0 END;
  END IF;');

    IF position('v_formula = ''DIVIDIR''' IN def) = 0 OR position('v_base_cif = ''COSTO_INSUMOS''' IN def) = 0
       OR position('v_costo_act numeric' IN def) = 0 THEN
      RAISE EXCEPTION 'No se pudieron aplicar las fórmulas administrables al motor de costos';
    END IF;
    EXECUTE def;
  END IF;
END $$;

SELECT core.recalcular_costos();
