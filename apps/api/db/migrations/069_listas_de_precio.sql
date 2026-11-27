-- =====================================================================
--  069 · Listas de precios administrables (pedido del ingeniero, 26/11/2026)
--  Cada lista tiene su nombre y un precio propio por producto; varios clientes
--  comparten una lista. Un producto que no está en la lista se cobra al precio
--  del catálogo. La oferta vale para todos: su precio manda sobre cualquier lista.
--  cliente.lista_precio sigue siendo el código de la lista (ahora con llave foránea).
-- =====================================================================

CREATE TABLE IF NOT EXISTS core.lista_precio (
  codigo      text PRIMARY KEY CHECK (codigo ~ '^[A-Z0-9_]{2,40}$'),
  nombre      text NOT NULL CHECK (length(trim(nombre)) BETWEEN 2 AND 60),
  descripcion text NOT NULL DEFAULT '',
  activa      boolean NOT NULL DEFAULT true,
  orden       int NOT NULL DEFAULT 0,
  creado_en   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_lista_precio_nombre ON core.lista_precio (lower(nombre));

-- Las tres de siempre arrancan vacías: cobran el precio del catálogo hasta que se les ponga precio propio.
INSERT INTO core.lista_precio (codigo, nombre, descripcion, orden) VALUES
  ('MINORISTA', 'Minorista', 'Público en general: precio del catálogo', 1),
  ('MAYORISTA', 'Mayorista', 'Compras por volumen', 2),
  ('CORPORATIVO', 'Corporativo', 'Empresas e instituciones', 3)
ON CONFLICT (codigo) DO NOTHING;
-- Cualquier otro valor que ya tenga un cliente se conserva como lista.
INSERT INTO core.lista_precio (codigo, nombre, orden)
  SELECT DISTINCT lista_precio, initcap(lower(replace(lista_precio, '_', ' '))), 9 FROM core.cliente
  WHERE lista_precio IS NOT NULL
ON CONFLICT (codigo) DO NOTHING;

CREATE TABLE IF NOT EXISTS core.lista_precio_item (
  lista_codigo   text NOT NULL REFERENCES core.lista_precio(codigo) ON DELETE CASCADE,
  producto_id    uuid NOT NULL REFERENCES core.producto(id) ON DELETE CASCADE,
  precio_con_igv numeric(18,4) NOT NULL CHECK (precio_con_igv > 0),
  PRIMARY KEY (lista_codigo, producto_id)
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_cliente_lista_precio') THEN
    ALTER TABLE core.cliente ADD CONSTRAINT fk_cliente_lista_precio FOREIGN KEY (lista_precio) REFERENCES core.lista_precio(codigo);
  END IF;
END $$;

-- Precio por unidad para un cliente: el de su lista (si está activa y tiene el producto) o el del catálogo.
CREATE OR REPLACE FUNCTION core.precio_cliente(p_producto uuid, p_cliente uuid) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT i.precio_con_igv FROM core.cliente c
       JOIN core.lista_precio l ON l.codigo = c.lista_precio AND l.activa
       JOIN core.lista_precio_item i ON i.lista_codigo = l.codigo AND i.producto_id = p_producto
     WHERE c.id = p_cliente),
    (SELECT precio_con_igv FROM core.producto WHERE id = p_producto));
$$;

INSERT INTO core.navegacion (id, grupo, etiqueta, ruta, icono, permiso_id, orden, grupo_orden) VALUES
  ('n-listas-precio', 'Maestros', 'Listas de precios', '/maestros/listas-precio', 'tag', 'maestros.editar', 4, 3)
ON CONFLICT (id) DO NOTHING;
