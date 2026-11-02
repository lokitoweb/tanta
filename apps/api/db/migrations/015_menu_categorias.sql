-- 015 · Categorías administrables desde el menú (margen objetivo del semáforo).
INSERT INTO core.navegacion (id, grupo, etiqueta, ruta, icono, permiso_id, orden, grupo_orden)
VALUES ('n-categorias', 'Maestros', 'Categorías', '/maestros/categorias', 'clipboard', 'maestros.editar', 3, 3)
ON CONFLICT (id) DO NOTHING;
