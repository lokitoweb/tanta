// node --test tests/maestros.test.mjs  (API en 127.0.0.1:3001 con la semilla)
// El motor de costeo responde a los maestros: CIF, recetas y compras cambian el costo real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const B = process.env.API ?? 'http://127.0.0.1:3001/api/v1';
const login = async (u) => (await (await fetch(B + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario: u, clave: 'tanta' }) })).json()).accessToken;
const api = (t, m, ruta, body) => fetch(B + ruta, {
  method: m, headers: { Authorization: 'Bearer ' + t, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));
const ficha = async (t, id) => (await api(t, 'GET', `/reportes/M-01?producto=${id}`)).b.filas.find((f) => f.concepto === 'Costo total unitario').costo;

test('CIF: subir un costo indirecto sube el costo de los productos, al instante', async () => {
  const adm = await login('lbermudez');
  const ger = await login('osquilcate');
  const prod = (await api(ger, 'GET', '/reportes-filtros')).b.productos[0];
  const antes = await ficha(ger, prod.id);
  const nuevo = await api(adm, 'POST', '/costos-indirectos', { concepto: 'Prueba ' + Date.now(), tipo: 'FIJO', montoMensual: 5000, activo: true });
  assert.equal(nuevo.s, 201);
  const despues = await ficha(ger, prod.id);
  assert.ok(despues > antes, `costo ${antes} → ${despues}`);
  const id = nuevo.b.items.find((i) => i.concepto.startsWith('Prueba') && i.activo).id;
  await api(adm, 'PATCH', `/costos-indirectos/${id}`, { concepto: 'Prueba desactivada ' + Date.now(), tipo: 'FIJO', montoMensual: 5000, activo: false });
  assert.ok(Math.abs((await ficha(ger, prod.id)) - antes) < 0.0001, 'al desactivarlo vuelve al costo original');
  assert.equal((await api(await login('cmedina'), 'POST', '/costos-indirectos', { concepto: 'x', tipo: 'FIJO', montoMensual: 1 })).s, 403);
});

test('Receta: una versión nueva recalcula el costo y queda versionada', async () => {
  const adm = await login('lbermudez');
  const ger = await login('osquilcate');
  const d = (await api(adm, 'GET', '/datos')).b;
  const r = d.recetas[0];
  const antes = await ficha(ger, r.productoId);
  const lineas = r.lineas.map((l) => ({ insumoId: l.insumoId, cantidad: l.cantidad * 2 }));
  const res = await api(adm, 'PUT', `/recetas/${r.productoId}`, { rendimiento: r.rendimiento, mermaEstandar: r.mermaEstandar, lineas });
  assert.equal(res.s, 200);
  assert.ok((await ficha(ger, r.productoId)) > antes, 'el doble de insumos cuesta más');
  // se restaura la receta original
  await api(adm, 'PUT', `/recetas/${r.productoId}`, { rendimiento: r.rendimiento, mermaEstandar: r.mermaEstandar, lineas: r.lineas.map((l) => ({ insumoId: l.insumoId, cantidad: l.cantidad })) });
  assert.ok(Math.abs((await ficha(ger, r.productoId)) - antes) < 0.0001);
  assert.equal((await api(adm, 'PUT', `/recetas/${r.productoId}`, { rendimiento: 0, mermaEstandar: 0, lineas: [] })).s, 422);
});

test('Clientes: alta con validación de documento y edición', async () => {
  const adm = await login('lbermudez');
  const base = { docTipo: 'RUC', telefono: '+51 999 000 111', email: 'compras@ejemplo.pe', direccion: 'Av. Prueba 123', listaPrecio: 'MAYORISTA', diasCredito: 15, limiteCredito: 2500, estado: 'ACTIVO' };
  assert.equal((await api(adm, 'POST', '/clientes', { ...base, nombre: 'Mal RUC', docNumero: '123' })).s, 422);
  const c = await api(adm, 'POST', '/clientes', { ...base, nombre: 'Cafetería Prueba ' + Date.now(), docNumero: '20123456789' });
  assert.equal(c.s, 201);
  assert.match(c.b.codigo, /^CLI-\d{4}$/);
  assert.equal((await api(adm, 'PATCH', `/clientes/${c.b.id}`, { ...base, nombre: 'Cafetería editada', docNumero: '20123456789', estado: 'INACTIVO' })).s, 200);
  assert.equal((await api(await login('rquispe'), 'GET', '/clientes')).s, 403, 'Producción no gestiona clientes');
});

test('Compra de insumo: el nuevo CPP cambia el costo del producto', async () => {
  const alm = await login('jramos');
  const ger = await login('osquilcate');
  // El Gerente no ve recetas (permiso recetas.ver): se leen como Administrador.
  const d = (await api(await login('lbermudez'), 'GET', '/datos')).b;
  const r = d.recetas[0];
  const insumo = d.insumos.find((i) => i.id === r.lineas[0].insumoId);
  const antes = await ficha(ger, r.productoId);
  const compra = await api(alm, 'POST', '/inventario/movimientos', { tipo: 'COMPRA', insumoId: insumo.id, cantidad: insumo.stock + 50, costoUnitario: insumo.cpp * 3, motivo: 'Prueba alza de precio' });
  assert.equal(compra.s, 200);
  assert.ok((await ficha(ger, r.productoId)) > antes, 'comprar más caro sube el costo');
});
