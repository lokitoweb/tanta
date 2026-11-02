-- 011 · La configuración y los archivos no dependen de un usuario por FK: un TRUNCATE de usuarios
-- (semilla) los borraba en cascada. Quién cambió qué ya queda en audit.evento.
ALTER TABLE core.configuracion DROP CONSTRAINT IF EXISTS configuracion_actualizado_por_fkey;
ALTER TABLE core.archivo DROP CONSTRAINT IF EXISTS archivo_creado_por_fkey;

INSERT INTO core.configuracion (clave, valor) VALUES
  ('marca', '{"nombreApp":"Tanta","colorPrimario":"#2B1D16","colorAcento":"#C9A27A","logoId":null,"iconoId":null}'),
  ('movil', '{"versionActual":"1.0.0","versionMinima":"1.0.0","urlAndroid":"","urlIos":"","mensajeActualizacion":"Hay una nueva versión de Tanta. Actualiza para continuar."}'),
  ('legal', '{"urlPrivacidad":"","urlTerminos":"","correoSoporte":"contacto@tantapanaderia.com"}'),
  ('firebase', '{"habilitado":false,"projectId":"","apiKey":"","appIdAndroid":"","appIdIos":"","senderId":"","cuentaServicio":""}'),
  ('webhook', '{"habilitado":false,"url":"","secreto":"","eventos":["venta.creada","cobro.registrado","pedido.estado"]}')
ON CONFLICT (clave) DO NOTHING;
