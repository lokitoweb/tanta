-- Pendientes de la auditoría 2026-11.
--  1) Cobros y recibos anulables con motivo (la deuda vuelve; si ya se rindió, caja grande registra la salida).
--  2) Cada cobro sabe en qué rendición se entregó: un cobro tardío va en una rendición complementaria del mismo día.
--  3) Verificación en dos pasos administrable por rol (antes fija en el código).
--  4) La orden de producción congela su receta al crearse: editar la receta no cambia órdenes en curso.

-- 1) Cobros y recibos anulables -------------------------------------------------------------
ALTER TABLE core.cobranza
  ADD COLUMN IF NOT EXISTS estado text NOT NULL DEFAULT 'VIGENTE' CHECK (estado IN ('VIGENTE','ANULADO')),
  ADD COLUMN IF NOT EXISTS anulado_por uuid REFERENCES core.usuario(id),
  ADD COLUMN IF NOT EXISTS anulado_en timestamptz,
  ADD COLUMN IF NOT EXISTS motivo_anulacion text,
  ADD COLUMN IF NOT EXISTS rendicion_id uuid REFERENCES core.rendicion_cobranza(id);

ALTER TABLE core.recibo
  ADD COLUMN IF NOT EXISTS estado text NOT NULL DEFAULT 'VIGENTE' CHECK (estado IN ('VIGENTE','ANULADO')),
  ADD COLUMN IF NOT EXISTS anulado_por uuid REFERENCES core.usuario(id),
  ADD COLUMN IF NOT EXISTS anulado_en timestamptz,
  ADD COLUMN IF NOT EXISTS motivo_anulacion text;

INSERT INTO core.permiso (id, grupo, descripcion) VALUES
  ('cobranza.anular', 'Cobranza', 'Anular cobros y recibos con motivo: la deuda vuelve y, si ya se rindió, sale de caja grande')
ON CONFLICT (id) DO NOTHING;
INSERT INTO core.rol_permiso (rol_id, permiso_id)
  SELECT r.id, 'cobranza.anular' FROM core.rol r WHERE r.id IN ('SUPERADMIN','GERENTE','ADMINISTRADOR')
ON CONFLICT DO NOTHING;

-- La salida de caja grande por un cobro anulado ya rendido.
ALTER TABLE core.movimiento_caja DROP CONSTRAINT IF EXISTS movimiento_caja_tipo_check;
ALTER TABLE core.movimiento_caja ADD CONSTRAINT movimiento_caja_tipo_check CHECK (tipo IN ('SALDO_INICIAL','AJUSTE','RENDICION','CIERRE_CAJA_CHICA','FONDO_CAJA_CHICA',
  'PAGO_COMPRA','PAGO_COSTO','DEPOSITO_SALIDA','DEPOSITO_ENTRADA','ANULACION_COBRO'));

-- 2) Rendiciones complementarias ------------------------------------------------------------
-- Antes: una rendición por vendedor y día. Ahora puede haber varias recibidas, pero solo una pendiente.
ALTER TABLE core.rendicion_cobranza DROP CONSTRAINT IF EXISTS rendicion_cobranza_vendedor_id_fecha_key;
CREATE UNIQUE INDEX IF NOT EXISTS ux_rendicion_pendiente ON core.rendicion_cobranza (vendedor_id, fecha) WHERE estado = 'PENDIENTE';

-- Los cobros de rendiciones existentes quedan ligados a ellas (antes se cruzaban por vendedor y fecha).
UPDATE core.cobranza b SET rendicion_id = r.id
  FROM core.rendicion_cobranza r
  WHERE b.rendicion_id IS NULL AND r.vendedor_id = b.registrado_por AND r.fecha = (b.creado_en AT TIME ZONE 'America/Lima')::date;

CREATE INDEX IF NOT EXISTS ix_cobranza_rendicion ON core.cobranza (rendicion_id);
CREATE INDEX IF NOT EXISTS ix_cobranza_por_rendir ON core.cobranza (registrado_por, creado_en) WHERE rendicion_id IS NULL AND estado = 'VIGENTE';

-- 3) Verificación en dos pasos por rol -------------------------------------------------------
ALTER TABLE core.rol ADD COLUMN IF NOT EXISTS exige_mfa boolean NOT NULL DEFAULT false;
UPDATE core.rol SET exige_mfa = true WHERE id IN ('SUPERADMIN','GERENTE','ADMINISTRADOR');

-- 4) Receta congelada en la orden ------------------------------------------------------------
-- por_unidad: cantidad del insumo (en su unidad de inventario) por unidad horneada (buenas + merma).
CREATE TABLE IF NOT EXISTS core.orden_produccion_insumo (
  id         bigserial PRIMARY KEY,
  op_id      uuid NOT NULL REFERENCES core.orden_produccion(id) ON DELETE CASCADE,
  insumo_id  uuid NOT NULL REFERENCES core.insumo(id),
  insumo     text NOT NULL,
  unidad     text NOT NULL,
  por_unidad numeric(24,12) NOT NULL CHECK (por_unidad >= 0),
  orden      integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_op_insumo_op ON core.orden_produccion_insumo (op_id);
