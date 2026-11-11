// node --test tests/flujo.test.mjs  (API en 127.0.0.1:3001 con la semilla)
// Flujo del PDF (Fig. 2) y correcciones de la auditoría: pedido del cliente, OP con consumo
// correcto, crédito con IGV, descuento con tope y ticket de MFA que no sirve como sesión.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql, sqlScript } from './_sql.mjs';
import { flujoCompras, hoyLima, nroUnico, ANULAR_COMPRAS_DE_PRUEBA } from './_compras.mjs';

const B = process.env.API ?? 'http://127.0.0.1:3001/api/v1';
const login = async (u) => (await (await fetch(B + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario: u, clave: 'tanta' }) })).json()).accessToken;
const api = (t, m, ruta, body) => fetch(B + ruta, {
  method: m, headers: { Authorization: 'Bearer ' + t, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));
const manana = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

test('el cliente registra su pedido y solo ve los suyos', async () => {
  const cli = await login('mfernandez');
  const prods = (await api(cli, 'GET', '/datos')).b.productos;
  // Este cliente de ejemplo ya debe más que su línea (PED-04 lo bloquearía): la prueba la suspende y la restaura.
  const cond = "(SELECT cliente_id FROM core.usuario WHERE usuario='mfernandez')";
  const limite = sql(`SELECT limite_credito FROM core.cliente WHERE id = ${cond}`);
  sql(`UPDATE core.cliente SET limite_credito = 0 WHERE id = ${cond}`);
  try {
  const otroCliente = sql("SELECT id FROM core.cliente WHERE id <> (SELECT cliente_id FROM core.usuario WHERE usuario='mfernandez') LIMIT 1");
  const r = await api(cli, 'POST', '/pedidos', { clienteId: otroCliente, items: [{ productoId: prods[0].id, cantidad: 3 }], fechaEntrega: manana, horaEntrega: '08:30', observaciones: 'Sin azúcar' });
  assert.equal(r.s, 201);
  assert.match(r.b.codigo, /^PED-\d{4}-\d{6}$/);
  const dueno = sql(`SELECT u.usuario FROM core.pedido p JOIN core.usuario u ON u.cliente_id = p.cliente_id WHERE p.codigo = '${r.b.codigo}'`);
  assert.equal(dueno, 'mfernandez', 'aunque envíe otro clienteId, el pedido queda a su nombre');
  const mios = (await api(cli, 'GET', '/pedidos')).b;
  assert.ok(mios.some((p) => p.codigo === r.b.codigo && p.items.length === 1));
  // Al cliente la entrega se le calcula; el personal puede fijarla, pero nunca en el pasado.
  assert.equal((await api(await login('cmedina'), 'POST', '/pedidos', { clienteId: otroCliente, items: [{ productoId: prods[0].id, cantidad: 1 }], fechaEntrega: '2020-01-01' })).s, 422, 'fecha pasada');
  assert.equal((await api(await login('jramos'), 'POST', '/pedidos', { items: [{ productoId: prods[0].id, cantidad: 1 }], fechaEntrega: manana })).s, 403);
  } finally { sql(`UPDATE core.cliente SET limite_credito = ${limite} WHERE id = ${cond}`); }
});

test('OP: requerimiento, requisición entregada por Almacén y cierre sin doble descuento', async () => {
  const prod = await login('rquispe');
  const adm = await login('lbermudez');
  const receta = (await api(adm, 'GET', '/datos')).b.recetas[0];
  const req = await api(prod, 'GET', `/produccion/requerimiento?productoId=${receta.productoId}&cantidad=24`);
  assert.equal(req.s, 200);
  const linea = receta.lineas[0];
  const esperado = linea.cantidad / receta.rendimiento * 24 * (1 + receta.mermaEstandar);
  assert.ok(Math.abs(req.b.insumos[0].necesario - esperado) < 0.01, `necesario ${req.b.insumos[0].necesario} vs ${esperado}`);

  // Stock suficiente para la prueba
  const alm = await login('jramos');
  // Stock por el flujo real de compra (Compras registra, Almacén verifica), en unidad de inventario.
  const { comprarInventario } = flujoCompras(api, login);
  for (const l of receta.lineas) await comprarInventario(l.insumoId, 100, Number(sql(`SELECT greatest(cpp, 0.01) FROM core.insumo WHERE id = '${l.insumoId}'`)));

  const op = await api(prod, 'POST', '/ordenes-produccion', { productoId: receta.productoId, cantidad: 24, entrega: manana });
  assert.equal(op.s, 201);
  assert.equal((await api(prod, 'POST', `/ordenes-produccion/${op.b.codigo}/cerrar`, { cantidadProducida: 24, mermaReal: 0 })).s, 409, 'no se cierra sin iniciar');
  assert.equal((await api(prod, 'POST', `/ordenes-produccion/${op.b.codigo}/iniciar`, {})).s, 200);
  assert.equal((await api(prod, 'POST', `/ordenes-produccion/${op.b.codigo}/cerrar`, { cantidadProducida: 24, mermaReal: 0 })).s, 409, 'sin entrega de Almacén no se cierra');
  // RN-27: el insumo baja cuando Almacén entrega la requisición, no al cerrar la OP.
  const stockInsumo = () => Number(sql(`SELECT stock FROM core.insumo WHERE id='${linea.insumoId}'`));
  const antes = stockInsumo();
  const rq = (await api(alm, 'GET', '/requisiciones')).b.find((r) => r.op === op.b.codigo);
  assert.equal((await api(alm, 'POST', `/requisiciones/${rq.codigo}/atender`, { lineas: rq.lineas.map((l) => ({ insumoId: l.insumoId, cantidad: l.solicitada })) })).s, 200);
  const consumido = antes - stockInsumo();
  assert.ok(Math.abs(consumido - esperado) < 0.01, `entrega ${consumido} vs requerido ${esperado}`);
  const cierre = await api(prod, 'POST', `/ordenes-produccion/${op.b.codigo}/cerrar`, { cantidadProducida: 24, mermaReal: 0 });
  assert.equal(cierre.s, 200);
  assert.ok(Math.abs(stockInsumo() - (antes - consumido)) < 0.001, 'el cierre no vuelve a descontar');
  assert.equal((await api(await login('cmedina'), 'POST', '/ordenes-produccion', { productoId: receta.productoId, cantidad: 1, entrega: manana })).s, 403);
});

test('venta al crédito: la deuda es con IGV y vence según los días del cliente', async () => {
  const v = await login('cmedina');
  const d = (await api(v, 'GET', '/datos')).b;
  const prod = d.productos.find((p) => p.stock - (p.reservado ?? 0) >= 5);
  // Cliente propio de la prueba: 7 días de crédito y límite holgado.
  const nuevo = await api(await login('lbermudez'), 'POST', '/clientes', {
    nombre: 'QA Crédito ' + Date.now(), docTipo: 'DNI', docNumero: '', telefono: '', email: '', direccion: '',
    listaPrecio: 'MINORISTA', diasCredito: 7, limiteCredito: 5000, estado: 'ACTIVO',
  });
  const cli = nuevo.b.id;
  const r = await api(v, 'POST', '/ventas', { items: [{ productoId: prod.id, cantidad: 2 }], formaPago: 'CREDITO', clienteId: cli });
  assert.equal(r.s, 201);
  const [monto, dias] = sql(`SELECT x.monto || '|' || (x.vence_en - current_date) FROM core.cuenta_por_cobrar x WHERE x.id = '${r.b.cxcId}'`).split('|');
  assert.ok(Math.abs(Number(monto) - prod.precioConIgv * 2) < 0.01, `deuda ${monto} = precio con IGV × 2 = ${prod.precioConIgv * 2}`);
  assert.equal(Number(dias), 7);
});

test('descuento: dentro del tope se aplica; por encima se rechaza', async () => {
  const v = await login('cmedina');
  const prod = (await api(v, 'GET', '/datos')).b.productos.find((p) => p.stock - (p.reservado ?? 0) >= 5);
  const ok = await api(v, 'POST', '/ventas', { items: [{ productoId: prod.id, cantidad: 1 }], formaPago: 'EFECTIVO', descuentoPct: 0.1 });
  assert.equal(ok.s, 201);
  assert.ok(Math.abs(ok.b.ventasNetas - prod.precioConIgv * 0.9 / 1.18) < 0.01);
  assert.equal((await api(v, 'POST', '/ventas', { items: [{ productoId: prod.id, cantidad: 1 }], formaPago: 'EFECTIVO', descuentoPct: 0.5 })).s, 422);
  const doc = sql(`SELECT documento FROM core.movimiento_inventario WHERE tipo='VENTA' ORDER BY id DESC LIMIT 1`);
  assert.match(doc, /^VTA-/, 'el kárdex queda trazado al código de la venta');
});

test('seguridad: el ticket de MFA no sirve como sesión', async () => {
  // Se fuerza el flujo de enrolamiento firmando con el mismo endpoint: se pide login de un rol con MFA
  // en modo obligatorio no es posible en dev, así que se valida directamente que un ticket MFA es rechazado.
  const { SignJWT } = await import('../node_modules/jose/dist/node/esm/index.js').catch(() => import('jose'));
  const secreto = process.env.JWT_SECRET;
  if (!secreto) return; // sin el secreto en el entorno de la prueba no se puede fabricar el ticket
  const ticket = await new SignJWT({ nombre: 'x', rol: 'SUPERADMIN', typ: 'mfa' }).setProtectedHeader({ alg: 'HS256' })
    .setSubject(sql("SELECT id FROM core.usuario WHERE usuario='superadmin'")).setIssuer('tanta-core').setAudience('tanta-mfa')
    .setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(secreto));
  assert.equal((await api(ticket, 'GET', '/sistema/config')).s, 401);
});

after(() => sqlScript(ANULAR_COMPRAS_DE_PRUEBA));
