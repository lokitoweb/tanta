-- =====================================================================
--  035 · Unidad de inventario por defecto
--  Un insumo creado sin unidad de inventario (cargas, integraciones) la toma de su unidad base:
--  así nada que ya creaba insumos se rompe y RN-03 se sigue validando en el mismo trigger.
-- =====================================================================
CREATE OR REPLACE FUNCTION core.validar_unidades_insumo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.unidad_inventario := coalesce(NEW.unidad_inventario, NEW.unidad);
  IF core.factor_unidades(NEW.unidad, NEW.unidad_inventario, NEW.equiv_kg) IS NULL THEN
    RAISE EXCEPTION 'El insumo % no tiene factor de inventario de % a %: define su densidad.', NEW.nombre, NEW.unidad, NEW.unidad_inventario
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
