-- =====================================================================
--  034 · Compra de insumos (Informe de Análisis v1.1, 04-11-2026)
--  · Conversión en tres niveles: presentación de compra → unidad base (F1) → unidad de inventario (F2).
--    Un único servicio de conversión en la base (core.factor_inventario) que usan Compras, Almacén,
--    Producción y el motor de costos (F3, F4).
--  · Flujo de la compra: REGISTRADA → VERIFICADA | OBSERVADA → EN_CORRECCION → REGISTRADA; ANULADA.
--    El stock solo ingresa al VERIFICAR (RN-06). Anular una verificada genera REVERSA_COMPRA (RN-09).
--  · Documento: proveedor + tipo + serie + número, único entre las no anuladas, sin espacios ni mayúsculas (RN-05).
--  · Rol Compras y permisos de la sección 7 del informe.
--  Reutiliza lo existente: "cantidad por presentación" es el contenido de la presentación y
--  "equivalente en kg" es la densidad (factor de inventario cuando se pasa de volumen o conteo a masa).
-- =====================================================================

-- ------------------------------------------------------- UNIDAD_MEDIDA (5.5)
CREATE TABLE IF NOT EXISTS core.unidad_medida (
  codigo          text PRIMARY KEY,
  descripcion     text NOT NULL,
  familia         text NOT NULL CHECK (familia IN ('MASA','VOLUMEN','CONTEO')),
  factor_a_patron numeric(12,6) NOT NULL CHECK (factor_a_patron > 0)
);
INSERT INTO core.unidad_medida VALUES
  ('KG', 'kilogramo', 'MASA', 1), ('GR', 'gramo', 'MASA', 0.001), ('G', 'gramo', 'MASA', 0.001),
  ('L', 'litro', 'VOLUMEN', 1), ('ML', 'mililitro', 'VOLUMEN', 0.001),
  ('UNIDAD', 'unidad', 'CONTEO', 1), ('UNID', 'unidad', 'CONTEO', 1), ('BALON', 'balón', 'CONTEO', 1)
ON CONFLICT (codigo) DO NOTHING;

-- ------------------------------------------------------- INSUMO: unidad de inventario
ALTER TABLE core.insumo ADD COLUMN IF NOT EXISTS unidad_inventario text;
UPDATE core.insumo SET unidad_inventario = unidad WHERE unidad_inventario IS NULL;
ALTER TABLE core.insumo ALTER COLUMN unidad_inventario SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE core.insumo ADD CONSTRAINT fk_insumo_unidad_inventario FOREIGN KEY (unidad_inventario) REFERENCES core.unidad_medida(codigo);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Factor de inventario: unidades de inventario por unidad base (F2).
--  · Misma familia: relación de patrones (L → L = 1; L → ml = 1000).
--  · Hacia masa desde volumen o conteo: la densidad del insumo (equiv_kg, kg por unidad base).
--  · Otro cruce: no hay conversión (NULL) y el insumo no se puede guardar (RN-03).
CREATE OR REPLACE FUNCTION core.factor_unidades(p_base text, p_inventario text, p_densidad numeric) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN b.familia = i.familia THEN b.factor_a_patron / i.factor_a_patron
    WHEN i.familia = 'MASA' AND p_densidad > 0 THEN p_densidad / i.factor_a_patron
  END
  FROM core.unidad_medida b, core.unidad_medida i WHERE b.codigo = p_base AND i.codigo = p_inventario
$$;
CREATE OR REPLACE FUNCTION core.factor_inventario(p_insumo uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT core.factor_unidades(unidad, unidad_inventario, equiv_kg) FROM core.insumo WHERE id = p_insumo
$$;

-- RN-03: sin factor válido el insumo no se guarda (también protege cargas fuera de la API).
CREATE OR REPLACE FUNCTION core.validar_unidades_insumo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF core.factor_unidades(NEW.unidad, NEW.unidad_inventario, NEW.equiv_kg) IS NULL THEN
    RAISE EXCEPTION 'El insumo % no tiene factor de inventario de % a %: define su densidad.', NEW.nombre, NEW.unidad, NEW.unidad_inventario
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tg_validar_unidades_insumo ON core.insumo;
CREATE TRIGGER tg_validar_unidades_insumo BEFORE INSERT OR UPDATE OF unidad, unidad_inventario, equiv_kg ON core.insumo
  FOR EACH ROW EXECUTE FUNCTION core.validar_unidades_insumo();

-- F4 en el motor de costos: la cantidad de la receta está en unidad base; el costo promedio, por unidad de
-- inventario. Costo de la línea = cantidad base × factor × CPP. Con factor 1 (todo lo existente) no cambia nada.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('core.recalcular_costos_base()'::regprocedure);
  IF position('factor_inventario' IN def) = 0 THEN
    def := replace(def, 'SET cpp = i.cpp, costo = d.cantidad * i.cpp,',
                        'SET cpp = i.cpp * core.factor_inventario(i.id), costo = d.cantidad * i.cpp * core.factor_inventario(i.id),');
    IF position('factor_inventario' IN def) = 0 THEN RAISE EXCEPTION 'No se pudo aplicar F4 al motor de costos'; END IF;
    EXECUTE def;
  END IF;
END $$;

-- ------------------------------------------------------- COMPRA (cabecera)
DO $$ DECLARE c text; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'core.compra'::regclass AND contype IN ('u','c')
             AND (pg_get_constraintdef(oid) ILIKE '%doc_numero%' OR pg_get_constraintdef(oid) ILIKE '%doc_tipo%') LOOP
    EXECUTE format('ALTER TABLE core.compra DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE core.compra
  ADD COLUMN IF NOT EXISTS serie          text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS nro            text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS fecha_compra   date NOT NULL DEFAULT current_date,
  ADD COLUMN IF NOT EXISTS estado         text NOT NULL DEFAULT 'REGISTRADA',
  ADD COLUMN IF NOT EXISTS estado_pago    text NOT NULL DEFAULT 'PENDIENTE',
  ADD COLUMN IF NOT EXISTS vence_pago     date,
  ADD COLUMN IF NOT EXISTS base           numeric(16,2),
  ADD COLUMN IF NOT EXISTS igv            numeric(16,2),
  ADD COLUMN IF NOT EXISTS modificado_por uuid REFERENCES core.usuario(id),
  ADD COLUMN IF NOT EXISTS modificado_en  timestamptz,
  ADD COLUMN IF NOT EXISTS verificado_por uuid REFERENCES core.usuario(id),
  ADD COLUMN IF NOT EXISTS verificado_en  timestamptz,
  ADD COLUMN IF NOT EXISTS anulado_por    uuid REFERENCES core.usuario(id),
  ADD COLUMN IF NOT EXISTS anulado_en     timestamptz,
  ADD COLUMN IF NOT EXISTS motivo_anulacion text,
  ADD COLUMN IF NOT EXISTS observacion    text;
ALTER TABLE core.compra ADD CONSTRAINT ck_compra_doc_tipo CHECK (doc_tipo IN ('FACTURA','BOLETA','NOTA_VENTA','GUIA','OTRO'));
ALTER TABLE core.compra ADD CONSTRAINT ck_compra_estado CHECK (estado IN ('REGISTRADA','VERIFICADA','OBSERVADA','EN_CORRECCION','ANULADA'));
ALTER TABLE core.compra ADD CONSTRAINT ck_compra_estado_pago CHECK (estado_pago IN ('PENDIENTE','PARCIAL','PAGADO'));
-- Las compras anteriores ya habían ingresado su stock: quedan VERIFICADAS. Su número se separa en serie y número.
UPDATE core.compra SET estado = 'VERIFICADA', verificado_en = creado_en, fecha_compra = (creado_en AT TIME ZONE 'America/Lima')::date,
       serie = CASE WHEN doc_numero LIKE '%-%' THEN split_part(doc_numero, '-', 1) ELSE 'S/S' END,
       nro = CASE WHEN doc_numero LIKE '%-%' THEN substring(doc_numero FROM position('-' IN doc_numero) + 1) ELSE doc_numero END
WHERE nro = '';
CREATE UNIQUE INDEX IF NOT EXISTS ux_compra_documento ON core.compra (proveedor_id, doc_tipo, upper(trim(serie)), upper(trim(nro)))
  WHERE estado <> 'ANULADA';
CREATE INDEX IF NOT EXISTS ix_compra_estado ON core.compra (estado, creado_en DESC);

-- ------------------------------------------------------- DETALLE_COMPRA
ALTER TABLE core.compra_detalle
  ADD COLUMN IF NOT EXISTS item                      int,
  ADD COLUMN IF NOT EXISTS cantidad_presentacion     numeric(18,4),
  ADD COLUMN IF NOT EXISTS precio_unitario           numeric(18,4),
  ADD COLUMN IF NOT EXISTS precio_lote               numeric(16,2),
  ADD COLUMN IF NOT EXISTS contenido                 numeric(18,6),
  ADD COLUMN IF NOT EXISTS factor                    numeric(18,6),
  ADD COLUMN IF NOT EXISTS cantidad_base             numeric(18,6),
  ADD COLUMN IF NOT EXISTS cantidad_inventario       numeric(18,6),
  ADD COLUMN IF NOT EXISTS costo_unitario_inventario numeric(18,6),
  ADD COLUMN IF NOT EXISTS cantidad_verificada       numeric(18,4),
  ADD COLUMN IF NOT EXISTS observacion_almacen       text,
  ADD COLUMN IF NOT EXISTS lote                      text,
  ADD COLUMN IF NOT EXISTS vence_en                  date,
  ADD COLUMN IF NOT EXISTS movimiento_id             bigint;
-- Hasta ahora la cantidad y el precio de la línea estaban en unidad base (contenido 1, factor 1).
UPDATE core.compra_detalle SET cantidad_presentacion = cantidad, precio_unitario = precio, precio_lote = round(cantidad * precio, 2),
       contenido = 1, factor = 1, cantidad_base = cantidad, cantidad_inventario = cantidad, costo_unitario_inventario = precio,
       cantidad_verificada = cantidad
WHERE cantidad_presentacion IS NULL;
UPDATE core.compra_detalle d SET item = x.n FROM (
  SELECT compra_id, insumo_id, row_number() OVER (PARTITION BY compra_id ORDER BY insumo_id) n FROM core.compra_detalle) x
WHERE d.item IS NULL AND x.compra_id = d.compra_id AND x.insumo_id = d.insumo_id;

-- ------------------------------------------------------- reversa de compra (RN-09)
DO $$ DECLARE c text; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'core.movimiento_inventario'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) ILIKE '%APERTURA%' LOOP
    EXECUTE format('ALTER TABLE core.movimiento_inventario DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE core.movimiento_inventario ADD CONSTRAINT ck_movimiento_tipo
  CHECK (tipo IN ('APERTURA','COMPRA','REVERSA_COMPRA','CONSUMO_OP','MERMA','INGRESO_PRODUCCION','VENTA','DEVOLUCION','AJUSTE'));

-- La reversa retira exactamente el lote de su compra (no por FEFO): la ruta lo descuenta y el trigger no lo toca.
CREATE OR REPLACE FUNCTION core.lote_movimiento() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.item_tipo <> 'INSUMO' OR NEW.cantidad = 0 OR NEW.tipo = 'REVERSA_COMPRA' THEN RETURN NULL; END IF;
  IF NEW.cantidad > 0 THEN
    INSERT INTO core.lote_insumo (insumo_id, lote, vence_en, cantidad_inicial, saldo, movimiento_id)
    VALUES (NEW.insumo_id, coalesce(nullif(trim(NEW.lote), ''), 'S/L-' || NEW.id), NEW.vence_en, NEW.cantidad, NEW.cantidad, NEW.id);
  ELSE
    PERFORM core.consumir_lotes(NEW.insumo_id, -NEW.cantidad);
  END IF;
  RETURN NULL;
END $$;

-- ------------------------------------------------------- rol Compras y permisos (sección 7)
INSERT INTO core.rol (id, nombre, corto, descripcion, perfil, icono, orden) VALUES
  ('COMPRAS', 'Compras', 'Compras', 'Registra compras de insumos y mantiene insumos y proveedores', 'web', 'sack', 8)
ON CONFLICT (id) DO NOTHING;

INSERT INTO core.permiso (id, grupo, descripcion) VALUES
  ('compras.ver', 'Compras', 'Consultar compras, su detalle y su estado'),
  ('compras.verificar', 'Compras', 'Verificar u observar las cantidades recibidas de una compra'),
  ('compras.autorizar', 'Compras', 'Autorizar la corrección de una compra observada'),
  ('compras.anular', 'Compras', 'Anular una compra (revierte el stock si ya ingresó)'),
  ('insumos.gestionar', 'Compras', 'Crear y editar insumos y sus unidades de compra')
ON CONFLICT (id) DO NOTHING;
UPDATE core.permiso SET grupo = 'Compras', descripcion = 'Registrar y corregir compras de insumos' WHERE id = 'compras.registrar';

INSERT INTO core.rol_permiso (rol_id, permiso_id)
SELECT r, p FROM (VALUES
  ('COMPRAS','panel.ver'), ('COMPRAS','compras.registrar'), ('COMPRAS','compras.ver'), ('COMPRAS','insumos.gestionar'),
  ('COMPRAS','proveedores.gestionar'), ('COMPRAS','inventario.ver'), ('COMPRAS','maestros.ver'),
  ('ALMACEN','compras.verificar'), ('ALMACEN','compras.ver'),
  ('ADMINISTRADOR','compras.registrar'), ('ADMINISTRADOR','compras.ver'), ('ADMINISTRADOR','compras.autorizar'),
  ('ADMINISTRADOR','compras.anular'), ('ADMINISTRADOR','insumos.gestionar'),
  ('GERENTE','compras.ver'),
  ('SUPERADMIN','compras.ver'), ('SUPERADMIN','compras.verificar'), ('SUPERADMIN','compras.autorizar'),
  ('SUPERADMIN','compras.anular'), ('SUPERADMIN','insumos.gestionar')) v(r, p)
WHERE EXISTS (SELECT 1 FROM core.rol WHERE id = r)
ON CONFLICT DO NOTHING;
-- Almacén ya no registra compras: las verifica (sección 7).
DELETE FROM core.rol_permiso WHERE rol_id = 'ALMACEN' AND permiso_id = 'compras.registrar';

UPDATE core.navegacion SET permiso_id = 'compras.ver' WHERE id = 'n-compras';
