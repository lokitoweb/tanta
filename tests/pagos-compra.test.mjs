// node --test tests/pagos-compra.test.mjs  (API en 127.0.0.1:3001 con la semilla)
// Deudas por pagar y cajas (informe de compra de insumos v1.1): criterios 8 y 9, RN-09 a RN-13, permisos y avisos.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql, sqlScript } from './_sql.mjs';
import { flujoCompras, ANULAR_COMPRAS_DE_PRUEBA, fondearCajaGrande } from './_compras.mjs';

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

const { proveedor, registrar, verificar } = flujoCompras(api, login);
let admin, vendedor, compras, prov, insumoId;
// Caja chica del vendedor: cada usuario tiene la suya; Administración paga desde ella indicándola.
let cajaVen = '';
const cajaDe = async (t) => (await api(t, 'GET', '/cajas/chica')).b.abiertas.find((x) => x.codigo === cajaVen);

/** Compra verificada por `total` soles (1 línea), lista para pagar. */
const deuda = async (total) => {
  const r = await registrar(prov, [{ insumoId, cantidad: 1, precioUnitario: total }]);
  assert.equal(r.s, 201, JSON.stringify(r.b));
  assert.equal((await verificar(r.b)).b.estado, 'VERIFICADA');
  return r.b.codigo;
};
const pagar = (codigo, body) => api(admin, 'POST', `/compras/${codigo}/pagos`, body);
const estadoPago = (codigo) => sql(`SELECT estado_pago FROM core.compra WHERE codigo = '${codigo}'`);

before(async () => {
  [admin, vendedor, compras] = await Promise.all(['lbermudez', 'cmedina', 'psalas'].map(login));
  prov = await proveedor();
  insumoId = sql(`WITH i AS (INSERT INTO core.insumo (codigo, nombre, unidad, cpp, stock, minimo) VALUES ('T-${randomUUID().slice(0, 8).toUpperCase()}', 'Insumo prueba pagos', 'KG', 1, 0, 0) RETURNING id) SELECT id FROM i`);
  // Cada corrida empieza con la caja chica cerrada (otra prueba pudo dejarla abierta).
  sqlScript(`UPDATE core.caja_apertura SET estado = 'CERRADA', cerrada_en = now(), monto_contado = 0, observacion = 'Cierre por prueba' WHERE estado = 'ABIERTA';`);
  // El fondo de la caja chica y los pagos desde caja grande necesitan saldo en sus cuentas.
  fondearCajaGrande();
});

test('RN-11: sin caja chica abierta no se paga desde ella; el vendedor la abre una sola vez', async () => {
  const codigo = await deuda(100);
  const sin = await pagar(codigo, { caja: 'CHICA', medio: 'EFECTIVO', monto: 50 });
  assert.equal(sin.s, 409);
  assert.match(sin.b.detail, /no tienes una caja chica abierta/i);
  assert.equal((await api(compras, 'POST', '/cajas/chica/abrir', { montoInicial: 300 })).s, 403, 'Compras no abre caja');
  const a = await api(vendedor, 'POST', '/cajas/chica/abrir', { montoInicial: 300 });
  assert.equal(a.s, 201, JSON.stringify(a.b));
  cajaVen = a.b.codigo;
  assert.equal((await api(vendedor, 'POST', '/cajas/chica/abrir', { montoInicial: 100 })).s, 409, 'una caja chica abierta por persona');
  assert.equal((await api(vendedor, 'GET', '/cajas/chica')).b.abierta.saldo, 300);
});

test('criterio 8 / RN-10: deuda de S/ 1,200 pagada con S/ 200 de caja chica en efectivo y S/ 1,000 de caja grande por transferencia', async () => {
  const codigo = await deuda(1200);
  assert.equal(estadoPago(codigo), 'PENDIENTE');
  const chica = await pagar(codigo, { caja: 'CHICA', medio: 'EFECTIVO', monto: 200, aperturaCodigo: cajaVen });
  assert.equal(chica.s, 201, JSON.stringify(chica.b));
  assert.equal(chica.b.estadoPago, 'PARCIAL');
  assert.equal(chica.b.saldo, 1000);
  assert.equal((await pagar(codigo, { caja: 'GRANDE', medio: 'TRANSFERENCIA', monto: 1000 })).s, 422, 'RN-12: sin número de operación');
  const grande = await pagar(codigo, { caja: 'GRANDE', medio: 'TRANSFERENCIA', monto: 1000, nroOperacion: 'TR-778899' });
  assert.equal(grande.s, 201, JSON.stringify(grande.b));
  assert.equal(grande.b.saldo, 0, 'el saldo queda en cero');
  assert.equal(grande.b.estadoPago, 'PAGADO');
  const d = (await api(admin, 'GET', '/deudas-compra')).b.find((x) => x.codigo === codigo);
  assert.deepEqual([d.total, d.pagado, d.saldo, d.pagos.length], [1200, 1200, 0, 2]);
  assert.equal((await pagar(codigo, { caja: 'GRANDE', medio: 'EFECTIVO', monto: 1 })).s, 422, 'RN-13: no se paga de más');
});

test('criterio 9 / RN-11: un pago de caja chica mayor a su saldo disponible se rechaza', async () => {
  const caja = await cajaDe(admin);
  assert.equal(caja.saldo, 100, 'S/ 300 iniciales menos S/ 200 pagados');
  const codigo = await deuda(500);
  const r = await pagar(codigo, { caja: 'CHICA', medio: 'EFECTIVO', monto: 150, aperturaCodigo: cajaVen });
  assert.equal(r.s, 422);
  assert.match(r.b.detail, /solo tiene S\/ 100\.00 disponibles/);
  assert.equal((await pagar(codigo, { caja: 'CHICA', medio: 'YAPE', monto: 10, nroOperacion: 'YP-1', aperturaCodigo: cajaVen })).s, 422, 'la caja chica solo paga en efectivo');
  assert.equal((await pagar(codigo, { caja: 'CHICA', medio: 'EFECTIVO', monto: 100, aperturaCodigo: cajaVen })).s, 201, 'hasta el saldo sí');
  assert.equal((await cajaDe(admin)).saldo, 0);
});

test('RN-09: anular una compra pagada anula sus pagos y devuelve el dinero a la caja chica', async () => {
  const codigo = (await api(admin, 'GET', '/deudas-compra')).b.find((x) => x.pagos.some((p) => p.caja === 'CHICA' && p.monto === 100 && p.apertura === cajaVen)).codigo;
  const an = await api(admin, 'POST', `/compras/${codigo}/anular`, { motivo: 'Factura duplicada del proveedor' });
  assert.equal(an.s, 200, JSON.stringify(an.b));
  assert.equal(an.b.pagosAnulados, 1);
  assert.equal(sql(`SELECT string_agg(p.estado, ',') FROM core.pago_compra p JOIN core.compra k ON k.id = p.compra_id WHERE k.codigo = '${codigo}'`), 'ANULADO');
  assert.equal((await cajaDe(admin)).saldo, 100, 'el efectivo vuelve a la caja chica');
});

test('un pago mal registrado se anula con motivo y la compra vuelve a tener saldo', async () => {
  const codigo = await deuda(80);
  const p = await pagar(codigo, { caja: 'GRANDE', medio: 'YAPE', monto: 80, nroOperacion: 'YP-445566' });
  assert.equal(estadoPago(codigo), 'PAGADO');
  assert.equal((await api(admin, 'POST', `/pagos-compra/${p.b.codigo}/anular`, { motivo: 'x' })).s, 422);
  assert.equal((await api(admin, 'POST', `/pagos-compra/${p.b.codigo}/anular`, { motivo: 'Monto equivocado' })).s, 200);
  assert.equal(estadoPago(codigo), 'PENDIENTE');
  assert.equal((await api(admin, 'POST', `/pagos-compra/${p.b.codigo}/anular`, { motivo: 'Otra vez más' })).s, 409);
});

test('solo se paga una compra verificada; permisos de la sección 7', async () => {
  const r = await registrar(prov, [{ insumoId, cantidad: 1, precioUnitario: 10 }]);
  const sinVerificar = await pagar(r.b.codigo, { caja: 'GRANDE', medio: 'EFECTIVO', monto: 10 });
  assert.equal(sinVerificar.s, 409);
  await verificar(r.b);
  assert.equal((await api(compras, 'POST', `/compras/${r.b.codigo}/pagos`, { caja: 'GRANDE', medio: 'EFECTIVO', monto: 10 })).s, 403, 'Compras no paga');
  assert.equal((await api(compras, 'GET', '/deudas-compra')).s, 200, 'Compras consulta deudas');
  assert.equal((await api(await login('jramos'), 'GET', '/deudas-compra')).s, 403, 'Almacén no ve deudas');
  // Sección 8: Administración recibe la deuda por pagar al verificarse.
  let aviso = null;
  for (let i = 0; i < 20 && !aviso; i++) {
    aviso = (await api(admin, 'GET', '/notificaciones')).b.avisos.find((a) => a.titulo === `Deuda ${r.b.codigo} por pagar`);
    if (!aviso) await new Promise((ok) => setTimeout(ok, 500));
  }
  assert.ok(aviso, 'Administración recibe el aviso de la deuda');
});

test('cierre de caja chica con lo contado y su diferencia', async () => {
  const caja = (await api(vendedor, 'GET', '/cajas/chica')).b.abierta;
  const c = await api(vendedor, 'POST', `/cajas/chica/${caja.codigo}/cerrar`, { montoContado: 95, observacion: 'Faltan S/ 5' });
  assert.equal(c.s, 200, JSON.stringify(c.b));
  assert.deepEqual([c.b.esperado, c.b.diferencia], [100, -5]);
  assert.equal((await api(vendedor, 'GET', '/cajas/chica')).b.abierta, null);
});

after(() => sqlScript(`${ANULAR_COMPRAS_DE_PRUEBA}
  UPDATE core.insumo SET activo = false WHERE nombre = 'Insumo prueba pagos';
  UPDATE core.proveedor SET estado = 'INACTIVO' WHERE razon_social LIKE 'Proveedor prueba %';`));
