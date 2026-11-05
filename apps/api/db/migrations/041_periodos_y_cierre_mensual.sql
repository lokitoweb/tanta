-- =====================================================================
--  041 · Períodos de costo automáticos y cierre mensual real (COS-09 / RN-38)
--
--  Antes: solo la semilla creaba los períodos (2026-10 y 2026-11). Desde diciembre el
--  motor no tenía dónde guardar las tarifas y las OP cerraban con mano de obra y CIF en 0.
--  Ahora:
--   · el motor crea el período del mes en curso cada vez que corre (y el API lo corre cada hora);
--   · durante el mes el CIF es ESTIMADO: promedio del CIF real de los últimos 3 meses cerrados
--     (si aún no hay cierres, el monto mensual registrado);
--   · al cerrar, core.cerrar_periodo() calcula las tarifas REALES con el CIF registrado y la
--     actividad realmente producida en ese mes calendario, y las deja guardadas.
--  El cierre no modifica ventas ya registradas (su costo quedó congelado al vender).
-- =====================================================================

ALTER TABLE core.periodo_costos
  ADD COLUMN IF NOT EXISTS cif_horno      numeric(16,4),
  ADD COLUMN IF NOT EXISTS cif_kg         numeric(16,4),
  ADD COLUMN IF NOT EXISTS cif_unidad     numeric(16,4),
  ADD COLUMN IF NOT EXISTS cif_estimado   numeric(16,4),
  ADD COLUMN IF NOT EXISTS tarifas_estimadas jsonb,
  ADD COLUMN IF NOT EXISTS ventas_netas   numeric(16,4),
  ADD COLUMN IF NOT EXISTS costo_ventas   numeric(16,4),
  ADD COLUMN IF NOT EXISTS cerrado_por    uuid REFERENCES core.usuario(id);

-- --------------------------------------------- motor: período del mes + CIF estimado
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('core.recalcular_costos_base()'::regprocedure);
  IF position('e_n integer' IN def) = 0 THEN
    def := replace(def, 't_h numeric;     t_k numeric;     t_u numeric;',
                        't_h numeric;     t_k numeric;     t_u numeric;
  e_h numeric;     e_k numeric;     e_u numeric;     e_n integer;');
    -- RN-38: durante el mes, CIF estimado = promedio del CIF real de los últimos 3 meses cerrados.
    def := replace(def, '  -- Actividad del mes desde la producción real (H-13); si no hay, desde lo vendido.',
'  SELECT avg(cif_horno), avg(cif_kg), avg(cif_unidad), count(*) INTO e_h, e_k, e_u, e_n
  FROM (SELECT cif_horno, cif_kg, cif_unidad FROM core.periodo_costos
        WHERE estado = ''CERRADO'' AND cif_horno IS NOT NULL ORDER BY anio DESC, mes DESC LIMIT 3) x;
  IF e_n > 0 THEN v_cif_h := e_h; v_cif_k := e_k; v_cif_u := e_u; END IF;

  -- Actividad del mes desde la producción real (H-13); si no hay, desde lo vendido.');
    -- El período del mes en curso siempre existe (zona horaria del negocio).
    def := replace(def, '  -- Período abierto: CIF del mes, hora hombre, actividad y tarifas vigentes (W31).',
'  INSERT INTO core.periodo_costos (anio, mes)
  VALUES (extract(year FROM now() AT TIME ZONE ''America/Lima'')::int, extract(month FROM now() AT TIME ZONE ''America/Lima'')::int)
  ON CONFLICT (anio, mes) DO NOTHING;
  -- Período abierto: CIF del mes, hora hombre, actividad y tarifas vigentes (W31).');
    def := replace(def,
      'WHERE estado <> ''CERRADO'' AND (anio, mes) = (extract(year FROM now())::int, extract(month FROM now())::int);',
      'WHERE estado <> ''CERRADO'' AND (anio, mes) = (extract(year FROM now() AT TIME ZONE ''America/Lima'')::int, extract(month FROM now() AT TIME ZONE ''America/Lima'')::int);');
    IF position('e_n integer' IN def) = 0 OR position('ON CONFLICT (anio, mes) DO NOTHING' IN def) = 0
       OR position('AND cif_horno IS NOT NULL' IN def) = 0 OR position('''America/Lima'')::int);' IN def) = 0 THEN
      RAISE EXCEPTION 'No se pudo aplicar el período automático al motor de costos';
    END IF;
    EXECUTE def;
  END IF;
END $$;

-- ------------------------------------------------------------ cierre mensual
-- Tarifas reales del mes = CIF registrado por base ÷ actividad producida en el mes calendario.
-- Si una base no tuvo actividad, su CIF pasa a unidades (igual que el motor): no se pierde costo.
CREATE OR REPLACE FUNCTION core.cerrar_periodo(p_id uuid, p_usuario uuid) RETURNS core.periodo_costos AS $$
DECLARE
  p core.periodo_costos;
  desde timestamptz; hasta timestamptz;
  c_h numeric; c_k numeric; c_u numeric;
  a_h numeric; a_k numeric; a_u numeric;
  t_h numeric; t_k numeric; t_u numeric;
  v_netas numeric; v_costo numeric;
BEGIN
  SELECT * INTO p FROM core.periodo_costos WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PERIODO_NO_EXISTE' USING ERRCODE = 'P0002'; END IF;
  IF p.estado = 'CERRADO' THEN RAISE EXCEPTION 'PERIODO_YA_CERRADO' USING ERRCODE = 'P0001'; END IF;
  -- Se cierra en orden: no puede quedar un mes anterior abierto detrás de uno cerrado.
  IF EXISTS (SELECT 1 FROM core.periodo_costos WHERE estado <> 'CERRADO' AND (anio, mes) < (p.anio, p.mes)) THEN
    RAISE EXCEPTION 'PERIODO_ANTERIOR_ABIERTO' USING ERRCODE = 'P0001';
  END IF;

  desde := make_date(p.anio, p.mes, 1)::timestamp AT TIME ZONE 'America/Lima';
  hasta := (make_date(p.anio, p.mes, 1) + interval '1 month')::timestamp AT TIME ZONE 'America/Lima';

  SELECT coalesce(sum(monto_mensual) FILTER (WHERE base_reparto = 'HORAS_HORNO'), 0),
         coalesce(sum(monto_mensual) FILTER (WHERE base_reparto = 'KG_MASA'), 0),
         coalesce(sum(monto_mensual) FILTER (WHERE base_reparto = 'UNIDADES'), 0)
    INTO c_h, c_k, c_u
  FROM core.costo_indirecto WHERE activo AND categoria = 'CIF';

  -- Actividad real: OP terminadas en el mes (horas de horno reales si se registraron).
  SELECT coalesce(sum(coalesce(o.horas_horno_real, coalesce(o.cantidad_producida, o.cantidad) / nullif(r.unidades_esperadas, 0) * pr.horas_horno_lote)), 0),
         coalesce(sum(coalesce(o.masa_kg, coalesce(o.cantidad_producida, o.cantidad) / nullif(r.unidades_esperadas, 0) * r.masa_lote_kg)), 0),
         coalesce(sum(coalesce(o.cantidad_producida, o.cantidad)), 0)
    INTO a_h, a_k, a_u
  FROM core.orden_produccion o
  JOIN core.producto pr ON pr.id = o.producto_id
  LEFT JOIN core.receta r ON r.producto_id = o.producto_id AND r.estado = 'VIGENTE'
  WHERE o.estado = 'TERMINADA' AND o.terminada_en >= desde AND o.terminada_en < hasta;

  t_h := CASE WHEN a_h > 0 THEN c_h / a_h ELSE 0 END;
  t_k := CASE WHEN a_k > 0 THEN c_k / a_k ELSE 0 END;
  t_u := CASE WHEN a_u > 0 THEN (c_u + CASE WHEN a_h > 0 THEN 0 ELSE c_h END + CASE WHEN a_k > 0 THEN 0 ELSE c_k END) / a_u ELSE 0 END;

  SELECT coalesce(sum(ventas_netas), 0), coalesce(sum(costo_ventas), 0) INTO v_netas, v_costo
  FROM core.venta WHERE estado = 'CONFIRMADA' AND creado_en >= desde AND creado_en < hasta;

  UPDATE core.periodo_costos SET
    -- Lo que se usó durante el mes queda como estimado, para comparar con el real (W31).
    cif_estimado = cif_total,
    tarifas_estimadas = jsonb_build_object('horaHorno', tarifa_hora_horno, 'kgMasa', tarifa_kg_masa, 'unidad', tarifa_unidad),
    cif_horno = c_h, cif_kg = c_k, cif_unidad = c_u, cif_total = c_h + c_k + c_u,
    horas_horno_mes = a_h, kg_masa_mes = a_k, unidades_mes = a_u,
    tarifa_hora_horno = t_h, tarifa_kg_masa = t_k, tarifa_unidad = t_u,
    ventas_netas = v_netas, costo_ventas = v_costo,
    estado = 'CERRADO', cerrado_en = now(), cerrado_por = p_usuario
  WHERE id = p_id RETURNING * INTO p;
  RETURN p;
END $$ LANGUAGE plpgsql;

-- Un período cerrado no se modifica (CP-32): ni tarifas ni montos, salvo por una reapertura explícita.
CREATE OR REPLACE FUNCTION core.periodo_cerrado_inmutable() RETURNS trigger AS $$
BEGIN
  IF OLD.estado = 'CERRADO' AND current_setting('tanta.reabrir_periodo', true) IS DISTINCT FROM 'si' THEN
    RAISE EXCEPTION 'PERIODO_CERRADO_INMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS tg_periodo_cerrado_inmutable ON core.periodo_costos;
CREATE TRIGGER tg_periodo_cerrado_inmutable BEFORE UPDATE OR DELETE ON core.periodo_costos
  FOR EACH ROW EXECUTE FUNCTION core.periodo_cerrado_inmutable();

-- El mes en curso existe desde ya (si el despliegue cae en un mes nuevo).
SELECT core.recalcular_costos();

-- COB-10: alertas de cuentas por cobrar vencidas (el día del vencimiento y cada 7 días mientras haya saldo).
ALTER TABLE core.cuenta_por_cobrar ADD COLUMN IF NOT EXISTS alerta_en date;
CREATE INDEX IF NOT EXISTS ix_cxc_alerta ON core.cuenta_por_cobrar (vence_en) WHERE estado IN ('PENDIENTE','PARCIAL');
