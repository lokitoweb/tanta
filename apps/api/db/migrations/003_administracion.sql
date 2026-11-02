-- =====================================================================
--  003 · Administración del sistema
--  Todo lo que el cliente debe poder cambiar sin tocar código vive aquí:
--  parámetros de negocio, gestión de usuarios y cierre de períodos.
-- =====================================================================

-- Nuevos permisos
INSERT INTO core.permiso (id, grupo, descripcion) VALUES
  ('parametros.gestionar', 'Seguridad', 'Cambiar parámetros de negocio (IGV, margen objetivo, política de stock)'),
  ('periodos.cerrar',      'Gerencia',  'Calcular y cerrar el período de costos')
ON CONFLICT (id) DO NOTHING;

-- Se asignan a los roles que corresponden
INSERT INTO core.rol_permiso (rol_id, permiso_id) VALUES
  ('ADMINISTRADOR', 'parametros.gestionar'),
  ('GERENTE',       'periodos.cerrar')
ON CONFLICT DO NOTHING;

-- Nuevas entradas de menú (el menú se genera desde la base, no desde el código)
INSERT INTO core.navegacion (id, grupo, etiqueta, ruta, icono, permiso_id, orden, grupo_orden) VALUES
  ('n-parametros', 'Maestros', 'Parámetros', '/seguridad/parametros', 'settings', 'parametros.gestionar', 5, 3),
  ('n-periodos',   'Gerencia', 'Períodos de costo', '/gerencia/periodos', 'report', 'periodos.cerrar', 3, 4)
ON CONFLICT (id) DO NOTHING;

-- Trazabilidad de cambios de parámetros: quién cambió qué y cuándo.
CREATE TABLE IF NOT EXISTS audit.parametro_historial (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clave       text NOT NULL,
  valor_antes text,
  valor_nuevo text NOT NULL,
  usuario_id  uuid REFERENCES core.usuario(id),
  creado_en   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_param_hist ON audit.parametro_historial (clave, creado_en DESC);
