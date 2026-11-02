-- 010 · El trigger de 009 fallaba si se insertan permisos antes de existir el rol
-- (instalación desde cero o semilla). Solo asigna cuando el Superadmin ya existe.
CREATE OR REPLACE FUNCTION core.superadmin_recibe_permiso() RETURNS trigger AS $$
BEGIN
  INSERT INTO core.rol_permiso (rol_id, permiso_id)
  SELECT 'SUPERADMIN', NEW.id WHERE EXISTS (SELECT 1 FROM core.rol WHERE id = 'SUPERADMIN')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
