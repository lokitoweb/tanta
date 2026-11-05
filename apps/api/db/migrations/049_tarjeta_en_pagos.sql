-- =====================================================================
--  049 · Excel «INTERFACES TANTA»: los pagos a proveedores y de costos admiten
--  EFECTIVO / YAPE / PLIN / TRANSFERENCIA / TARJETA. La tarjeta exige n.° de operación y no sale de caja chica.
-- =====================================================================
UPDATE core.medio_pago SET en_compras = true WHERE codigo = 'TARJETA' AND NOT en_compras;
