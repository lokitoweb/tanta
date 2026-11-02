#!/usr/bin/env node
/**
 * Tanta · pruebas puntuales de concurrencia (reproducen los defectos del informe).
 *
 *   node tests/pruebas-puntuales.mjs
 *
 * P1 · POST /ventas concurrente: el código se genera con `count(*)+1` sin
 *      bloqueo, así que dos ventas simultáneas calculan el mismo código y una
 *      choca contra `venta_codigo_key`.
 * P2 · POST /ventas sin stock: no hay comprobación de existencias, así que la
 *      fila choca contra `ck_producto_stock_no_negativo` y el cliente recibe 500
 *      (debería ser 409 de negocio).
 *
 * Modifica datos: P2 deja el stock de P016 en 0 y lo repone al terminar.
 */

import { spawnSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:3001/api/v1';
const CLAVE = 'tanta';
const PRODUCTO = '099f5b27-e35c-402f-865f-20471e5e813d'; // P001 · Pan francés

const psql = (sql) => {
  const r = spawnSync('docker', ['exec', 'tanta-pg', 'psql', '-U', 'tanta', '-d', 'tanta', '-t', '-A', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

async function login(usuario) {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.240.0.1' },
    body: JSON.stringify({ usuario, clave: CLAVE }),
  });
  const d = await r.json();
  if (!d.accessToken) throw new Error(`login ${usuario}: ${JSON.stringify(d)}`);
  return d.accessToken;
}

async function venta(token, productoId, cantidad, ip) {
  const r = await fetch(`${BASE}/ventas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-forwarded-for': ip },
    body: JSON.stringify({ items: [{ productoId, cantidad }], formaPago: 'EFECTIVO' }),
  });
  const texto = await r.text();
  let cuerpo = {};
  try { cuerpo = JSON.parse(texto); } catch { /* no json */ }
  return { status: r.status, codigo: cuerpo.codigo ?? null, mensaje: (cuerpo.detail ?? cuerpo.title ?? '').slice(0, 120) };
}

const token = await login('cmedina');

console.log('P1 · 6 ventas simultáneas de productos DISTINTOS');
// Clave: si las 6 ventas usan el mismo producto, el `FOR UPDATE` de la fila las
// serializa y el choque de código no aparece. En una panadería real dos cajas
// venden SKUs distintos a la vez: ahí sí se cruzan.
const productos = psql(
  "SELECT string_agg(id::text, ',' ORDER BY codigo) FROM (SELECT id, codigo FROM core.producto WHERE estado='ACTIVO' ORDER BY codigo LIMIT 6) p",
).split(',');
const resultados = await Promise.all(
  productos.map((id, i) => venta(token, id, 1, `10.241.0.${i + 1}`)),
);
for (const r of resultados) console.log(`   ${r.status} ${r.codigo ?? 'OK'}${r.mensaje ? ` — ${r.mensaje}` : ''}`);
console.log(`   → ${resultados.filter((r) => r.status === 201).length} creadas, ${resultados.filter((r) => r.status >= 500).length} con 500`);;

console.log('\nP2 · venta de un producto con stock 0');
const stockOriginal = psql(`SELECT stock FROM core.producto WHERE id='${PRODUCTO}'`);
psql(`UPDATE core.producto SET stock = 0 WHERE id='${PRODUCTO}'`);
try {
  const r = await venta(token, PRODUCTO, 1, '10.241.1.1');
  console.log(`   ${r.status} ${r.codigo ?? 'OK'}${r.mensaje ? ` — ${r.mensaje}` : ''}`);
  console.log('   → se esperaba 409 STOCK_INSUFICIENTE; se obtuvo ' + r.status);
} finally {
  psql(`UPDATE core.producto SET stock = ${stockOriginal} WHERE id='${PRODUCTO}'`);
  console.log(`   stock de P001 repuesto a ${stockOriginal}`);
}

console.log('\nP3 · integridad de la cadena de auditoría');
console.log(
  psql(
    `WITH e AS (SELECT id, hash_anterior, hash_actual, lag(hash_actual) OVER (ORDER BY id) AS prev FROM audit.evento)
     SELECT 'eventos=' || count(*) || ' eslabones_rotos=' || count(*) FILTER (WHERE prev IS NOT NULL AND hash_anterior <> prev) FROM e`,
  ),
);
