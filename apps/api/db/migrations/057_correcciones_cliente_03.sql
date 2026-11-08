-- Informe «Modificaciones sistema Tanta 03»: tipo de comprobante elegido por el cliente, hasta N direcciones,
-- contraseña mínima administrable y permisos que el cliente no encontraba (verificar compras, confirmar pedidos).
-- Todo sigue siendo administrable: parámetros, catálogo de comprobantes, series y roles.

INSERT INTO core.parametro (clave, valor, tipo, descripcion) VALUES
  ('clave_longitud_minima', '5', 'numero', 'Caracteres mínimos de una contraseña nueva (5 a 64). El bloqueo tras 5 intentos fallidos sigue activo'),
  ('cliente_max_direcciones', '4', 'numero', 'Direcciones de entrega que puede guardar cada cliente (1 a 20)'),
  ('comprobante_leyenda', 'Documento de control interno. No reemplaza al comprobante electrónico emitido ante SUNAT.', 'texto',
   'Leyenda al pie de los comprobantes que el cliente descarga. Cámbiala cuando se integre la facturación electrónica')
ON CONFLICT (clave) DO NOTHING;

/* Tipos de comprobante de venta (Maestros → Catálogos). requiere_ruc: la factura exige cliente con RUC. */
CREATE TABLE core.tipo_comprobante_venta (
  codigo       text PRIMARY KEY CHECK (codigo ~ '^[A-Z][A-Z0-9_]{1,19}$'),
  nombre       text NOT NULL,
  requiere_ruc boolean NOT NULL DEFAULT false,
  activo       boolean NOT NULL DEFAULT true,
  orden        integer NOT NULL DEFAULT 0
);
INSERT INTO core.tipo_comprobante_venta (codigo, nombre, requiere_ruc, orden) VALUES
  ('NOTA_VENTA', 'Nota de pedido', false, 1), ('BOLETA', 'Boleta de venta', false, 2), ('FACTURA', 'Factura', true, 3);

/* Cada tipo tiene su serie (Parámetros → Series); RECIBO es la de cobranza. */
ALTER TABLE core.serie_comprobante DROP CONSTRAINT IF EXISTS serie_comprobante_tipo_check;
INSERT INTO core.serie_comprobante (tipo, serie) VALUES ('BOLETA', 'B001'), ('FACTURA', 'F001') ON CONFLICT DO NOTHING;

/* El pedido guarda el comprobante que pidió el cliente; la venta del despacho lo emite. */
ALTER TABLE core.pedido ADD COLUMN comprobante_tipo text NOT NULL DEFAULT 'NOTA_VENTA' REFERENCES core.tipo_comprobante_venta(codigo);

/* Permisos por defecto (cada rol se sigue editando en Roles):
   el Administrador verifica compras y confirma pedidos desde la web; el Vendedor publica promociones. */
INSERT INTO core.rol_permiso (rol_id, permiso_id)
SELECT r, p FROM (VALUES ('ADMINISTRADOR', 'compras.verificar'), ('ADMINISTRADOR', 'pedidos.gestionar'), ('VENDEDOR', 'promociones.gestionar')) v(r, p)
WHERE EXISTS (SELECT 1 FROM core.rol WHERE id = v.r) AND EXISTS (SELECT 1 FROM core.permiso WHERE id = v.p)
ON CONFLICT DO NOTHING;
