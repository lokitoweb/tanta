-- =====================================================================
--  032 · Almacenes (INF-TEC-001 MAE-10, W12) y proveedor habitual del insumo (MAE-01)
--  Un almacén de insumos y uno de productos terminados, cada uno con responsable.
--  "Cada movimiento de inventario queda asociado a un almacén": lo asigna la base al insertar,
--  con el almacén principal del tipo de ítem, así ninguna ruta puede olvidarlo.
-- =====================================================================

CREATE TABLE IF NOT EXISTS core.almacen (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre         text NOT NULL CHECK (length(trim(nombre)) >= 3),
  tipo           text NOT NULL CHECK (tipo IN ('INSUMOS','PRODUCTOS')),
  responsable_id uuid REFERENCES core.usuario(id) ON DELETE SET NULL,
  ubicacion      text NOT NULL DEFAULT '',
  principal      boolean NOT NULL DEFAULT false,
  estado         text NOT NULL DEFAULT 'ACTIVO' CHECK (estado IN ('ACTIVO','INACTIVO')),
  creado_en      timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT principal OR estado = 'ACTIVO')
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_almacen_nombre ON core.almacen (lower(nombre));
CREATE UNIQUE INDEX IF NOT EXISTS ux_almacen_principal ON core.almacen (tipo) WHERE principal;

INSERT INTO core.almacen (nombre, tipo, principal) VALUES
  ('Almacén de insumos', 'INSUMOS', true),
  ('Almacén de productos terminados', 'PRODUCTOS', true)
ON CONFLICT DO NOTHING;

ALTER TABLE core.movimiento_inventario ADD COLUMN IF NOT EXISTS almacen_id uuid REFERENCES core.almacen(id);

CREATE OR REPLACE FUNCTION core.almacen_movimiento() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.almacen_id IS NULL THEN
    SELECT id INTO NEW.almacen_id FROM core.almacen
    WHERE principal AND tipo = CASE NEW.item_tipo WHEN 'INSUMO' THEN 'INSUMOS' ELSE 'PRODUCTOS' END;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tg_almacen_movimiento ON core.movimiento_inventario;
CREATE TRIGGER tg_almacen_movimiento BEFORE INSERT ON core.movimiento_inventario
  FOR EACH ROW EXECUTE FUNCTION core.almacen_movimiento();

-- Los movimientos ya registrados quedan en el almacén principal de su tipo.
UPDATE core.movimiento_inventario m SET almacen_id = a.id FROM core.almacen a
WHERE m.almacen_id IS NULL AND a.principal AND a.tipo = CASE m.item_tipo WHEN 'INSUMO' THEN 'INSUMOS' ELSE 'PRODUCTOS' END;
CREATE INDEX IF NOT EXISTS ix_movimiento_almacen ON core.movimiento_inventario (almacen_id, creado_en DESC);

-- MAE-01: el proveedor habitual del insumo se elige del maestro; la base lo vincula por nombre.
CREATE OR REPLACE FUNCTION core.proveedor_insumo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.proveedor_id := (SELECT id FROM core.proveedor WHERE lower(razon_social) = lower(trim(NEW.proveedor)) LIMIT 1);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tg_proveedor_insumo ON core.insumo;
CREATE TRIGGER tg_proveedor_insumo BEFORE INSERT OR UPDATE OF proveedor ON core.insumo
  FOR EACH ROW EXECUTE FUNCTION core.proveedor_insumo();

INSERT INTO core.navegacion (id, grupo, etiqueta, ruta, icono, permiso_id, orden, grupo_orden) VALUES
  ('n-almacenes', 'Maestros', 'Almacenes', '/maestros/almacenes', 'box', 'maestros.editar', 5, 3)
ON CONFLICT (id) DO NOTHING;
