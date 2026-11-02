-- =====================================================================
--  017 · Ventas con descuento y total con IGV, pedido → venta, detalle de pedidos
--  y motivos de merma (hallazgos de QA: B1, B4, A1, A2, A6, A7)
-- =====================================================================

ALTER TABLE core.venta
  ADD COLUMN IF NOT EXISTS descuento_pct numeric(9,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_con_igv numeric(16,4),
  ADD COLUMN IF NOT EXISTS pedido_id     uuid REFERENCES core.pedido(id);
DO $$ BEGIN
  ALTER TABLE core.venta ADD CONSTRAINT ck_venta_descuento CHECK (descuento_pct >= 0 AND descuento_pct < 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS ux_venta_pedido ON core.venta (pedido_id) WHERE pedido_id IS NOT NULL AND estado = 'CONFIRMADA';

-- Total con IGV de las ventas existentes (lo que el cliente pagó / debe)
UPDATE core.venta v SET total_con_igv = x.t
FROM (SELECT venta_id, sum(precio_con_igv * cantidad) t FROM core.venta_detalle GROUP BY venta_id) x
WHERE x.venta_id = v.id AND v.total_con_igv IS NULL;

-- Las cuentas por cobrar se habían registrado SIN IGV (el cliente debe el precio con IGV).
UPDATE core.cuenta_por_cobrar x
SET saldo = round(x.saldo * v.total_con_igv / NULLIF(x.monto, 0), 4), monto = v.total_con_igv
FROM core.venta v
WHERE v.id = x.venta_id AND v.total_con_igv IS NOT NULL AND abs(x.monto - v.ventas_netas) < 0.01 AND v.total_con_igv > x.monto;

INSERT INTO core.parametro (clave, valor, tipo, descripcion) VALUES
  ('descuento_maximo', '0.10', 'porcentaje', 'Descuento máximo que un vendedor puede aplicar en una venta')
ON CONFLICT (clave) DO NOTHING;

-- Detalle de pedido: qué productos y cuántos (antes el pedido solo tenía un total).
CREATE TABLE IF NOT EXISTS core.pedido_detalle (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pedido_id    uuid NOT NULL REFERENCES core.pedido(id) ON DELETE CASCADE,
  producto_id  uuid NOT NULL REFERENCES core.producto(id),
  producto     text NOT NULL,
  cantidad     numeric(18,6) NOT NULL CHECK (cantidad > 0 AND cantidad <= 10000),
  precio_con_igv numeric(16,4) NOT NULL CHECK (precio_con_igv >= 0)
);
CREATE INDEX IF NOT EXISTS ix_pedido_detalle_pedido ON core.pedido_detalle (pedido_id);
ALTER TABLE core.pedido
  ADD COLUMN IF NOT EXISTS hora_entrega   text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS observaciones  text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS creado_por     uuid REFERENCES core.usuario(id);

-- Merma real con motivo (PDF §3.2 Producción)
ALTER TABLE core.orden_produccion ADD COLUMN IF NOT EXISTS motivo_merma text NOT NULL DEFAULT '';
ALTER TABLE core.orden_produccion ADD COLUMN IF NOT EXISTS pedido_id uuid REFERENCES core.pedido(id);

-- El cliente registra y consulta SUS pedidos (Tabla 2: Cliente ● Pedidos)
INSERT INTO core.permiso (id, grupo, descripcion) VALUES
  ('pedidos.crear', 'Cliente', 'Registrar pedidos propios desde la app o la web'),
  ('produccion.planificar', 'Producción', 'Generar órdenes de producción')
ON CONFLICT (id) DO NOTHING;
INSERT INTO core.rol_permiso (rol_id, permiso_id)
SELECT v.r, v.p FROM (VALUES ('CLIENTE','pedidos.crear'), ('VENDEDOR','pedidos.crear'), ('PRODUCCION','produccion.planificar'), ('PRODUCCION','pedidos.ver')) v(r,p)
WHERE EXISTS (SELECT 1 FROM core.rol WHERE id = v.r)
ON CONFLICT DO NOTHING;
