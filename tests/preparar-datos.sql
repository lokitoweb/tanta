-- ============================================================================
-- Tanta · Preparación de datos para la prueba de carga (SOLO entorno de pruebas)
-- Ejecutar con:  docker exec -i tanta-pg psql -U tanta -d tanta -f - < tests/preparar-datos.sql
--                (o) pwsh -File tests/preparar-datos.ps1
--
-- ¿Por qué es necesario?
--   POST /ventas descuenta stock real y POST /cobranza descuenta saldo real.
--   Sin reponer, la corrida deja de medir el sistema y empieza a medir el
--   agotamiento del catálogo: los 500 por `ck_producto_stock_no_negativo`
--   no son un límite de capacidad.
--   (El agotamiento en sí es un hallazgo: ver INFORME-CARGA.md, H-07.)
-- ============================================================================

-- 1) Reponer stock de productos (el seed deja entre 1 y 256 unidades).
UPDATE core.producto SET stock = 250000 WHERE estado = 'ACTIVO';

-- 2) Reponer el saldo de las cuentas por cobrar abiertas.
UPDATE core.cuenta_por_cobrar
   SET saldo = monto,
       estado = 'PENDIENTE'
 WHERE estado IN ('PENDIENTE', 'PARCIAL')
   AND saldo < monto;

-- 3) Estado de referencia (queda en el log de la corrida).
SELECT 'stock_total' AS k, sum(stock)::numeric(18,2)::text AS v FROM core.producto
UNION ALL
SELECT 'cxc_pendientes', count(*)::text FROM core.cuenta_por_cobrar WHERE estado IN ('PENDIENTE','PARCIAL')
UNION ALL
SELECT 'cxc_saldo', sum(saldo)::numeric(18,2)::text FROM core.cuenta_por_cobrar WHERE estado IN ('PENDIENTE','PARCIAL')
UNION ALL
SELECT 'ventas', count(*)::text FROM core.venta
UNION ALL
SELECT 'movimientos', count(*)::text FROM core.movimiento_inventario
UNION ALL
SELECT 'auditoria', count(*)::text FROM audit.evento;
