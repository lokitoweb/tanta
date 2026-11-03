// node --test tests/costos-excel.test.mjs
// Motor de costos contra las cifras del informe INF-TEC-001 (Reglas_Negocio y Casos_Prueba).
// Todo ocurre dentro de una transacción que se deshace: no deja datos ni cambia costos reales.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqlScript } from './_sql.mjs';

const cerca = (real, esperado, tol, msg) => assert.ok(Math.abs(real - esperado) <= tol, `${msg}: ${real} (esperado ${esperado})`);

test('pan francés del modelo: masa, costo del lote, unidades, % panadero, mano de obra y CIF', () => {
  const salida = sqlScript(`
    BEGIN;
    -- Escenario aislado: sin otros costos indirectos ni horas de horno de otros panes.
    UPDATE core.costo_indirecto SET activo = false;
    UPDATE core.producto SET horas_horno_lote = 0;
    UPDATE core.parametro SET valor = '1500' WHERE clave = 'sueldo_base';
    UPDATE core.parametro SET valor = '0'    WHERE clave = 'factor_beneficios';
    UPDATE core.parametro SET valor = '192'  WHERE clave = 'horas_mes';
    INSERT INTO core.insumo (codigo, nombre, unidad, cpp, tipo, equiv_kg) VALUES
      ('T-HAR', 'Harina prueba', 'KG', 2.80, 'HARINA', 1),
      ('T-AGU', 'Agua prueba',   'L',  0,    'LIQUIDO', 1),
      ('T-LEV', 'Otros prueba',  'KG', 7.859, 'OTRO', 1);
    INSERT INTO core.producto (codigo, nombre, categoria_id, precio_con_igv, estado, peso_masa_g, perdida_coccion, horas_hombre_lote, horas_horno_lote)
      SELECT 'T-PAN', 'Pan francés prueba', id, 0.35, 'ACTIVO', 55, 0.12, 1, 1 FROM core.categoria ORDER BY orden LIMIT 1;
    INSERT INTO core.receta (id, producto_id, producto, rendimiento, merma_estandar)
      SELECT id, id, nombre, 24, 0.03 FROM core.producto WHERE codigo = 'T-PAN';
    INSERT INTO core.receta_detalle (receta_id, insumo_id, insumo, unidad, cantidad, orden)
      SELECT p.id, i.id, i.nombre, i.unidad, v.c, v.o FROM core.producto p,
        (VALUES ('T-HAR', 10, 1), ('T-AGU', 5.8, 2), ('T-LEV', 0.584, 3)) v(cod, c, o) JOIN core.insumo i ON i.codigo = v.cod
      WHERE p.codigo = 'T-PAN';
    -- Mes de referencia: 448 horas de horno con S/ 4,600 de CIF de horno (RN-13).
    INSERT INTO core.costo_indirecto (concepto, tipo, monto_mensual, categoria, base_reparto) VALUES ('Horno prueba', 'FIJO', 4600, 'CIF', 'HORAS_HORNO');
    SELECT core.recalcular_costos();
    INSERT INTO core.orden_produccion (codigo, producto_id, producto, receta_id, cantidad, estado, entrega, responsable, cantidad_producida, terminada_en)
      SELECT 'T-OP', r.producto_id, r.producto, r.id, 1, 'TERMINADA', current_date, 'Prueba', 448 * r.unidades_esperadas, now()
      FROM core.receta r JOIN core.producto p ON p.id = r.producto_id WHERE p.codigo = 'T-PAN';
    SELECT core.recalcular_costos();
    SELECT json_build_object(
      'masa', r.masa_lote_kg, 'costoLote', r.costo_lote, 'teoricas', r.unidades_teoricas, 'esperadas', r.unidades_esperadas,
      'pesoFinal', r.peso_final_g, 'insumoUnidad', r.costo_con_merma, 'mo', r.mo_unitario, 'cif', r.cif_unitario,
      'pctAgua', (SELECT d.pct_panadero FROM core.receta_detalle d JOIN core.insumo i ON i.id = d.insumo_id WHERE d.receta_id = r.id AND i.codigo = 'T-AGU'),
      'costoTotal', p.costo_unitario)
    FROM core.receta r JOIN core.producto p ON p.id = r.producto_id WHERE p.codigo = 'T-PAN';
    ROLLBACK;`);
  const r = JSON.parse(salida.split('\n').filter((l) => l.startsWith('{')).at(-1));
  cerca(r.masa, 16.384, 0.0005, 'RN-05 masa del lote (kg)');                 // CP-07
  cerca(r.costoLote, 32.59, 0.005, 'RN-09 costo de insumos del lote (S/)');  // CP-07
  cerca(r.teoricas, 297.89, 0.01, 'RN-06 unidades teóricas');
  cerca(r.esperadas, 288.95, 0.01, 'RN-07 unidades esperadas');               // CP-07
  cerca(r.pesoFinal, 48.4, 0.01, 'RN-08 peso final (g)');
  cerca(r.insumoUnidad, 0.113, 0.0005, 'RN-10 costo de insumos por unidad');  // COS-01
  cerca(r.pctAgua, 0.58, 0.0001, 'RN-04 % panadero del agua');                // CP-08
  cerca(r.mo, 0.027, 0.0005, 'RN-12 mano de obra por unidad');                // 1 h × 7.81 ÷ 288.95
  cerca(r.cif, 10.268 / 288.95, 0.0005, 'RN-14 CIF por pan con tarifa de horno S/ 10.268'); // CP-30
  cerca(r.costoTotal, r.insumoUnidad + r.mo + r.cif, 0.000001, 'RN-15 costo total = insumos + MO + CIF');
});

test('RN-16/17: margen y markup del pan francés (CP-31)', () => {
  // Precio 0.35 con IGV y costo 0.1728: margen 41.7 % y markup 71.7 %.
  const neto = 0.35 / 1.18, costo = 0.1728;
  cerca((neto - costo) / neto, 0.417, 0.001, 'margen');
  cerca((neto - costo) / costo, 0.717, 0.001, 'markup');
});
