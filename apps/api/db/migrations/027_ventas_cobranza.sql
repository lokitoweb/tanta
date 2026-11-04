-- =====================================================================
--  027 · Ventas y cobranza según INF-TEC-001 (M07, M08)
--  RN-31/32 nota de venta con serie, correlativo, base e IGV · COB-02 tarjeta y n.° de operación
--  RN-34 cobro aplicado a varios documentos (más antiguos primero) con recibo correlativo (COB-08)
--  RN-36 descuento sobre el tope con aprobación del Gerente · COB-03 condición de pago del cliente
-- =====================================================================

-- Series y correlativos (MAE-14): un número nunca se emite dos veces.
CREATE TABLE IF NOT EXISTS core.serie_comprobante (
  tipo               text NOT NULL CHECK (tipo IN ('NOTA_VENTA','RECIBO')),
  serie              text NOT NULL CHECK (serie ~ '^[A-Z0-9]{4}$'),
  correlativo_actual integer NOT NULL DEFAULT 0 CHECK (correlativo_actual >= 0),
  activo             boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tipo, serie)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_serie_activa ON core.serie_comprobante (tipo) WHERE activo;
INSERT INTO core.serie_comprobante (tipo, serie) VALUES ('NOTA_VENTA','NV01'), ('RECIBO','RC01') ON CONFLICT DO NOTHING;

-- Formas de pago con tarjeta (COB-02): se reemplazan las restricciones originales.
DO $$ DECLARE c text; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'core.venta'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%forma_pago%' LOOP
    EXECUTE format('ALTER TABLE core.venta DROP CONSTRAINT %I', c);
  END LOOP;
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'core.cobranza'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%medio%' LOOP
    EXECUTE format('ALTER TABLE core.cobranza DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE core.venta ADD CONSTRAINT ck_venta_forma_pago CHECK (forma_pago IN ('EFECTIVO','TRANSFERENCIA','YAPE','PLIN','TARJETA','CREDITO'));
ALTER TABLE core.cobranza ADD CONSTRAINT ck_cobranza_medio CHECK (medio IN ('EFECTIVO','TRANSFERENCIA','YAPE','PLIN','TARJETA'));

-- Comprobante de la venta: serie, correlativo, base, IGV y referencia del pago.
ALTER TABLE core.venta
  ADD COLUMN IF NOT EXISTS comprobante_tipo text NOT NULL DEFAULT 'NOTA_VENTA',
  ADD COLUMN IF NOT EXISTS serie            text,
  ADD COLUMN IF NOT EXISTS correlativo      integer,
  ADD COLUMN IF NOT EXISTS base             numeric(16,2),
  ADD COLUMN IF NOT EXISTS igv              numeric(16,2),
  ADD COLUMN IF NOT EXISTS referencia_pago  text;
CREATE UNIQUE INDEX IF NOT EXISTS ux_venta_comprobante ON core.venta (serie, correlativo) WHERE serie IS NOT NULL;

-- Recibo de cobranza: un pago del cliente que se aplica a uno o varios documentos.
CREATE TABLE IF NOT EXISTS core.recibo (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  numero         text NOT NULL UNIQUE,
  cliente_id     uuid NOT NULL REFERENCES core.cliente(id),
  monto          numeric(16,2) NOT NULL CHECK (monto > 0),
  medio          text NOT NULL CHECK (medio IN ('EFECTIVO','TRANSFERENCIA','YAPE','PLIN','TARJETA')),
  referencia     text,
  registrado_por uuid REFERENCES core.usuario(id),
  idempotency_key text UNIQUE,
  creado_en      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_recibo_fecha ON core.recibo (creado_en DESC);
CREATE INDEX IF NOT EXISTS ix_recibo_cliente ON core.recibo (cliente_id, creado_en DESC);
ALTER TABLE core.cobranza ADD COLUMN IF NOT EXISTS recibo_id uuid REFERENCES core.recibo(id);
CREATE INDEX IF NOT EXISTS ix_cobranza_recibo ON core.cobranza (recibo_id);

-- Condición de pago del cliente (COB-03) y vendedor asignado (MAE-08).
ALTER TABLE core.cliente
  ADD COLUMN IF NOT EXISTS condicion_pago text NOT NULL DEFAULT 'CONTADO',
  ADD COLUMN IF NOT EXISTS vendedor_id    uuid REFERENCES core.usuario(id);
DO $$ BEGIN
  ALTER TABLE core.cliente ADD CONSTRAINT ck_cliente_condicion CHECK (condicion_pago IN ('CONTADO','CREDITO'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Quien ya tenía línea o plazo de crédito queda como cliente al crédito.
UPDATE core.cliente SET condicion_pago = 'CREDITO' WHERE condicion_pago = 'CONTADO' AND (limite_credito > 0 OR dias_credito > 0);

-- Descuento sobre el tope: el vendedor solicita y el Gerente aprueba (VEN-07, RN-36).
CREATE TABLE IF NOT EXISTS core.descuento_aprobacion (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  solicitado_por uuid NOT NULL REFERENCES core.usuario(id),
  cliente_id     uuid REFERENCES core.cliente(id),
  porcentaje     numeric(9,6) NOT NULL CHECK (porcentaje > 0 AND porcentaje <= 0.9),
  motivo         text NOT NULL CHECK (length(trim(motivo)) >= 5),
  estado         text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE','APROBADA','RECHAZADA','USADA')),
  resuelto_por   uuid REFERENCES core.usuario(id),
  resuelto_en    timestamptz,
  venta_id       uuid REFERENCES core.venta(id),
  creado_en      timestamptz NOT NULL DEFAULT now(),
  expira_en      timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX IF NOT EXISTS ix_descuento_pendiente ON core.descuento_aprobacion (creado_en) WHERE estado = 'PENDIENTE';

INSERT INTO core.permiso (id, grupo, descripcion) VALUES
  ('descuentos.aprobar', 'Ventas', 'Aprobar descuentos mayores al máximo permitido')
ON CONFLICT (id) DO NOTHING;
INSERT INTO core.rol_permiso (rol_id, permiso_id)
SELECT r, 'descuentos.aprobar' FROM unnest(ARRAY['SUPERADMIN','GERENTE']) r
WHERE EXISTS (SELECT 1 FROM core.rol WHERE id = r)
ON CONFLICT DO NOTHING;
INSERT INTO core.navegacion (id, grupo, etiqueta, ruta, icono, permiso_id, orden, grupo_orden) VALUES
  ('n-aprobaciones', 'Comercial', 'Aprobaciones', '/ventas/aprobaciones', 'check', 'descuentos.aprobar', 4, 2)
ON CONFLICT (id) DO NOTHING;
