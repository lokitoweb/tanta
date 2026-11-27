-- =====================================================================
--  070 · Tarifario General (Observaciones Tanta 03, OBS-03-03)
--  Una lista «General» con el precio del catálogo: es la que recibe todo
--  cliente nuevo (desde la web, la app o el registro) sin que nadie la elija.
--  Los clientes que ya existen conservan su lista.
-- =====================================================================

INSERT INTO core.lista_precio (codigo, nombre, descripcion, orden)
VALUES ('GENERAL', 'General', 'Precio del catálogo: la reciben los clientes nuevos', 0)
ON CONFLICT DO NOTHING;

ALTER TABLE core.cliente ALTER COLUMN lista_precio SET DEFAULT 'GENERAL';
