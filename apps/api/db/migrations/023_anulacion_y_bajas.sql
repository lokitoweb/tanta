-- =====================================================================
--  023 · Anulación de ventas y bajas con motivo (PDF §3.2, §3.3, §4.5)
-- =====================================================================

-- Motivo tipificado de cada baja: G-10 agrupa por esto, no por texto libre.
ALTER TABLE core.movimiento_inventario
  ADD COLUMN IF NOT EXISTS motivo_tipo text
    CHECK (motivo_tipo IN ('CONSUMO','MERMA','VENCIMIENTO','AJUSTE','DEVOLUCION','ANULACION'));

ALTER TABLE core.venta
  ADD COLUMN IF NOT EXISTS anulada_en timestamptz,
  ADD COLUMN IF NOT EXISTS anulada_por uuid,
  ADD COLUMN IF NOT EXISTS motivo_anulacion text;

INSERT INTO core.permiso (id, grupo, descripcion) VALUES
  ('ventas.anular', 'Ventas', 'Anular ventas: devuelve el stock y cancela la deuda')
ON CONFLICT (id) DO NOTHING;

INSERT INTO core.rol_permiso (rol_id, permiso_id)
SELECT r, 'ventas.anular' FROM unnest(ARRAY['SUPERADMIN','GERENTE','ADMINISTRADOR']) r
WHERE EXISTS (SELECT 1 FROM core.rol WHERE id = r)
ON CONFLICT DO NOTHING;
