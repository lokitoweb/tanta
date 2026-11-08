// node --test tests/permisos-excel.test.mjs  (API en 127.0.0.1:3001 con la semilla)
// Matriz de permisos del INF-TEC-001 (hoja Actores_Permisos): qué puede y qué no puede cada rol.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql, sqlScript } from './_sql.mjs';

const B = process.env.API ?? 'http://127.0.0.1:3001/api/v1';
const sesiones = new Map();
// Si el límite antiabuso de login responde 429 (suite completa en local), espera y reintenta.
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

const permisos = (rol) => new Set(sql(`SELECT string_agg(permiso_id, ',') FROM core.rol_permiso WHERE rol_id = '${rol}'`).split(','));

// [rol, debe tener, no debe tener] — cada permiso con la fila de la matriz que lo exige.
const MATRIZ = [
  ['ADMINISTRADOR', ['usuarios.gestionar', 'maestros.editar', 'parametros.gestionar', 'proveedores.gestionar', 'compras.registrar', 'compras.autorizar', 'compras.anular', 'ventas.anular', 'auditoria.ver', 'dashboard.ver'],
    ['ventas.registrar', 'descuentos.aprobar', 'conteo.aprobar', 'inventario.mover']],
  // Informe 03: el Administrador también verifica compras (no encontraba la opción).
  ['GERENTE', ['usuarios.ver', 'clientes.ver', 'maestros.ver', 'costos.ver', 'dashboard.ver', 'auditoria.ver', 'descuentos.aprobar', 'conteo.aprobar', 'ventas.anular', 'cobranza.ver'],
    ['usuarios.gestionar', 'maestros.editar', 'clientes.gestionar', 'ventas.registrar', 'inventario.mover', 'compras.registrar']],
  ['PRODUCCION', ['produccion.planificar', 'produccion.ejecutar', 'maestros.ver', 'recetas.ver', 'inventario.ver', 'pedidos.ver'],
    ['costos.ver', 'maestros.editar', 'inventario.mover', 'ventas.registrar', 'cobranza.ver']],
  // Compra de insumos (informe v1.1, sección 7): Almacén verifica lo recibido; registra Compras.
  ['ALMACEN', ['requisiciones.atender', 'compras.verificar', 'compras.ver', 'inventario.mover', 'inventario.ver', 'maestros.ver', 'pedidos.ver'],
    ['compras.registrar', 'compras.anular', 'proveedores.gestionar', 'conteo.aprobar', 'costos.ver', 'ventas.registrar', 'pedidos.gestionar']],
  ['COMPRAS', ['compras.registrar', 'compras.ver', 'insumos.gestionar', 'proveedores.gestionar', 'inventario.ver'],
    ['compras.verificar', 'compras.autorizar', 'compras.anular', 'costos.ver', 'inventario.mover', 'ventas.registrar']],
  ['VENDEDOR', ['pedidos.gestionar', 'pedidos.crear', 'ventas.registrar', 'cobranza.registrar', 'clientes.gestionar', 'inventario.ver'],
    ['costos.ver', 'descuentos.aprobar', 'ventas.anular', 'inventario.mover', 'dashboard.ver']],
  ['CLIENTE', ['catalogo.ver', 'pedidos.crear'],
    ['pedidos.ver', 'cobranza.ver', 'clientes.ver', 'costos.ver', 'inventario.ver']],
];

for (const [rol, si, no] of MATRIZ) {
  test(`matriz: ${rol}`, () => {
    const p = permisos(rol);
    for (const x of si) assert.ok(p.has(x), `${rol} debe tener ${x}`);
    for (const x of no) assert.ok(!p.has(x), `${rol} no debe tener ${x}`);
  });
}

test('matriz en la API: cada rol solo hace lo suyo', async () => {
  const ven = await login('cmedina'), ger = await login('osquilcate'), alm = await login('jramos'), pro = await login('rquispe');
  // Fila 5: el Vendedor crea clientes; el Gerente solo los consulta.
  const doc = String(10_000_000 + Math.floor(Math.random() * 89_999_999));
  const c = await api(ven, 'POST', '/clientes', { nombre: 'Cliente del vendedor', docTipo: 'DNI', docNumero: doc, telefono: '', email: '', direccion: '', listaPrecio: 'MINORISTA', diasCredito: 0, limiteCredito: 0 });
  assert.equal(c.s, 201, JSON.stringify(c.b));
  assert.equal((await api(ger, 'POST', '/clientes', { nombre: 'No', docTipo: 'DNI', docNumero: '', telefono: '', email: '', direccion: '', listaPrecio: 'MINORISTA', diasCredito: 0, limiteCredito: 0 })).s, 403);
  // Fila 1: el Gerente ve los usuarios en sus datos, sin poder crearlos.
  const d = await api(ger, 'GET', '/datos');
  assert.ok(d.b.usuarios.length > 0, 'el Gerente consulta usuarios');
  assert.equal((await api(ger, 'POST', '/usuarios', { nombre: 'X', usuario: 'x' + Date.now(), clave: 'Clave-Segura-123', rol: 'VENDEDOR' })).s, 403);
  // Fila 6: Almacén y Gerente consultan proveedores.
  assert.equal((await api(alm, 'GET', '/proveedores')).s, 200);
  assert.equal((await api(ger, 'GET', '/proveedores')).s, 200);
  assert.equal((await api(pro, 'GET', '/proveedores')).s, 200, 'Producción consulta maestros');
  assert.equal((await api(ven, 'GET', '/proveedores')).s, 403);
  // Fila 13: Producción no toca el inventario.
  assert.equal((await api(pro, 'POST', '/conteos', { items: [] })).s, 403);
  // Fila 20: el Vendedor no recibe costos.
  const dv = await api(ven, 'GET', '/datos');
  assert.ok(!JSON.stringify(dv.b.productos ?? []).includes('"costoUnitario"'), 'sin costo para el vendedor');
});

after(() => sqlScript("UPDATE core.cliente SET estado = 'INACTIVO' WHERE nombre = 'Cliente del vendedor';"));
