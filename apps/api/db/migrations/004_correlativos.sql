-- =====================================================================
--  004 · Correlativos con secuencia
--  El código de documento se calculaba con count(*), lo que cuesta O(n)
--  y —peor— permite que dos ventas concurrentes obtengan el mismo código.
--  La secuencia es atómica y O(1).
-- =====================================================================

CREATE SEQUENCE IF NOT EXISTS core.venta_correlativo_seq;
CREATE SEQUENCE IF NOT EXISTS core.pedido_correlativo_seq;
CREATE SEQUENCE IF NOT EXISTS core.op_correlativo_seq;

-- Se alinean con los documentos ya existentes para no chocar con lo cargado.
SELECT setval('core.venta_correlativo_seq',
              GREATEST((SELECT count(*) FROM core.venta), 1), true);
SELECT setval('core.pedido_correlativo_seq',
              GREATEST((SELECT count(*) FROM core.pedido), 1), true);
SELECT setval('core.op_correlativo_seq',
              GREATEST((SELECT count(*) FROM core.orden_produccion), 1), true);

-- Índice para el aging de cartera y el dashboard: cubre la consulta más frecuente.
CREATE INDEX IF NOT EXISTS ix_cxc_aging
  ON core.cuenta_por_cobrar (vence_en, saldo)
  WHERE estado IN ('PENDIENTE','PARCIAL');

-- El dashboard filtra ventas por fecha y estado; este índice evita el seq scan.
CREATE INDEX IF NOT EXISTS ix_venta_periodo
  ON core.venta (creado_en)
  INCLUDE (ventas_netas, costo_ventas, utilidad)
  WHERE estado = 'CONFIRMADA';
