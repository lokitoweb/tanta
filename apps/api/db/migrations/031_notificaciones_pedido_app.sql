-- =====================================================================
--  031 · Compra del cliente en la app y avisos por área (INF-TEC-001 A04–A11, PED-05, PED-08, VEN-03)
--  · Centro de notificaciones por usuario (A11): cada aviso guarda la pantalla que abre y si se leyó.
--  · Historial de estados del pedido por trigger: alimenta la línea de tiempo (A09) y los avisos,
--    sin importar qué ruta cambió el estado (cliente, vendedor, despacho por venta, cancelación).
--  · Pago contra entrega: el cliente indica cómo pagará al recibir (no hay pasarela).
-- =====================================================================

CREATE TABLE IF NOT EXISTS core.notificacion (
  id         bigserial PRIMARY KEY,
  usuario_id uuid NOT NULL REFERENCES core.usuario(id) ON DELETE CASCADE,
  tipo       text NOT NULL,
  titulo     text NOT NULL,
  cuerpo     text NOT NULL,
  ruta       text NOT NULL DEFAULT '',
  leida_en   timestamptz,
  creado_en  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_notificacion_usuario ON core.notificacion (usuario_id, id DESC);
CREATE INDEX IF NOT EXISTS ix_notificacion_no_leida ON core.notificacion (usuario_id) WHERE leida_en IS NULL;

CREATE TABLE IF NOT EXISTS core.pedido_historial (
  id            bigserial PRIMARY KEY,
  pedido_id     uuid NOT NULL REFERENCES core.pedido(id) ON DELETE CASCADE,
  estado        text NOT NULL,
  creado_en     timestamptz NOT NULL DEFAULT now(),
  notificado_en timestamptz
);
CREATE INDEX IF NOT EXISTS ix_pedido_historial ON core.pedido_historial (pedido_id, id);
CREATE INDEX IF NOT EXISTS ix_pedido_historial_pendiente ON core.pedido_historial (id) WHERE notificado_en IS NULL;

CREATE OR REPLACE FUNCTION core.historial_pedido() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.estado IS DISTINCT FROM OLD.estado THEN
    INSERT INTO core.pedido_historial (pedido_id, estado) VALUES (NEW.id, NEW.estado);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS tg_historial_pedido ON core.pedido;
CREATE TRIGGER tg_historial_pedido AFTER INSERT OR UPDATE OF estado ON core.pedido
  FOR EACH ROW EXECUTE FUNCTION core.historial_pedido();

-- Los pedidos que ya existen arrancan con su estado actual (sin avisos por lo pasado).
INSERT INTO core.pedido_historial (pedido_id, estado, creado_en, notificado_en)
SELECT p.id, p.estado, p.creado_en, now() FROM core.pedido p
WHERE NOT EXISTS (SELECT 1 FROM core.pedido_historial h WHERE h.pedido_id = p.id);

ALTER TABLE core.pedido ADD COLUMN IF NOT EXISTS pago_entrega text NOT NULL DEFAULT 'EFECTIVO';
DO $$ BEGIN
  ALTER TABLE core.pedido ADD CONSTRAINT ck_pedido_pago_entrega CHECK (pago_entrega IN ('EFECTIVO','YAPE','PLIN','TARJETA','CREDITO'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO core.permiso (id, grupo, descripcion) VALUES
  ('alertas.ventas', 'Ventas', 'Recibir el aviso de cada venta registrada')
ON CONFLICT (id) DO NOTHING;
INSERT INTO core.rol_permiso (rol_id, permiso_id)
SELECT r, 'alertas.ventas' FROM unnest(ARRAY['SUPERADMIN','GERENTE']) r
WHERE EXISTS (SELECT 1 FROM core.rol WHERE id = r)
ON CONFLICT DO NOTHING;
