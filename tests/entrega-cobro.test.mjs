// node --test tests/entrega-cobro.test.mjs  (API con la semilla)
// Flujo acordado con el dueño: el cliente pide sin forma de pago → el vendedor observa o confirma →
// el despacho queda por cobrar → al entregar cobra (todo, una parte o nada, en una o varias formas) →
// al final del día rinde lo cobrado y caja lo recibe. Producto y cliente propios por ejecución.
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
const manana = () => new Date(Date.now() - 5 * 3_600_000 + 86_400_000).toISOString().slice(0, 10);

const sufijo = randomUUID().slice(0, 6).toUpperCase();
let ven, alm, ger, cli, productoId, clienteId;

/** Pedido de 10 panes a S/ 2.00 (S/ 20) llevado hasta «Despachado». */
async function despachado() {
  const p = (await api(ven, 'POST', '/pedidos', { clienteId, items: [{ productoId, cantidad: 10 }], fechaEntrega: manana() })).b;
  assert.equal((await api(ven, 'PATCH', `/pedidos/${p.codigo}/estado`, { estado: 'LISTO' })).s, 200);
  const pedId = sql(`SELECT id FROM core.pedido WHERE codigo = '${p.codigo}'`);
  // Aunque se envíe una forma de pago, el despacho de un pedido queda por cobrar.
  const v = await api(ven, 'POST', '/ventas', { items: [{ productoId, cantidad: 10 }], formaPago: 'EFECTIVO', pedidoId: pedId });
  assert.equal(v.s, 201, JSON.stringify(v.b));
  assert.ok(v.b.cxcId, 'el despacho genera la cuenta por cobrar');
  return { ...p, pedId, venta: v.b };
}

before(async () => {
  [ven, alm, ger] = await Promise.all(['cmedina', 'jramos', 'osquilcate'].map((u) => login(u)));
  productoId = sql(`WITH p AS (INSERT INTO core.producto (codigo, nombre, categoria_id, precio_con_igv, estado, anticipacion_horas)
    SELECT 'EC-${sufijo}', 'Pan entrega ${sufijo}', id, 2.00, 'ACTIVO', 0 FROM core.categoria ORDER BY orden LIMIT 1 RETURNING id) SELECT id FROM p`);
  assert.equal((await api(alm, 'POST', '/inventario/productos', { productoId, cantidad: 100, motivoTipo: 'DEVOLUCION', motivo: 'Stock de prueba' })).s, 200);
  // Cliente al CONTADO y sin línea: igual puede quedar debiendo al recibir (regla del dueño).
  clienteId = sql(`WITH c AS (INSERT INTO core.cliente (codigo, nombre, limite_credito, condicion_pago) VALUES ('EC-${sufijo}', 'Cliente entrega ${sufijo}', 0, 'CONTADO') RETURNING id) SELECT id FROM c`);
  cli = await login('mfernandez');
});

test('el cliente pide sin forma de pago (si la envía, se ignora)', async () => {
  const p = await api(cli, 'POST', '/pedidos', { items: [{ productoId, cantidad: 2 }], fechaEntrega: manana(), pagoEntrega: 'YAPE' });
  assert.equal(p.s, 201, JSON.stringify(p.b));
  assert.equal(sql(`SELECT coalesce(pago_entrega, '—') FROM core.pedido WHERE codigo = '${p.b.codigo}'`), '—');
  await api(cli, 'POST', `/pedidos/${p.b.codigo}/cancelar`, { motivo: 'Prueba automática' });
});

test('observar: el vendedor avisa al cliente que el pedido parece mal hecho', async () => {
  const p = (await api(cli, 'POST', '/pedidos', { items: [{ productoId, cantidad: 4 }], fechaEntrega: manana() })).b;
  assert.equal((await api(ven, 'POST', `/pedidos/${p.codigo}/observar`, { mensaje: 'no' })).s, 422, 'el mensaje es obligatorio');
  assert.equal((await api(cli, 'POST', `/pedidos/${p.codigo}/observar`, { mensaje: 'Siempre pides 48' })).s, 403, 'el cliente no observa');
  const o = await api(ven, 'POST', `/pedidos/${p.codigo}/observar`, { mensaje: 'Siempre pides 48 unidades, ¿seguro 4?' });
  assert.equal(o.s, 200, JSON.stringify(o.b));
  const mio = (await api(cli, 'GET', '/pedidos')).b.find((x) => x.codigo === p.codigo);
  assert.equal(mio.observacion, 'Siempre pides 48 unidades, ¿seguro 4?', 'el cliente ve la observación');
  assert.equal(mio.estado, 'REGISTRADO', 'el pedido no se mueve');
  // El cliente lo anula para volver a hacerlo.
  assert.equal((await api(cli, 'POST', `/pedidos/${p.codigo}/cancelar`, { motivo: 'Lo hago de nuevo con 48' })).s, 200);
  assert.equal((await api(ven, 'POST', `/pedidos/${p.codigo}/observar`, { mensaje: 'Ya fue cancelado' })).s, 409, 'un cancelado ya no se observa');
});

test('entregar y cobrar: pagó una parte en dos formas; lo demás queda como deuda', async () => {
  const p = await despachado();
  assert.equal(p.venta.alertaCredito, null);
  assert.equal(sql(`SELECT forma_pago FROM core.venta WHERE id = '${p.venta.ventaId}'`), 'CREDITO');
  assert.equal(sql(`SELECT estado || ' ' || saldo::numeric(10,2) FROM core.cuenta_por_cobrar WHERE id = '${p.venta.cxcId}'`), 'PENDIENTE 20.00');
  assert.equal(sql(`SELECT (vence_en = current_date)::text FROM core.cuenta_por_cobrar WHERE id = '${p.venta.cxcId}'`), 'true', 'al contado vence el mismo día');

  assert.equal((await api(ven, 'PATCH', `/pedidos/${p.codigo}/estado`, { estado: 'ENTREGADO', pagos: [{ monto: 25, medio: 'EFECTIVO' }] })).s, 422, 'no se cobra más de lo que debe');
  assert.equal(sql(`SELECT estado FROM core.pedido WHERE id = '${p.pedId}'`), 'DESPACHADO', 'si el cobro falla, la entrega no queda a medias');
  assert.equal((await api(ven, 'PATCH', `/pedidos/${p.codigo}/estado`, { estado: 'ENTREGADO', pagos: [{ monto: 5, medio: 'YAPE' }] })).s, 422, 'Yape sin N.° de operación');

  const e = await api(ven, 'PATCH', `/pedidos/${p.codigo}/estado`, { estado: 'ENTREGADO', observaciones: 'Recibió el encargado',
    pagos: [{ monto: 10, medio: 'EFECTIVO' }, { monto: 5, medio: 'YAPE', referencia: 'Y-778899' }] });
  assert.equal(e.s, 200, JSON.stringify(e.b));
  assert.match(e.b.recibo.numero, /^[A-Z0-9]{4}-\d{8}$/);
  assert.equal(e.b.quedaPorCobrar, 5);
  assert.equal(sql(`SELECT estado || ' ' || saldo::numeric(10,2) FROM core.cuenta_por_cobrar WHERE id = '${p.venta.cxcId}'`), 'PARCIAL 5.00');
  assert.equal(sql(`SELECT estado FROM core.pedido WHERE id = '${p.pedId}'`), 'ENTREGADO');
  const fila = (await api(ven, 'GET', '/cxc')).b.find((x) => x.id === p.venta.cxcId);
  assert.ok(fila && fila.saldo === 5 && fila.pagado === 15, 'sigue en Cobranza con lo que falta');
  const listado = (await api(ven, 'GET', '/pedidos')).b.find((x) => x.codigo === p.codigo);
  assert.equal(listado.porCobrar, 5);
});

test('entregar sin cobro: todo queda como deuda («te pago mañana»)', async () => {
  const p = await despachado();
  const e = await api(ven, 'PATCH', `/pedidos/${p.codigo}/estado`, { estado: 'ENTREGADO', observaciones: 'Paga mañana' });
  assert.equal(e.s, 200);
  assert.equal(e.b.recibo, null);
  assert.equal(e.b.quedaPorCobrar, 20);
  assert.equal((await api(ven, 'PATCH', `/pedidos/${p.codigo}/estado`, { estado: 'ENTREGADO', pagos: [{ monto: 1, medio: 'EFECTIVO' }] })).s, 409, 'no se entrega dos veces');
});

test('mi día, rendición del vendedor y recepción en caja', async () => {
  sql(`DELETE FROM core.rendicion_cobranza WHERE vendedor_id = (SELECT id FROM core.usuario WHERE usuario = 'cmedina') AND fecha = (now() AT TIME ZONE 'America/Lima')::date`);
  const dia = await api(ven, 'GET', '/cobranza/mi-dia');
  assert.equal(dia.s, 200, JSON.stringify(dia.b));
  assert.ok(dia.b.porMedio.EFECTIVO >= 10 && dia.b.porMedio.YAPE >= 5, 'lo cobrado hoy por forma de pago');
  assert.ok(dia.b.entregas.some((x) => x.quedaPorCobrar === 20), 'la entrega sin cobro aparece con lo que quedó');
  assert.ok(dia.b.cobros.length > 0);

  assert.equal((await api(ven, 'POST', '/cobranza/rendiciones', { fecha: '2999-01-01', efectivoEntregado: 1 })).s, 422, 'no se rinde el futuro');
  const r = await api(ven, 'POST', '/cobranza/rendiciones', { efectivoEntregado: dia.b.efectivo - 1, nota: 'Me faltó 1 sol de vuelto' });
  assert.equal(r.s, 201, JSON.stringify(r.b));
  assert.equal((await api(ven, 'POST', `/cobranza/rendiciones/${r.b.id}/recibir`, { efectivoRecibido: 1 })).s, 403, 'el vendedor no se recibe a sí mismo');

  const cierre = await api(ger, 'GET', '/cobranza/cierre');
  const yo = cierre.b.vendedores.find((v) => v.rendicion?.id === r.b.id);
  assert.ok(yo, 'caja ve la rendición en el cierre del día');
  assert.equal(yo.rendicion.estado, 'PENDIENTE');
  assert.equal(yo.rendicion.diferencia, -1);

  const rec = await api(ger, 'POST', `/cobranza/rendiciones/${r.b.id}/recibir`, { efectivoRecibido: dia.b.efectivo - 1, nota: 'Falta 1 sol' });
  assert.equal(rec.s, 200, JSON.stringify(rec.b));
  assert.equal(rec.b.diferencia, -1);
  assert.equal((await api(ger, 'POST', `/cobranza/rendiciones/${r.b.id}/recibir`, { efectivoRecibido: 1 })).s, 409, 'no se recibe dos veces');
  assert.equal((await api(ven, 'POST', '/cobranza/rendiciones', { efectivoEntregado: 1 })).s, 409, 'ya recibida: no se cambia');
});
