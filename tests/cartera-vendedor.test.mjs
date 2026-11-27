// node tests/correr.mjs tests/cartera-vendedor.test.mjs  (API de pruebas con la semilla)
// Observación del ingeniero (27-nov-2026): cada vendedor ve solo su cartera, y un teléfono recibe solo los avisos de la cuenta abierta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from './_sql.mjs';

const B = process.env.API ?? 'http://127.0.0.1:3001/api/v1';
const entrar = async (usuario, clave = 'tanta') => {
  for (let i = 0; i < 10; i++) {
    const r = await fetch(B + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario, clave }) });
    if (r.status !== 429) return (await r.json()).accessToken;
    await new Promise((ok) => setTimeout(ok, 7000));
  }
  throw new Error('login bloqueado por el límite');
};
const api = (t, m, ruta, body) => fetch(B + ruta, {
  method: m, headers: { Authorization: 'Bearer ' + t, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));
const manana = () => sql(`SELECT (core.hoy_lima() + 2)::text`);

test('Cartera por vendedor: cada uno ve y opera solo sus clientes y pedidos; Gerencia ve todo', async () => {
  const sa = await entrar('superadmin'), ger = await entrar('osquilcate'), a = await entrar('cmedina');
  // Segundo vendedor, del mismo rol.
  const usuarioB = `cart${randomUUID().slice(0, 6)}`;
  assert.equal((await api(sa, 'POST', '/usuarios', { nombre: 'Vendedor B', usuario: usuarioB, clave: 'ClaveSegura123', rol: 'VENDEDOR' })).s, 201);
  const b = await entrar(usuarioB, 'ClaveSegura123');
  const idA = sql(`SELECT id FROM core.usuario WHERE usuario = 'cmedina'`);

  // Cada vendedor crea su cliente: queda en su cartera aunque envíe otro vendedor.
  const nuevo = (t, n) => api(t, 'POST', '/clientes', { nombre: `Cartera ${n} ${randomUUID().slice(0, 4)}`, docTipo: 'DNI', docNumero: String(Math.floor(1e7 + Math.random() * 9e7)),
    telefono: '', email: '', direccion: 'Av. Cartera 123', listaPrecio: 'GENERAL', diasCredito: 0, limiteCredito: 0, vendedorId: '' });
  const ca = await nuevo(a, 'A'), cb = await nuevo(b, 'B');
  assert.equal(ca.s, 201, JSON.stringify(ca.b));
  assert.equal(cb.s, 201, JSON.stringify(cb.b));
  assert.equal(sql(`SELECT vendedor_id FROM core.cliente WHERE id = '${ca.b.id}'`), idA);

  const listaB = await api(b, 'GET', '/clientes');
  assert.ok(listaB.b.some((c) => c.id === cb.b.id) && !listaB.b.some((c) => c.id === ca.b.id), 'B no ve el cliente de A');
  assert.equal((await api(b, 'GET', `/clientes/${ca.b.id}/direcciones`)).s, 404);
  assert.equal((await api(b, 'GET', `/estado-cuenta?clienteId=${ca.b.id}`)).s, 404);
  const datosB = await api(b, 'GET', '/datos');
  assert.ok(!datosB.b.clientes.some((c) => c.id === ca.b.id), 'tampoco en el selector de clientes');

  // A registra un pedido para su cliente; B no lo ve ni lo toca. B no puede pedir para el cliente de A.
  const prod = sql(`SELECT id FROM core.producto WHERE estado = 'ACTIVO' AND insumo_id IS NULL AND precio_con_igv > 0 ORDER BY nombre LIMIT 1`);
  const ped = await api(a, 'POST', '/pedidos', { clienteId: ca.b.id, items: [{ productoId: prod, cantidad: 1 }], fechaEntrega: manana(), tipoEntrega: 'RECOJO' });
  assert.equal(ped.s, 201, JSON.stringify(ped.b));
  const codigo = ped.b.codigo ?? ped.b.pedidos?.[0]?.codigo;
  assert.ok((await api(a, 'GET', '/pedidos')).b.some((p) => p.codigo === codigo), 'A ve su pedido');
  assert.ok(!(await api(b, 'GET', '/pedidos')).b.some((p) => p.codigo === codigo), 'B no ve el pedido de A');
  assert.ok(!datosB.b.pedidos.some((p) => p.codigo === codigo));
  assert.equal((await api(b, 'PATCH', `/pedidos/${codigo}/estado`, { estado: 'CANCELADO', motivo: 'no es mío' })).s, 404);
  assert.equal((await api(b, 'POST', '/pedidos', { clienteId: ca.b.id, items: [{ productoId: prod, cantidad: 1 }], fechaEntrega: manana(), tipoEntrega: 'RECOJO' })).s, 404);

  // El vendedor no se reasigna clientes; Gerencia (ve todo) sí.
  const editado = await api(b, 'PATCH', `/clientes/${cb.b.id}`, { ...cb.b, vendedorId: idA });
  assert.equal(editado.s, 200, JSON.stringify(editado.b));
  assert.notEqual(sql(`SELECT vendedor_id FROM core.cliente WHERE id = '${cb.b.id}'`), idA);
  assert.ok((await api(ger, 'GET', '/pedidos')).b.some((p) => p.codigo === codigo), 'Gerencia ve todos los pedidos');

  // Un cliente sin vendedor asignado es cartera libre: ambos lo ven.
  const libre = sql(`SELECT id FROM core.cliente WHERE vendedor_id IS NULL AND estado = 'ACTIVO' LIMIT 1`);
  assert.ok((await api(b, 'GET', '/clientes')).b.some((c) => c.id === libre));
  assert.equal((await api(a, 'PATCH', `/pedidos/${codigo}/estado`, { estado: 'CANCELADO', motivo: 'prueba cartera' })).s, 200);
});

test('Un teléfono recibe solo los avisos de la cuenta abierta: al cambiar de cuenta o salir se da de baja', async () => {
  const cli = await entrar('mfernandez'), ven = await entrar('cmedina');
  const instalacion = randomUUID(), token = 'tok-' + randomUUID();
  const registrar = (t) => api(t, 'POST', '/dispositivo', { instalacion, plataforma: 'android', versionApp: '1.0.0', tokenPush: token });
  const cuentas = () => sql(`SELECT string_agg(u.usuario, ',' ORDER BY u.usuario) FROM core.dispositivo d JOIN core.usuario u ON u.id = d.usuario_id WHERE d.instalacion = '${instalacion}' OR d.token_push = '${token}'`);
  assert.equal((await registrar(cli)).s, 200);
  assert.equal(cuentas(), 'mfernandez');
  assert.equal((await registrar(ven)).s, 200);
  assert.equal(cuentas(), 'cmedina', 'el cliente ya no recibe sus avisos en el teléfono del vendedor');
  assert.equal((await api(ven, 'POST', '/auth/logout', { instalacion })).s, 200);
  assert.equal(cuentas(), '', 'al salir, el teléfono deja de recibir avisos');
});
