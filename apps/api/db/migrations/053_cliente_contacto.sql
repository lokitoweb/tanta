-- Nombre de la persona de contacto del cliente (opcional): útil cuando el cliente es una empresa.
ALTER TABLE core.cliente ADD COLUMN contacto text NOT NULL DEFAULT '';
