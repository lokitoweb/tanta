// node tests/correr.mjs tests/insumo-entero-kardex.test.mjs  (API de pruebas con la semilla)
// Observación del ingeniero (27-nov-2026): el huevo no se fracciona al producir menos de un lote; el kárdex se consulta por período.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from './_sql.mjs';

const B = process.env.API ?? 'http://127.0.0.1:3001/api/v1';
const entrar = async (usuario) => {
  for (let i = 0; i < 10; i++) {
    const r = await fetch(B + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario, clave: 'tanta' }) });
    if (r.status !== 429) return (await r.json()).accessToken;
    await new Promise((ok) => setTimeout(ok, 7000));
  }
  throw new Error('login bloqueado por el límite');
};
const get = (t, ruta) => fetch(B + ruta, { headers: { Authorization: 'Bearer ' + t } }).then(async (r) => ({ s: r.status, b: await r.json() }));

test('Insumo que se usa entero (huevos): con menos de un lote se redondea hacia arriba; los demás siguen proporcionales', async () => {
  const adm = await entrar('superadmin');
  const fila = sql(`SELECT p.id || '|' || i.id FROM core.receta r JOIN core.producto p ON p.id = r.producto_id JOIN core.receta_detalle d ON d.receta_id = r.id
    JOIN core.insumo i ON i.id = d.insumo_id WHERE r.estado = 'VIGENTE' AND p.estado = 'ACTIVO' AND i.unidad_inventario = 'UNIDAD' LIMIT 1`);
  assert.ok(fila, 'la semilla tiene una receta con un insumo por unidad');
  const [prod, ins] = fila.split('|');
  const req = async () => (await get(adm, `/produccion/requerimiento?productoId=${prod}&cantidad=1&criterio=PROPORCIONAL`)).b.insumos.find((x) => x.insumoId === ins).necesario;
  sql(`UPDATE core.insumo SET consumo_entero = false WHERE id = '${ins}'`);
  const fraccion = await req();
  assert.ok(fraccion > 0 && fraccion < 1, `fraccionado: ${fraccion}`);
  sql(`UPDATE core.insumo SET consumo_entero = true WHERE id = '${ins}'`);
  assert.equal(await req(), Math.ceil(fraccion), 'entero: la unidad completa');
});

test('Kárdex por período: saldo inicial del día anterior y solo los asientos entre las fechas', async () => {
  const adm = await entrar('superadmin');
  const cod = sql(`SELECT i.codigo FROM core.insumo i WHERE EXISTS (SELECT 1 FROM core.movimiento_inventario m WHERE m.insumo_id = i.id) ORDER BY i.codigo LIMIT 1`);
  const todo = await get(adm, `/kardex/${cod}`);
  assert.equal(todo.s, 200);
  const ultimo = todo.b.at(-1);
  // Un período futuro: sin asientos, solo el saldo inicial = saldo vigente.
  const futuro = await get(adm, `/kardex/${cod}?desde=2099-01-01&hasta=2099-01-31`);
  assert.equal(futuro.s, 200);
  assert.equal(futuro.b.length, 1);
  assert.equal(futuro.b[0].tipo, 'SALDO_INICIAL');
  assert.equal(futuro.b[0].saldoCantidad, ultimo.saldoCantidad);
  // Un período pasado sin nada antes: vacío.
  assert.deepEqual((await get(adm, `/kardex/${cod}?desde=2000-01-01&hasta=2000-01-31`)).b, []);
  assert.equal((await get(adm, `/kardex/${cod}?desde=ayer`)).s, 422);
});
