// node --test tests/pedidos-excel.test.mjs  (API en 127.0.0.1:3001 con la semilla)
// Pedidos y despacho contra INF-TEC-001: CP-04, CP-09, CP-11, CP-23, RN-26 y RN-29.
// Producto propio por ejecución: no altera el stock de los productos reales.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from './_sql.mjs';

const B = process.env.API ?? 'http://127.0.0.1:3001/api/v1';
const login = async (u, clave = 'tanta') => (await (await fetch(B + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario: u, clave }) })).json()).accessToken;
const api = (t, m, ruta, body) => fetch(B + ruta, {
  method: m, headers: { ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));
const iso = (d) => d.toISOString().slice(0, 10);
const enDias = (n) => iso(new Date(Date.now() - 5 * 3_600_000 + n * 86_400_000));
const dni = () => String(10_000_000 + Math.floor(Math.random() * 89_999_999));

const sufijo = randomUUID().slice(0, 6).toUpperCase();
let ven, alm, productoId, clienteId;

before(async () => {
  [ven, alm] = await Promise.all(['cmedina', 'jramos'].map((u) => login(u)));
  productoId = sql(`WITH p AS (INSERT INTO core.producto (codigo, nombre, categoria_id, precio_con_igv, estado, anticipacion_horas)
    SELECT 'PP-${sufijo}', 'Pan pedido ${sufijo}', id, 1.20, 'ACTIVO', 0 FROM core.categoria ORDER BY orden LIMIT 1 RETURNING id) SELECT id FROM p`);
  // 10 panes en stock (devolución = ingreso con kárdex).
  assert.equal((await api(alm, 'POST', '/inventario/productos', { productoId, cantidad: 10, motivoTipo: 'DEVOLUCION', motivo: 'Stock de prueba' })).s, 200);
  clienteId = sql(`WITH c AS (INSERT INTO core.cliente (codigo, nombre, limite_credito) VALUES ('CP-${sufijo}', 'Cliente pedidos ${sufijo}', 0) RETURNING id) SELECT id FROM c`);
});

test('CP-04 / SEG-04: autorregistro de cliente con documento único y RUC validado', async () => {
  const doc = dni(), usuario = `cli${sufijo.toLowerCase()}`;
  const datos = { nombre: 'Cliente App Prueba', docTipo: 'DNI', docNumero: doc, telefono: '999 888 777', email: `${usuario}@prueba.pe`, direccion: 'Av. Prueba 456, Lima', usuario, clave: 'clave-segura-123' };
  assert.equal((await api(null, 'POST', '/auth/registro', { ...datos, docTipo: 'RUC', docNumero: '20123456780' })).s, 422, 'RUC con dígito verificador incorrecto');
  const r = await api(null, 'POST', '/auth/registro', datos);
  assert.equal(r.s, 201, JSON.stringify(r.b));
  const dup = await api(null, 'POST', '/auth/registro', { ...datos, usuario: usuario + 'x', email: 'x' + datos.email });
  assert.equal(dup.s, 409, 'el mismo DNI no se registra dos veces');
  const t = await login(usuario, datos.clave);
  assert.ok(t, 'la cuenta nueva inicia sesión');
  const yo = await api(t, 'GET', '/pedidos');
  assert.equal(yo.s, 200, 'tiene acceso de cliente');
  assert.equal((await api(t, 'GET', '/sistema/config')).s, 403, 'y nada más');
});

test('CP-09 / PED-04: anticipación mínima por producto', async () => {
  sql(`UPDATE core.producto SET anticipacion_horas = 24 WHERE id = '${productoId}'`);
  try {
    const hoy = await api(ven, 'POST', '/pedidos', { clienteId, items: [{ productoId, cantidad: 1 }], fechaEntrega: enDias(0), horaEntrega: '23:59' });
    assert.equal(hoy.s, 422, 'para hoy no alcanza la anticipación de 24 h');
    assert.match(hoy.b.detail, /anticipación/);
    assert.equal((await api(ven, 'POST', '/pedidos', { clienteId, items: [{ productoId, cantidad: 1 }], fechaEntrega: enDias(3) })).s, 201);
  } finally { sql(`UPDATE core.producto SET anticipacion_horas = 0 WHERE id = '${productoId}'`); }
});

test('PED-03: delivery exige dirección', async () => {
  assert.equal((await api(ven, 'POST', '/pedidos', { clienteId, items: [{ productoId, cantidad: 1 }], fechaEntrega: enDias(1), tipoEntrega: 'DELIVERY' })).s, 422);
  const ok = await api(ven, 'POST', '/pedidos', { clienteId, items: [{ productoId, cantidad: 1 }], fechaEntrega: enDias(1), tipoEntrega: 'DELIVERY', direccion: 'Jr. Las Flores 123' });
  assert.equal(ok.s, 201);
  assert.equal(ok.b.estado, 'CONFIRMADO', 'PED-09: el pedido que registra el vendedor nace confirmado');
});

test('RN-26 / RN-29 / CP-23: confirmar, reservar al estar listo, despachar sin superar lo pedido ni lo disponible, entregar', async () => {
  const p = (await api(ven, 'POST', '/pedidos', { clienteId, items: [{ productoId, cantidad: 6 }], fechaEntrega: enDias(1) })).b;
  assert.equal((await api(ven, 'PATCH', `/pedidos/${p.codigo}/estado`, { estado: 'RECHAZADO' })).s, 422, 'rechazar exige motivo');
  assert.equal((await api(ven, 'PATCH', `/pedidos/${p.codigo}/estado`, { estado: 'LISTO' })).s, 200, 'confirmado con stock pasa a listo');
  assert.equal(Number(sql(`SELECT reservado FROM core.producto WHERE id = '${productoId}'`)), 6, 'RN-29: 6 reservados');

  // Venta a terceros: solo quedan 4 disponibles (10 − 6 reservados).
  const tercero = await api(ven, 'POST', '/ventas', { items: [{ productoId, cantidad: 5 }], formaPago: 'EFECTIVO' });
  assert.equal(tercero.s, 409, 'CP-23: no se vende lo reservado');
  assert.match(tercero.b.detail, /disponible 4/);

  const pedId = sql(`SELECT id FROM core.pedido WHERE codigo = '${p.codigo}'`);
  assert.equal((await api(ven, 'POST', '/ventas', { items: [{ productoId, cantidad: 7 }], formaPago: 'EFECTIVO', pedidoId: pedId })).s, 422, 'no más de lo pedido');
  const desp = await api(ven, 'POST', '/ventas', { items: [{ productoId, cantidad: 6 }], formaPago: 'EFECTIVO', pedidoId: pedId });
  assert.equal(desp.s, 201, JSON.stringify(desp.b));
  assert.equal(sql(`SELECT estado FROM core.pedido WHERE id = '${pedId}'`), 'DESPACHADO');
  assert.equal(Number(sql(`SELECT reservado FROM core.producto WHERE id = '${productoId}'`)), 0, 'la reserva se libera al despachar');
  assert.equal(Number(sql(`SELECT stock FROM core.producto WHERE id = '${productoId}'`)), 4);
  const ent = await api(ven, 'PATCH', `/pedidos/${p.codigo}/estado`, { estado: 'ENTREGADO', observaciones: 'Recibió el encargado' });
  assert.equal(ent.s, 200);
  assert.equal(sql(`SELECT entrega_obs FROM core.pedido WHERE id = '${pedId}'`), 'Recibió el encargado');
});

test('CP-11 / PED-07: el cliente cancela antes de producir, no después', async () => {
  const t = await login('mfernandez');
  const cond = "(SELECT cliente_id FROM core.usuario WHERE usuario='mfernandez')";
  const limite = sql(`SELECT limite_credito FROM core.cliente WHERE id = ${cond}`);
  sql(`UPDATE core.cliente SET limite_credito = 0 WHERE id = ${cond}`);
  try {
    const a = (await api(t, 'POST', '/pedidos', { items: [{ productoId, cantidad: 1 }], fechaEntrega: enDias(2) })).b;
    assert.equal(a.estado, 'REGISTRADO');
    assert.equal((await api(t, 'POST', `/pedidos/${a.codigo}/cancelar`, { motivo: 'Ya no lo necesito' })).s, 200);
    const b = (await api(t, 'POST', '/pedidos', { items: [{ productoId, cantidad: 1 }], fechaEntrega: enDias(2) })).b;
    await api(ven, 'PATCH', `/pedidos/${b.codigo}/estado`, { estado: 'CONFIRMADO' });
    await api(ven, 'PATCH', `/pedidos/${b.codigo}/estado`, { estado: 'EN_PRODUCCION' });
    assert.equal((await api(t, 'POST', `/pedidos/${b.codigo}/cancelar`, { motivo: 'Ya no lo necesito' })).s, 409, 'en producción ya no se cancela desde la app');
    // Un pedido ajeno no existe para el cliente.
    const ajeno = (await api(ven, 'POST', '/pedidos', { clienteId, items: [{ productoId, cantidad: 1 }], fechaEntrega: enDias(2) })).b;
    assert.equal((await api(t, 'POST', `/pedidos/${ajeno.codigo}/cancelar`, { motivo: 'No es mío' })).s, 404);
  } finally { sql(`UPDATE core.cliente SET limite_credito = ${limite} WHERE id = ${cond}`); }
});
