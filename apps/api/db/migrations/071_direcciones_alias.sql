-- =====================================================================
--  071 · Direcciones con alias y teléfono (Observaciones Tanta 03, OBS-03-04)
--  Cada dirección de entrega lleva un alias (Casa, Local, Oficina) y un teléfono
--  de contacto opcional. La principal sigue en la ficha del cliente; se puede
--  editar y cambiar por otra («marcar como principal») desde la web y la app.
--  Los pedidos guardan su copia del texto: cambiar una dirección no altera el historial.
-- =====================================================================

ALTER TABLE core.direccion_cliente
  ADD COLUMN IF NOT EXISTS alias    text NOT NULL DEFAULT '' CHECK (length(alias) <= 40),
  ADD COLUMN IF NOT EXISTS telefono text NOT NULL DEFAULT '' CHECK (length(telefono) <= 30);

ALTER TABLE core.cliente
  ADD COLUMN IF NOT EXISTS direccion_alias      text NOT NULL DEFAULT '' CHECK (length(direccion_alias) <= 40),
  ADD COLUMN IF NOT EXISTS direccion_referencia text NOT NULL DEFAULT '' CHECK (length(direccion_referencia) <= 120),
  ADD COLUMN IF NOT EXISTS direccion_telefono   text NOT NULL DEFAULT '' CHECK (length(direccion_telefono) <= 30);
