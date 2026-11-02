-- 014 · venta_detalle.precio_neto es precio UNITARIO (así lo guarda la API de ventas).
-- La semilla antigua guardaba el total de la línea; los reportes sumaban mal.
-- Solo se corrigen las filas que coinciden con "total de línea" (cantidad > 1).
UPDATE core.venta_detalle
SET precio_neto = round(precio_neto / cantidad, 4)
WHERE cantidad > 1
  AND abs(precio_neto - precio_con_igv / (1 + (SELECT valor::numeric FROM core.parametro WHERE clave = 'igv')) * cantidad) < 0.05 * cantidad;
