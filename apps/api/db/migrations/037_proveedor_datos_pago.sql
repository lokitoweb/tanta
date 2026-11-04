-- =====================================================================
--  037 · Proveedor: datos para pagar (informe de compra de insumos, 5.2)
--  Dirección, vendedor que atiende a la panadería, banco y CCI (20 dígitos) para transferencias.
-- =====================================================================
ALTER TABLE core.proveedor
  ADD COLUMN IF NOT EXISTS direccion text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS vendedor  text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS banco     text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS cci       text;
DO $$ BEGIN
  ALTER TABLE core.proveedor ADD CONSTRAINT ck_proveedor_cci CHECK (cci IS NULL OR cci ~ '^\d{20}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
