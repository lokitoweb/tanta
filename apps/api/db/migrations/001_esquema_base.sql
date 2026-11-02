-- =====================================================================
--  001 · Esquema base del Sistema Integral de Gestión — Panadería Tanta
--  PostgreSQL 17 · esquemas core (negocio) y audit (trazabilidad)
--  Reglas: numeric exacto, sin float en dinero; borrado lógico; auditoría.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS report;

-- ---------------------------------------------------------------- roles
CREATE TABLE core.rol (
  id           text PRIMARY KEY,
  nombre       text NOT NULL,
  corto        text NOT NULL,
  descripcion  text NOT NULL DEFAULT '',
  perfil       text NOT NULL CHECK (perfil IN ('web','tablet','app')),
  icono        text NOT NULL DEFAULT 'user',
  inicio       text NOT NULL DEFAULT '/panel',
  orden        smallint NOT NULL DEFAULT 0
);

CREATE TABLE core.permiso (
  id           text PRIMARY KEY,
  grupo        text NOT NULL,
  descripcion  text NOT NULL DEFAULT ''
);

CREATE TABLE core.rol_permiso (
  rol_id      text NOT NULL REFERENCES core.rol(id) ON DELETE CASCADE,
  permiso_id  text NOT NULL REFERENCES core.permiso(id) ON DELETE CASCADE,
  PRIMARY KEY (rol_id, permiso_id)
);
CREATE INDEX ix_rol_permiso_permiso ON core.rol_permiso (permiso_id);

-- -------------------------------------------------------- navegación
CREATE TABLE core.navegacion (
  id          text PRIMARY KEY,
  grupo       text NOT NULL,
  etiqueta    text NOT NULL,
  ruta        text NOT NULL,
  icono       text NOT NULL DEFAULT 'box',
  permiso_id  text NOT NULL REFERENCES core.permiso(id),
  orden       smallint NOT NULL DEFAULT 0,
  grupo_orden smallint NOT NULL DEFAULT 0
);
CREATE INDEX ix_navegacion_permiso ON core.navegacion (permiso_id);

-- ------------------------------------------------------------ usuarios
CREATE TABLE core.usuario (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre        text NOT NULL,
  usuario       text NOT NULL,
  clave_hash    text NOT NULL,
  estado        text NOT NULL DEFAULT 'ACTIVO' CHECK (estado IN ('ACTIVO','BLOQUEADO')),
  ultimo_acceso timestamptz,
  creado_en     timestamptz NOT NULL DEFAULT now()
);
-- login insensible a mayúsculas
CREATE UNIQUE INDEX ux_usuario_login ON core.usuario (lower(usuario));

CREATE TABLE core.usuario_rol (
  usuario_id uuid NOT NULL REFERENCES core.usuario(id) ON DELETE CASCADE,
  rol_id     text NOT NULL REFERENCES core.rol(id) ON DELETE RESTRICT,
  PRIMARY KEY (usuario_id, rol_id)
);

CREATE TABLE core.refresh_token (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id  uuid NOT NULL REFERENCES core.usuario(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  familia     uuid NOT NULL,
  expira_en   timestamptz NOT NULL,
  revocado_en timestamptz,
  creado_en   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_refresh_usuario ON core.refresh_token (usuario_id) WHERE revocado_en IS NULL;
CREATE INDEX ix_refresh_expira  ON core.refresh_token (expira_en);

-- ----------------------------------------------------------- parámetros
CREATE TABLE core.parametro (
  clave       text PRIMARY KEY,
  valor       text NOT NULL,
  tipo        text NOT NULL CHECK (tipo IN ('texto','numero','porcentaje','booleano')),
  descripcion text NOT NULL DEFAULT ''
);

-- --------------------------------------------------------------- maestros
CREATE TABLE core.categoria (
  id              text PRIMARY KEY,
  nombre          text NOT NULL,
  margen_objetivo numeric(9,6) NOT NULL DEFAULT 0.5 CHECK (margen_objetivo >= 0 AND margen_objetivo < 1),
  orden           smallint NOT NULL DEFAULT 0
);

CREATE TABLE core.producto (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo          text NOT NULL UNIQUE,
  nombre          text NOT NULL,
  categoria_id    text NOT NULL REFERENCES core.categoria(id),
  unidad          text NOT NULL DEFAULT 'UNIDAD',
  precio_con_igv  numeric(16,4) NOT NULL CHECK (precio_con_igv >= 0),
  costo_unitario  numeric(18,6) NOT NULL DEFAULT 0 CHECK (costo_unitario >= 0),
  merma_pct       numeric(9,6) NOT NULL DEFAULT 0 CHECK (merma_pct >= 0 AND merma_pct < 1),
  vendidos_30d    integer NOT NULL DEFAULT 0,
  stock           numeric(18,6) NOT NULL DEFAULT 0,
  estado          text NOT NULL DEFAULT 'ACTIVO' CHECK (estado IN ('ACTIVO','INACTIVO')),
  creado_en       timestamptz NOT NULL DEFAULT now()
);
-- consultas del catálogo: activos por categoría, ordenados por nombre
CREATE INDEX ix_producto_categoria ON core.producto (categoria_id, nombre) WHERE estado = 'ACTIVO';
CREATE INDEX ix_producto_nombre_trgm ON core.producto (lower(nombre));

CREATE TABLE core.insumo (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo      text NOT NULL UNIQUE,
  nombre      text NOT NULL,
  unidad      text NOT NULL,
  cpp         numeric(18,6) NOT NULL DEFAULT 0 CHECK (cpp >= 0),
  stock       numeric(18,6) NOT NULL DEFAULT 0,
  minimo      numeric(18,6) NOT NULL DEFAULT 0,
  proveedor   text NOT NULL DEFAULT '',
  estado      text NOT NULL DEFAULT 'OK' CHECK (estado IN ('OK','BAJO_MINIMO')),
  actualizado_en timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_insumo_bajo_minimo ON core.insumo (nombre) WHERE estado = 'BAJO_MINIMO';

CREATE TABLE core.cliente (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo         text NOT NULL UNIQUE,
  nombre         text NOT NULL,
  doc_tipo       text NOT NULL DEFAULT 'DNI' CHECK (doc_tipo IN ('DNI','RUC','CE')),
  doc_numero     text,
  telefono       text,
  lista_precio   text NOT NULL DEFAULT 'MINORISTA',
  dias_credito   smallint NOT NULL DEFAULT 0 CHECK (dias_credito >= 0),
  limite_credito numeric(16,4) NOT NULL DEFAULT 0 CHECK (limite_credito >= 0),
  creado_en      timestamptz NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------- recetas
CREATE TABLE core.receta (
  id               uuid PRIMARY KEY REFERENCES core.producto(id) ON DELETE CASCADE,
  producto_id      uuid NOT NULL UNIQUE REFERENCES core.producto(id) ON DELETE CASCADE,
  producto         text NOT NULL,
  version          integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  estado           text NOT NULL DEFAULT 'VIGENTE' CHECK (estado IN ('BORRADOR','VIGENTE','OBSOLETA')),
  rendimiento      numeric(18,6) NOT NULL CHECK (rendimiento > 0),
  merma_estandar   numeric(9,6) NOT NULL DEFAULT 0 CHECK (merma_estandar >= 0 AND merma_estandar < 1),
  costo_insumos    numeric(18,6) NOT NULL DEFAULT 0,
  costo_con_merma  numeric(18,6) NOT NULL DEFAULT 0,
  cif_unitario     numeric(18,6) NOT NULL DEFAULT 0,
  creado_en        timestamptz NOT NULL DEFAULT now()
);
-- una sola versión vigente por producto
CREATE UNIQUE INDEX ux_receta_vigente ON core.receta (producto_id) WHERE estado = 'VIGENTE';

CREATE TABLE core.receta_detalle (
  receta_id   uuid NOT NULL REFERENCES core.receta(id) ON DELETE CASCADE,
  insumo_id   uuid NOT NULL REFERENCES core.insumo(id),
  insumo      text NOT NULL,
  unidad      text NOT NULL,
  cantidad    numeric(18,6) NOT NULL CHECK (cantidad > 0),
  cpp         numeric(18,6) NOT NULL DEFAULT 0,
  costo       numeric(18,6) NOT NULL DEFAULT 0,
  orden       smallint NOT NULL DEFAULT 1,
  PRIMARY KEY (receta_id, insumo_id)
);
CREATE INDEX ix_receta_detalle_insumo ON core.receta_detalle (insumo_id);

-- ------------------------------------------------------------ inventario
CREATE TABLE core.movimiento_inventario (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tipo                text NOT NULL CHECK (tipo IN ('APERTURA','COMPRA','CONSUMO_OP','MERMA','INGRESO_PRODUCCION','VENTA','DEVOLUCION','AJUSTE')),
  item_tipo           text NOT NULL CHECK (item_tipo IN ('INSUMO','PRODUCTO')),
  insumo_id           uuid REFERENCES core.insumo(id),
  producto_id         uuid REFERENCES core.producto(id),
  documento           text NOT NULL DEFAULT '',
  cantidad            numeric(18,6) NOT NULL,
  costo_unitario      numeric(18,6) NOT NULL DEFAULT 0,
  valor               numeric(16,4) NOT NULL DEFAULT 0,
  saldo_cantidad      numeric(18,6) NOT NULL,
  saldo_valor         numeric(16,4) NOT NULL,
  cpp                 numeric(18,6),
  idempotency_key     text UNIQUE,
  registrado_por      uuid REFERENCES core.usuario(id),
  creado_en           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_mov_item CHECK (
    (item_tipo = 'INSUMO'   AND insumo_id IS NOT NULL AND producto_id IS NULL) OR
    (item_tipo = 'PRODUCTO' AND producto_id IS NOT NULL AND insumo_id IS NULL)
  )
);
-- kárdex: último movimiento por ítem, sin escanear la tabla
CREATE INDEX ix_mov_insumo   ON core.movimiento_inventario (insumo_id, id DESC)   WHERE insumo_id IS NOT NULL;
CREATE INDEX ix_mov_producto ON core.movimiento_inventario (producto_id, id DESC) WHERE producto_id IS NOT NULL;
CREATE INDEX ix_mov_creado   ON core.movimiento_inventario (creado_en DESC);
CREATE INDEX ix_mov_tipo     ON core.movimiento_inventario (tipo, creado_en DESC);

-- ------------------------------------------------------------ producción
CREATE TABLE core.orden_produccion (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo         text NOT NULL UNIQUE,
  producto_id    uuid NOT NULL REFERENCES core.producto(id),
  producto       text NOT NULL,
  receta_id      uuid NOT NULL REFERENCES core.receta(id),
  cantidad       numeric(18,6) NOT NULL CHECK (cantidad > 0),
  estado         text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE','EN_PROCESO','TERMINADA','ANULADA')),
  entrega        date NOT NULL,
  responsable    text NOT NULL,
  avance         numeric(5,4) NOT NULL DEFAULT 0 CHECK (avance >= 0 AND avance <= 1),
  merma_esperada numeric(9,6) NOT NULL DEFAULT 0.03,
  merma_real     numeric(9,6),
  iniciada_en    timestamptz,
  terminada_en   timestamptz,
  creado_en      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_op_estado_entrega ON core.orden_produccion (estado, entrega);
CREATE INDEX ix_op_hoy ON core.orden_produccion (entrega) WHERE estado <> 'TERMINADA';

-- ------------------------------------------------------------------ ventas
CREATE TABLE core.pedido (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo        text NOT NULL UNIQUE,
  cliente_id    uuid NOT NULL REFERENCES core.cliente(id),
  cliente       text NOT NULL,
  vendedor      text NOT NULL DEFAULT '—',
  estado        text NOT NULL DEFAULT 'REGISTRADO'
                CHECK (estado IN ('REGISTRADO','EN_PRODUCCION','LISTO','DESPACHADO','ENTREGADO','CANCELADO')),
  total         numeric(16,4) NOT NULL DEFAULT 0 CHECK (total >= 0),
  fecha_entrega date NOT NULL,
  creado_en     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_pedido_estado  ON core.pedido (estado, fecha_entrega);
CREATE INDEX ix_pedido_cliente ON core.pedido (cliente_id, creado_en DESC);
CREATE INDEX ix_pedido_abiertos ON core.pedido (fecha_entrega) WHERE estado IN ('REGISTRADO','EN_PRODUCCION','LISTO');

CREATE TABLE core.venta (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo         text NOT NULL UNIQUE,
  cliente_id     uuid REFERENCES core.cliente(id),
  forma_pago     text NOT NULL DEFAULT 'EFECTIVO' CHECK (forma_pago IN ('EFECTIVO','TRANSFERENCIA','YAPE','PLIN','CREDITO')),
  ventas_netas   numeric(16,4) NOT NULL CHECK (ventas_netas >= 0),
  costo_ventas   numeric(16,4) NOT NULL CHECK (costo_ventas >= 0),
  utilidad       numeric(16,4) NOT NULL,
  margen         numeric(9,6) NOT NULL,
  estado         text NOT NULL DEFAULT 'CONFIRMADA' CHECK (estado IN ('CONFIRMADA','ANULADA')),
  vendedor       text NOT NULL DEFAULT '',
  idempotency_key text UNIQUE,
  creado_en      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_venta_fecha   ON core.venta (creado_en DESC) WHERE estado = 'CONFIRMADA';
CREATE INDEX ix_venta_cliente ON core.venta (cliente_id, creado_en DESC);

CREATE TABLE core.venta_detalle (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  venta_id        uuid NOT NULL REFERENCES core.venta(id) ON DELETE CASCADE,
  producto_id     uuid NOT NULL REFERENCES core.producto(id),
  producto        text NOT NULL,
  cantidad        numeric(18,6) NOT NULL CHECK (cantidad > 0),
  precio_con_igv  numeric(16,4) NOT NULL,
  precio_neto     numeric(16,4) NOT NULL,
  costo_unitario  numeric(18,6) NOT NULL,   -- congelado: no cambia si sube la harina
  utilidad        numeric(16,4) NOT NULL,
  margen          numeric(9,6) NOT NULL
);
CREATE INDEX ix_vd_venta    ON core.venta_detalle (venta_id);
CREATE INDEX ix_vd_producto ON core.venta_detalle (producto_id);

CREATE TABLE core.cuenta_por_cobrar (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id  uuid NOT NULL REFERENCES core.cliente(id),
  venta_id    uuid REFERENCES core.venta(id),
  monto       numeric(16,4) NOT NULL CHECK (monto > 0),
  saldo       numeric(16,4) NOT NULL CHECK (saldo >= 0),
  vence_en    date NOT NULL,
  estado      text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE','PARCIAL','PAGADA','ANULADA')),
  creado_en   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_cxc_cliente ON core.cuenta_por_cobrar (cliente_id, vence_en);
CREATE INDEX ix_cxc_pendientes ON core.cuenta_por_cobrar (vence_en) WHERE estado IN ('PENDIENTE','PARCIAL');

CREATE TABLE core.cobranza (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cxc_id          uuid NOT NULL REFERENCES core.cuenta_por_cobrar(id),
  monto           numeric(16,4) NOT NULL CHECK (monto > 0),
  medio           text NOT NULL CHECK (medio IN ('EFECTIVO','TRANSFERENCIA','YAPE','PLIN')),
  referencia      text,
  registrado_por  uuid REFERENCES core.usuario(id),
  idempotency_key text UNIQUE,
  creado_en       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_cobranza_cxc ON core.cobranza (cxc_id, creado_en DESC);

-- --------------------------------------------------------------- costos
CREATE TABLE core.periodo_costos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anio         smallint NOT NULL CHECK (anio BETWEEN 2020 AND 2100),
  mes          smallint NOT NULL CHECK (mes BETWEEN 1 AND 12),
  estado       text NOT NULL DEFAULT 'ABIERTO' CHECK (estado IN ('ABIERTO','CALCULADO','CERRADO')),
  cif_total    numeric(16,4) NOT NULL DEFAULT 0,
  cerrado_en   timestamptz,
  UNIQUE (anio, mes)
);

-- -------------------------------------------------------------- seguridad
CREATE TABLE core.idempotencia (
  clave       text PRIMARY KEY,
  usuario_id  uuid REFERENCES core.usuario(id),
  ruta        text NOT NULL,
  respuesta   jsonb,
  expira_en   timestamptz NOT NULL,
  creado_en   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_idempotencia_expira ON core.idempotencia (expira_en);

CREATE TABLE audit.evento (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id     uuid REFERENCES core.usuario(id),
  actor        text NOT NULL DEFAULT '',
  rol          text NOT NULL DEFAULT '',
  accion       text NOT NULL,
  entidad      text NOT NULL,
  entidad_id   text,
  detalle      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip           inet,
  hash_anterior text,
  hash_actual  text,
  creado_en    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_creado  ON audit.evento (creado_en DESC);
CREATE INDEX ix_audit_entidad ON audit.evento (entidad, entidad_id, creado_en DESC);
CREATE INDEX ix_audit_actor   ON audit.evento (actor_id, creado_en DESC);

-- ------------------------------------------------------------ reportes
-- Vista del día: base del dashboard y de G-01
CREATE VIEW report.v_venta_dia AS
SELECT
  (creado_en AT TIME ZONE 'America/Lima')::date AS fecha,
  sum(ventas_netas)                            AS ventas_netas,
  sum(costo_ventas)                            AS costo,
  sum(utilidad)                                AS utilidad,
  count(*)                                     AS tickets
FROM core.venta
WHERE estado = 'CONFIRMADA'
GROUP BY 1;
