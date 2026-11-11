// node --test tests/almacenes-excel.test.mjs  (API en 127.0.0.1:3001 con la semilla)
// Almacenes (MAE-10), proveedor habitual del insumo (MAE-01) y vendedor asignado al cliente (MAE-08).
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

const principal = (tipo) => sql(`SELECT id FROM core.almacen WHERE principal AND tipo = '${tipo}'`);
const sufijo = randomUUID().slice(0, 6);

test('MAE-10: cada movimiento queda en el almacén de su tipo', async () => {
  const alm = await login('jramos');
  const l = await api(alm, 'GET', '/almacenes');
  assert.equal(l.s, 200);
  assert.deepEqual(l.b.filter((a) => a.principal).map((a) => a.tipo).sort(), ['INSUMOS', 'PRODUCTOS'], 'un principal por tipo');
  const ins = sql("SELECT id FROM core.insumo WHERE activo AND stock >= 5 ORDER BY nombre LIMIT 1");
  assert.equal((await api(alm, 'POST', '/inventario/movimientos', { tipo: 'MERMA', insumoId: ins, cantidad: 0.01, motivo: 'Prueba de almacén' })).s, 200);
  assert.equal(sql(`SELECT almacen_id FROM core.movimiento_inventario WHERE insumo_id = '${ins}' ORDER BY id DESC LIMIT 1`), principal('INSUMOS'));
  const prod = sql('SELECT id FROM core.producto WHERE stock - reservado >= 5 ORDER BY nombre LIMIT 1');
  assert.equal((await api(alm, 'POST', '/inventario/productos', { productoId: prod, cantidad: 1, motivoTipo: 'MERMA', motivo: 'Prueba de almacén' })).s, 200);
  assert.equal(sql(`SELECT almacen_id FROM core.movimiento_inventario WHERE producto_id = '${prod}' ORDER BY id DESC LIMIT 1`), principal('PRODUCTOS'));
  const codigo = sql(`SELECT codigo FROM core.insumo WHERE id = '${ins}'`);
  const k = await api(alm, 'GET', `/kardex/${codigo}`);
  assert.equal(k.b.at(-1).almacen, 'Almacén de insumos', 'el kárdex muestra el almacén');
  assert.equal(sql('SELECT count(*) FROM core.movimiento_inventario WHERE almacen_id IS NULL'), '0', 'ningún movimiento sin almacén');
});

test('W12: el Administrador mantiene almacenes; un principal por tipo; Almacén solo consulta', async () => {
  const adm = await login('lbermudez'), alm = await login('jramos');
  const antes = principal('INSUMOS');
  assert.equal((await api(alm, 'POST', '/almacenes', { nombre: `Almacén prueba ${sufijo}`, tipo: 'INSUMOS' })).s, 403);
  const resp = (await api(adm, 'GET', '/almacenes/responsables')).b.find((u) => u.nombre === 'Julio Ramos');
  const n = await api(adm, 'POST', '/almacenes', { nombre: `Almacén prueba ${sufijo}`, tipo: 'INSUMOS', responsableId: resp.id, ubicacion: 'Segundo piso' });
  assert.equal(n.s, 201, JSON.stringify(n.b));
  assert.equal((await api(adm, 'POST', '/almacenes', { nombre: `almacén PRUEBA ${sufijo}`, tipo: 'INSUMOS' })).s, 409, 'nombre único');
  assert.equal((await api(adm, 'PATCH', `/almacenes/${n.b.id}`, { nombre: `Almacén prueba ${sufijo}`, tipo: 'INSUMOS', responsableId: resp.id, principal: true })).s, 200);
  assert.equal(principal('INSUMOS'), n.b.id, 'el nuevo pasa a principal');
  assert.equal(Number(sql("SELECT count(*) FROM core.almacen WHERE principal AND tipo = 'INSUMOS'")), 1, 'y el anterior deja de serlo');
  assert.equal((await api(adm, 'PATCH', `/almacenes/${n.b.id}`, { nombre: `Almacén prueba ${sufijo}`, tipo: 'INSUMOS', principal: false })).s, 409, 'no queda sin principal');
  // Se devuelve el rol al almacén original.
  const orig = (await api(adm, 'GET', '/almacenes')).b.find((a) => a.id === antes);
  assert.equal((await api(adm, 'PATCH', `/almacenes/${antes}`, { ...orig, principal: true })).s, 200);
  assert.equal(principal('INSUMOS'), antes);
});

test('MAE-01: el proveedor elegido en la ficha del insumo queda vinculado al maestro', async () => {
  const adm = await login('lbermudez');
  const prov = sql("SELECT razon_social FROM core.proveedor WHERE estado = 'ACTIVO' ORDER BY razon_social LIMIT 1");
  const r = await api(adm, 'POST', '/insumos', { nombre: `Insumo proveedor ${sufijo}`, unidad: 'KG', minimo: 0, proveedor: prov });
  assert.equal(r.s, 201, JSON.stringify(r.b));
  assert.equal(sql(`SELECT p.razon_social FROM core.insumo i JOIN core.proveedor p ON p.id = i.proveedor_id WHERE i.id = '${r.b.id}'`), prov);
  const ins = (await api(adm, 'GET', '/proveedores')).b.find((p) => p.razonSocial === prov);
  assert.ok(ins.insumos.includes(`Insumo proveedor ${sufijo}`), 'el proveedor lista el insumo que abastece');
});

test('MAE-08: vendedor asignado al cliente', async () => {
  const ven = await login('cmedina');
  const v = await api(ven, 'GET', '/vendedores');
  assert.equal(v.s, 200);
  const yo = v.b.find((x) => x.nombre === 'Carlos Medina');
  assert.ok(yo);
  const doc = String(10_000_000 + Math.floor(Math.random() * 89_999_999));
  const c = await api(ven, 'POST', '/clientes', { nombre: `Cliente cartera ${sufijo}`, docTipo: 'DNI', docNumero: doc, telefono: '', email: '', direccion: '', listaPrecio: 'MINORISTA', diasCredito: 0, limiteCredito: 0, vendedorId: yo.id });
  assert.equal(c.s, 201, JSON.stringify(c.b));
  const fila = (await api(ven, 'GET', '/clientes')).b.find((x) => x.id === c.b.id);
  assert.equal(fila.vendedorId, yo.id);
  assert.equal((await api(await login('jramos'), 'GET', '/vendedores')).s, 403);
});

after(() => sqlScript(`UPDATE core.almacen SET estado = 'INACTIVO' WHERE nombre LIKE 'Almacén prueba %' AND NOT principal;
  UPDATE core.insumo SET activo = false WHERE nombre LIKE 'Insumo proveedor %';
  UPDATE core.cliente SET estado = 'INACTIVO' WHERE nombre LIKE 'Cliente cartera %';`));
