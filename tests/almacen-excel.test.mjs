// node --test tests/almacen-excel.test.mjs  (API en 127.0.0.1:3001 con la semilla)
// Almacén del INF-TEC-001: proveedores (MAE-09), compras con CPP y conteo físico con aprobación del Gerente.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql, sqlScript } from './_sql.mjs';
import { flujoCompras, hoyLima, nroUnico, ANULAR_COMPRAS_DE_PRUEBA } from './_compras.mjs';

const B = process.env.API ?? 'http://127.0.0.1:3001/api/v1';
const sesiones = new Map();
const login = (u) => { if (!sesiones.has(u)) sesiones.set(u, fetch(B + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario: u, clave: 'tanta' }) }).then((r) => r.json()).then((j) => j.accessToken)); return sesiones.get(u); };
const api = (t, m, ruta, body) => fetch(B + ruta, {
  method: m, headers: { Authorization: 'Bearer ' + t, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));

// RUC válido y único por corrida.
const { registrar, verificar } = flujoCompras(api, login);
const ruc = () => '20' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
// Insumo propio por prueba: stock y CPP conocidos, sin depender de los datos de ejemplo.
const insumo = (stock, cpp) => sql(`WITH i AS (INSERT INTO core.insumo (codigo, nombre, unidad, cpp, stock, minimo)
  VALUES ('T-${randomUUID().slice(0, 8)}', 'Insumo prueba almacén', 'KG', ${cpp}, ${stock}, 0) RETURNING id) SELECT id FROM i`);
const stock = (id) => Number(sql(`SELECT stock FROM core.insumo WHERE id = '${id}'`));

test('MAE-09: proveedor con RUC único; con compras solo se inactiva', async () => {
  const alm = await login('jramos'), adm = await login('lbermudez');
  const r = ruc();
  assert.equal((await api(alm, 'POST', '/proveedores', { ruc: r, razonSocial: 'Almacén solo consulta' })).s, 403, 'matriz fila 6: Almacén consulta');
  assert.equal((await api(alm, 'GET', '/proveedores')).s, 200);
  const p = await api(adm, 'POST', '/proveedores', { ruc: r, razonSocial: `Proveedor prueba ${r}` });
  assert.equal(p.s, 201, JSON.stringify(p.b));
  assert.equal((await api(adm, 'POST', '/proveedores', { ruc: r, razonSocial: `Otro ${r}` })).s, 409, 'RUC duplicado');
  assert.equal((await api(adm, 'POST', '/proveedores', { ruc: '12345678901', razonSocial: 'RUC inválido' })).s, 422);
  assert.equal((await api(await login('cmedina'), 'POST', '/proveedores', { razonSocial: 'Sin permiso' })).s, 403);
  const ins = insumo(0, 1);
  assert.equal((await registrar(p.b.id, [{ insumoId: ins, cantidad: 1, precioUnitario: 1 }])).s, 201);
  assert.equal((await api(adm, 'DELETE', `/proveedores/${p.b.id}`)).s, 409, 'con compras no se elimina');
  assert.equal((await api(adm, 'PATCH', `/proveedores/${p.b.id}`, { ruc: r, razonSocial: `Proveedor prueba ${r}`, estado: 'INACTIVO' })).s, 200);
  assert.equal((await registrar(p.b.id, [{ insumoId: ins, cantidad: 1, precioUnitario: 1 }])).s, 409, 'inactivo no compra');
});

test('compra con varias líneas: al verificar, stock y costo promedio ponderado; el documento no se repite', async () => {
  const p = await api(await login('lbermudez'), 'POST', '/proveedores', { ruc: ruc(), razonSocial: `Molino prueba ${randomUUID().slice(0, 6)}` });
  const a = insumo(10, 2), b = insumo(0, 0);
  // Boleta: sin crédito fiscal, el precio es el costo (la factura descuenta el IGV: lo prueba catalogos.test).
  const doc = { docTipo: 'BOLETA', serie: 'B001', nro: nroUnico() };
  const c = await registrar(p.b.id, [{ insumoId: a, cantidad: 10, precioUnitario: 4 }, { insumoId: b, cantidad: 5, precioUnitario: 3 }], doc);
  assert.equal(c.s, 201, JSON.stringify(c.b));
  assert.equal(c.b.total, 55);
  assert.equal(stock(a), 10, 'registrada no ingresa stock');
  assert.equal((await verificar(c.b)).b.estado, 'VERIFICADA');
  assert.equal(stock(a), 20);
  assert.equal(Number(sql(`SELECT cpp FROM core.insumo WHERE id = '${a}'`)), 3, '(10·2 + 10·4) / 20 = 3');
  assert.equal(Number(sql(`SELECT cpp FROM core.insumo WHERE id = '${b}'`)), 3);
  assert.equal(sql(`SELECT count(*) FROM core.movimiento_inventario WHERE insumo_id IN ('${a}','${b}') AND tipo = 'COMPRA'`), '2', 'una entrada al kárdex por línea');
  assert.equal((await registrar(p.b.id, [{ insumoId: a, cantidad: 1, precioUnitario: 1 }], doc)).s, 409, 'documento repetido');
  assert.equal((await registrar(p.b.id, [{ insumoId: a, cantidad: 0, precioUnitario: 1 }])).s, 422, 'cantidad mayor a cero');
  assert.equal((await api(await login('rquispe'), 'POST', '/compras', { proveedorId: p.b.id, docTipo: 'BOLETA', serie: 'B001', nro: nroUnico(), fechaCompra: hoyLima(), items: [{ insumoId: a, cantidad: 1, precioUnitario: 1 }] })).s, 403);
});

test('conteo físico: las diferencias se ajustan solo con aprobación del Gerente', async () => {
  const alm = await login('jramos'), ger = await login('osquilcate');
  const a = insumo(10, 2), b = insumo(5, 1);
  const k = await api(alm, 'POST', '/conteos', { observacion: 'Inventario de prueba', items: [{ insumoId: a, contado: 8 }, { insumoId: b, contado: 5 }] });
  assert.equal(k.s, 201, JSON.stringify(k.b));
  assert.equal(k.b.diferencias, 1);
  assert.equal(stock(a), 10, 'sin aprobación no cambia el stock');
  assert.equal((await api(alm, 'POST', `/conteos/${k.b.id}/resolver`, { aprobar: true })).s, 403, 'el almacenero no aprueba');
  // Un movimiento posterior al conteo no se pisa: el ajuste es por la diferencia.
  sql(`WITH u AS (UPDATE core.insumo SET stock = stock + 1 WHERE id = '${a}' RETURNING 1) SELECT 1 FROM u`);
  const ok = await api(ger, 'POST', `/conteos/${k.b.id}/resolver`, { aprobar: true });
  assert.equal(ok.s, 200, JSON.stringify(ok.b));
  assert.equal(ok.b.ajustes, 1);
  assert.equal(stock(a), 9, '11 − 2 de diferencia');
  assert.equal(sql(`SELECT documento FROM core.movimiento_inventario WHERE insumo_id = '${a}' AND tipo = 'AJUSTE'`), `Conteo ${k.b.codigo}`);
  assert.equal((await api(ger, 'POST', `/conteos/${k.b.id}/resolver`, { aprobar: true })).s, 409, 'no se aprueba dos veces');

  const r = await api(alm, 'POST', '/conteos', { items: [{ insumoId: b, contado: 1 }] });
  assert.equal((await api(ger, 'POST', `/conteos/${r.b.id}/resolver`, { aprobar: false })).s, 422, 'rechazo con motivo');
  assert.equal((await api(ger, 'POST', `/conteos/${r.b.id}/resolver`, { aprobar: false, motivo: 'Volver a contar' })).s, 200);
  assert.equal(stock(b), 5, 'rechazado no ajusta');
  const lista = await api(alm, 'GET', '/conteos');
  assert.ok(!('valor' in lista.b[0].items[0]), 'el almacenero no ve valores');
});

// Los insumos y proveedores de prueba no quedan activos en las listas.
after(() => sqlScript(`${ANULAR_COMPRAS_DE_PRUEBA}
  UPDATE core.insumo SET activo = false WHERE nombre = 'Insumo prueba almacén';
  UPDATE core.proveedor SET estado = 'INACTIVO' WHERE razon_social LIKE 'Proveedor prueba %' OR razon_social LIKE 'Molino prueba %';`));

test('CP-21: al bajar del mínimo hay una sola alerta hasta que el stock se recupere', async () => {
  const alm = await login('jramos');
  const id = sql(`WITH i AS (INSERT INTO core.insumo (codigo, nombre, unidad, cpp, stock, minimo)
    VALUES ('T-${randomUUID().slice(0, 8)}', 'Insumo prueba almacén', 'KG', 1, 10, 5) RETURNING id) SELECT id FROM i`);
  const alertas = () => Number(sql(`SELECT count(*) FROM core.alerta_stock WHERE insumo_id = '${id}'`));
  const baja = (cantidad) => api(alm, 'POST', '/inventario/movimientos', { tipo: 'MERMA', insumoId: id, cantidad, motivo: 'Prueba de alerta' });
  assert.equal((await baja(3)).s, 200);
  assert.equal(alertas(), 0, 'sobre el mínimo no alerta');
  assert.equal((await baja(4)).s, 200);
  assert.equal(sql(`SELECT estado FROM core.insumo WHERE id = '${id}'`), 'BAJO_MINIMO', 'el estado lo calcula la base en cualquier movimiento');
  assert.equal(alertas(), 1, 'cruzó el mínimo: una alerta');
  assert.equal((await baja(1)).s, 200);
  assert.equal(alertas(), 1, 'sigue bajo el mínimo: no se repite');
  const p = await api(await login('lbermudez'), 'POST', '/proveedores', { razonSocial: `Proveedor prueba ${randomUUID().slice(0, 8)}` });
  const compra = await registrar(p.b.id, [{ insumoId: id, cantidad: 10, precioUnitario: 1 }]);
  assert.equal((await verificar(compra.b)).b.estado, 'VERIFICADA');
  assert.equal(sql(`SELECT estado FROM core.insumo WHERE id = '${id}'`), 'OK', 'la compra lo recupera');
  assert.equal((await baja(9)).s, 200);
  assert.equal(alertas(), 2, 'volvió a bajar: nueva alerta');
  // El despachador la envía una sola vez (revisa cada 15 s).
  let enviadas = 0;
  for (let i = 0; i < 25 && enviadas < 2; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    enviadas = Number(sql(`SELECT count(*) FROM core.alerta_stock WHERE insumo_id = '${id}' AND enviada_en IS NOT NULL`));
  }
  assert.equal(enviadas, 2, 'cada alerta se envía');
});
