// node --test tests/ofertas-y-costos.test.mjs  (API de pruebas con la semilla)
// Informe «modificaciones sistema tanta» (13/11): CPP como el Excel del cliente, unidades reales por lote en el costo,
// ofertas con unidades limitadas (aviso de agotada), pedido de oferta aparte que no pasa por producción.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from './_sql.mjs';
import { flujoCompras, hoyLima } from './_compras.mjs';

const B = process.env.API ?? 'http://127.0.0.1:3001/api/v1';
const sesiones = new Map();
const entrar = async (u) => {
  for (let i = 0; i < 10; i++) {
    const r = await fetch(B + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario: u, clave: 'tanta' }) });
    if (r.status !== 429) return (await r.json()).accessToken;
    await new Promise((ok) => setTimeout(ok, 7000));
  }
  throw new Error('login bloqueado por el límite');
};
const login = (u) => { if (!sesiones.has(u)) sesiones.set(u, entrar(u)); return sesiones.get(u); };
const api = (t, m, ruta, body) => fetch(B + ruta, {
  method: m, headers: { Authorization: 'Bearer ' + t, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));
const cerca = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} ≈ ${b}`);

test('CPP: mismo resultado que el Excel del cliente (saldo inicial, compra, salida, compra)', async () => {
  const adm = await login('lbermudez'), alm = await login('jramos');
  const codigo = `CPP-${randomUUID().slice(0, 6)}`;
  const id = sql(`INSERT INTO core.insumo (codigo, nombre, unidad, cpp, stock, minimo, tipo, unidad_inventario, maneja_stock)
    SELECT '${codigo}', 'Harina CPP prueba', 'KG', 0, 0, 0, tipo, 'KG', true FROM core.insumo WHERE unidad = 'KG' LIMIT 1 RETURNING id`).split('\n')[0];
  const ini = await api(adm, 'POST', '/inventario/inicial', { filas: [{ tipo: 'INSUMO', codigo, cantidad: 120, costoUnitario: 2.8 }] });
  assert.equal(ini.s, 200, JSON.stringify(ini.b));
  const saldo = () => sql(`SELECT saldo_cantidad || '|' || saldo_valor || '|' || cpp || '|' || costo_unitario FROM core.movimiento_inventario WHERE insumo_id = '${id}' ORDER BY id DESC LIMIT 1`).split('|').map(Number);
  const compras = flujoCompras(api, login);

  await compras.comprarInventario(id, 500, 2.95);
  let [stock, valor, cpp, costo] = saldo();
  // CPP nuevo = (stock × CPP + comprado × costo) ÷ (stock + comprado), con el costo que registró la compra.
  cerca(cpp, (120 * 2.8 + 500 * costo) / 620, 0.0001, 'CPP tras la compra');
  assert.equal(stock, 620);
  if (Math.abs(costo - 2.95) < 1e-6) { cerca(cpp, 2.921, 0.0005, 'fila 6 del Excel'); cerca(valor, 1811, 0.01, 'valor del stock'); }

  // La salida no cambia el CPP: reduce stock y valor en la misma proporción.
  assert.equal((await api(alm, 'POST', '/inventario/movimientos', { tipo: 'MERMA', motivoTipo: 'CONSUMO', insumoId: id, cantidad: 180, motivo: 'Salida a producción' })).s, 200);
  const cppAntes = cpp;
  [stock, valor, cpp] = saldo();
  assert.equal(stock, 440);
  cerca(cpp, cppAntes, 1e-6, 'la salida no cambia el CPP');
  cerca(valor, 440 * cppAntes, 0.01, 'valor = stock × CPP');

  await compras.comprarInventario(id, 300, 3.05);
  [stock, valor, cpp, costo] = saldo();
  cerca(cpp, (440 * cppAntes + 300 * costo) / 740, 0.0001, 'CPP tras la segunda compra');
  if (Math.abs(costo - 3.05) < 1e-6) cerca(cpp, 2.973, 0.0005, 'fila 8 del Excel');
});

test('Recetas: las unidades reales del producto mandan en el costo de insumos por pan', () => {
  const prod = sql(`SELECT p.id FROM core.producto p JOIN core.receta r ON r.producto_id = p.id AND r.estado = 'VIGENTE' WHERE p.insumo_id IS NULL AND r.costo_lote > 0 ORDER BY p.nombre LIMIT 1`);
  assert.ok(prod, 'hace falta un producto con receta');
  const antes = sql(`SELECT coalesce(unidades_lote::text, '') || '|' || coalesce(peso_masa_g::text, '') FROM core.producto WHERE id = '${prod}'`).split('|');
  try {
    sql(`UPDATE core.producto SET unidades_lote = 20, peso_masa_g = 450 WHERE id = '${prod}'`);
    sql('SELECT core.recalcular_costos()');
    const [esperadas, conMerma, lote, teoricas] = sql(`SELECT unidades_esperadas || '|' || costo_con_merma || '|' || costo_lote || '|' || unidades_teoricas FROM core.receta WHERE producto_id = '${prod}'`).split('|').map(Number);
    assert.equal(esperadas, 20, 'se planifica y costea con las 20 unidades reales');
    cerca(conMerma, lote / 20, 0.0001, 'costo de insumos por pan = costo del lote ÷ 20');
    assert.ok(teoricas > 0, 'el cálculo por peso queda como referencia');
    // Sin unidades reales vuelve el cálculo por peso.
    sql(`UPDATE core.producto SET unidades_lote = NULL WHERE id = '${prod}'`);
    sql('SELECT core.recalcular_costos()');
    assert.notEqual(Number(sql(`SELECT unidades_esperadas FROM core.receta WHERE producto_id = '${prod}'`)), 20);
  } finally {
    sql(`UPDATE core.producto SET unidades_lote = ${antes[0] || 'NULL'}, peso_masa_g = ${antes[1] || 'NULL'} WHERE id = '${prod}'`);
    sql('SELECT core.recalcular_costos()');
  }
});

test('Oferta: unidades limitadas, pedido aparte sin producción, aviso de agotada y reapertura al cancelar', async () => {
  const adm = await login('lbermudez'), cli = await login('mfernandez'), ven = await login('cmedina');
  const [promoProd, regular] = sql(`SELECT id FROM core.producto WHERE estado = 'ACTIVO' AND insumo_id IS NULL AND anticipacion_horas <= 24 ORDER BY nombre LIMIT 2`).split('\n');
  sql(`UPDATE core.producto SET stock = stock + 100 WHERE id = '${promoProd}'`);
  const titulo = `Oferta prueba ${randomUUID().slice(0, 6)}`;
  const p = await api(adm, 'POST', '/promociones', { productoId: promoProd, titulo, precioConIgv: 2, desde: hoyLima(), hasta: hoyLima(), cantidad: 5, avisar: false });
  assert.equal(p.s, 201, JSON.stringify(p.b));
  after(() => { sql(`UPDATE core.promocion SET activa = false WHERE id = '${p.b.id}'`); });
  const vigente = async () => (await api(cli, 'GET', '/promociones/vigentes')).b.find((x) => x.id === p.b.id);
  assert.equal((await vigente()).disponible, 5, 'el cliente ve las 5 unidades ofrecidas');

  // Carrito mixto: sale un pedido regular y otro de oferta (se cobran aparte).
  const r1 = await api(cli, 'POST', '/pedidos', { items: [{ productoId: regular, cantidad: 1 }, { productoId: promoProd, cantidad: 3, promocionId: p.b.id }] });
  assert.equal(r1.s, 201, JSON.stringify(r1.b));
  assert.equal(r1.b.pedidos.length, 2);
  const of1 = r1.b.pedidos.find((x) => x.esOferta), reg = r1.b.pedidos.find((x) => !x.esOferta);
  assert.equal(r1.b.codigo, reg.codigo, 'compatibilidad: el primero es el regular');
  assert.equal(of1.total, 6);
  assert.equal(sql(`SELECT es_oferta::text FROM core.pedido WHERE codigo = '${of1.codigo}'`), 'true');
  assert.equal((await vigente()).disponible, 2);

  assert.equal((await api(cli, 'POST', '/pedidos', { items: [{ productoId: promoProd, cantidad: 3, promocionId: p.b.id }] })).s, 409, 'no se pasa de lo ofrecido');
  const r2 = await api(cli, 'POST', '/pedidos', { items: [{ productoId: promoProd, cantidad: 2, promocionId: p.b.id }] });
  assert.equal(r2.s, 201, JSON.stringify(r2.b));
  assert.equal(r2.b.pedidos.length, 1);
  assert.ok(sql(`SELECT agotada_en FROM core.promocion WHERE id = '${p.b.id}'`), 'quedó marcada como agotada');
  assert.equal(await vigente(), undefined, 'ya no se ofrece');
  await new Promise((ok) => setTimeout(ok, 500));
  assert.ok(Number(sql(`SELECT count(*) FROM core.notificacion WHERE titulo = 'Promoción agotada: ${titulo}'`)) >= 1, 'se avisó a los clientes');

  // El vendedor confirma la oferta: queda lista para despacho, sin producción.
  const c = await api(ven, 'PATCH', `/pedidos/${of1.codigo}/estado`, { estado: 'CONFIRMADO' });
  assert.equal(c.s, 200, JSON.stringify(c.b));
  assert.equal(sql(`SELECT estado FROM core.pedido WHERE codigo = '${of1.codigo}'`), 'LISTO');
  assert.equal(sql(`SELECT count(*) FROM core.pedido_detalle d JOIN core.pedido k ON k.id = d.pedido_id WHERE k.codigo = '${of1.codigo}' AND d.promocion_id IS NULL`), '0', 'no tiene nada que producir');

  // Si se cancela, las unidades vuelven a la oferta.
  assert.equal((await api(ven, 'PATCH', `/pedidos/${of1.codigo}/estado`, { estado: 'CANCELADO', motivo: 'Prueba de reapertura' })).s, 200);
  assert.equal(sql(`SELECT agotada_en IS NULL FROM core.promocion WHERE id = '${p.b.id}'`), 't');
  assert.equal((await vigente()).disponible, 3);

  for (const x of [reg.codigo, r2.b.codigo]) await api(cli, 'POST', `/pedidos/${x}/cancelar`, { motivo: 'Fin de prueba' });
});
