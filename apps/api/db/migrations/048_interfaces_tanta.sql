-- =====================================================================
--  048 · «INTERFACES TANTA» (Excel del dueño, nov-2026)
--
--  · Códigos propios en categoría, almacén, proveedor y costo indirecto (manuales o automáticos).
--  · Presentaciones de COMPRA (saco x 50 kg, botella 900 ml…) y de VENTA (unidad, paquete x 6) como catálogos.
--    La de venta puede descontar sola un insumo de empaque (1 bolsa por paquete) al vender.
--  · Producto: SKU (código de barras) de la presentación unitaria y presentaciones adicionales con su SKU y precio.
--  · Insumo: «maneja stock» y costo para fórmulas actualizado a mano («se sugiere manual»): el motor de costos usa
--    insumo.costo_formula si existe; si no, el costo del kárdex. Parámetro costo_insumo_formulas = MANUAL | AUTOMATICO.
--  · Proveedor: RUC opcional (las notas de pedido no lo traen) y varias cuentas bancarias.
--  · Compra: condición contado/crédito, precios con o sin IGV, documento «Nota de pedido».
--  · Pagos: comprobante (imagen) en pagos a proveedores y pagos de costos (CIF) desde caja grande o chica.
-- =====================================================================

-- ------------------------------------------------------------- códigos
-- Código manual (se guarda en mayúsculas) o, si llega vacío, el siguiente correlativo PREFIJO-NNN.
-- Lo asigna la base: ninguna ruta (API, semilla, importación) puede dejar un registro sin código.
CREATE OR REPLACE FUNCTION core.asignar_codigo() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pref text := TG_ARGV[0]; ancho int := TG_ARGV[1]::int; n int;
BEGIN
  IF NEW.codigo IS NULL OR trim(NEW.codigo) = '' THEN
    -- Serializa la numeración de esta tabla dentro de la transacción (dos altas a la vez no repiten número).
    PERFORM pg_advisory_xact_lock(hashtext('codigo:' || TG_TABLE_NAME));
    EXECUTE format('SELECT coalesce(max(substring(codigo from %s)::int), 0) + 1 FROM %I.%I WHERE codigo ~ %L',
      length(pref) + 1, TG_TABLE_SCHEMA, TG_TABLE_NAME, '^' || pref || '[0-9]+$') INTO n;
    NEW.codigo := pref || lpad(n::text, ancho, '0');
  ELSE
    NEW.codigo := upper(trim(NEW.codigo));
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE core.categoria ADD COLUMN IF NOT EXISTS codigo text;
WITH x AS (SELECT id, row_number() OVER (ORDER BY orden, nombre) n FROM core.categoria WHERE codigo IS NULL)
UPDATE core.categoria c SET codigo = 'CAT-' || lpad((x.n + coalesce((SELECT max(substring(codigo from 5)::int) FROM core.categoria WHERE codigo ~ '^CAT-[0-9]+$'), 0))::text, 2, '0')
FROM x WHERE x.id = c.id;
ALTER TABLE core.categoria ALTER COLUMN codigo SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_categoria_codigo ON core.categoria (upper(codigo));

ALTER TABLE core.almacen ADD COLUMN IF NOT EXISTS codigo text;
WITH x AS (SELECT id, row_number() OVER (ORDER BY tipo, NOT principal, nombre) n FROM core.almacen WHERE codigo IS NULL)
UPDATE core.almacen a SET codigo = 'ALM-' || lpad((x.n + coalesce((SELECT max(substring(codigo from 5)::int) FROM core.almacen WHERE codigo ~ '^ALM-[0-9]+$'), 0))::text, 2, '0')
FROM x WHERE x.id = a.id;
ALTER TABLE core.almacen ALTER COLUMN codigo SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_almacen_codigo ON core.almacen (upper(codigo));

ALTER TABLE core.proveedor ADD COLUMN IF NOT EXISTS codigo text;
WITH x AS (SELECT id, row_number() OVER (ORDER BY creado_en, razon_social) n FROM core.proveedor WHERE codigo IS NULL)
UPDATE core.proveedor p SET codigo = 'PRV-' || lpad((x.n + coalesce((SELECT max(substring(codigo from 5)::int) FROM core.proveedor WHERE codigo ~ '^PRV-[0-9]+$'), 0))::text, 3, '0')
FROM x WHERE x.id = p.id;
ALTER TABLE core.proveedor ALTER COLUMN codigo SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_proveedor_codigo ON core.proveedor (upper(codigo));

-- CIF: código y clasificación del Excel (costo de producción, operativo o de ventas). Solo el de producción entra al pan.
ALTER TABLE core.costo_indirecto ADD COLUMN IF NOT EXISTS codigo text, ADD COLUMN IF NOT EXISTS clasificacion text;
UPDATE core.costo_indirecto SET clasificacion = CASE WHEN categoria = 'CIF' THEN 'PRODUCCION' ELSE 'OPERATIVO' END WHERE clasificacion IS NULL;
WITH x AS (SELECT id, row_number() OVER (ORDER BY concepto) n FROM core.costo_indirecto WHERE codigo IS NULL)
UPDATE core.costo_indirecto k SET codigo = 'CIF-' || lpad((x.n + coalesce((SELECT max(substring(codigo from 5)::int) FROM core.costo_indirecto WHERE codigo ~ '^CIF-[0-9]+$'), 0))::text, 2, '0')
FROM x WHERE x.id = k.id;
ALTER TABLE core.costo_indirecto ALTER COLUMN codigo SET NOT NULL, ALTER COLUMN clasificacion SET NOT NULL, ALTER COLUMN clasificacion SET DEFAULT 'PRODUCCION';
DO $$ BEGIN
  ALTER TABLE core.costo_indirecto ADD CONSTRAINT ck_cif_clasificacion CHECK (clasificacion IN ('PRODUCCION','OPERATIVO','VENTAS'));
  -- La categoría que lee el motor se deriva de la clasificación: no pueden contradecirse.
  ALTER TABLE core.costo_indirecto ADD CONSTRAINT ck_cif_clasificacion_categoria CHECK ((clasificacion = 'PRODUCCION') = (categoria = 'CIF'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS ux_cif_codigo ON core.costo_indirecto (upper(codigo));

DROP TRIGGER IF EXISTS tg_codigo ON core.categoria;
CREATE TRIGGER tg_codigo BEFORE INSERT OR UPDATE OF codigo ON core.categoria FOR EACH ROW EXECUTE FUNCTION core.asignar_codigo('CAT-', '2');
DROP TRIGGER IF EXISTS tg_codigo ON core.almacen;
CREATE TRIGGER tg_codigo BEFORE INSERT OR UPDATE OF codigo ON core.almacen FOR EACH ROW EXECUTE FUNCTION core.asignar_codigo('ALM-', '2');
DROP TRIGGER IF EXISTS tg_codigo ON core.proveedor;
CREATE TRIGGER tg_codigo BEFORE INSERT OR UPDATE OF codigo ON core.proveedor FOR EACH ROW EXECUTE FUNCTION core.asignar_codigo('PRV-', '3');
DROP TRIGGER IF EXISTS tg_codigo ON core.costo_indirecto;
CREATE TRIGGER tg_codigo BEFORE INSERT OR UPDATE OF codigo ON core.costo_indirecto FOR EACH ROW EXECUTE FUNCTION core.asignar_codigo('CIF-', '2');

-- ------------------------------------------------------------- catálogos de presentaciones y bancos
CREATE TABLE IF NOT EXISTS core.presentacion_compra (
  codigo      text PRIMARY KEY CHECK (codigo ~ '^[A-Z0-9][A-Z0-9_-]{1,19}$'),
  nombre      text NOT NULL,
  -- Cuánto trae en la unidad base del insumo (saco x 50 kg = 50; botella 900 ml con base L = 0.9).
  equivalencia numeric(14,6) NOT NULL CHECK (equivalencia > 0),
  activo      boolean NOT NULL DEFAULT true,
  orden       int NOT NULL DEFAULT 0
);
INSERT INTO core.presentacion_compra (codigo, nombre, equivalencia, orden) VALUES
  ('SACO50', 'Saco x 50 kg', 50, 1), ('SACO25', 'Saco x 25 kg', 25, 2), ('BOT900', 'Botella 900 ml', 0.9, 3),
  ('BOT1L', 'Botella 1 L', 1, 4), ('CAJA1L', 'Caja x 1 L', 1, 5), ('PAQ6', 'Paquete x 6 unid', 6, 6),
  ('PAQ12', 'Paquete x 12 unid', 12, 7), ('CELDA30', 'Celda x 30 unid', 30, 8), ('UNIDAD', 'Unidad', 1, 9)
ON CONFLICT (codigo) DO NOTHING;

CREATE TABLE IF NOT EXISTS core.presentacion_venta (
  codigo          text PRIMARY KEY CHECK (codigo ~ '^[A-Z0-9][A-Z0-9_-]{1,19}$'),
  nombre          text NOT NULL,
  -- Unidades del producto que lleva (paquete x 6 = 6): el stock baja equivalencia × cantidad vendida.
  equivalencia    numeric(14,4) NOT NULL CHECK (equivalencia > 0),
  -- Empaque que se descarga solo al vender (bolsa 5 x 10"), por cada presentación vendida.
  insumo_id       uuid REFERENCES core.insumo(id),
  cantidad_insumo numeric(14,6) CHECK (cantidad_insumo IS NULL OR cantidad_insumo > 0),
  activo          boolean NOT NULL DEFAULT true,
  orden           int NOT NULL DEFAULT 0,
  CHECK ((insumo_id IS NULL) = (cantidad_insumo IS NULL))
);
INSERT INTO core.presentacion_venta (codigo, nombre, equivalencia, orden) VALUES
  ('UNID', 'Unidad', 1, 1), ('PAQ6', 'Paquete x 6 unid', 6, 2), ('PAQ12', 'Paquete x 12 unid', 12, 3)
ON CONFLICT (codigo) DO NOTHING;

CREATE TABLE IF NOT EXISTS core.banco (
  codigo text PRIMARY KEY CHECK (codigo ~ '^[A-Z0-9][A-Z0-9_-]{1,19}$'),
  nombre text NOT NULL,
  activo boolean NOT NULL DEFAULT true,
  orden  int NOT NULL DEFAULT 0
);
INSERT INTO core.banco (codigo, nombre, orden) VALUES
  ('BCP', 'Banco de Crédito (BCP)', 1), ('BBVA', 'BBVA', 2), ('INTERBANK', 'Interbank', 3), ('SCOTIABANK', 'Scotiabank', 4),
  ('BN', 'Banco de la Nación', 5), ('BANBIF', 'BanBif', 6), ('PICHINCHA', 'Banco Pichincha', 7), ('OTRO', 'Otro banco o caja', 99)
ON CONFLICT (codigo) DO NOTHING;

-- ------------------------------------------------------------- producto: SKU y presentaciones
ALTER TABLE core.producto ADD COLUMN IF NOT EXISTS sku text;
CREATE UNIQUE INDEX IF NOT EXISTS ux_producto_sku ON core.producto (sku) WHERE sku IS NOT NULL;

CREATE TABLE IF NOT EXISTS core.producto_presentacion (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  producto_id         uuid NOT NULL REFERENCES core.producto(id) ON DELETE CASCADE,
  presentacion_codigo text NOT NULL REFERENCES core.presentacion_venta(codigo),
  sku                 text CHECK (sku IS NULL OR sku ~ '^[A-Za-z0-9-]{3,30}$'),
  precio_con_igv      numeric(14,4) NOT NULL CHECK (precio_con_igv > 0),
  activo              boolean NOT NULL DEFAULT true,
  orden               int NOT NULL DEFAULT 0,
  UNIQUE (producto_id, presentacion_codigo)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_producto_presentacion_sku ON core.producto_presentacion (sku) WHERE sku IS NOT NULL;

-- El pedido y la venta guardan la cantidad en UNIDADES del producto (stock, costos y reportes no cambian)
-- y, aparte, en qué presentación se pidió/vendió.
ALTER TABLE core.pedido_detalle
  ADD COLUMN IF NOT EXISTS presentacion_codigo   text REFERENCES core.presentacion_venta(codigo),
  ADD COLUMN IF NOT EXISTS cantidad_presentacion numeric(14,4);
ALTER TABLE core.venta_detalle
  ADD COLUMN IF NOT EXISTS presentacion_codigo   text REFERENCES core.presentacion_venta(codigo),
  ADD COLUMN IF NOT EXISTS cantidad_presentacion numeric(14,4);

-- ------------------------------------------------------------- insumo
ALTER TABLE core.insumo
  ADD COLUMN IF NOT EXISTS maneja_stock        boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS costo_formula       numeric(18,6) CHECK (costo_formula IS NULL OR costo_formula >= 0),
  ADD COLUMN IF NOT EXISTS costo_formula_en    timestamptz,
  ADD COLUMN IF NOT EXISTS costo_formula_por   uuid REFERENCES core.usuario(id),
  ADD COLUMN IF NOT EXISTS presentacion_codigo text REFERENCES core.presentacion_compra(codigo);
CREATE UNIQUE INDEX IF NOT EXISTS ux_insumo_codigo ON core.insumo (upper(codigo));

-- Historial de cada ajuste manual del costo (quién, cuándo, de cuánto a cuánto).
CREATE TABLE IF NOT EXISTS core.ajuste_costo_insumo (
  id          bigserial PRIMARY KEY,
  insumo_id   uuid NOT NULL REFERENCES core.insumo(id) ON DELETE CASCADE,
  costo_antes numeric(18,6) NOT NULL,
  costo_nuevo numeric(18,6) NOT NULL,
  usuario_id  uuid NOT NULL REFERENCES core.usuario(id),
  creado_en   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO core.parametro (clave, valor, tipo, descripcion) VALUES
  ('costo_insumo_formulas', 'MANUAL', 'texto', 'Costo de insumo para las fórmulas de precio: MANUAL (se actualiza con «Ajustar costos») o AUTOMATICO (cada compra verificada lo cambia)'),
  ('umbral_variacion_costo', '0.01', 'porcentaje', 'Variación mínima entre el costo de las fórmulas y el de las compras para que el insumo salga en el informe de corrección')
ON CONFLICT (clave) DO NOTHING;

-- Motor: el costo de la receta usa el costo para fórmulas si existe; si no, el del kárdex.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('core.recalcular_costos_base()'::regprocedure);
  IF position('costo_formula' IN def) = 0 THEN
    def := replace(def, 'i.cpp * core.factor_inventario(i.id)', 'coalesce(i.costo_formula, i.cpp) * core.factor_inventario(i.id)');
    IF (length(def) - length(replace(def, 'coalesce(i.costo_formula, i.cpp)', ''))) / length('coalesce(i.costo_formula, i.cpp)') < 2 THEN
      RAISE EXCEPTION 'No se pudo llevar el costo para fórmulas al motor de costos';
    END IF;
    EXECUTE def;
  END IF;
END $$;

-- ------------------------------------------------------------- proveedor: cuentas
CREATE TABLE IF NOT EXISTS core.proveedor_cuenta (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proveedor_id uuid NOT NULL REFERENCES core.proveedor(id) ON DELETE CASCADE,
  banco        text NOT NULL REFERENCES core.banco(codigo),
  numero       text NOT NULL CHECK (numero ~ '^[0-9][0-9 -]{4,38}[0-9]$'),
  orden        int NOT NULL DEFAULT 0,
  UNIQUE (proveedor_id, numero)
);
-- Las cuentas que ya estaban en la ficha (banco + CCI) pasan a la tabla.
INSERT INTO core.proveedor_cuenta (proveedor_id, banco, numero)
SELECT p.id, coalesce((SELECT b.codigo FROM core.banco b WHERE upper(trim(p.banco)) IN (b.codigo, upper(b.nombre)) LIMIT 1), 'OTRO'), p.cci
FROM core.proveedor p WHERE p.cci IS NOT NULL
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------- compra
INSERT INTO core.tipo_documento_compra (codigo, nombre, credito_fiscal, orden) VALUES ('NOTA_PEDIDO', 'Nota de pedido', false, 3)
ON CONFLICT (codigo) DO NOTHING;
ALTER TABLE core.compra
  ADD COLUMN IF NOT EXISTS condicion       text NOT NULL DEFAULT 'CONTADO',
  -- Algunos documentos traen el detalle sin IGV: entonces el total suma el IGV aparte.
  ADD COLUMN IF NOT EXISTS precios_con_igv boolean NOT NULL DEFAULT true;
UPDATE core.compra SET condicion = 'CREDITO' WHERE vence_pago IS NOT NULL AND condicion = 'CONTADO';
DO $$ BEGIN
  ALTER TABLE core.compra ADD CONSTRAINT ck_compra_condicion CHECK (condicion IN ('CONTADO','CREDITO'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------- pagos
ALTER TABLE core.pago_compra ADD COLUMN IF NOT EXISTS comprobante_id uuid REFERENCES core.archivo(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS core.pago_costo (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo            text NOT NULL UNIQUE,
  costo_indirecto_id uuid REFERENCES core.costo_indirecto(id),
  concepto          text NOT NULL CHECK (length(trim(concepto)) >= 2),
  fecha_operacion   date NOT NULL,
  periodo_mes       int NOT NULL CHECK (periodo_mes BETWEEN 1 AND 12),
  periodo_anio      int NOT NULL CHECK (periodo_anio BETWEEN 2000 AND 2100),
  monto             numeric(14,2) NOT NULL CHECK (monto > 0),
  caja              text NOT NULL CHECK (caja IN ('CHICA','GRANDE')),
  apertura_id       uuid REFERENCES core.caja_apertura(id),
  medio_pago        text NOT NULL REFERENCES core.medio_pago(codigo),
  nro_operacion     text,
  comprobante_id    uuid REFERENCES core.archivo(id) ON DELETE SET NULL,
  usuario_id        uuid NOT NULL REFERENCES core.usuario(id),
  estado            text NOT NULL DEFAULT 'VIGENTE' CHECK (estado IN ('VIGENTE','ANULADO')),
  anulado_por       uuid REFERENCES core.usuario(id),
  anulado_en        timestamptz,
  motivo_anulacion  text,
  idempotency_key   text UNIQUE,
  creado_en         timestamptz NOT NULL DEFAULT now(),
  CHECK ((caja = 'CHICA') = (apertura_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_pago_costo_periodo ON core.pago_costo (periodo_anio, periodo_mes) WHERE estado = 'VIGENTE';
CREATE INDEX IF NOT EXISTS ix_pago_costo_apertura ON core.pago_costo (apertura_id) WHERE estado = 'VIGENTE';

-- Saldo de una apertura de caja chica = monto inicial − pagos vigentes a proveedores − pagos de costos.
CREATE OR REPLACE FUNCTION core.saldo_caja(p_apertura uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT a.monto_inicial
       - coalesce((SELECT sum(p.monto) FROM core.pago_compra p WHERE p.apertura_id = a.id AND p.estado = 'VIGENTE'), 0)
       - coalesce((SELECT sum(g.monto) FROM core.pago_costo g WHERE g.apertura_id = a.id AND g.estado = 'VIGENTE'), 0)
  FROM core.caja_apertura a WHERE a.id = p_apertura
$$;

INSERT INTO core.navegacion (id, grupo, etiqueta, ruta, icono, permiso_id, orden, grupo_orden) VALUES
  ('n-pagos-costos', 'Operación', 'Pagos de costos', '/compras/pagos-costos', 'wallet', 'compras.pagar', 9, 1)
ON CONFLICT (id) DO NOTHING;
