import type { FastifyInstance } from 'fastify';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';
import { q, tx, uno } from '../db.js';
import { autenticar, exigir, error, hashClave, verificarClave } from '../seguridad.js';
import { auditar } from '../auditoria.js';
import { recordar, invalidar } from '../cache.js';
import { enviarCorreo } from '../correo.js';

/**
 * Sistema: todo lo que el superadministrador cambia sin desplegar.
 * Marca (logo, colores), versión mínima de la app, legal, Firebase, webhook,
 * permisos por rol; y el perfil propio de cada usuario.
 */

type Config = Record<string, unknown>;
const SECCIONES = ['marca', 'movil', 'legal', 'firebase', 'webhook', 'correo'] as const;
type Seccion = (typeof SECCIONES)[number];
// Campos que nunca salen del servidor: se devuelven como "••••" si tienen valor.
const SECRETOS: Partial<Record<Seccion, string[]>> = { firebase: ['cuentaServicio'], webhook: ['secreto'], correo: ['clave'] };
const MASCARA = '••••••••';

/**
 * Secretos cifrados en reposo con AES-256-GCM: un respaldo o un volcado de la base no
 * expone la llave de Firebase ni el secreto del webhook. La llave vive solo en el entorno
 * (CONFIG_KEY; si falta, se deriva de JWT_SECRET). Cambiarla obliga a volver a cargar los secretos.
 */
const LLAVE = createHash('sha256').update(process.env.CONFIG_KEY ?? `config:${process.env.JWT_SECRET ?? ''}`).digest();

export function cifrar(texto: string): string {
  if (!texto) return '';
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', LLAVE, iv);
  const datos = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return 'enc:v1:' + Buffer.concat([iv, c.getAuthTag(), datos]).toString('base64');
}

export function descifrar(valor: string): string {
  if (!valor?.startsWith('enc:v1:')) return valor ?? '';
  const b = Buffer.from(valor.slice(7), 'base64');
  const d = createDecipheriv('aes-256-gcm', LLAVE, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

export async function leerConfig(seccion: Seccion): Promise<Config> {
  return recordar(`cfg:${seccion}`, 30_000, async () => {
    const v = (await uno<{ valor: Config }>('SELECT valor FROM core.configuracion WHERE clave = $1', [seccion]))?.valor ?? {};
    for (const k of SECRETOS[seccion] ?? []) {
      try { v[k] = descifrar(String(v[k] ?? '')); } catch { v[k] = ''; /* llave cambiada: hay que volver a cargarlo */ }
    }
    return v;
  });
}

const enmascarar = (s: Seccion, v: Config) =>
  Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRETOS[s]?.includes(k) && x ? MASCARA : x]));

/* ------------------------------------------------------------ validación */
// 1.2.3 o 1.2.3+45 (número de compilación: cada APK de GitHub sube este número).
const semver = z.string().regex(/^\d+\.\d+\.\d+(\+\d+)?$/, 'Formato 1.2.3 o 1.2.3+45');
const urlHttps = z.union([z.literal(''), z.string().url().startsWith('https://', 'Debe usar https://')]);
const color = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const ESQUEMAS: Record<Seccion, z.ZodTypeAny> = {
  marca: z.object({ nombreApp: z.string().trim().min(2).max(40), colorPrimario: color, colorAcento: color,
    logoId: z.string().uuid().nullable(), iconoId: z.string().uuid().nullable() }),
  movil: z.object({ versionActual: semver, versionMinima: semver, urlAndroid: urlHttps, urlIos: urlHttps,
    mensajeActualizacion: z.string().trim().min(5).max(200),
    // Servidor que deben usar las apps instaladas: si cambia, se mudan solas al abrir.
    urlApi: urlHttps.optional().default(''),
    // Secciones de la app que el superadmin activa o apaga para todos (además del permiso del rol).
    modulos: z.record(z.string().regex(/^[a-z]+$/), z.boolean()).optional().default({}),
    // Repositorio que compila la APK (dueño/nombre): de su último release salen versión y enlace.
    repoGithub: z.union([z.literal(''), z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'Formato dueño/repositorio')]).optional().default('') }),
  legal: z.object({ urlPrivacidad: urlHttps, urlTerminos: urlHttps, correoSoporte: z.union([z.literal(''), z.string().email()]),
    textoPrivacidad: z.string().max(60_000).optional().default(''), textoTerminos: z.string().max(60_000).optional().default('') }),
  firebase: z.object({ habilitado: z.boolean(), projectId: z.string().max(100), apiKey: z.string().max(100),
    appIdAndroid: z.string().max(100), appIdIos: z.string().max(100), senderId: z.string().max(40),
    cuentaServicio: z.string().max(10_000) }),
  correo: z.object({ habilitado: z.boolean(), host: z.string().trim().max(200).regex(/^[A-Za-z0-9.-]*$/, 'Host inválido'),
    puerto: z.number().int().min(1).max(65535), seguro: z.boolean(), usuario: z.string().trim().max(200), clave: z.string().max(500),
    remitente: z.union([z.literal(''), z.string().trim().email()]), nombreRemitente: z.string().trim().max(80) }),
  webhook: z.object({ habilitado: z.boolean(), url: urlHttps, secreto: z.string().max(200),
    eventos: z.array(z.enum(['venta.creada', 'cobro.registrado', 'pedido.estado', 'inventario.movimiento', 'usuario.eliminado'])) }),
};

/** a < b en semver. */
/** Compara 1.2.3+45: mayor, menor, parche y número de compilación (sin compilación = 0). */
export function versionMenor(a: string, b: string): boolean {
  const partes = (v: string) => v.replace(/^v/, '').split(/[.+]/).map(Number);
  const pa = partes(a), pb = partes(b);
  for (let i = 0; i < 4; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
}

/**
 * Versión publicada automática: lee el último release del repositorio configurado (GitHub
 * Actions publica uno por cada APK). Si es más nuevo, actualiza versión y enlace de Android;
 * así el superadmin ve el dato al día y las apps instaladas reciben el aviso de actualización.
 * ponytail: consulta como máximo cada 5 min (límite de la API pública de GitHub: 60/h por IP).
 */
/** Dominio público por el que llegó la petición (túnel, servidor nuevo, dominio propio); null si es local. */
export function dominioPublico(hostCrudo: string | undefined): string | null {
  const host = String(hostCrudo ?? '').toLowerCase().replace(/:\d+$/, '');
  const publico = /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) && !/(^|\.)localhost$|\.local$|\.internal$/.test(host);
  return publico ? `https://${host}` : null;
}

/**
 * Dominio automático: el sistema usa SIEMPRE el dominio donde está instalado y por el que se entra.
 * Nada queda fijo: al instalarlo en otro servidor, cambiar de túnel o de dominio, el valor guardado
 * (lo que ven Configuración, la APK y las apps) se actualiza solo en la primera visita.
 * Desde localhost o una IP privada no se cambia (no hay un dominio público que adoptar).
 */
let ultimoDominio = '';
export async function seguirDominio(hostCrudo: string | undefined): Promise<void> {
  const nuevo = dominioPublico(hostCrudo);
  if (!nuevo || nuevo === ultimoDominio) return;
  const movil = await leerConfig('movil') as { urlApi?: string };
  const guardado = String(movil.urlApi ?? '').replace(/\/api\/v1$/, '').replace(/\/+$/, '');
  ultimoDominio = nuevo;
  if (guardado === nuevo) return;
  await q(`UPDATE core.configuracion SET valor = valor || jsonb_build_object('urlApi', $1::text), actualizado_en = now() WHERE clave = 'movil'`, [nuevo]);
  invalidar('cfg:movil');
  await auditar({ actorId: null, actor: 'Sistema', rol: 'SISTEMA', accion: 'DOMINIO_ACTUALIZADO', entidad: 'configuracion', entidadId: 'movil',
    detalle: { antes: guardado, despues: nuevo, motivo: 'el sistema se abrió desde otro dominio' } }).catch(() => {});
}

let ultimaRevision = 0;
export async function sincronizarRelease(): Promise<void> {
  if (Date.now() - ultimaRevision < 5 * 60_000) return;
  ultimaRevision = Date.now();
  const movil = await leerConfig('movil') as { repoGithub?: string; versionActual?: string };
  if (!movil.repoGithub) return;
  try {
    const r = await fetch(`https://api.github.com/repos/${movil.repoGithub}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'tanta-api' }, signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return;
    const rel = await r.json() as { tag_name?: string; assets?: Array<{ name: string; browser_download_url: string }> };
    const version = (rel.tag_name ?? '').replace(/^v/, '');
    const apk = rel.assets?.find((a) => a.name.endsWith('.apk'))?.browser_download_url;
    if (!/^\d+\.\d+\.\d+(\+\d+)?$/.test(version) || !apk || !versionMenor(movil.versionActual ?? '0.0.0', version)) return;
    await q(`UPDATE core.configuracion SET valor = valor || jsonb_build_object('versionActual', $1::text, 'urlAndroid', $2::text), actualizado_en = now()
             WHERE clave = 'movil'`, [version, apk]);
    invalidar('cfg:movil');
  } catch { /* GitHub no respondió: se reintenta en la próxima ventana */ }
}

/** Tipo real por "números mágicos": no se confía en el mime que declara el cliente. */
function mimeReal(b: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (b.length > 8 && b.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export async function guardarImagen(base64: string, usuarioId: string): Promise<string> {
  const datos = Buffer.from(base64.replace(/^data:[^,]+,/, ''), 'base64');
  const mime = mimeReal(datos);
  if (!mime) throw Object.assign(new Error('Solo imágenes PNG, JPEG o WebP.'), { status: 415, codigo: 'IMAGEN_INVALIDA' });
  if (datos.length > 1_048_576) throw Object.assign(new Error('La imagen supera 1 MB.'), { status: 413, codigo: 'IMAGEN_GRANDE' });
  const f = await uno<{ id: string }>('INSERT INTO core.archivo (mime, datos, creado_por) VALUES ($1,$2,$3) RETURNING id', [mime, datos, usuarioId]);
  return f!.id;
}

/* -------------------------------------------------------------- webhook */
/** IP no enrutable públicamente (loopback, privada, link-local/metadata, CGNAT, reservada). */
function ipPrivada(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return ipPrivada(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/**
 * Anti-SSRF: el webhook solo puede salir a internet. Se resuelve el DNS y se valida CADA
 * dirección (un dominio no puede apuntar a 127.0.0.1 o al servicio de metadatos de la nube).
 */
export async function destinoPublico(url: string): Promise<boolean> {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
    const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address);
    return ips.length > 0 && ips.every((ip) => !ipPrivada(ip));
  } catch {
    return false;
  }
}

/** Notifica a un sistema externo. Firma HMAC-SHA256 del cuerpo en X-Tanta-Firma. Nunca bloquea la operación. */
export async function emitirEvento(evento: string, datos: unknown): Promise<void> {
  try {
    const cfg = await leerConfig('webhook') as { habilitado?: boolean; url?: string; secreto?: string; eventos?: string[] };
    if (!cfg.habilitado || !cfg.url || !cfg.eventos?.includes(evento)) return;
    if (!(await destinoPublico(cfg.url))) return;
    const cuerpo = JSON.stringify({ evento, ocurridoEn: new Date().toISOString(), datos });
    const firma = createHmac('sha256', cfg.secreto ?? '').update(cuerpo).digest('hex');
    await fetch(cfg.url, {
      method: 'POST', body: cuerpo, redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', 'X-Tanta-Evento': evento, 'X-Tanta-Firma': `sha256=${firma}` },
    });
  } catch { /* ponytail: sin reintentos; agregar cola persistente si el receptor es crítico */ }
}

/* ------------------------------------------------------------ push FCM */
let tokenGoogle: { valor: string; expira: number } | null = null;

async function accesoGoogle(cuenta: { client_email: string; private_key: string }): Promise<string> {
  if (tokenGoogle && tokenGoogle.expira > Date.now() + 60_000) return tokenGoogle.valor;
  const llave = await importPKCS8(cuenta.private_key, 'RS256');
  const jwt = await new SignJWT({ scope: 'https://www.googleapis.com/auth/firebase.messaging' })
    .setProtectedHeader({ alg: 'RS256' }).setIssuer(cuenta.client_email).setAudience('https://oauth2.googleapis.com/token')
    .setIssuedAt().setExpirationTime('1h').sign(llave);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(8000),
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!r.ok) throw new Error(`Google rechazó la cuenta de servicio (${r.status})`);
  const d = await r.json() as { access_token: string; expires_in: number };
  tokenGoogle = { valor: d.access_token, expira: Date.now() + d.expires_in * 1000 };
  return d.access_token;
}

/** Push a todos los dispositivos de un usuario (FCM HTTP v1). Devuelve cuántos se enviaron. */
export async function enviarPush(usuarioId: string, titulo: string, cuerpo: string): Promise<number> {
  const cfg = await leerConfig('firebase') as { habilitado?: boolean; projectId?: string; cuentaServicio?: string };
  if (!cfg.habilitado || !cfg.projectId || !cfg.cuentaServicio) return 0;
  const acceso = await accesoGoogle(JSON.parse(cfg.cuentaServicio));
  const tokens = await q<{ token_push: string }>('SELECT token_push FROM core.dispositivo WHERE usuario_id = $1 AND token_push IS NOT NULL', [usuarioId]);
  let enviados = 0;
  for (const { token_push } of tokens) {
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/messages:send`, {
      method: 'POST', signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${acceso}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { token: token_push, notification: { title: titulo, body: cuerpo },
        android: { priority: 'HIGH', notification: { sound: 'default' } }, apns: { payload: { aps: { sound: 'default' } } } } }),
    });
    if (r.ok) enviados++;
    else if (r.status === 404 || r.status === 400) await q('UPDATE core.dispositivo SET token_push = NULL WHERE token_push = $1', [token_push]);
  }
  return enviados;
}

/** Datos del negocio (tarjeta del login, comprobantes, contacto). Viven en core.negocio. */
const Negocio = z.object({
  nombre: z.string().trim().min(2).max(120), ruc: z.string().trim().regex(/^(\d{11})?$/, 'RUC de 11 dígitos'),
  direccion: z.string().trim().max(200), telefono: z.string().trim().max(30), whatsapp: z.string().trim().max(30),
  email: z.union([z.literal(''), z.string().trim().email()]), representante: z.string().trim().max(120), claim: z.string().trim().max(60),
});
const leerNegocio = () => recordar('cfg:negocio', 30_000, async () =>
  (await uno<Record<string, string>>('SELECT nombre, ruc, direccion, telefono, whatsapp, email, representante, claim FROM core.negocio WHERE id = 1')) ?? {});

export async function rutasSistema(app: FastifyInstance) {
  app.put('/sistema/negocio', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'config.gestionar')) return;
    const p = Negocio.safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' · ')));
    const d = p.data;
    await q(`INSERT INTO core.negocio (id, nombre, ruc, direccion, telefono, whatsapp, email, representante, claim) VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (id) DO UPDATE SET nombre=$1, ruc=$2, direccion=$3, telefono=$4, whatsapp=$5, email=$6, representante=$7, claim=$8, actualizado_en=now()`,
      [d.nombre, d.ruc, d.direccion, d.telefono, d.whatsapp, d.email, d.representante, d.claim]);
    invalidar('cfg:negocio');
    invalidar('negocio');
    await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'NEGOCIO_ACTUALIZADO', entidad: 'negocio', detalle: d, ip: req.ip });
    return d;
  });

  const fallo = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, e: unknown) => {
    const err = e as Error & { status?: number; codigo?: string };
    if (!err.status) throw e;
    return reply.code(err.status).send(error(err.status, err.codigo ?? 'ERROR', err.message));
  };

  /* --------------------------------------- configuración pública (sin sesión) */
  // Lo que la pantalla de login y la app necesitan antes de autenticarse. Nada secreto.
  app.get('/config/publica', async (req, reply) => {
    await sincronizarRelease();
    await seguirDominio(req.hostname);
    const [marca, movil, legal, fb, negocio] = await Promise.all([leerConfig('marca'), leerConfig('movil'), leerConfig('legal'), leerConfig('firebase'), leerNegocio()]);
    const f = fb as Record<string, unknown>;
    // no-cache: el navegador revalida siempre; el servidor ya lo tiene en memoria e invalida al guardar.
    reply.header('Cache-Control', 'no-cache');
    // El dominio por el que se entró manda; el guardado solo sirve si se entra desde localhost.
    const dominio = dominioPublico(req.hostname) ?? String((movil as { urlApi?: string }).urlApi ?? '');
    const { textoPrivacidad: _p, textoTerminos: _t, ...legalPublico } = legal as Record<string, unknown>;
    return {
      marca, legal: legalPublico, negocio,
      movil: { ...movil, urlApi: dominio && !dominio.endsWith('/api/v1') ? `${dominio}/api/v1` : dominio },
      // Datos públicos del cliente Firebase (van en toda app); la cuenta de servicio jamás.
      firebase: f.projectId && f.apiKey ? { projectId: f.projectId, apiKey: f.apiKey, appIdAndroid: f.appIdAndroid, appIdIos: f.appIdIos, senderId: f.senderId } : null,
    };
  });

  // Páginas públicas que exigen Google Play y App Store (no requieren sesión).
  app.get('/legal/:doc', async (req, reply) => {
    const { doc } = req.params as { doc: string };
    if (doc !== 'privacidad' && doc !== 'terminos') return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'Documento inexistente.'));
    const [legal, negocio] = await Promise.all([leerConfig('legal'), leerNegocio()]) as [Record<string, string>, Record<string, string>];
    const propio = doc === 'privacidad' ? legal.textoPrivacidad : legal.textoTerminos;
    reply.header('Cache-Control', 'no-cache');
    return { titulo: doc === 'privacidad' ? 'Política de privacidad' : 'Términos y condiciones', texto: propio || textoLegalBase(doc, negocio, legal.correoSoporte), negocio: negocio.nombre ?? '' };
  });

  app.get('/archivos/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'Archivo no encontrado.'));
    const f = await uno<{ mime: string; datos: Buffer }>('SELECT mime, datos FROM core.archivo WHERE id = $1', [id]);
    if (!f) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'Archivo no encontrado.'));
    // El id es inmutable (un archivo nuevo = id nuevo): se puede cachear para siempre.
    return reply.header('Content-Type', f.mime).header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "default-src 'none'")
      // Imágenes públicas que también carga la app móvil (otro origen): el resto del API sigue same-site.
      .header('Cross-Origin-Resource-Policy', 'cross-origin').send(f.datos);
  });

  /* ------------------------------------------------- configuración (admin) */
  app.get('/sistema/config', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'config.gestionar')) return;
    const todo = await Promise.all(SECCIONES.map(async (s) => [s, enmascarar(s, await leerConfig(s))]));
    return Object.fromEntries(todo);
  });

  app.put('/sistema/config/:seccion', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'config.gestionar')) return;
    const { seccion } = req.params as { seccion: Seccion };
    if (!SECCIONES.includes(seccion)) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'Sección inexistente.'));
    const anterior = await leerConfig(seccion);
    const entrada = { ...(req.body as Config) };
    // Un secreto que vuelve enmascarado significa "no lo cambié".
    for (const k of SECRETOS[seccion] ?? []) if (entrada[k] === MASCARA) entrada[k] = anterior[k] ?? '';
    if (seccion === 'movil' && typeof entrada.urlApi === 'string') entrada.urlApi = entrada.urlApi.trim().replace(/\/+$/, '').replace(/\/api\/v1$/, '');
    const p = ESQUEMAS[seccion].safeParse(entrada);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' · ')));
    if (seccion === 'webhook' && p.data.url && !(await destinoPublico(p.data.url))) {
      return reply.code(422).send(error(422, 'DESTINO_NO_PERMITIDO', 'El webhook debe apuntar a un servidor público por https (no a direcciones internas).'));
    }
    if (seccion === 'movil' && versionMenor(p.data.versionActual, p.data.versionMinima)) {
      return reply.code(422).send(error(422, 'VERSION_INVALIDA', 'La versión mínima no puede ser mayor que la actual.'));
    }
    if (seccion === 'firebase' && p.data.cuentaServicio) {
      try {
        const c = JSON.parse(p.data.cuentaServicio);
        if (!c.client_email || !c.private_key) throw new Error();
      } catch { return reply.code(422).send(error(422, 'CUENTA_SERVICIO_INVALIDA', 'Pega el JSON completo de la cuenta de servicio de Firebase.')); }
      tokenGoogle = null;
    }
    const guardar: Config = { ...p.data };
    for (const k of SECRETOS[seccion] ?? []) guardar[k] = cifrar(String(guardar[k] ?? ''));
    await q('UPDATE core.configuracion SET valor = $1, actualizado_en = now(), actualizado_por = $2 WHERE clave = $3', [guardar, req.usuario!.id, seccion]);
    invalidar(`cfg:${seccion}`);
    await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'CONFIG_CAMBIADA',
      entidad: 'configuracion', entidadId: seccion, detalle: enmascarar(seccion, p.data), ip: req.ip });
    return enmascarar(seccion, p.data);
  });

  app.post('/sistema/archivos', { preHandler: autenticar, bodyLimit: 1_500_000 }, async (req, reply) => {
    if (!exigir(req, reply, 'config.gestionar')) return;
    const p = z.object({ base64: z.string().min(10) }).safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Falta la imagen.'));
    try { return reply.code(201).send({ id: await guardarImagen(p.data.base64, req.usuario!.id) }); } catch (e) { return fallo(reply, e); }
  });

  app.post('/sistema/webhook/probar', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'config.gestionar')) return;
    const cfg = await leerConfig('webhook') as { url?: string; secreto?: string };
    if (!cfg.url) return reply.code(422).send(error(422, 'SIN_URL', 'Configura primero la URL del webhook.'));
    if (!(await destinoPublico(cfg.url))) return reply.code(422).send(error(422, 'DESTINO_NO_PERMITIDO', 'El webhook debe apuntar a un servidor público por https (no a direcciones internas).'));
    const cuerpo = JSON.stringify({ evento: 'prueba', ocurridoEn: new Date().toISOString(), datos: {} });
    try {
      const r = await fetch(cfg.url, { method: 'POST', body: cuerpo, redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json', 'X-Tanta-Evento': 'prueba',
          'X-Tanta-Firma': `sha256=${createHmac('sha256', cfg.secreto ?? '').update(cuerpo).digest('hex')}` } });
      return { ok: r.ok, status: r.status };
    } catch (e) { return { ok: false, status: 0, detalle: (e as Error).message }; }
  });

  // Envía un correo de prueba al Superadmin que lo pide (a su correo del perfil).
  app.post('/sistema/correo/probar', { preHandler: autenticar, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!exigir(req, reply, 'config.gestionar')) return;
    const yo = await uno<{ email: string }>('SELECT email FROM core.usuario WHERE id = $1', [req.usuario!.id]);
    if (!yo?.email) return reply.code(422).send(error(422, 'SIN_CORREO', 'Agrega tu correo en Mi perfil para recibir la prueba.'));
    try {
      await enviarCorreo(yo.email, 'Prueba de correo', ['El servidor de correo está bien configurado.', 'Desde ahora el sistema puede enviar códigos de recuperación de contraseña.']);
      return { ok: true, para: yo.email };
    } catch (e) {
      const err = e as Error & { status?: number };
      return reply.code(err.status ?? 502).send(error(err.status ?? 502, 'SMTP_ERROR', `No se pudo enviar: ${err.message}`));
    }
  });

  app.post('/sistema/push/probar', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'config.gestionar')) return;
    const cfg = await leerConfig('firebase') as { habilitado?: boolean; projectId?: string; cuentaServicio?: string };
    if (!cfg.habilitado) return reply.code(422).send(error(422, 'PUSH_INACTIVO', 'Activa "Enviar notificaciones push" y guarda.'));
    if (!cfg.cuentaServicio) return reply.code(422).send(error(422, 'SIN_CUENTA_SERVICIO', 'Falta la cuenta de servicio: sin ella el servidor no puede enviar. Súbela con el botón "Cuenta de servicio (.json)" y guarda.'));
    const quien = String((req.body as { destinatario?: string } | null)?.destinatario ?? '').trim().toLowerCase();
    const u = quien
      ? await uno<{ id: string; nombre: string }>('SELECT id, nombre FROM core.usuario WHERE lower(usuario) = $1 OR lower(email) = $1', [quien])
      : { id: req.usuario!.id, nombre: req.usuario!.nombre };
    if (!u) return reply.code(404).send(error(404, 'SIN_USUARIO', 'No existe un usuario con ese usuario o correo.'));
    const tel = await uno<{ n: string }>('SELECT count(*) n FROM core.dispositivo WHERE usuario_id = $1 AND token_push IS NOT NULL', [u.id]);
    if (!Number(tel?.n)) return reply.code(422).send(error(422, 'SIN_DISPOSITIVO', `${u.nombre} no tiene un teléfono con notificaciones activas: instala la app, inicia sesión y acepta el permiso de notificaciones.`));
    try { return { enviados: await enviarPush(u.id, 'Tanta', 'Notificación de prueba'), destinatario: u.nombre }; }
    catch (e) { return reply.code(502).send(error(502, 'FIREBASE_ERROR', (e as Error).message)); }
  });

  app.get('/sistema/dispositivos', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'config.gestionar')) return;
    const movil = await leerConfig('movil') as { versionMinima?: string };
    const filas = await q<Record<string, string>>(`
      SELECT d.plataforma, d.version_app, d.ultimo_uso, (d.token_push IS NOT NULL) AS push, u.nombre, u.usuario
      FROM core.dispositivo d JOIN core.usuario u ON u.id = d.usuario_id ORDER BY d.ultimo_uso DESC LIMIT 500`);
    return filas.map((f) => ({ ...f, desactualizada: versionMenor(f.version_app, movil.versionMinima ?? '0.0.0') }));
  });

  /* ------------------------------------------------------ roles y permisos */
  app.get('/sistema/roles', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'roles.gestionar')) return;
    const [roles, permisos, asignados] = await Promise.all([
      q('SELECT id, nombre, descripcion, perfil FROM core.rol ORDER BY orden'),
      q('SELECT id, grupo, descripcion FROM core.permiso ORDER BY grupo, id'),
      q<{ rol_id: string; permiso_id: string }>('SELECT rol_id, permiso_id FROM core.rol_permiso'),
    ]);
    return { roles, permisos, asignados: asignados.map((a) => `${a.rol_id}:${a.permiso_id}`) };
  });

  // Roles nuevos (p. ej. "Cajero", "Repartidor"): nacen sin permisos y se configuran en la matriz.
  const NuevoRol = z.object({
    nombre: z.string().trim().min(3).max(40), descripcion: z.string().trim().max(120).default(''),
    perfil: z.enum(['web', 'app', 'tablet']).default('web'),
  });
  const ROLES_BASE = new Set(['SUPERADMIN', 'GERENTE', 'ADMINISTRADOR', 'PRODUCCION', 'ALMACEN', 'VENDEDOR', 'CLIENTE', 'SOPORTE']);

  app.post('/sistema/roles', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'roles.gestionar')) return;
    const p = NuevoRol.safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues[0]?.message ?? 'Datos inválidos.'));
    const id = p.data.nombre.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);
    if (!id || await uno('SELECT 1 FROM core.rol WHERE id = $1 OR lower(nombre) = lower($2)', [id, p.data.nombre])) {
      return reply.code(409).send(error(409, 'DUPLICADO', 'Ya existe un rol con ese nombre.'));
    }
    await q(`INSERT INTO core.rol (id, nombre, corto, descripcion, perfil, icono, orden)
             VALUES ($1,$2,$2,$3,$4,'user',(SELECT coalesce(max(orden),0)+1 FROM core.rol))`, [id, p.data.nombre, p.data.descripcion, p.data.perfil]);
    // Todo rol ve al menos su panel: sin eso no tendría pantalla de inicio.
    await q("INSERT INTO core.rol_permiso (rol_id, permiso_id) VALUES ($1, 'panel.ver') ON CONFLICT DO NOTHING", [id]);
    await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'ROL_CREADO', entidad: 'rol', entidadId: id, detalle: p.data, ip: req.ip });
    return reply.code(201).send({ id, ...p.data });
  });

  app.delete('/sistema/roles/:id', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'roles.gestionar')) return;
    const { id } = req.params as { id: string };
    if (ROLES_BASE.has(id)) return reply.code(409).send(error(409, 'ROL_PROTEGIDO', 'Los roles base del sistema no se eliminan (sí se pueden editar sus permisos).'));
    const usados = await uno<{ n: string }>('SELECT count(*) n FROM core.usuario_rol WHERE rol_id = $1', [id]);
    if (Number(usados?.n) > 0) return reply.code(409).send(error(409, 'ROL_EN_USO', `Hay ${usados?.n} usuario(s) con este rol: cámbialos de rol antes de eliminarlo.`));
    const r = await q('DELETE FROM core.rol WHERE id = $1 RETURNING id', [id]);
    if (!r.length) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'El rol no existe.'));
    await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'ROL_ELIMINADO', entidad: 'rol', entidadId: id, ip: req.ip });
    return { ok: true };
  });

  app.put('/sistema/roles/:id/permisos', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'roles.gestionar')) return;
    const { id } = req.params as { id: string };
    // El superadmin siempre conserva todo: nadie (ni él mismo) puede dejar el sistema sin administrador.
    if (id === 'SUPERADMIN') return reply.code(409).send(error(409, 'ROL_PROTEGIDO', 'El Superadministrador siempre tiene todos los permisos.'));
    const p = z.object({ permisos: z.array(z.string().max(60)).max(200) }).safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Lista de permisos inválida.'));
    // Solo un superadmin reparte los permisos de sistema: evita que un rol se autoeleve.
    const sistema = ['config.gestionar', 'roles.gestionar'];
    if (req.usuario!.rol !== 'SUPERADMIN' && p.data.permisos.some((x) => sistema.includes(x))) {
      return reply.code(403).send(error(403, 'SIN_PERMISO', 'Solo el Superadministrador asigna permisos de sistema.'));
    }
    const antes = await q<{ permiso_id: string }>('SELECT permiso_id FROM core.rol_permiso WHERE rol_id = $1', [id]);
    await tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM core.rol WHERE id = $1', [id])).rowCount) throw Object.assign(new Error('El rol no existe.'), { status: 404 });
      await c.query('DELETE FROM core.rol_permiso WHERE rol_id = $1', [id]);
      await c.query('INSERT INTO core.rol_permiso (rol_id, permiso_id) SELECT $1, id FROM core.permiso WHERE id = ANY($2::text[])', [id, p.data.permisos]);
    }).catch((e) => fallo(reply, e));
    if (reply.sent) return;
    await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'ROL_PERMISOS_CAMBIADOS',
      entidad: 'rol', entidadId: id, detalle: { antes: antes.map((a) => a.permiso_id), despues: p.data.permisos }, ip: req.ip });
    return { id, permisos: p.data.permisos };
  });

  /* ----------------------------------------------------------- mi perfil */
  app.get('/perfil', { preHandler: autenticar }, async (req) => {
    const u = await uno<Record<string, string>>(
      `SELECT u.id, u.nombre, u.usuario, u.email, u.telefono, u.foto_id, u.creado_en, u.ultimo_acceso, r.nombre AS rol,
              (SELECT count(*) FROM core.mfa_codigo m WHERE m.usuario_id = u.id AND m.usado_en IS NULL) AS codigos_mfa
       FROM core.usuario u JOIN core.rol r ON r.id = $2 WHERE u.id = $1`, [req.usuario!.id, req.usuario!.rol]);
    return { ...u, fotoUrl: u?.foto_id ? `/archivos/${u.foto_id}` : null };
  });

  const DatosPerfil = z.object({
    nombre: z.string().trim().min(3).max(120),
    email: z.union([z.literal(''), z.string().trim().email().max(160)]),
    telefono: z.string().trim().max(30).regex(/^[0-9+ ()-]*$/, 'Solo números, espacios, +, ( ) y -'),
    clave: z.string().max(128).optional(),
  });

  app.patch('/perfil', { preHandler: autenticar, config: { rateLimit: { max: Number(process.env.LOGIN_RATE_MAX ?? 8), timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = DatosPerfil.safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues[0]?.message ?? 'Datos inválidos.'));
    const { clave, ...datos } = p.data;
    const u = await uno<{ email: string | null; clave_hash: string }>('SELECT email, clave_hash FROM core.usuario WHERE id = $1', [req.usuario!.id]);
    // El correo recupera la cuenta: con un token robado no debe poder cambiarse sin la contraseña.
    if ((u?.email ?? '').toLowerCase() !== datos.email.toLowerCase() && (!clave || !u || !verificarClave(clave, u.clave_hash))) {
      return reply.code(403).send(error(403, 'CLAVE_ACTUAL_INCORRECTA', 'Para cambiar el correo escribe tu contraseña actual.'));
    }
    await q('UPDATE core.usuario SET nombre = $1, email = $2, telefono = $3 WHERE id = $4', [datos.nombre, datos.email, datos.telefono, req.usuario!.id]);
    invalidar(`sesion:${req.usuario!.id}`);
    await auditar({ actorId: req.usuario!.id, actor: datos.nombre, rol: req.usuario!.rol, accion: 'PERFIL_ACTUALIZADO', entidad: 'usuario', entidadId: req.usuario!.id,
      detalle: u?.email !== datos.email ? { emailAnterior: u?.email ?? '' } : undefined, ip: req.ip });
    return datos;
  });

  app.post('/perfil/clave', {
    preHandler: autenticar,
    config: { rateLimit: { max: Number(process.env.LOGIN_RATE_MAX ?? 8), timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const p = z.object({ actual: z.string().min(1).max(128), nueva: z.string().min(10).max(128) }).safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'CLAVE_DEBIL', 'La nueva contraseña debe tener al menos 10 caracteres.'));
    if (p.data.actual === p.data.nueva) return reply.code(422).send(error(422, 'CLAVE_IGUAL', 'La nueva contraseña debe ser distinta.'));
    const u = await uno<{ clave_hash: string }>('SELECT clave_hash FROM core.usuario WHERE id = $1', [req.usuario!.id]);
    if (!u || !verificarClave(p.data.actual, u.clave_hash)) {
      return reply.code(403).send(error(403, 'CLAVE_ACTUAL_INCORRECTA', 'La contraseña actual no es correcta.'));
    }
    await q('UPDATE core.usuario SET clave_hash = $1 WHERE id = $2', [hashClave(p.data.nueva), req.usuario!.id]);
    // Cierra las sesiones en otros dispositivos: si alguien robó la clave, queda fuera.
    await q('UPDATE core.refresh_token SET revocado_en = now() WHERE usuario_id = $1 AND revocado_en IS NULL', [req.usuario!.id]);
    await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'CLAVE_CAMBIADA', entidad: 'usuario', entidadId: req.usuario!.id, ip: req.ip });
    return { ok: true, sesionesCerradas: true };
  });

  app.put('/perfil/foto', { preHandler: autenticar, bodyLimit: 1_500_000 }, async (req, reply) => {
    const p = z.object({ base64: z.string().min(10) }).safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Falta la imagen.'));
    try {
      const id = await guardarImagen(p.data.base64, req.usuario!.id);
      const previa = await uno<{ foto_id: string | null }>('SELECT foto_id FROM core.usuario WHERE id = $1', [req.usuario!.id]);
      await q('UPDATE core.usuario SET foto_id = $1 WHERE id = $2', [id, req.usuario!.id]);
      if (previa?.foto_id) await q('DELETE FROM core.archivo WHERE id = $1', [previa.foto_id]);
      return { fotoUrl: `/archivos/${id}` };
    } catch (e) { return fallo(reply, e); }
  });

  /**
   * Eliminar mi cuenta (exigido por App Store 5.1.1(v) y Google Play).
   * Los datos personales se borran; ventas y cobros se conservan anonimizados porque
   * son registros contables (obligación tributaria, Ley 29733 art. 18 excepciones).
   */
  app.delete('/perfil', {
    preHandler: autenticar,
    config: { rateLimit: { max: Number(process.env.LOGIN_RATE_MAX ?? 8), timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const p = z.object({ clave: z.string().min(1).max(128) }).safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Confirma con tu contraseña.'));
    if (req.usuario!.rol === 'SUPERADMIN') return reply.code(409).send(error(409, 'ROL_PROTEGIDO', 'El Superadministrador no puede eliminarse a sí mismo.'));
    const u = await uno<{ clave_hash: string; foto_id: string | null }>('SELECT clave_hash, foto_id FROM core.usuario WHERE id = $1', [req.usuario!.id]);
    if (!u || !verificarClave(p.data.clave, u.clave_hash)) return reply.code(403).send(error(403, 'CLAVE_ACTUAL_INCORRECTA', 'La contraseña no es correcta.'));
    const id = req.usuario!.id;
    await tx(async (c) => {
      await c.query(`UPDATE core.usuario SET nombre = 'Cuenta eliminada', usuario = 'eliminado-' || left(id::text, 8),
        email = '', telefono = '', foto_id = NULL, estado = 'BLOQUEADO', eliminado_en = now(), clave_hash = $2 WHERE id = $1`,
        [id, hashClave(crypto.randomUUID())]);
      if (u.foto_id) await c.query('DELETE FROM core.archivo WHERE id = $1', [u.foto_id]);
      await c.query('UPDATE core.refresh_token SET revocado_en = now() WHERE usuario_id = $1 AND revocado_en IS NULL', [id]);
      await c.query('DELETE FROM core.dispositivo WHERE usuario_id = $1', [id]);
    });
    invalidar(`sesion:${id}`);
    await auditar({ actorId: id, actor: 'Cuenta eliminada', rol: req.usuario!.rol, accion: 'CUENTA_ELIMINADA', entidad: 'usuario', entidadId: id, ip: req.ip });
    void emitirEvento('usuario.eliminado', { usuarioId: id });
    return { ok: true };
  });

  /* ------------------------------------------- dispositivo y versión de app */
  // La app lo llama al abrir: registra su versión (y token push) y recibe si debe actualizarse.
  app.post('/dispositivo', { preHandler: autenticar }, async (req, reply) => {
    const p = z.object({
      instalacion: z.string().min(8).max(64), plataforma: z.enum(['android', 'ios', 'web']),
      versionApp: semver, tokenPush: z.string().max(4096).nullable().optional(),
    }).safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Datos del dispositivo inválidos.'));
    const d = p.data;
    await q(`INSERT INTO core.dispositivo (usuario_id, instalacion, plataforma, version_app, token_push)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (usuario_id, instalacion) DO UPDATE SET plataforma = EXCLUDED.plataforma,
               version_app = EXCLUDED.version_app, token_push = coalesce(EXCLUDED.token_push, core.dispositivo.token_push), ultimo_uso = now()`,
      [req.usuario!.id, d.instalacion, d.plataforma, d.versionApp, d.tokenPush ?? null]);
    await sincronizarRelease();
    const movil = await leerConfig('movil') as { versionMinima: string; versionActual: string; urlAndroid: string; urlIos: string; mensajeActualizacion: string };
    return {
      actualizacionObligatoria: versionMenor(d.versionApp, movil.versionMinima),
      actualizacionDisponible: versionMenor(d.versionApp, movil.versionActual),
      url: d.plataforma === 'ios' ? movil.urlIos : movil.urlAndroid,
      mensaje: movil.mensajeActualizacion,
    };
  });
}

/** Texto base (Ley 29733 de Protección de Datos Personales, Perú). El superadmin lo reemplaza desde Configuración. */
function textoLegalBase(doc: 'privacidad' | 'terminos', n: Record<string, string>, soporte?: string): string {
  const empresa = n.nombre || 'La empresa';
  const contacto = soporte || n.email || '';
  const pie = `\n\nContacto: ${[contacto, n.telefono, n.direccion].filter(Boolean).join(' · ')}${n.ruc ? `\nRUC: ${n.ruc}` : ''}`;
  if (doc === 'privacidad') return `${empresa} trata tus datos personales conforme a la Ley N.° 29733 y su reglamento.

1. Datos que recopilamos
Nombre, usuario, correo, teléfono y foto de perfil; pedidos, ventas y pagos que registras; datos técnicos del dispositivo (modelo, versión de la app y un identificador para notificaciones).

2. Para qué los usamos
Prestar el servicio (pedidos, entregas, cobranza), enviarte avisos sobre tus pedidos, mantener la seguridad de tu cuenta y cumplir obligaciones legales y tributarias.

3. Con quién los compartimos
No vendemos tus datos. Solo los compartimos con proveedores que nos ayudan a operar (alojamiento, correo y notificaciones de Google Firebase), bajo obligación de confidencialidad, o cuando la ley lo exige.

4. Conservación y seguridad
Conservamos los datos mientras tengas una cuenta y el tiempo que exija la ley. Las contraseñas se guardan cifradas y cada acceso queda auditado.

5. Tus derechos
Puedes acceder, rectificar, cancelar u oponerte al tratamiento de tus datos (derechos ARCO) y eliminar tu cuenta desde "Mi cuenta" en la app o escribiendo a ${contacto || 'nuestro correo de soporte'}.${pie}`;
  return `Al usar el sistema y la aplicación de ${empresa} aceptas estas condiciones.

1. Cuentas
Cada cuenta es personal. Eres responsable de mantener tu contraseña en reserva y de las operaciones hechas con ella.

2. Pedidos y precios
Los precios incluyen IGV salvo que se indique lo contrario. Un pedido se confirma cuando cambia a "En producción"; la disponibilidad puede variar.

3. Pagos y crédito
Las ventas al crédito están sujetas al límite y plazo asignados a cada cliente. Los comprobantes internos no reemplazan al comprobante electrónico SUNAT.

4. Uso aceptable
No está permitido intentar acceder a cuentas ajenas, alterar información ni afectar el funcionamiento del sistema.

5. Cambios
Podemos actualizar estas condiciones; la versión vigente es la publicada en esta página.${pie}`;
}
