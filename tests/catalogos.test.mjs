// node tests/correr.mjs tests/catalogos.test.mjs
// Catálogos administrables (tipos de documento, medios de pago, tipos de insumo, unidades) y costo sin IGV en facturas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql, sqlScript } from './_sql.mjs';
import { flujoCompras, ANULAR_COMPRAS_DE_PRUEBA } from './_compras.mjs';

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

const { proveedor, registrar, verificar } = flujoCompras(api, login);
const sufijo = randomUUID().slice(0, 4).toUpperCase();
let admin, compras, vendedor, prov;
const nuevo = { medio: `QA_MEDIO_${sufijo}`, tipo: `QA_TIPO_${sufijo}`, unidad: `QA_LB_${sufijo}` };

before(async () => {
  [admin, compras, vendedor] = await Promise.all(['lbermudez', 'psalas', 'cmedina'].map(login));
  prov = await proveedor();
});

test('punto 4: con factura (crédito fiscal) el costo del insumo va sin IGV; con boleta, con IGV', async () => {
  const id = sql(`WITH i AS (INSERT INTO core.insumo (codigo, nombre, unidad, cpp, stock, minimo, presentacion, cant_presentacion) VALUES ('T-${sufijo}-IGV', 'Insumo prueba catálogo', 'KG', 0, 0, 0, 'Saco 50 kg', 50) RETURNING id) SELECT id FROM i`);
  const igv = Number(sql("SELECT valor FROM core.parametro WHERE clave = 'igv'"));
  const factura = await registrar(prov, [{ insumoId: id, cantidad: 1, precioUnitario: 165.2 }], { docTipo: 'FACTURA', serie: 'F001' });
  assert.equal(factura.s, 201, JSON.stringify(factura.b));
  cerca(factura.b.items[0].costoInventario, 165.2 / (1 + igv) / 50, 1e-6, 'S/ 165.20 con IGV el saco = S/ 2.80 por kg sin IGV');
  assert.equal(factura.b.items[0].sinIgv, true);
  assert.equal(factura.b.total, 165.2, 'la deuda con el proveedor es el total con IGV');
  cerca(factura.b.base + factura.b.igv, 165.2, 0.011, 'base + IGV = total');
  const boleta = await registrar(prov, [{ insumoId: id, cantidad: 1, precioUnitario: 165.2 }], { docTipo: 'BOLETA', serie: 'B001' });
  cerca(boleta.b.items[0].costoInventario, 165.2 / 50, 1e-6, 'la boleta no da crédito fiscal: el IGV es costo');
  assert.equal(boleta.b.base, null);
  await verificar(factura.b);
  cerca(Number(sql(`SELECT cpp FROM core.insumo WHERE id = '${id}'`)), 2.8, 1e-4, 'el costo promedio entra sin IGV');
});

test('medios de pago: el Administrador agrega uno y las ventas lo respetan (n.° de operación, desactivación)', async () => {
  assert.equal((await api(vendedor, 'POST', '/catalogos/medios-pago', { codigo: nuevo.medio, nombre: 'Billetera QA', enVentas: true })).s, 403, 'solo el Administrador');
  const r = await api(admin, 'POST', '/catalogos/medios-pago', { codigo: nuevo.medio, nombre: 'Billetera QA', requiereOperacion: true, enVentas: true, enCobranza: true });
  assert.equal(r.s, 201, JSON.stringify(r.b));
  assert.equal((await api(admin, 'POST', '/catalogos/medios-pago', { codigo: nuevo.medio, nombre: 'Otra' })).s, 409, 'código único');
  assert.ok((await api(vendedor, 'GET', '/catalogos')).b.mediosPago.some((m) => m.codigo === nuevo.medio), 'aparece en los formularios');
  const prod = sql('SELECT id FROM core.producto WHERE stock >= 5 ORDER BY nombre LIMIT 1');
  const venta = (extra) => api(vendedor, 'POST', '/ventas', { items: [{ productoId: prod, cantidad: 1 }], formaPago: nuevo.medio, ...extra });
  assert.equal((await venta({})).s, 422, 'exige n.° de operación por su atributo');
  assert.equal((await venta({ referenciaPago: 'QA-123' })).s, 201);
  assert.equal((await api(admin, 'PATCH', `/catalogos/medios-pago/${nuevo.medio}`, { nombre: 'Billetera QA', requiereOperacion: true, enVentas: true, enCobranza: true, activo: false })).s, 200);
  assert.equal((await venta({ referenciaPago: 'QA-124' })).s, 422, 'desactivado ya no se usa');
  assert.ok(!(await api(vendedor, 'GET', '/catalogos')).b.mediosPago.some((m) => m.codigo === nuevo.medio), 'ni se ofrece');
  assert.equal((await api(admin, 'POST', '/catalogos/medios-pago', { codigo: `QA_MAL_${sufijo}`, nombre: 'Crédito raro', esCredito: true, enCompras: true })).s, 422,
    'el crédito no paga proveedores');
  // Un medio sin uso en compras no se acepta al pagar a un proveedor (TARJETA viene así del catálogo inicial).
  const deuda = await registrar(prov, [{ insumoId: sql(`SELECT id FROM core.insumo WHERE codigo = 'T-${sufijo}-IGV'`), cantidad: 1, precioUnitario: 10 }]);
  await verificar(deuda.b);
  const pago = await api(admin, 'POST', `/compras/${deuda.b.codigo}/pagos`, { caja: 'GRANDE', medio: 'TARJETA', monto: 10, nroOperacion: 'POS-1' });
  assert.equal(pago.s, 422);
  assert.match(pago.b.detail, /no está habilitado para compras/);
});

test('tipos de insumo: el insumo usa los del catálogo', async () => {
  assert.equal((await api(compras, 'POST', '/insumos', { nombre: `Insumo tipo ${sufijo}`, unidad: 'KG', minimo: 0, proveedor: '', tipo: nuevo.tipo })).s, 422, 'tipo inexistente');
  assert.equal((await api(admin, 'POST', '/catalogos/tipos-insumo', { codigo: nuevo.tipo, nombre: 'Semillas QA' })).s, 201);
  const i = await api(compras, 'POST', '/insumos', { nombre: `Insumo tipo ${sufijo}`, unidad: 'KG', minimo: 0, proveedor: '', tipo: nuevo.tipo });
  assert.equal(i.s, 201, JSON.stringify(i.b));
});

test('unidades: una sola tabla; una unidad nueva convierte en recetas; la que está en uso no cambia de escala', async () => {
  assert.equal((await api(admin, 'POST', '/catalogos/unidades', { codigo: nuevo.unidad, descripcion: 'libra QA', familia: 'MASA', factorAPatron: 0.453592 })).s, 201);
  assert.equal(sql("SELECT to_regclass('core.unidad_conversion') IS NULL"), 't', 'ya no existe la tabla duplicada');
  const ins = sql(`WITH i AS (INSERT INTO core.insumo (codigo, nombre, unidad, cpp, stock, minimo) VALUES ('T-${sufijo}-LB', 'Insumo prueba catálogo', 'KG', 2, 0, 0) RETURNING id) SELECT id FROM i`);
  const prod = sql(`WITH p AS (INSERT INTO core.producto (codigo, nombre, categoria_id, precio_con_igv, estado, peso_masa_g, perdida_coccion) SELECT 'T-${sufijo}-P', 'Pan prueba catálogo', id, 1, 'INACTIVO', 50, 0 FROM core.categoria ORDER BY orden LIMIT 1 RETURNING id) SELECT id FROM p`);
  const rec = await api(await login('superadmin'), 'PUT', `/recetas/${prod}`, { rendimiento: 10, mermaEstandar: 0, lineas: [{ insumoId: ins, cantidad: 10, unidad: nuevo.unidad }] });
  assert.equal(rec.s, 200, JSON.stringify(rec.b));
  cerca(Number(sql(`SELECT cantidad FROM core.receta_detalle WHERE receta_id = '${prod}'`)), 4.53592, 1e-6, '10 lb = 4.53592 kg');
  assert.equal((await api(await login('superadmin'), 'PUT', `/recetas/${prod}`, { rendimiento: 10, mermaEstandar: 0, lineas: [{ insumoId: ins, cantidad: 1, unidad: 'L' }] })).s, 422, 'otra familia no se acepta');
  const cambio = await api(admin, 'PATCH', `/catalogos/unidades/${nuevo.unidad}`, { descripcion: 'libra QA', familia: 'MASA', factorAPatron: 0.5 });
  assert.equal(cambio.s, 409, 'en uso: no cambia su factor');
  assert.equal((await api(admin, 'PATCH', `/catalogos/unidades/${nuevo.unidad}`, { descripcion: 'libra (lb)', familia: 'MASA', factorAPatron: 0.453592 })).s, 200, 'la descripción sí');
});

test('tipos de documento: uno nuevo sin crédito fiscal se usa en compras; inactivo, ya no', async () => {
  const cod = `QA_DOC_${sufijo}`;
  assert.equal((await api(admin, 'POST', '/catalogos/tipos-documento', { codigo: cod, nombre: 'Recibo por honorarios QA' })).s, 201);
  const ins = sql(`SELECT id FROM core.insumo WHERE codigo = 'T-${sufijo}-IGV'`);
  assert.equal((await registrar(prov, [{ insumoId: ins, cantidad: 1, precioUnitario: 5 }], { docTipo: cod, serie: 'R001' })).s, 201);
  await api(admin, 'PATCH', `/catalogos/tipos-documento/${cod}`, { nombre: 'Recibo por honorarios QA', activo: false });
  assert.equal((await registrar(prov, [{ insumoId: ins, cantidad: 1, precioUnitario: 5 }], { docTipo: cod, serie: 'R002' })).s, 422);
});

after(() => sqlScript(`${ANULAR_COMPRAS_DE_PRUEBA}
  UPDATE core.insumo SET activo = false WHERE nombre IN ('Insumo prueba catálogo') OR nombre LIKE 'Insumo tipo QA%' OR codigo LIKE 'T-${sufijo}%' OR nombre = 'Insumo tipo ${sufijo}';
  UPDATE core.medio_pago SET activo = false WHERE codigo LIKE 'QA_%';
  UPDATE core.tipo_insumo SET activo = false WHERE codigo LIKE 'QA_%';
  UPDATE core.tipo_documento_compra SET activo = false WHERE codigo LIKE 'QA_%';
  UPDATE core.proveedor SET estado = 'INACTIVO' WHERE razon_social LIKE 'Proveedor prueba %';`));
