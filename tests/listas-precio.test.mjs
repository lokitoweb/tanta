// node tests/correr.mjs tests/listas-precio.test.mjs  (API de pruebas con la semilla)
// Listas de precios administrables (ingeniero, 26-nov-2026): cada lista con su precio por producto, varios clientes
// por lista, lo que no está en la lista va al precio del catálogo y la oferta vale para todos (manda sobre la lista).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from './_sql.mjs';

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

const cliente = sql(`SELECT cliente_id FROM core.usuario WHERE usuario = 'mfernandez'`);
const listaOriginal = sql(`SELECT lista_precio FROM core.cliente WHERE id = '${cliente}'`);
const [prod, catalogo] = sql(`SELECT id || '|' || precio_con_igv FROM core.producto WHERE estado = 'ACTIVO' AND insumo_id IS NULL AND precio_con_igv > 1 ORDER BY nombre LIMIT 1`).split('|');
const [otro] = sql(`SELECT id FROM core.producto WHERE estado = 'ACTIVO' AND insumo_id IS NULL AND precio_con_igv > 0 AND id <> '${prod}' ORDER BY nombre LIMIT 1`).split('|');
const precioLista = Number((Number(catalogo) * 0.8).toFixed(2));
let codigo = '';
after(() => {
  sql(`UPDATE core.cliente SET lista_precio = '${listaOriginal}' WHERE id = '${cliente}'`);
  if (codigo) sql(`DELETE FROM core.lista_precio WHERE codigo = '${codigo}'`);
});
const precioPedido = (cod, producto) => Number(sql(`SELECT d.precio_con_igv FROM core.pedido_detalle d JOIN core.pedido p ON p.id = d.pedido_id WHERE p.codigo = '${cod}' AND d.producto_id = '${producto}' LIMIT 1`));

test('listas de precios: se crean con precios propios, el cliente asignado paga su lista y el resto el catálogo', async () => {
  const sa = await login('superadmin'), ven = await login('cmedina'), cli = await login('mfernandez');

  const listas = await api(sa, 'GET', '/listas-precio');
  assert.equal(listas.s, 200);
  assert.ok(['MINORISTA', 'MAYORISTA', 'CORPORATIVO'].every((c) => listas.b.some((l) => l.codigo === c)), 'las tres de siempre siguen');

  const nombre = `Prueba Cafeterías ${Date.now()}`;
  const creada = await api(sa, 'POST', '/listas-precio', { nombre, precios: [{ productoId: prod, precio: precioLista }] });
  assert.equal(creada.s, 201, JSON.stringify(creada.b));
  codigo = creada.b.codigo;
  assert.match(codigo, /^PRUEBA_CAFETERIAS_\d+$/, 'el código nace del nombre, sin tildes');
  assert.equal((await api(sa, 'POST', '/listas-precio', { nombre })).s, 409, 'nombre repetido');
  assert.equal((await api(sa, 'POST', '/listas-precio', { nombre: 'Otra', precios: [{ productoId: prod, precio: 0 }] })).s, 422, 'precio en cero');
  assert.equal((await api(ven, 'POST', '/listas-precio', { nombre: 'Del vendedor' })).s, 403, 'el vendedor no crea listas');

  // El cliente se asigna en su ficha: una lista que no existe no se acepta.
  const ficha = (await api(sa, 'GET', '/clientes')).b.find((c) => c.id === cliente);
  const { id: _i, codigo: _c, saldo: _s, usaApp: _u, ...datos } = ficha;
  assert.equal((await api(sa, 'PATCH', `/clientes/${cliente}`, { ...datos, listaPrecio: 'NO_EXISTE' })).s, 422);
  assert.equal((await api(sa, 'PATCH', `/clientes/${cliente}`, { ...datos, listaPrecio: codigo })).s, 200);
  assert.equal(sql(`SELECT lista_precio FROM core.cliente WHERE id = '${cliente}'`), codigo);

  const detalle = await api(sa, 'GET', `/listas-precio/${codigo}`);
  assert.ok(detalle.b.clientes.some((c) => c.id === cliente), 'la lista muestra sus clientes');

  // Pedido del vendedor para ese cliente: su lista para el producto con precio, catálogo para el otro.
  const ped = await api(ven, 'POST', '/pedidos', { clienteId: cliente, items: [{ productoId: prod, cantidad: 2 }, { productoId: otro, cantidad: 1 }] });
  assert.equal(ped.s, 201, JSON.stringify(ped.b));
  assert.equal(precioPedido(ped.b.codigo, prod), precioLista);
  assert.equal(precioPedido(ped.b.codigo, otro), Number(sql(`SELECT precio_con_igv FROM core.producto WHERE id = '${otro}'`)));

  // El cliente desde su cuenta: su catálogo muestra la lista y el pedido se cobra igual.
  const ds = await api(cli, 'GET', '/datos');
  assert.equal(ds.b.productos.find((p) => p.id === prod).precioConIgv, precioLista);
  const mio = await api(cli, 'POST', '/pedidos', { items: [{ productoId: prod, cantidad: 1 }] });
  assert.equal(mio.s, 201, JSON.stringify(mio.b));
  assert.equal(precioPedido(mio.b.codigo, prod), precioLista);
  assert.equal((await api(cli, 'GET', `/clientes/${cliente}/precios`)).s, 403, 'un cliente no consulta precios por id');

  // Pantallas del vendedor: precios del cliente elegido.
  const precios = await api(ven, 'GET', `/clientes/${cliente}/precios`);
  assert.equal(precios.b.precios[prod], precioLista);
  const stock = await api(ven, 'GET', `/ventas-stock/productos?clienteId=${cliente}`);
  const enStock = stock.b.productos.find((p) => p.id === prod);
  if (enStock) assert.equal(enStock.precio, precioLista);

  // Lista inactiva: sus clientes vuelven al precio del catálogo.
  assert.equal((await api(sa, 'PUT', `/listas-precio/${codigo}`, { nombre, activa: false, precios: [{ productoId: prod, precio: precioLista }] })).s, 200);
  const inactiva = await api(ven, 'POST', '/pedidos', { clienteId: cliente, items: [{ productoId: prod, cantidad: 1 }] });
  assert.equal(precioPedido(inactiva.b.codigo, prod), Number(catalogo));
});

test('OBS-03: la lista General es la de todo cliente nuevo, no se inactiva y el cambio de precio queda auditado', async () => {
  const sa = await login('superadmin');
  const nuevo = await api(sa, 'POST', '/clientes', { nombre: `Cliente General ${Date.now()}`, docTipo: 'DNI', docNumero: '', telefono: '', email: '', direccion: '', diasCredito: 0, limiteCredito: 0 });
  assert.equal(nuevo.s, 201, JSON.stringify(nuevo.b));
  assert.equal(sql(`SELECT lista_precio FROM core.cliente WHERE id = '${nuevo.b.id}'`), 'GENERAL', 'sin elegir lista queda en la General');
  sql(`DELETE FROM core.cliente WHERE id = '${nuevo.b.id}'`);
  assert.equal((await api(sa, 'PUT', '/listas-precio/GENERAL', { nombre: 'General', activa: false })).s, 422, 'la General no se inactiva');

  const nombre = `Prueba auditoría ${Date.now()}`;
  const c = await api(sa, 'POST', '/listas-precio', { nombre, precios: [{ productoId: prod, precio: 5 }] });
  assert.equal(c.s, 201);
  try {
    assert.equal((await api(sa, 'PUT', `/listas-precio/${c.b.codigo}`, { nombre, precios: [{ productoId: prod, precio: 6.5 }] })).s, 200);
    const det = JSON.parse(sql(`SELECT detalle::text FROM audit.evento WHERE accion = 'LISTA_PRECIO_EDITADA' AND entidad_id = '${c.b.codigo}' ORDER BY creado_en DESC LIMIT 1`));
    assert.deepEqual(det.precios.map((x) => [x.antes, x.despues]), [[5, 6.5]], 'precio anterior y nuevo');
  } finally { sql(`DELETE FROM core.lista_precio WHERE codigo = '${c.b.codigo}'`); }
});
