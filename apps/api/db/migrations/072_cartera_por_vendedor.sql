-- Cartera por vendedor: sin «pedidos.ver_todos», cada vendedor ve solo sus clientes (asignados o sin asignar) y sus pedidos.
INSERT INTO core.permiso (id, grupo, descripcion) VALUES
  ('pedidos.ver_todos', 'Ventas', 'Ver pedidos y clientes de todos los vendedores (sin esto, cada vendedor ve solo su cartera)')
ON CONFLICT (id) DO NOTHING;

-- Todos los roles, salvo Vendedor y Cliente, siguen viendo todo como hasta ahora.
INSERT INTO core.rol_permiso (rol_id, permiso_id)
SELECT id, 'pedidos.ver_todos' FROM core.rol WHERE id NOT IN ('VENDEDOR', 'CLIENTE')
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS ix_cliente_vendedor ON core.cliente (vendedor_id);
CREATE INDEX IF NOT EXISTS ix_pedido_creado_por ON core.pedido (creado_por);
