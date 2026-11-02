import { randomBytes, scryptSync, timingSafeEqual, createHash, randomInt, createHmac } from 'node:crypto';
import { argon2id } from '@noble/hashes/argon2.js';
import { SignJWT, jwtVerify } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { q, uno } from './db.js';
import { recordar } from './cache.js';

/* ------------------------------------------------------------------ */
/*  Contraseñas                                                        */
/*                                                                     */
/*  Se usa Argon2id (estándar actual). Las cuentas antiguas siguen con */
/*  scrypt y se migran solas en el siguiente inicio de sesión: el      */
/*  prefijo del hash dice qué algoritmo lo generó.                     */
/*                                                                     */
/*  argon2id$m=65536,t=3,p=1$<salt hex>$<hash hex>                     */
/*  scrypt$<salt hex>$<hash hex>            (heredado)                 */
/* ------------------------------------------------------------------ */

const ARGON = { m: 65536, t: 3, p: 1, dkLen: 32 };
const CLAVE_PEPPER = process.env.PEPPER ?? '';

function conPeper(clave: string): string {
  return clave.normalize('NFKC') + CLAVE_PEPPER;
}

export function hashClave(clave: string): string {
  const salt = randomBytes(16);
  const hash = argon2id(conPeper(clave), salt, ARGON);
  return `argon2id$m=${ARGON.m},t=${ARGON.t},p=${ARGON.p}$${salt.toString('hex')}$${Buffer.from(hash).toString('hex')}`;
}

/** Devuelve si la clave es correcta y si el hash debe migrarse a Argon2id. */
export function verificarClaveDetalle(clave: string, almacenado: string): { valida: boolean; rehash: boolean } {
  if (almacenado.startsWith('argon2id$')) {
    const [, params, saltHex, hashHex] = almacenado.split('$');
    if (!params || !saltHex || !hashHex) return { valida: false, rehash: false };
    const m = Number(/m=(\d+)/.exec(params)?.[1] ?? ARGON.m);
    const t = Number(/t=(\d+)/.exec(params)?.[1] ?? ARGON.t);
    const p = Number(/p=(\d+)/.exec(params)?.[1] ?? ARGON.p);
    const esperado = Buffer.from(hashHex, 'hex');
    const calculado = Buffer.from(argon2id(conPeper(clave), Buffer.from(saltHex, 'hex'), { m, t, p, dkLen: esperado.length }));
    const valida = calculado.length === esperado.length && timingSafeEqual(calculado, esperado);
    // Si los parámetros quedaron viejos, se aprovecha para subirlos.
    return { valida, rehash: valida && (m !== ARGON.m || t !== ARGON.t || p !== ARGON.p) };
  }

  if (almacenado.startsWith('scrypt$')) {
    const [, saltHex, hashHex] = almacenado.split('$');
    if (!saltHex || !hashHex) return { valida: false, rehash: false };
    const esperado = Buffer.from(hashHex, 'hex');
    const calculado = scryptSync(conPeper(clave), Buffer.from(saltHex, 'hex'), esperado.length, {
      N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
    });
    const valida = calculado.length === esperado.length && timingSafeEqual(calculado, esperado);
    // Una clave heredada correcta se reescribe con Argon2id en el mismo login.
    return { valida, rehash: valida };
  }

  return { valida: false, rehash: false };
}

export function verificarClave(clave: string, almacenado: string): boolean {
  return verificarClaveDetalle(clave, almacenado).valida;
}

/* ------------------------------------------------------------------ */
/*  Segundo factor (TOTP, RFC 6238)                                    */
/* ------------------------------------------------------------------ */

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // base32 (RFC 4648)

export function generarSecretoMfa(bytes = 20): string {
  const buf = randomBytes(bytes);
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let salida = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    salida += ALFABETO[parseInt(bits.slice(i, i + 5), 2)];
  }
  return salida;
}

function base32aBuffer(secreto: string): Buffer {
  const limpio = secreto.replace(/=+$/, '').toUpperCase();
  let bits = '';
  for (const c of limpio) {
    const i = ALFABETO.indexOf(c);
    if (i < 0) continue;
    bits += i.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/** Código de 6 dígitos para un instante dado (paso de 30 s). */
export function codigoTotp(secreto: string, paso = 0): string {
  const contador = Math.floor(Date.now() / 1000 / 30) + paso;
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(contador / 2 ** 32), 0);
  buf.writeUInt32BE(contador % 2 ** 32, 4);
  const hmac = createHmac('sha1', base32aBuffer(secreto)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binario =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return String(binario % 1_000_000).padStart(6, '0');
}

/** Acepta el código actual y los de ±1 paso (reloj del teléfono desfasado). */
export function verificarTotp(secreto: string, codigo: string, ventana = 1): boolean {
  const limpio = codigo.replace(/\D/g, '');
  if (limpio.length !== 6) return false;
  for (let p = -ventana; p <= ventana; p++) {
    if (codigoTotp(secreto, p) === limpio) return true;
  }
  return false;
}

export function urlOtpauth(secreto: string, cuenta: string, emisor = 'Tanta'): string {
  const etiqueta = encodeURIComponent(`${emisor}:${cuenta}`);
  return `otpauth://totp/${etiqueta}?secret=${secreto}&issuer=${encodeURIComponent(emisor)}&algorithm=SHA1&digits=6&period=30`;
}

export function codigoRecuperacion(): string {
  return String(randomInt(100000, 999999));
}


/* ------------------------------------------------------------------ */
/*  Tokens                                                             */
/* ------------------------------------------------------------------ */

/**
 * El secreto NO tiene valor por defecto. Un secreto conocido permite forjar un
 * token de Gerente; por eso el proceso se niega a arrancar sin él.
 * En desarrollo se puede usar `pnpm setup`, que escribe uno aleatorio en .env.
 */
const SECRETO_TEXTO = process.env.JWT_SECRET ?? '';
if (SECRETO_TEXTO.length < 32) {
  // Solo se permite el arranque en pruebas automatizadas con un secreto efímero.
  if (process.env.NODE_ENV === 'test') {
    process.env.JWT_SECRET = 'test-' + 'x'.repeat(40);
  } else {
    throw new Error(
      'JWT_SECRET ausente o demasiado corto (mínimo 32 caracteres). ' +
      'Defínelo en el entorno antes de arrancar el API.',
    );
  }
}
const SECRETO = new TextEncoder().encode(process.env.JWT_SECRET!);
const EMISOR = 'tanta-core';
const AUDIENCIA = 'tanta-apps';
export const ACCESO_MIN = 15;
export const REFRESCO_DIAS = 30;

export interface CargaToken {
  sub: string;
  nombre: string;
  rol: string;
  pv: number; // versión de permisos: invalidar sesiones al cambiar el rol
}

export async function firmarAcceso(c: CargaToken): Promise<string> {
  return new SignJWT({ nombre: c.nombre, rol: c.rol, pv: c.pv })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(c.sub)
    .setIssuer(EMISOR)
    .setAudience(AUDIENCIA)
    .setIssuedAt()
    .setExpirationTime(`${ACCESO_MIN}m`)
    .sign(SECRETO);
}

export async function verificarAcceso(token: string): Promise<CargaToken | null> {
  try {
    const { payload } = await jwtVerify(token, SECRETO, { issuer: EMISOR, audience: AUDIENCIA });
    return {
      sub: String(payload.sub),
      nombre: String(payload.nombre ?? ''),
      rol: String(payload.rol ?? ''),
      pv: Number(payload.pv ?? 0),
    };
  } catch {
    return null;
  }
}

/** Token opaco de refresco: al servidor solo llega su hash. */
export function nuevoRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString('base64url');
  return { token, hash: sha256(token) };
}

export function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

/* ------------------------------------------------------------------ */
/*  Contexto de petición                                               */
/* ------------------------------------------------------------------ */

export interface UsuarioActual {
  id: string;
  nombre: string;
  rol: string;
  permisos: Set<string>;
}

declare module 'fastify' {
  interface FastifyRequest {
    usuario?: UsuarioActual;
  }
}

export async function permisosDeRol(rolId: string): Promise<string[]> {
  const filas = await q<{ permiso_id: string }>(
    'SELECT permiso_id FROM core.rol_permiso WHERE rol_id = $1 ORDER BY permiso_id',
    [rolId],
  );
  return filas.map((f) => f.permiso_id);
}

/**
 * Se ejecuta antes de cada ruta protegida.
 * La firma del token no basta: se comprueba contra la base que el usuario exista,
 * esté ACTIVO y siga teniendo el rol con el que se emitió. Así, bloquear a alguien
 * surte efecto de inmediato y no cuando expire su token.
 */
export async function autenticar(req: FastifyRequest, reply: FastifyReply) {
  const cab = req.headers.authorization;
  if (!cab?.startsWith('Bearer ')) {
    return reply.code(401).send(error(401, 'NO_AUTENTICADO', 'Falta el token de acceso.'));
  }
  const carga = await verificarAcceso(cab.slice(7));
  if (!carga) {
    return reply.code(401).send(error(401, 'TOKEN_INVALIDO', 'El token expiró o no es válido.'));
  }

  const vigente = await recordar(`sesion:${carga.sub}`, 10_000, async () => {
    const fila = await uno<{ estado: string; rol_id: string | null; nombre: string }>(
      `SELECT u.estado, u.nombre,
              (SELECT ur.rol_id FROM core.usuario_rol ur JOIN core.rol r ON r.id = ur.rol_id
                WHERE ur.usuario_id = u.id ORDER BY r.orden LIMIT 1) AS rol_id
       FROM core.usuario u WHERE u.id = $1`,
      [carga.sub],
    );
    return fila;
  });

  if (!vigente || vigente.estado !== 'ACTIVO') {
    return reply.code(401).send(error(401, 'SESION_INVALIDA', 'La cuenta ya no está activa.'));
  }
  if (vigente.rol_id !== carga.rol) {
    // El rol cambió desde que se emitió el token: se obliga a reautenticarse.
    return reply.code(401).send(error(401, 'ROL_CAMBIADO', 'Tu perfil cambió. Vuelve a ingresar.'));
  }

  req.usuario = {
    id: carga.sub,
    nombre: vigente.nombre,
    rol: carga.rol,
    permisos: new Set(await permisosDeRol(carga.rol)),
  };
}

/** Autorización en el caso de uso, no solo en la ruta (D-12 del dossier). */
export function exigir(req: FastifyRequest, reply: FastifyReply, permiso: string): boolean {
  if (!req.usuario?.permisos.has(permiso)) {
    reply.code(403).send(error(403, 'SIN_PERMISO', `Falta el permiso ${permiso}.`));
    return false;
  }
  return true;
}

export function error(status: number, codigo: string, mensaje: string) {
  return { type: 'about:blank', title: mensaje, status, codigo, detail: mensaje };
}

/* ------------------------------------------------------------------ */
/*  Sesión de usuario                                                  */
/* ------------------------------------------------------------------ */

export async function rolDeUsuario(usuarioId: string): Promise<string | null> {
  const fila = await uno<{ rol_id: string }>(
    `SELECT ur.rol_id FROM core.usuario_rol ur
     JOIN core.rol r ON r.id = ur.rol_id
     WHERE ur.usuario_id = $1
     ORDER BY r.orden LIMIT 1`,
    [usuarioId],
  );
  return fila?.rol_id ?? null;
}
