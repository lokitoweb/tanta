-- Auditoría 2026-11: índices para consultas que hoy recorren la tabla entera.

-- Entregas del día por vendedor (cierre de cobranza, «mi día»).
CREATE INDEX IF NOT EXISTS ix_pedido_entregado_por ON core.pedido (entregado_por, entregado_en) WHERE entregado_por IS NOT NULL;

-- core.saldo_cuenta suma los movimientos vigentes de una cuenta en cada pago desde caja grande.
CREATE INDEX IF NOT EXISTS ix_movimiento_caja_saldo ON core.movimiento_caja (cuenta) INCLUDE (monto) WHERE estado = 'VIGENTE';

-- Liquidación diaria: pagos a proveedores por fecha.
CREATE INDEX IF NOT EXISTS ix_pago_compra_fecha ON core.pago_compra (fecha_pago) WHERE estado = 'VIGENTE';

-- Anular una compra busca sus lotes por movimiento.
CREATE INDEX IF NOT EXISTS ix_lote_insumo_movimiento ON core.lote_insumo (movimiento_id);

-- Promociones vendidas / stock reservado por promoción.
CREATE INDEX IF NOT EXISTS ix_pedido_detalle_promocion ON core.pedido_detalle (promocion_id) WHERE promocion_id IS NOT NULL;
