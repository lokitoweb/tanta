-- Deja SOLO la categoría Panadería (decisión del dueño, 5-nov-2026). Se ejecuta una vez sobre una base
-- existente; la semilla ya nace así. Todo en una transacción: o se limpia completo o no cambia nada.
--   · Borra los productos de Pastelería y Tortas con recetas, órdenes de producción (y sus requisiciones),
--     pedidos y las líneas de venta de esos productos.
--   · Una venta que solo tenía esos productos se borra (con su cuenta por cobrar); una venta mixta se queda
--     con sus panes y se recalculan sus totales, su IGV y su deuda.
--   · Los consumos de insumos ya registrados en el kárdex se conservan: el stock de insumos es real.
BEGIN;

CREATE TEMP TABLE x_prod ON COMMIT DROP AS SELECT id FROM core.producto WHERE categoria_id <> 'pan';
CREATE TEMP TABLE x_ped ON COMMIT DROP AS SELECT DISTINCT pedido_id id FROM core.pedido_detalle WHERE producto_id IN (SELECT id FROM x_prod);
CREATE TEMP TABLE x_op ON COMMIT DROP AS
  SELECT id FROM core.orden_produccion WHERE producto_id IN (SELECT id FROM x_prod) OR pedido_id IN (SELECT id FROM x_ped);

-- Producción
DELETE FROM core.requisicion WHERE op_id IN (SELECT id FROM x_op);
DELETE FROM core.orden_produccion WHERE id IN (SELECT id FROM x_op);

-- Ventas: líneas fuera; ventas vacías fuera; ventas mixtas recalculadas
UPDATE core.venta SET pedido_id = NULL WHERE pedido_id IN (SELECT id FROM x_ped);
CREATE TEMP TABLE x_mixtas ON COMMIT DROP AS
  SELECT DISTINCT d.venta_id id FROM core.venta_detalle d WHERE d.producto_id IN (SELECT id FROM x_prod)
    AND EXISTS (SELECT 1 FROM core.venta_detalle o WHERE o.venta_id = d.venta_id AND o.producto_id NOT IN (SELECT id FROM x_prod));
DELETE FROM core.venta_detalle WHERE producto_id IN (SELECT id FROM x_prod);
CREATE TEMP TABLE x_vacias ON COMMIT DROP AS
  SELECT v.id FROM core.venta v WHERE NOT EXISTS (SELECT 1 FROM core.venta_detalle d WHERE d.venta_id = v.id);
DELETE FROM core.cobranza WHERE cxc_id IN (SELECT id FROM core.cuenta_por_cobrar WHERE venta_id IN (SELECT id FROM x_vacias));
DELETE FROM core.cuenta_por_cobrar WHERE venta_id IN (SELECT id FROM x_vacias);
DELETE FROM core.descuento_aprobacion WHERE venta_id IN (SELECT id FROM x_vacias);
DELETE FROM core.venta WHERE id IN (SELECT id FROM x_vacias);

UPDATE core.venta v SET
  ventas_netas  = t.netas,
  costo_ventas  = t.costo,
  utilidad      = t.netas - t.costo,
  margen        = CASE WHEN t.netas > 0 THEN (t.netas - t.costo) / t.netas ELSE 0 END,
  total_con_igv = t.total,
  base          = round(t.total / (1 + (SELECT valor::numeric FROM core.parametro WHERE clave = 'igv')), 2),
  igv           = t.total - round(t.total / (1 + (SELECT valor::numeric FROM core.parametro WHERE clave = 'igv')), 2)
FROM (SELECT venta_id, sum(precio_neto * cantidad) netas, sum(costo_unitario * cantidad) costo,
             round(sum(precio_con_igv * cantidad) * (1 - max(coalesce(v2.descuento_pct, 0))), 2) total
      FROM core.venta_detalle d JOIN core.venta v2 ON v2.id = d.venta_id GROUP BY venta_id) t
WHERE t.venta_id = v.id AND v.id IN (SELECT id FROM x_mixtas);

-- La deuda de una venta mixta baja a su nuevo total (sin pasar por debajo de lo ya cobrado)
UPDATE core.cuenta_por_cobrar x SET
  monto = v.total_con_igv,
  saldo = greatest(v.total_con_igv - (x.monto - x.saldo), 0),
  estado = CASE WHEN greatest(v.total_con_igv - (x.monto - x.saldo), 0) <= 0.005 THEN 'PAGADA' ELSE x.estado END
FROM core.venta v WHERE v.id = x.venta_id AND v.id IN (SELECT id FROM x_mixtas) AND v.total_con_igv > 0;

-- Pedidos y productos
DELETE FROM core.pedido WHERE id IN (SELECT id FROM x_ped);
DELETE FROM core.movimiento_inventario WHERE producto_id IN (SELECT id FROM x_prod);
DELETE FROM core.producto WHERE id IN (SELECT id FROM x_prod);
DELETE FROM core.categoria WHERE id <> 'pan';
UPDATE core.categoria SET nombre = 'Panadería' WHERE id = 'pan';

SELECT core.recalcular_costos();
COMMIT;
