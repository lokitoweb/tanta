-- =====================================================================
--  024 · Motor de costos del modelo analisis.xlsx (INF-TEC-001, RN-01 a RN-17)
--  Corrige los hallazgos H-01 a H-05, H-07, H-09 y H-13: todo se calcula desde
--  los datos (nada escrito a mano), la mano de obra usa las horas de cada pan,
--  el % panadero divide entre todas las harinas y el CIF se reparte en 3 bases.
--  Aditiva y compatible: sin los datos nuevos, el resultado es el de antes.
-- =====================================================================

-- Producto (hoja 'pan' A:Q, V): peso, pérdidas y tiempos por lote.
ALTER TABLE core.producto
  ADD COLUMN IF NOT EXISTS peso_masa_g       numeric(10,3) CHECK (peso_masa_g IS NULL OR peso_masa_g > 0),
  ADD COLUMN IF NOT EXISTS perdida_coccion   numeric(9,6) NOT NULL DEFAULT 0 CHECK (perdida_coccion >= 0 AND perdida_coccion < 1),
  ADD COLUMN IF NOT EXISTS horas_hombre_lote numeric(8,3) NOT NULL DEFAULT 0 CHECK (horas_hombre_lote >= 0),
  ADD COLUMN IF NOT EXISTS horas_horno_lote  numeric(8,3) NOT NULL DEFAULT 0 CHECK (horas_horno_lote >= 0);

-- Insumo (hoja 'insumos' A:L): tipo, presentación de compra y equivalente en kg.
ALTER TABLE core.insumo
  ADD COLUMN IF NOT EXISTS tipo              text NOT NULL DEFAULT 'OTRO',
  ADD COLUMN IF NOT EXISTS presentacion      text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS precio_compra     numeric(14,4) CHECK (precio_compra IS NULL OR precio_compra >= 0),
  ADD COLUMN IF NOT EXISTS cant_presentacion numeric(14,4) CHECK (cant_presentacion IS NULL OR cant_presentacion > 0),
  ADD COLUMN IF NOT EXISTS equiv_kg          numeric(10,6) NOT NULL DEFAULT 1 CHECK (equiv_kg > 0);
DO $$ BEGIN
  ALTER TABLE core.insumo ADD CONSTRAINT ck_insumo_tipo CHECK (tipo IN ('HARINA','GRASA','LACTEO','AZUCAR','LEVADURA','HUEVO','RELLENO','ADITIVO','LIQUIDO','OTRO'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Los nombres que ya dicen "harina" se marcan como harina (necesario para el % panadero).
UPDATE core.insumo SET tipo = 'HARINA' WHERE tipo = 'OTRO' AND nombre ILIKE 'harina%';
-- Los líquidos en litros pesan casi lo mismo que el agua; el aceite se corrige en el maestro.
UPDATE core.insumo SET equiv_kg = 1 WHERE equiv_kg IS NULL;

-- Conversión de unidades de receta a unidad base (MAE-07, RN-03).
CREATE TABLE IF NOT EXISTS core.unidad_conversion (
  unidad_receta text PRIMARY KEY,
  unidad_base   text NOT NULL,
  factor        numeric(12,6) NOT NULL CHECK (factor > 0)
);
INSERT INTO core.unidad_conversion VALUES
  ('GR','KG',0.001), ('KG','KG',1), ('ML','L',0.001), ('L','L',1), ('UNID','UNID',1), ('UNIDAD','UNIDAD',1)
ON CONFLICT (unidad_receta) DO NOTHING;

-- Línea de receta: cómo se registró, su peso y su % panadero (RN-03, RN-04).
ALTER TABLE core.receta_detalle
  ADD COLUMN IF NOT EXISTS unidad_receta     text,
  ADD COLUMN IF NOT EXISTS cantidad_original numeric(18,6),
  ADD COLUMN IF NOT EXISTS peso_kg           numeric(18,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pct_panadero      numeric(12,6);

-- Receta: resultados del lote (RN-05 a RN-15), todos calculados por el motor.
ALTER TABLE core.receta
  ADD COLUMN IF NOT EXISTS masa_lote_kg       numeric(18,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unidades_teoricas  numeric(18,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unidades_esperadas numeric(18,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS peso_final_g       numeric(10,3),
  ADD COLUMN IF NOT EXISTS costo_lote         numeric(18,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mo_unitario        numeric(18,6) NOT NULL DEFAULT 0;

-- Costos indirectos (hoja 'costos indirectos' A:C): categoría y base de reparto (MAE-11).
ALTER TABLE core.costo_indirecto
  ADD COLUMN IF NOT EXISTS categoria    text NOT NULL DEFAULT 'CIF',
  ADD COLUMN IF NOT EXISTS base_reparto text NOT NULL DEFAULT 'UNIDADES';
DO $$ BEGIN
  ALTER TABLE core.costo_indirecto ADD CONSTRAINT ck_cif_categoria CHECK (categoria IN ('CIF','GASTO'));
  ALTER TABLE core.costo_indirecto ADD CONSTRAINT ck_cif_base CHECK (base_reparto IN ('HORAS_HORNO','KG_MASA','UNIDADES'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Tarifas aplicadas en el período (COS-03, COS-09): quedan guardadas al cerrar el mes.
ALTER TABLE core.periodo_costos
  ADD COLUMN IF NOT EXISTS costo_hora_hombre numeric(14,6),
  ADD COLUMN IF NOT EXISTS tarifa_hora_horno numeric(14,6),
  ADD COLUMN IF NOT EXISTS tarifa_kg_masa    numeric(14,6),
  ADD COLUMN IF NOT EXISTS tarifa_unidad     numeric(14,6),
  ADD COLUMN IF NOT EXISTS horas_horno_mes   numeric(14,3),
  ADD COLUMN IF NOT EXISTS kg_masa_mes       numeric(16,3),
  ADD COLUMN IF NOT EXISTS unidades_mes      numeric(18,3);

-- Parámetros de mano de obra (MAE-12, MAE-13, RN-11).
INSERT INTO core.parametro (clave, valor, tipo, descripcion) VALUES
  ('sueldo_base',        '1500', 'numero',     'Sueldo mensual de referencia del personal de producción (S/)'),
  ('factor_beneficios',  '0',    'porcentaje', 'Beneficios y aportes sobre el sueldo (0.45 = 45 %)'),
  ('horas_mes',          '192',  'numero',     'Horas trabajadas al mes por persona'),
  ('tolerancia_varianza','0.03', 'porcentaje', 'Tolerancia del consumo real frente al teórico')
ON CONFLICT (clave) DO NOTHING;

-- ------------------------------------------------------------------ motor
CREATE OR REPLACE FUNCTION core.recalcular_costos_base() RETURNS integer AS $$
DECLARE
  v_hora numeric;  v_n integer;
  v_cif_h numeric; v_cif_k numeric; v_cif_u numeric;
  v_h numeric;     v_k numeric;     v_u numeric;
  t_h numeric;     t_k numeric;     t_u numeric;
BEGIN
  -- RN-09 / RN-03: costo y peso de cada línea (la cantidad ya está en unidad base).
  UPDATE core.receta_detalle d SET cpp = i.cpp, costo = d.cantidad * i.cpp, peso_kg = d.cantidad * i.equiv_kg
  FROM core.insumo i WHERE i.id = d.insumo_id;

  -- RN-05: masa del lote · RN-04: % panadero sobre TODAS las harinas (H-09).
  UPDATE core.receta r SET masa_lote_kg = x.masa, costo_lote = x.costo
  FROM (SELECT receta_id, coalesce(sum(peso_kg), 0) masa, coalesce(sum(costo), 0) costo FROM core.receta_detalle GROUP BY receta_id) x
  WHERE x.receta_id = r.id;
  UPDATE core.receta_detalle d SET pct_panadero = CASE WHEN h.harina > 0 THEN d.peso_kg / h.harina END
  FROM (SELECT d2.receta_id, sum(d2.peso_kg) harina FROM core.receta_detalle d2 JOIN core.insumo i ON i.id = d2.insumo_id
        WHERE i.tipo = 'HARINA' GROUP BY d2.receta_id) h
  WHERE h.receta_id = d.receta_id;

  -- RN-06 / RN-07 / RN-08: unidades teóricas y esperadas por lote.
  -- Sin peso de masa registrado se usa el rendimiento declarado (comportamiento anterior).
  UPDATE core.receta r SET
    unidades_teoricas  = CASE WHEN p.peso_masa_g > 0 THEN r.masa_lote_kg * 1000 / p.peso_masa_g ELSE r.rendimiento END,
    unidades_esperadas = CASE WHEN p.peso_masa_g > 0 THEN r.masa_lote_kg * 1000 / p.peso_masa_g * (1 - r.merma_estandar)
                              ELSE r.rendimiento / (1 + r.merma_estandar) END,
    peso_final_g       = CASE WHEN p.peso_masa_g > 0 THEN p.peso_masa_g * (1 - p.perdida_coccion) END
  FROM core.producto p WHERE p.id = r.producto_id;

  -- RN-10: costo de insumos por unidad esperada (columna costo_con_merma, que usan los reportes).
  UPDATE core.receta SET
    costo_insumos   = CASE WHEN unidades_esperadas > 0 THEN costo_lote / unidades_esperadas ELSE 0 END,
    costo_con_merma = CASE WHEN unidades_esperadas > 0 THEN costo_lote / unidades_esperadas ELSE 0 END;

  -- RN-11 / RN-12: hora hombre con beneficios (H-04) y horas propias de cada pan (H-03).
  SELECT (coalesce((SELECT valor FROM core.parametro WHERE clave = 'sueldo_base'), '0')::numeric
          * (1 + coalesce((SELECT valor FROM core.parametro WHERE clave = 'factor_beneficios'), '0')::numeric))
         / nullif(coalesce((SELECT valor FROM core.parametro WHERE clave = 'horas_mes'), '0')::numeric, 0)
    INTO v_hora;
  UPDATE core.receta r SET mo_unitario = CASE WHEN r.unidades_esperadas > 0
      THEN p.horas_hombre_lote * coalesce(v_hora, 0) / r.unidades_esperadas ELSE 0 END
  FROM core.producto p WHERE p.id = r.producto_id;

  -- RN-13: CIF del mes por base (H-01/H-02: siempre la suma de todos los conceptos CIF).
  SELECT coalesce(sum(monto_mensual) FILTER (WHERE base_reparto = 'HORAS_HORNO'), 0),
         coalesce(sum(monto_mensual) FILTER (WHERE base_reparto = 'KG_MASA'), 0),
         coalesce(sum(monto_mensual) FILTER (WHERE base_reparto = 'UNIDADES'), 0)
    INTO v_cif_h, v_cif_k, v_cif_u
  FROM core.costo_indirecto WHERE activo AND categoria = 'CIF';

  -- Actividad del mes desde la producción real (H-13); si no hay, desde lo vendido.
  CREATE TEMP TABLE IF NOT EXISTS _act (producto_id uuid PRIMARY KEY, u numeric) ON COMMIT DROP;
  TRUNCATE _act;
  INSERT INTO _act
  SELECT p.id, greatest(coalesce(op.u, 0), coalesce(vd.u, 0))
  FROM core.producto p
  LEFT JOIN (SELECT producto_id, sum(coalesce(cantidad_producida, cantidad)) u FROM core.orden_produccion
             WHERE estado = 'TERMINADA' AND terminada_en >= now() - interval '30 days' GROUP BY producto_id) op ON op.producto_id = p.id
  LEFT JOIN (SELECT d.producto_id, sum(d.cantidad) u FROM core.venta_detalle d JOIN core.venta v ON v.id = d.venta_id
             WHERE v.estado = 'CONFIRMADA' AND v.creado_en >= now() - interval '30 days' GROUP BY d.producto_id) vd ON vd.producto_id = p.id
  WHERE p.estado = 'ACTIVO';

  -- Lotes del mes = unidades ÷ unidades esperadas por lote.
  SELECT coalesce(sum(a.u / nullif(r.unidades_esperadas, 0) * p.horas_horno_lote), 0),
         coalesce(sum(a.u / nullif(r.unidades_esperadas, 0) * r.masa_lote_kg), 0),
         coalesce(sum(a.u), 0)
    INTO v_h, v_k, v_u
  FROM _act a JOIN core.receta r ON r.producto_id = a.producto_id AND r.estado = 'VIGENTE'
  JOIN core.producto p ON p.id = a.producto_id;

  -- Tarifas por base. Si una base no tiene actividad (p. ej. aún no se registran horas de horno),
  -- su CIF pasa a la base unidades para no perderlo del costo.
  t_h := CASE WHEN v_h > 0 THEN v_cif_h / v_h ELSE 0 END;
  t_k := CASE WHEN v_k > 0 THEN v_cif_k / v_k ELSE 0 END;
  t_u := CASE WHEN v_u > 0 THEN (v_cif_u + CASE WHEN v_h > 0 THEN 0 ELSE v_cif_h END + CASE WHEN v_k > 0 THEN 0 ELSE v_cif_k END) / v_u ELSE 0 END;

  -- RN-14: CIF por pan = (horas de horno × tarifa + kg de masa × tarifa) ÷ unidades + tarifa por pan.
  UPDATE core.receta r SET cif_unitario = CASE WHEN r.unidades_esperadas > 0
      THEN (p.horas_horno_lote * t_h + r.masa_lote_kg * t_k) / r.unidades_esperadas + t_u ELSE t_u END
  FROM core.producto p WHERE p.id = r.producto_id;

  -- RN-15: costo total por unidad = insumos + mano de obra + CIF (lo que congela cada venta).
  UPDATE core.producto p SET costo_unitario = r.costo_con_merma + r.mo_unitario + r.cif_unitario, merma_pct = r.merma_estandar
  FROM core.receta r WHERE r.producto_id = p.id AND r.estado = 'VIGENTE';
  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- Período abierto: CIF del mes, hora hombre, actividad y tarifas vigentes (W31).
  UPDATE core.periodo_costos SET cif_total = v_cif_h + v_cif_k + v_cif_u, costo_hora_hombre = v_hora,
    tarifa_hora_horno = t_h, tarifa_kg_masa = t_k, tarifa_unidad = t_u, horas_horno_mes = v_h, kg_masa_mes = v_k, unidades_mes = v_u
  WHERE estado <> 'CERRADO' AND (anio, mes) = (extract(year FROM now())::int, extract(month FROM now())::int);
  RETURN v_n;
END $$ LANGUAGE plpgsql;

SELECT core.recalcular_costos();
