#!/usr/bin/env node
/**
 * Tanta — prueba de carga del API (Node puro, sin dependencias).
 * =================================================================
 *
 * Qué hace
 * ---------
 *  1. Hace login UNA sola vez por usuario y reutiliza el token durante toda la
 *     corrida (el rate limit del login no es el sistema: no se mide martillándolo).
 *  2. Genera una mezcla de tráfico realista y respetuosa de los permisos reales:
 *        60 % GET /datos · 15 % GET /kardex/:codigo · 20 % POST /ventas · 5 % POST /cobranza
 *     Cada usuario virtual encarna una persona (rol) con su propia mezcla, de modo
 *     que el agregado sea exactamente 60/15/20/5. Esto evita que la prueba se llene
 *     de 403 SIN_PERMISO que no son fallos del sistema sino del generador de carga
 *     (p. ej. el GERENTE no tiene `ventas.registrar`).
 *  3. Mide por endpoint: n, RPS, p50, p90, p95, p99, máximo y tasa de error, y
 *     recolecta los códigos de error de NEGOCIO (`codigo` del cuerpo), no solo el HTTP.
 *
 * Uso
 * ---
 *   node tests/carga.mjs --concurrencia=20 --duracion=30
 *   node tests/carga.mjs --concurrencia=60 --duracion=20 --etiqueta=60 --salida=tests/r60.json
 *   node tests/carga.mjs --concurrencia=10 --xff=off          # prueba de NAT (rate limit)
 *   node tests/carga.mjs --solo=datos,ventas                  # aislar endpoints
 *
 * Opciones
 * --------
 *   --concurrencia=N     usuarios virtuales en paralelo            (def. 20)
 *   --duracion=S         segundos de medición                      (def. 30)
 *   --calentamiento=S    segundos de precalentamiento (no se miden) (def. 5)
 *   --base=URL           raíz del API                (def. http://127.0.0.1:3001/api/v1)
 *   --clave=...          contraseña de los usuarios de prueba      (def. tanta)
 *   --etiqueta=...       nombre de la corrida (para el informe)
 *   --salida=RUTA.json   archivo de resultados
 *   --solo=a,b           limitar la mezcla a esos endpoints
 *   --xff=vu|req|off     IP simulada por usuario / por petición / sin cabecera (def. vu)
 *                        El API tiene rate limit GLOBAL por IP (240/min). Con `vu`
 *                        cada usuario virtual es un cliente distinto (realista);
 *                        con `off` todos comparten IP = escenario NAT de una oficina.
 *   --idempotencia=on    envía Idempotency-Key en los POST (la web NO lo envía hoy)
 *   --pausa=MS           pausa entre peticiones de un mismo usuario virtual (def. 0)
 *   --timeout=MS         timeout por petición                      (def. 30000)
 *   --fixtures=ruta.json catálogo de productos y CxC a usar (si falta se autodescubre)
 *   --semilla=N          semilla del generador pseudoaleatorio     (def. 20261101)
 *
 * Nota sobre el estado de la base: POST /ventas descuenta stock real y POST /cobranza
 * descuenta saldo real. Antes de cada escalón conviene reposicionar los datos de
 * prueba (ver INFORME-CARGA.md, sección "Preparación de datos").
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/* ------------------------------------------------------------------ */
/*  Argumentos                                                        */
/* ------------------------------------------------------------------ */
const args = new Map();
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) args.set(m[1], m[2] ?? 'true');
}
const cfg = {
  concurrencia: Number(args.get('concurrencia') ?? 20),
  duracion: Number(args.get('duracion') ?? 30),
  calentamiento: Number(args.get('calentamiento') ?? 5),
  base: (args.get('base') ?? 'http://127.0.0.1:3001/api/v1').replace(/\/$/, ''),
  clave: args.get('clave') ?? 'tanta',
  etiqueta: args.get('etiqueta') ?? `${args.get('concurrencia') ?? 20}u`,
  salida: args.get('salida') ?? `tests/resultados-${args.get('etiqueta') ?? `${args.get('concurrencia') ?? 20}u`}.json`,
  xff: args.get('xff') ?? 'vu',
  idempotencia: (args.get('idempotencia') ?? 'off') === 'on',
  pausa: Number(args.get('pausa') ?? 0),
  timeout: Number(args.get('timeout') ?? 30000),
  semilla: Number(args.get('semilla') ?? 20261101),
  fixtures: args.get('fixtures') ?? 'tests/fixtures.json',
  solo: (args.get('solo') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
};

/* ------------------------------------------------------------------ */
/*  Personas: quién puede llamar a qué, y con qué peso                */
/* ------------------------------------------------------------------ */
// Permisos reales (core.rol_permiso):
//   GERENTE    panel.ver, inventario.ver, costos.ver, ...        → NO ventas.registrar / cobranza.registrar
//   VENDEDOR   ventas.registrar, cobranza.registrar, panel.ver   → NO inventario.ver
//   PRODUCCION inventario.ver, produccion.ejecutar, panel.ver
//   ALMACEN    inventario.ver, inventario.mover, panel.ver
//
// Mezcla por persona (pesos relativos). Suma global = 60 datos / 15 kardex / 20 ventas / 5 cobranza.
const PERSONAS = {
  GERENTE:    { datos: 21, kardex: 5 },
  PRODUCCION: { datos: 13, kardex: 5 },
  ALMACEN:    { datos: 13, kardex: 5 },
  VENDEDOR:   { datos: 13, ventas: 20, cobranza: 5 },
};

const USUARIOS = [
  { usuario: 'osquilcate', persona: 'GERENTE' },
  { usuario: 'cmedina', persona: 'VENDEDOR' },
  { usuario: 'rquispe', persona: 'PRODUCCION' },
  { usuario: 'jramos', persona: 'ALMACEN' },
];

const MEDIOS_PAGO = ['EFECTIVO', 'YAPE', 'PLIN', 'TRANSFERENCIA'];

/* ------------------------------------------------------------------ */
/*  Utilidades                                                        */
/* ------------------------------------------------------------------ */
/** PRNG determinista (mulberry32): las corridas son reproducibles. */
function prng(semilla) {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const azar = prng(cfg.semilla);
const entero = (min, max) => min + Math.floor(azar() * (max - min + 1));
const elegirUno = (arr) => arr[Math.floor(azar() * arr.length)];

function percentil(ordenados, p) {
  if (ordenados.length === 0) return null;
  const i = Math.ceil(p * ordenados.length) - 1;
  return ordenados[Math.min(Math.max(i, 0), ordenados.length - 1)];
}
const red = (v, d = 1) => (v === null || v === undefined ? null : Number(v.toFixed(d)));
const ahora = () => new Date().toISOString();

/** Reparte `total` cupos según pesos, por resto mayor (determinista). */
function repartir(total, pesos) {
  const claves = Object.keys(pesos);
  const suma = claves.reduce((s, k) => s + pesos[k], 0);
  const crudo = claves.map((k) => ({ k, v: (total * pesos[k]) / suma }));
  const base = crudo.map((c) => ({ ...c, n: Math.floor(c.v), frac: c.v - Math.floor(c.v) }));
  let resto = total - base.reduce((s, c) => s + c.n, 0);
  const porFrac = [...base].sort((a, b) => b.frac - a.frac || a.k.localeCompare(b.k));
  for (const c of porFrac) {
    if (resto <= 0) break;
    c.n += 1;
    resto -= 1;
  }
  const salida = [];
  for (const c of base) for (let i = 0; i < c.n; i += 1) salida.push(c.k);
  // mezclar para que los usuarios no queden agrupados por rol
  for (let i = salida.length - 1; i > 0; i -= 1) {
    const j = Math.floor(azar() * (i + 1));
    [salida[i], salida[j]] = [salida[j], salida[i]];
  }
  return salida;
}

function ipDeVU(vu) {
  return `10.${(vu >> 8) & 255}.${vu & 255}.7`;
}
let contadorIp = 0;
function ipPorPeticion() {
  contadorIp += 1;
  return `10.${200 + ((contadorIp >> 16) & 15)}.${(contadorIp >> 8) & 255}.${(contadorIp & 255) || 1}`;
}
/** Devuelve las cabeceras extra (IP simulada) según el modo. */
function cabeceraIp(ctx) {
  if (cfg.xff === 'off') return {};
  if (cfg.xff === 'req') return { 'x-forwarded-for': ipPorPeticion() };
  return { 'x-forwarded-for': ctx.ip };
}

/* ------------------------------------------------------------------ */
/*  Fixtures: catálogo de productos y CxC existentes                  */
/* ------------------------------------------------------------------ */
function psql(sql) {
  const r = spawnSync('docker', ['exec', 'tanta-pg', 'psql', '-U', 'tanta', '-d', 'tanta', '-t', '-A', '-F', '|', '-c', sql], {
    encoding: 'utf8',
    timeout: 15000,
  });
  if (r.status !== 0) {
    throw new Error(`psql falló: ${r.stderr || r.error?.message || 'sin detalle'}`);
  }
  return r.stdout.split(/\r?\n/).filter((l) => l.trim() !== '');
}

async function autodescubrir(token) {
  const fixtures = { productos: [], cxc: [] };
  // Productos vía API (mismo camino que usaría el frontend).
  try {
    const r = await fetch(`${cfg.base}/datos`, { headers: { Authorization: `Bearer ${token}`, 'x-forwarded-for': '10.255.255.1' } });
    if (r.ok) {
      const d = await r.json();
      fixtures.productos = (d.productos ?? []).map((p) => ({ id: p.id, codigo: p.codigo, nombre: p.nombre, stock: p.stock }));
    }
  } catch { /* sigue con lo que haya */ }

  // CxC: la API no expone los ids, así que se leen de la base (solo lectura).
  try {
    const filas = psql(
      "SELECT id || '|' || saldo FROM core.cuenta_por_cobrar WHERE estado IN ('PENDIENTE','PARCIAL') AND saldo >= 5 ORDER BY id",
    );
    fixtures.cxc = filas.map((f) => {
      const [id, saldo] = f.split('|');
      return { id, saldo: Number(saldo) };
    });
  } catch (e) {
    console.warn(`[aviso] no se pudieron leer las CxC: ${e.message}`);
  }
  return fixtures;
}

/* ------------------------------------------------------------------ */
/*  Login (una vez por usuario)                                       */
/* ------------------------------------------------------------------ */
async function login(usuario, clave, indice) {
  const t0 = performance.now();
  const r = await fetch(`${cfg.base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.250.0.${indice + 1}` },
    body: JSON.stringify({ usuario, clave }),
    signal: AbortSignal.timeout(cfg.timeout),
  });
  const ms = performance.now() - t0;
  const texto = await r.text();
  if (!r.ok) {
    let codigo = `HTTP_${r.status}`;
    try { codigo = JSON.parse(texto).codigo ?? codigo; } catch { /* cuerpo no JSON */ }
    throw new Error(`login ${usuario} falló (${r.status} ${codigo}): ${texto.slice(0, 200)}`);
  }
  const d = JSON.parse(texto);
  return { token: d.accessToken, rol: d.rol, ms };
}

/* ------------------------------------------------------------------ */
/*  Ejecución de una operación                                        */
/* ------------------------------------------------------------------ */
function nombreDe(op) {
  return { datos: 'GET /datos', kardex: 'GET /kardex/INS-001', ventas: 'POST /ventas', cobranza: 'POST /cobranza' }[op];
}

async function ejecutar(op, cliente, fixtures, n) {
  const cab = { Authorization: `Bearer ${cliente.token}`, ...cabeceraIp(cliente) };
  let url;
  let init = { method: 'GET', headers: cab };

  if (op === 'datos') {
    url = `${cfg.base}/datos`;
  } else if (op === 'kardex') {
    url = `${cfg.base}/kardex/INS-001`;
  } else if (op === 'ventas') {
    const productos = fixtures.productos;
    const lineas = entero(1, 2);
    const items = [];
    for (let i = 0; i < lineas; i += 1) {
      const p = productos[(n * 7 + i * 3) % productos.length];
      items.push({ productoId: p.id, cantidad: entero(1, 3) });
    }
    url = `${cfg.base}/ventas`;
    init = {
      method: 'POST',
      headers: {
        ...cab,
        'content-type': 'application/json',
        ...(cfg.idempotencia ? { 'idempotency-key': `carga-${cliente.vu}-${n}` } : {}),
      },
      body: JSON.stringify({ items, formaPago: elegirUno(MEDIOS_PAGO) }),
    };
  } else if (op === 'cobranza') {
    const cxc = fixtures.cxc[(n * 5 + cliente.vu) % fixtures.cxc.length];
    url = `${cfg.base}/cobranza`;
    init = {
      method: 'POST',
      headers: {
        ...cab,
        'content-type': 'application/json',
        ...(cfg.idempotencia ? { 'idempotency-key': `carga-cxc-${cliente.vu}-${n}` } : {}),
      },
      body: JSON.stringify({
        cxcId: cxc.id,
        monto: 1,
        medio: elegirUno(['EFECTIVO', 'YAPE', 'PLIN', 'TRANSFERENCIA']),
        referencia: `CARGA-${cliente.vu}-${n}`.slice(0, 60),
      }),
    };
  } else {
    throw new Error(`operación desconocida: ${op}`);
  }

  return { url, init };
}

/* ------------------------------------------------------------------ */
/*  Recolección de métricas                                           */
/* ------------------------------------------------------------------ */
const metricas = new Map(); // endpoint -> { duraciones: [], status: Map, errores: Map, bytes }
function nuevoBucket(nombre) {
  return { endpoint: nombre, duraciones: [], status: new Map(), errores: new Map(), bytes: 0, n: 0 };
}
function bucket(op) {
  const nombre = nombreDe(op);
  if (!metricas.has(nombre)) metricas.set(nombre, nuevoBucket(nombre));
  return metricas.get(nombre);
}
function registrar(op, ms, status, codigo, bytes, mensaje) {
  const b = bucket(op);
  b.n += 1;
  b.duraciones.push(ms);
  b.bytes += bytes;
  b.status.set(status, (b.status.get(status) ?? 0) + 1);
  if (status === 0 || status >= 400) {
    const clave = `${status}|${codigo ?? ''}`;
    const prev = b.errores.get(clave) ?? { status, codigo: codigo ?? '', n: 0, mensaje: '' };
    prev.n += 1;
    if (!prev.mensaje && mensaje) prev.mensaje = mensaje;
    b.errores.set(clave, prev);
  }
}

function extraerCodigo(texto) {
  try {
    const j = JSON.parse(texto);
    return { codigo: j.codigo ?? j.code ?? null, mensaje: (j.detail ?? j.title ?? '').toString().slice(0, 180) };
  } catch {
    return { codigo: null, mensaje: texto.slice(0, 120) };
  }
}

/* ------------------------------------------------------------------ */
/*  Bucle de un usuario virtual                                       */
/* ------------------------------------------------------------------ */
let enMarcha = true;
let contadorGlobal = 0;

async function bucleVU(vu, cliente, fixtures, fin, medir) {
  let n = 0;
  while (enMarcha && Date.now() < fin) {
    const op = cliente.elegirOp();
    n += 1;
    contadorGlobal += 1;
    const t0 = performance.now();
    let status = 0;
    let codigo = null;
    let mensaje = '';
    let bytes = 0;
    try {
      const { url, init } = await ejecutar(op, cliente, fixtures, n);
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(cfg.timeout) });
      // Se consume el cuerpo completo: serializar la respuesta también cuesta CPU.
      const texto = await r.text();
      bytes = texto.length;
      status = r.status;
      if (status >= 400) {
        const info = extraerCodigo(texto);
        codigo = info.codigo ?? `HTTP_${status}`;
        mensaje = info.mensaje;
      }
    } catch (e) {
      status = 0;
      const nombre = e?.name ?? 'Error';
      codigo = nombre === 'TimeoutError' || nombre === 'AbortError' ? 'TIMEOUT' : (e?.cause?.code ?? nombre);
      mensaje = (e?.cause?.message ?? e?.message ?? '').slice(0, 180);
    }
    const ms = performance.now() - t0;
    if (medir) registrar(op, ms, status, codigo, bytes, mensaje);
    if (cfg.pausa > 0) await new Promise((r) => setTimeout(r, cfg.pausa));
  }
}

/**
 * Reparte los VU entre personas y devuelve los clientes listos.
 * Con `--solo`, las personas que no pueden ejecutar ninguna de las operaciones
 * pedidas se descartan y los pesos se renormalizan (si no, quedarían VU ociosos).
 */
function construirClientes({ tokenPorUsuario }) {
  const personasEfectivas = {};
  for (const [persona, mezcla] of Object.entries(PERSONAS)) {
    const ops = Object.keys(mezcla).filter((o) => cfg.solo.length === 0 || cfg.solo.includes(o));
    if (ops.length === 0) continue;
    personasEfectivas[persona] = Object.fromEntries(ops.map((o) => [o, mezcla[o]]));
  }
  const pesosPersona = {};
  for (const [persona, mezcla] of Object.entries(personasEfectivas)) {
    pesosPersona[persona] = Object.values(mezcla).reduce((s, v) => s + v, 0);
  }
  if (Object.keys(pesosPersona).length === 0) {
    throw new Error(`ninguna persona puede ejecutar ${cfg.solo.join(',')}`);
  }

  const cupos = repartir(cfg.concurrencia, pesosPersona);
  const clientes = [];
  for (let vu = 0; vu < cfg.concurrencia; vu += 1) {
    const persona = cupos[vu] ?? Object.keys(pesosPersona)[0];
    const usuario = USUARIOS.find((u) => u.persona === persona) ?? USUARIOS[0];
    const mezcla = personasEfectivas[persona];
    const totalOps = Object.values(mezcla).reduce((s, v) => s + v, 0);
    const acumulado = [];
    let acc = 0;
    for (const o of Object.keys(mezcla)) {
      acc += mezcla[o] / totalOps;
      acumulado.push({ op: o, hasta: acc });
    }
    const token = tokenPorUsuario.get(usuario.usuario)?.token;
    if (!token) throw new Error(`sin token para ${usuario.usuario}`);
    clientes.push({
      vu,
      usuario: usuario.usuario,
      persona,
      token,
      ip: ipDeVU(vu + 1),
      elegirOp() {
        const x = azar();
        for (const c of acumulado) if (x <= c.hasta) return c.op;
        return acumulado[acumulado.length - 1].op;
      },
    });
  }
  return clientes;
}

/* ------------------------------------------------------------------ */
/*  Reporte por consola                                               */
/* ------------------------------------------------------------------ */
function resumir(duracionSeg) {
  const filas = [];
  for (const b of metricas.values()) {
    const dur = [...b.duraciones].sort((x, y) => x - y);
    const errores = [...b.errores.values()].reduce((s, e) => s + e.n, 0);
    filas.push({
      endpoint: b.endpoint,
      n: b.n,
      rps: red(b.n / duracionSeg, 2),
      p50: red(percentil(dur, 0.5)),
      p90: red(percentil(dur, 0.9)),
      p95: red(percentil(dur, 0.95)),
      p99: red(percentil(dur, 0.99)),
      max: red(dur[dur.length - 1] ?? null),
      media: red(dur.reduce((s, v) => s + v, 0) / (dur.length || 1)),
      errores,
      tasaError: red((errores / b.n) * 100, 2),
      estados: Object.fromEntries([...b.status.entries()].sort()),
      codigos: [...b.errores.values()].sort((a, b2) => b2.n - a.n),
      kbytes: red(b.bytes / 1024, 1),
    });
  }
  filas.sort((a, b) => b.n - a.n);

  const tot = filas.reduce(
    (s, f) => ({
      n: s.n + f.n,
      errores: s.errores + f.errores,
      duraciones: s.duraciones.concat(metricas.get(f.endpoint).duraciones),
    }),
    { n: 0, errores: 0, duraciones: [] },
  );
  const dur = tot.duraciones.sort((a, b) => a - b);
  return {
    filas,
    totales: {
      n: tot.n,
      rps: red(tot.n / duracionSeg, 2),
      errores: tot.errores,
      tasaError: red((tot.errores / tot.n) * 100, 2),
      p50: red(percentil(dur, 0.5)),
      p90: red(percentil(dur, 0.9)),
      p95: red(percentil(dur, 0.95)),
      p99: red(percentil(dur, 0.99)),
      max: red(dur[dur.length - 1] ?? null),
    },
  };
}

function imprimir(resumen, duracionSeg, repartoReal) {
  const L = [];
  L.push('');
  L.push(`=== CARGA TANTA · ${cfg.etiqueta} · ${cfg.concurrencia} VU · ${duracionSeg}s · xff=${cfg.xff} ===`);
  L.push(
    `usuarios: ${Object.entries(repartoReal.usuarios).map(([u, n]) => `${u}=${n}`).join('  ')}   ` +
      `mezcla real: ${Object.entries(repartoReal.ops).map(([o, n]) => `${o}=${n}`).join('  ')}`,
  );
  L.push('');
  const cab = ['endpoint', 'n', 'RPS', 'p50', 'p90', 'p95', 'p99', 'max', 'err', 'err%'];
  const anchos = [22, 7, 7, 8, 8, 8, 8, 8, 6, 7];
  const fmt = (v, w, izq = false) => {
    const s = String(v ?? '-');
    return izq ? s.padEnd(w) : s.padStart(w);
  };
  L.push(cab.map((c, i) => fmt(c, anchos[i], i === 0)).join(' '));
  for (const f of resumen.filas) {
    L.push(
      [
        fmt(f.endpoint, anchos[0], true),
        fmt(f.n, anchos[1]),
        fmt(f.rps, anchos[2]),
        fmt(f.p50, anchos[3]),
        fmt(f.p90, anchos[4]),
        fmt(f.p95, anchos[5]),
        fmt(f.p99, anchos[6]),
        fmt(f.max, anchos[7]),
        fmt(f.errores, anchos[8]),
        fmt(f.tasaError, anchos[9]),
      ].join(' '),
    );
  }
  const t = resumen.totales;
  L.push(
    [
      fmt('TOTAL', anchos[0], true),
      fmt(t.n, anchos[1]),
      fmt(t.rps, anchos[2]),
      fmt(t.p50, anchos[3]),
      fmt(t.p90, anchos[4]),
      fmt(t.p95, anchos[5]),
      fmt(t.p99, anchos[6]),
      fmt(t.max, anchos[7]),
      fmt(t.errores, anchos[8]),
      fmt(t.tasaError, anchos[9]),
    ].join(' '),
  );
  L.push('');
  L.push('estados HTTP:');
  for (const f of resumen.filas) {
    L.push(`  ${f.endpoint}: ${Object.entries(f.estados).map(([k, v]) => `${k || 'NET'}×${v}`).join('  ')}`);
  }
  const conError = resumen.filas.filter((f) => f.codigos.length > 0);
  if (conError.length > 0) {
    L.push('');
    L.push('errores por código de negocio:');
    for (const f of conError) {
      for (const c of f.codigos) {
        L.push(`  ${f.endpoint} · ${c.status} ${c.codigo} ×${c.n}${c.mensaje ? ` — ${c.mensaje}` : ''}`);
      }
    }
  }
  L.push('');
  console.log(L.join('\n'));
}

/* ------------------------------------------------------------------ */
/*  Principal                                                         */
/* ------------------------------------------------------------------ */
async function main() {
  const inicioCorrida = new Date();
  console.log(`[carga] ${cfg.base} · ${cfg.concurrencia} VU · ${cfg.duracion}s (+${cfg.calentamiento}s calentamiento) · xff=${cfg.xff}`);

  // --- 1. Login único por usuario -----------------------------------
  const tokenPorUsuario = new Map();
  const logins = [];
  for (const [i, u] of USUARIOS.entries()) {
    try {
      const r = await login(u.usuario, cfg.clave, i);
      tokenPorUsuario.set(u.usuario, r);
      logins.push({ usuario: u.usuario, rol: r.rol, ms: red(r.ms, 1) });
      console.log(`[carga] login ok ${u.usuario} (${r.rol}) en ${r.ms.toFixed(0)} ms`);
    } catch (e) {
      console.error(`[carga] ${e.message}`);
      console.error('[carga] se aborta: sin token no se puede medir el sistema (no el login).');
      process.exit(2);
    }
  }

  // --- 2. Fixtures ---------------------------------------------------
  let fixtures;
  if (existsSync(cfg.fixtures)) {
    fixtures = JSON.parse(readFileSync(cfg.fixtures, 'utf8'));
    console.log(`[carga] fixtures: ${cfg.fixtures} (${fixtures.productos?.length ?? 0} productos, ${fixtures.cxc?.length ?? 0} CxC)`);
  } else {
    fixtures = await autodescubrir([...tokenPorUsuario.values()][0].token);
    console.log(`[carga] fixtures autodescubiertos: ${fixtures.productos.length} productos, ${fixtures.cxc.length} CxC`);
  }
  if (!fixtures.productos?.length) throw new Error('sin productos: POST /ventas no se puede construir');
  if ((cfg.solo.length === 0 || cfg.solo.includes('cobranza')) && !fixtures.cxc?.length) {
    throw new Error('sin CxC: POST /cobranza no se puede construir (revisa el acceso a docker/psql o --fixtures)');
  }

  const clientes = construirClientes({ tokenPorUsuario });
  const repartoUsuarios = {};
  for (const c of clientes) repartoUsuarios[c.usuario] = (repartoUsuarios[c.usuario] ?? 0) + 1;

  // --- 3. Calentamiento ---------------------------------------------
  if (cfg.calentamiento > 0) {
    metricas.clear();
    enMarcha = true;
    const finCal = Date.now() + cfg.calentamiento * 1000;
    await Promise.all(clientes.map((c) => bucleVU(c.vu, c, fixtures, finCal, false)));
    console.log(`[carga] calentamiento listo (${cfg.calentamiento}s, descartado)`);
  }

  // --- 4. Medición ---------------------------------------------------
  metricas.clear();
  const repartoOps = {};
  const t0 = Date.now();
  const fin = t0 + cfg.duracion * 1000;

  await Promise.all(clientes.map((c) => bucleVU(c.vu, c, fixtures, fin, true)));
  const finReal = Date.now();
  const duracionReal = Math.max((finReal - t0) / 1000, 0.001);

  // mezcla real observada
  let totalOps = 0;
  for (const [nombre, b] of metricas) {
    repartoOps[nombre] = b.n;
    totalOps += b.n;
  }
  const mezclaReal = {};
  for (const [k, v] of Object.entries(repartoOps)) mezclaReal[k] = red((v / totalOps) * 100, 1);

  const resumen = resumir(duracionReal);
  imprimir(resumen, duracionReal, { usuarios: repartoUsuarios, ops: mezclaReal });

  // --- 5. Persistir resultados ---------------------------------------
  const salida = {
    etiqueta: cfg.etiqueta,
    inicio: inicioCorrida.toISOString(),
    fin: new Date().toISOString(),
    duracionSeg: red(duracionReal, 2),
    config: cfg,
    logins,
    usuariosPorPersona: repartoUsuarios,
    mezclaObjetivo: { 'GET /datos': 60, 'GET /kardex/INS-001': 15, 'POST /ventas': 20, 'POST /cobranza': 5 },
    mezclaRealPct: mezclaReal,
    totales: resumen.totales,
    endpoints: resumen.filas,
  };
  mkdirSync(dirname(cfg.salida), { recursive: true });
  writeFileSync(cfg.salida, `${JSON.stringify(salida, null, 2)}\n`, 'utf8');
  console.log(`[carga] resultados → ${cfg.salida}`);
  console.log(
    `[carga] RPS=${resumen.totales.rps} p95=${resumen.totales.p95}ms errores=${resumen.totales.errores} (${resumen.totales.tasaError}%)`,
  );
}

process.on('SIGINT', () => {
  enMarcha = false;
  console.log('\n[carga] interrumpido: se cierra el bucle y se reporta lo medido');
  setTimeout(() => process.exit(130), 500);
});

main().catch((e) => {
  console.error('[carga] error fatal:', e);
  process.exit(1);
});
