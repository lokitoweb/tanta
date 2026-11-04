-- =====================================================================
--  038 · Catálogos administrables y una sola tabla de unidades
--  Antes eran listas fijas en el código y en CHECK de la base. Ahora cada una es una tabla que el
--  Administrador mantiene; las reglas salen de sus atributos, no del código del valor:
--  · tipo_documento_compra.credito_fiscal: el IGV del documento no es costo del insumo (factura).
--  · medio_pago: en qué procesos se usa, si exige n.° de operación, si sale de caja chica, si es crédito.
--  · tipo_insumo.es_harina: suma al 100 % del porcentaje panadero.
--  · unidad_medida: única fuente de conversión (familia y factor al patrón). Reemplaza a unidad_conversion.
--  Los registros existentes se conservan: los valores actuales son las filas iniciales de cada catálogo.
-- =====================================================================

-- ------------------------------------------------------- tipos de documento de compra
CREATE TABLE IF NOT EXISTS core.tipo_documento_compra (
  codigo         text PRIMARY KEY CHECK (codigo ~ '^[A-Z][A-Z0-9_]{1,19}$'),
  nombre         text NOT NULL,
  credito_fiscal boolean NOT NULL DEFAULT false,
  activo         boolean NOT NULL DEFAULT true,
  orden          int NOT NULL DEFAULT 0
);
INSERT INTO core.tipo_documento_compra (codigo, nombre, credito_fiscal, orden) VALUES
  ('FACTURA', 'Factura', true, 1), ('BOLETA', 'Boleta', false, 2), ('NOTA_VENTA', 'Nota de venta', false, 3),
  ('GUIA', 'Guía de remisión', false, 4), ('OTRO', 'Otro', false, 5)
ON CONFLICT (codigo) DO NOTHING;

-- ------------------------------------------------------- medios de pago
CREATE TABLE IF NOT EXISTS core.medio_pago (
  codigo             text PRIMARY KEY CHECK (codigo ~ '^[A-Z][A-Z0-9_]{1,19}$'),
  nombre             text NOT NULL,
  requiere_operacion boolean NOT NULL DEFAULT false,
  en_ventas          boolean NOT NULL DEFAULT false,
  en_cobranza        boolean NOT NULL DEFAULT false,
  en_compras         boolean NOT NULL DEFAULT false,
  caja_chica         boolean NOT NULL DEFAULT false,
  es_credito         boolean NOT NULL DEFAULT false,
  activo             boolean NOT NULL DEFAULT true,
  orden              int NOT NULL DEFAULT 0,
  -- El crédito no es dinero: no se cobra con él, no se paga a proveedores ni sale de caja.
  CHECK (NOT es_credito OR NOT (en_cobranza OR en_compras OR caja_chica OR requiere_operacion))
);
INSERT INTO core.medio_pago (codigo, nombre, requiere_operacion, en_ventas, en_cobranza, en_compras, caja_chica, es_credito, orden) VALUES
  ('EFECTIVO', 'Efectivo', false, true, true, true, true, false, 1),
  ('YAPE', 'Yape', true, true, true, true, false, false, 2),
  ('PLIN', 'Plin', true, true, true, true, false, false, 3),
  ('TARJETA', 'Tarjeta (POS)', true, true, true, false, false, false, 4),
  ('TRANSFERENCIA', 'Transferencia bancaria', true, true, true, true, false, false, 5),
  ('OTRO', 'Otro', false, false, false, true, false, false, 6),
  ('CREDITO', 'Crédito', false, true, false, false, false, true, 7)
ON CONFLICT (codigo) DO NOTHING;

-- ------------------------------------------------------- tipos de insumo
CREATE TABLE IF NOT EXISTS core.tipo_insumo (
  codigo    text PRIMARY KEY CHECK (codigo ~ '^[A-Z][A-Z0-9_]{1,19}$'),
  nombre    text NOT NULL,
  es_harina boolean NOT NULL DEFAULT false,
  activo    boolean NOT NULL DEFAULT true,
  orden     int NOT NULL DEFAULT 0
);
INSERT INTO core.tipo_insumo (codigo, nombre, es_harina, orden) VALUES
  ('HARINA', 'Harina', true, 1), ('GRASA', 'Grasa', false, 2), ('LACTEO', 'Lácteo', false, 3), ('AZUCAR', 'Azúcar', false, 4),
  ('LEVADURA', 'Levadura', false, 5), ('HUEVO', 'Huevo', false, 6), ('RELLENO', 'Relleno', false, 7), ('ADITIVO', 'Aditivo', false, 8),
  ('LIQUIDO', 'Líquido', false, 9), ('OTRO', 'Otro', false, 10)
ON CONFLICT (codigo) DO NOTHING;

-- ------------------------------------------------------- unidades (una sola tabla)
ALTER TABLE core.unidad_medida
  ADD COLUMN IF NOT EXISTS activo boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS orden  int NOT NULL DEFAULT 0;
-- Los códigos que ya usaban las recetas se conservan (GR, ML, UNID) como unidades del catálogo.
INSERT INTO core.unidad_medida (codigo, descripcion, familia, factor_a_patron)
SELECT c.unidad_receta, lower(c.unidad_receta), m.familia, c.factor * m.factor_a_patron
FROM core.unidad_conversion c JOIN core.unidad_medida m ON m.codigo = c.unidad_base
ON CONFLICT (codigo) DO NOTHING;
DROP TABLE IF EXISTS core.unidad_conversion;

-- Convierte una cantidad entre unidades de la misma familia (g → kg, ml → L). NULL si son de familias distintas.
CREATE OR REPLACE FUNCTION core.convertir_unidad(p_cantidad numeric, p_de text, p_a text) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT p_cantidad * d.factor_a_patron / a.factor_a_patron
  FROM core.unidad_medida d, core.unidad_medida a WHERE d.codigo = p_de AND a.codigo = p_a AND d.familia = a.familia
$$;

-- ------------------------------------------------------- de CHECK fijos a referencias al catálogo
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT conrelid::regclass AS tabla, conname FROM pg_constraint
           WHERE contype = 'c' AND (
             (conrelid = 'core.compra'::regclass AND pg_get_constraintdef(oid) ILIKE '%doc_tipo%')
          OR (conrelid = 'core.insumo'::regclass AND pg_get_constraintdef(oid) ILIKE '%tipo%HARINA%')
          OR (conrelid = 'core.venta'::regclass AND pg_get_constraintdef(oid) ILIKE '%forma_pago%')
          OR (conrelid = 'core.cobranza'::regclass AND pg_get_constraintdef(oid) ILIKE '%medio%')
          OR (conrelid = 'core.recibo'::regclass AND pg_get_constraintdef(oid) ILIKE '%medio%')
          OR (conrelid = 'core.pedido'::regclass AND pg_get_constraintdef(oid) ILIKE '%pago_entrega%')
          OR (conrelid = 'core.pago_compra'::regclass AND pg_get_constraintdef(oid) ILIKE '%medio_pago%')) LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tabla, r.conname);
  END LOOP;
END $$;

DO $$ BEGIN
  ALTER TABLE core.compra      ADD CONSTRAINT fk_compra_doc_tipo FOREIGN KEY (doc_tipo) REFERENCES core.tipo_documento_compra(codigo);
  ALTER TABLE core.insumo      ADD CONSTRAINT fk_insumo_tipo FOREIGN KEY (tipo) REFERENCES core.tipo_insumo(codigo);
  ALTER TABLE core.insumo      ADD CONSTRAINT fk_insumo_unidad FOREIGN KEY (unidad) REFERENCES core.unidad_medida(codigo);
  ALTER TABLE core.venta       ADD CONSTRAINT fk_venta_forma_pago FOREIGN KEY (forma_pago) REFERENCES core.medio_pago(codigo);
  ALTER TABLE core.cobranza    ADD CONSTRAINT fk_cobranza_medio FOREIGN KEY (medio) REFERENCES core.medio_pago(codigo);
  ALTER TABLE core.recibo      ADD CONSTRAINT fk_recibo_medio FOREIGN KEY (medio) REFERENCES core.medio_pago(codigo);
  ALTER TABLE core.pedido      ADD CONSTRAINT fk_pedido_pago_entrega FOREIGN KEY (pago_entrega) REFERENCES core.medio_pago(codigo);
  ALTER TABLE core.pago_compra ADD CONSTRAINT fk_pago_compra_medio FOREIGN KEY (medio_pago) REFERENCES core.medio_pago(codigo);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- El % panadero suma las harinas del catálogo (es_harina), ya no el código 'HARINA' escrito en el motor.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('core.recalcular_costos_base()'::regprocedure);
  IF position('es_harina' IN def) = 0 THEN
    def := replace(def, $r$WHERE i.tipo = 'HARINA'$r$, $r$WHERE i.tipo IN (SELECT codigo FROM core.tipo_insumo WHERE es_harina)$r$);
    IF position('es_harina' IN def) = 0 THEN RAISE EXCEPTION 'No se pudo llevar el %% panadero al catálogo de tipos'; END IF;
    EXECUTE def;
  END IF;
END $$;

-- La compra guarda el costo sin IGV cuando el documento da crédito fiscal (lo informa el detalle).
ALTER TABLE core.compra_detalle ADD COLUMN IF NOT EXISTS sin_igv boolean NOT NULL DEFAULT false;

INSERT INTO core.navegacion (id, grupo, etiqueta, ruta, icono, permiso_id, orden, grupo_orden) VALUES
  ('n-catalogos', 'Maestros', 'Catálogos', '/maestros/catalogos', 'clipboard', 'maestros.editar', 9, 3)
ON CONFLICT (id) DO NOTHING;
