// node --test tests/correcciones-03.test.mjs  (API de pruebas con la semilla)
// Informe «Modificaciones sistema Tanta 03»: comprobante elegido por el cliente y descargable, hasta N direcciones,
// ficha del cliente, cancelación múltiple, contraseña mínima administrable y permisos por defecto.
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
  method: m, headers: { ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));
const param = (clave, valor) => sql(`UPDATE core.parametro SET valor = '${valor}' WHERE clave = '${clave}'`);

const prod = sql(`SELECT id FROM core.producto WHERE estado = 'ACTIVO' AND insumo_id IS NULL AND anticipacion_horas <= 24 ORDER BY nombre LIMIT 1`);
const cliId = sql(`SELECT cliente_id FROM core.usuario WHERE usuario = 'mfernandez'`);
const previo = Object.fromEntries(['clave_longitud_minima', 'cliente_max_direcciones'].map((k) => [k, sql(`SELECT valor FROM core.parametro WHERE clave = '${k}'`)]));
const docPrevio = sql(`SELECT doc_tipo || '|' || doc_numero || '|' || direccion FROM core.cliente WHERE id = '${cliId}'`).split('|');
after(() => {
  for (const [k, v] of Object.entries(previo)) param(k, v);
  sql(`UPDATE core.cliente SET doc_tipo = '${docPrevio[0]}', doc_numero = '${docPrevio[1]}', direccion = '${docPrevio[2].replace(/'/g, "''")}' WHERE id = '${cliId}'`);
  sql(`DELETE FROM core.direccion_cliente WHERE cliente_id = '${cliId}' AND direccion LIKE 'Prueba 03 %'`);
});

test('Permisos por defecto: el Administrador verifica compras y confirma pedidos; el Vendedor publica promociones', () => {
  const tiene = (rol, p) => sql(`SELECT count(*) FROM core.rol_permiso WHERE rol_id = '${rol}' AND permiso_id = '${p}'`) === '1';
  assert.ok(tiene('ADMINISTRADOR', 'compras.verificar'));
  assert.ok(tiene('ADMINISTRADOR', 'pedidos.gestionar'));
  assert.ok(tiene('VENDEDOR', 'promociones.gestionar'));
});

test('Contraseña mínima administrable: la configuración pública la anuncia y la API la exige', async () => {
  const adm = await login('lbermudez');
  assert.equal((await api(adm, 'PATCH', '/parametros/clave_longitud_minima', { valor: '4' })).s, 422, 'el piso es 5');
  assert.equal((await api(adm, 'PATCH', '/parametros/clave_longitud_minima', { valor: '6' })).s, 200);
  assert.equal((await api(null, 'GET', '/config/publica')).b.seguridad.claveMinima, 6);
  const u = `p03${randomUUID().slice(0, 6)}`;
  const corta = await api(adm, 'POST', '/usuarios', { nombre: 'Prueba 03', usuario: u, clave: '12345', rol: 'VENDEDOR' });
  assert.equal(corta.s, 422);
  assert.match(corta.b.message ?? corta.b.mensaje ?? JSON.stringify(corta.b), /6 caracteres/);
  param('clave_longitud_minima', '5');
  const ok = await api(adm, 'POST', '/usuarios', { nombre: 'Prueba 03', usuario: u, clave: 'ab3de', rol: 'VENDEDOR' });
  assert.equal(ok.s, 201, JSON.stringify(ok.b));
});

test('Ficha del cliente: contacto, documento, celular y hasta N direcciones (la principal cuenta)', async () => {
  const cli = await login('mfernandez');
  sql(`DELETE FROM core.direccion_cliente WHERE cliente_id = '${cliId}'`);
  sql(`UPDATE core.cliente SET direccion = 'Av. Principal 100' WHERE id = '${cliId}'`);
  param('cliente_max_direcciones', '2');
  const f = await api(cli, 'GET', '/mi-ficha');
  assert.equal(f.s, 200, JSON.stringify(f.b));
  assert.ok('docNumero' in f.b && 'contacto' in f.b && 'telefono' in f.b);
  assert.equal(f.b.maxDirecciones, 2);
  assert.equal(f.b.direcciones[0].principal, true);
  assert.equal((await api(cli, 'POST', '/mis-direcciones', { direccion: 'Prueba 03 Jr. Uno 1' })).s, 201);
  const lleno = await api(cli, 'POST', '/mis-direcciones', { direccion: 'Prueba 03 Jr. Dos 2' });
  assert.equal(lleno.s, 409, 'principal + 1 = 2: no entra otra');
  assert.equal((await api(cli, 'PATCH', '/mi-ficha', { contacto: 'Ana', telefono: '987654321' })).s, 200);
  assert.equal(sql(`SELECT contacto FROM core.cliente WHERE id = '${cliId}'`), 'Ana');
  assert.equal((await api(await login('cmedina'), 'GET', '/mi-ficha')).s, 403, 'solo cuentas de cliente');

  // Al pedir elige una de sus direcciones; una ajena se rechaza.
  const ajena = await api(cli, 'POST', '/pedidos', { items: [{ productoId: prod, cantidad: 1 }], direccion: 'Calle inventada 999' });
  assert.equal(ajena.s, 422);
  const p = await api(cli, 'POST', '/pedidos', { items: [{ productoId: prod, cantidad: 1 }], direccion: 'Prueba 03 Jr. Uno 1' });
  assert.equal(p.s, 201, JSON.stringify(p.b));
  assert.equal(sql(`SELECT direccion FROM core.pedido WHERE codigo = '${p.b.codigo}'`), 'Prueba 03 Jr. Uno 1');
  await api(cli, 'POST', `/pedidos/${p.b.codigo}/cancelar`, { motivo: 'Prueba de direcciones' });
});

test('Comprobante: el cliente elige boleta o factura; la factura exige RUC; se emite con su serie y se descarga', async () => {
  const cli = await login('mfernandez'), ven = await login('cmedina');
  sql(`UPDATE core.cliente SET doc_tipo = 'DNI', doc_numero = '45678912' WHERE id = '${cliId}'`);
  const fac = await api(cli, 'POST', '/pedidos', { items: [{ productoId: prod, cantidad: 1 }], comprobanteTipo: 'FACTURA' });
  assert.equal(fac.s, 422, 'factura sin RUC');
  assert.equal((await api(cli, 'POST', '/pedidos', { items: [{ productoId: prod, cantidad: 1 }], comprobanteTipo: 'INVENTADO' })).s, 422);
  assert.ok((await api(cli, 'GET', '/catalogos')).b.comprobantesVenta.some((t) => t.codigo === 'BOLETA'), 'la app lee los tipos del catálogo');

  const p = await api(cli, 'POST', '/pedidos', { items: [{ productoId: prod, cantidad: 2 }], comprobanteTipo: 'BOLETA' });
  assert.equal(p.s, 201, JSON.stringify(p.b));
  assert.equal(p.b.comprobanteTipo, 'BOLETA');
  sql(`UPDATE core.producto SET stock = stock + 10 WHERE id = '${prod}'`);
  assert.equal((await api(ven, 'PATCH', `/pedidos/${p.b.codigo}/estado`, { estado: 'CONFIRMADO' })).s, 200);
  assert.equal((await api(ven, 'PATCH', `/pedidos/${p.b.codigo}/estado`, { estado: 'LISTO' })).s, 200);
  const id = sql(`SELECT id FROM core.pedido WHERE codigo = '${p.b.codigo}'`);
  const v = await api(ven, 'POST', '/ventas', { pedidoId: id, items: [{ productoId: prod, cantidad: 2 }] });
  assert.equal(v.s, 201, JSON.stringify(v.b));
  assert.equal(v.b.comprobante.tipo, 'BOLETA');
  assert.match(v.b.comprobante.numero, /^B001-\d{8}$/);

  const mio = (await api(cli, 'GET', '/pedidos')).b.find((x) => x.codigo === p.b.codigo);
  assert.equal(mio.comprobante.numero, v.b.comprobante.numero);
  assert.equal(mio.comprobante.nombre, 'Boleta de venta');
  assert.equal(mio.comprobante.lineas.length, 1);
  assert.ok(!JSON.stringify(mio.comprobante).includes('costo'), 'el cliente no ve costos');
});

test('Cancelación múltiple: se cancelan los que se pueden, el resto se informa, cada uno queda auditado', async () => {
  const ven = await login('cmedina'), cli = await login('mfernandez');
  const a = await api(ven, 'POST', '/pedidos', { clienteId: cliId, items: [{ productoId: prod, cantidad: 1 }] });
  const b = await api(cli, 'POST', '/pedidos', { items: [{ productoId: prod, cantidad: 1 }] });
  const entregado = sql(`SELECT codigo FROM core.pedido WHERE estado IN ('DESPACHADO','ENTREGADO') LIMIT 1`);
  const codigos = [a.b.codigo, b.b.codigo, ...(entregado ? [entregado] : [])];
  assert.equal((await api(cli, 'POST', '/pedidos/cancelar-varios', { codigos, motivo: 'Cliente cerró' })).s, 403, 'un cliente no cancela en bloque');
  assert.equal((await api(ven, 'POST', '/pedidos/cancelar-varios', { codigos, motivo: 'x' })).s, 422, 'motivo obligatorio');
  const r = await api(ven, 'POST', '/pedidos/cancelar-varios', { codigos, motivo: 'Cliente cerró el local' });
  assert.equal(r.s, 200, JSON.stringify(r.b));
  assert.deepEqual(r.b.cancelados.sort(), [a.b.codigo, b.b.codigo].sort());
  if (entregado) assert.equal(r.b.rechazados[0].codigo, entregado);
  assert.equal(sql(`SELECT count(*) FROM audit.evento WHERE accion = 'PEDIDO_CANCELADO' AND entidad_id IN ('${a.b.codigo}','${b.b.codigo}')`), '2');
});
