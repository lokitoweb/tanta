-- Los comprobantes (vouchers, facturas de gastos) son datos financieros: solo se ven con sesión y permiso.
-- Las imágenes públicas (logo, productos, fondos) no cambian.
ALTER TABLE core.archivo ADD COLUMN privado boolean NOT NULL DEFAULT false;

UPDATE core.archivo a SET privado = true
WHERE a.id IN (SELECT comprobante_id FROM core.recibo WHERE comprobante_id IS NOT NULL)
   OR a.id IN (SELECT comprobante_id FROM core.pago_compra WHERE comprobante_id IS NOT NULL)
   OR a.id IN (SELECT comprobante_id FROM core.pago_costo WHERE comprobante_id IS NOT NULL);
