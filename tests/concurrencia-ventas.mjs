/**
 * Prueba puntual: N ventas simultáneas del mismo vendedor.
 * Antes del arreglo, el correlativo se calculaba con count(*)+1 y las ventas
 * concurrentes chocaban con venta_codigo_key (500 en el 10-22 %).
 *
 *   node tests/concurrencia-ventas.mjs 40
 */
const API = process.env.API ?? 'http://127.0.0.1:3001/api/v1';
const N = Number(process.argv[2] ?? 40);

const login = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ usuario: 'cmedina', clave: 'tanta' }),
}).then((r) => r.json());

const cab = { Authorization: `Bearer ${login.accessToken}` };
const datos = await fetch(`${API}/datos`, { headers: cab }).then((r) => r.json());
const productos = datos.productos.filter((p) => p.stock > 2).slice(0, N);
if (productos.length < N) console.warn(`solo hay ${productos.length} productos con stock`);

console.log(`Lanzando ${productos.length} ventas simultáneas…`);
const t0 = Date.now();

const respuestas = await Promise.all(
  productos.map((p) =>
    fetch(`${API}/ventas`, {
      method: 'POST',
      headers: { ...cab, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ items: [{ productoId: p.id, cantidad: 1 }], formaPago: 'EFECTIVO' }),
    }).then(async (r) => ({ status: r.status, cuerpo: await r.json().catch(() => ({})) })),
  ),
);

const ms = Date.now() - t0;
const porEstado = {};
for (const r of respuestas) porEstado[r.status] = (porEstado[r.status] ?? 0) + 1;

const codigos = respuestas.filter((r) => r.status === 201).map((r) => r.cuerpo.codigo);
const unicos = new Set(codigos);

console.log(`\n${productos.length} ventas en ${ms} ms`);
console.log('Estados:', porEstado);
console.log(`Códigos emitidos: ${codigos.length} · únicos: ${unicos.size}`);

const fallos = respuestas.filter((r) => r.status >= 500);
if (fallos.length) {
  console.log('\nFallos 5xx:', fallos.slice(0, 3).map((f) => f.cuerpo.detail ?? f.cuerpo.codigo));
}

const ok = fallos.length === 0 && unicos.size === codigos.length;
console.log(`\n${ok ? '✔ APROBADO' : '✖ FALLÓ'}: ${ok ? 'sin errores 5xx y sin códigos duplicados' : 'hay colisiones o errores'}`);
process.exit(ok ? 0 : 1);
