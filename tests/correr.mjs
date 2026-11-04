// node tests/correr.mjs [archivos…]  ·  pnpm pruebas
// Corre las pruebas contra la base y la API de PRUEBAS (tanta_test, puerto 3002), nunca contra la que se usa
// a diario (tanta, 3001). Antes: levantar la API de pruebas (configuración "api-pruebas" o
// `node --env-file-if-exists=../../.env --env-file=pruebas.env dist/src/server.js` en apps/api).
// En CI no se usa: allí la base ya es desechable y las variables vienen del workflow.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

process.env.API ??= 'http://127.0.0.1:3002/api/v1';
process.env.PGDATABASE ??= 'tanta_test';
if (process.env.PGDATABASE === 'tanta') {
  console.error('Las pruebas no se corren contra la base de uso diario (tanta). Usa tanta_test.');
  process.exit(1);
}
const salud = await fetch(process.env.API + '/health').then((r) => r.ok).catch(() => false);
if (!salud) {
  console.error(`La API de pruebas no responde en ${process.env.API}. Levántala con la configuración "api-pruebas".`);
  process.exit(1);
}
const archivos = process.argv.slice(2).length ? process.argv.slice(2)
  : readdirSync('tests').filter((f) => f.endsWith('.test.mjs')).map((f) => `tests/${f}`);
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...archivos], { stdio: 'inherit', env: process.env });
process.exit(r.status ?? 1);
