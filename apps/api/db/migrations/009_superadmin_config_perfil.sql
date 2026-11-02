-- =====================================================================
--  009 · Todo administrable: superadmin, roles editables, configuración
--  central (marca, app móvil, legal, Firebase, webhook), perfil de usuario
--  y dispositivos con su versión de app.
-- =====================================================================

-- ---------------------------------------------------------- permisos nuevos
INSERT INTO core.permiso (id, grupo, descripcion) VALUES
  ('config.gestionar', 'Seguridad', 'Configurar marca, app móvil, integraciones y legal'),
  ('roles.gestionar',  'Seguridad', 'Editar los permisos de cada rol')
ON CONFLICT (id) DO NOTHING;

-- Superadmin: tiene todo, incluidos los permisos que se creen en el futuro (ver trigger).
INSERT INTO core.rol (id, nombre, corto, descripcion, perfil, icono, orden)
VALUES ('SUPERADMIN', 'Superadministrador', 'Sistema', 'Configuración total del sistema', 'web', 'shield', 0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO core.rol_permiso (rol_id, permiso_id)
SELECT 'SUPERADMIN', id FROM core.permiso
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION core.superadmin_recibe_permiso() RETURNS trigger AS $$
BEGIN
  INSERT INTO core.rol_permiso (rol_id, permiso_id) VALUES ('SUPERADMIN', NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tg_superadmin_permiso ON core.permiso;
CREATE TRIGGER tg_superadmin_permiso AFTER INSERT ON core.permiso
  FOR EACH ROW EXECUTE FUNCTION core.superadmin_recibe_permiso();

-- Menú: las pantallas nuevas también salen de la base.
INSERT INTO core.navegacion (id, grupo, etiqueta, ruta, icono, permiso_id, orden, grupo_orden) VALUES
  ('n-roles',  'Sistema', 'Roles y permisos', '/sistema/roles',         'shield',   'roles.gestionar',  1, 9),
  ('n-config', 'Sistema', 'Configuración',    '/sistema/configuracion', 'settings', 'config.gestionar', 2, 9)
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------ configuración central
-- Un documento JSON por sección. "secreto" marca valores que nunca salen del servidor
-- (llave privada de Firebase, secreto del webhook): la API los devuelve enmascarados.
CREATE TABLE IF NOT EXISTS core.configuracion (
  clave          text PRIMARY KEY,
  valor          jsonb NOT NULL DEFAULT '{}'::jsonb,
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  actualizado_por uuid REFERENCES core.usuario(id)
);

INSERT INTO core.configuracion (clave, valor) VALUES
  ('marca', '{"nombreApp":"Tanta","colorPrimario":"#2B1D16","colorAcento":"#C9A27A","logoId":null,"iconoId":null}'),
  ('movil', '{"versionActual":"1.0.0","versionMinima":"1.0.0","urlAndroid":"","urlIos":"","mensajeActualizacion":"Hay una nueva versión de Tanta. Actualiza para continuar."}'),
  ('legal', '{"urlPrivacidad":"","urlTerminos":"","correoSoporte":"contacto@tantapanaderia.com"}'),
  ('firebase', '{"habilitado":false,"projectId":"","apiKey":"","appIdAndroid":"","appIdIos":"","senderId":"","cuentaServicio":""}'),
  ('webhook', '{"habilitado":false,"url":"","secreto":"","eventos":["venta.creada","cobro.registrado","pedido.estado"]}')
ON CONFLICT (clave) DO NOTHING;

-- Archivos pequeños (logo, ícono, foto de perfil) en la base: respaldados con todo lo demás
-- y servidos por la API con su tipo validado. ponytail: pasar a S3/R2 si superan unos MB.
CREATE TABLE IF NOT EXISTS core.archivo (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mime      text NOT NULL CHECK (mime IN ('image/png','image/jpeg','image/webp')),
  datos     bytea NOT NULL CHECK (octet_length(datos) <= 1048576),
  creado_por uuid REFERENCES core.usuario(id),
  creado_en timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------- perfil
ALTER TABLE core.usuario
  ADD COLUMN IF NOT EXISTS email     text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS telefono  text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS foto_id   uuid REFERENCES core.archivo(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS eliminado_en timestamptz;

-- ------------------------------------------------- dispositivos y versiones
-- Cada app registra su versión al iniciar: el sistema sabe quién usa qué versión
-- y a quién mandar notificaciones push.
CREATE TABLE IF NOT EXISTS core.dispositivo (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id    uuid NOT NULL REFERENCES core.usuario(id) ON DELETE CASCADE,
  instalacion   text NOT NULL,
  plataforma    text NOT NULL CHECK (plataforma IN ('android','ios','web')),
  version_app   text NOT NULL,
  token_push    text,
  ultimo_uso    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (usuario_id, instalacion)
);
CREATE INDEX IF NOT EXISTS ix_dispositivo_usuario ON core.dispositivo (usuario_id);
