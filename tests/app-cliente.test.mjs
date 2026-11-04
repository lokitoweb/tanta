// node --test tests/app-cliente.test.mjs  (API en 127.0.0.1:3001 con la semilla)
// Compra del cliente en la app (A04–A09) y avisos por área (A11, PED-05, PED-08, VEN-03, CP-36).
import { test } from 'node:test';
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

const manana = () => new Date(Date.now() - 5 * 3_600_000 + 3 * 86_400_000).toISOString().slice(0, 10);
const producto = () => sql("SELECT id FROM core.producto WHERE estado = 'ACTIVO' AND anticipacion_horas <= 24 ORDER BY nombre LIMIT 1");
// Espera a que el despachador (cada 5 s) deje el aviso; CP-36 pide menos de 30 s.
const esperarAviso = async (t, texto) => {
  const inicio = Date.now();
  while (Date.now() - inicio < 30_000) {
    const n = await api(t, 'GET', '/notificaciones');
    const a = n.b.avisos.find((x) => x.titulo.includes(texto) || x.cuerpo.includes(texto));
    if (a) return { aviso: a, segundos: (Date.now() - inicio) / 1000, noLeidas: n.b.noLeidas };
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
};

test('pedido del cliente con pago contra entrega: avisa al Vendedor, al cliente y a Producción', async () => {
  const cli = await login('mfernandez'), ven = await login('cmedina'), pro = await login('rquispe');
  const p = await api(cli, 'POST', '/pedidos', { items: [{ productoId: producto(), cantidad: 2 }], fechaEntrega: manana(), horaEntrega: '10:00', tipoEntrega: 'RECOJO', pagoEntrega: 'YAPE', observaciones: 'Sin azúcar' });
  assert.equal(p.s, 201, JSON.stringify(p.b));
  assert.equal(p.b.estado, 'REGISTRADO');
  assert.equal(sql(`SELECT pago_entrega FROM core.pedido WHERE codigo = '${p.b.codigo}'`), 'YAPE');

  // PED-08: el Vendedor (área de pedidos) se entera del pedido nuevo.
  const v = await esperarAviso(ven, p.b.codigo);
  assert.ok(v, 'el vendedor recibe el aviso');
  assert.ok(v.segundos < 30, `CP-36: llegó en ${v.segundos} s`);
  assert.equal(v.aviso.ruta, '/ventas/pedidos', 'el aviso abre la pantalla de pedidos');
  assert.ok((await esperarAviso(cli, 'recibimos tu pedido')), 'el cliente recibe la confirmación de registro');

  // Al confirmar: el cliente y Producción.
  assert.equal((await api(ven, 'PATCH', `/pedidos/${p.b.codigo}/estado`, { estado: 'CONFIRMADO' })).s, 200);
  assert.ok(await esperarAviso(cli, 'fue confirmado'), 'el cliente sabe que se confirmó');
  assert.ok(await esperarAviso(pro, p.b.codigo), 'Producción recibe el pedido confirmado');

  // A09: línea de tiempo; un cliente no ve pedidos ajenos.
  const h = await api(cli, 'GET', `/pedidos/${p.b.codigo}/historial`);
  assert.deepEqual(h.b.map((x) => x.estado), ['REGISTRADO', 'CONFIRMADO']);
  const ajeno = sql("SELECT codigo FROM core.pedido WHERE cliente_id <> (SELECT cliente_id FROM core.usuario WHERE usuario = 'mfernandez') LIMIT 1");
  if (ajeno) assert.equal((await api(cli, 'GET', `/pedidos/${ajeno}/historial`)).s, 404);

  // La cancelación también avisa al área.
  assert.equal((await api(cli, 'POST', `/pedidos/${p.b.codigo}/cancelar`, { motivo: 'Cambio de planes' })).s, 200);
  assert.ok(await esperarAviso(ven, 'Cambio de planes'), 'el vendedor sabe que se canceló y por qué');
});

test('centro de notificaciones: no leídas y marcar como leídas, solo las propias', async () => {
  const ven = await login('cmedina');
  const n = await api(ven, 'GET', '/notificaciones');
  assert.equal(n.s, 200);
  assert.ok(n.b.avisos.length > 0);
  const id = n.b.avisos[0].id;
  assert.equal((await api(ven, 'POST', '/notificaciones/leidas', { ids: [id] })).s, 200);
  const d = await api(ven, 'GET', '/notificaciones');
  assert.equal(d.b.avisos.find((a) => a.id === id).leida, true);
  // Otro usuario no puede marcar un aviso ajeno.
  const otro = await api(await login('mfernandez'), 'POST', '/notificaciones/leidas', { ids: [d.b.avisos[1]?.id ?? id] });
  assert.equal(otro.b.marcadas, 0);
  assert.equal((await api(ven, 'POST', '/notificaciones/leidas', {})).s, 200);
  assert.equal((await api(ven, 'GET', '/notificaciones')).b.noLeidas, 0, 'marcar todo deja 0 pendientes');
});

test('una venta avisa a Gerencia (permiso alertas.ventas)', async () => {
  const ger = await login('osquilcate');
  const v = await api(await login('cmedina'), 'POST', '/ventas', { items: [{ productoId: sql('SELECT id FROM core.producto WHERE stock >= 5 ORDER BY nombre LIMIT 1'), cantidad: 1 }], formaPago: 'EFECTIVO' });
  assert.equal(v.s, 201, JSON.stringify(v.b));
  assert.ok(await esperarAviso(ger, v.b.comprobante.numero), 'el gerente recibe la venta');
});

test('crédito al pedir solo para clientes al crédito', async () => {
  const cli = await login('mfernandez');
  const cond = sql("SELECT condicion_pago FROM core.cliente WHERE id = (SELECT cliente_id FROM core.usuario WHERE usuario = 'mfernandez')");
  const r = await api(cli, 'POST', '/pedidos', { items: [{ productoId: producto(), cantidad: 1 }], fechaEntrega: manana(), pagoEntrega: 'CREDITO' });
  if (cond === 'CONTADO') assert.equal(r.s, 422);
  else {
    assert.ok([201, 409].includes(r.s), JSON.stringify(r.b));
    if (r.s === 201) await api(cli, 'POST', `/pedidos/${r.b.codigo}/cancelar`, { motivo: 'Prueba automática' });
  }
});
