-- =====================================================================
--  021 · Hallazgos de la auditoría de base de datos
--  - El motor de costeo daba deadlocks en paralelo (67 % de fallos con 8 llamadas
--    concurrentes): ahora se serializa y bloquea productos en el mismo orden que las ventas.
--  - Índices para los reportes con volumen de un año (seq scans de 900k filas).
-- =====================================================================

-- Motor serializado: la lógica queda en recalcular_costos_base; el punto de entrada
-- toma un lock transaccional y bloquea productos ORDER BY id (igual que POST /ventas).
ALTER FUNCTION core.recalcular_costos() RENAME TO recalcular_costos_base;

CREATE OR REPLACE FUNCTION core.recalcular_costos() RETURNS integer AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('core.recalcular_costos'));
  PERFORM 1 FROM core.producto ORDER BY id FOR UPDATE;
  RETURN core.recalcular_costos_base();
END $$ LANGUAGE plpgsql;

-- Índices para reportes y dashboard
CREATE INDEX IF NOT EXISTS ix_vd_venta_inc ON core.venta_detalle (venta_id) INCLUDE (producto_id, cantidad, precio_neto, costo_unitario);
CREATE INDEX IF NOT EXISTS ix_vd_producto ON core.venta_detalle (producto_id);
CREATE INDEX IF NOT EXISTS ix_pedido_creado ON core.pedido (creado_en DESC);
CREATE INDEX IF NOT EXISTS ix_pedido_entrega ON core.pedido (fecha_entrega) WHERE estado IN ('REGISTRADO','EN_PRODUCCION');
CREATE INDEX IF NOT EXISTS ix_pedido_detalle_producto ON core.pedido_detalle (producto_id);
CREATE INDEX IF NOT EXISTS ix_op_terminada ON core.orden_produccion (terminada_en) WHERE estado = 'TERMINADA';
CREATE INDEX IF NOT EXISTS ix_op_producto_entrega ON core.orden_produccion (producto_id, entrega);
CREATE INDEX IF NOT EXISTS ix_mov_insumo_fecha ON core.movimiento_inventario (insumo_id, creado_en) WHERE cantidad < 0;
CREATE INDEX IF NOT EXISTS ix_cxc_cliente_estado ON core.cuenta_por_cobrar (cliente_id) WHERE estado IN ('PENDIENTE','PARCIAL');
CREATE INDEX IF NOT EXISTS ix_cxc_venta ON core.cuenta_por_cobrar (venta_id);
CREATE INDEX IF NOT EXISTS ix_venta_vendedor ON core.venta (vendedor_id);
CREATE INDEX IF NOT EXISTS ix_cobranza_creado ON core.cobranza (creado_en DESC);

-- Índice duplicado de ix_venta_fecha (mismo predicado y columna)
DROP INDEX IF EXISTS core.ix_venta_creado;

-- Estadísticas de consultas (la librería ya se precarga en producción)
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
