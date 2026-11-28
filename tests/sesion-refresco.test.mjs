// node tests/correr.mjs tests/sesion-refresco.test.mjs
// Renovación de sesión en la app: si la respuesta de una renovación se pierde (mala señal, reinicio del API) y el
// celular reintenta con el mismo token, no se cierran todas las sesiones; un token cerrado con «Salir» sí es reuso.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from './_sql.mjs';

const B = process.env.API ?? 'http://127.0.0.1:3001/api/v1';
const post = (ruta, body, token) => fetch(B + ruta, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body),
}).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));
const entrar = async () => {
  for (let i = 0; i < 10; i++) {
    const r = await post('/auth/login', { usuario: 'superadmin', clave: 'tanta', recordar: true });
    if (r.s !== 429) return r.b;
    await new Promise((ok) => setTimeout(ok, 7000));
  }
  throw new Error('login bloqueado por el límite');
};
const renovar = (t) => post('/auth/refresh', { refreshToken: t });

test('Renovación perdida: reintentar con el mismo token entrega una sesión nueva y anula la que no llegó (durante la gracia)', async () => {
  const s = await entrar();
  assert.ok(s.refreshToken, 'la app recibe el refresco en el cuerpo');
  const r1 = await renovar(s.refreshToken); // esta respuesta «no llega» al celular
  assert.equal(r1.s, 200);
  const r2 = await renovar(s.refreshToken); // el celular reintenta con el token anterior
  assert.equal(r2.s, 200, JSON.stringify(r2.b));
  assert.ok(r2.b.accessToken && r2.b.refreshToken);
  assert.equal(sql(`SELECT count(*) FROM core.refresh_token WHERE token_hash = encode(sha256('${r1.b.refreshToken}'::bytea), 'hex') AND revocado_en IS NOT NULL`), '1', 'el token que no llegó queda anulado');
  assert.equal((await renovar(r2.b.refreshToken)).s, 200, 'la sesión sigue viva');
});

test('Pasada la gracia, o tras «Salir», usar un token viejo cierra todas las sesiones', async () => {
  const s = await entrar();
  const r1 = await renovar(s.refreshToken);
  sql(`UPDATE core.refresh_token SET revocado_en = now() - interval '10 minutes' WHERE token_hash = encode(sha256('${s.refreshToken}'::bytea), 'hex')`);
  const reuso = await renovar(s.refreshToken);
  assert.equal(reuso.s, 401);
  assert.equal(reuso.b.codigo, 'SESION_COMPROMETIDA');
  assert.equal((await renovar(r1.b.refreshToken)).s, 401, 'se cerró la familia');

  const t = await entrar();
  assert.equal((await post('/auth/logout', { refreshToken: t.refreshToken }, t.accessToken)).s < 300, true);
  const tras = await renovar(t.refreshToken);
  assert.equal(tras.s, 401);
  assert.equal(tras.b.codigo, 'SESION_COMPROMETIDA');
});
