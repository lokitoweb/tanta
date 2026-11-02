-- =====================================================================
--  008 · Segundo factor (TOTP)
--  Gerencia y Administración pueden cambiar precios, costos y usuarios:
--  una contraseña sola no es suficiente para esas cuentas.
-- =====================================================================

ALTER TABLE core.usuario
  ADD COLUMN IF NOT EXISTS mfa_secreto text,
  ADD COLUMN IF NOT EXISTS mfa_activo boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mfa_activado_en timestamptz;

-- Códigos de recuperación: se guardan hasheados, nunca en claro.
CREATE TABLE IF NOT EXISTS core.mfa_codigo (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  usuario_id  uuid NOT NULL REFERENCES core.usuario(id) ON DELETE CASCADE,
  codigo_hash text NOT NULL,
  usado_en    timestamptz,
  creado_en   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_mfa_codigo_usuario ON core.mfa_codigo (usuario_id) WHERE usado_en IS NULL;

-- Intento de login por cuenta: permite bloquear la fuerza bruta dirigida,
-- que el límite por IP no detiene si el atacante rota direcciones.
CREATE TABLE IF NOT EXISTS core.intento_login (
  usuario     text NOT NULL,
  ip          inet,
  fallos      smallint NOT NULL DEFAULT 0,
  bloqueado_hasta timestamptz,
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (usuario)
);
