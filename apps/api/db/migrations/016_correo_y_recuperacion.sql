-- =====================================================================
--  016 · Correo SMTP administrable y recuperación de contraseña
-- =====================================================================

-- Servidor de correo: lo configura el Superadmin (la clave se guarda cifrada por la API).
INSERT INTO core.configuracion (clave, valor) VALUES
  ('correo', '{"habilitado":false,"host":"","puerto":587,"seguro":false,"usuario":"","clave":"","remitente":"","nombreRemitente":"Tanta"}')
ON CONFLICT (clave) DO NOTHING;

-- Códigos de recuperación: se guarda solo el hash; vencen y tienen intentos limitados.
CREATE TABLE IF NOT EXISTS core.recuperacion (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  usuario_id  uuid NOT NULL REFERENCES core.usuario(id) ON DELETE CASCADE,
  codigo_hash text NOT NULL,
  expira_en   timestamptz NOT NULL,
  intentos    smallint NOT NULL DEFAULT 0 CHECK (intentos >= 0),
  usado_en    timestamptz,
  creado_en   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_recuperacion_usuario ON core.recuperacion (usuario_id, creado_en DESC) WHERE usado_en IS NULL;

-- Correo único por usuario (para recuperar por correo sin ambigüedad). Vacío se permite repetido.
CREATE UNIQUE INDEX IF NOT EXISTS ux_usuario_email ON core.usuario (lower(email)) WHERE email <> '';
