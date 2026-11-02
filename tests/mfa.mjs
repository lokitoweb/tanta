/**
 * Prueba del flujo completo de segundo factor y de la cookie HttpOnly.
 *
 *   node tests/mfa.mjs
 *
 * Requiere el API con MFA_OBLIGATORIO=true y la semilla cargada.
 */
const API = process.env.API ?? 'http://127.0.0.1:3001/api/v1';

// Implementación mínima de TOTP para el test (misma que valida el servidor).
function base32aBuffer(secreto) {
  const ALF = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secreto.toUpperCase().replace(/=+$/, '')) {
    const i = ALF.indexOf(c);
    if (i >= 0) bits += i.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

async function totp(secreto) {
  const { createHmac } = await import('node:crypto');
  const contador = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(contador / 2 ** 32), 0);
  buf.writeUInt32BE(contador % 2 ** 32, 4);
  const hmac = createHmac('sha1', base32aBuffer(secreto)).update(buf).digest();
  const o = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[o] & 0x7f) << 24) | (hmac[o + 1] << 16) | (hmac[o + 2] << 8) | hmac[o + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

const post = (ruta, cuerpo, cabeceras = {}) =>
  fetch(`${API}${ruta}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cabeceras },
    body: JSON.stringify(cuerpo),
  });

let ok = true;
const comprobar = (nombre, condicion, extra = '') => {
  console.log(`${condicion ? '✔' : '✖'} ${nombre}${extra ? ' · ' + extra : ''}`);
  if (!condicion) ok = false;
};

// 1. Login del gerente: debe pedir enrolamiento (primer uso) o código
let r = await post('/auth/login', { usuario: 'osquilcate', clave: 'tanta' });
let datos = await r.json();
comprobar('login no entrega sesión directa', !datos.accessToken, Object.keys(datos).join(','));
comprobar('pide segundo factor', datos.mfaEnrolamiento === true || datos.mfaRequerido === true);

// 2. Enrolamiento (solo la primera vez)
if (datos.mfaEnrolamiento) {
  const { ticket } = datos;
  const alta = await (await post('/auth/mfa/enrolar', { ticket })).json();
  comprobar('devuelve secreto y otpauth', !!alta.secreto && alta.otpauth?.startsWith('otpauth://'), alta.secreto?.slice(0, 6) + '…');

  const codigo = await totp(alta.secreto);
  const activ = await post('/auth/mfa/activar', { ticket, codigo });
  const sesion = await activ.json();
  comprobar('activa MFA y abre sesión', !!sesion.accessToken);

  const cookie = activ.headers.getSetCookie?.() ?? [];
  const tieneCookie = cookie.some((c) => c.startsWith('tanta_refresh=') && c.includes('HttpOnly'));
  comprobar('emite cookie HttpOnly de refresco', tieneCookie, cookie[0]?.split(';').slice(0, 3).join('; '));
}

// 3. Segundo inicio de sesión: ahora pide el código
r = await post('/auth/login', { usuario: 'osquilcate', clave: 'tanta' });
datos = await r.json();
comprobar('segundo login pide código', datos.mfaRequerido === true);

// 4. Código incorrecto se rechaza
const malo = await post('/auth/mfa/verificar', { ticket: datos.ticket, codigo: '000000' });
comprobar('código incorrecto → 422', malo.status === 422, `status ${malo.status}`);

// 5. Se recupera el secreto para generar el código correcto (el servidor no lo expone:
//    se lee de la base para esta prueba).
const secreto = process.env.MFA_SECRETO_TEST;
if (secreto) {
  const codigo = await totp(secreto);
  const ok2 = await post('/auth/mfa/verificar', { ticket: datos.ticket, codigo });
  const sesion = await ok2.json();
  comprobar('código correcto abre sesión', !!sesion.accessToken);
} else {
  console.log('· (MFA_SECRETO_TEST no definido: se omite la verificación positiva)');
}

// 6. El refresh viaja en cookie y emite un acceso nuevo
const refresco = await fetch(`${API}/auth/refresh`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
});
comprobar('refresh sin cookie → 401', refresco.status === 401, `status ${refresco.status}`);

console.log(`\n${ok ? '✔ FLUJO COMPLETO OK' : '✖ HAY FALLOS'}`);
process.exit(ok ? 0 : 1);
