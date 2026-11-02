#!/usr/bin/env node
/**
 * Analiza un log de PostgreSQL con `log_min_duration_statement` para responder:
 * ¿cuáles son las consultas más costosas y cuánto tiempo consumen de verdad?
 *
 * Uso:
 *   node tests/analizar-log-sql.mjs tests/evidencia/pg-log-60-vu.log --top=15
 *
 * Dos detalles del formato que hay que respetar:
 *  · Las consultas de `datos.ts` son plantillas que empiezan con salto de línea,
 *    así que PostgreSQL escribe `statement: ` y el SQL en las líneas siguientes.
 *    Hay que concatenar las líneas de continuación.
 *  · node-postgres usa el protocolo extendido sólo cuando hay parámetros: esas
 *    consultas se registran como parse/bind/execute. Sin parámetros usa el
 *    protocolo simple y se registra como `statement`. Ambas son ejecuciones.
 */

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const archivo = args.find((a) => !a.startsWith('--'));
const top = Number((args.find((a) => a.startsWith('--top=')) ?? '--top=15').split('=')[1]);
if (!archivo) {
  console.error('uso: node tests/analizar-log-sql.mjs <archivo.log> [--top=N]');
  process.exit(1);
}

const lineas = readFileSync(archivo, 'utf8').replace(/\r\n/g, '\n').split('\n');
const RE_INICIO = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+ \S+ \[\d+\] /;
const RE_DURACION = /duration: ([\d.]+) ms\s+(parse|bind|execute fetch from|execute|statement)\s*(?:<unnamed>)?:?\s?/;

const entradas = [];
let actual = null;
for (const linea of lineas) {
  if (RE_INICIO.test(linea)) {
    if (actual) entradas.push(actual);
    actual = { cabecera: linea, cuerpo: [linea] };
  } else if (actual && linea.trim() !== '') {
    actual.cuerpo.push(linea);
  }
}
if (actual) entradas.push(actual);

function normalizar(sql) {
  return sql
    .replace(/\s+/g, ' ')
    .replace(/\$\d+/g, '$?')
    .replace(/'[^']*'/g, "'…'")
    .replace(/\b\d+(\.\d+)?\b/g, 'N')
    .trim()
    .slice(0, 240);
}

const porConsulta = new Map(); // fase|sqlNormalizado -> registro
let conDuracion = 0;

for (const e of entradas) {
  const texto = e.cuerpo.join('\n');
  const m = RE_DURACION.exec(e.cabecera);
  if (!m) continue;
  conDuracion += 1;
  const ms = Number(m[1]);
  const fase = m[2];
  // El SQL es lo que sigue al marcador en la cabecera + las líneas de continuación.
  const restoCabecera = e.cabecera.slice((m.index ?? 0) + m[0].length);
  const sqlCrudo = [restoCabecera, ...e.cuerpo.slice(1)].join('\n').trim();
  if (!sqlCrudo) continue;
  const sql = normalizar(sqlCrudo);
  const clave = `${fase}|${sql}`;
  if (!porConsulta.has(clave)) {
    porConsulta.set(clave, { fase, sql, ejemplo: sqlCrudo.replace(/\s+/g, ' ').slice(0, 500), tiempos: [] });
  }
  porConsulta.get(clave).tiempos.push(ms);
  void texto;
}

function pct(ordenados, p) {
  if (!ordenados.length) return 0;
  const i = Math.ceil(p * ordenados.length) - 1;
  return ordenados[Math.min(Math.max(i, 0), ordenados.length - 1)];
}
function resumen(tiempos) {
  const o = [...tiempos].sort((a, b) => a - b);
  const suma = o.reduce((s, v) => s + v, 0);
  return {
    n: o.length,
    totalMs: Number(suma.toFixed(1)),
    media: Number((suma / o.length).toFixed(3)),
    p50: Number(pct(o, 0.5).toFixed(3)),
    p95: Number(pct(o, 0.95).toFixed(3)),
    p99: Number(pct(o, 0.99).toFixed(3)),
    max: Number(o[o.length - 1].toFixed(3)),
  };
}

const porFase = {};
for (const r of porConsulta.values()) {
  porFase[r.fase] ??= { n: 0, ms: 0 };
  porFase[r.fase].n += r.tiempos.length;
  porFase[r.fase].ms += r.tiempos.reduce((s, v) => s + v, 0);
}

console.log(`archivo: ${archivo}`);
console.log(`entradas con duración: ${conDuracion} · consultas normalizadas distintas: ${porConsulta.size}`);
console.log('\ntiempo por fase:');
for (const [fase, v] of Object.entries(porFase).sort((a, b) => b[1].ms - a[1].ms)) {
  console.log(`  ${fase.padEnd(20)} n=${String(v.n).padStart(6)}  total=${v.ms.toFixed(0).padStart(8)} ms  media=${(v.ms / v.n).toFixed(3)} ms`);
}

// El coste real de ejecución: `execute` y `statement`.
const ejecuciones = [...porConsulta.values()]
  .filter((x) => x.fase === 'execute' || x.fase === 'statement')
  .sort((a, b) => b.tiempos.reduce((s, v) => s + v, 0) - a.tiempos.reduce((s, v) => s + v, 0));
const gran = ejecuciones.reduce((s, x) => s + x.tiempos.reduce((a, b) => a + b, 0), 0);

console.log(`\ntop ${top} consultas por tiempo acumulado de ejecución (${gran.toFixed(0)} ms):`);
const ancho = [4, 6, 10, 7, 9, 9, 9, 9];
console.log(
  ['#', 'n', 'total ms', '%', 'p50', 'p95', 'p99', 'max'].map((c, i) => (i === 0 ? c.padStart(2) : c.padStart(10))).join(''),
);
ejecuciones.slice(0, top).forEach((x, i) => {
  const r = resumen(x.tiempos);
  const fila = [i + 1, r.n, r.totalMs, ((r.totalMs / gran) * 100).toFixed(1), r.p50, r.p95, r.p99, r.max]
    .map((c, j) => (j === 0 ? String(c).padStart(2) : String(c).padStart(10)))
    .join('');
  console.log(fila);
  console.log(`    [${x.fase}] ${x.sql}`);
});
void ancho;

console.log('\npeor p99:');
for (const x of [...ejecuciones].sort((a, b) => resumen(b.tiempos).p99 - resumen(a.tiempos).p99).slice(0, 6)) {
  const r = resumen(x.tiempos);
  console.log(`  p99=${String(r.p99).padStart(9)} ms  max=${String(r.max).padStart(8)}  n=${String(r.n).padStart(5)}  ${x.sql.slice(0, 120)}`);
}

if (process.argv.includes('--sql')) {
  console.log('\nSQL de ejemplo (top 3):');
  ejecuciones.slice(0, 3).forEach((x, i) => console.log(`--- ${i + 1} ---\n${x.ejemplo}\n`));
}
