// node --test tests/ventas-excel.test.mjs  (API en 127.0.0.1:3001 con la semilla)
// Ventas y cobranza del INF-TEC-001: CP-25 a CP-29 y CP-34.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql, sqlScript } from './_sql.mjs';

const B = process.env.API ?? 'http://127.0.0.1:3001/api/v1';
const sesiones = new Map();
const login = (u) => { if (!sesiones.has(u)) sesiones.set(u, fetch(B + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario: u, clave: 'tanta' }) }).then((r) => r.json()).then((j) => j.accessToken)); return sesiones.get(u); };
const api = (t, m, ruta, body) => fetch(B + ruta, {
  method: m, headers: { Authorization: 'Bearer ' + t, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));

const prod = () => sql('SELECT id FROM core.producto WHERE stock >= 5 ORDER BY nombre LIMIT 1');
// Cliente propio por prueba: no depende de la deuda de los datos de ejemplo.
const cliente = (cond = 'CREDITO', limite = 100000) => sql(`WITH c AS (INSERT INTO core.cliente (codigo, nombre, dias_credito, limite_credito, condicion_pago)
  VALUES ('T-${randomUUID().slice(0, 8)}', 'Cliente prueba ventas', 30, ${limite}, '${cond}') RETURNING id) SELECT id FROM c`);
// Documento por cobrar directo, con vencimiento a "dias" atrás.
const deuda = (cli, monto, dias = 0) => sql(`WITH x AS (INSERT INTO core.cuenta_por_cobrar (cliente_id, monto, saldo, estado, vence_en)
  VALUES ('${cli}', ${monto}, ${monto}, 'PENDIENTE', current_date - ${dias}) RETURNING id) SELECT id FROM x`);

test('CP-26: nota de venta con serie y correlativo; base + IGV = total', async () => {
  const v = await api(await login('cmedina'), 'POST', '/ventas', { items: [{ productoId: prod(), cantidad: 1 }], formaPago: 'EFECTIVO' });
  assert.equal(v.s, 201, JSON.stringify(v.b));
  const c = v.b.comprobante;
  assert.match(c.numero, /^[A-Z0-9]{4}-\d{8}$/);
  assert.equal(Number((c.base + c.igv).toFixed(2)), Number(c.total.toFixed(2)));
  const igv = Number(sql("SELECT valor FROM core.parametro WHERE clave = 'igv'"));
  assert.ok(Math.abs(c.igv - c.base * igv) <= 0.01, 'IGV sobre la base');
  // Base 100 → IGV 18 → total 118 (misma fórmula que la API).
  assert.equal(Number((118 / 1.18).toFixed(2)), 100);
  const otra = await api(await login('cmedina'), 'POST', '/ventas', { items: [{ productoId: prod(), cantidad: 1 }], formaPago: 'EFECTIVO' });
  assert.equal(otra.b.comprobante.correlativo, c.correlativo + 1, 'correlativo único y consecutivo');
});

test('COB-02: pago con tarjeta o billetera exige número de operación', async () => {
  const t = await login('cmedina');
  assert.equal((await api(t, 'POST', '/ventas', { items: [{ productoId: prod(), cantidad: 1 }], formaPago: 'TARJETA' })).s, 422);
  const v = await api(t, 'POST', '/ventas', { items: [{ productoId: prod(), cantidad: 1 }], formaPago: 'YAPE', referenciaPago: 'OP-123456' });
  assert.equal(v.s, 201, JSON.stringify(v.b));
});

test('CP-25: descuento sobre el tope necesita la aprobación del Gerente', async () => {
  const vend = await login('cmedina');
  const tope = Number(sql("SELECT valor FROM core.parametro WHERE clave = 'descuento_maximo'"));
  const pct = Number(Math.min(tope + 0.05, 0.5).toFixed(4));
  const venta = (extra = {}) => api(vend, 'POST', '/ventas', { items: [{ productoId: prod(), cantidad: 1 }], formaPago: 'EFECTIVO', descuentoPct: pct, ...extra });
  assert.equal((await venta()).s, 422, 'sin aprobación se rechaza');
  const sol = await api(vend, 'POST', '/descuentos/solicitudes', { porcentaje: pct, motivo: 'Cliente frecuente, compra grande' });
  assert.equal(sol.s, 201, JSON.stringify(sol.b));
  assert.equal((await api(vend, 'POST', `/descuentos/solicitudes/${sol.b.id}/resolver`, { aprobar: true })).s, 403, 'el vendedor no aprueba');
  assert.equal((await venta({ aprobacionDescuentoId: sol.b.id })).s, 422, 'pendiente no sirve');
  assert.equal((await api(await login('osquilcate'), 'POST', `/descuentos/solicitudes/${sol.b.id}/resolver`, { aprobar: true })).s, 200);
  const ok = await venta({ aprobacionDescuentoId: sol.b.id });
  assert.equal(ok.s, 201, JSON.stringify(ok.b));
  assert.equal(sql(`SELECT estado FROM core.descuento_aprobacion WHERE id = '${sol.b.id}'`), 'USADA');
  assert.equal((await venta({ aprobacionDescuentoId: sol.b.id })).s, 422, 'una aprobación se usa una vez');
});

test('CP-29: crédito solo para clientes con condición crédito y dentro del límite', async () => {
  const t = await login('cmedina');
  const contado = cliente('CONTADO');
  assert.equal((await api(t, 'POST', '/ventas', { items: [{ productoId: prod(), cantidad: 1 }], formaPago: 'CREDITO', clienteId: contado })).s, 409);
  const corto = cliente('CREDITO', 1);
  deuda(corto, 1);
  assert.equal((await api(t, 'POST', '/ventas', { items: [{ productoId: prod(), cantidad: 1 }], formaPago: 'CREDITO', clienteId: corto })).s, 409, 'límite excedido');
});

test('CP-27 / CP-28: pago parcial, varios documentos y pago mayor al saldo', async () => {
  const t = await login('cmedina');
  const cli = cliente();
  const viejo = deuda(cli, 100, 10), nuevo = deuda(cli, 50, 0);
  assert.equal((await api(t, 'POST', '/cobranza/recibos', { clienteId: cli, monto: 151, medio: 'EFECTIVO' })).s, 422, 'CP-28: supera el saldo');
  assert.equal((await api(t, 'POST', '/cobranza/recibos', { clienteId: cli, monto: 10, medio: 'TRANSFERENCIA' })).s, 422, 'sin referencia');
  const p = await api(t, 'POST', '/cobranza/recibos', { clienteId: cli, monto: 120, medio: 'TRANSFERENCIA', referencia: 'OP-998877' });
  assert.equal(p.s, 201, JSON.stringify(p.b));
  assert.match(p.b.numero, /^[A-Z0-9]{4}-\d{8}$/);
  assert.equal(p.b.aplicaciones.length, 2, 'se aplica a dos documentos');
  assert.equal(sql(`SELECT estado FROM core.cuenta_por_cobrar WHERE id = '${viejo}'`), 'PAGADA', 'el más antiguo primero');
  assert.equal(sql(`SELECT estado || ' ' || saldo::numeric(10,2) FROM core.cuenta_por_cobrar WHERE id = '${nuevo}'`), 'PARCIAL 30.00', 'CP-27: saldo pendiente');
  const ec = await api(t, 'GET', `/estado-cuenta?clienteId=${cli}`);
  assert.equal(ec.s, 200);
  assert.equal(ec.b.saldo, 30);
  const cierre = await api(t, 'GET', '/cobranza/cierre');
  assert.equal(cierre.s, 200);
  assert.ok(cierre.b.porMedio.some((m) => m.medio === 'TRANSFERENCIA' && m.monto >= 120));
});

test('Pago con dos formas (efectivo + Yape) y pago parcial que deja la compra en la cartera', async () => {
  const t = await login('cmedina');
  const cli = cliente();
  const doc = deuda(cli, 250, 3);
  const yapeSinOp = await api(t, 'POST', '/cobranza/recibos', { clienteId: cli, pagos: [{ monto: 50, medio: 'EFECTIVO' }, { monto: 50, medio: 'YAPE' }] });
  assert.equal(yapeSinOp.s, 422, 'Yape sin N.° de operación');
  assert.equal((await api(t, 'POST', '/cobranza/recibos', { clienteId: cli, pagos: [{ monto: 200, medio: 'EFECTIVO' }, { monto: 60, medio: 'EFECTIVO' }] })).s, 422, 'la suma supera el saldo');
  const r = await api(t, 'POST', '/cobranza/recibos', { clienteId: cli, cxcIds: [doc], pagos: [{ monto: 60, medio: 'EFECTIVO' }, { monto: 40, medio: 'YAPE', referencia: 'Y-123456' }] });
  assert.equal(r.s, 201, JSON.stringify(r.b));
  assert.equal(r.b.monto, 100);
  assert.deepEqual(r.b.pagos.map((p) => `${p.medio} ${p.monto}`).sort(), ['EFECTIVO 60', 'YAPE 40']);
  assert.equal(sql(`SELECT estado || ' ' || saldo::numeric(10,2) FROM core.cuenta_por_cobrar WHERE id = '${doc}'`), 'PARCIAL 150.00', 'pagó 100 de 250: quedan 150');
  const cartera = await api(t, 'GET', '/cxc');
  const fila = cartera.b.find((x) => x.id === doc);
  assert.ok(fila, 'la compra con pago parcial sigue en la cartera');
  assert.equal(fila.pagado, 100);
  assert.equal(fila.saldo, 150);
  assert.equal(fila.clienteId, cli);
});

test('CP-34: antigüedad de deuda por días vencidos (5, 20 y 40)', async () => {
  const cli = cliente();
  [5, 20, 40].forEach((d) => deuda(cli, 10, d));
  const r = await api(await login('osquilcate'), 'GET', `/reportes/V-01?cliente=${cli}`);
  assert.equal(r.s, 200, JSON.stringify(r.b));
  const f = r.b.filas[0];
  assert.deepEqual([f.d0_7, f.d16_30, f.d30, f.total], [10, 10, 10, 30]);
  sqlScript(`UPDATE core.cuenta_por_cobrar SET estado = 'ANULADA' WHERE cliente_id = '${cli}';`);
});

test('el cliente solo ve su propio estado de cuenta', async () => {
  const r = await api(await login('mfernandez'), 'GET', `/estado-cuenta?clienteId=${randomUUID()}`);
  assert.equal(r.s, 200, 'ignora el clienteId y devuelve el suyo');
  assert.notEqual(r.b.cliente.nombre, 'Cliente prueba ventas');
});

// Los clientes de prueba no dejan deuda en el tablero.
after(() => sqlScript(`UPDATE core.cuenta_por_cobrar SET estado = 'ANULADA' WHERE estado IN ('PENDIENTE','PARCIAL')
  AND cliente_id IN (SELECT id FROM core.cliente WHERE nombre = 'Cliente prueba ventas');`));
