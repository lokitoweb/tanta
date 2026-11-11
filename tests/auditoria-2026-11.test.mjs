// node tests/correr.mjs tests/auditoria-2026-11.test.mjs
// Correcciones de la auditoría de noviembre 2026: seguridad (MFA, jerarquía, datos personales, crédito,
// período cerrado), períodos de costo y cierre mensual (RN-38), reportes (REP-02, RN-37),
// inventario inicial (AIN-09), importación de insumos (MAE-02) y sub-recetas (MAE-06 / PRO-13).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from './_sql.mjs';

const B = process.env.API ?? 'http://127.0.0.1:3001/api/v1';
const sesiones = new Map();
const login = (u, c = 'tanta') => {
  if (!sesiones.has(u + c)) sesiones.set(u + c, fetch(B + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario: u, clave: c }) }).then((r) => r.json()).then((j) => j.accessToken));
  return sesiones.get(u + c);
};
const api = (t, m, ruta, body) => fetch(B + ruta, {
  method: m, headers: { ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));
const sufijo = randomUUID().slice(0, 6);
const limpiar = [];
after(() => { for (const s of limpiar.reverse()) { try { sql(s); } catch { /* lo que no se pudo limpiar no rompe la prueba */ } } });

test('MFA: con el segundo factor activo, el ticket no sirve para enrolar otro autenticador', async () => {
  const secreto = process.env.JWT_SECRET;
  if (!secreto) return;
  const { SignJWT } = await import('../node_modules/jose/dist/node/esm/index.js').catch(() => import('jose'));
  const sa = await login('superadmin');
  const usuario = 'mfa' + sufijo;
  assert.equal((await api(sa, 'POST', '/usuarios', { nombre: 'Prueba MFA', usuario, clave: 'ClaveSegura123', rol: 'VENDEDOR' })).s, 201);
  const id = sql(`UPDATE core.usuario SET mfa_activo = true, mfa_secreto = 'SECRETOORIGINAL' WHERE usuario = '${usuario}' RETURNING id`).split(/\r?\n/)[0]; // psql agrega «UPDATE 1»
  limpiar.push(`DELETE FROM core.usuario WHERE id = '${id}'`);
  const ticket = await new SignJWT({ nombre: 'Prueba MFA', rol: 'VENDEDOR', typ: 'mfa' }).setProtectedHeader({ alg: 'HS256' })
    .setSubject(id).setIssuer('tanta-core').setAudience('tanta-mfa').setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(secreto));
  const enr = await api(null, 'POST', '/auth/mfa/enrolar', { ticket });
  assert.equal(enr.s, 409, JSON.stringify(enr.b));
  assert.equal((await api(null, 'POST', '/auth/mfa/activar', { ticket, codigo: '000000' })).s, 409);
  assert.equal(sql(`SELECT mfa_secreto FROM core.usuario WHERE id = '${id}'`), 'SECRETOORIGINAL', 'el secreto del dueño no cambia');
});

test('datos personales y financieros: un cliente no ve la lista de clientes ni los períodos', async () => {
  const cli = await login('mfernandez');
  const f = await api(cli, 'GET', '/reportes-filtros');
  assert.equal(f.s, 200);
  assert.deepEqual(f.b.clientes, []);
  assert.deepEqual(f.b.vendedores, []);
  assert.equal((await api(cli, 'GET', '/periodos')).s, 403);
  const vend = await api(await login('cmedina'), 'GET', '/reportes-filtros');
  assert.ok(vend.b.clientes.length > 0, 'el vendedor sí elige clientes');
});

test('bloqueo por cuenta a los 5 intentos (SEG-01 / CP-02)', async () => {
  const sa = await login('superadmin');
  const usuario = 'bloq' + sufijo;
  assert.equal((await api(sa, 'POST', '/usuarios', { nombre: 'Prueba Bloqueo', usuario, clave: 'ClaveSegura123', rol: 'VENDEDOR' })).s, 201);
  limpiar.push(`DELETE FROM core.usuario WHERE usuario = '${usuario}'`, `DELETE FROM core.intento_login WHERE usuario = '${usuario}'`);
  for (let i = 0; i < 5; i++) await api(null, 'POST', '/auth/login', { usuario, clave: 'mala' + i });
  const r = await api(null, 'POST', '/auth/login', { usuario, clave: 'ClaveSegura123' });
  assert.equal(r.s, 429, 'bloqueada aun con la clave correcta');
});

test('crédito: sin límite definido no hay venta a crédito (RN-35)', async () => {
  const cli = sql(`WITH c AS (INSERT INTO core.cliente (codigo, nombre, dias_credito, limite_credito, condicion_pago)
    VALUES ('T-${sufijo}', 'Cliente sin línea', 30, 0, 'CREDITO') RETURNING id) SELECT id FROM c`);
  limpiar.push(`DELETE FROM core.cliente WHERE id = '${cli}'`);
  const prod = sql("SELECT id FROM core.producto WHERE stock - reservado >= 2 AND insumo_id IS NULL ORDER BY nombre LIMIT 1");
  const r = await api(await login('cmedina'), 'POST', '/ventas', { items: [{ productoId: prod, cantidad: 1 }], formaPago: 'CREDITO', clienteId: cli });
  assert.equal(r.s, 409);
});

test('períodos: el mes en curso existe, se cierra en orden y el cerrado no cambia (RN-38 / CP-32)', async () => {
  const hoy = sql("SELECT to_char(now() AT TIME ZONE 'America/Lima', 'YYYY-MM')");
  assert.equal(sql(`SELECT count(*) FROM core.periodo_costos WHERE to_char(make_date(anio, mes, 1), 'YYYY-MM') = '${hoy}'`), '1');
  const ger = await login('osquilcate');
  const lista = (await api(ger, 'GET', '/periodos')).b;
  const abiertos = lista.filter((p) => p.estado !== 'CERRADO').sort((a, b) => a.anio - b.anio || a.mes - b.mes);
  if (abiertos.length >= 2) {
    const r = await api(ger, 'POST', `/periodos/${abiertos[1].id}/cerrar`, {});
    assert.equal(r.s, 409, 'no se cierra un mes con uno anterior abierto');
  }
  // El cierre real se prueba dentro de una transacción que se deshace: no deja la base de pruebas cerrada.
  const salida = sql(`BEGIN; SELECT estado || '|' || (cif_estimado IS NOT NULL) FROM core.cerrar_periodo('${abiertos[0].id}', NULL); ROLLBACK;`);
  assert.match(salida, /CERRADO\|t/);
  assert.throws(() => sql(`BEGIN; SELECT core.cerrar_periodo('${abiertos[0].id}', NULL); UPDATE core.periodo_costos SET cif_total = 1 WHERE id = '${abiertos[0].id}'; ROLLBACK;`), /PERIODO_CERRADO_INMUTABLE/);
});

test('reportes: la estructura de costos suma el costo de ventas e incluye mano de obra (REP-02)', async () => {
  const ger = await login('osquilcate');
  const r = await api(ger, 'GET', '/reportes/G-07?desde=2026-01-01&hasta=2026-12-31');
  assert.equal(r.s, 200);
  const suma = r.b.filas.reduce((s, x) => s + x.monto, 0);
  assert.ok(Math.abs(suma - r.b.resumen.costoVentas) < 0.05, `suma ${suma} = costo de ventas ${r.b.resumen.costoVentas}`);
  assert.ok(r.b.filas.some((x) => x.concepto === 'Mano de obra'));
});

test('importación de insumos: filas válidas entran, las malas vuelven con su motivo y no se duplican (MAE-02)', async () => {
  const adm = await login('lbermudez');
  const nombre = 'Insumo importado ' + sufijo;
  limpiar.push(`DELETE FROM core.insumo WHERE nombre = '${nombre}'`);
  const r = await api(adm, 'POST', '/insumos/importar', { filas: [
    { nombre, tipo: 'OTRO', unidad: 'KG', minimo: 1, proveedor: '', precioCompra: 10, cantPresentacion: 5 },
    { nombre: 'x', tipo: 'OTRO', unidad: 'KG', minimo: 1, proveedor: '' },
    { nombre, tipo: 'OTRO', unidad: 'KG', minimo: 1, proveedor: '' },
    { nombre: 'Unidad rara ' + sufijo, tipo: 'OTRO', unidad: 'NOEXISTE', minimo: 1, proveedor: '' },
  ] });
  assert.equal(r.s, 200);
  assert.equal(r.b.creados.length, 1);
  assert.deepEqual(r.b.errores.map((e) => e.fila), [3, 4, 5]);
  assert.equal(sql(`SELECT cpp FROM core.insumo WHERE nombre = '${nombre}'`), '2.000000', 'costo = precio ÷ cantidad por presentación');
});

test('inventario inicial: genera «Saldo inicial» una sola vez y fija stock y costo (AIN-09)', async () => {
  const adm = await login('lbermudez');
  const nombre = 'Insumo apertura ' + sufijo;
  limpiar.push(`DELETE FROM core.insumo WHERE nombre = '${nombre}'`, `DELETE FROM core.movimiento_inventario WHERE insumo_id = (SELECT id FROM core.insumo WHERE nombre = '${nombre}')`);
  const codigo = (await api(adm, 'POST', '/insumos', { nombre, tipo: 'OTRO', unidad: 'KG', minimo: 0, proveedor: '' })).b.codigo;
  const r = await api(adm, 'POST', '/inventario/inicial', { filas: [{ tipo: 'INSUMO', codigo, cantidad: 12, costoUnitario: 3.5 }, { tipo: 'INSUMO', codigo: 'NO-EXISTE', cantidad: 1, costoUnitario: 1 }] });
  assert.equal(r.s, 200);
  assert.equal(r.b.aplicados.length, 1);
  assert.equal(r.b.errores.length, 1);
  assert.equal(sql(`SELECT stock::numeric(10,2) || '|' || cpp::numeric(10,2) FROM core.insumo WHERE codigo = '${codigo}'`), '12.00|3.50');
  assert.equal(sql(`SELECT count(*) FROM core.movimiento_inventario m JOIN core.insumo i ON i.id = m.insumo_id WHERE i.codigo = '${codigo}' AND m.tipo = 'APERTURA' AND m.documento = 'Saldo inicial'`), '1');
  const otra = await api(adm, 'POST', '/inventario/inicial', { filas: [{ tipo: 'INSUMO', codigo, cantidad: 5, costoUnitario: 1 }] });
  assert.equal(otra.b.aplicados.length, 0, 'con movimientos ya no se vuelve a cargar');
});

test('sub-receta: el intermedio no se vende y su costo entra al del pan (MAE-06)', async () => {
  const adm = await login('lbermudez');
  const nombre = 'Masa madre prueba ' + sufijo;
  limpiar.push(`DELETE FROM core.insumo WHERE nombre = '${nombre}'`);
  const ins = (await api(adm, 'POST', '/insumos', { nombre, tipo: 'OTRO', unidad: 'KG', minimo: 0, proveedor: '' })).b;
  const p = (await api(adm, 'POST', '/productos', { nombre: nombre + ' (producción)', categoriaId: sql('SELECT id FROM core.categoria ORDER BY orden LIMIT 1'), unidad: 'KG', precioConIgv: 0 })).b;
  limpiar.push(`UPDATE core.producto SET insumo_id = NULL WHERE id = '${p.id}'`, `DELETE FROM core.receta_detalle WHERE receta_id IN (SELECT id FROM core.receta WHERE producto_id = '${p.id}')`, `DELETE FROM core.receta WHERE producto_id = '${p.id}'`, `DELETE FROM core.producto WHERE id = '${p.id}'`);
  const base = { nombre: nombre + ' (producción)', categoriaId: sql('SELECT id FROM core.categoria ORDER BY orden LIMIT 1'), precioConIgv: 0, estado: 'ACTIVO' };
  assert.equal((await api(adm, 'PATCH', `/productos/${p.id}`, { ...base, unidad: 'UNIDAD', insumoId: ins.id })).s, 422, 'la unidad debe ser la del stock del insumo');
  assert.equal((await api(adm, 'PATCH', `/productos/${p.id}`, { ...base, unidad: 'KG', insumoId: ins.id })).s, 200);
  // Receta del intermedio: 1 kg de harina por "lote" de 1 kg.
  const harina = sql(`SELECT id FROM core.insumo WHERE cpp > 0 AND unidad = 'KG' AND activo AND nombre NOT LIKE '%${sufijo}%' ORDER BY nombre LIMIT 1`);
  const rec = await api(adm, 'PUT', `/recetas/${p.id}`, { rendimiento: 1, mermaEstandar: 0, lineas: [{ insumoId: harina, cantidad: 1 }] });
  assert.ok(rec.s < 300, 'receta del intermedio: ' + JSON.stringify(rec.b));
  sql('SELECT core.recalcular_costos()');
  assert.ok(Number(sql(`SELECT cpp FROM core.insumo WHERE id = '${ins.id}'`)) > 0, 'el intermedio sin stock toma el costo de su receta');
  const venta = await api(await login('cmedina'), 'POST', '/ventas', { items: [{ productoId: p.id, cantidad: 1 }], formaPago: 'EFECTIVO' });
  assert.ok(venta.s === 404 || venta.s === 409 || venta.s === 422, 'el intermedio no se vende');
});

test('merma del PDF del dueño: costo con merma = costo de insumos × (1 + merma), y es administrable', async () => {
  const fila = () => sql(`SELECT costo_insumos || '|' || costo_con_merma || '|' || merma_estandar FROM core.receta WHERE estado = 'VIGENTE' AND merma_estandar > 0 AND costo_insumos > 0 ORDER BY id LIMIT 1`).split('|').map(Number);
  const [ins, cm, m] = fila();
  assert.ok(Math.abs(cm - ins * (1 + m)) < 1e-6, `${cm} = ${ins} × (1 + ${m})`);
  const ger = await login('superadmin');
  assert.equal((await api(ger, 'PATCH', '/parametros/formula_merma', { valor: 'OTRA' })).s, 422);
  try {
    assert.equal((await api(ger, 'PATCH', '/parametros/formula_merma', { valor: 'dividir' })).s, 200);
    const [ins2, cm2, m2] = fila();
    assert.ok(Math.abs(cm2 - ins2 / (1 - m2)) < 1e-6, 'con DIVIDIR rige la del Excel');
  } finally {
    await api(ger, 'PATCH', '/parametros/formula_merma', { valor: 'MULTIPLICAR' });
  }
  assert.equal((await api(ger, 'PATCH', '/parametros/metodo_costo_insumo', { valor: 'X' })).s, 422);
});

test('proveedor: RUC opcional (Excel: las notas de pedido no lo traen), pero si se escribe debe ser válido', async () => {
  const adm = await login('lbermudez');
  const r = await api(adm, 'POST', '/proveedores', { razonSocial: 'Sin RUC ' + sufijo });
  assert.equal(r.s, 201, JSON.stringify(r.b));
  limpiar.push(`DELETE FROM core.proveedor WHERE id = '${r.b.id}'`);
  assert.equal((await api(adm, 'POST', '/proveedores', { razonSocial: 'RUC malo ' + sufijo, ruc: '123' })).s, 422);
});

test('categorías: no se elimina una con productos; una vacía sí', async () => {
  const adm = await login('lbermudez');
  const usada = sql('SELECT categoria_id FROM core.producto LIMIT 1');
  const r = await api(adm, 'DELETE', `/categorias/${usada}`);
  assert.equal(r.s, 409);
  assert.match(r.b.detail, /producto/);
  const nueva = await api(adm, 'POST', '/categorias', { nombre: 'Vacía ' + sufijo, orden: 9 });
  assert.equal(nueva.s, 201);
  assert.equal((await api(adm, 'DELETE', `/categorias/${nueva.b.id}`)).s, 204);
  assert.equal(sql(`SELECT count(*) FROM core.categoria WHERE id = '${nueva.b.id}'`), '0');
});

test('producto: código manual o automático, pérdida por cocción desde el peso final y costo por lote de horno', async () => {
  const adm = await login('lbermudez');
  const cat = sql('SELECT id FROM core.categoria ORDER BY orden LIMIT 1');
  const manual = 'PX-' + sufijo.toUpperCase();
  const a = await api(adm, 'POST', '/productos', { codigo: manual, nombre: 'Pan manual ' + sufijo, categoriaId: cat, unidad: 'UNIDAD', precioConIgv: 1 });
  assert.equal(a.s, 201, JSON.stringify(a.b));
  limpiar.push(`DELETE FROM core.receta WHERE producto_id = '${a.b.id}'`, `DELETE FROM core.producto WHERE id = '${a.b.id}'`);
  assert.equal(sql(`SELECT codigo FROM core.producto WHERE id = '${a.b.id}'`), manual);
  assert.equal((await api(adm, 'POST', '/productos', { codigo: manual, nombre: 'Otro ' + sufijo, categoriaId: cat, unidad: 'UNIDAD', precioConIgv: 1 })).s, 409, 'código repetido');
  const b = await api(adm, 'POST', '/productos', { nombre: 'Pan auto ' + sufijo, categoriaId: cat, unidad: 'UNIDAD', precioConIgv: 1 });
  limpiar.push(`DELETE FROM core.receta WHERE producto_id = '${b.b.id}'`, `DELETE FROM core.producto WHERE id = '${b.b.id}'`);
  assert.match(sql(`SELECT codigo FROM core.producto WHERE id = '${b.b.id}'`), /^P\d{3,}$/, 'sin código, el sistema lo genera');

  const datos = { nombre: 'Pan manual ' + sufijo, categoriaId: cat, unidad: 'UNIDAD', precioConIgv: 1, estado: 'ACTIVO', pesoMasaG: 60, pesoFinalG: 51, unidadesLote: 40, horasHornoLote: 0.5, horasHombreLote: 1 };
  assert.equal((await api(adm, 'PATCH', `/productos/${a.b.id}`, { ...datos, pesoFinalG: 70 })).s, 422, 'final mayor que crudo');
  assert.equal((await api(adm, 'PATCH', `/productos/${a.b.id}`, datos)).s, 200);
  assert.equal(sql(`SELECT round(perdida_coccion, 4) || '|' || unidades_lote FROM core.producto WHERE id = '${a.b.id}'`), '0.1500|40', 'pérdida = 1 − 51 ÷ 60');
  assert.equal((await api(adm, 'PATCH', `/productos/${a.b.id}`, { ...datos, vidaUtilDias: 3 })).s, 200);
  assert.equal(sql(`SELECT vida_util_dias FROM core.producto WHERE id = '${a.b.id}'`), '3', 'vida útil guardada');
  // Mano de obra por pan = horas hombre × costo hora ÷ panes del lote de horno.
  const hora = Number(sql("SELECT costo_hora_hombre FROM core.periodo_costos WHERE estado <> 'CERRADO' ORDER BY anio DESC, mes DESC LIMIT 1"));
  const moTxt = sql(`SELECT mo_unitario FROM core.receta WHERE producto_id = '${a.b.id}'`);
  const mo = Number(moTxt);
  if (hora > 0 && moTxt) assert.ok(Math.abs(mo - hora / 40) < 1e-4, `MO ${mo} = ${hora} ÷ 40`);
});
