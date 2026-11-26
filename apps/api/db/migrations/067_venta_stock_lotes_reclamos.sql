-- =====================================================================
--  067 · Respuestas del ingeniero a la propuesta «pedidos de producción y ventas de stock» (25-nov-2026)
--  1) Pan por lote con vencimiento: cada ingreso de producto crea su lote; las ventas toman primero el que vence
--     antes y nunca el vencido; el retiro de vencidos (merma VENCIMIENTO) se lleva los vencidos.
--  2) Venta de stock: el vendedor vende lo que ya está hecho con precio por línea; bajar más del tope pide al Gerente.
--  3) Factura de SUNAT: se sube en PDF al pedido y el cliente la descarga.
--  4) Reclamos con seguimiento. 5) Turno de la hoja de producción. 6) Catálogos y parámetros nuevos.
-- =====================================================================

/* ---------------------------------------------------------------- 1) lotes de pan */
CREATE TABLE core.lote_producto (
  id               bigserial PRIMARY KEY,
  producto_id      uuid NOT NULL REFERENCES core.producto(id) ON DELETE CASCADE,
  lote             text NOT NULL,
  vence_en         date,
  cantidad_inicial numeric(18,6) NOT NULL CHECK (cantidad_inicial >= 0),
  saldo            numeric(18,6) NOT NULL CHECK (saldo >= 0),
  movimiento_id    bigint,
  alerta_en        timestamptz,
  creado_en        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_lote_producto_fefo ON core.lote_producto (producto_id, vence_en NULLS LAST, id) WHERE saldo > 0;
CREATE INDEX ix_lote_producto_vence ON core.lote_producto (vence_en) WHERE saldo > 0 AND vence_en IS NOT NULL;

CREATE OR REPLACE FUNCTION core.hoy_lima() RETURNS date LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'America/Lima')::date $$;

-- Saca `cantidad` del pan por FEFO. Con `vigentes_primero` (ventas, mermas comunes) lo vencido va al final:
-- una venta nunca se lleva primero un lote vencido. El retiro por vencimiento sí empieza por los vencidos.
CREATE OR REPLACE FUNCTION core.consumir_lotes_producto(p_producto uuid, p_cantidad numeric, p_vigentes_primero boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE l record; resto numeric := p_cantidad; toma numeric; hoy date := core.hoy_lima();
BEGIN
  FOR l IN SELECT id, saldo FROM core.lote_producto WHERE producto_id = p_producto AND saldo > 0
           ORDER BY CASE WHEN p_vigentes_primero AND vence_en < hoy THEN 1 ELSE 0 END, vence_en NULLS LAST, id FOR UPDATE LOOP
    EXIT WHEN resto <= 0;
    toma := least(l.saldo, resto);
    UPDATE core.lote_producto SET saldo = saldo - toma WHERE id = l.id;
    resto := resto - toma;
  END LOOP;
END $$;

-- Mismo trigger de los insumos (033/034), ahora también para el pan. Un ingreso sin vencimiento toma la vida útil del producto.
CREATE OR REPLACE FUNCTION core.lote_movimiento() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.cantidad = 0 OR NEW.tipo = 'REVERSA_COMPRA' THEN RETURN NULL; END IF;
  IF NEW.item_tipo = 'PRODUCTO' THEN
    IF NEW.cantidad > 0 THEN
      INSERT INTO core.lote_producto (producto_id, lote, vence_en, cantidad_inicial, saldo, movimiento_id)
      VALUES (NEW.producto_id, coalesce(nullif(trim(NEW.lote), ''), nullif(trim(NEW.documento), ''), 'S/L-' || NEW.id),
              coalesce(NEW.vence_en, core.hoy_lima() + (SELECT vida_util_dias FROM core.producto WHERE id = NEW.producto_id)),
              NEW.cantidad, NEW.cantidad, NEW.id);
    ELSE
      PERFORM core.consumir_lotes_producto(NEW.producto_id, -NEW.cantidad, NEW.motivo_tipo IS DISTINCT FROM 'VENCIMIENTO');
    END IF;
    RETURN NULL;
  END IF;
  IF NEW.item_tipo <> 'INSUMO' THEN RETURN NULL; END IF;
  IF NEW.cantidad > 0 THEN
    INSERT INTO core.lote_insumo (insumo_id, lote, vence_en, cantidad_inicial, saldo, movimiento_id)
    VALUES (NEW.insumo_id, coalesce(nullif(trim(NEW.lote), ''), 'S/L-' || NEW.id), NEW.vence_en, NEW.cantidad, NEW.cantidad, NEW.id);
  ELSE
    PERFORM core.consumir_lotes(NEW.insumo_id, -NEW.cantidad);
  END IF;
  RETURN NULL;
END $$;

-- El stock que ya había (sin lotes) entra como lote INICIAL, con la vida útil del producto contada desde hoy.
INSERT INTO core.lote_producto (producto_id, lote, vence_en, cantidad_inicial, saldo)
SELECT p.id, 'INICIAL', core.hoy_lima() + p.vida_util_dias, p.stock, p.stock FROM core.producto p WHERE p.stock > 0;

-- Pan vencido que aún figura en el almacén (no se puede vender: hay que retirarlo).
-- plpgsql y no sql: el plan queda en caché (en el catálogo de 200 panes, 80 ms en vez de 720 ms).
CREATE OR REPLACE FUNCTION core.producto_vencido(p_producto uuid) RETURNS numeric LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN (SELECT coalesce(sum(saldo), 0) FROM core.lote_producto WHERE producto_id = p_producto AND saldo > 0 AND vence_en < (now() AT TIME ZONE 'America/Lima')::date);
END $$;

-- Lo que se puede vender o apartar: stock − apartado − vencido (si Parámetros excluye lo vencido, que es lo normal).
CREATE OR REPLACE FUNCTION core.stock_libre(p_producto uuid) RETURNS numeric LANGUAGE plpgsql STABLE AS $$
DECLARE s numeric; r numeric; excluir boolean;
BEGIN
  SELECT stock, reservado INTO s, r FROM core.producto WHERE id = p_producto;
  IF NOT FOUND THEN RETURN NULL; END IF;
  excluir := coalesce((SELECT valor FROM core.parametro WHERE clave = 'excluir_pan_vencido'), 'true') = 'true';
  RETURN greatest(s - r - CASE WHEN excluir THEN core.producto_vencido(p_producto) ELSE 0 END, 0);
END $$;

/* ------------------------------------------------------------- 2) venta de stock */
-- es_oferta ya marcaba el pedido que no pasa por producción: desde aquí es el «pedido de stock» (lo registra el vendedor).
COMMENT ON COLUMN core.pedido.es_oferta IS 'Pedido de stock: sale de lo ya producido (no pasa por producción) y nace Listo para despacho';
ALTER TABLE core.pedido_detalle ADD COLUMN precio_lista numeric(18,4);
ALTER TABLE core.descuento_aprobacion ADD COLUMN pedido_id uuid REFERENCES core.pedido(id) ON DELETE SET NULL;

/* ------------------------------------------------------------ 3) factura de SUNAT */
-- Los archivos aceptan PDF (la factura); las imágenes siguen con su tope de 1 MB y el PDF con el de Parámetros (hasta 10 MB).
ALTER TABLE core.archivo DROP CONSTRAINT archivo_mime_check, DROP CONSTRAINT archivo_datos_check,
  ADD CONSTRAINT archivo_mime_check CHECK (mime IN ('image/png','image/jpeg','image/webp','application/pdf')),
  ADD CONSTRAINT archivo_datos_check CHECK (octet_length(datos) <= CASE WHEN mime = 'application/pdf' THEN 10485760 ELSE 1048576 END);
ALTER TABLE core.pedido
  ADD COLUMN factura_id        uuid REFERENCES core.archivo(id) ON DELETE SET NULL,
  ADD COLUMN factura_numero    text,
  ADD COLUMN factura_subida_en timestamptz,
  ADD COLUMN factura_subida_por uuid REFERENCES core.usuario(id);

/* --------------------------------------------------------------------- 4) reclamos */
CREATE TABLE core.tipo_reclamo (
  codigo text PRIMARY KEY CHECK (codigo ~ '^[A-Z][A-Z0-9_-]{1,19}$'),
  nombre text NOT NULL,
  activo boolean NOT NULL DEFAULT true,
  orden  integer NOT NULL DEFAULT 0
);
INSERT INTO core.tipo_reclamo (codigo, nombre, orden) VALUES
  ('PRODUCTO', 'Producto en mal estado', 1), ('FALTANTE', 'Faltó producto', 2), ('DEMORA', 'Demora en la entrega', 3),
  ('COBRO', 'Cobro o comprobante', 4), ('ATENCION', 'Atención', 5), ('OTRO', 'Otro', 9);

CREATE SEQUENCE core.reclamo_correlativo_seq;
CREATE TABLE core.reclamo (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo       text NOT NULL UNIQUE,
  cliente_id   uuid NOT NULL REFERENCES core.cliente(id),
  pedido_id    uuid REFERENCES core.pedido(id) ON DELETE SET NULL,
  tipo         text NOT NULL REFERENCES core.tipo_reclamo(codigo),
  descripcion  text NOT NULL CHECK (length(trim(descripcion)) >= 10),
  foto_id      uuid REFERENCES core.archivo(id) ON DELETE SET NULL,
  estado       text NOT NULL DEFAULT 'ABIERTO' CHECK (estado IN ('ABIERTO','EN_PROCESO','RESUELTO','CERRADO')),
  resolucion   text,
  asignado_a   uuid REFERENCES core.usuario(id),
  creado_por   uuid NOT NULL REFERENCES core.usuario(id),
  creado_en    timestamptz NOT NULL DEFAULT now(),
  resuelto_por uuid REFERENCES core.usuario(id),
  resuelto_en  timestamptz
);
CREATE INDEX ix_reclamo_cliente ON core.reclamo (cliente_id, creado_en DESC);
CREATE INDEX ix_reclamo_abierto ON core.reclamo (creado_en) WHERE estado IN ('ABIERTO','EN_PROCESO');

-- Cada paso del seguimiento: mensaje del cliente o de la panadería y, si cambió, el estado nuevo.
CREATE TABLE core.reclamo_seguimiento (
  id         bigserial PRIMARY KEY,
  reclamo_id uuid NOT NULL REFERENCES core.reclamo(id) ON DELETE CASCADE,
  usuario_id uuid NOT NULL REFERENCES core.usuario(id),
  autor      text NOT NULL,
  de_cliente boolean NOT NULL,
  mensaje    text NOT NULL CHECK (length(trim(mensaje)) >= 2),
  estado     text,
  creado_en  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_reclamo_seguimiento ON core.reclamo_seguimiento (reclamo_id, id);

/* ------------------------------------------------------------- 5) turno de la hoja */
CREATE TABLE core.turno_produccion (
  codigo text PRIMARY KEY CHECK (codigo ~ '^[A-Z][A-Z0-9_-]{1,19}$'),
  nombre text NOT NULL,
  activo boolean NOT NULL DEFAULT true,
  orden  integer NOT NULL DEFAULT 0
);
INSERT INTO core.turno_produccion (codigo, nombre, orden) VALUES ('MANANA', 'Mañana', 1), ('NOCHE', 'Noche', 2);
ALTER TABLE core.hoja_produccion ADD COLUMN turno text REFERENCES core.turno_produccion(codigo);

/* ------------------------------------------------------- 6) permisos, menú, parámetros */
INSERT INTO core.permiso (id, grupo, descripcion) VALUES
  ('ventas.stock', 'Ventas', 'Registrar ventas de stock: pan ya producido, con precio por producto, directo a despacho'),
  ('comprobantes.subir', 'Ventas', 'Subir la factura de SUNAT (PDF) a un pedido para que el cliente la descargue'),
  ('reclamos.ver', 'Reclamos', 'Ver los reclamos de los clientes y su seguimiento'),
  ('reclamos.gestionar', 'Reclamos', 'Atender reclamos: responder, cambiar su estado y resolverlos'),
  ('reclamos.crear', 'Reclamos', 'Registrar un reclamo (cliente) y seguirlo')
ON CONFLICT (id) DO NOTHING;
INSERT INTO core.rol_permiso (rol_id, permiso_id)
SELECT r, p FROM (VALUES
  ('VENDEDOR','ventas.stock'), ('ADMINISTRADOR','ventas.stock'), ('SUPERADMIN','ventas.stock'),
  ('VENDEDOR','comprobantes.subir'), ('ADMINISTRADOR','comprobantes.subir'), ('SUPERADMIN','comprobantes.subir'),
  ('VENDEDOR','reclamos.ver'), ('VENDEDOR','reclamos.gestionar'), ('ADMINISTRADOR','reclamos.ver'), ('ADMINISTRADOR','reclamos.gestionar'),
  ('GERENTE','reclamos.ver'), ('SUPERADMIN','reclamos.ver'), ('SUPERADMIN','reclamos.gestionar'),
  ('CLIENTE','reclamos.crear')) v(r, p)
WHERE EXISTS (SELECT 1 FROM core.rol WHERE id = r)
ON CONFLICT DO NOTHING;
INSERT INTO core.navegacion (id, grupo, etiqueta, ruta, icono, permiso_id, orden, grupo_orden) VALUES
  ('n-reclamos', 'Comercial', 'Reclamos', '/ventas/reclamos', 'bell', 'reclamos.ver', 9, 3),
  ('n-vencidos', 'Operación', 'Pan por vencer', '/almacen/vencimientos', 'box', 'inventario.ver', 4, 1)
ON CONFLICT (id) DO NOTHING;

INSERT INTO core.parametro (clave, valor, tipo, descripcion) VALUES
  -- El ingeniero decidió que toda rebaja la apruebe el Gerente: tope 0 (se puede subir aquí si luego dan un margen libre).
  ('venta_stock_descuento_maximo', '0', 'porcentaje', 'Venta de stock: cuánto puede bajar el vendedor el precio de lista sin aprobación (0 = toda rebaja la aprueba el Gerente; 0.10 = hasta 10 % sin aprobación)'),
  ('excluir_pan_vencido', 'true', 'booleano', 'El pan vencido no se vende ni se aparta: deja de contar como disponible hasta que Almacén lo retira'),
  ('ofertas_pedido_cliente', 'false', 'booleano', 'El cliente puede tomar ofertas desde la app (false = solo ve el aviso con precio y unidades; la venta la registra el vendedor)'),
  ('dias_alerta_vencimiento_pan', '1', 'numero', 'Días antes del vencimiento de un lote de pan para avisar a Almacén (0 = el mismo día)'),
  ('factura_max_mb', '3', 'numero', 'Tamaño máximo del PDF de la factura de SUNAT que se sube a un pedido (MB)')
ON CONFLICT (clave) DO NOTHING;

-- El ingeniero pidió quitar la boleta: se desactiva (el catálogo la conserva para los pedidos pasados; se puede reactivar).
UPDATE core.tipo_comprobante_venta SET activo = false WHERE codigo = 'BOLETA';
