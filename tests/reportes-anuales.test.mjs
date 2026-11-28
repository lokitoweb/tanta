// node tests/correr.mjs tests/reportes-anuales.test.mjs  (API de pruebas con la semilla)
// Informe REQ-TANTA-REP-01 del ing. Alvarez (27/11/2026): registro de ventas (G-06) y reportes anuales G-14 (categoría), G-15 (producto) y G-16 (rentabilidad).
// Todos salen de las mismas líneas de venta que el Resumen ejecutivo (G-01): deben cuadrar con él y no contar anuladas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from './_sql.mjs';

const B = process.env.API ?? 'http://127.0.0.1:3001/api/v1';
const entrar = async (usuario) => {
  for (let i = 0; i < 10; i++) {
    const r = await fetch(B + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario, clave: 'tanta' }) });
    if (r.status !== 429) return (await r.json()).accessToken;
    await new Promise((ok) => setTimeout(ok, 7000));
  }
  throw new Error('login bloqueado por el límite');
};
const get = (t, ruta) => fetch(B + ruta, { headers: { Authorization: 'Bearer ' + t } }).then(async (r) => ({ s: r.status, b: await r.json() }));
const cerca = (a, b, tol = 0.05, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} ≠ ${b}`);
const suma = (xs) => xs.reduce((a, b) => a + b, 0);
const meses = (f) => Array.from({ length: 12 }, (_, i) => f[`m${i + 1}`]);
// El año con ventas en la semilla (las fechas de la semilla son relativas a hoy).
const ANIO = Number(sql(`SELECT extract(year FROM max(creado_en) AT TIME ZONE 'America/Lima')::int FROM core.venta WHERE estado = 'CONFIRMADA'`));

test('G-16 Rentabilidad por año: 12 meses que suman el año y cuadran con el Resumen ejecutivo', async () => {
  const t = await entrar('superadmin');
  const r = await get(t, `/reportes/G-16?anio=${ANIO}`);
  assert.equal(r.s, 200);
  assert.deepEqual(r.b.filas.map((f) => f.mes), ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Set', 'Oct', 'Nov', 'Dic']);
  cerca(suma(r.b.filas.map((f) => f.ventas)), r.b.resumen.ventas, 0.01, 'meses vs. año');
  for (const f of r.b.filas) cerca(f.utilidad, f.ventas - f.costo, 0.01, f.mes);
  const g01 = (await get(t, `/reportes/G-01?desde=${ANIO}-01-01&hasta=${ANIO}-12-31`)).b.filas;
  cerca(r.b.resumen.ventas, g01.find((x) => x.indicador === 'Ventas netas').actual, 0.01, 'ventas vs. G-01');
  cerca(r.b.resumen.costo, g01.find((x) => x.indicador === 'Costo de ventas').actual, 0.01, 'costo vs. G-01');
  assert.ok(r.b.resumen.ventas > 0, 'la semilla tiene ventas en el año');
});

test('G-14 Margen por categoría: cada fila suma sus meses; en % las columnas cambian a porcentaje', async () => {
  const t = await entrar('superadmin');
  const s = await get(t, `/reportes/G-14?anio=${ANIO}`);
  assert.equal(s.s, 200);
  assert.equal(s.b.columnas.find((c) => c.key === 'm1').tipo, 'dinero');
  for (const f of s.b.filas) cerca(suma(meses(f)), f.total, 0.01, f.nombre);
  const anual = (await get(t, `/reportes/G-16?anio=${ANIO}`)).b.resumen;
  cerca(suma(s.b.filas.map((f) => f.total)), anual.utilidad, 0.05, 'categorías vs. G-16');
  const p = await get(t, `/reportes/G-14?anio=${ANIO}&medida=margen`);
  assert.equal(p.b.columnas.find((c) => c.key === 'total').tipo, 'pct');
  for (const f of p.b.filas) assert.ok(f.total <= 1, `margen en fracción: ${f.total}`);
});

test('G-15 Ventas por producto: Top N ordenado y unidades iguales a lo vendido', async () => {
  const t = await entrar('superadmin');
  const top = await get(t, `/reportes/G-15?anio=${ANIO}&top=5`);
  assert.equal(top.s, 200);
  assert.ok(top.b.filas.length <= 5 && top.b.filas.length > 0);
  const totales = top.b.filas.map((f) => f.total);
  assert.deepEqual(totales, [...totales].sort((a, b) => b - a), 'de más a menos vendido');
  const und = await get(t, `/reportes/G-15?anio=${ANIO}&medida=unidades`);
  assert.equal(und.b.columnas.find((c) => c.key === 'm1').tipo, 'num');
  const vendido = Number(sql(`SELECT coalesce(sum(d.cantidad),0) FROM core.venta_detalle d JOIN core.venta v ON v.id = d.venta_id
    WHERE v.estado = 'CONFIRMADA' AND v.creado_en >= '${ANIO}-01-01'::date AND v.creado_en < '${ANIO + 1}-01-01'::date`));
  cerca(suma(und.b.filas.map((f) => f.total)), vendido, 0.01, 'unidades');
});

test('G-06 Registro de ventas: un documento por venta confirmada, con IGV, condición y estado de pago', async () => {
  const t = await entrar('superadmin');
  const rango = `desde=${ANIO}-01-01&hasta=${ANIO}-12-31`;
  const r = await get(t, `/reportes/G-06?${rango}`);
  assert.equal(r.s, 200);
  const confirmadas = Number(sql(`SELECT count(*) FROM core.venta WHERE estado = 'CONFIRMADA' AND creado_en >= '${ANIO}-01-01'::date AND creado_en < '${ANIO + 1}-01-01'::date`));
  assert.equal(r.b.filas.length, Math.min(confirmadas, 2000));
  const anuladas = sql(`SELECT coalesce(string_agg(codigo, ','), '') FROM core.venta WHERE estado = 'ANULADA'`).split(',').filter(Boolean);
  assert.ok(!r.b.filas.some((f) => anuladas.includes(f.codigo)), 'sin anuladas');
  for (const f of r.b.filas.slice(0, 50)) cerca(f.subtotal + f.igv, f.total, 0.02, f.codigo);
  // Filtros: crédito y estado de pago.
  const cred = await get(t, `/reportes/G-06?${rango}&condicion=CREDITO`);
  assert.ok(cred.b.filas.every((f) => f.condicion === 'Crédito'));
  const pend = await get(t, `/reportes/G-06?${rango}&estadoPago=PENDIENTE`);
  assert.ok(pend.b.filas.every((f) => f.estadoPago === 'Pendiente'));
  const app = await get(t, `/reportes/G-06?${rango}&canal=APP`);
  assert.ok(app.b.filas.every((f) => f.canal === 'Pedido por app'));
  // Mismo costo congelado que el resto de reportes.
  const g01 = (await get(t, `/reportes/G-01?${rango}`)).b.filas;
  if (confirmadas <= 2000) cerca(suma(r.b.filas.map((f) => f.costo)), g01.find((x) => x.indicador === 'Costo de ventas').actual, 0.05, 'costo vs. G-01');
});

test('Filtros inválidos: 422', async () => {
  const t = await entrar('superadmin');
  assert.equal((await get(t, '/reportes/G-16?anio=19')).s, 422);
  assert.equal((await get(t, '/reportes/G-15?medida=kilos')).s, 422);
  assert.equal((await get(t, '/reportes/G-06?estadoPago=REGALADO')).s, 422);
});
