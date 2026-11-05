// node tests/correr.mjs tests/interfaces-tanta.test.mjs
// Excel «INTERFACES TANTA» del dueño: códigos automáticos o manuales, presentaciones de venta con SKU y empaque,
// ajustar precio, insumos con costo para fórmulas manual e informe de variación, proveedor con RUC opcional y
// varias cuentas, compras (nota de pedido, crédito, precios sin IGV), CIF con clasificación y pagos de costos.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql, sqlScript } from './_sql.mjs';
import { flujoCompras, hoyLima, nroUnico } from './_compras.mjs';

const B = process.env.API ?? 'http://127.0.0.1:3001/api/v1';
const sesiones = new Map();
const login = (u) => { if (!sesiones.has(u)) sesiones.set(u, fetch(B + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario: u, clave: 'tanta' }) }).then((r) => r.json()).then((j) => j.accessToken)); return sesiones.get(u); };
const api = (t, m, ruta, body) => fetch(B + ruta, {
  method: m, headers: { Authorization: 'Bearer ' + t, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));
const sufijo = randomUUID().slice(0, 6).toUpperCase();
const limpiar = [];
after(() => { for (const s of limpiar.reverse()) { try { sqlScript(s); } catch { /* no rompe la prueba */ } } });
const compras = flujoCompras(api, login);
const valor = (consulta) => Number(sql(consulta));

test('códigos: vacío = automático (CAT-, PRV-, ALM-, CIF-); escrito = manual en mayúsculas y único', async () => {
  const adm = await login('lbermudez');
  const a = await api(adm, 'POST', '/categorias', { nombre: 'Auto ' + sufijo });
  assert.equal(a.s, 201, JSON.stringify(a.b));
  limpiar.push(`DELETE FROM core.categoria WHERE id = '${a.b.id}'`);
  assert.match(a.b.codigo, /^CAT-\d{2,}$/);
  const m = await api(adm, 'POST', '/categorias', { nombre: 'Manual ' + sufijo, codigo: 'pan-' + sufijo.toLowerCase() });
  limpiar.push(`DELETE FROM core.categoria WHERE id = '${m.b.id}'`);
  assert.equal(m.b.codigo, 'PAN-' + sufijo, 'se guarda en mayúsculas');
  assert.equal((await api(adm, 'POST', '/categorias', { nombre: 'Otra ' + sufijo, codigo: 'PAN-' + sufijo })).s, 409, 'código repetido');

  const p = await api(adm, 'POST', '/proveedores', { razonSocial: 'Prov código ' + sufijo });
  limpiar.push(`DELETE FROM core.proveedor WHERE id = '${p.b.id}'`);
  assert.match(p.b.codigo, /^PRV-\d{3,}$/);
  const k = await api(adm, 'POST', '/costos-indirectos', { concepto: 'Seguridad ' + sufijo, tipo: 'FIJO', montoMensual: 1, clasificacion: 'VENTAS', activo: false });
  assert.equal(k.s, 201, JSON.stringify(k.b));
  const cif = k.b.items.find((i) => i.concepto === 'Seguridad ' + sufijo);
  limpiar.push(`DELETE FROM core.costo_indirecto WHERE id = '${cif.id}'`);
  assert.match(cif.codigo, /^CIF-\d{2,}$/);
  assert.equal(cif.clasificacion, 'VENTAS');
  assert.equal(cif.categoria, 'GASTO', 'un costo de ventas no entra al costo del pan');
});

test('proveedor: RUC opcional y varias cuentas bancarias del catálogo', async () => {
  const adm = await login('lbermudez');
  const cuentas = [{ banco: 'BCP', numero: '125544548888' }, { banco: 'BBVA', numero: '4454-5454-45454-4545' }];
  const r = await api(adm, 'POST', '/proveedores', { razonSocial: 'Plaza prueba ' + sufijo, direccion: 'Chacarero s/n', contacto: 'Pedro', telefono: '963578444', cuentas });
  assert.equal(r.s, 201, JSON.stringify(r.b));
  limpiar.push(`DELETE FROM core.proveedor WHERE id = '${r.b.id}'`);
  const l = (await api(adm, 'GET', '/proveedores')).b.find((x) => x.id === r.b.id);
  assert.deepEqual(l.cuentas.map((c) => `${c.banco} ${c.numero}`), ['BCP 125544548888', 'BBVA 4454-5454-45454-4545']);
  assert.equal(l.ruc, '');
  assert.equal((await api(adm, 'PATCH', `/proveedores/${r.b.id}`, { razonSocial: 'Plaza prueba ' + sufijo, cuentas: [{ banco: 'NOEXISTE', numero: '123456' }] })).s, 422, 'banco fuera del catálogo');
  assert.equal((await api(adm, 'PATCH', `/proveedores/${r.b.id}`, { razonSocial: 'Plaza prueba ' + sufijo, cuentas: [cuentas[0]] })).s, 200);
  assert.equal(sql(`SELECT count(*) FROM core.proveedor_cuenta WHERE proveedor_id = '${r.b.id}'`), '1', 'las cuentas se reemplazan');
});

test('presentación de venta: paquete x 6 con SKU y precio propio; descuenta 6 panes y 1 bolsa; anular devuelve ambos', async () => {
  const adm = await login('lbermudez');
  // Bolsa (empaque) con stock y presentación de venta que la descarga.
  const bolsa = sql(`WITH i AS (INSERT INTO core.insumo (codigo, nombre, unidad, unidad_inventario, cpp, stock, minimo) VALUES ('BOL-${sufijo}', 'Bolsa 5x10 ${sufijo}', 'UNIDAD', 'UNIDAD', 0.1, 10, 0) RETURNING id) SELECT id FROM i`);
  limpiar.push(`DELETE FROM core.movimiento_inventario WHERE insumo_id = '${bolsa}'; DELETE FROM core.lote_insumo WHERE insumo_id = '${bolsa}'`);
  const pres = 'P6' + sufijo;
  const c = await api(adm, 'POST', '/catalogos/presentaciones-venta', { codigo: pres, nombre: 'Paquete x 6 ' + sufijo, equivalencia: 6, insumoId: bolsa, cantidadInsumo: 1 });
  assert.equal(c.s, 201, JSON.stringify(c.b));
  assert.equal((await api(adm, 'POST', '/catalogos/presentaciones-venta', { codigo: 'X' + pres, nombre: 'Mala', equivalencia: 2, insumoId: bolsa })).s, 422, 'insumo sin cantidad');

  const prod = sql('SELECT id FROM core.producto WHERE stock >= 20 AND insumo_id IS NULL AND estado = \'ACTIVO\' ORDER BY nombre LIMIT 1');
  assert.ok(prod, 'hay un pan con stock en los datos de prueba');
  const p = (await api(adm, 'GET', '/datos')).b.productos.find((x) => x.id === prod);
  const ficha = { nombre: p.nombre, categoriaId: p.categoriaId, unidad: p.unidad, precioConIgv: p.precioConIgv, estado: 'ACTIVO' };
  const skuPaq = '77' + nroUnico();
  limpiar.push(`DELETE FROM core.producto_presentacion WHERE producto_id = '${prod}'; UPDATE core.producto SET sku = NULL WHERE id = '${prod}'`);
  const e = await api(adm, 'PATCH', `/productos/${prod}`, { ...ficha, sku: '10' + nroUnico(), presentaciones: [{ presentacion: pres, sku: skuPaq, precioConIgv: 48 }] });
  assert.equal(e.s, 200, JSON.stringify(e.b));
  // El SKU no se repite en otro producto.
  const otro = sql(`SELECT id FROM core.producto WHERE id <> '${prod}' AND insumo_id IS NULL ORDER BY nombre LIMIT 1`);
  const o = (await api(adm, 'GET', '/datos')).b.productos.find((x) => x.id === otro);
  const rep = await api(adm, 'PATCH', `/productos/${otro}`, { nombre: o.nombre, categoriaId: o.categoriaId, unidad: o.unidad, precioConIgv: o.precioConIgv, estado: o.estado, sku: skuPaq });
  assert.equal(rep.s, 409, JSON.stringify(rep.b));

  const stock0 = valor(`SELECT stock FROM core.producto WHERE id = '${prod}'`);
  const bolsas0 = valor(`SELECT stock FROM core.insumo WHERE id = '${bolsa}'`);
  const v = await api(await login('cmedina'), 'POST', '/ventas', { items: [{ productoId: prod, cantidad: 2, presentacion: pres }], formaPago: 'EFECTIVO' });
  assert.equal(v.s, 201, JSON.stringify(v.b));
  assert.equal(valor(`SELECT stock FROM core.producto WHERE id = '${prod}'`), stock0 - 12, '2 paquetes x 6 = 12 panes');
  assert.equal(valor(`SELECT stock FROM core.insumo WHERE id = '${bolsa}'`), bolsas0 - 2, 'una bolsa por paquete');
  assert.equal(valor(`SELECT total_con_igv FROM core.venta WHERE codigo = '${v.b.codigo}'`), 96, '2 × S/ 48');
  assert.equal(sql(`SELECT presentacion_codigo || '|' || cantidad_presentacion::int || '|' || cantidad::int FROM core.venta_detalle d JOIN core.venta v ON v.id = d.venta_id WHERE v.codigo = '${v.b.codigo}'`), `${pres}|2|12`);
  // Más bolsas que las que hay: la venta no pasa.
  const sin = await api(await login('cmedina'), 'POST', '/ventas', { items: [{ productoId: prod, cantidad: 1, presentacion: pres }], formaPago: 'EFECTIVO' });
  if (bolsas0 - 2 < 1) assert.equal(sin.s, 409);
  else if (sin.s === 201) await api(await login('lbermudez'), 'POST', `/ventas/${sin.b.codigo}/anular`, { motivo: 'Prueba de empaque' });

  const an = await api(await login('lbermudez'), 'POST', `/ventas/${v.b.codigo}/anular`, { motivo: 'Prueba de presentaciones' });
  assert.equal(an.s, 200, JSON.stringify(an.b));
  assert.equal(valor(`SELECT stock FROM core.producto WHERE id = '${prod}'`), stock0, 'los panes vuelven');
  assert.equal(valor(`SELECT stock FROM core.insumo WHERE id = '${bolsa}'`), bolsas0, 'las bolsas vuelven');
  limpiar.push(`UPDATE core.presentacion_venta SET activo = false WHERE codigo = '${pres}'`);
});

test('ajustar precio y anular producto: el anulado no se vende', async () => {
  const adm = await login('lbermudez');
  const cat = sql('SELECT id FROM core.categoria ORDER BY orden LIMIT 1');
  const a = await api(adm, 'POST', '/productos', { nombre: 'Pan anular ' + sufijo, categoriaId: cat, unidad: 'UNIDAD', precioConIgv: 2 });
  assert.equal(a.s, 201, JSON.stringify(a.b));
  limpiar.push(`DELETE FROM core.receta WHERE producto_id = '${a.b.id}'; DELETE FROM core.producto WHERE id = '${a.b.id}'`);
  const pr = await api(adm, 'PATCH', `/productos/${a.b.id}/precios`, { precioConIgv: 2.5 });
  assert.equal(pr.s, 200, JSON.stringify(pr.b));
  assert.equal(valor(`SELECT precio_con_igv FROM core.producto WHERE id = '${a.b.id}'`), 2.5);
  assert.equal(sql(`SELECT count(*) FROM audit.evento WHERE accion = 'PRECIO_AJUSTADO' AND entidad_id = '${a.b.id}'`), '1', 'queda auditado');
  assert.equal((await api(adm, 'PATCH', `/productos/${a.b.id}/precios`, { precioConIgv: 2, presentaciones: [{ presentacion: 'NOEXISTE', precioConIgv: 5 }] })).s, 422);
  assert.equal((await api(adm, 'PATCH', `/productos/${a.b.id}/estado`, { estado: 'INACTIVO' })).s, 200);
  sqlScript(`UPDATE core.producto SET stock = 5 WHERE id = '${a.b.id}'`);
  const v = await api(await login('cmedina'), 'POST', '/ventas', { items: [{ productoId: a.b.id, cantidad: 1 }], formaPago: 'EFECTIVO' });
  assert.equal(v.s, 404, 'un producto anulado no se vende');
  sqlScript(`UPDATE core.producto SET stock = 0 WHERE id = '${a.b.id}'`);
});

test('insumo: costo para fórmulas manual; la compra no lo cambia, sale en el informe y «Actualizar» lo fija', async () => {
  const adm = await login('lbermudez');
  const ger = await login('superadmin');
  assert.equal((await api(ger, 'PATCH', '/parametros/costo_insumo_formulas', { valor: 'MANUAL' })).s, 200);
  const r = await api(adm, 'POST', '/insumos', { codigo: 'har-' + sufijo, nombre: 'Harina prueba ' + sufijo, tipo: 'HARINA', unidad: 'KG', minimo: 0, proveedor: '',
    presentacionCodigo: 'SACO50', precioCompra: 100 });
  assert.equal(r.s, 201, JSON.stringify(r.b));
  assert.equal(r.b.codigo, 'HAR-' + sufijo, 'código manual en mayúsculas');
  assert.equal(r.b.cantPresentacion, 50, 'el saco trae 50 kg (catálogo)');
  assert.equal(r.b.presentacion, 'Saco x 50 kg');
  assert.equal((await api(adm, 'POST', '/insumos', { codigo: 'HAR-' + sufijo, nombre: 'Otra ' + sufijo, unidad: 'KG', minimo: 0, proveedor: '' })).s, 409, 'código repetido');
  const id = r.b.id;
  assert.equal(valor(`SELECT cpp FROM core.insumo WHERE id = '${id}'`), 2, 'costo inicial = 100 ÷ 50');

  // Compra a S/ 150 el saco (sin IGV, guía): el kárdex sube a 3, las fórmulas siguen en 2.
  const k = await compras.comprar([{ insumoId: id, cantidad: 1, precioUnitario: 150 }]);
  assert.ok(k.codigo);
  assert.equal(valor(`SELECT cpp FROM core.insumo WHERE id = '${id}'`), 3);
  assert.equal(valor(`SELECT costo_formula FROM core.insumo WHERE id = '${id}'`), 2, 'MANUAL: la compra no cambia el costo de las fórmulas');
  const inf = await api(adm, 'GET', '/insumos/variacion-costos');
  const fila = inf.b.find((x) => x.id === id);
  assert.ok(fila, 'sale en el informe de variación');
  assert.equal(fila.costoActual, 2);
  assert.equal(fila.costoSugerido, 3);
  assert.ok(Math.abs(fila.variacion - 0.5) < 1e-9, '+50 %');
  const det = await api(adm, 'GET', `/insumos/${id}/costos`);
  assert.equal(det.s, 200);
  assert.equal(det.b.compras.length, 1);
  assert.equal(det.b.precioActual, 3);

  const act = await api(adm, 'POST', `/insumos/${id}/costo`, { costo: 3 });
  assert.equal(act.s, 200, JSON.stringify(act.b));
  assert.equal(valor(`SELECT costo_formula FROM core.insumo WHERE id = '${id}'`), 3);
  assert.equal(sql(`SELECT count(*) FROM core.ajuste_costo_insumo WHERE insumo_id = '${id}'`), '1', 'historial del ajuste');
  assert.ok(!(await api(adm, 'GET', '/insumos/variacion-costos')).b.some((x) => x.id === id), 'ya no varía');
  // Anular (inactivar) y reactivar.
  assert.equal((await api(adm, 'PATCH', `/insumos/${id}/estado`, { activo: false })).s, 200);
  assert.equal(sql(`SELECT activo FROM core.insumo WHERE id = '${id}'`), 'f');
  assert.equal((await api(adm, 'PATCH', `/insumos/${id}/estado`, { activo: true })).s, 200);
  // AUTOMATICO: las fórmulas vuelven a seguir al kárdex.
  assert.equal((await api(ger, 'PATCH', '/parametros/costo_insumo_formulas', { valor: 'AUTOMATICO' })).s, 200);
  assert.equal(sql(`SELECT costo_formula IS NULL FROM core.insumo WHERE id = '${id}'`), 't');
  assert.equal((await api(ger, 'PATCH', '/parametros/costo_insumo_formulas', { valor: 'MANUAL' })).s, 200);
});

test('compras: nota de pedido sin serie, crédito exige vencimiento y factura con detalle sin IGV', async () => {
  const prov = await compras.proveedor();
  const ins = sql(`WITH i AS (INSERT INTO core.insumo (codigo, nombre, unidad, cpp, stock, minimo) VALUES ('T-${sufijo}-C', 'Insumo prueba compras ${sufijo}', 'KG', 1, 0, 0) RETURNING id) SELECT id FROM i`);
  const ps = await login('psalas');
  const base = { proveedorId: prov, fechaCompra: hoyLima(), items: [{ insumoId: ins, cantidad: 10, precioUnitario: 10 }] };
  const nota = await api(ps, 'POST', '/compras', { ...base, docTipo: 'NOTA_PEDIDO', serie: '', nro: nroUnico() });
  assert.equal(nota.s, 201, JSON.stringify(nota.b));
  assert.match(nota.b.documento, /^NOTA PEDIDO \d+$/, 'sin serie, el documento es solo el número');
  assert.equal(nota.b.condicion, 'CONTADO');
  const cred = await api(ps, 'POST', '/compras', { ...base, docTipo: 'BOLETA', serie: 'B001', nro: nroUnico(), condicion: 'CREDITO' });
  assert.equal(cred.s, 422, 'crédito sin fecha de vencimiento');
  const sinIgv = await api(ps, 'POST', '/compras', { ...base, docTipo: 'FACTURA', serie: 'F001', nro: nroUnico(), condicion: 'CREDITO', vencePago: hoyLima(), preciosConIgv: false });
  assert.equal(sinIgv.s, 201, JSON.stringify(sinIgv.b));
  assert.equal(sinIgv.b.base, 100, 'el detalle sin IGV es la base');
  assert.equal(sinIgv.b.total, 118, 'el total suma el IGV');
  assert.equal(sinIgv.b.items[0].costoInventario, 10, 'el costo del insumo no se divide otra vez entre 1.18');
  const ant = await api(ps, 'GET', '/compras/precios-anteriores');
  assert.equal(ant.b[ins].precio, 10, 'precio anterior para el icono sube/baja');
});

test('pagos de costos: caja grande con n.° de operación; caja chica descuenta su saldo; anular devuelve el dinero', async () => {
  const adm = await login('lbermudez');
  const cif = sql("SELECT id FROM core.costo_indirecto WHERE activo ORDER BY codigo LIMIT 1");
  const ahora = new Date(Date.now() - 5 * 3_600_000);
  const base = { costoIndirectoId: cif, fechaOperacion: hoyLima(), periodoMes: ahora.getUTCMonth() + 1, periodoAnio: ahora.getUTCFullYear(), monto: 50 };
  assert.equal((await api(adm, 'POST', '/pagos-costos', { ...base, caja: 'GRANDE', medio: 'TRANSFERENCIA' })).s, 422, 'transferencia sin n.° de operación');
  const g = await api(adm, 'POST', '/pagos-costos', { ...base, caja: 'GRANDE', medio: 'TRANSFERENCIA', nroOperacion: 'OP-' + sufijo });
  assert.equal(g.s, 201, JSON.stringify(g.b));
  limpiar.push(`DELETE FROM core.pago_costo WHERE codigo = '${g.b.codigo}'`);
  assert.equal((await api(await login('psalas'), 'POST', '/pagos-costos', { ...base, caja: 'GRANDE', medio: 'EFECTIVO' })).s, 403, 'Compras no paga costos');

  // Caja chica propia de esta prueba.
  sqlScript(`UPDATE core.caja_apertura SET estado = 'CERRADA', cerrada_en = now(), monto_contado = 0, observacion = 'Cierre por prueba' WHERE estado = 'ABIERTA';`);
  assert.equal((await api(adm, 'POST', '/pagos-costos', { ...base, caja: 'CHICA', medio: 'EFECTIVO' })).s, 409, 'sin caja chica abierta');
  const a = await api(await login('cmedina'), 'POST', '/cajas/chica/abrir', { montoInicial: 100 });
  assert.equal(a.s, 201, JSON.stringify(a.b));
  const c = await api(adm, 'POST', '/pagos-costos', { ...base, caja: 'CHICA', medio: 'EFECTIVO', monto: 30 });
  assert.equal(c.s, 201, JSON.stringify(c.b));
  limpiar.push(`DELETE FROM core.pago_costo WHERE codigo = '${c.b.codigo}'`);
  assert.equal((await api(adm, 'GET', '/cajas/chica')).b.abierta.saldo, 70, 'la caja chica baja con el pago de costos');
  assert.equal((await api(adm, 'POST', '/pagos-costos', { ...base, caja: 'CHICA', medio: 'EFECTIVO', monto: 80 })).s, 422, 'no supera el saldo');
  assert.equal((await api(adm, 'POST', `/pagos-costos/${c.b.codigo}/anular`, { motivo: 'Prueba de anulación' })).s, 200);
  assert.equal((await api(adm, 'GET', '/cajas/chica')).b.abierta.saldo, 100, 'el dinero vuelve a la caja');
  const lista = (await api(adm, 'GET', `/pagos-costos?anio=${base.periodoAnio}&mes=${base.periodoMes}`)).b;
  assert.ok(lista.some((p) => p.codigo === g.b.codigo && p.estado === 'VIGENTE'));
  sqlScript(`UPDATE core.caja_apertura SET estado = 'CERRADA', cerrada_en = now(), monto_contado = 100, observacion = 'Cierre por prueba' WHERE codigo = '${a.b.codigo}';`);
});
