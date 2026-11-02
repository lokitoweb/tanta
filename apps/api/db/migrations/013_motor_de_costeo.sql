-- =====================================================================
--  013 · Motor de costeo real (PDF §5.1–5.2)
--  Antes: costo de receta y de producto eran números fijos de la semilla;
--  comprar harina más cara o subir el gas no cambiaba ningún margen.
--  Ahora: costo = Σ(insumo × CPP) ÷ rendimiento × (1 + merma) + CIF/unidad,
--  recalculado en la base tras cada compra, cambio de receta o de CIF.
-- =====================================================================

-- Costos indirectos de fabricación por concepto (alquiler, gas, energía…)
CREATE TABLE IF NOT EXISTS core.costo_indirecto (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concepto      text NOT NULL CHECK (length(trim(concepto)) BETWEEN 2 AND 80),
  tipo          text NOT NULL DEFAULT 'FIJO' CHECK (tipo IN ('FIJO','VARIABLE')),
  monto_mensual numeric(16,4) NOT NULL CHECK (monto_mensual >= 0),
  activo        boolean NOT NULL DEFAULT true,
  creado_en     timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cif_concepto ON core.costo_indirecto (lower(concepto)) WHERE activo;

INSERT INTO core.parametro (clave, valor, tipo, descripcion) VALUES
  ('cif_base_prorrateo', 'UNIDADES', 'texto', 'Base de prorrateo del CIF: UNIDADES o COSTO_INSUMOS')
ON CONFLICT (clave) DO NOTHING;

-- Producción real (G-13) y canal de la venta (G-05)
ALTER TABLE core.orden_produccion ADD COLUMN IF NOT EXISTS cantidad_producida numeric(18,6);
ALTER TABLE core.venta ADD COLUMN IF NOT EXISTS canal text NOT NULL DEFAULT 'TERCEROS';
DO $$ BEGIN
  ALTER TABLE core.venta ADD CONSTRAINT ck_venta_canal CHECK (canal IN ('APP','TERCEROS'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE core.venta ADD COLUMN IF NOT EXISTS vendedor_id uuid REFERENCES core.usuario(id);
CREATE INDEX IF NOT EXISTS ix_venta_creado ON core.venta (creado_en DESC) WHERE estado = 'CONFIRMADA';

-- Clientes administrables
ALTER TABLE core.cliente
  ADD COLUMN IF NOT EXISTS email     text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS direccion text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS estado    text NOT NULL DEFAULT 'ACTIVO';
DO $$ BEGIN
  ALTER TABLE core.cliente ADD CONSTRAINT ck_cliente_estado CHECK (estado IN ('ACTIVO','INACTIVO'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Insumos y categorías con estado (se desactivan, no se borran: el kárdex los referencia)
ALTER TABLE core.insumo ADD COLUMN IF NOT EXISTS activo boolean NOT NULL DEFAULT true;

INSERT INTO core.permiso (id, grupo, descripcion) VALUES
  ('clientes.gestionar', 'Ventas', 'Crear y editar clientes, crédito y lista de precios'),
  ('auditoria.ver',      'Seguridad', 'Consultar la bitácora de auditoría')
ON CONFLICT (id) DO NOTHING;
INSERT INTO core.rol_permiso (rol_id, permiso_id)
SELECT v.r, v.p FROM (VALUES ('ADMINISTRADOR','clientes.gestionar'), ('GERENTE','auditoria.ver'), ('ADMINISTRADOR','auditoria.ver')) v(r,p)
WHERE EXISTS (SELECT 1 FROM core.rol WHERE id = v.r)
ON CONFLICT DO NOTHING;
INSERT INTO core.navegacion (id, grupo, etiqueta, ruta, icono, permiso_id, orden, grupo_orden) VALUES
  ('n-clientes',  'Maestros', 'Clientes',           '/maestros/clientes', 'user',     'clientes.gestionar', 4, 3),
  ('n-cif',       'Maestros', 'Costos indirectos',  '/maestros/cif',      'wallet',   'maestros.editar',    5, 3),
  ('n-auditoria', 'Sistema',  'Auditoría',          '/sistema/auditoria', 'ledger',   'auditoria.ver',      3, 9)
ON CONFLICT (id) DO NOTHING;
UPDATE core.navegacion SET orden = 6 WHERE id = 'n-usuarios';
UPDATE core.navegacion SET orden = 7 WHERE id = 'n-parametros';

-- ---------------------------------------------------------------- motor
-- Devuelve cuántos productos se recostearon. Idempotente y transaccional.
CREATE OR REPLACE FUNCTION core.recalcular_costos() RETURNS integer AS $$
DECLARE
  v_cif      numeric;
  v_base     text;
  v_unidades numeric;
  v_peso     numeric;
  v_n        integer;
BEGIN
  -- 1) Costo de insumos por unidad y con merma (CPP vigente de cada insumo)
  UPDATE core.receta_detalle d SET cpp = i.cpp, costo = d.cantidad * i.cpp
  FROM core.insumo i WHERE i.id = d.insumo_id;

  UPDATE core.receta r SET
    costo_insumos   = x.total / r.rendimiento,
    costo_con_merma = x.total / r.rendimiento * (1 + r.merma_estandar)
  FROM (SELECT receta_id, coalesce(sum(costo), 0) AS total FROM core.receta_detalle GROUP BY receta_id) x
  WHERE x.receta_id = r.id;

  -- 2) CIF mensual y unidades del mes (producción real de 30 días; si no hay, ventas)
  SELECT coalesce(sum(monto_mensual), 0) INTO v_cif FROM core.costo_indirecto WHERE activo;
  SELECT coalesce((SELECT valor FROM core.parametro WHERE clave = 'cif_base_prorrateo'), 'UNIDADES') INTO v_base;

  CREATE TEMP TABLE IF NOT EXISTS _unid (producto_id uuid PRIMARY KEY, u numeric) ON COMMIT DROP;
  TRUNCATE _unid;
  INSERT INTO _unid
  -- Unidades del mes: lo producido o lo vendido, lo que sea mayor (la producción no siempre se registra completa).
  SELECT p.id, greatest(coalesce(op.u, 0), coalesce(vd.u, 0), 0)
  FROM core.producto p
  LEFT JOIN (SELECT producto_id, sum(coalesce(cantidad_producida, cantidad)) u
             FROM core.orden_produccion WHERE estado = 'TERMINADA' AND terminada_en >= now() - interval '30 days'
             GROUP BY producto_id) op ON op.producto_id = p.id
  LEFT JOIN (SELECT d.producto_id, sum(d.cantidad) u FROM core.venta_detalle d JOIN core.venta v ON v.id = d.venta_id
             WHERE v.estado = 'CONFIRMADA' AND v.creado_en >= now() - interval '30 days' GROUP BY d.producto_id) vd ON vd.producto_id = p.id
  WHERE p.estado = 'ACTIVO';

  SELECT coalesce(sum(u), 0) INTO v_unidades FROM _unid;

  IF v_base = 'COSTO_INSUMOS' THEN
    -- Cada producto absorbe CIF en proporción a su costo de insumos
    SELECT coalesce(sum(r.costo_con_merma * un.u), 0) INTO v_peso
    FROM core.receta r JOIN _unid un ON un.producto_id = r.producto_id;
    UPDATE core.receta r SET cif_unitario = CASE WHEN v_peso > 0 THEN v_cif * r.costo_con_merma / v_peso ELSE 0 END;
  ELSE
    UPDATE core.receta SET cif_unitario = CASE WHEN v_unidades > 0 THEN v_cif / v_unidades ELSE 0 END;
  END IF;

  -- 3) Costo total unitario del producto (lo que la venta congela en cada línea)
  UPDATE core.producto p SET costo_unitario = r.costo_con_merma + r.cif_unitario
  FROM core.receta r WHERE r.producto_id = p.id AND r.estado = 'VIGENTE';
  GET DIAGNOSTICS v_n = ROW_COUNT;

  UPDATE core.periodo_costos SET cif_total = v_cif WHERE estado <> 'CERRADO'
    AND (anio, mes) = (extract(year FROM now())::int, extract(month FROM now())::int);
  RETURN v_n;
END $$ LANGUAGE plpgsql;

-- Instalaciones existentes: el CIF que había quedado como un solo número pasa a ser un
-- concepto editable, para que el primer recálculo no deje los costos sin CIF.
INSERT INTO core.costo_indirecto (concepto, tipo, monto_mensual)
SELECT 'CIF consolidado (migrado)', 'FIJO', p.cif_total
FROM core.periodo_costos p
WHERE p.cif_total > 0 AND NOT EXISTS (SELECT 1 FROM core.costo_indirecto)
ORDER BY p.anio DESC, p.mes DESC LIMIT 1;
