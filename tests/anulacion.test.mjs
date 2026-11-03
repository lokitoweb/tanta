// node --test tests/anulacion.test.mjs  (API en 127.0.0.1:3001 con la semilla)
// Anulación de ventas (devuelve stock, cancela la deuda) y bajas/devoluciones de producto terminado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from './_sql.mjs';

const B = process.env.API ?? 'http://127.0.0.1:3001/api/v1';
const login = async (u) => (await (await fetch(B + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario: u, clave: 'tanta' }) })).json()).accessToken;
const api = (t, m, ruta, body) => fetch(B + ruta, {
  method: m, headers: { Authorization: 'Bearer ' + t, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));

const productoConStock = () => sql("SELECT id FROM core.producto WHERE stock >= 5 ORDER BY nombre LIMIT 1");
// Cliente propio con crédito sin límite: no depende de la deuda que traigan los datos de ejemplo.
// (Dentro de un WITH: psql no agrega la línea "INSERT 0 1" a la salida.)
const clientePrueba = () => sql(`WITH c AS (INSERT INTO core.cliente (codigo, nombre, dias_credito, limite_credito)
  VALUES ('CLI-ANUL', 'Cliente prueba anulación', 30, 0)
  ON CONFLICT (codigo) DO UPDATE SET limite_credito = 0 RETURNING id) SELECT id FROM c`);
const stock = (id) => Number(sql(`SELECT stock FROM core.producto WHERE id = '${id}'`));

test('anular una venta al crédito devuelve el stock y cancela la deuda', async () => {
  const vend = await login('cmedina');
  const ger = await login('osquilcate');
  const prod = productoConStock();
  const cliente = clientePrueba();
  const antes = stock(prod);
  const v = await api(vend, 'POST', '/ventas', { items: [{ productoId: prod, cantidad: 2 }], formaPago: 'CREDITO', clienteId: cliente });
  assert.equal(v.s, 201, JSON.stringify(v.b));
  assert.equal(stock(prod), antes - 2);

  assert.equal((await api(vend, 'POST', `/ventas/${v.b.codigo}/anular`, { motivo: 'Error de digitación' })).s, 403, 'el vendedor no anula');
  assert.equal((await api(ger, 'POST', `/ventas/${v.b.codigo}/anular`, { motivo: 'x' })).s, 422, 'motivo obligatorio');
  const a = await api(ger, 'POST', `/ventas/${v.b.codigo}/anular`, { motivo: 'Error de digitación' });
  assert.equal(a.s, 200, JSON.stringify(a.b));
  assert.equal(stock(prod), antes, 'el stock vuelve');
  assert.equal(sql(`SELECT estado FROM core.cuenta_por_cobrar WHERE venta_id = '${v.b.ventaId}'`), 'ANULADA');
  assert.equal(sql(`SELECT estado FROM core.venta WHERE id = '${v.b.ventaId}'`), 'ANULADA');
  assert.equal((await api(ger, 'POST', `/ventas/${v.b.codigo}/anular`, { motivo: 'Otra vez' })).s, 409, 'no se anula dos veces');
});

test('una venta con cobros no se puede anular', async () => {
  const vend = await login('cmedina');
  const prod = productoConStock();
  const cliente = clientePrueba();
  const v = await api(vend, 'POST', '/ventas', { items: [{ productoId: prod, cantidad: 1 }], formaPago: 'CREDITO', clienteId: cliente });
  assert.equal(v.s, 201);
  const cxc = sql(`SELECT id FROM core.cuenta_por_cobrar WHERE venta_id = '${v.b.ventaId}'`);
  assert.equal((await api(vend, 'POST', '/cobranza', { cxcId: cxc, monto: 0.5, medio: 'EFECTIVO' })).s, 201);
  assert.equal((await api(await login('osquilcate'), 'POST', `/ventas/${v.b.codigo}/anular`, { motivo: 'Cliente desistió' })).s, 409);
});

test('baja y devolución de producto terminado con motivo tipificado', async () => {
  const alm = await login('jramos');
  const prod = productoConStock();
  const antes = stock(prod);
  const baja = await api(alm, 'POST', '/inventario/productos', { productoId: prod, cantidad: 1, motivoTipo: 'VENCIMIENTO', motivo: 'Lote vencido' });
  assert.equal(baja.s, 200, JSON.stringify(baja.b));
  assert.equal(stock(prod), antes - 1);
  const dev = await api(alm, 'POST', '/inventario/productos', { productoId: prod, cantidad: 1, motivoTipo: 'DEVOLUCION', motivo: 'Devuelto por cliente' });
  assert.equal(dev.s, 200);
  assert.equal(stock(prod), antes);
  assert.equal(sql(`SELECT motivo_tipo FROM core.movimiento_inventario WHERE producto_id = '${prod}' ORDER BY id DESC LIMIT 1`), 'DEVOLUCION');
  assert.equal((await api(alm, 'POST', '/inventario/productos', { productoId: prod, cantidad: 1e5, motivoTipo: 'MERMA', motivo: 'Demasiado' })).s, 409, 'sin stock negativo');
  assert.equal((await api(await login('cmedina'), 'POST', '/inventario/productos', { productoId: prod, cantidad: 1, motivoTipo: 'MERMA', motivo: 'No autorizado' })).s, 403);
});
