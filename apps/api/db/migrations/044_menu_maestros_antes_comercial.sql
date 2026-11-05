-- Menú lateral: Maestros va antes que Comercial (pedido del dueño, 5-nov-2026).
UPDATE core.navegacion SET grupo_orden = 2 WHERE grupo = 'Maestros';
UPDATE core.navegacion SET grupo_orden = 3 WHERE grupo = 'Comercial';
