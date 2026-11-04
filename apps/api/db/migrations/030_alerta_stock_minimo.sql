-- =====================================================================
--  030 · Alerta de stock mínimo (INF-TEC-001 AIN-05, CP-21)
--  El estado del insumo lo calcula la base en cada cambio de stock o mínimo (antes solo dos rutas lo
--  actualizaban). Al cruzar el mínimo hacia abajo se registra UNA alerta; no se repite hasta que el
--  stock se recupere y vuelva a bajar. La API la envía a quien tiene el permiso alertas.stock.
-- =====================================================================

CREATE TABLE IF NOT EXISTS core.alerta_stock (
  id         bigserial PRIMARY KEY,
  insumo_id  uuid NOT NULL REFERENCES core.insumo(id) ON DELETE CASCADE,
  stock      numeric(18,6) NOT NULL,
  minimo     numeric(18,6) NOT NULL,
  creado_en  timestamptz NOT NULL DEFAULT now(),
  enviada_en timestamptz
);
CREATE INDEX IF NOT EXISTS ix_alerta_stock_pendiente ON core.alerta_stock (id) WHERE enviada_en IS NULL;

CREATE OR REPLACE FUNCTION core.estado_insumo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.estado := CASE WHEN NEW.stock < NEW.minimo THEN 'BAJO_MINIMO' ELSE 'OK' END;
  IF TG_OP = 'UPDATE' AND OLD.estado = 'OK' AND NEW.estado = 'BAJO_MINIMO' AND NEW.activo THEN
    INSERT INTO core.alerta_stock (insumo_id, stock, minimo) VALUES (NEW.id, NEW.stock, NEW.minimo);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tg_estado_insumo ON core.insumo;
CREATE TRIGGER tg_estado_insumo BEFORE INSERT OR UPDATE OF stock, minimo ON core.insumo
  FOR EACH ROW EXECUTE FUNCTION core.estado_insumo();

-- Corrige los estados que quedaron desfasados (sin generar alertas por lo pasado).
UPDATE core.insumo SET estado = CASE WHEN stock < minimo THEN 'BAJO_MINIMO' ELSE 'OK' END
WHERE estado <> CASE WHEN stock < minimo THEN 'BAJO_MINIMO' ELSE 'OK' END;

INSERT INTO core.permiso (id, grupo, descripcion) VALUES
  ('alertas.stock', 'Almacén', 'Recibir la alerta de insumos bajo el stock mínimo')
ON CONFLICT (id) DO NOTHING;
INSERT INTO core.rol_permiso (rol_id, permiso_id)
SELECT r, 'alertas.stock' FROM unnest(ARRAY['SUPERADMIN','ALMACEN','GERENTE']) r
WHERE EXISTS (SELECT 1 FROM core.rol WHERE id = r)
ON CONFLICT DO NOTHING;
