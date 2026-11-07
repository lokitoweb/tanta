-- Avisos a clientes (promociones y comunicados): salen por el centro de notificaciones y por push.
-- Quién puede enviarlos se decide en Roles y permisos con «clientes.avisar».
CREATE TABLE core.aviso_cliente (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo      text NOT NULL,
  cuerpo      text NOT NULL,
  todos       boolean NOT NULL,
  clientes    integer NOT NULL,
  usuarios    integer NOT NULL,
  enviado_por uuid NOT NULL REFERENCES core.usuario(id),
  creado_en   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_aviso_cliente_fecha ON core.aviso_cliente (creado_en DESC);

INSERT INTO core.permiso (id, grupo, descripcion) VALUES
  ('clientes.avisar', 'Clientes', 'Enviar avisos y promociones a los clientes')
ON CONFLICT (id) DO NOTHING;

INSERT INTO core.rol_permiso (rol_id, permiso_id)
SELECT r, 'clientes.avisar' FROM unnest(ARRAY['SUPERADMIN','GERENTE','ADMINISTRADOR']) r
ON CONFLICT DO NOTHING;

INSERT INTO core.navegacion (id, grupo, etiqueta, ruta, icono, permiso_id, orden, grupo_orden)
VALUES ('n-avisos-clientes', 'Comercial', 'Avisos a clientes', '/ventas/avisos', 'bell', 'clientes.avisar', 5, 3)
ON CONFLICT (id) DO NOTHING;
