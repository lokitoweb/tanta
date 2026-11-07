// node --test tests/sistema.test.mjs  (API en 127.0.0.1:3001 con la semilla)
// Configuración central, perfil, versión móvil, roles y las barreras contra escalada de privilegios.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from './_sql.mjs';

// Estas pruebas cambian la Configuración: se guarda tal cual y se restaura al final,
// para no borrar el dominio, el repositorio de la APK ni el webhook de quien las corre.
let configOriginal = '';
before(() => { configOriginal = sql("SELECT coalesce(json_agg(json_build_object('clave', clave, 'valor', valor)), '[]') FROM core.configuracion"); });
after(() => {
  sql(`UPDATE core.configuracion c SET valor = x.valor FROM json_to_recordset('${configOriginal.replace(/'/g, "''")}') AS x(clave text, valor jsonb) WHERE c.clave = x.clave`);
});

const B = process.env.API ?? 'http://127.0.0.1:3001/api/v1';
const login = async (u, c = 'tanta') => (await (await fetch(B + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario: u, clave: c }) })).json()).accessToken;
const api = (t, m, ruta, body) => fetch(B + ruta, {
  method: m, headers: { ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));
// PNG 1x1 válido
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

test('configuración: pública sin secretos, admin enmascarado, validación', async () => {
  const sa = await login('superadmin');
  const pub = await api(null, 'GET', '/config/publica');
  assert.equal(pub.s, 200);
  assert.ok(pub.b.marca.nombreApp && !('cuentaServicio' in (pub.b.firebase ?? {})));

  // Fondos del ingreso: se administran en la marca y salen en la configuración pública, sin pasar del tope.
  const fondo = '00000000-0000-4000-8000-000000000001';
  const { fondosIngreso: _f, fondoSegundos: _s, ...marca } = pub.b.marca;
  assert.equal((await api(sa, 'PUT', '/sistema/config/marca', { ...marca, fondosIngreso: [fondo], fondoSegundos: 9 })).s, 200);
  const conFondo = (await api(null, 'GET', '/config/publica')).b.marca;
  assert.deepEqual([conFondo.fondosIngreso, conFondo.fondoSegundos], [[fondo], 9]);
  assert.equal((await api(sa, 'PUT', '/sistema/config/marca', { ...marca, fondosIngreso: Array(9).fill(fondo) })).s, 422);
  assert.equal((await api(sa, 'PUT', '/sistema/config/marca', marca)).s, 200);

  const wh = await api(sa, 'PUT', '/sistema/config/webhook', { habilitado: false, url: 'https://example.com/hook', secreto: 'abc123', eventos: ['venta.creada'] });
  assert.equal(wh.s, 200);
  assert.equal(wh.b.secreto, '••••••••', 'el secreto nunca vuelve al navegador');
  const cfg = await api(sa, 'GET', '/sistema/config');
  assert.equal(cfg.b.webhook.secreto, '••••••••');
  // En la base el secreto está cifrado (AES-256-GCM), no en claro.
  const enBase = sql("SELECT valor->>'secreto' FROM core.configuracion WHERE clave='webhook'");
  assert.ok(enBase.startsWith('enc:v1:') && !enBase.includes('abc123'), 'secreto cifrado en reposo');

  assert.equal((await api(sa, 'PUT', '/sistema/config/webhook', { habilitado: true, url: 'http://inseguro.com', secreto: '', eventos: [] })).s, 422, 'solo https');
  assert.equal((await api(sa, 'PUT', '/sistema/config/movil', { versionActual: '1.0.0', versionMinima: '2.0.0', urlAndroid: '', urlIos: '', mensajeActualizacion: 'Actualiza ya' })).s, 422);
  assert.equal((await api(await login('osquilcate'), 'GET', '/sistema/config')).s, 403, 'el gerente no configura el sistema');
});

test('versión móvil: el sistema reconoce apps desactualizadas', async () => {
  const sa = await login('superadmin');
  await api(sa, 'PUT', '/sistema/config/movil', { versionActual: '1.2.0', versionMinima: '1.1.0', urlAndroid: 'https://play.google.com/store/apps/details?id=pe.tanta', urlIos: '', mensajeActualizacion: 'Actualiza para continuar.' });
  const v = await login('cmedina');
  const vieja = await api(v, 'POST', '/dispositivo', { instalacion: randomUUID(), plataforma: 'android', versionApp: '1.0.5' });
  assert.equal(vieja.b.actualizacionObligatoria, true);
  const nueva = await api(v, 'POST', '/dispositivo', { instalacion: randomUUID(), plataforma: 'android', versionApp: '1.2.0' });
  assert.equal(nueva.b.actualizacionObligatoria, false);
  assert.equal(nueva.b.actualizacionDisponible, false);
  const lista = await api(sa, 'GET', '/sistema/dispositivos');
  assert.ok(lista.b.some((d) => d.version_app === '1.0.5' && d.desactualizada));
  await api(sa, 'PUT', '/sistema/config/movil', { versionActual: '1.0.0', versionMinima: '1.0.0', urlAndroid: '', urlIos: '', mensajeActualizacion: 'Hay una nueva versión de Tanta. Actualiza para continuar.' });
});

test('perfil: datos, foto validada, cambio de clave y eliminación de cuenta', async () => {
  // Usuario temporal: no se tocan las cuentas de la semilla que usan las otras pruebas.
  const sa = await login('superadmin');
  const usuario = 'temp' + Date.now();
  assert.equal((await api(sa, 'POST', '/usuarios', { nombre: 'Temporal Prueba', usuario, clave: 'ClaveInicial1', rol: 'VENDEDOR' })).s, 201);
  const t = await login(usuario, 'ClaveInicial1');

  assert.equal((await api(t, 'PATCH', '/perfil', { nombre: 'Temporal Prueba', email: 'temp@tanta.pe', telefono: '+51 999 111 222' })).s, 403, 'cambiar el correo pide la contraseña');
  assert.equal((await api(t, 'PATCH', '/perfil', { nombre: 'Temporal Prueba', email: 'temp@tanta.pe', telefono: '+51 999 111 222', clave: 'ClaveInicial1' })).s, 200);
  assert.equal((await api(t, 'PATCH', '/perfil', { nombre: 'Temporal Dos', email: 'temp@tanta.pe', telefono: '' })).s, 200, 'sin cambiar el correo no pide contraseña');
  assert.equal((await api(t, 'POST', '/auth/mfa/recuperacion', {})).s, 403, 'regenerar códigos pide la contraseña');
  assert.equal((await api(t, 'GET', '/perfil')).b.email, 'temp@tanta.pe');
  assert.equal((await api(t, 'PATCH', '/perfil', { nombre: 'J', email: 'x', telefono: '<script>' })).s, 422);

  const foto = await api(t, 'PUT', '/perfil/foto', { base64: PNG });
  assert.equal(foto.s, 200);
  assert.equal((await fetch(B + foto.b.fotoUrl)).headers.get('content-type'), 'image/png');
  assert.equal((await api(t, 'PUT', '/perfil/foto', { base64: Buffer.from('<svg onload=alert(1)>').toString('base64') })).s, 415, 'no acepta SVG/HTML disfrazado');

  assert.equal((await api(t, 'POST', '/perfil/clave', { actual: 'mala', nueva: 'NuevaClave2026' })).s, 403);
  assert.equal((await api(t, 'POST', '/perfil/clave', { actual: 'ClaveInicial1', nueva: 'corta' })).s, 422);
  assert.equal((await api(t, 'POST', '/perfil/clave', { actual: 'ClaveInicial1', nueva: 'NuevaClave2026' })).s, 200);
  const t2 = await login(usuario, 'NuevaClave2026');
  assert.ok(t2, 'entra con la clave nueva');

  // App Store 5.1.1(v): el usuario elimina su cuenta desde la app.
  assert.equal((await api(t2, 'DELETE', '/perfil', { clave: 'mala' })).s, 403);
  assert.equal((await api(t2, 'DELETE', '/perfil', { clave: 'NuevaClave2026' })).s, 200);
  assert.equal(await login(usuario, 'NuevaClave2026'), undefined, 'la cuenta eliminada ya no entra');
  assert.equal((await fetch(B + foto.b.fotoUrl)).status, 404, 'la foto se borró');
});

test('escalada de privilegios bloqueada', async () => {
  const admin = await login('lbermudez');
  assert.equal((await api(admin, 'POST', '/usuarios', { nombre: 'Intruso', usuario: 'intruso' + Date.now(), clave: 'claveSegura1', rol: 'SUPERADMIN' })).s, 403, 'admin no crea superadmins');
  const sa = await login('superadmin');
  const roles = await api(sa, 'GET', '/sistema/roles');
  const superId = (await api(sa, 'GET', '/perfil')).b.id;
  assert.equal((await api(admin, 'PATCH', `/usuarios/${superId}/clave`, { clave: 'robada12345' })).s, 403, 'admin no cambia la clave del superadmin');
  assert.equal((await api(admin, 'PATCH', `/usuarios/${superId}/estado`, { estado: 'BLOQUEADO' })).s, 403);
  assert.equal((await api(admin, 'POST', '/usuarios', { nombre: 'Intruso', usuario: 'intruso' + Date.now(), clave: 'claveSegura1', rol: 'GERENTE' })).s, 403, 'admin no crea gerentes');
  assert.equal((await api(admin, 'POST', '/usuarios', { nombre: 'Intruso', usuario: 'intruso' + Date.now(), clave: 'claveSegura1', rol: 'ADMINISTRADOR' })).s, 403, 'admin no crea pares');
  const gerenteId = (await api(await login('osquilcate'), 'GET', '/perfil')).b.id;
  assert.equal((await api(admin, 'PATCH', `/usuarios/${gerenteId}/clave`, { clave: 'robada12345' })).s, 403, 'admin no cambia la clave del gerente');
  assert.ok(!(await api(admin, 'GET', '/roles-asignables')).b.some((r) => ['SUPERADMIN', 'GERENTE', 'ADMINISTRADOR'].includes(r.id)));
  assert.equal((await api(sa, 'PUT', '/sistema/roles/SUPERADMIN/permisos', { permisos: [] })).s, 409, 'superadmin no puede quedarse sin permisos');
  assert.ok(roles.b.roles.length >= 8);
});

test('roles editables en caliente', async () => {
  const sa = await login('superadmin');
  const { b } = await api(sa, 'GET', '/sistema/roles');
  const actuales = b.asignados.filter((x) => x.startsWith('VENDEDOR:')).map((x) => x.split(':')[1]);
  await api(sa, 'PUT', '/sistema/roles/VENDEDOR/permisos', { permisos: actuales.filter((p) => p !== 'cobranza.ver') });
  const v = await login('cmedina');
  assert.equal((await api(v, 'GET', '/cxc')).s, 403, 'quitar el permiso aplica al instante');
  await api(sa, 'PUT', '/sistema/roles/VENDEDOR/permisos', { permisos: actuales });
  assert.equal((await api(await login('cmedina'), 'GET', '/cxc')).s, 200);
});

test('si PostgreSQL corta las conexiones, la API sigue viva y se reconecta', async () => {
  assert.ok(await login('cmedina'), 'hay conexiones abiertas');
  sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'tanta-api' AND datname = current_database()");
  await new Promise((ok) => setTimeout(ok, 500));
  assert.ok(await login('cmedina'), 'la API responde con conexiones nuevas');
});
