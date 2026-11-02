-- =====================================================================
--  007 · El usuario cliente se vincula a su ficha de cliente
--  Sin este vínculo, la app no puede mostrar "mis pedidos" sin exponer
--  los pedidos de todos. Cada quien ve lo suyo por diseño.
-- =====================================================================

ALTER TABLE core.usuario
  ADD COLUMN IF NOT EXISTS cliente_id uuid REFERENCES core.cliente(id);

CREATE INDEX IF NOT EXISTS ix_usuario_cliente ON core.usuario (cliente_id) WHERE cliente_id IS NOT NULL;
