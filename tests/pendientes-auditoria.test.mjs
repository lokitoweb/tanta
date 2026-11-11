// node tests/correr.mjs tests/pendientes-auditoria.test.mjs
// Pendientes de la auditoría 2026-11: anular cobros y recibos (con y sin rendir), rendición complementaria,
// receta congelada en la orden de producción y verificación en dos pasos administrable por rol.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from './_sql.mjs';

const B = process.env.API ?? 'http://127.0.0.1:3001/api/v1';
const login = async (u) => (await (await fetch(B + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario: u, clave: 'tanta' }) })).json()).accessToken;
const api = (t, m, ruta, body) => fetch(B + ruta, {
  method: m, headers: { Authorization: 'Bearer ' + t, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));
const manana = () => new Date(Date.now() - 5 * 3_600_000 + 86_400_000).toISOString().slice(0, 10);

const sufijo = randomUUID().slice(0, 6).toUpperCase();
let ven, alm, ger, adm, sa, productoId, clienteId;

/** Pedido de 10 panes a S/ 2.00, despachado y entregado con S/ 20 en efectivo: devuelve el recibo. */
async function entregadoConCobro() {
  const p = (await api(ven, 'POST', '/pedidos', { clienteId, items: [{ productoId, cantidad: 10 }], fechaEntrega: manana() })).b;
  assert.equal((await api(ven, 'PATCH', `/pedidos/${p.codigo}/estado`, { estado: 'LISTO' })).s, 200);
  const pedId = sql(`SELECT id FROM core.pedido WHERE codigo = '${p.codigo}'`);
  const v = await api(ven, 'POST', '/ventas', { items: [{ productoId, cantidad: 10 }], formaPago: 'CREDITO', pedidoId: pedId });
  assert.equal(v.s, 201, JSON.stringify(v.b));
  const e = await api(ven, 'PATCH', `/pedidos/${p.codigo}/estado`, { estado: 'ENTREGADO', pagos: [{ monto: 20, medio: 'EFECTIVO' }] });
  assert.equal(e.s, 200, JSON.stringify(e.b));
  return { recibo: e.b.recibo.numero, cxcId: v.b.cxcId };
}
const cxc = (id) => sql(`SELECT estado || ' ' || saldo::numeric(10,2) FROM core.cuenta_por_cobrar WHERE id = '${id}'`);

before(async () => {
  [ven, alm, ger, adm, sa] = await Promise.all(['cmedina', 'jramos', 'osquilcate', 'lbermudez', 'superadmin'].map(login));
  productoId = sql(`WITH p AS (INSERT INTO core.producto (codigo, nombre, categoria_id, precio_con_igv, estado, anticipacion_horas)
    SELECT 'PA-${sufijo}', 'Pan anulación ${sufijo}', id, 2.00, 'ACTIVO', 0 FROM core.categoria ORDER BY orden LIMIT 1 RETURNING id) SELECT id FROM p`);
  assert.equal((await api(alm, 'POST', '/inventario/productos', { productoId, cantidad: 100, motivoTipo: 'DEVOLUCION', motivo: 'Stock de prueba' })).s, 200);
  clienteId = sql(`WITH c AS (INSERT INTO core.cliente (codigo, nombre, limite_credito, condicion_pago) VALUES ('PA-${sufijo}', 'Cliente anulación ${sufijo}', 0, 'CONTADO') RETURNING id) SELECT id FROM c`);
});

test('anular un recibo sin rendir: la deuda vuelve, no suma en el día y queda auditado', async () => {
  const { recibo, cxcId } = await entregadoConCobro();
  assert.equal(cxc(cxcId), 'PAGADA 0.00');
  const antes = (await api(ven, 'GET', '/cobranza/mi-dia')).b.porRendir.total;

  assert.equal((await api(ven, 'POST', `/cobranza/recibos/${recibo}/anular`, { motivo: 'Me equivoqué de cliente' })).s, 403, 'el vendedor no anula');
  assert.equal((await api(ger, 'POST', `/cobranza/recibos/${recibo}/anular`, { motivo: 'no' })).s, 422, 'el motivo es obligatorio');
  const a = await api(ger, 'POST', `/cobranza/recibos/${recibo}/anular`, { motivo: 'Monto mal digitado' });
  assert.equal(a.s, 200, JSON.stringify(a.b));
  assert.equal(a.b.salioDeCajaGrande, false, 'sin rendir, el dinero no estaba en caja grande');
  assert.equal(cxc(cxcId), 'PENDIENTE 20.00', 'la deuda vuelve completa');
  assert.equal(sql(`SELECT estado FROM core.recibo WHERE numero = '${recibo}'`), 'ANULADO');
  assert.equal((await api(ger, 'POST', `/cobranza/recibos/${recibo}/anular`, { motivo: 'Otra vez' })).s, 409, 'no se anula dos veces');

  const dia = (await api(ven, 'GET', '/cobranza/mi-dia')).b;
  assert.ok(Math.abs(dia.porRendir.total - (antes - 20)) < 0.001, 'lo anulado ya no se rinde');
  assert.ok(!dia.cobros.some((x) => x.recibo === recibo), 'ni aparece en los cobros del día');
  const edc = (await api(ger, 'GET', `/estado-cuenta?clienteId=${clienteId}`)).b;
  assert.equal(edc.pagos.find((x) => x.recibo === recibo)?.estado, 'ANULADO', 'el estado de cuenta lo muestra anulado');
  assert.equal(Number(sql(`SELECT count(*) FROM audit.evento WHERE accion = 'COBRO_ANULADO' AND entidad_id = '${recibo}'`)), 1);
});

test('rendición complementaria y anulación de un cobro ya recibido por caja (sale de caja grande)', async () => {
  // Todo lo pendiente del vendedor se rinde y caja lo recibe.
  const pendiente = (await api(ven, 'GET', '/cobranza/mi-dia')).b.porRendir;
  if (pendiente.total > 0) {
    const r0 = await api(ven, 'POST', '/cobranza/rendiciones', { efectivoEntregado: pendiente.efectivo });
    assert.equal(r0.s, 201, JSON.stringify(r0.b));
    assert.equal((await api(ger, 'POST', `/cobranza/rendiciones/${r0.b.id}/recibir`, { efectivoRecibido: pendiente.efectivo })).s, 200);
  }
  // Un cobro posterior: va en una rendición complementaria, no se pierde.
  const { recibo, cxcId } = await entregadoConCobro();
  const dia = (await api(ven, 'GET', '/cobranza/mi-dia')).b;
  assert.equal(dia.porRendir.total, 20, 'solo lo cobrado después');
  const r = await api(ven, 'POST', '/cobranza/rendiciones', { efectivoEntregado: 20 });
  assert.equal(r.s, 201, JSON.stringify(r.b));
  assert.equal(r.b.total, 20);
  assert.equal(r.b.complementaria, pendiente.total > 0 || dia.rendiciones.some((x) => x.estado === 'RECIBIDA'));
  assert.equal(Number(sql(`SELECT count(*) FROM core.cobranza b JOIN core.recibo x ON x.id = b.recibo_id WHERE x.numero = '${recibo}' AND b.rendicion_id = '${r.b.id}'`)), 1, 'el cobro queda ligado a su rendición');
  assert.equal((await api(ger, 'POST', `/cobranza/rendiciones/${r.b.id}/recibir`, { efectivoRecibido: 20 })).s, 200);

  const cuenta = sql(`SELECT cuenta FROM core.movimiento_caja WHERE origen_id = '${r.b.id}' AND tipo = 'RENDICION' LIMIT 1`);
  const saldo = () => Number(sql(`SELECT core.saldo_cuenta('${cuenta}')`));
  const antes = saldo();
  const a = await api(ger, 'POST', `/cobranza/recibos/${recibo}/anular`, { motivo: 'Pago duplicado' });
  assert.equal(a.s, 200, JSON.stringify(a.b));
  assert.equal(a.b.salioDeCajaGrande, true);
  assert.ok(Math.abs(saldo() - (antes - 20)) < 0.001, 'los S/ 20 salen de la cuenta donde entraron');
  assert.equal(sql(`SELECT count(*) FROM core.movimiento_caja WHERE tipo = 'ANULACION_COBRO' AND monto = -20 AND concepto LIKE '%Pago duplicado%'`) >= '1', true);
  assert.equal(cxc(cxcId), 'PENDIENTE 20.00');
});

test('una venta con su cobro anulado ya se puede anular', async () => {
  const { recibo, cxcId } = await entregadoConCobro();
  const venta = sql(`SELECT v.codigo FROM core.venta v JOIN core.cuenta_por_cobrar x ON x.venta_id = v.id WHERE x.id = '${cxcId}'`);
  assert.equal((await api(ger, 'POST', `/ventas/${venta}/anular`, { motivo: 'Prueba de anulación' })).s, 409, 'con cobros vigentes no');
  assert.equal((await api(ger, 'POST', `/cobranza/recibos/${recibo}/anular`, { motivo: 'Se devolvió el dinero' })).s, 200);
  const v = await api(ger, 'POST', `/ventas/${venta}/anular`, { motivo: 'Prueba de anulación' });
  assert.equal(v.s, 200, JSON.stringify(v.b));
});

test('la orden de producción congela su receta: editar la receta no cambia lo que descontará', async () => {
  const harina = sql(`SELECT id FROM core.insumo WHERE activo ORDER BY nombre LIMIT 1`);
  const pan = sql(`WITH p AS (INSERT INTO core.producto (codigo, nombre, categoria_id, precio_con_igv, estado)
    SELECT 'RC-${sufijo}', 'Pan receta ${sufijo}', id, 1.00, 'ACTIVO' FROM core.categoria ORDER BY orden LIMIT 1 RETURNING id) SELECT id FROM p`);
  assert.equal((await api(sa, 'PUT', `/recetas/${pan}`, { rendimiento: 10, mermaEstandar: 0, lineas: [{ insumoId: harina, cantidad: 1 }] })).s, 200);
  const op = await api(sa, 'POST', '/ordenes-produccion', { productoId: pan, cantidad: 10, entrega: manana(), criterio: 'PROPORCIONAL' });
  assert.equal(op.s, 201, JSON.stringify(op.b));
  const congelada = () => Number(sql(`SELECT sum(i.por_unidad) FROM core.orden_produccion_insumo i JOIN core.orden_produccion o ON o.id = i.op_id WHERE o.codigo = '${op.b.codigo}'`));
  const antes = congelada();
  assert.ok(antes > 0, 'la orden guarda su receta');
  assert.equal((await api(sa, 'PUT', `/recetas/${pan}`, { rendimiento: 10, mermaEstandar: 0, lineas: [{ insumoId: harina, cantidad: 5 }] })).s, 200);
  assert.equal(congelada(), antes, 'la receta editada no toca la orden en curso');
  await api(sa, 'POST', `/ordenes-produccion/${op.b.codigo}/anular`, { motivo: 'Prueba automática' });
  sql(`UPDATE core.producto SET estado = 'INACTIVO' WHERE id = '${pan}' RETURNING id`);
});

test('verificación en dos pasos por rol: administrable y protegida', async () => {
  const roles = (await api(sa, 'GET', '/sistema/roles')).b.roles;
  assert.equal(roles.find((r) => r.id === 'GERENTE').exigeMfa, true, 'Gerencia la exige por defecto');
  assert.equal(roles.find((r) => r.id === 'VENDEDOR').exigeMfa, false);
  assert.equal((await api(sa, 'PATCH', '/sistema/roles/SUPERADMIN/seguridad', { exigeMfa: false })).s, 409, 'el Superadministrador siempre la exige');
  assert.equal((await api(sa, 'PATCH', '/sistema/roles/COMPRAS/seguridad', { exigeMfa: true })).s, 200);
  assert.equal(sql(`SELECT exige_mfa::text FROM core.rol WHERE id = 'COMPRAS'`), 'true');
  // Quitarla baja la seguridad: solo el Superadministrador.
  assert.equal((await api(adm, 'PATCH', '/sistema/roles/COMPRAS/seguridad', { exigeMfa: false })).s, 403);
  assert.equal((await api(sa, 'PATCH', '/sistema/roles/COMPRAS/seguridad', { exigeMfa: false })).s, 200);
  assert.equal(sql(`SELECT exige_mfa::text FROM core.rol WHERE id = 'COMPRAS'`), 'false');
});
