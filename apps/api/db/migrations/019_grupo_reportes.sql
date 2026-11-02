-- 019 · Reportes en su propio grupo del menú: Vendedor y Almacén ven sus reportes
-- (V-xx, A-xx) sin aparecer bajo «Gerencia».
UPDATE core.navegacion SET grupo = 'Reportes', grupo_orden = 8, orden = 1 WHERE id = 'n-reportes';
