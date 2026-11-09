-- =====================================================================
--  060 · Caja grande con cuentas y saldo; caja chica por usuario (audio del cliente, 09/11/2026)
--  · Caja grande = el repositorio de todos los ingresos: efectivo (caja fuerte) y cuentas bancarias o billeteras
--    (Yape, Plin). Cuentas administrables (Maestros → Catálogos); cada medio de pago indica a qué cuenta llega.
--  · Libro de movimientos: el saldo de una cuenta es la suma de sus movimientos vigentes (nada se borra: se anula).
--    Entran: rendiciones recibidas del vendedor (cada medio a su cuenta), cierre de caja chica (lo contado).
--    Salen: pagos a proveedores y de costos desde caja grande (sin superar el saldo), fondo de caja chica.
--    Entre cuentas: depósito del efectivo al banco. Saldo inicial y ajustes con motivo, con permiso.
--  · Caja chica: cada usuario que cobra abre la suya (una abierta por usuario); su fondo sale del efectivo de caja grande
--    y al cerrarla lo contado vuelve a caja grande.
-- =====================================================================

CREATE TABLE core.cuenta_caja (
  codigo  text PRIMARY KEY CHECK (codigo ~ '^[A-Z0-9][A-Z0-9_-]{1,19}$'),
  nombre  text NOT NULL,
  tipo    text NOT NULL CHECK (tipo IN ('EFECTIVO','BANCO','BILLETERA')),
  banco   text REFERENCES core.banco(codigo),
  numero  text,
  activo  boolean NOT NULL DEFAULT true,
  orden   integer NOT NULL DEFAULT 0
);
INSERT INTO core.cuenta_caja (codigo, nombre, tipo, orden) VALUES
  ('EFECTIVO', 'Efectivo (caja fuerte)', 'EFECTIVO', 1),
  ('BANCO', 'Cuenta bancaria principal', 'BANCO', 2);

-- A qué cuenta de caja grande llega lo cobrado con cada medio (el crédito no cobra: sin cuenta).
ALTER TABLE core.medio_pago ADD COLUMN cuenta_caja text REFERENCES core.cuenta_caja(codigo);
UPDATE core.medio_pago SET cuenta_caja = CASE WHEN caja_chica THEN 'EFECTIVO' ELSE 'BANCO' END WHERE NOT es_credito;

-- Numeración sin choques aunque dos personas registren a la vez (MCG-000001…).
CREATE SEQUENCE core.movimiento_caja_seq;
CREATE TABLE core.movimiento_caja (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo      text NOT NULL UNIQUE DEFAULT 'MCG-' || lpad(nextval('core.movimiento_caja_seq')::text, 6, '0'),
  cuenta      text NOT NULL REFERENCES core.cuenta_caja(codigo),
  tipo        text NOT NULL CHECK (tipo IN ('SALDO_INICIAL','AJUSTE','RENDICION','CIERRE_CAJA_CHICA','FONDO_CAJA_CHICA',
                                             'PAGO_COMPRA','PAGO_COSTO','DEPOSITO_SALIDA','DEPOSITO_ENTRADA')),
  monto       numeric(16,2) NOT NULL CHECK (monto <> 0),   -- + entra a la cuenta, − sale
  concepto    text NOT NULL,
  referencia  text,                                         -- código del documento de origen (PAG-…, CCH-…, rendición…)
  origen_id   uuid,                                         -- fila de origen: al anularla se anula su movimiento
  usuario_id  uuid NOT NULL REFERENCES core.usuario(id),
  creado_en   timestamptz NOT NULL DEFAULT now(),
  estado      text NOT NULL DEFAULT 'VIGENTE' CHECK (estado IN ('VIGENTE','ANULADO')),
  anulado_por uuid REFERENCES core.usuario(id),
  anulado_en  timestamptz,
  motivo_anulacion text
);
CREATE INDEX ix_movimiento_caja_cuenta ON core.movimiento_caja (cuenta, creado_en DESC);
CREATE INDEX ix_movimiento_caja_origen ON core.movimiento_caja (origen_id) WHERE origen_id IS NOT NULL;

CREATE OR REPLACE FUNCTION core.saldo_cuenta(p_cuenta text) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(monto), 0) FROM core.movimiento_caja WHERE cuenta = p_cuenta AND estado = 'VIGENTE'
$$;

-- Pagos desde caja grande: de qué cuenta salieron (los anteriores a esta versión no lo tenían).
ALTER TABLE core.pago_compra ADD COLUMN cuenta_caja text REFERENCES core.cuenta_caja(codigo);
ALTER TABLE core.pago_costo  ADD COLUMN cuenta_caja text REFERENCES core.cuenta_caja(codigo);
ALTER TABLE core.pago_compra ADD CONSTRAINT ck_pago_compra_cuenta CHECK (caja <> 'GRANDE' OR cuenta_caja IS NOT NULL) NOT VALID;
ALTER TABLE core.pago_costo  ADD CONSTRAINT ck_pago_costo_cuenta  CHECK (caja <> 'GRANDE' OR cuenta_caja IS NOT NULL) NOT VALID;

-- Caja chica por usuario: una abierta por persona (antes una sola para todos).
DROP INDEX IF EXISTS core.ux_caja_chica_abierta;
CREATE UNIQUE INDEX ux_caja_chica_abierta_usuario ON core.caja_apertura (abierta_por) WHERE estado = 'ABIERTA';
ALTER TABLE core.caja_apertura ADD COLUMN cuenta_origen text REFERENCES core.cuenta_caja(codigo);
-- Quien solo cobra puede abrir su caja sin fondo (0): sus gastos necesitan fondo, sus cobros no.
ALTER TABLE core.caja_apertura DROP CONSTRAINT IF EXISTS caja_apertura_monto_inicial_check;
ALTER TABLE core.caja_apertura ADD CONSTRAINT caja_apertura_monto_inicial_check CHECK (monto_inicial >= 0);

/* Permisos y menú (cada rol se sigue editando en Roles). */
INSERT INTO core.permiso (id, grupo, descripcion) VALUES
  ('caja.grande.ver', 'Caja', 'Ver la caja grande: saldo de cada cuenta y sus movimientos'),
  ('caja.grande.gestionar', 'Caja', 'Registrar saldo inicial, depósitos entre cuentas y ajustes de la caja grande')
ON CONFLICT (id) DO NOTHING;
INSERT INTO core.rol_permiso (rol_id, permiso_id)
SELECT r, p FROM (VALUES ('SUPERADMIN','caja.grande.ver'), ('SUPERADMIN','caja.grande.gestionar'), ('ADMINISTRADOR','caja.grande.ver'),
  ('ADMINISTRADOR','caja.grande.gestionar'), ('GERENTE','caja.grande.ver')) v(r, p)
WHERE EXISTS (SELECT 1 FROM core.rol WHERE id = v.r)
ON CONFLICT DO NOTHING;
INSERT INTO core.navegacion (id, grupo, etiqueta, ruta, icono, permiso_id, orden, grupo_orden) VALUES
  ('n-caja-grande', 'Operación', 'Caja grande', '/caja-grande', 'wallet', 'caja.grande.ver', 10, 1)
ON CONFLICT (id) DO NOTHING;
