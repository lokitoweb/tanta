-- =====================================================================
--  002 · Invariantes de inventario
--  El stock no puede quedar negativo: la política estricta del dossier
--  (07 §6) deja de ser un "if" en el código y pasa a ser una restricción.
-- =====================================================================

ALTER TABLE core.insumo
  ADD CONSTRAINT ck_insumo_stock_no_negativo CHECK (stock >= 0) NOT VALID;

ALTER TABLE core.producto
  ADD CONSTRAINT ck_producto_stock_no_negativo CHECK (stock >= 0) NOT VALID;

-- Índice parcial: el reporte de stock crítico no escanea la tabla completa.
CREATE INDEX IF NOT EXISTS ix_insumo_critico
  ON core.insumo (nombre)
  WHERE stock <= minimo;

-- Se valida solo si los datos ya están limpios; si no, queda constancia y
-- se reintenta tras corregir. Así la migración nunca bloquea un despliegue.
DO $$
BEGIN
  BEGIN
    ALTER TABLE core.insumo VALIDATE CONSTRAINT ck_insumo_stock_no_negativo;
    ALTER TABLE core.producto VALIDATE CONSTRAINT ck_producto_stock_no_negativo;
    RAISE NOTICE 'Invariantes de stock validados.';
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'Validación pendiente: existen filas con stock negativo. Se validará tras corregir los datos.';
  END;
END $$;
