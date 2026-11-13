// node --test tests/modificaciones-02.test.mjs  (API de pruebas con la semilla)
// Informe «Modificaciones sistema Tanta 02»: entrega según hora de corte, corrección del pedido, hoja de producción,
// despacho con móvil y empaques, voucher, gastos, liquidación, promociones y punto de equilibrio.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
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

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
const lima = (dias = 0) => new Date(Date.now() - 5 * 3_600_000 + dias * 86_400_000).toISOString().slice(0, 10);
// Word 04: la fecha con producción ya empezada (con hoja) no recibe más pedidos de clientes.
const libre = (dias = 0) => sql(`SELECT core.entrega_libre('${lima(dias)}')`);
const param = (clave, valor) => sql(`UPDATE core.parametro SET valor = '${valor}' WHERE clave = '${clave}'`);

// Producto con receta vigente y sus insumos con stock de sobra: esta prueba es del flujo, no de la falta de stock.
const conReceta = () => sql(`SELECT p.id FROM core.producto p JOIN core.receta r ON r.producto_id = p.id AND r.estado = 'VIGENTE'
  WHERE p.estado = 'ACTIVO' AND p.insumo_id IS NULL AND r.unidades_esperadas > 0 AND p.anticipacion_horas <= 24 ORDER BY p.nombre LIMIT 1`);
const prodA = conReceta();
sql(`UPDATE core.insumo SET stock = stock + 500000 WHERE id IN (SELECT d.insumo_id FROM core.receta_detalle d JOIN core.receta r ON r.id = d.receta_id WHERE r.producto_id = '${prodA}')`);
const stock = () => Number(sql(`SELECT stock FROM core.producto WHERE id = '${prodA}'`));
const reservado = () => Number(sql(`SELECT reservado FROM core.producto WHERE id = '${prodA}'`));
const precio = () => Number(sql(`SELECT precio_con_igv FROM core.producto WHERE id = '${prodA}'`));
const empezarEnCero = () => sql(`UPDATE core.pedido SET estado = 'CANCELADO', motivo = 'limpieza de prueba' WHERE estado = 'CONFIRMADO' AND hoja_id IS NULL`);

const cortePrevio = sql("SELECT valor FROM core.parametro WHERE clave = 'hora_corte_mismo_dia'");
after(() => param('hora_corte_mismo_dia', cortePrevio));

test('Entrega: la calcula el servidor con la hora de corte, aunque el cliente envíe otra fecha', async () => {
  const cli = await login('mfernandez');
  param('hora_corte_mismo_dia', '23:59');
  const hoy = await api(cli, 'POST', '/pedidos', { items: [{ productoId: prodA, cantidad: 1 }], fechaEntrega: lima(20) });
  assert.equal(hoy.s, 201, JSON.stringify(hoy.b));
  assert.equal(hoy.b.fechaEntrega, libre(), 'antes del corte: el mismo día');
  param('hora_corte_mismo_dia', '00:00');
  const man = await api(cli, 'POST', '/pedidos', { items: [{ productoId: prodA, cantidad: 1 }] });
  assert.equal(man.b.fechaEntrega, libre(1), 'después del corte: al día siguiente');
  assert.equal((await api(cli, 'GET', '/pedidos/entrega-estimada')).b.fecha, libre(1));
  const adm = await login('lbermudez');
  assert.equal((await api(adm, 'PATCH', '/parametros/hora_corte_mismo_dia', { valor: '25:00' })).s, 422, 'una hora inválida no se guarda');
  for (const p of [hoy, man]) await api(cli, 'POST', `/pedidos/${p.b.codigo}/cancelar`, { motivo: 'Prueba de fechas' });
});

test('El vendedor corrige el pedido antes de producción; el cliente recibe el aviso y no puede corregir', async () => {
  const cli = await login('mfernandez'), ven = await login('cmedina');
  const p = await api(cli, 'POST', '/pedidos', { items: [{ productoId: prodA, cantidad: 4 }] });
  const c = await api(ven, 'PUT', `/pedidos/${p.b.codigo}/items`, { items: [{ productoId: prodA, cantidad: 48 }] });
  assert.equal(c.s, 200, JSON.stringify(c.b));
  assert.equal(c.b.total, Number((precio() * 48).toFixed(2)), 'el total se recalcula en el servidor');
  assert.equal((await api(cli, 'PUT', `/pedidos/${p.b.codigo}/items`, { items: [{ productoId: prodA, cantidad: 1 }] })).s, 403);
  assert.equal(sql(`SELECT count(*) FROM audit.evento WHERE accion = 'PEDIDO_CORREGIDO' AND entidad_id = '${p.b.codigo}'`), '1');
  await api(cli, 'POST', `/pedidos/${p.b.codigo}/cancelar`, { motivo: 'Fin de prueba' });
});

test('Del pedido a la cobranza: hoja de producción, cierre con lo real, despacho en móvil, entrega con voucher', async () => {
  empezarEnCero();
  const cli = await login('mfernandez'), ven = await login('cmedina'), pro = await login('rquispe'), adm = await login('lbermudez');
  param('hora_corte_mismo_dia', '00:00');
  const p = await api(cli, 'POST', '/pedidos', { items: [{ productoId: prodA, cantidad: 10 }] });
  assert.equal(p.s, 201, JSON.stringify(p.b));
  const fecha = p.b.fechaEntrega;
  // Otro pedido del cliente, aún sin confirmar cuando empiece la producción.
  const tarde = await api(cli, 'POST', '/pedidos', { items: [{ productoId: prodA, cantidad: 1 }] });
  assert.equal(tarde.b.fechaEntrega, fecha);
  assert.equal((await api(ven, 'PATCH', `/pedidos/${p.b.codigo}/estado`, { estado: 'CONFIRMADO' })).s, 200);

  // La hoja se llena sola con lo confirmado, con su kárdex de insumos.
  const h = await api(pro, 'GET', `/produccion/hoja?fecha=${fecha}`);
  assert.equal(h.s, 200, JSON.stringify(h.b));
  const fila = h.b.filas.find((f) => f.productoId === prodA);
  assert.ok(fila.pedido >= 10);
  assert.ok(Object.values(fila.porCliente).includes(10), 'columna por cliente');
  assert.ok(h.b.insumos.length > 0 && h.b.insumos.every((i) => ['NORMAL', 'ALERTA', 'FALTA'].includes(i.estado)));
  const pedido = fila.pedido;
  // Word 04: consumo, stock actual y saldo; costo unitario y total solo para quien ve costos.
  const kardex = (await api(adm, 'GET', `/produccion/hoja?fecha=${fecha}`)).b.insumos;
  assert.ok(kardex.every((i) => Math.abs(i.stock - i.cantidad - i.restante) < 0.001), 'saldo = stock actual − consumo');
  assert.ok(kardex.every((i) => Math.abs(i.costoUnitario * i.cantidad - i.costoTotal) < 0.02) && kardex.some((i) => i.costoTotal > 0), 'costo total = consumo × costo unitario');
  assert.ok(!('costoTotal' in h.b.insumos[0]) || sql("SELECT count(*) FROM core.rol_permiso WHERE rol_id = 'PRODUCCION' AND permiso_id = 'costos.ver'") !== '0');

  // Cerrar pedidos: pasan a producción.
  assert.equal((await api(cli, 'POST', '/produccion/hoja/cerrar-pedidos', { fecha })).s, 403, 'un cliente no cierra');
  const cierre = await api(pro, 'POST', '/produccion/hoja/cerrar-pedidos', { fecha });
  assert.equal(cierre.s, 201, JSON.stringify(cierre.b));
  assert.match(cierre.b.codigo, /^LOT \d+$/);
  const cod = encodeURIComponent(cierre.b.codigo);
  assert.equal(sql(`SELECT estado FROM core.pedido WHERE codigo = '${p.b.codigo}'`), 'EN_PRODUCCION');
  assert.equal((await api(ven, 'POST', `/pedidos/${p.b.codigo}/cancelar`, { motivo: 'Tarde' })).s, 409);
  // Word 04: empezada la producción de esa fecha, los pedidos del cliente ya no entran en ella.
  const nuevo = await api(cli, 'POST', '/pedidos', { items: [{ productoId: prodA, cantidad: 1 }] });
  assert.ok(nuevo.b.fechaEntrega > fecha, 'el pedido nuevo va a la siguiente fecha');
  assert.equal((await api(ven, 'PATCH', `/pedidos/${tarde.b.codigo}/estado`, { estado: 'CONFIRMADO' })).s, 200);
  assert.ok(sql(`SELECT fecha_entrega::text FROM core.pedido WHERE codigo = '${tarde.b.codigo}'`) > fecha, 'el que se confirma tarde también');
  for (const x of [nuevo, tarde]) await api(ven, 'POST', `/pedidos/${x.b.codigo}/cancelar`, { motivo: 'Fin de prueba' });

  // Cerrar producción: entra lo real (más que lo pedido), se descargan insumos, el pedido queda listo.
  const insumoAntes = Number(sql(`SELECT sum(i.stock) FROM core.insumo i WHERE i.id IN (SELECT d.insumo_id FROM core.receta_detalle d JOIN core.receta r ON r.id = d.receta_id WHERE r.producto_id = '${prodA}')`));
  const stockAntes = stock();
  const lineas = (await api(pro, 'GET', `/produccion/hojas/${cod}`)).b.resumen.map((r) => ({ productoId: r.productoId, real: r.pedido + 5 }));
  // Word 04 (200 pedidos, 2,080 producidos): una diferencia mayor a la tolerancia pide confirmación.
  param('tolerancia_produccion', '0.001'); // mínima: la hoja puede traer pedidos de otras pruebas y +5 no llegar al 10 %
  const dudosa = await api(pro, 'POST', `/produccion/hojas/${cod}/cerrar`, { lineas });
  assert.equal(dudosa.s, 409, JSON.stringify(dudosa.b));
  assert.match(dudosa.b.detail, /se aleja de lo solicitado/);
  assert.equal(stock(), stockAntes, 'sin confirmar no se mueve el almacén');
  const cerrada = await api(pro, 'POST', `/produccion/hojas/${cod}/cerrar`, { lineas, confirmar: true });
  param('tolerancia_produccion', '0.10');
  assert.equal(cerrada.s, 200, JSON.stringify(cerrada.b));
  assert.equal(cerrada.b.sinStock.length, 0);
  assert.equal(stock(), stockAntes + pedido + 5, 'los panes reales entran al almacén');
  assert.ok(Number(sql(`SELECT sum(i.stock) FROM core.insumo i WHERE i.id IN (SELECT d.insumo_id FROM core.receta_detalle d JOIN core.receta r ON r.id = d.receta_id WHERE r.producto_id = '${prodA}')`)) < insumoAntes, 'los insumos se descargan al cerrar');
  assert.equal(sql(`SELECT estado FROM core.pedido WHERE codigo = '${p.b.codigo}'`), 'LISTO');
  assert.equal((await api(pro, 'POST', `/produccion/hojas/${cod}/cerrar`, { lineas })).s, 409, 'no se cierra dos veces');

  // Historial: costo, venta y rentabilidad; el maestro no ve costos sin el permiso.
  const det = (await api(adm, 'GET', `/produccion/hojas/${cod}`)).b;
  const r = det.resumen.find((x) => x.productoId === prodA);
  assert.equal(r.real, pedido + 5);
  assert.ok(r.costo > 0 && r.venta > 0);
  assert.equal(r.rentabilidad, Number((r.venta - r.costo).toFixed(2)));
  assert.ok(det.insumosUsados.length > 0);
  assert.ok(!('costo' in (await api(pro, 'GET', `/produccion/hojas/${cod}`)).b.resumen[0]) || sql("SELECT count(*) FROM core.rol_permiso WHERE rol_id = 'PRODUCCION' AND permiso_id = 'costos.ver'") !== '0');

  // Despacho: el rol Despacho carga el pedido a la móvil sin poder hacer ventas directas.
  sql(`INSERT INTO core.usuario_rol (usuario_id, rol_id) SELECT id, 'DESPACHO' FROM core.usuario WHERE usuario = 'jramos' ON CONFLICT DO NOTHING`);
  const placa = `T${randomUUID().slice(0, 5).toUpperCase()}`;
  const v = await api(adm, 'POST', '/vehiculos', { placa, descripcion: 'Furgón', conductor: 'Prueba' });
  assert.equal(v.s, 201, JSON.stringify(v.b));
  assert.equal((await api(adm, 'POST', '/vehiculos', { placa })).s, 409, 'placa repetida');
  const emp = sql(`INSERT INTO core.insumo (codigo, nombre, unidad, cpp, stock, minimo, tipo, unidad_inventario, maneja_stock) SELECT 'EMP-' || substr(md5(random()::text), 1, 6), 'Bolsa prueba', unidad, 0.5, 100, 0, 'EMPAQUE', unidad_inventario, true FROM core.insumo LIMIT 1 RETURNING id`).split('\n')[0];
  const d = await api(adm, 'GET', '/despacho');
  assert.equal(d.s, 200, JSON.stringify(d.b));
  const enLista = d.b.pedidos.find((x) => x.codigo === p.b.codigo);
  assert.ok(enLista);
  assert.ok(d.b.empaques.some((e) => e.id === emp));
  assert.equal((await api(cli, 'GET', '/despacho')).s, 403);
  const venta = await api(adm, 'POST', '/ventas', { pedidoId: enLista.id, vehiculoId: v.b.id, empaques: [{ insumoId: emp, cantidad: 3 }],
    items: enLista.items.map((i) => ({ productoId: i.productoId, cantidad: Number(i.cantidad) })) });
  assert.equal(venta.s, 201, JSON.stringify(venta.b));
  assert.equal(sql(`SELECT estado FROM core.pedido WHERE codigo = '${p.b.codigo}'`), 'DESPACHADO');
  assert.equal(Number(sql(`SELECT stock FROM core.insumo WHERE id = '${emp}'`)), 97, 'el empaque se descarga');
  assert.equal((await api(cli, 'GET', '/pedidos')).b.find((x) => x.codigo === p.b.codigo).vehiculo, placa, 'el pedido dice qué móvil lo lleva');

  // Entrega con pago y voucher: recién ahí entra a cobranza.
  const e = await api(ven, 'PATCH', `/pedidos/${p.b.codigo}/estado`, { estado: 'ENTREGADO', voucher: PNG, pagos: [{ monto: 1, medio: 'YAPE', referencia: 'V-123456' }] });
  assert.equal(e.s, 200, JSON.stringify(e.b));
  const urlVoucher = e.b.recibo.comprobante_url ?? e.b.recibo.comprobanteUrl ?? '';
  assert.match(urlVoucher, /^\/comprobantes\//, 'el voucher queda en el recibo');
  // Privado: sin sesión no se ve, tampoco por la ruta pública; lo ve el dueño y quien tiene permiso.
  const id = urlVoucher.split('/').pop();
  const ver = (t) => fetch(B + urlVoucher, t ? { headers: { Authorization: 'Bearer ' + t } } : {});
  assert.equal((await ver()).status, 401, 'sin sesión');
  assert.equal((await fetch(`${B}/archivos/${id}`)).status, 404, 'la ruta pública no lo entrega');
  const visto = await ver(ven);
  assert.equal(visto.status, 200);
  assert.equal(visto.headers.get('cache-control'), 'private, no-store');
  assert.equal((await ver(cli)).status, 200, 'el cliente ve su propio voucher');
  assert.equal((await ver(await login('jramos'))).status, 404, 'Almacén no lo ve');
});

test('Cobranza: el voucher es opcional, y un archivo que no es imagen se rechaza', async () => {
  const t = await login('cmedina');
  const cli = sql(`WITH c AS (INSERT INTO core.cliente (codigo, nombre, dias_credito, limite_credito, condicion_pago) VALUES ('T-${randomUUID().slice(0, 8)}', 'Cliente voucher', 30, 1000, 'CREDITO') RETURNING id) SELECT id FROM c`);
  sql(`INSERT INTO core.cuenta_por_cobrar (cliente_id, monto, saldo, estado, vence_en) VALUES ('${cli}', 100, 100, 'PENDIENTE', current_date)`);
  const malo = await api(t, 'POST', '/cobranza/recibos', { clienteId: cli, voucher: 'data:text/html;base64,PHNjcmlwdD4=', pagos: [{ monto: 10, medio: 'EFECTIVO' }] });
  assert.ok([415, 422].includes(malo.s) || malo.s >= 400, 'no acepta HTML como voucher');
  const ok = await api(t, 'POST', '/cobranza/recibos', { clienteId: cli, voucher: PNG, pagos: [{ monto: 10, medio: 'EFECTIVO' }] });
  assert.equal(ok.s, 201, JSON.stringify(ok.b));
  const sin = await api(t, 'POST', '/cobranza/recibos', { clienteId: cli, pagos: [{ monto: 10, medio: 'EFECTIVO' }] });
  assert.equal(sin.s, 201);
  assert.equal(sin.b.comprobante_url, null);
});

test('Gastos de caja chica y liquidación diaria: ingresos y gastos por medio de pago', async () => {
  const ven = await login('cmedina'), adm = await login('lbermudez'), cli = await login('mfernandez');
  sql(`INSERT INTO core.caja_apertura (codigo, tipo, monto_inicial, estado, abierta_por)
    SELECT 'CCH-T' || substr(md5(random()::text), 1, 5), 'CHICA', 500, 'ABIERTA', id FROM core.usuario WHERE usuario = 'cmedina' AND NOT EXISTS (SELECT 1 FROM core.caja_apertura WHERE tipo = 'CHICA' AND estado = 'ABIERTA')`);
  const gasto = { concepto: 'Gasto de menú', fechaOperacion: lima(), periodoMes: Number(lima().slice(5, 7)), periodoAnio: Number(lima().slice(0, 4)), monto: 1, caja: 'CHICA', medio: 'EFECTIVO',
    tipoGasto: 'VENTAS', docTipo: 'FACTURA', docSerie: 'F001', docNumero: '559', autorizadoPor: 'Wilmer', comprobante: PNG };
  assert.equal((await api(cli, 'POST', '/pagos-costos', gasto)).s, 403);
  assert.equal((await api(ven, 'POST', '/pagos-costos', { ...gasto, caja: 'GRANDE' })).s, 403, 'el vendedor solo usa caja chica');
  assert.equal((await api(ven, 'POST', '/pagos-costos', { ...gasto, autorizadoPor: '' })).s, 422, 'exige quién autorizó');
  assert.equal((await api(ven, 'POST', '/pagos-costos', { ...gasto, tipoGasto: 'NOEXISTE' })).s, 422);
  const g = await api(ven, 'POST', '/pagos-costos', gasto);
  assert.equal(g.s, 201, JSON.stringify(g.b));
  const lista = (await api(ven, 'GET', '/pagos-costos')).b;
  const fila = lista.find((x) => x.codigo === g.b.codigo);
  assert.equal(fila.autorizadoPor, 'Wilmer');
  assert.equal(fila.docSerie, 'F001');
  assert.ok(lista.every((x) => x.usuario === fila.usuario), 'el vendedor ve solo sus gastos');
  const c = (await api(adm, 'GET', `/cobranza/cierre?fecha=${lima()}`)).b;
  assert.ok(c.liquidacion.detalleGastos.some((x) => x.codigo === g.b.codigo));
  assert.equal(c.liquidacion.neto, Number((c.liquidacion.totalIngresos - c.liquidacion.totalGastos).toFixed(2)));
  assert.equal(Number(c.liquidacion.gastos.reduce((s, x) => s + x.monto, 0).toFixed(2)), Number(c.liquidacion.totalGastos.toFixed(2)));
});

test('Promociones: salen del stock con su precio, no entran a producción y se liberan al cancelar', async () => {
  empezarEnCero();
  const adm = await login('lbermudez'), cli = await login('mfernandez'), ven = await login('cmedina');
  sql(`UPDATE core.producto SET stock = reservado + 10 WHERE id = '${prodA}'`);
  const body = { productoId: prodA, titulo: `Promo ${randomUUID().slice(0, 6)}`, precioConIgv: 0.5, desde: lima(), hasta: lima(2) };
  assert.equal((await api(await login('rquispe'), 'POST', '/promociones', body)).s, 403, 'sin promociones.gestionar (el Vendedor sí lo tiene desde el informe 03)');
  assert.equal((await api(adm, 'POST', '/promociones', { ...body, hasta: lima(-1) })).s, 422, 'fechas al revés');
  const pr = await api(adm, 'POST', '/promociones', body);
  assert.equal(pr.s, 201, JSON.stringify(pr.b));
  const v = (await api(cli, 'GET', '/promociones/vigentes')).b.find((x) => x.id === pr.b.id);
  assert.equal(v.disponible, 10);

  assert.equal((await api(cli, 'POST', '/pedidos', { items: [{ productoId: prodA, cantidad: 11, promocionId: pr.b.id }] })).s, 409, 'no vende más de lo que hay');
  const antes = reservado();
  const p = await api(cli, 'POST', '/pedidos', { items: [{ productoId: prodA, cantidad: 4, promocionId: pr.b.id }] });
  assert.equal(p.s, 201, JSON.stringify(p.b));
  assert.equal(p.b.total, 2, 'el precio lo pone el servidor');
  assert.equal(reservado(), antes + 4, 'queda reservado al pedir');
  // Informe del 13/11: la oferta confirmada queda lista para despacho (es stock reservado, no se produce).
  assert.equal((await api(ven, 'PATCH', `/pedidos/${p.b.codigo}/estado`, { estado: 'CONFIRMADO' })).s, 200);
  assert.equal(sql(`SELECT estado FROM core.pedido WHERE codigo = '${p.b.codigo}'`), 'LISTO');
  const h = (await api(adm, 'GET', `/produccion/hoja?fecha=${sql(`SELECT fecha_entrega FROM core.pedido WHERE codigo = '${p.b.codigo}'`)}`)).b;
  assert.ok(!h.filas.some((f) => f.productoId === prodA), 'no entra a la hoja de producción');

  // Listo no reserva otra vez; al despachar se cobra a precio de promoción y se libera la reserva.
  assert.equal(reservado(), antes + 4, 'sin doble reserva');
  const ped = (await api(ven, 'GET', '/pedidos')).b.find((x) => x.codigo === p.b.codigo);
  const venta = await api(ven, 'POST', '/ventas', { pedidoId: ped.id, items: [{ productoId: prodA, cantidad: 4 }] });
  assert.equal(venta.s, 201, JSON.stringify(venta.b));
  assert.equal(venta.b.comprobante.total, 2, 'la venta respeta el precio de promoción');
  assert.equal(reservado(), antes);

  const q = await api(cli, 'POST', '/pedidos', { items: [{ productoId: prodA, cantidad: 2, promocionId: pr.b.id }] });
  assert.equal(reservado(), antes + 2);
  await api(cli, 'POST', `/pedidos/${q.b.codigo}/cancelar`, { motivo: 'Ya no quiero' });
  assert.equal(reservado(), antes, 'cancelar devuelve el stock a la promoción');
});

test('Punto de equilibrio: gastos del mes ÷ ganancia por unidad, sin contar costos de producción', async () => {
  const adm = await login('lbermudez');
  assert.equal((await api(await login('cmedina'), 'GET', '/analisis/punto-equilibrio')).s, 403);
  const r = await api(adm, 'GET', `/analisis/punto-equilibrio?anio=${lima().slice(0, 4)}`);
  assert.equal(r.s, 200, JSON.stringify(r.b));
  const mes = Number(lima().slice(5, 7));
  const m = r.b.meses.find((x) => x.mes === mes);
  assert.ok(m.gastos >= 1);
  assert.equal(r.b.dias.length, 3);
  const p = r.b.productos.find((x) => x.ganancia > 0);
  assert.equal(p.meses.find((x) => x.mes === mes).equilibrio, Math.ceil(m.gastos / p.ganancia));
});

test('Reporte V-03: pedidos pagados y con deuda por cobrar', async () => {
  const r = await api(await login('lbermudez'), 'GET', `/reportes/V-03?desde=${lima(-1)}&hasta=${lima()}`);
  assert.equal(r.s, 200, JSON.stringify(r.b));
  assert.ok(r.b.filas.length > 0);
  assert.ok(r.b.filas.every((f) => ['Pagado', 'Deuda por cobrar', 'Por entregar', 'Anulado'].includes(f.situacion)));
});

test('Comprobante real: una foto de 700 KB pasa el límite del servidor y queda privada', async () => {
  const t = await login('cmedina');
  const cli = sql(`WITH c AS (INSERT INTO core.cliente (codigo, nombre, dias_credito, limite_credito, condicion_pago) VALUES ('T-${randomUUID().slice(0, 8)}', 'Cliente foto', 30, 1000, 'CREDITO') RETURNING id) SELECT id FROM c`);
  sql(`INSERT INTO core.cuenta_por_cobrar (cliente_id, monto, saldo, estado, vence_en) VALUES ('${cli}', 100, 100, 'PENDIENTE', current_date)`);
  const png = Buffer.concat([Buffer.from(PNG.split(',')[1], 'base64'), Buffer.alloc(700_000, 7)]);
  const r = await api(t, 'POST', '/cobranza/recibos', { clienteId: cli, voucher: 'data:image/png;base64,' + png.toString('base64'), pagos: [{ monto: 10, medio: 'EFECTIVO' }] });
  assert.equal(r.s, 201, JSON.stringify(r.b));
});

test('Excel real: .xlsx con números, texto escapado y sin fórmulas; exige sesión', async () => {
  const cuerpo = { nombre: 'Prueba <ñ>', filas: [{ Cliente: '=HYPERLINK("x") & <b>', Total: 1234.5 }, { Cliente: 'Ana', Total: 2 }] };
  const sin = await fetch(B + '/exportar/excel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
  assert.equal(sin.status, 401);
  const r = await fetch(B + '/exportar/excel', { method: 'POST', headers: { Authorization: 'Bearer ' + await login('cmedina'), 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /spreadsheetml/);
  const zip = Buffer.from(await r.arrayBuffer());
  assert.equal(zip.toString('latin1', 0, 2), 'PK');
  // Se recorre el ZIP como lo hace Excel: por sus cabeceras locales.
  const partes = new Map();
  for (let i = 0; zip.readUInt32LE(i) === 0x04034b50;) {
    const largo = zip.readUInt32LE(i + 18), n = zip.readUInt16LE(i + 26), inicio = i + 30 + n;
    partes.set(zip.toString('utf8', i + 30, inicio), inflateRawSync(zip.subarray(inicio, inicio + largo)).toString('utf8'));
    i = inicio + largo;
  }
  for (const p of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml']) assert.ok(partes.has(p), p);
  const hoja = partes.get('xl/worksheets/sheet1.xml');
  assert.ok(hoja.includes('<v>1234.5</v>'), 'los números son números');
  assert.ok(hoja.includes('=HYPERLINK(&quot;x&quot;) &amp; &lt;b&gt;'), 'el texto va escapado');
  assert.ok(!hoja.includes('<f>'), 'nunca hay fórmulas');
  assert.ok(partes.get('xl/workbook.xml').includes('Prueba &lt;ñ&gt;'));
});

test('Instalación nueva: la semilla trae todos los permisos, menús y parámetros de las migraciones', async () => {
  for (const p of ['clientes.avisar', 'despacho.ver', 'despacho.gestionar', 'gastos.registrar', 'promociones.gestionar', 'caja.rendiciones']) {
    assert.equal(sql(`SELECT count(*) FROM core.permiso WHERE id = '${p}'`), '1', p);
  }
  assert.equal(sql("SELECT count(*) FROM core.rol WHERE id = 'DESPACHO'"), '1');
  assert.equal(sql("SELECT count(*) FROM core.navegacion WHERE ruta IN ('/ventas/despacho','/ventas/gastos','/ventas/promociones','/ventas/avisos','/produccion/hoja','/gerencia/punto-equilibrio')"), '6');
  assert.equal(sql("SELECT count(*) FROM core.parametro WHERE clave = 'hora_corte_mismo_dia'"), '1');
});
