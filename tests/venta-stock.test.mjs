// node tests/correr.mjs tests/venta-stock.test.mjs  (API de pruebas con la semilla)
// Respuestas del ingeniero a la propuesta «pedidos de producción y ventas de stock» (25-nov-2026):
// venta de stock con precio por línea y aprobación del Gerente, pan por lote con vencimiento (lo vencido no se vende
// y se retira), ofertas que el cliente solo ve, factura de SUNAT en PDF, reclamos, turno de la hoja, direcciones elegidas.
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
}).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null), tipo: r.headers.get('content-type') }));
const hoy = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
const CLIENTE = () => sql(`SELECT cliente_id FROM core.usuario WHERE usuario = 'mfernandez'`);

/** Producto de prueba: stock con un lote vencido (ayer) y uno vigente, entrados por movimientos (el trigger crea los lotes). */
function prepararPan(vencido, vigente) {
  const id = sql(`SELECT id FROM core.producto WHERE estado = 'ACTIVO' AND insumo_id IS NULL AND precio_con_igv > 0 AND anticipacion_horas <= 24 ORDER BY nombre DESC LIMIT 1`);
  const mover = (cant, vence, lote) => sql(`WITH p AS (UPDATE core.producto SET stock = stock + ${cant} WHERE id = '${id}' RETURNING stock, costo_unitario)
    INSERT INTO core.movimiento_inventario (tipo,item_tipo,producto_id,documento,cantidad,costo_unitario,valor,saldo_cantidad,saldo_valor,cpp,lote,vence_en)
    SELECT 'DEVOLUCION','PRODUCTO','${id}','Prueba lotes',${cant},p.costo_unitario,${cant}*p.costo_unitario,p.stock,p.stock*p.costo_unitario,p.costo_unitario,'${lote}','${vence}'::date FROM p RETURNING id`);
  const ayer = sql(`SELECT (core.hoy_lima() - 1)::text`), luego = sql(`SELECT (core.hoy_lima() + 2)::text`);
  const marca = randomUUID().slice(0, 6);
  mover(vencido, ayer, `VEN-${marca}`);
  mover(vigente, luego, `VIG-${marca}`);
  return { id, marca, precio: Number(sql(`SELECT precio_con_igv FROM core.producto WHERE id = '${id}'`)) };
}

test('Pan por lote: lo vencido no cuenta como libre, la venta de stock respeta lo libre y pide aprobación al rebajar', async () => {
  const ven = await login('cmedina'), ger = await login('osquilcate'), desp = await login('jramos');
  const vende = ven; // despacha quien vende (ventas.registrar); Almacén retira lo vencido
  const { id, marca, precio } = prepararPan(7, 20);
  const lote = (pref) => Number(sql(`SELECT saldo FROM core.lote_producto WHERE producto_id = '${id}' AND lote = '${pref}-${marca}'`));
  assert.equal(lote('VEN'), 7);
  assert.equal(lote('VIG'), 20);

  const disp = await api(ven, 'GET', '/ventas-stock/productos');
  assert.equal(disp.s, 200, JSON.stringify(disp.b));
  const p = disp.b.productos.find((x) => x.id === id);
  assert.ok(p.vencido >= 7, 'el vencido se informa aparte');
  const libre = p.libre;
  assert.equal(libre, Math.floor(Number(sql(`SELECT core.stock_libre('${id}')`))), 'libre = stock − apartado − vencido');
  assert.ok(libre >= 20 && libre <= p.stock - p.apartado - 7 + 1e-6, 'el vencido no se puede vender');

  const cliente = CLIENTE();
  // Más de lo libre: 409 con lo que queda.
  const mucho = await api(ven, 'POST', '/pedidos/stock', { clienteId: cliente, items: [{ productoId: id, cantidad: libre + 1, precio }] });
  assert.equal(mucho.s, 409, JSON.stringify(mucho.b));
  assert.match(mucho.b.detail, /Solo quedan|Ya no queda/);

  // El ingeniero decidió que toda rebaja la apruebe el Gerente (tope 0 en Parámetros).
  assert.equal(sql(`SELECT valor FROM core.parametro WHERE clave = 'venta_stock_descuento_maximo'`), '0');
  const rebajado = Number((precio * 0.8).toFixed(2));
  const sinAprob = await api(ven, 'POST', '/pedidos/stock', { clienteId: cliente, items: [{ productoId: id, cantidad: 5, precio: rebajado }] });
  assert.equal(sinAprob.s, 422, JSON.stringify(sinAprob.b));
  assert.equal(sinAprob.b.codigo, 'REQUIERE_APROBACION');

  // Al precio de lista no pide nada: nace Listo, aparta el pan y no entra a la hoja de producción.
  const reservadoAntes = Number(sql(`SELECT reservado FROM core.producto WHERE id = '${id}'`));
  const v1 = await api(ven, 'POST', '/pedidos/stock', { clienteId: cliente, items: [{ productoId: id, cantidad: 5, precio }] });
  assert.equal(v1.s, 201, JSON.stringify(v1.b));
  assert.equal(v1.b.estado, 'LISTO');
  assert.equal(sql(`SELECT es_oferta::text || '|' || estado FROM core.pedido WHERE codigo = '${v1.b.codigo}'`), 'true|LISTO');
  assert.equal(Number(sql(`SELECT reservado FROM core.producto WHERE id = '${id}'`)), reservadoAntes + 5, 'quedó apartado');

  // Con aprobación del Gerente para 20 %: pasa, y la aprobación queda usada en ese pedido.
  // Quien vende stock sin registrar ventas de mostrador (Administrador) también puede pedir la rebaja.
  const adm = await login('lbermudez');
  assert.equal((await api(adm, 'POST', '/descuentos/solicitudes', { porcentaje: 0.1, motivo: 'Rebaja de stock (prueba admin)', clienteId: cliente, paraStock: true })).s, 201);
  const sol = await api(ven, 'POST', '/descuentos/solicitudes', { porcentaje: 0.2, motivo: 'Remate de la tarde (prueba)', clienteId: cliente, paraStock: true });
  assert.equal(sol.s, 201, JSON.stringify(sol.b));
  assert.equal((await api(ger, 'POST', `/descuentos/solicitudes/${sol.b.id}/resolver`, { aprobar: true })).s, 200);
  const v2 = await api(ven, 'POST', '/pedidos/stock', { clienteId: cliente, items: [{ productoId: id, cantidad: 4, precio: rebajado }], aprobacionId: sol.b.id });
  assert.equal(v2.s, 201, JSON.stringify(v2.b));
  assert.equal(sql(`SELECT estado || '|' || (pedido_id IS NOT NULL) FROM core.descuento_aprobacion WHERE id = '${sol.b.id}'`), 'USADA|true');
  assert.equal(Number(sql(`SELECT precio_lista FROM core.pedido_detalle d JOIN core.pedido p ON p.id = d.pedido_id WHERE p.codigo = '${v2.b.codigo}'`)), precio, 'guarda el precio de lista');

  // Despacho: se vende al precio pactado y sale primero el lote vigente (el vencido no se toca).
  const ped2 = sql(`SELECT id FROM core.pedido WHERE codigo = '${v2.b.codigo}'`);
  const vigentes = () => Number(sql(`SELECT coalesce(sum(saldo), 0) FROM core.lote_producto WHERE producto_id = '${id}' AND (vence_en IS NULL OR vence_en >= core.hoy_lima())`));
  const vigAntes = vigentes();
  const d = await api(vende, 'POST', '/ventas', { items: [{ productoId: id, cantidad: 4 }], formaPago: 'CREDITO', clienteId: cliente, pedidoId: ped2 });
  assert.equal(d.s, 201, JSON.stringify(d.b));
  assert.equal(Number(sql(`SELECT precio_con_igv FROM core.venta_detalle WHERE venta_id = '${d.b.ventaId}'`)), rebajado, 'la venta lleva el precio aprobado');
  assert.equal(lote('VEN'), 7, 'el lote vencido sigue intacto');
  assert.equal(vigentes(), vigAntes - 4, 'salió de lotes vigentes (FEFO entre los que no vencieron)');

  // Retiro de vencidos: merma por vencimiento; ya no queda pan vencido de este producto.
  const r = await api(desp, 'POST', '/lotes-producto/retirar-vencidos', { productoIds: [id] });
  assert.equal(r.s, 200, JSON.stringify(r.b));
  assert.ok(r.b.unidades >= 7);
  assert.equal(Number(sql(`SELECT core.producto_vencido('${id}')`)), 0);
  assert.equal(lote('VEN'), 0);
  assert.ok(Number(sql(`SELECT count(*) FROM core.movimiento_inventario WHERE producto_id = '${id}' AND tipo = 'MERMA' AND motivo_tipo = 'VENCIMIENTO'`)) >= 1);
  assert.equal((await api(desp, 'POST', '/lotes-producto/retirar-vencidos', { productoIds: [id] })).s, 409, 'nada más que retirar');
  const lotes = await api(desp, 'GET', `/lotes-producto?productoId=${id}`);
  assert.equal(lotes.s, 200);
  assert.ok(lotes.b.every((l) => l.estado !== 'VENCIDO'));

  // Cancelar la venta de stock devuelve lo apartado.
  const antes = Number(sql(`SELECT reservado FROM core.producto WHERE id = '${id}'`));
  assert.equal((await api(ven, 'PATCH', `/pedidos/${v1.b.codigo}/estado`, { estado: 'CANCELADO', motivo: 'Fin de prueba' })).s, 200);
  assert.equal(Number(sql(`SELECT reservado FROM core.producto WHERE id = '${id}'`)), antes - 5);
  // Lotes y stock siguen cuadrando.
  assert.equal(Number(sql(`SELECT p.stock - coalesce((SELECT sum(saldo) FROM core.lote_producto WHERE producto_id = p.id), 0) FROM core.producto p WHERE p.id = '${id}'`)), 0);
});

test('Venta de stock: solo el personal con permiso; el cliente no toma ofertas desde la app (Parámetros)', async () => {
  const cli = await login('mfernandez'), prod = await login('rquispe'), adm = await login('lbermudez');
  sql(`UPDATE core.parametro SET valor = 'false' WHERE clave = 'ofertas_pedido_cliente'`); // el valor de fábrica (067)
  const id = sql(`SELECT id FROM core.producto WHERE estado = 'ACTIVO' AND insumo_id IS NULL ORDER BY nombre LIMIT 1`);
  assert.equal((await api(cli, 'POST', '/pedidos/stock', { clienteId: CLIENTE(), items: [{ productoId: id, cantidad: 1, precio: 1 }] })).s, 403);
  assert.equal((await api(prod, 'GET', '/ventas-stock/productos')).s, 403);

  sql(`UPDATE core.producto SET stock = stock + 5 WHERE id = '${id}'`);
  sql(`INSERT INTO core.lote_producto (producto_id, lote, vence_en, cantidad_inicial, saldo) VALUES ('${id}', 'PRUEBA-OF', core.hoy_lima() + 3, 5, 5)`);
  const promo = await api(adm, 'POST', '/promociones', { productoId: id, titulo: `Oferta solo aviso ${randomUUID().slice(0, 5)}`, precioConIgv: 0.5, desde: hoy(), hasta: hoy(), cantidad: 2, avisar: false });
  assert.equal(promo.s, 201, JSON.stringify(promo.b));
  after(() => sql(`UPDATE core.promocion SET activa = false WHERE id = '${promo.b.id}'`));
  const vista = (await api(cli, 'GET', '/promociones/vigentes')).b.find((x) => x.id === promo.b.id);
  assert.equal(vista.pedible, false, 'el cliente ve el aviso, no el botón');
  assert.equal(vista.disponible, 2, 'y cuánto queda');
  const r = await api(cli, 'POST', '/pedidos', { items: [{ productoId: id, cantidad: 1, promocionId: promo.b.id }] });
  assert.equal(r.s, 409, JSON.stringify(r.b));
  assert.match(r.b.detail, /vendedor/);
});

test('Dirección elegida (no escrita) y varias direcciones en la ficha del cliente', async () => {
  const adm = await login('lbermudez'), ven = await login('cmedina');
  const cliente = CLIENTE();
  const dir = `Av. Prueba ${randomUUID().slice(0, 6)} 123, Lima`;
  const n = await api(adm, 'POST', `/clientes/${cliente}/direcciones`, { direccion: dir, referencia: 'Puerta verde' });
  if (n.s === 409) assert.match(n.b.detail, /hasta/); else assert.equal(n.s, 201, JSON.stringify(n.b));
  const lista = await api(ven, 'GET', `/clientes/${cliente}/direcciones`);
  assert.equal(lista.s, 200);
  const prod = sql(`SELECT id FROM core.producto WHERE estado = 'ACTIVO' AND insumo_id IS NULL AND anticipacion_horas = 0 ORDER BY nombre LIMIT 1`);
  const escrita = await api(ven, 'POST', '/pedidos', { clienteId: cliente, items: [{ productoId: prod, cantidad: 1 }], tipoEntrega: 'DELIVERY', direccion: 'Una calle que nadie registró 999' });
  assert.equal(escrita.s, 422, JSON.stringify(escrita.b));
  const elegida = lista.b.direcciones[0].direccion;
  const ok = await api(ven, 'POST', '/pedidos', { clienteId: cliente, items: [{ productoId: prod, cantidad: 1 }], tipoEntrega: 'DELIVERY', direccion: elegida });
  assert.equal(ok.s, 201, JSON.stringify(ok.b));
  await api(ven, 'PATCH', `/pedidos/${ok.b.codigo}/estado`, { estado: 'CANCELADO', motivo: 'Fin de prueba' });
  if (n.s === 201) assert.equal((await api(adm, 'DELETE', `/clientes/${cliente}/direcciones/${n.b.id}`)).s, 200);
});

test('Factura de SUNAT: se sube en PDF al pedido y solo su cliente (o el personal) la descarga', async () => {
  const ven = await login('cmedina'), cli = await login('mfernandez'), prod = await login('psalas');
  const ped = sql(`SELECT codigo FROM core.pedido WHERE cliente_id = '${CLIENTE()}' AND estado NOT IN ('CANCELADO','RECHAZADO') ORDER BY creado_en DESC LIMIT 1`);
  assert.ok(ped, 'hace falta un pedido vivo del cliente de prueba');
  const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
  assert.equal((await api(ven, 'POST', `/pedidos/${ped}/factura`, { numero: 'F001-1', archivo: 'data:image/png;base64,' + Buffer.from('no es pdf').toString('base64') })).s, 415);
  assert.equal((await api(prod, 'POST', `/pedidos/${ped}/factura`, { numero: 'F001-1', archivo: pdf })).s, 403, 'sin permiso comprobantes.subir');
  const s = await api(ven, 'POST', `/pedidos/${ped}/factura`, { numero: 'f001-777', archivo: pdf });
  assert.equal(s.s, 200, JSON.stringify(s.b));
  assert.equal(s.b.factura.numero, 'F001-777');
  const desc = await fetch(B + `/pedidos/${ped}/factura`, { headers: { Authorization: 'Bearer ' + cli } });
  assert.equal(desc.status, 200);
  assert.equal(desc.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await desc.arrayBuffer()).toString('latin1', 0, 5), '%PDF-');
  const mio = (await api(cli, 'GET', '/pedidos')).b.find((x) => x.codigo === ped);
  assert.equal(mio.factura.numero, 'F001-777', 'el cliente la ve en su pedido');
  assert.equal((await fetch(B + `/pedidos/${ped}/factura`, { headers: { Authorization: 'Bearer ' + prod } })).status, 404, 'sin pedidos.ver no existe');
});

test('Reclamos: el cliente registra, la panadería responde y resuelve, todo con seguimiento', async () => {
  const cli = await login('mfernandez'), ven = await login('cmedina');
  assert.equal((await api(ven, 'POST', '/reclamos', { tipo: 'PRODUCTO', descripcion: 'El personal no registra reclamos.' })).s, 403);
  const ped = sql(`SELECT codigo FROM core.pedido WHERE cliente_id = '${CLIENTE()}' ORDER BY creado_en DESC LIMIT 1`);
  const r = await api(cli, 'POST', '/reclamos', { tipo: 'FALTANTE', descripcion: 'Llegaron 45 panes y pedí 50.', pedido: ped });
  assert.equal(r.s, 201, JSON.stringify(r.b));
  assert.match(r.b.codigo, /^RCL-\d{4}-\d{6}$/);
  assert.equal((await api(cli, 'POST', `/reclamos/${r.b.codigo}/seguimiento`, { mensaje: 'Lo cierro yo', estado: 'CERRADO' })).s, 403, 'el estado lo cambia la panadería');

  const resp = await api(ven, 'POST', `/reclamos/${r.b.codigo}/seguimiento`, { mensaje: 'Revisamos el despacho.' });
  assert.equal(resp.b.estado, 'EN_PROCESO');
  const res = await api(ven, 'POST', `/reclamos/${r.b.codigo}/seguimiento`, { mensaje: 'Le reponemos 5 panes mañana.', estado: 'RESUELTO' });
  assert.equal(res.b.estado, 'RESUELTO');
  const det = await api(cli, 'GET', `/reclamos/${r.b.codigo}`);
  assert.equal(det.b.resolucion, 'Le reponemos 5 panes mañana.');
  assert.equal(det.b.seguimiento.length, 2);
  // El cliente responde a un resuelto: se reabre.
  assert.equal((await api(cli, 'POST', `/reclamos/${r.b.codigo}/seguimiento`, { mensaje: 'No llegaron los 5.' })).b.estado, 'EN_PROCESO');
  await api(ven, 'POST', `/reclamos/${r.b.codigo}/seguimiento`, { mensaje: 'Repuestos hoy.', estado: 'RESUELTO' });
  assert.equal((await api(ven, 'POST', `/reclamos/${r.b.codigo}/seguimiento`, { mensaje: 'Cerrado con el cliente.', estado: 'CERRADO' })).b.estado, 'CERRADO');
  assert.equal((await api(cli, 'POST', `/reclamos/${r.b.codigo}/seguimiento`, { mensaje: 'Otra cosa' })).s, 409, 'cerrado no se reabre');
  assert.ok((await api(cli, 'GET', '/reclamos')).b.every((x) => x.clienteId === CLIENTE()), 'el cliente solo ve los suyos');
});

test('Hoja: el turno es obligatorio mientras haya turnos activos; sus OP no se cierran desde el Tablero', async () => {
  const prod = await login('rquispe');
  const lejana = '2099-01-01';
  const sinTurno = await api(prod, 'POST', '/produccion/hoja/cerrar-pedidos', { fecha: lejana });
  assert.equal(sinTurno.s, 422, JSON.stringify(sinTurno.b));
  assert.match(sinTurno.b.detail, /turno/);
  assert.equal((await api(prod, 'POST', '/produccion/hoja/cerrar-pedidos', { fecha: lejana, turno: 'NOEXISTE' })).s, 422);
  assert.equal((await api(prod, 'POST', '/produccion/hoja/cerrar-pedidos', { fecha: lejana, turno: 'MANANA' })).s, 409, 'con turno válido llega a la validación de pedidos');
  const op = sql(`SELECT codigo FROM core.orden_produccion WHERE hoja_id IS NOT NULL AND estado = 'EN_PROCESO' LIMIT 1`);
  if (op) {
    const c = await api(prod, 'POST', `/ordenes-produccion/${op}/cerrar`, { unidadesBuenas: 1 });
    assert.equal(c.s, 409, JSON.stringify(c.b));
    assert.equal(c.b.codigo, 'OP_DE_HOJA');
  }
});
