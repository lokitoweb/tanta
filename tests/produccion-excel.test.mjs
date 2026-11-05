// node --test tests/produccion-excel.test.mjs  (API en 127.0.0.1:3001 con la semilla)
// Producción contra los casos de prueba del informe INF-TEC-001: CP-12 a CP-18 y CP-35.
// Usa un pan y tres insumos propios (códigos únicos por ejecución): no toca los datos reales.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql, sqlScript } from './_sql.mjs';
import { flujoCompras, hoyLima, nroUnico, ANULAR_COMPRAS_DE_PRUEBA } from './_compras.mjs';

const B = process.env.API ?? 'http://127.0.0.1:3001/api/v1';
const login = async (u) => (await (await fetch(B + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario: u, clave: 'tanta' }) })).json()).accessToken;
const api = (t, m, ruta, body) => fetch(B + ruta, {
  method: m, headers: { Authorization: 'Bearer ' + t, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));
const cerca = (real, esperado, tol, msg) => assert.ok(Math.abs(real - esperado) <= tol, `${msg}: ${real} (esperado ${esperado})`);

const sufijo = randomUUID().slice(0, 6).toUpperCase();
let sa, alm, pro, ger, productoId, harina, levadura;

before(async () => {
  [sa, alm, pro, ger] = await Promise.all(['superadmin', 'jramos', 'rquispe', 'osquilcate'].map(login));
  // Pan francés del modelo: 55 g de masa cruda, 3 % de merma; receta de 10 kg de harina.
  const ids = sql(`WITH i AS (INSERT INTO core.insumo (codigo, nombre, unidad, cpp, tipo, equiv_kg) VALUES
      ('TH-${sufijo}', 'Harina prueba ${sufijo}', 'KG', 2.80, 'HARINA', 1),
      ('TA-${sufijo}', 'Agua prueba ${sufijo}', 'L', 0, 'LIQUIDO', 1),
      ('TL-${sufijo}', 'Levadura prueba ${sufijo}', 'KG', 7.859, 'LEVADURA', 1) RETURNING id, codigo),
    p AS (INSERT INTO core.producto (codigo, nombre, categoria_id, precio_con_igv, estado, peso_masa_g, perdida_coccion, horas_hombre_lote, horas_horno_lote)
      SELECT 'TP-${sufijo}', 'Pan prueba ${sufijo}', id, 0.35, 'ACTIVO', 55, 0.12, 1, 1 FROM core.categoria ORDER BY orden LIMIT 1 RETURNING id)
    SELECT (SELECT id FROM p) || ',' || (SELECT string_agg(codigo || '=' || id, ',' ORDER BY codigo) FROM i)`).split(',');
  productoId = ids[0];
  const mapa = Object.fromEntries(ids.slice(1).map((x) => x.split('=')));
  harina = mapa[`TH-${sufijo}`]; levadura = mapa[`TL-${sufijo}`];
  const receta = await api(sa, 'PUT', `/recetas/${productoId}`, { rendimiento: 24, mermaEstandar: 0.03, lineas: [
    { insumoId: harina, cantidad: 10 }, { insumoId: mapa[`TA-${sufijo}`], cantidad: 5800, unidad: 'ML' }, { insumoId: levadura, cantidad: 584, unidad: 'G' }] });
  assert.equal(receta.s, 200, JSON.stringify(receta.b));
  // CP-15: con 30 kg de harina en stock, una orden de 40 kg queda en FALTA.
  const { comprarInventario } = flujoCompras(api, login);
  await comprarInventario(harina, 30, 2.80);
  await comprarInventario(levadura, 10, 7.859);
  await comprarInventario(mapa[`TA-${sufijo}`], 100, 0.001);
});

test('CP-12/13/14/15: lotes completos y proporcional, consumo de harina y alerta FALTA', async () => {
  const lc = (await api(pro, 'GET', `/produccion/requerimiento?productoId=${productoId}&cantidad=1000&criterio=LOTES_COMPLETOS`)).b;
  assert.equal(lc.lotes, 4, 'CP-12: 4 lotes completos');
  cerca(lc.unidadesObtenidas, 1155.9, 0.2, 'CP-12: unidades que se obtendrían');
  cerca(lc.masaKg, 65.536, 0.001, 'CP-12: masa total (kg)');
  const h = lc.insumos.find((i) => i.insumoId === harina);
  cerca(h.necesario, 40, 0.001, 'CP-14: harina para 4 lotes (kg)');
  cerca(h.costo, 112, 0.01, 'CP-14: costo de la harina (S/)');
  assert.equal(h.estado, 'FALTA', 'CP-15: 30 kg no alcanzan');
  cerca(h.saldo, -10, 0.001, 'CP-15: saldo');
  const pr = (await api(pro, 'GET', `/produccion/requerimiento?productoId=${productoId}&cantidad=1000&criterio=PROPORCIONAL`)).b;
  cerca(pr.lotes, 3.461, 0.001, 'CP-13: lotes proporcionales');
});

test('CP-16: presupuesto de 4,000 panes con 3 % de merma = 4,124 a preparar (redondeo hacia arriba)', async () => {
  const p = (await api(pro, 'GET', `/produccion/presupuesto?productoId=${productoId}&cantidad=4000&merma=0.03`)).b;
  assert.equal(p.panesAPreparar, 4124);
  assert.ok(p.panesAPreparar * (1 - 0.03) >= 4000, 'los 4,000 buenos quedan garantizados');
});

test('CP-17/18/35: requisición, salida al entregar, cierre con merma y varianza', async () => {
  await flujoCompras(api, login).comprarInventario(harina, 470, 2.80);
  const stock = () => Number(sql(`SELECT stock FROM core.insumo WHERE id = '${harina}'`));
  const op = await api(pro, 'POST', '/ordenes-produccion', { productoId, cantidad: 1000, entrega: new Date().toISOString().slice(0, 10), criterio: 'LOTES_COMPLETOS' });
  assert.equal(op.s, 201, JSON.stringify(op.b));
  assert.equal(op.b.calculo.lotes, 4);
  cerca(stock(), 500, 0.001, 'CP-17: crear la OP no descuenta insumos');

  // Sin entrega de Almacén la OP no se cierra.
  assert.equal((await api(pro, 'POST', `/ordenes-produccion/${op.b.codigo}/iniciar`, {})).s, 200);
  assert.equal((await api(pro, 'POST', `/ordenes-produccion/${op.b.codigo}/cerrar`, { unidadesBuenas: 1100 })).s, 409);

  const req = (await api(alm, 'GET', '/requisiciones')).b.find((r) => r.op === op.b.codigo);
  assert.ok(req, 'Almacén ve la requisición');
  assert.equal((await api(pro, 'POST', `/requisiciones/${req.codigo}/atender`, { lineas: [] })).s, 403, 'Producción no entrega insumos');
  const at = await api(alm, 'POST', `/requisiciones/${req.codigo}/atender`, { lineas: req.lineas.map((l) => ({ insumoId: l.insumoId, cantidad: l.solicitada })) });
  assert.equal(at.s, 200, JSON.stringify(at.b));
  assert.equal(at.b.estado, 'ATENDIDA');
  cerca(stock(), 460, 0.001, 'CP-17: el stock baja al confirmar la salida (500 − 40)');

  // CP-35: levadura teórica × 1.075 → +7.5 % y EXCESO con tolerancia 3 %.
  const teoricaLev = req.lineas.find((l) => l.insumoId === levadura).solicitada;
  const stockPan = () => Number(sql(`SELECT stock FROM core.producto WHERE id = '${productoId}'`));
  const antes = stockPan();
  assert.equal((await api(pro, 'POST', `/ordenes-produccion/${op.b.codigo}/cerrar`, { unidadesBuenas: 1100, unidadesMerma: 20 })).s, 422, 'merma sin motivo');
  const cierre = await api(pro, 'POST', `/ordenes-produccion/${op.b.codigo}/cerrar`, {
    unidadesBuenas: 1100, unidadesMerma: 20, motivoMermaTipo: 'QUEMADO', horasHombreReal: 4, horasHornoReal: 4,
    consumoReal: [{ insumoId: levadura, cantidad: teoricaLev * 1.075 }] });
  assert.equal(cierre.s, 200, JSON.stringify(cierre.b));
  cerca(stockPan() - antes, 1100, 0.001, 'CP-18: el stock de panes sube en las unidades buenas');
  cerca(cierre.b.costoUnitario, cierre.b.costoTotal / 1100, 0.0001, 'RN-28: costo unitario = costo de la OP ÷ unidades buenas');
  cerca(cierre.b.desglose.insumos, Number(sql(`SELECT sum(costo_entregado) FROM core.requisicion_detalle d JOIN core.requisicion q ON q.id = d.requisicion_id WHERE q.codigo = '${req.codigo}'`)), 0.01, 'insumos = lo entregado');

  const hoy = new Date().toISOString().slice(0, 10);
  const v = (await api(ger, 'GET', `/reportes/P-02?desde=${hoy}&hasta=${hoy}&producto=${productoId}`)).b;
  const lev = v.filas.find((f) => f.op === op.b.codigo && f.insumo.startsWith('Levadura'));
  cerca(lev.variacionPct, 0.075, 0.0001, 'CP-35: variación %');
  assert.equal(lev.estado, 'EXCESO');
});

test('PRO-12: anular con motivo; con insumos entregados no se anula', async () => {
  const hoy = new Date().toISOString().slice(0, 10);
  const op = (await api(pro, 'POST', '/ordenes-produccion', { productoId, cantidad: 100, entrega: hoy })).b;
  assert.equal((await api(pro, 'POST', `/ordenes-produccion/${op.codigo}/anular`, { motivo: 'x' })).s, 422);
  assert.equal((await api(pro, 'POST', `/ordenes-produccion/${op.codigo}/anular`, { motivo: 'Pedido cancelado' })).s, 200);
  const op2 = (await api(pro, 'POST', '/ordenes-produccion', { productoId, cantidad: 100, entrega: hoy })).b;
  const req = (await api(alm, 'GET', '/requisiciones')).b.find((r) => r.op === op2.codigo);
  await api(alm, 'POST', `/requisiciones/${req.codigo}/atender`, { lineas: [{ insumoId: harina, cantidad: 1 }] });
  assert.equal((await api(pro, 'POST', `/ordenes-produccion/${op2.codigo}/anular`, { motivo: 'Pedido cancelado' })).s, 409);
});

// El pan y los insumos de prueba no quedan activos en las listas.
after(() => sqlScript(`${ANULAR_COMPRAS_DE_PRUEBA}
  UPDATE core.producto SET estado = 'INACTIVO' WHERE codigo = 'TP-${sufijo}';
  UPDATE core.insumo SET activo = false WHERE codigo IN ('TH-${sufijo}', 'TA-${sufijo}', 'TL-${sufijo}');`));
