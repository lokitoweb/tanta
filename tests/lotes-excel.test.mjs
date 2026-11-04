// node --test tests/lotes-excel.test.mjs  (API en 127.0.0.1:3001 con la semilla)
// Lotes y fechas de vencimiento de insumos (INF-TEC-001 AIN-11): ingreso por lote, consumo FEFO y alerta.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql, sqlScript } from './_sql.mjs';

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

const fecha = (dias) => new Date(Date.now() - 5 * 3_600_000 + dias * 86_400_000).toISOString().slice(0, 10);
const sufijo = randomUUID().slice(0, 6).toUpperCase();
const insumo = () => sql(`WITH i AS (INSERT INTO core.insumo (codigo, nombre, unidad, cpp, stock, minimo)
  VALUES ('T-${randomUUID().slice(0, 8).toUpperCase()}', 'Insumo prueba lotes', 'KG', 1, 0, 0) RETURNING id) SELECT id FROM i`);
const proveedor = async () => (await api(await login('lbermudez'), 'POST', '/proveedores', { razonSocial: `Proveedor prueba ${randomUUID().slice(0, 8)}` })).b.id;
const saldos = (id) => sql(`SELECT string_agg(lote || '=' || saldo::numeric(10,2), ' ' ORDER BY id) FROM core.lote_insumo WHERE insumo_id = '${id}'`);

test('AIN-11: cada línea de compra entra como lote; la salida consume primero el que vence antes', async () => {
  const alm = await login('jramos');
  const id = insumo(), prov = await proveedor();
  const compra = (doc, lote, vence, cantidad) => api(alm, 'POST', '/compras', { proveedorId: prov, docTipo: 'GUIA', docNumero: doc, items: [{ insumoId: id, cantidad, precio: 1, lote, venceEn: vence }] });
  assert.equal((await compra(`G-${sufijo}-1`, `L${sufijo}A`, fecha(40), 10)).s, 201, 'lote que vence después');
  assert.equal((await compra(`G-${sufijo}-2`, `L${sufijo}B`, fecha(10), 10)).s, 201, 'lote que vence antes');
  assert.equal((await compra(`G-${sufijo}-3`, `L${sufijo}V`, fecha(-1), 5)).s, 422, 'un lote vencido no se recibe');

  // Baja de 12: FEFO toma los 10 del lote B (vence antes) y 2 del lote A.
  assert.equal((await api(alm, 'POST', '/inventario/movimientos', { tipo: 'MERMA', insumoId: id, cantidad: 12, motivo: 'Prueba FEFO' })).s, 200);
  assert.equal(saldos(id), `L${sufijo}A=8.00 L${sufijo}B=0.00`);
  assert.equal(Number(sql(`SELECT stock FROM core.insumo WHERE id = '${id}'`)), 8, 'los lotes suman el stock');

  const l = await api(alm, 'GET', `/lotes?insumoId=${id}`);
  assert.equal(l.s, 200);
  assert.deepEqual(l.b.map((x) => [x.lote, x.saldo, x.estado]), [[`L${sufijo}A`, 8, 'VIGENTE']], 'solo lotes con saldo');
  const codigo = sql(`SELECT codigo FROM core.insumo WHERE id = '${id}'`);
  assert.ok((await api(alm, 'GET', `/kardex/${codigo}`)).b.some((m) => m.lote === `L${sufijo}A` && m.vence === fecha(40)), 'el kárdex muestra lote y vencimiento');
});

test('una compra sin número de lote crea uno propio y una entrada sin lote también se rastrea', async () => {
  const alm = await login('jramos');
  const id = insumo(), prov = await proveedor();
  assert.equal((await api(alm, 'POST', '/compras', { proveedorId: prov, docTipo: 'GUIA', docNumero: `G-${sufijo}-9`, items: [{ insumoId: id, cantidad: 3, precio: 2 }] })).s, 201);
  assert.match(sql(`SELECT lote FROM core.lote_insumo WHERE insumo_id = '${id}'`), /^S\/L-\d+$/);
  assert.equal(sql(`SELECT vence_en IS NULL FROM core.lote_insumo WHERE insumo_id = '${id}'`), 't');
});

test('alerta de vencimiento: una sola vez por lote, a quien tiene alertas.stock', async () => {
  const alm = await login('jramos'), ger = await login('osquilcate');
  const id = insumo(), prov = await proveedor();
  const dias = Number(sql("SELECT valor FROM core.parametro WHERE clave = 'dias_alerta_vencimiento'"));
  const lote = `L${sufijo}X`;
  assert.equal((await api(alm, 'POST', '/compras', { proveedorId: prov, docTipo: 'GUIA', docNumero: `G-${sufijo}-X`, items: [{ insumoId: id, cantidad: 4, precio: 1, lote, venceEn: fecha(Math.max(dias - 1, 0)) }] })).s, 201);
  let aviso = null;
  for (let i = 0; i < 30 && !aviso; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    aviso = (await api(ger, 'GET', '/notificaciones')).b.avisos.find((a) => a.cuerpo.includes(lote));
  }
  assert.ok(aviso, 'el gerente recibe la alerta del lote');
  assert.equal(aviso.titulo, 'Lote por vencer');
  await new Promise((r) => setTimeout(r, 16_000));
  const veces = (await api(ger, 'GET', '/notificaciones')).b.avisos.filter((a) => a.cuerpo.includes(lote)).length;
  assert.equal(veces, 1, 'no se repite');
  assert.ok((await api(alm, 'GET', `/lotes?dias=${dias}`)).b.some((x) => x.lote === lote), 'aparece en los lotes por vencer');
});

after(() => sqlScript(`UPDATE core.insumo SET activo = false WHERE nombre = 'Insumo prueba lotes';
  UPDATE core.proveedor SET estado = 'INACTIVO' WHERE razon_social LIKE 'Proveedor prueba %';`));
