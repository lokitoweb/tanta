-- Informe «Modificaciones sistema Tanta 02»: voucher en cobranza, despacho con móvil y empaques, gastos,
-- entrega según hora de corte, promociones con stock, hoja de producción por lote.
-- Todo se suma a lo existente: roles, catálogos y parámetros siguen siendo administrables.

/* Entrega: el pedido hecho antes de esta hora se entrega el mismo día; después, al día siguiente. */
INSERT INTO core.parametro (clave, valor, tipo, descripcion) VALUES
  ('hora_corte_mismo_dia', '03:00', 'texto', 'Hora límite (HH:MM) para entregar un pedido el mismo día; después se entrega al día siguiente')
ON CONFLICT (clave) DO NOTHING;

/* Voucher del cobro. */
ALTER TABLE core.recibo ADD COLUMN comprobante_id uuid REFERENCES core.archivo(id) ON DELETE SET NULL;

/* Tipos de gasto administrables en Catálogos. */
CREATE TABLE core.tipo_gasto (
  codigo text PRIMARY KEY,
  nombre text NOT NULL,
  activo boolean NOT NULL DEFAULT true,
  orden  integer NOT NULL DEFAULT 0
);
INSERT INTO core.tipo_gasto (codigo, nombre, orden) VALUES
  ('VENTAS', 'Gasto de ventas', 1), ('DISTRIBUCION', 'Gasto de distribución', 2),
  ('OPERATIVO', 'Gasto operativo', 3), ('ADMINISTRATIVO', 'Gasto administrativo', 4);

ALTER TABLE core.pago_costo
  ADD COLUMN doc_tipo text REFERENCES core.tipo_documento_compra(codigo),
  ADD COLUMN doc_serie text,
  ADD COLUMN doc_numero text,
  ADD COLUMN tipo_gasto text REFERENCES core.tipo_gasto(codigo),
  ADD COLUMN autorizado_por text;

/* Empaques: el tipo de insumo dice qué materiales puede usar Despacho. */
ALTER TABLE core.tipo_insumo ADD COLUMN es_empaque boolean NOT NULL DEFAULT false;
INSERT INTO core.tipo_insumo (codigo, nombre, es_empaque, orden) VALUES ('EMPAQUE', 'Material de empaque', true, 90)
ON CONFLICT (codigo) DO UPDATE SET es_empaque = true;

/* Vehículos de reparto. */
CREATE TABLE core.vehiculo (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  placa       text NOT NULL UNIQUE,
  descripcion text NOT NULL DEFAULT '',
  conductor   text NOT NULL DEFAULT '',
  activo      boolean NOT NULL DEFAULT true,
  creado_en   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE core.pedido ADD COLUMN vehiculo_id uuid REFERENCES core.vehiculo(id);

CREATE TABLE core.pedido_empaque (
  id             bigserial PRIMARY KEY,
  pedido_id      uuid NOT NULL REFERENCES core.pedido(id) ON DELETE CASCADE,
  insumo_id      uuid NOT NULL REFERENCES core.insumo(id),
  insumo         text NOT NULL,
  cantidad       numeric(16,6) NOT NULL CHECK (cantidad > 0),
  registrado_por uuid NOT NULL REFERENCES core.usuario(id),
  creado_en      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_pedido_empaque_pedido ON core.pedido_empaque (pedido_id);

/* Promociones: venden el sobrante en stock, con precio propio; no entran a producción. */
CREATE TABLE core.promocion (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  producto_id   uuid NOT NULL REFERENCES core.producto(id),
  titulo        text NOT NULL,
  precio_con_igv numeric(16,4) NOT NULL CHECK (precio_con_igv > 0),
  desde         date NOT NULL,
  hasta         date NOT NULL,
  activa        boolean NOT NULL DEFAULT true,
  creado_por    uuid NOT NULL REFERENCES core.usuario(id),
  creado_en     timestamptz NOT NULL DEFAULT now(),
  CHECK (hasta >= desde)
);
CREATE INDEX ix_promocion_vigente ON core.promocion (activa, desde, hasta);
ALTER TABLE core.pedido_detalle ADD COLUMN promocion_id uuid REFERENCES core.promocion(id);

/* Hoja de producción: agrupa los pedidos de un día en un lote (LOT 1001…). */
CREATE SEQUENCE core.hoja_produccion_seq START 1001;
CREATE TABLE core.hoja_produccion (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo         text NOT NULL UNIQUE,
  fecha          date NOT NULL,
  estado         text NOT NULL DEFAULT 'EN_PRODUCCION' CHECK (estado IN ('EN_PRODUCCION','CERRADA')),
  cerrada_por    uuid REFERENCES core.usuario(id),
  cerrada_en     timestamptz,
  creado_por     uuid NOT NULL REFERENCES core.usuario(id),
  creado_en      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_hoja_produccion_fecha ON core.hoja_produccion (fecha DESC);
ALTER TABLE core.orden_produccion ADD COLUMN hoja_id uuid REFERENCES core.hoja_produccion(id);
ALTER TABLE core.pedido ADD COLUMN hoja_id uuid REFERENCES core.hoja_produccion(id);
CREATE INDEX ix_orden_produccion_hoja ON core.orden_produccion (hoja_id) WHERE hoja_id IS NOT NULL;
CREATE INDEX ix_pedido_hoja ON core.pedido (hoja_id) WHERE hoja_id IS NOT NULL;

/* Permisos y rol Despacho: las personas y lo que ve cada rol se administran en Roles y permisos. */
INSERT INTO core.permiso (id, grupo, descripcion) VALUES
  ('despacho.ver', 'Despacho', 'Ver los pedidos por despachar y en tránsito'),
  ('despacho.gestionar', 'Despacho', 'Cargar pedidos a una móvil, usar empaques y administrar vehículos'),
  ('gastos.registrar', 'Caja', 'Registrar gastos de caja chica (menú, gasolina, distribución…)'),
  ('promociones.gestionar', 'Clientes', 'Crear y editar promociones')
ON CONFLICT (id) DO NOTHING;

INSERT INTO core.rol (id, nombre, corto, descripcion, perfil, icono, orden)
VALUES ('DESPACHO', 'Despacho', 'Despacho', 'Empaca los pedidos, usa materiales de empaque y los carga a la móvil', 'app', 'truck', 9)
ON CONFLICT (id) DO NOTHING;

INSERT INTO core.rol_permiso (rol_id, permiso_id) VALUES
  ('DESPACHO', 'panel.ver'), ('DESPACHO', 'despacho.ver'), ('DESPACHO', 'despacho.gestionar'),
  ('GERENTE', 'despacho.ver'), ('GERENTE', 'despacho.gestionar'), ('ADMINISTRADOR', 'despacho.ver'), ('ADMINISTRADOR', 'despacho.gestionar'),
  ('VENDEDOR', 'gastos.registrar'), ('ADMINISTRADOR', 'gastos.registrar'), ('GERENTE', 'gastos.registrar'),
  ('ADMINISTRADOR', 'promociones.gestionar'), ('GERENTE', 'promociones.gestionar')
ON CONFLICT DO NOTHING;

INSERT INTO core.navegacion (id, grupo, etiqueta, ruta, icono, permiso_id, orden, grupo_orden) VALUES
  ('n-despacho', 'Comercial', 'Despacho', '/ventas/despacho', 'truck', 'despacho.ver', 6, 3),
  ('n-gastos', 'Comercial', 'Gastos', '/ventas/gastos', 'wallet', 'gastos.registrar', 7, 3),
  ('n-promociones', 'Comercial', 'Promociones', '/ventas/promociones', 'tag', 'promociones.gestionar', 8, 3)
ON CONFLICT (id) DO NOTHING;
INSERT INTO core.navegacion (id, grupo, etiqueta, ruta, icono, permiso_id, orden, grupo_orden)
SELECT 'n-hoja-produccion', grupo, 'Hoja de producción', '/produccion/hoja', 'clipboard', 'produccion.ver', orden + 1, grupo_orden FROM core.navegacion WHERE ruta = '/produccion'
ON CONFLICT (id) DO NOTHING;
INSERT INTO core.navegacion (id, grupo, etiqueta, ruta, icono, permiso_id, orden, grupo_orden)
SELECT 'n-punto-equilibrio', grupo, 'Punto de equilibrio', '/gerencia/punto-equilibrio', 'chart', 'costos.ver', orden + 1, grupo_orden FROM core.navegacion WHERE ruta = '/gerencia/reportes'
ON CONFLICT (id) DO NOTHING;
