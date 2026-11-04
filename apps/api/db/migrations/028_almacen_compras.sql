-- =====================================================================
--  028 · Almacén según INF-TEC-001 (M05)
--  MAE-09 proveedores · AIN compras con documento y CPP · AIN conteo físico con aprobación del Gerente
-- =====================================================================

-- Proveedores (MAE-09): RUC único; con compras solo se inactiva.
CREATE TABLE IF NOT EXISTS core.proveedor (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ruc          text CHECK (ruc ~ '^(10|15|17|20)\d{9}$'),
  razon_social text NOT NULL CHECK (length(trim(razon_social)) >= 2),
  contacto     text NOT NULL DEFAULT '',
  telefono     text NOT NULL DEFAULT '',
  email        text NOT NULL DEFAULT '',
  estado       text NOT NULL DEFAULT 'ACTIVO' CHECK (estado IN ('ACTIVO','INACTIVO')),
  creado_en    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_proveedor_ruc ON core.proveedor (ruc) WHERE ruc IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_proveedor_nombre ON core.proveedor (lower(razon_social));

-- El insumo apunta a su proveedor habitual (MAE-01). El texto anterior pasa a la tabla.
ALTER TABLE core.insumo ADD COLUMN IF NOT EXISTS proveedor_id uuid REFERENCES core.proveedor(id);
INSERT INTO core.proveedor (razon_social)
SELECT DISTINCT trim(proveedor) FROM core.insumo WHERE trim(proveedor) <> ''
ON CONFLICT DO NOTHING;
UPDATE core.insumo i SET proveedor_id = p.id FROM core.proveedor p
WHERE i.proveedor_id IS NULL AND lower(trim(i.proveedor)) = lower(p.razon_social);

-- Compra: un documento del proveedor con varias líneas; cada línea es una entrada al kárdex.
CREATE TABLE IF NOT EXISTS core.compra (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo          text NOT NULL UNIQUE,
  proveedor_id    uuid NOT NULL REFERENCES core.proveedor(id),
  doc_tipo        text NOT NULL CHECK (doc_tipo IN ('FACTURA','BOLETA','GUIA')),
  doc_numero      text NOT NULL CHECK (length(trim(doc_numero)) >= 3),
  total           numeric(16,2) NOT NULL CHECK (total > 0),
  registrado_por  uuid REFERENCES core.usuario(id),
  idempotency_key text UNIQUE,
  creado_en       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proveedor_id, doc_tipo, doc_numero)
);
CREATE TABLE IF NOT EXISTS core.compra_detalle (
  compra_id    uuid NOT NULL REFERENCES core.compra(id) ON DELETE CASCADE,
  insumo_id    uuid NOT NULL REFERENCES core.insumo(id),
  cantidad     numeric(18,6) NOT NULL CHECK (cantidad > 0),
  precio       numeric(18,6) NOT NULL CHECK (precio > 0),
  cpp_anterior numeric(18,6) NOT NULL,
  cpp_nuevo    numeric(18,6) NOT NULL,
  PRIMARY KEY (compra_id, insumo_id)
);

-- Conteo físico: el Almacén cuenta, el Gerente aprueba y recién entonces se ajusta el stock.
CREATE TABLE IF NOT EXISTS core.conteo (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo         text NOT NULL UNIQUE,
  estado         text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE','APROBADO','RECHAZADO')),
  observacion    text NOT NULL DEFAULT '',
  registrado_por uuid REFERENCES core.usuario(id),
  resuelto_por   uuid REFERENCES core.usuario(id),
  resuelto_en    timestamptz,
  motivo_rechazo text,
  creado_en      timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS core.conteo_detalle (
  conteo_id     uuid NOT NULL REFERENCES core.conteo(id) ON DELETE CASCADE,
  insumo_id     uuid NOT NULL REFERENCES core.insumo(id),
  stock_sistema numeric(18,6) NOT NULL,
  contado       numeric(18,6) NOT NULL CHECK (contado >= 0),
  PRIMARY KEY (conteo_id, insumo_id)
);

INSERT INTO core.permiso (id, grupo, descripcion) VALUES
  ('proveedores.gestionar', 'Almacén', 'Registrar y editar proveedores'),
  ('compras.registrar', 'Almacén', 'Registrar compras de insumos con su documento'),
  ('conteo.aprobar', 'Almacén', 'Aprobar las diferencias del conteo físico')
ON CONFLICT (id) DO NOTHING;
INSERT INTO core.rol_permiso (rol_id, permiso_id)
SELECT r, p FROM (VALUES ('SUPERADMIN','proveedores.gestionar'), ('ADMINISTRADOR','proveedores.gestionar'), ('ALMACEN','proveedores.gestionar'),
  ('SUPERADMIN','compras.registrar'), ('ALMACEN','compras.registrar'),
  ('SUPERADMIN','conteo.aprobar'), ('GERENTE','conteo.aprobar')) v(r, p)
WHERE EXISTS (SELECT 1 FROM core.rol WHERE id = r)
ON CONFLICT DO NOTHING;
INSERT INTO core.navegacion (id, grupo, etiqueta, ruta, icono, permiso_id, orden, grupo_orden) VALUES
  ('n-compras', 'Operación', 'Compras', '/almacen/compras', 'sack', 'compras.registrar', 6, 1),
  ('n-conteos', 'Operación', 'Conteo físico', '/almacen/conteos', 'clipboard', 'inventario.ver', 7, 1),
  ('n-proveedores', 'Maestros', 'Proveedores', '/maestros/proveedores', 'truck', 'proveedores.gestionar', 4, 3)
ON CONFLICT (id) DO NOTHING;
