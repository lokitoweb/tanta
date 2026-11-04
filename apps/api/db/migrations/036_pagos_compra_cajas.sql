-- =====================================================================
--  036 · Deudas por pagar y cajas (Informe de Análisis de Compra de Insumos v1.1)
--  · PAGO_COMPRA: varios pagos por compra, desde caja chica o caja grande, con medio y n.° de operación (RN-10, RN-12).
--  · Caja chica: la abre el vendedor con un monto inicial; un pago desde ella requiere apertura vigente y no supera
--    su saldo disponible = monto inicial − pagos vigentes (RN-11). Caja grande: efectivo y medios digitales o bancarios.
--  · Saldo de la compra = total − pagos vigentes; estado del pago PENDIENTE, PARCIAL o PAGADO (3.2, RN-13).
--  · Al anular una compra sus pagos pasan a ANULADO (RN-09).
-- =====================================================================

CREATE TABLE IF NOT EXISTS core.caja_apertura (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo        text NOT NULL UNIQUE,
  tipo          text NOT NULL DEFAULT 'CHICA' CHECK (tipo = 'CHICA'),
  monto_inicial numeric(14,2) NOT NULL CHECK (monto_inicial > 0),
  estado        text NOT NULL DEFAULT 'ABIERTA' CHECK (estado IN ('ABIERTA','CERRADA')),
  abierta_por   uuid NOT NULL REFERENCES core.usuario(id),
  abierta_en    timestamptz NOT NULL DEFAULT now(),
  cerrada_por   uuid REFERENCES core.usuario(id),
  cerrada_en    timestamptz,
  monto_contado numeric(14,2),
  observacion   text
);
-- Una sola caja chica abierta a la vez.
CREATE UNIQUE INDEX IF NOT EXISTS ux_caja_chica_abierta ON core.caja_apertura (tipo) WHERE estado = 'ABIERTA';

CREATE TABLE IF NOT EXISTS core.pago_compra (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo           text NOT NULL UNIQUE,
  compra_id        uuid NOT NULL REFERENCES core.compra(id),
  fecha_pago       timestamptz NOT NULL DEFAULT now(),
  caja             text NOT NULL CHECK (caja IN ('CHICA','GRANDE')),
  medio_pago       text NOT NULL CHECK (medio_pago IN ('EFECTIVO','PLIN','YAPE','TRANSFERENCIA','OTRO')),
  monto            numeric(14,2) NOT NULL CHECK (monto > 0),
  nro_operacion    text,
  apertura_id      uuid REFERENCES core.caja_apertura(id),
  usuario_autoriza uuid NOT NULL REFERENCES core.usuario(id),
  estado           text NOT NULL DEFAULT 'VIGENTE' CHECK (estado IN ('VIGENTE','ANULADO')),
  anulado_por      uuid REFERENCES core.usuario(id),
  anulado_en       timestamptz,
  motivo_anulacion text,
  idempotency_key  text UNIQUE,
  -- Caja chica: siempre contra una apertura y en efectivo. Digitales y transferencias: con n.° de operación.
  CHECK ((caja = 'CHICA') = (apertura_id IS NOT NULL)),
  CHECK (caja <> 'CHICA' OR medio_pago = 'EFECTIVO'),
  CHECK (medio_pago IN ('EFECTIVO','OTRO') OR length(trim(coalesce(nro_operacion, ''))) >= 3)
);
CREATE INDEX IF NOT EXISTS ix_pago_compra_compra ON core.pago_compra (compra_id) WHERE estado = 'VIGENTE';
CREATE INDEX IF NOT EXISTS ix_pago_compra_apertura ON core.pago_compra (apertura_id) WHERE estado = 'VIGENTE';

-- Recordatorio diario de deudas por vencer o vencidas (sección 8).
ALTER TABLE core.compra ADD COLUMN IF NOT EXISTS alerta_pago_en date;

INSERT INTO core.parametro (clave, valor, tipo, descripcion)
VALUES ('dias_alerta_pago', '3', 'numero', 'Días antes del vencimiento del pago de una compra para avisar a Administración')
ON CONFLICT (clave) DO NOTHING;

INSERT INTO core.permiso (id, grupo, descripcion) VALUES
  ('compras.pagar', 'Compras', 'Registrar pagos de compras y elegir caja y medio'),
  ('deudas.ver', 'Compras', 'Consultar las deudas por pagar a proveedores'),
  ('caja.abrir', 'Caja', 'Abrir y cerrar la caja chica')
ON CONFLICT (id) DO NOTHING;
INSERT INTO core.rol_permiso (rol_id, permiso_id)
SELECT r, p FROM (VALUES
  ('ADMINISTRADOR','compras.pagar'), ('ADMINISTRADOR','deudas.ver'),
  ('COMPRAS','deudas.ver'), ('GERENTE','deudas.ver'), ('VENDEDOR','caja.abrir'),
  ('SUPERADMIN','compras.pagar'), ('SUPERADMIN','deudas.ver'), ('SUPERADMIN','caja.abrir')) v(r, p)
WHERE EXISTS (SELECT 1 FROM core.rol WHERE id = r)
ON CONFLICT DO NOTHING;

INSERT INTO core.navegacion (id, grupo, etiqueta, ruta, icono, permiso_id, orden, grupo_orden) VALUES
  ('n-deudas', 'Operación', 'Deudas por pagar', '/compras/deudas', 'wallet', 'deudas.ver', 8, 1),
  ('n-caja', 'Comercial', 'Caja chica', '/caja', 'wallet', 'caja.abrir', 5, 2)
ON CONFLICT (id) DO NOTHING;
