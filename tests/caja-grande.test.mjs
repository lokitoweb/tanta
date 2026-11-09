// node tests/correr.mjs tests/caja-grande.test.mjs
// Caja grande y caja chica por usuario (audio del cliente, 09/11/2026): cuentas con saldo, cada cobro a su cuenta,
// depósito del efectivo al banco, pagos que no superan el saldo, caja chica de cada vendedor con fondo de caja grande.
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

const { proveedor, registrar, verificar } = flujoCompras(api, login);
const sufijo = randomUUID().slice(0, 4).toUpperCase();
const CTA = `QA_${sufijo}`, CTA2 = `QB_${sufijo}`;
const saldo = (c) => Number(sql(`SELECT core.saldo_cuenta('${c}')`));
let adm, ger, ven;

before(async () => {
  [adm, ger, ven] = await Promise.all(['lbermudez', 'osquilcate', 'cmedina'].map(login));
  // Dos cuentas propias de la prueba: los saldos no dependen de lo que hagan otras pruebas.
  for (const [c, n, t] of [[CTA, 'Caja fuerte QA', 'EFECTIVO'], [CTA2, 'Banco QA', 'BANCO']]) {
    const r = await api(adm, 'POST', '/catalogos/cuentas-caja', { codigo: c, nombre: `${n} ${sufijo}`, tipo: t, orden: 90 });
    assert.equal(r.s, 201, JSON.stringify(r.b));
  }
});

test('permisos: el Gerente ve la caja grande pero no la mueve; el Vendedor no la ve', async () => {
  assert.equal((await api(ger, 'GET', '/caja-grande')).s, 200);
  assert.equal((await api(ger, 'POST', '/caja-grande/movimientos', { tipo: 'SALDO_INICIAL', cuenta: CTA, monto: 10 })).s, 403);
  assert.equal((await api(ven, 'GET', '/caja-grande')).s, 403);
});

test('saldo inicial una sola vez; depósito del efectivo al banco; no se deposita más de lo que hay', async () => {
  assert.equal((await api(adm, 'POST', '/caja-grande/movimientos', { tipo: 'SALDO_INICIAL', cuenta: CTA, monto: 1000 })).s, 201);
  assert.equal((await api(adm, 'POST', '/caja-grande/movimientos', { tipo: 'SALDO_INICIAL', cuenta: CTA, monto: 5 })).s, 409, 'después se corrige con un ajuste');
  assert.equal((await api(adm, 'POST', '/caja-grande/movimientos', { tipo: 'DEPOSITO', cuenta: CTA, cuentaDestino: CTA2, monto: 1500 })).s, 422, 'sin saldo suficiente');
  const d = await api(adm, 'POST', '/caja-grande/movimientos', { tipo: 'DEPOSITO', cuenta: CTA, cuentaDestino: CTA2, monto: 600, nroOperacion: 'DEP-1' });
  assert.equal(d.s, 201, JSON.stringify(d.b));
  assert.equal(saldo(CTA), 400);
  assert.equal(saldo(CTA2), 600);
  // Anular un depósito revierte sus dos patas.
  assert.equal((await api(adm, 'POST', `/caja-grande/movimientos/${d.b.codigos[1]}/anular`, { motivo: 'Depósito mal registrado' })).s, 200);
  assert.equal(saldo(CTA), 1000);
  assert.equal(saldo(CTA2), 0);
  assert.equal((await api(adm, 'POST', '/caja-grande/movimientos', { tipo: 'AJUSTE', cuenta: CTA, monto: -1, concepto: 'abc' })).s, 422, 'el ajuste pide motivo');
  const vista = (await api(ger, 'GET', `/caja-grande?cuenta=${CTA}`)).b;
  assert.equal(vista.cuentas.find((k) => k.codigo === CTA).saldo, 1000);
  assert.ok(vista.movimientos.every((m) => m.cuenta === CTA));
});

test('pago a proveedor desde caja grande: elige la cuenta, no supera su saldo y al anularlo el dinero vuelve', async () => {
  const ins = sql(`WITH i AS (INSERT INTO core.insumo (codigo, nombre, unidad, cpp, stock, minimo) VALUES ('T-${sufijo}-CG', 'Insumo prueba caja grande', 'KG', 1, 0, 0) RETURNING id) SELECT id FROM i`);
  const k = await registrar(await proveedor(), [{ insumoId: ins, cantidad: 1, precioUnitario: 1500 }]);
  assert.equal(k.s, 201, JSON.stringify(k.b));
  await verificar(k.b);
  const pagar = (body) => api(adm, 'POST', `/compras/${k.b.codigo}/pagos`, { caja: 'GRANDE', medio: 'TRANSFERENCIA', nroOperacion: 'OP-' + sufijo, ...body });
  const sinFondo = await pagar({ monto: 1200, cuentaCaja: CTA });
  assert.equal(sinFondo.s, 422, 'la cuenta solo tiene S/ 1000');
  assert.match(sinFondo.b.detail, /solo tiene S\/ 1000\.00/);
  const ok = await pagar({ monto: 700, cuentaCaja: CTA });
  assert.equal(ok.s, 201, JSON.stringify(ok.b));
  assert.equal(saldo(CTA), 300);
  assert.equal(sql(`SELECT cuenta_caja FROM core.pago_compra WHERE codigo = '${ok.b.codigo}'`), CTA);
  assert.equal((await api(adm, 'POST', `/pagos-compra/${ok.b.codigo}/anular`, { motivo: 'Pago de prueba anulado' })).s, 200);
  assert.equal(saldo(CTA), 1000, 'el dinero vuelve a la cuenta');
});

test('caja chica por usuario: cada vendedor abre la suya; el fondo sale del efectivo y al cerrar lo contado vuelve', async () => {
  // La cuenta de efectivo de la prueba recibe el fondo: se asigna al medio en efectivo solo durante la prueba.
  const previo = sql(`SELECT cuenta_caja FROM core.medio_pago WHERE codigo = 'EFECTIVO'`);
  sqlScript(`UPDATE core.caja_apertura SET estado = 'CERRADA', cerrada_en = now(), monto_contado = 0, observacion = 'Cierre por prueba' WHERE estado = 'ABIERTA';
    UPDATE core.medio_pago SET cuenta_caja = '${CTA}' WHERE codigo = 'EFECTIVO';`);
  try {
    const a1 = await api(ven, 'POST', '/cajas/chica/abrir', { montoInicial: 100 });
    assert.equal(a1.s, 201, JSON.stringify(a1.b));
    assert.equal((await api(ven, 'POST', '/cajas/chica/abrir', { montoInicial: 10 })).s, 409, 'una abierta por persona');
    // Otro usuario con caja.abrir (el superadmin) abre la suya al mismo tiempo, sin fondo.
    const sa = await login('superadmin');
    const a2 = await api(sa, 'POST', '/cajas/chica/abrir', { montoInicial: 0 });
    assert.equal(a2.s, 201, JSON.stringify(a2.b));
    assert.equal(saldo(CTA), 900, 'el fondo de 100 salió del efectivo de caja grande');
    const mia = (await api(ven, 'GET', '/cajas/chica')).b;
    assert.equal(mia.abierta.codigo, a1.b.codigo, 'el vendedor ve su caja');
    assert.ok(mia.historial.every((x) => x.propia), 'y solo las suyas');
    assert.ok((await api(adm, 'GET', '/cajas/chica')).b.abiertas.length >= 2, 'Administración ve todas las abiertas');
    // Administración paga un costo desde la caja chica del vendedor eligiéndola.
    const ahora = new Date(Date.now() - 5 * 3_600_000);
    const g = await api(adm, 'POST', '/pagos-costos', { concepto: 'Gasto prueba caja chica', fechaOperacion: ahora.toISOString().slice(0, 10), periodoMes: ahora.getUTCMonth() + 1,
      periodoAnio: ahora.getUTCFullYear(), monto: 30, caja: 'CHICA', medio: 'EFECTIVO', aperturaCodigo: a1.b.codigo });
    assert.equal(g.s, 201, JSON.stringify(g.b));
    assert.equal((await api(ven, 'GET', '/cajas/chica')).b.abierta.saldo, 70);
    assert.equal((await api(ven, 'POST', `/cajas/chica/${a2.b.codigo}/cerrar`, { montoContado: 0 })).s, 403, 'no cierra la caja de otro');
    const cierre = await api(ven, 'POST', `/cajas/chica/${a1.b.codigo}/cerrar`, { montoContado: 68, observacion: 'Faltan 2 soles' });
    assert.equal(cierre.s, 200, JSON.stringify(cierre.b));
    assert.equal(cierre.b.diferencia, -2);
    assert.equal(saldo(CTA), 968, 'lo contado (68) volvió a caja grande');
    assert.equal((await api(sa, 'POST', `/cajas/chica/${a2.b.codigo}/cerrar`, { montoContado: 0 })).s, 200);
    sql(`UPDATE core.pago_costo SET estado = 'ANULADO', motivo_anulacion = 'Limpieza de prueba' WHERE codigo = '${g.b.codigo}'`);
  } finally {
    sql(`UPDATE core.medio_pago SET cuenta_caja = ${previo ? `'${previo}'` : 'NULL'} WHERE codigo = 'EFECTIVO'`);
  }
});

test('un medio que cobra debe tener su cuenta de caja grande', async () => {
  const r = await api(adm, 'POST', '/catalogos/medios-pago', { codigo: `QM_${sufijo}`, nombre: `Billetera ${sufijo}`, enCobranza: true });
  assert.equal(r.s, 422);
  assert.match(r.b.detail, /cuenta de caja grande/);
  assert.equal((await api(adm, 'POST', '/catalogos/medios-pago', { codigo: `QM_${sufijo}`, nombre: `Billetera ${sufijo}`, enCobranza: true, cuentaCaja: CTA2 })).s, 201);
});

after(() => sqlScript(`${ANULAR_COMPRAS_DE_PRUEBA}
  UPDATE core.insumo SET activo = false WHERE codigo LIKE 'T-${sufijo}%';
  UPDATE core.medio_pago SET activo = false WHERE codigo LIKE 'QM_%';
  UPDATE core.cuenta_caja SET activo = false WHERE codigo LIKE 'QA_%' OR codigo LIKE 'QB_%';
  UPDATE core.proveedor SET estado = 'INACTIVO' WHERE razon_social LIKE 'Proveedor prueba %';`));
