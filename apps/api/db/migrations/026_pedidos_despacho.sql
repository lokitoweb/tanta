-- =====================================================================
--  026 · Pedidos y despacho según INF-TEC-001 (M03, M06, M07)
--  RN-26 estados (Confirmado y Rechazado), PED-03 tipo de entrega y dirección,
--  PED-04 anticipación mínima, RN-29 stock reservado, VEN-02/03 despacho y entrega,
--  SEG-04 autorregistro de clientes con documento único.
-- =====================================================================

-- Estados del pedido: se reemplaza la restricción original por la del catálogo.
DO $$ DECLARE c text; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'core.pedido'::regclass AND contype = 'c'
           AND pg_get_constraintdef(oid) ILIKE '%estado%' LOOP
    EXECUTE format('ALTER TABLE core.pedido DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE core.pedido ADD CONSTRAINT ck_pedido_estado
  CHECK (estado IN ('REGISTRADO','CONFIRMADO','EN_PRODUCCION','LISTO','DESPACHADO','ENTREGADO','RECHAZADO','CANCELADO'));

ALTER TABLE core.pedido
  ADD COLUMN IF NOT EXISTS tipo_entrega  text NOT NULL DEFAULT 'RECOJO',
  ADD COLUMN IF NOT EXISTS direccion     text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS motivo        text,
  ADD COLUMN IF NOT EXISTS confirmado_en timestamptz,
  ADD COLUMN IF NOT EXISTS despachado_en timestamptz,
  ADD COLUMN IF NOT EXISTS entregado_en  timestamptz,
  ADD COLUMN IF NOT EXISTS entrega_obs   text;
DO $$ BEGIN
  ALTER TABLE core.pedido ADD CONSTRAINT ck_pedido_tipo_entrega CHECK (tipo_entrega IN ('RECOJO','DELIVERY'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE core.pedido_detalle ADD COLUMN IF NOT EXISTS cantidad_despachada numeric(18,6) NOT NULL DEFAULT 0;

-- RN-29: disponible = stock físico − reservado por pedidos listos. PED-04: anticipación mínima.
ALTER TABLE core.producto
  ADD COLUMN IF NOT EXISTS reservado          numeric(18,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS anticipacion_horas integer NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE core.producto ADD CONSTRAINT ck_producto_reservado CHECK (reservado >= 0 AND anticipacion_horas BETWEEN 0 AND 720);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Direcciones de entrega del cliente (A12).
CREATE TABLE IF NOT EXISTS core.direccion_cliente (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL REFERENCES core.cliente(id) ON DELETE CASCADE,
  direccion  text NOT NULL CHECK (length(trim(direccion)) BETWEEN 5 AND 200),
  referencia text NOT NULL DEFAULT '',
  creado_en  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_direccion_cliente ON core.direccion_cliente (cliente_id);

-- SEG-04 / CP-04: el documento del cliente no se repite.
-- Si una base antigua ya trae duplicados, la validación queda en el API y el índice se crea al depurarlos.
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS ux_cliente_documento ON core.cliente (doc_tipo, doc_numero) WHERE coalesce(doc_numero, '') <> '';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'Hay documentos de cliente repetidos: depúralos para activar la unicidad en la base.';
END $$;
