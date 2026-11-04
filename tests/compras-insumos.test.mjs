// node --test tests/compras-insumos.test.mjs  (API en 127.0.0.1:3001 con la semilla)
// Compra de insumos (Informe de Análisis v1.1): criterios de aceptación 1 a 7 y 10, roles y alertas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql, sqlScript } from './_sql.mjs';
import { flujoCompras, hoyLima, nroUnico, ANULAR_COMPRAS_DE_PRUEBA } from './_compras.mjs';

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
const cerca = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const stock = (id) => Number(sql(`SELECT stock FROM core.insumo WHERE id = '${id}'`));

const { proveedor, registrar, verificar } = flujoCompras(api, login);
const sufijo = randomUUID().slice(0, 6).toUpperCase();
let compras, almacen, admin, aceite, harina, prov;

before(async () => {
  [compras, almacen, admin] = await Promise.all(['psalas', 'jramos', 'lbermudez'].map(login));
  prov = await proveedor();
  // Ficha del aceite del informe: botella de 0.9 L, unidad base L, inventario en kg, densidad 0.917 kg/L.
  const a = await api(compras, 'POST', '/insumos', { nombre: `Aceite vegetal ${sufijo}`, unidad: 'L', unidadInventario: 'KG', equivKg: 0.917,
    minimo: 0, proveedor: '', tipo: 'GRASA', presentacion: 'Botella 900 ml', cantPresentacion: 0.9, precioCompra: null });
  assert.equal(a.s, 201, JSON.stringify(a.b));
  aceite = a.b.id;
  const h = await api(compras, 'POST', '/insumos', { nombre: `Harina ${sufijo}`, unidad: 'KG', minimo: 0, proveedor: '', tipo: 'HARINA', presentacion: 'Saco 50 kg', cantPresentacion: 50, equivKg: 1 });
  assert.equal(h.s, 201, JSON.stringify(h.b));
  harina = h.b.id;
});

test('criterio 4 / RN-03: un insumo en litros con stock en kg sin densidad se rechaza', async () => {
  const r = await api(compras, 'POST', '/insumos', { nombre: `Aceite sin densidad ${sufijo}`, unidad: 'L', unidadInventario: 'KG', minimo: 0, proveedor: '', presentacion: 'Botella', cantPresentacion: 0.9 });
  assert.equal(r.s, 422);
  assert.match(r.b.detail, /densidad/);
  // Misma familia no necesita densidad: litros con stock en mililitros.
  assert.equal((await api(compras, 'POST', '/insumos', { nombre: `Esencia ${sufijo}`, unidad: 'L', unidadInventario: 'ML', minimo: 0, proveedor: '' })).s, 201);
});

test('criterio 1 / F1 F2 F3: 6 botellas de 900 ml a S/ 8.50 = 5.4 L = 4.9518 kg a S/ 10.2993 por kg; el stock entra al verificar', async () => {
  const r = await registrar(prov, [{ insumoId: aceite, cantidad: 6, precioUnitario: 8.5 }]);
  assert.equal(r.s, 201, JSON.stringify(r.b));
  assert.equal(r.b.estado, 'REGISTRADA');
  const l = r.b.items[0];
  cerca(l.cantidadBase, 5.4, 1e-9, 'F1 cantidad base');
  cerca(l.cantidadInventario, 4.9518, 1e-9, 'F2 cantidad de inventario');
  cerca(l.costoInventario, 10.2993, 0.0001, 'F3 costo por kg');
  assert.equal(l.precioLote, 51, 'precio de lote = 6 × 8.50');
  assert.equal(stock(aceite), 0, 'RN-06: registrada no ingresa stock');
  const ver = await verificar(r.b);
  assert.equal(ver.b.estado, 'VERIFICADA');
  cerca(stock(aceite), 4.9518, 1e-9, 'el inventario aumenta en 4.9518 kg');
  cerca(Number(sql(`SELECT cpp FROM core.insumo WHERE id = '${aceite}'`)), 10.2993, 0.0001, 'RN-13: costo del insumo');
  assert.equal(sql(`SELECT unidad_inventario FROM core.insumo WHERE id = '${aceite}'`), 'KG', 'el stock se lleva en kg');
  // RN-04: las cantidades convertidas quedan guardadas aunque cambie la densidad después.
  sqlScript(`UPDATE core.insumo SET equiv_kg = 0.92 WHERE id = '${aceite}';`);
  const guardada = (await api(compras, 'GET', '/compras')).b.find((c) => c.codigo === r.b.codigo).items[0];
  cerca(guardada.cantidadInventario, 4.9518, 1e-9, 'la compra ya registrada no cambia');
  sqlScript(`UPDATE core.insumo SET equiv_kg = 0.917 WHERE id = '${aceite}';`);
});

test('criterio 2 / F4: una receta de 200 ml de aceite descuenta 0.1834 kg y el stock queda en 4.7684 kg', async () => {
  const pro = await login('rquispe');
  const productoId = sql(`WITH p AS (INSERT INTO core.producto (codigo, nombre, categoria_id, precio_con_igv, estado, peso_masa_g, perdida_coccion, horas_hombre_lote, horas_horno_lote)
    SELECT 'TF-${sufijo}', 'Pan francés prueba ${sufijo}', id, 0.35, 'ACTIVO', 55, 0, 0, 0 FROM core.categoria ORDER BY orden LIMIT 1 RETURNING id) SELECT id FROM p`);
  const rec = await api(await login('superadmin'), 'PUT', `/recetas/${productoId}`, { rendimiento: 10, mermaEstandar: 0, lineas: [{ insumoId: aceite, cantidad: 200, unidad: 'ML' }] });
  assert.equal(rec.s, 200, JSON.stringify(rec.b));
  // Un lote completo: la orden pide la receta una vez.
  const req = await api(pro, 'GET', `/produccion/requerimiento?productoId=${productoId}&cantidad=1&criterio=LOTES_COMPLETOS`);
  assert.equal(req.s, 200, JSON.stringify(req.b));
  assert.equal(req.b.lotes, 1);
  const lineaAceite = req.b.insumos[0];
  cerca(lineaAceite.necesario, 0.1834, 1e-9, 'F4 salida en kg');
  assert.equal(lineaAceite.unidad, 'KG', 'producción descuenta en unidad de inventario');
  cerca(lineaAceite.costo, 1.89, 0.005, 'costo del aceite en la salida');
  // Producción real: la orden genera la requisición y Almacén entrega lo pedido.
  const op = await api(pro, 'POST', '/ordenes-produccion', { productoId, cantidad: 1, entrega: hoyLima(), criterio: 'LOTES_COMPLETOS' });
  assert.equal(op.s, 201, JSON.stringify(op.b));
  const r = (await api(almacen, 'GET', '/requisiciones')).b.find((x) => x.op === op.b.codigo);
  const at = await api(almacen, 'POST', `/requisiciones/${r.codigo}/atender`, { lineas: r.lineas.map((l) => ({ insumoId: l.insumoId, cantidad: l.solicitada })) });
  assert.equal(at.s, 200, JSON.stringify(at.b));
  cerca(stock(aceite), 4.7684, 1e-9, 'stock resultante');
  sqlScript(`UPDATE core.producto SET estado = 'INACTIVO' WHERE id = '${productoId}';`);
});

test('criterio 3: 4 sacos de harina de 50 kg ingresan 200 kg; una receta de 10 kg descuenta 10 kg', async () => {
  const r = await registrar(prov, [{ insumoId: harina, cantidad: 4, precioUnitario: 140 }]);
  assert.equal(r.s, 201, JSON.stringify(r.b));
  assert.equal(r.b.items[0].cantidadInventario, 200);
  cerca(r.b.items[0].costoInventario, 2.8, 1e-9, 'RN-01: S/ 140 el saco = S/ 2.80 por kg');
  assert.equal((await verificar(r.b)).b.estado, 'VERIFICADA');
  assert.equal(stock(harina), 200);
  assert.equal(Number(sql(`SELECT core.factor_inventario('${harina}') * 10`)), 10, 'F4 con factor 1');
});

test('criterio 5 / RN-05: documento duplicado rechazado, también con espacios y minúsculas', async () => {
  const nro = nroUnico();
  const base = { docTipo: 'FACTURA', serie: 'F001', nro };
  const a = await registrar(prov, [{ insumoId: harina, cantidad: 1, precioUnitario: 140 }], base);
  assert.equal(a.s, 201, JSON.stringify(a.b));
  const dup = await registrar(prov, [{ insumoId: harina, cantidad: 1, precioUnitario: 140 }], { ...base, serie: ' f001 ' });
  assert.equal(dup.s, 409);
  assert.match(dup.b.detail, /ya está registrado/);
  assert.ok(a.b.base > 0 && Math.abs(a.b.base + a.b.igv - a.b.total) < 0.011, 'factura: base + IGV = total');
  assert.equal((await registrar(prov, [{ insumoId: harina, cantidad: 1, precioUnitario: 1 }], { fechaCompra: '2999-01-01' })).s, 422, 'la fecha no puede ser futura');
  // Anulada la primera, el número se puede volver a usar (único entre las no anuladas).
  assert.equal((await api(admin, 'POST', `/compras/${a.b.codigo}/anular`, { motivo: 'Documento mal digitado' })).s, 200);
  assert.equal((await registrar(prov, [{ insumoId: harina, cantidad: 1, precioUnitario: 140 }], base)).s, 201);
});

test('criterios 6 y 7: observada sin stock y con alerta; corrección autorizada; vuelve a verificar e ingresa lo corregido', async () => {
  const r = await registrar(prov, [{ insumoId: aceite, cantidad: 6, precioUnitario: 8.5 }]);
  const antes = stock(aceite);
  assert.equal((await verificar(r.b, { 1: [5, ''] })).s, 422, 'una diferencia exige motivo');
  const obs = await verificar(r.b, { 1: [5, 'Llegó una botella menos'] });
  assert.equal(obs.b.estado, 'OBSERVADA');
  assert.equal(stock(aceite), antes, 'observada no ingresa stock');
  let alerta = null;
  for (let i = 0; i < 20 && !alerta; i++) {
    alerta = (await api(admin, 'GET', '/notificaciones')).b.avisos.find((a) => a.titulo === `Compra ${r.b.codigo} observada`);
    if (!alerta) await new Promise((ok) => setTimeout(ok, 500));
  }
  assert.ok(alerta, 'Administración recibe la alerta');
  assert.match(alerta.cuerpo, /5 contadas/);

  const cuerpo = (cant) => ({ proveedorId: prov, docTipo: 'GUIA', serie: 'G001', nro: r.b.nro, fechaCompra: hoyLima(), items: [{ insumoId: aceite, cantidad: cant, precioUnitario: 8.5 }] });
  assert.equal((await api(compras, 'PUT', `/compras/${r.b.codigo}`, cuerpo(5))).s, 409, 'RN-08: sin autorización no se corrige');
  assert.equal((await api(compras, 'POST', `/compras/${r.b.codigo}/autorizar-correccion`)).s, 403, 'solo Administración autoriza');
  assert.equal((await api(admin, 'POST', `/compras/${r.b.codigo}/autorizar-correccion`)).s, 200);
  const corr = await api(compras, 'PUT', `/compras/${r.b.codigo}`, cuerpo(5));
  assert.equal(corr.s, 200, JSON.stringify(corr.b));
  assert.equal(corr.b.estado, 'REGISTRADA', 'vuelve a verificación');
  assert.equal((await verificar(corr.b)).b.estado, 'VERIFICADA');
  cerca(stock(aceite), antes + 5 * 0.9 * 0.917, 1e-9, 'ingresa la cantidad corregida');
});

test('criterio 10 / RN-09: anular una verificada revierte el inventario y el costo, con motivo, usuario y fecha', async () => {
  const id = sql(`WITH i AS (INSERT INTO core.insumo (codigo, nombre, unidad, cpp, stock, minimo) VALUES ('T-${sufijo}-AN', 'Insumo prueba anulación', 'KG', 2, 10, 0) RETURNING id) SELECT id FROM i`);
  sql('SELECT core.cuadrar_lotes()');
  const r = await registrar(prov, [{ insumoId: id, cantidad: 10, precioUnitario: 4 }]);
  await verificar(r.b);
  assert.equal(stock(id), 20);
  cerca(Number(sql(`SELECT cpp FROM core.insumo WHERE id = '${id}'`)), 3, 1e-9, 'CPP (10·2 + 10·4) / 20');
  assert.equal((await api(compras, 'POST', `/compras/${r.b.codigo}/anular`, { motivo: 'Error de digitación' })).s, 403, 'solo Administración anula');
  assert.equal((await api(admin, 'POST', `/compras/${r.b.codigo}/anular`, { motivo: 'x' })).s, 422, 'motivo obligatorio');
  const an = await api(admin, 'POST', `/compras/${r.b.codigo}/anular`, { motivo: 'Factura de otro proveedor' });
  assert.equal(an.s, 200, JSON.stringify(an.b));
  assert.equal(stock(id), 10, 'reversa del inventario');
  cerca(Number(sql(`SELECT cpp FROM core.insumo WHERE id = '${id}'`)), 2, 1e-9, 'el costo vuelve al de antes');
  assert.equal(sql(`SELECT tipo || ' ' || cantidad::numeric(10,2) FROM core.movimiento_inventario WHERE insumo_id = '${id}' ORDER BY id DESC LIMIT 1`), 'REVERSA_COMPRA -10.00');
  const fila = (await api(admin, 'GET', '/compras?estado=ANULADA')).b.find((c) => c.codigo === r.b.codigo);
  assert.equal(fila.motivoAnulacion, 'Factura de otro proveedor');
  assert.equal(fila.anuladoPor, 'Lucía Bermúdez');
  assert.ok(fila.anuladoEn);
  assert.equal((await api(admin, 'POST', `/compras/${r.b.codigo}/anular`, { motivo: 'Otra vez más' })).s, 409, 'no se anula dos veces');
});

test('anular una compra anterior a la verificación (sin lote enlazado) mantiene lotes y stock iguales', async () => {
  const id = sql(`WITH i AS (INSERT INTO core.insumo (codigo, nombre, unidad, cpp, stock, minimo) VALUES ('T-${sufijo}-LG', 'Insumo prueba anulación', 'KG', 1, 0, 0) RETURNING id) SELECT id FROM i`);
  const r = await registrar(prov, [{ insumoId: id, cantidad: 5, precioUnitario: 2 }]);
  await verificar(r.b);
  // Así quedaron las compras registradas antes de la Fase 10: sin el movimiento (y su lote) enlazado.
  sqlScript(`UPDATE core.compra_detalle SET movimiento_id = NULL WHERE compra_id = (SELECT id FROM core.compra WHERE codigo = '${r.b.codigo}');`);
  assert.equal((await api(admin, 'POST', `/compras/${r.b.codigo}/anular`, { motivo: 'Compra antigua mal cargada' })).s, 200);
  assert.equal(stock(id), 0);
  assert.equal(Number(sql(`SELECT coalesce(sum(saldo), 0) FROM core.lote_insumo WHERE insumo_id = '${id}'`)), 0, 'los lotes bajan con el stock');
});

test('punto 7: no se anula una compra cuyo stock ya se usó', async () => {
  const id = sql(`WITH i AS (INSERT INTO core.insumo (codigo, nombre, unidad, cpp, stock, minimo) VALUES ('T-${sufijo}-US', 'Insumo prueba anulación', 'KG', 1, 0, 0) RETURNING id) SELECT id FROM i`);
  const r = await registrar(prov, [{ insumoId: id, cantidad: 10, precioUnitario: 1 }]);
  await verificar(r.b);
  assert.equal((await api(almacen, 'POST', '/inventario/movimientos', { tipo: 'MERMA', insumoId: id, cantidad: 3, motivo: 'Uso de prueba' })).s, 200);
  const an = await api(admin, 'POST', `/compras/${r.b.codigo}/anular`, { motivo: 'Intento de anulación' });
  assert.equal(an.s, 409);
  assert.match(an.b.detail, /ya se usaron 3/);
  assert.equal(stock(id), 7, 'no cambia nada');
});

test('Excel y PDF coinciden: CP-19 (RN-02) y RN-03 con la densidad del Excel dan lo mismo que F2 y F4', async () => {
  // CP-19 / RN-02 del Excel por el flujo del PDF: 120 kg a S/ 2.80 y compra verificada de 500 kg a S/ 2.95 → S/ 2.921.
  const id = sql(`WITH i AS (INSERT INTO core.insumo (codigo, nombre, unidad, cpp, stock, minimo) VALUES ('T-${sufijo}-CP', 'Insumo prueba anulación', 'KG', 2.80, 120, 0) RETURNING id) SELECT id FROM i`);
  sql('SELECT core.cuadrar_lotes()');
  const r = await registrar(prov, [{ insumoId: id, cantidad: 500, precioUnitario: 2.95 }], { docTipo: 'BOLETA', serie: 'B001' });
  await verificar(r.b);
  cerca(Number(sql(`SELECT cpp FROM core.insumo WHERE id = '${id}'`)), (120 * 2.80 + 500 * 2.95) / 620, 1e-6, 'CP-19');
  assert.equal(Number(sql(`SELECT cpp FROM core.insumo WHERE id = '${id}'`)).toFixed(2), '2.92');
  // RN-03 del Excel (peso de la receta) y F4 del PDF (salida a inventario) usan la misma densidad: con 0.92, 200 ml = 0.184 kg.
  const aceite = await api(compras, 'POST', '/insumos', { nombre: `Aceite Excel ${sufijo}`, unidad: 'L', unidadInventario: 'KG', equivKg: 0.92, minimo: 0, proveedor: '', tipo: 'GRASA' });
  assert.equal(aceite.s, 201, JSON.stringify(aceite.b));
  const prod = sql(`WITH p AS (INSERT INTO core.producto (codigo, nombre, categoria_id, precio_con_igv, estado, peso_masa_g, perdida_coccion) SELECT 'TX-${sufijo}', 'Pan prueba Excel ${sufijo}', id, 1, 'INACTIVO', 50, 0 FROM core.categoria ORDER BY orden LIMIT 1 RETURNING id) SELECT id FROM p`);
  assert.equal((await api(await login('superadmin'), 'PUT', `/recetas/${prod}`, { rendimiento: 10, mermaEstandar: 0, lineas: [{ insumoId: aceite.b.id, cantidad: 200, unidad: 'ML' }] })).s, 200);
  cerca(Number(sql(`SELECT peso_kg FROM core.receta_detalle WHERE receta_id = '${prod}'`)), 0.184, 1e-9, 'RN-03 peso');
  cerca(Number(sql(`SELECT cantidad * core.factor_inventario(insumo_id) FROM core.receta_detalle WHERE receta_id = '${prod}'`)), 0.184, 1e-9, 'F4 salida');
});

test('sección 7 y alertas: cada rol hace lo suyo; Almacén recibe la compra por verificar sin ver precios', async () => {
  const r = await registrar(prov, [{ insumoId: harina, cantidad: 1, precioUnitario: 140 }]);
  assert.equal((await api(almacen, 'POST', '/compras', { proveedorId: prov, docTipo: 'GUIA', serie: 'G1', nro: nroUnico(), fechaCompra: hoyLima(), items: [{ insumoId: harina, cantidad: 1, precioUnitario: 1 }] })).s, 403, 'Almacén no registra');
  assert.equal((await api(compras, 'POST', `/compras/${r.b.codigo}/verificar`, { lineas: [{ item: 1, cantidadVerificada: 1 }] })).s, 403, 'Compras no verifica');
  assert.equal((await api(almacen, 'POST', '/inventario/movimientos', { tipo: 'COMPRA', insumoId: harina, cantidad: 1, costoUnitario: 1, motivo: 'Directo' })).s, 422, 'RN-06: sin ingreso directo');
  let aviso = null;
  for (let i = 0; i < 20 && !aviso; i++) {
    aviso = (await api(almacen, 'GET', '/notificaciones')).b.avisos.find((a) => a.titulo === `Compra ${r.b.codigo} por verificar`);
    if (!aviso) await new Promise((ok) => setTimeout(ok, 500));
  }
  assert.ok(aviso, 'Almacén recibe la compra por verificar');
  const vista = (await api(almacen, 'GET', '/compras?estado=REGISTRADA')).b.find((c) => c.codigo === r.b.codigo);
  assert.equal(vista.items[0].precioUnitario, undefined, 'Almacén cuenta cantidades, no ve precios');
  assert.equal((await api(await login('cmedina'), 'GET', '/compras')).s, 403, 'el vendedor no ve compras');
});

after(() => sqlScript(`${ANULAR_COMPRAS_DE_PRUEBA}
  UPDATE core.insumo SET activo = false WHERE nombre LIKE '%${sufijo}%' OR nombre = 'Insumo prueba anulación';
  UPDATE core.proveedor SET estado = 'INACTIVO' WHERE razon_social LIKE 'Proveedor prueba %';`));
