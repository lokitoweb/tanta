// node --test tests/almacen-excel.test.mjs  (API en 127.0.0.1:3001 con la semilla)
// Almacén del INF-TEC-001: proveedores (MAE-09), compras con CPP y conteo físico con aprobación del Gerente.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql, sqlScript } from './_sql.mjs';

const B = process.env.API ?? 'http://127.0.0.1:3001/api/v1';
const sesiones = new Map();
const login = (u) => { if (!sesiones.has(u)) sesiones.set(u, fetch(B + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario: u, clave: 'tanta' }) }).then((r) => r.json()).then((j) => j.accessToken)); return sesiones.get(u); };
const api = (t, m, ruta, body) => fetch(B + ruta, {
  method: m, headers: { Authorization: 'Bearer ' + t, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));

// RUC válido y único por corrida.
const ruc = () => '20' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
// Insumo propio por prueba: stock y CPP conocidos, sin depender de los datos de ejemplo.
const insumo = (stock, cpp) => sql(`WITH i AS (INSERT INTO core.insumo (codigo, nombre, unidad, cpp, stock, minimo)
  VALUES ('T-${randomUUID().slice(0, 8)}', 'Insumo prueba almacén', 'KG', ${cpp}, ${stock}, 0) RETURNING id) SELECT id FROM i`);
const stock = (id) => Number(sql(`SELECT stock FROM core.insumo WHERE id = '${id}'`));

test('MAE-09: proveedor con RUC único; con compras solo se inactiva', async () => {
  const alm = await login('jramos');
  const r = ruc();
  const p = await api(alm, 'POST', '/proveedores', { ruc: r, razonSocial: `Proveedor prueba ${r}` });
  assert.equal(p.s, 201, JSON.stringify(p.b));
  assert.equal((await api(alm, 'POST', '/proveedores', { ruc: r, razonSocial: `Otro ${r}` })).s, 409, 'RUC duplicado');
  assert.equal((await api(alm, 'POST', '/proveedores', { ruc: '12345678901', razonSocial: 'RUC inválido' })).s, 422);
  assert.equal((await api(await login('cmedina'), 'POST', '/proveedores', { razonSocial: 'Sin permiso' })).s, 403);
  const ins = insumo(0, 1);
  assert.equal((await api(alm, 'POST', '/compras', { proveedorId: p.b.id, docTipo: 'FACTURA', docNumero: 'F001-1', items: [{ insumoId: ins, cantidad: 1, precio: 1 }] })).s, 201);
  assert.equal((await api(alm, 'DELETE', `/proveedores/${p.b.id}`)).s, 409, 'con compras no se elimina');
  assert.equal((await api(alm, 'PATCH', `/proveedores/${p.b.id}`, { ruc: r, razonSocial: `Proveedor prueba ${r}`, estado: 'INACTIVO' })).s, 200);
  assert.equal((await api(alm, 'POST', '/compras', { proveedorId: p.b.id, docTipo: 'FACTURA', docNumero: 'F001-2', items: [{ insumoId: ins, cantidad: 1, precio: 1 }] })).s, 409, 'inactivo no compra');
});

test('compra con varias líneas: stock y costo promedio ponderado; el documento no se repite', async () => {
  const alm = await login('jramos');
  const p = await api(alm, 'POST', '/proveedores', { ruc: ruc(), razonSocial: `Molino prueba ${randomUUID().slice(0, 6)}` });
  const a = insumo(10, 2), b = insumo(0, 0);
  const doc = `F001-${Date.now() % 1e6}`;
  const c = await api(alm, 'POST', '/compras', { proveedorId: p.b.id, docTipo: 'FACTURA', docNumero: doc, items: [{ insumoId: a, cantidad: 10, precio: 4 }, { insumoId: b, cantidad: 5, precio: 3 }] });
  assert.equal(c.s, 201, JSON.stringify(c.b));
  assert.equal(c.b.total, 55);
  assert.equal(stock(a), 20);
  assert.equal(Number(sql(`SELECT cpp FROM core.insumo WHERE id = '${a}'`)), 3, '(10·2 + 10·4) / 20 = 3');
  assert.equal(Number(sql(`SELECT cpp FROM core.insumo WHERE id = '${b}'`)), 3);
  assert.equal(sql(`SELECT count(*) FROM core.movimiento_inventario WHERE insumo_id IN ('${a}','${b}') AND tipo = 'COMPRA'`), '2', 'una entrada al kárdex por línea');
  assert.equal((await api(alm, 'POST', '/compras', { proveedorId: p.b.id, docTipo: 'FACTURA', docNumero: doc, items: [{ insumoId: a, cantidad: 1, precio: 1 }] })).s, 409, 'documento repetido');
  assert.equal((await api(alm, 'POST', '/compras', { proveedorId: p.b.id, docTipo: 'FACTURA', docNumero: 'F9', items: [{ insumoId: a, cantidad: 0, precio: 1 }] })).s, 422, 'cantidad mayor a cero');
  assert.equal((await api(await login('rquispe'), 'POST', '/compras', { proveedorId: p.b.id, docTipo: 'BOLETA', docNumero: 'B001-1', items: [{ insumoId: a, cantidad: 1, precio: 1 }] })).s, 403);
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
after(() => sqlScript(`UPDATE core.insumo SET activo = false WHERE nombre = 'Insumo prueba almacén';
  UPDATE core.proveedor SET estado = 'INACTIVO' WHERE razon_social LIKE 'Proveedor prueba %' OR razon_social LIKE 'Molino prueba %';`));
