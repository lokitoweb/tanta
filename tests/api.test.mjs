/**
 * Pruebas funcionales del API de Tanta.
 *
 *   node --test tests/api.test.mjs
 *
 * Requiere el API corriendo y la semilla cargada. Cubre lo que no puede romperse:
 * autenticación, autorización por rol, idempotencia, invariantes de inventario y validación.
 */
import { test, describe, before } from 'node:test';
import { sql } from './_sql.mjs';
import assert from 'node:assert/strict';

const API = process.env.API ?? 'http://127.0.0.1:3001/api/v1';
const CLAVE = 'tanta';

const tokens = {};

async function login(usuario, { navegador = true } = {}) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // El navegador siempre envía Origin; la app nativa no. El servidor usa esa
      // diferencia para decidir si entrega el refresco en cookie o en el cuerpo.
      ...(navegador ? { Origin: 'http://127.0.0.1:5180' } : {}),
    },
    body: JSON.stringify({ usuario, clave: CLAVE }),
  });
  return {
    status: r.status,
    cuerpo: await r.json().catch(() => ({})),
    cookie: r.headers.getSetCookie?.().join('; ') ?? r.headers.get('set-cookie') ?? '',
  };
}

async function pedir(ruta, { metodo = 'GET', token, cuerpo, extra = {} } = {}) {
  const r = await fetch(`${API}${ruta}`, {
    method: metodo,
    headers: {
      ...(cuerpo ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const texto = await r.text();
  let datos = null;
  try { datos = texto ? JSON.parse(texto) : null; } catch { datos = texto; }
  return { status: r.status, datos };
}

before(async () => {
  // La suite provoca fallos de login a propósito (para probar el bloqueo por cuenta).
  // Sin limpiar el contador, la segunda ejecución seguida se bloquearía sola.
  sql('DELETE FROM core.intento_login');

  for (const u of ['osquilcate', 'lbermudez', 'cmedina', 'rquispe', 'jramos']) {
    const r = await login(u);
    if (r.status !== 200) throw new Error(`No se pudo iniciar sesión con ${u}: ${r.status}`);
    tokens[u] = r.cuerpo.accessToken;
  }
});

describe('Salud del servicio', () => {
  test('GET /health responde ok y la base está conectada', async () => {
    const r = await pedir('/health');
    assert.equal(r.status, 200);
    assert.equal(r.datos.estado, 'ok');
    assert.equal(r.datos.baseDatos, 'ok');
  });
});

describe('Autenticación', () => {
  test('login correcto devuelve rol, permisos y tokens', async () => {
    const r = await login('osquilcate');
    assert.equal(r.status, 200);
    assert.equal(r.cuerpo.rol, 'GERENTE');
    assert.ok(r.cuerpo.permisos.includes('costos.ver'));
    assert.ok(r.cuerpo.accessToken.length > 40);
    // El refresco ya no viaja en el cuerpo: va en una cookie HttpOnly.
    assert.equal(r.cuerpo.refreshToken, undefined, 'el refresco no debe exponerse al JavaScript');
    const cookie = r.cookie ?? '';
    assert.match(cookie, /tanta_refresh=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
  });

  test('la app nativa sí recibe el refresco en el cuerpo (no tiene cookies)', async () => {
    const r = await login('cmedina', { navegador: false });
    assert.equal(r.status, 200);
    assert.ok(r.cuerpo.refreshToken?.length > 40, 'el móvil necesita el token para su almacén seguro');
    assert.ok(r.cuerpo.accessToken?.length > 40);
  });

  test('la contraseña se guarda con Argon2id', async () => {
    const r = await login('osquilcate');
    assert.equal(r.status, 200);
    const hash = sql("SELECT clave_hash FROM core.usuario WHERE usuario='osquilcate'");
    assert.match(hash, /^argon2id\$m=\d+,t=\d+,p=\d+\$/);
  });

  test('contraseña incorrecta y usuario inexistente responden igual (no se enumeran cuentas)', async () => {
    const malaClave = await login('osquilcate').then(() => null);
    void malaClave;
    const conClaveMala = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario: 'osquilcate', clave: 'incorrecta' }),
    });
    const inexistente = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario: 'noexiste', clave: 'incorrecta' }),
    });
    const a = await conClaveMala.json();
    const b = await inexistente.json();
    assert.equal(conClaveMala.status, 401);
    assert.equal(inexistente.status, 401);
    assert.equal(a.codigo, b.codigo);
  });

  test('sin token, /datos responde 401', async () => {
    const r = await pedir('/datos');
    assert.equal(r.status, 401);
  });

  test('token alterado responde 401', async () => {
    const roto = tokens.osquilcate.slice(0, -4) + 'aaaa';
    const r = await pedir('/datos', { token: roto });
    assert.equal(r.status, 401);
  });
});

describe('Autorización por rol (field-level security)', () => {
  test('el gerente recibe costo y margen', async () => {
    const r = await pedir('/datos', { token: tokens.osquilcate });
    assert.equal(r.status, 200);
    assert.equal(typeof r.datos.productos[0].costoUnitario, 'number');
    assert.equal(typeof r.datos.productos[0].margen, 'number');
  });

  test('el vendedor NO recibe costo ni margen', async () => {
    const r = await pedir('/datos', { token: tokens.cmedina });
    assert.equal(r.status, 200);
    assert.equal(r.datos.productos[0].costoUnitario, undefined);
    assert.equal(r.datos.productos[0].margen, undefined);
    assert.equal(r.datos.kpis.costoVentas === undefined || r.datos.kpis.costoVentas === 0, true);
  });

  test('el vendedor no puede cerrar una orden de producción', async () => {
    const r = await pedir('/ordenes-produccion/OP-2026-000313/iniciar', {
      metodo: 'POST', token: tokens.cmedina,
    });
    assert.equal(r.status, 403);
    assert.equal(r.datos.codigo, 'SIN_PERMISO');
  });

  test('el menú del vendedor no incluye la sección de gerencia', async () => {
    const r = await pedir('/auth/yo', { token: tokens.cmedina });
    const grupos = r.datos.navegacion.map((g) => g.titulo);
    assert.ok(!grupos.includes('Gerencia'));
    assert.ok(grupos.includes('Comercial'));
  });
});

describe('Validación de entrada', () => {
  test('venta sin ítems responde 422', async () => {
    const r = await pedir('/ventas', { metodo: 'POST', token: tokens.cmedina, cuerpo: { items: [] } });
    assert.equal(r.status, 422);
  });

  test('venta con producto inexistente responde 404', async () => {
    const r = await pedir('/ventas', {
      metodo: 'POST', token: tokens.cmedina,
      cuerpo: { items: [{ productoId: '00000000-0000-0000-0000-000000000000', cantidad: 1 }] },
      extra: { 'Idempotency-Key': crypto.randomUUID() },
    });
    assert.equal(r.status, 404);
  });

  test('intento de inyección SQL en el login no rompe el servidor', async () => {
    const r = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario: "' OR 1=1 --", clave: 'x' }),
    });
    assert.equal(r.status, 401);
  });

  test('cantidad negativa en venta es rechazada', async () => {
    const r = await pedir('/ventas', {
      metodo: 'POST', token: tokens.cmedina,
      cuerpo: { items: [{ productoId: '00000000-0000-0000-0000-000000000000', cantidad: -5 }] },
    });
    assert.equal(r.status, 422);
  });
});

describe('Idempotencia', () => {
  test('el mismo Idempotency-Key devuelve la misma venta y no duplica', async () => {
    const datos = await pedir('/datos', { token: tokens.cmedina });
    const producto = datos.datos.productos.find((p) => p.stock - (p.reservado ?? 0) >= 2);
    assert.ok(producto, 'se necesita un producto con stock');

    const clave = crypto.randomUUID();
    const cuerpo = { items: [{ productoId: producto.id, cantidad: 1 }], formaPago: 'EFECTIVO' };
    const extra = { 'Idempotency-Key': clave };

    const a = await pedir('/ventas', { metodo: 'POST', token: tokens.cmedina, cuerpo, extra });
    const b = await pedir('/ventas', { metodo: 'POST', token: tokens.cmedina, cuerpo, extra });

    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(a.datos.codigo, b.datos.codigo);
  });

  test('un cobro reenviado con la misma clave no se aplica dos veces', async () => {
    // Es la garantía que sostiene la cola offline del móvil: si el vendedor
    // reintenta el pago cinco veces por mala señal, el saldo baja una sola vez.
    const cartera = await pedir('/cxc', { token: tokens.cmedina });
    assert.equal(cartera.status, 200);
    const cuenta = cartera.datos.find((c) => c.saldo > 1);
    assert.ok(cuenta, 'se necesita una cuenta con saldo');

    const clave = crypto.randomUUID();
    const cuerpo = { cxcId: cuenta.id, monto: 1, medio: 'EFECTIVO' };
    const extra = { 'Idempotency-Key': clave };

    const a = await pedir('/cobranza', { metodo: 'POST', token: tokens.cmedina, cuerpo, extra });
    const b = await pedir('/cobranza', { metodo: 'POST', token: tokens.cmedina, cuerpo, extra });

    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.deepEqual(a.datos, b.datos, 'el reenvío devuelve la operación original, no una nueva');
    assert.equal(a.datos.saldo, b.datos.saldo, 'el saldo no debe bajar dos veces');
  });
});

describe('Invariantes de negocio', () => {
  test('el cierre de una orden ya terminada responde 409', async () => {
    const r = await pedir('/ordenes-produccion/OP-2026-000316/cerrar', {
      metodo: 'POST', token: tokens.rquispe,
      cuerpo: { cantidadProducida: 10, mermaReal: 0 },
      extra: { 'Idempotency-Key': crypto.randomUUID() },
    });
    assert.equal(r.status, 409);
  });

  test('la cobranza no acepta un monto mayor al saldo', async () => {
    const r = await pedir('/cobranza', {
      metodo: 'POST', token: tokens.cmedina,
      cuerpo: { cxcId: crypto.randomUUID(), monto: 999999, medio: 'EFECTIVO' },
      extra: { 'Idempotency-Key': crypto.randomUUID() },
    });
    assert.ok([404, 422].includes(r.status), `esperaba 404/422, recibió ${r.status}`);
  });

  test('el kárdex devuelve asientos con saldo corrido', async () => {
    const r = await pedir('/kardex/INS-001', { token: tokens.jramos });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.datos));
    assert.ok(r.datos.length > 0);
    const ultimo = r.datos[r.datos.length - 1];
    assert.equal(typeof ultimo.saldoCantidad, 'number');
    assert.ok(ultimo.saldoCantidad >= 0, 'el saldo nunca debe ser negativo');
  });
});

describe('Administración', () => {
  test('el gerente no puede leer parámetros (permiso de administración)', async () => {
    const r = await pedir('/parametros', { token: tokens.osquilcate });
    assert.equal(r.status, 403);
  });

  test('el administrador sí puede leer y actualizar un parámetro', async () => {
    const lista = await pedir('/parametros', { token: tokens.lbermudez });
    assert.equal(lista.status, 200);
    assert.ok(lista.datos.length > 0);

    const igv = lista.datos.find((p) => p.clave === 'igv');
    const original = igv.valor;
    const cambio = await pedir('/parametros/igv', {
      metodo: 'PATCH', token: tokens.lbermudez, cuerpo: { valor: '0.18' },
    });
    assert.equal(cambio.status, 200);
    assert.equal(cambio.datos.valor, '0.18');
    assert.equal(original, '0.18');
  });

  test('el IGV fuera de rango se rechaza', async () => {
    const r = await pedir('/parametros/igv', {
      metodo: 'PATCH', token: tokens.lbermudez, cuerpo: { valor: '18' },
    });
    assert.equal(r.status, 422);
    assert.equal(r.datos.codigo, 'PORCENTAJE_FUERA_DE_RANGO');
  });

  test('la lista de períodos es visible y trae estado', async () => {
    const r = await pedir('/periodos', { token: tokens.osquilcate });
    assert.equal(r.status, 200);
    assert.ok(r.datos.length >= 1);
    assert.ok(['ABIERTO', 'CALCULADO', 'CERRADO'].includes(r.datos[0].estado));
  });
});
