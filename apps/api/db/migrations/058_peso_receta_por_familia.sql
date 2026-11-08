-- =====================================================================
--  058 · Peso de cada línea de receta según la familia de su unidad
--  Antes: peso = cantidad × equiv_kg para todo. Una bolsa (1 u, equiv 1) sumaba 1 kg a la masa del lote
--  y 20 % al porcentaje panadero, e inflaba las unidades esperadas; un insumo en kg con equiv ≠ 1 pesaba de menos.
--  Ahora: empaque = 0 kg (cuesta, pero no es masa) · masa = su factor · volumen = factor × densidad ·
--  conteo = kg por unidad de la ficha (huevo 0.05).
-- =====================================================================
CREATE OR REPLACE FUNCTION core.peso_unitario_kg(p_insumo uuid) RETURNS numeric AS $$
  SELECT CASE
    WHEN coalesce(t.es_empaque, false) THEN 0
    WHEN u.familia = 'MASA' THEN u.factor_a_patron
    WHEN u.familia = 'VOLUMEN' THEN u.factor_a_patron * i.equiv_kg
    ELSE i.equiv_kg END
  FROM core.insumo i
  JOIN core.unidad_medida u ON u.codigo = i.unidad
  LEFT JOIN core.tipo_insumo t ON t.codigo = i.tipo
  WHERE i.id = p_insumo
$$ LANGUAGE sql STABLE;

DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('core.recalcular_costos_base()'::regprocedure);
  IF position('peso_unitario_kg' IN def) = 0 THEN
    def := replace(def, 'peso_kg = d.cantidad * i.equiv_kg', 'peso_kg = d.cantidad * core.peso_unitario_kg(i.id)');
    IF position('peso_unitario_kg' IN def) = 0 THEN RAISE EXCEPTION 'No se pudo cambiar el peso de las líneas de receta'; END IF;
    EXECUTE def;
  END IF;
END $$;

SELECT core.recalcular_costos();
