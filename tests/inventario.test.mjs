// node --test tests/inventario.test.mjs  (API en 127.0.0.1:3001 con la semilla)
// Compra recalcula el CPP, la baja no deja stock negativo, el conteo genera ajuste, solo Almacén mueve.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const B = process.env.API ?? 'http://127.0.0.1:3001/api/v1';
const login = async (u) => (await (await fetch(B + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario: u, clave: 'tanta' }) })).json()).accessToken;
const mover = (t, body, clave = randomUUID()) => fetch(B + '/inventario/movimientos', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t, 'Idempotency-Key': clave }, body: JSON.stringify(body),
}).then(async (r) => ({ s: r.status, b: await r.json() }));
const insumo = async (t) => (await (await fetch(B + '/datos', { headers: { Authorization: 'Bearer ' + t } })).json()).insumos[0];

test('flujo de inventario', async () => {
  const alm = await login('jramos');
  const i0 = await insumo(alm);

  const compra = await mover(alm, { tipo: 'COMPRA', insumoId: i0.id, cantidad: 10, costoUnitario: i0.cpp * 2 || 5, motivo: 'Prueba compra' });
  assert.equal(compra.s, 200);
  const esperado = (i0.stock * i0.cpp + 10 * (i0.cpp * 2 || 5)) / (i0.stock + 10);
  assert.ok(Math.abs(compra.b.cpp - esperado) < 0.001, `CPP ${compra.b.cpp} vs ${esperado}`);

  const exceso = await mover(alm, { tipo: 'MERMA', insumoId: i0.id, cantidad: 1e6, motivo: 'Demasiado' });
  assert.equal(exceso.s, 409);

  const conteo = await mover(alm, { tipo: 'CONTEO', insumoId: i0.id, cantidadContada: compra.b.saldo - 1, motivo: 'Conteo de prueba' });
  assert.equal(conteo.s, 403, 'el ajuste por conteo necesita la aprobación del Gerente');

  const k = randomUUID();
  const a = await mover(alm, { tipo: 'MERMA', insumoId: i0.id, cantidad: 0.5, motivo: 'Idempotencia' }, k);
  const b = await mover(alm, { tipo: 'MERMA', insumoId: i0.id, cantidad: 0.5, motivo: 'Idempotencia' }, k);
  assert.deepEqual(a.b, b.b, 'el reintento no duplica la baja');

  assert.equal((await mover(alm, { tipo: 'MERMA', insumoId: i0.id, cantidad: 1, motivo: 'x' })).s, 422, 'motivo obligatorio');
  assert.equal((await mover(await login('cmedina'), { tipo: 'MERMA', insumoId: i0.id, cantidad: 1, motivo: 'Vendedor' })).s, 403);
  assert.equal((await mover(await login('rquispe'), { tipo: 'MERMA', insumoId: i0.id, cantidad: 1, motivo: 'Producción' })).s, 403);
});
