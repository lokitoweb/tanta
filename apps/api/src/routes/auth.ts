import { randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { q, uno, tx } from '../db.js';
import {
  ACCESO_MIN, REFRESCO_DIAS, autenticar, error, firmarAcceso, firmarTicketMfa, verificarTicketMfa, nuevoRefreshToken,
  permisosDeRol, rolDeUsuario, sha256, verificarClaveDetalle, hashClave,
  generarSecretoMfa, verificarTotp, urlOtpauth, claveCorta, totpUnaVez, mfaBloqueado, registrarFalloMfa,
} from '../seguridad.js';
import { auditar } from '../auditoria.js';
import { enviarCorreo, correoDisponible } from '../correo.js';
import { invalidar } from '../cache.js';

const Login = z.object({
  usuario: z.string().min(1).max(80),
  clave: z.string().min(1).max(200),
  // "Mantener sesión iniciada": sin él, la sesión muere al cerrar el navegador (y como máximo en 12 h).
  recordar: z.boolean().default(true),
});

const Refresh = z.object({ refreshToken: z.string().min(10).max(200).optional() });
const Ticket = z.object({ ticket: z.string().min(10) });
const VerificarMfa = z.object({ ticket: z.string().min(10), codigo: z.string().min(6).max(20) });

/** Perfiles que pueden mover dinero, precios o usuarios: exigen segundo factor. */

const COOKIE = 'tanta_refresh';
const ES_PROD = process.env.NODE_ENV === 'production';

/**
 * Un navegador envía Origin en los POST; una app nativa no.
 * Al navegador se le da el refresco SOLO en cookie HttpOnly (inmune a XSS);
 * a la app nativa se le devuelve en el cuerpo para que lo guarde en el
 * almacén seguro del sistema. Nunca ambos: el navegador no lo recibe jamás.
 */
function esNavegador(req: { headers: Record<string, unknown> }): boolean {
  return Boolean(req.headers.origin);
}

function ponerCookie(reply: FastifyReply, token: string, recordar = true) {
  reply.setCookie(COOKIE, token, {
    httpOnly: true,          // JavaScript no puede leerla: un XSS no se lleva la sesión
    secure: ES_PROD,         // solo por HTTPS en producción
    sameSite: 'strict',
    path: '/api/v1/auth',
    // Sin maxAge es cookie de sesión: el navegador la borra al cerrarse.
    ...(recordar ? { maxAge: REFRESCO_DIAS * 24 * 60 * 60 } : {}),
  });
}

function quitarCookie(reply: FastifyReply) {
  reply.clearCookie(COOKIE, { path: '/api/v1/auth' });
}

/** Hash de relleno: iguala el tiempo de respuesta cuando el usuario no existe. */
const HASH_SEÑUELO = hashClave('señuelo-para-igualar-tiempos-' + Math.random());

// Límite estricto para todo lo que adivina un secreto corto (TOTP de 6 dígitos, tickets).
const ESTRICTO = { config: { rateLimit: { max: Number(process.env.LOGIN_RATE_MAX ?? 8), timeWindow: '1 minute' } } };

export async function rutasAuth(app: FastifyInstance) {
  /**
   * POST /auth/login
   * Contraseña correcta → emite sesión, o pide el segundo factor si la cuenta lo exige.
   */
  app.post('/auth/login', {
    config: { rateLimit: { max: Number(process.env.LOGIN_RATE_MAX ?? 8), timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const parseo = Login.safeParse(req.body);
    if (!parseo.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Usuario y contraseña son obligatorios.'));

    const { usuario, clave } = parseo.data;

    // Bloqueo por cuenta: el límite por IP no frena a quien rota direcciones.
    const intento = await uno<{ fallos: number; bloqueado_hasta: string | null }>(
      'SELECT fallos, bloqueado_hasta::text AS bloqueado_hasta FROM core.intento_login WHERE usuario = lower($1)',
      [usuario],
    );
    if (intento?.bloqueado_hasta && new Date(intento.bloqueado_hasta) > new Date()) {
      return reply.code(429).send(error(429, 'CUENTA_BLOQUEADA_TEMPORAL',
        'Demasiados intentos. Espera unos minutos o contacta al administrador.'));
    }

    const fila = await uno<{ id: string; nombre: string; clave_hash: string; estado: string; mfa_activo: boolean }>(
      'SELECT id, nombre, clave_hash, estado, mfa_activo FROM core.usuario WHERE lower(usuario) = lower($1)',
      [usuario],
    );

    // Misma respuesta y mismo costo si la cuenta no existe: no se enumeran usuarios.
    const fallo = async () => {
      await q(
        `INSERT INTO core.intento_login (usuario, ip, fallos, bloqueado_hasta)
         VALUES (lower($1), $2, 1, NULL)
         ON CONFLICT (usuario) DO UPDATE SET
           -- Un bloqueo vencido empieza de cero: un solo fallo no vuelve a bloquear la cuenta.
           fallos = CASE WHEN core.intento_login.bloqueado_hasta < now() THEN 1 ELSE core.intento_login.fallos + 1 END,
           ip = $2,
           actualizado_en = now(),
           -- SEG-01 / CP-02 del Excel: 5 intentos fallidos bloquean la cuenta 15 minutos.
           bloqueado_hasta = CASE WHEN core.intento_login.bloqueado_hasta < now() THEN NULL
                                  WHEN core.intento_login.fallos + 1 >= 5 THEN now() + interval '15 minutes'
                                  ELSE core.intento_login.bloqueado_hasta END`,
        [usuario, req.ip],
      );
      return reply.code(401).send(error(401, 'CREDENCIALES_INVALIDAS', 'Usuario o contraseña incorrectos.'));
    };

    if (!fila) {
      verificarClaveDetalle('x', HASH_SEÑUELO);
      return fallo();
    }
    if (fila.estado === 'BLOQUEADO') {
      // Se verifica igual para no distinguir el estado por tiempo de respuesta.
      verificarClaveDetalle(clave, HASH_SEÑUELO);
      return reply.code(401).send(error(401, 'CREDENCIALES_INVALIDAS', 'Usuario o contraseña incorrectos.'));
    }

    const chequeo = verificarClaveDetalle(clave, fila.clave_hash);
    if (!chequeo.valida) {
      await auditar({ actorId: fila.id, actor: fila.nombre, accion: 'LOGIN_FALLIDO', entidad: 'usuario', entidadId: fila.id, ip: req.ip });
      return fallo();
    }

    // Contraseña correcta: se limpia el contador de intentos.
    await q('DELETE FROM core.intento_login WHERE usuario = lower($1)', [usuario]);

    // Migración transparente a Argon2id si la cuenta venía con scrypt.
    if (chequeo.rehash) {
      await q('UPDATE core.usuario SET clave_hash = $1 WHERE id = $2', [hashClave(clave), fila.id]);
    }

    const rol = await rolDeUsuario(fila.id);
    if (!rol) return reply.code(403).send(error(403, 'SIN_ROL', 'El usuario no tiene un rol asignado.'));

    // Qué roles exigen segundo factor se administra en Usuarios y roles (rol.exige_mfa).
    const exigeMfa = (await uno<{ exige: boolean }>('SELECT exige_mfa exige FROM core.rol WHERE id = $1', [rol]))?.exige === true;

    // Segundo factor: si ya está activo se pide; si es obligatorio y falta, se enrola.
    if (fila.mfa_activo) {
      const ticket = await firmarTicketMfa({ sub: fila.id, nombre: fila.nombre, rol });
      return reply.send({ mfaRequerido: true, ticket, usuario: { nombre: fila.nombre } });
    }
    // En producción el segundo factor es obligatorio para estos perfiles; en
    // desarrollo se puede desactivar con MFA_OBLIGATORIO=false para no frenar las pruebas.
    const mfaObligatorio = (process.env.MFA_OBLIGATORIO ?? (ES_PROD ? 'true' : 'false')) !== 'false';
    if (exigeMfa && mfaObligatorio) {
      const ticket = await firmarTicketMfa({ sub: fila.id, nombre: fila.nombre, rol });
      return reply.send({ mfaEnrolamiento: true, ticket, usuario: { nombre: fila.nombre } });
    }

    return emitirSesion(req, reply, fila.id, fila.nombre, rol, undefined, parseo.data.recordar);
  });

  /** POST /auth/mfa/enrolar — genera el secreto y la URL para la app autenticadora. */
  app.post('/auth/mfa/enrolar', ESTRICTO, async (req, reply) => {
    const parseo = Ticket.safeParse(req.body);
    if (!parseo.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Falta el ticket de la sesión.'));

    const carga = await verificarTicket(parseo.data.ticket);
    if (!carga) return reply.code(401).send(error(401, 'TICKET_INVALIDO', 'Vuelve a ingresar.'));

    // Con MFA ya activo el ticket solo sirve para verificar: enrolar de nuevo saltaría el segundo factor.
    const secreto = generarSecretoMfa();
    const enrolado = await uno('UPDATE core.usuario SET mfa_secreto = $1 WHERE id = $2 AND NOT mfa_activo RETURNING id', [secreto, carga.sub]);
    if (!enrolado) return reply.code(409).send(error(409, 'MFA_YA_ACTIVO', 'El segundo factor ya está activo. Ingresa el código de tu app autenticadora.'));
    const cuenta = await uno<{ usuario: string }>('SELECT usuario FROM core.usuario WHERE id = $1', [carga.sub]);

    return reply.send({
      secreto,
      otpauth: urlOtpauth(secreto, cuenta?.usuario ?? carga.nombre),
      instrucciones: 'Escanea el código en Google Authenticator o Authy, y confirma con los 6 dígitos.',
    });
  });

  /** POST /auth/mfa/activar — confirma el primer código y abre la sesión. */
  app.post('/auth/mfa/activar', ESTRICTO, async (req, reply) => {
    const parseo = VerificarMfa.safeParse(req.body);
    if (!parseo.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Falta el código de 6 dígitos.'));

    const carga = await verificarTicket(parseo.data.ticket);
    if (!carga) return reply.code(401).send(error(401, 'TICKET_INVALIDO', 'Vuelve a ingresar.'));

    const fila = await uno<{ mfa_secreto: string | null; nombre: string; mfa_activo: boolean }>(
      'SELECT mfa_secreto, nombre, mfa_activo FROM core.usuario WHERE id = $1', [carga.sub],
    );
    if (fila?.mfa_activo) return reply.code(409).send(error(409, 'MFA_YA_ACTIVO', 'El segundo factor ya está activo. Ingresa el código de tu app autenticadora.'));
    if (!fila?.mfa_secreto) return reply.code(409).send(error(409, 'MFA_NO_INICIADO', 'Primero solicita el código de enrolamiento.'));
    if (!verificarTotp(fila.mfa_secreto, parseo.data.codigo)) {
      return reply.code(422).send(error(422, 'CODIGO_INCORRECTO', 'El código no es válido. Revisa la hora de tu teléfono.'));
    }

    await q('UPDATE core.usuario SET mfa_activo = true, mfa_activado_en = now() WHERE id = $1', [carga.sub]);
    await auditar({ actorId: carga.sub, actor: fila.nombre, rol: carga.rol, accion: 'MFA_ACTIVADO', entidad: 'usuario', entidadId: carga.sub, ip: req.ip });

    // Se entregan una sola vez. Sin ellos, perder el teléfono deja la cuenta fuera.
    const codigos = await generarCodigosRecuperacion(carga.sub);
    return emitirSesion(req, reply, carga.sub, fila.nombre, carga.rol, codigos);
  });

  /** POST /auth/mfa/recuperacion — regenera los códigos de respaldo (requiere sesión). */
  app.post('/auth/mfa/recuperacion', { preHandler: autenticar, ...ESTRICTO }, async (req, reply) => {
    const u = req.usuario!;
    // Pide la contraseña: con solo un token robado no se reemplazan los códigos de respaldo del dueño.
    const clave = String((req.body as { clave?: unknown } | undefined)?.clave ?? '').slice(0, 128);
    const fila = await uno<{ clave_hash: string }>('SELECT clave_hash FROM core.usuario WHERE id = $1', [u.id]);
    if (!clave || !fila || !verificarClaveDetalle(clave, fila.clave_hash).valida) {
      return reply.code(403).send(error(403, 'CLAVE_ACTUAL_INCORRECTA', 'Escribe tu contraseña actual para generar códigos nuevos.'));
    }
    const codigos = await generarCodigosRecuperacion(u.id);
    await auditar({ actorId: u.id, actor: u.nombre, rol: u.rol, accion: 'MFA_CODIGOS_REGENERADOS', entidad: 'usuario', entidadId: u.id, ip: req.ip });
    return reply.send({ codigos });
  });

  /** POST /auth/mfa/verificar — segundo factor en un inicio de sesión normal. */
  app.post('/auth/mfa/verificar', ESTRICTO, async (req, reply) => {
    const parseo = VerificarMfa.safeParse(req.body);
    if (!parseo.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Falta el código.'));
    const codigo = parseo.data.codigo.trim();

    const carga = await verificarTicket(parseo.data.ticket);
    if (!carga) return reply.code(401).send(error(401, 'TICKET_INVALIDO', 'Vuelve a ingresar.'));

    const fila = await uno<{ mfa_secreto: string | null; nombre: string; estado: string }>(
      'SELECT mfa_secreto, nombre, estado FROM core.usuario WHERE id = $1', [carga.sub],
    );
    if (!fila || fila.estado !== 'ACTIVO') return reply.code(401).send(error(401, 'SESION_INVALIDA', 'Cuenta no disponible.'));
    if (mfaBloqueado(carga.sub)) return reply.code(429).send(error(429, 'MFA_BLOQUEADO', 'Demasiados códigos incorrectos. Espera 15 minutos.'));

    const esRecuperacion = codigo.replace(/-/g, '').length >= 8;
    let valido = false;

    if (esRecuperacion) {
      valido = await consumirCodigoRecuperacion(carga.sub, codigo);
      if (valido) {
        await auditar({ actorId: carga.sub, actor: fila.nombre, accion: 'MFA_RECUPERACION', entidad: 'usuario', entidadId: carga.sub, ip: req.ip });
      }
    } else if (fila.mfa_secreto) {
      valido = totpUnaVez(carga.sub, fila.mfa_secreto, codigo);
    }

    if (!valido) {
      registrarFalloMfa(carga.sub);
      await auditar({ actorId: carga.sub, actor: fila.nombre, accion: 'MFA_FALLIDO', entidad: 'usuario', entidadId: carga.sub, ip: req.ip });
      return reply.code(422).send(error(422, 'CODIGO_INCORRECTO',
        esRecuperacion ? 'El código de recuperación no es válido o ya se usó.' : 'El código no es válido.'));
    }

    return emitirSesion(req, reply, carga.sub, fila.nombre, carga.rol);
  });

  /** POST /auth/refresh — rota el token. El refresco viaja en cookie HttpOnly. */
  app.post('/auth/refresh', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const enCookie = (req as { cookies?: Record<string, string> }).cookies?.[COOKIE];
    const enCuerpo = Refresh.safeParse(req.body ?? {}).success ? (req.body as { refreshToken?: string }).refreshToken : undefined;
    const token = enCookie ?? enCuerpo;
    if (!token) return reply.code(401).send(error(401, 'REFRESCO_INVALIDO', 'Sesión no válida. Vuelve a ingresar.'));

    return tx(async (c) => {
      const hash = sha256(token);
      const r = await c.query<{ id: string; usuario_id: string; familia: string; revocado_en: string | null; expira_en: string; creado_en: string }>(
        'SELECT id, usuario_id, familia, revocado_en, expira_en, creado_en FROM core.refresh_token WHERE token_hash = $1 FOR UPDATE',
        [hash],
      );
      const fila = r.rows[0];
      if (!fila) return reply.code(401).send(error(401, 'REFRESCO_INVALIDO', 'Sesión no válida. Vuelve a ingresar.'));

      if (fila.revocado_en) {
        await c.query('UPDATE core.refresh_token SET revocado_en = now() WHERE familia = $1 AND revocado_en IS NULL', [fila.familia]);
        await auditar({ actorId: fila.usuario_id, accion: 'REFRESCO_REUSO', entidad: 'refresh_token', entidadId: fila.id, ip: req.ip });
        quitarCookie(reply);
        return reply.code(401).send(error(401, 'SESION_COMPROMETIDA', 'Por seguridad cerramos todas las sesiones. Vuelve a ingresar.'));
      }
      if (new Date(fila.expira_en) < new Date()) {
        return reply.code(401).send(error(401, 'REFRESCO_EXPIRADO', 'La sesión expiró. Vuelve a ingresar.'));
      }

      const usuario = await c.query<{ id: string; nombre: string; estado: string }>(
        'SELECT id, nombre, estado FROM core.usuario WHERE id = $1', [fila.usuario_id],
      );
      const u = usuario.rows[0];
      if (!u || u.estado !== 'ACTIVO') {
        return reply.code(401).send(error(401, 'SESION_INVALIDA', 'La cuenta ya no está activa.'));
      }
      const rol = await rolDeUsuario(u.id);
      if (!rol) return reply.code(403).send(error(403, 'SIN_ROL', 'El usuario no tiene rol asignado.'));

      await c.query('UPDATE core.refresh_token SET revocado_en = now() WHERE id = $1', [fila.id]);
      const { token: nuevoToken, hash: nuevoHash } = nuevoRefreshToken();
      // La sesión sin "recordar" (vida < 1 día) sigue siendo corta al renovarse.
      const recordar = Date.parse(fila.expira_en) - Date.parse(fila.creado_en) > 86_400_000;
      await c.query(
        `INSERT INTO core.refresh_token (usuario_id, token_hash, familia, expira_en)
         VALUES ($1,$2,$3, now() + $4::interval)`,
        [fila.usuario_id, nuevoHash, fila.familia, recordar ? `${REFRESCO_DIAS} days` : '12 hours'],
      );

      ponerCookie(reply, nuevoToken, recordar);
      const acceso = await firmarAcceso({ sub: u.id, nombre: u.nombre, rol, pv: 1 });
      return reply.send({
        accessToken: acceso,
        expiraEn: ACCESO_MIN * 60,
        rol,
        ...(esNavegador(req) ? {} : { refreshToken: nuevoToken }),
      });
    });
  });

  /** GET /auth/yo — perfil, permisos y menú calculado para el rol. */
  app.get('/auth/yo', { preHandler: autenticar }, async (req, reply) => {
    const u = req.usuario!;
    const filas = await q<{ id: string; grupo: string; etiqueta: string; ruta: string; icono: string }>(
      `SELECT n.id, n.grupo, n.etiqueta, n.ruta, n.icono
       FROM core.navegacion n
       JOIN core.rol_permiso rp ON rp.permiso_id = n.permiso_id AND rp.rol_id = $1
       ORDER BY n.grupo_orden, n.orden`,
      [u.rol],
    );
    const grupos: Array<{ titulo: string; items: unknown[] }> = [];
    for (const f of filas) {
      let g = grupos.find((x) => x.titulo === f.grupo);
      if (!g) { g = { titulo: f.grupo, items: [] }; grupos.push(g); }
      g.items.push({ id: f.id, etiqueta: f.etiqueta, ruta: f.ruta, icono: f.icono });
    }
    const rol = await uno('SELECT id, nombre, corto, descripcion, perfil, icono FROM core.rol WHERE id = $1', [u.rol]);
    const foto = await uno<{ foto_id: string | null }>('SELECT foto_id FROM core.usuario WHERE id = $1', [u.id]);
    return reply.send({
      usuario: { id: u.id, nombre: u.nombre, fotoUrl: foto?.foto_id ? `/archivos/${foto.foto_id}` : null },
      rol, permisos: [...u.permisos], navegacion: grupos,
    });
  });

  /** POST /auth/logout — revoca el refresco y borra la cookie. */
  /* ------------------------------------------------ recuperar contraseña */
  // Paso 1: pide el código. La respuesta es SIEMPRE la misma (exista o no la cuenta)
  // para no revelar qué usuarios o correos están registrados.
  const MSG_RECUPERAR = 'Si los datos corresponden a una cuenta con correo, te enviamos un código. Revisa tu bandeja.';

  app.get('/auth/recuperar/disponible', async () => ({ disponible: await correoDisponible() }));

  // SEG-04: autorregistro del cliente desde la app. El documento no se repite (CP-04) y el RUC
  // se valida con su dígito verificador. La cuenta nace con el rol Cliente, nunca con otro.
  const Registro = z.object({
    nombre: z.string().trim().min(3).max(150),
    docTipo: z.enum(['DNI', 'RUC']),
    docNumero: z.string().trim(),
    telefono: z.string().trim().min(6).max(20).regex(/^[0-9+ ]+$/, 'Teléfono inválido'),
    email: z.string().trim().toLowerCase().email().max(160),
    direccion: z.string().trim().min(5).max(200),
    usuario: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{4,30}$/, 'Usuario de 4 a 30 letras o números'),
    clave: z.string().max(128),
  }).refine((d) => docValido(d.docTipo, d.docNumero), { message: 'Número de documento inválido', path: ['docNumero'] });

  app.post('/auth/registro', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const p = Registro.safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues[0]?.message ?? 'Revisa tus datos.'));
    const d = p.data;
    const corta = await claveCorta(d.clave);
    if (corta) return reply.code(422).send(error(422, 'CLAVE_CORTA', corta));
    try {
      await tx(async (c) => {
        if ((await c.query('SELECT 1 FROM core.cliente WHERE doc_tipo = $1 AND doc_numero = $2', [d.docTipo, d.docNumero])).rowCount) {
          throw Object.assign(new Error('Ese documento ya está registrado. Si es tuyo, recupera tu contraseña.'), { status: 409 });
        }
        if ((await c.query('SELECT 1 FROM core.usuario WHERE lower(usuario) = $1 OR lower(email) = $2', [d.usuario, d.email])).rowCount) {
          throw Object.assign(new Error('Ese usuario o correo ya existe.'), { status: 409 });
        }
        const cli = (await c.query<{ id: string }>(`INSERT INTO core.cliente (codigo, nombre, doc_tipo, doc_numero, telefono, email, direccion)
          VALUES ('CLI-' || lpad((SELECT coalesce(max(substring(codigo from 5)::int), 0) + 1 FROM core.cliente WHERE codigo ~ '^CLI-[0-9]+$')::text, 4, '0'),
                  $1,$2,$3,$4,$5,$6) RETURNING id`, [d.nombre, d.docTipo, d.docNumero, d.telefono, d.email, d.direccion])).rows[0];
        await c.query('INSERT INTO core.direccion_cliente (cliente_id, direccion) VALUES ($1,$2)', [cli.id, d.direccion]);
        const u = (await c.query<{ id: string }>('INSERT INTO core.usuario (nombre, usuario, email, telefono, clave_hash, cliente_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
          [d.nombre, d.usuario, d.email, d.telefono, hashClave(d.clave), cli.id])).rows[0];
        await c.query("INSERT INTO core.usuario_rol (usuario_id, rol_id) VALUES ($1, 'CLIENTE')", [u.id]);
        await auditar({ actorId: u.id, actor: d.nombre, rol: 'CLIENTE', accion: 'CLIENTE_AUTORREGISTRO', entidad: 'cliente', entidadId: cli.id, detalle: { docTipo: d.docTipo }, ip: req.ip });
      });
      return reply.code(201).send({ ok: true, mensaje: 'Cuenta creada. Ya puedes iniciar sesión.' });
    } catch (e) {
      const err = e as Error & { status?: number; code?: string };
      if (err.code === '23505') return reply.code(409).send(error(409, 'DUPLICADO', 'Ese documento, usuario o correo ya está registrado.'));
      if (!err.status) throw e;
      return reply.code(err.status).send(error(err.status, 'REGISTRO_INVALIDO', err.message));
    }
  });

  app.post('/auth/recuperar', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const p = z.object({ identificador: z.string().trim().min(3).max(160) }).safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Escribe tu usuario o correo.'));
    const id = p.data.identificador.toLowerCase();
    const u = await uno<{ id: string; nombre: string; email: string }>(
      `SELECT id, nombre, email FROM core.usuario
       WHERE (lower(usuario) = $1 OR lower(email) = $1) AND estado = 'ACTIVO' AND email <> '' AND eliminado_en IS NULL LIMIT 1`, [id]);
    if (u) {
      // Máximo 3 códigos por hora por cuenta: evita usar el sistema para inundar un correo.
      const recientes = await uno<{ n: string }>("SELECT count(*) n FROM core.recuperacion WHERE usuario_id = $1 AND creado_en > now() - interval '1 hour'", [u.id]);
      if (Number(recientes?.n ?? 0) < 3) {
        const codigo = String(randomInt(0, 1_000_000)).padStart(6, '0');
        await tx(async (c) => {
          await c.query('UPDATE core.recuperacion SET usado_en = now() WHERE usuario_id = $1 AND usado_en IS NULL', [u.id]);
          await c.query("INSERT INTO core.recuperacion (usuario_id, codigo_hash, expira_en) VALUES ($1, $2, now() + interval '15 minutes')", [u.id, sha256(codigo)]);
        });
        try {
          await enviarCorreo(u.email, 'Código para restablecer tu contraseña',
            [`Hola ${u.nombre.split(' ')[0]}:`, 'Usa este código para crear una contraseña nueva. Vence en 15 minutos y sirve una sola vez.'], codigo);
          await auditar({ actorId: u.id, actor: u.nombre, rol: '', accion: 'RECUPERACION_SOLICITADA', entidad: 'usuario', entidadId: u.id, ip: req.ip });
        } catch (e) {
          req.log.error({ err: e }, 'no se pudo enviar el correo de recuperación');
          // Sin correo configurado sí se avisa: es un problema del sistema, no revela la cuenta.
          if (!(await correoDisponible())) return reply.code(503).send(error(503, 'CORREO_NO_CONFIGURADO', 'La recuperación por correo no está disponible. Contacta al administrador.'));
        }
      }
    }
    return { ok: true, mensaje: MSG_RECUPERAR };
  });

  // Paso 2: código + contraseña nueva. 5 intentos por código; luego hay que pedir otro.
  app.post('/auth/restablecer', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const p = z.object({
      identificador: z.string().trim().min(3).max(160), codigo: z.string().regex(/^\d{6}$/, 'El código tiene 6 dígitos'),
      nueva: z.string().max(128),
    }).safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues[0]?.message ?? 'Datos inválidos.'));
    const corta = await claveCorta(p.data.nueva);
    if (corta) return reply.code(422).send(error(422, 'CLAVE_CORTA', corta));
    const invalido = () => reply.code(400).send(error(400, 'CODIGO_INVALIDO', 'El código no es válido o ya venció. Pide uno nuevo.'));
    const u = await uno<{ id: string; nombre: string; usuario: string; rol: string | null }>(
      `SELECT u.id, u.nombre, u.usuario, (SELECT rol_id FROM core.usuario_rol WHERE usuario_id = u.id LIMIT 1) rol FROM core.usuario u
       WHERE (lower(u.usuario) = $1 OR lower(u.email) = $1) AND u.estado = 'ACTIVO' LIMIT 1`, [p.data.identificador.toLowerCase()]);
    if (!u) return invalido();
    const r = await uno<{ id: string; codigo_hash: string; intentos: number }>(
      'SELECT id, codigo_hash, intentos FROM core.recuperacion WHERE usuario_id = $1 AND usado_en IS NULL AND expira_en > now() ORDER BY id DESC LIMIT 1', [u.id]);
    if (!r) return invalido();
    // El intento se cuenta ANTES de comparar y de forma atómica: peticiones en paralelo no prueban más de 5 códigos.
    const cuenta = await uno<{ intentos: number }>('UPDATE core.recuperacion SET intentos = intentos + 1 WHERE id = $1 AND intentos < 5 RETURNING intentos', [r.id]);
    if (!cuenta || r.codigo_hash !== sha256(p.data.codigo)) return invalido();
    await tx(async (c) => {
      await c.query('UPDATE core.recuperacion SET usado_en = now() WHERE id = $1', [r.id]);
      await c.query('UPDATE core.usuario SET clave_hash = $1 WHERE id = $2', [hashClave(p.data.nueva), u.id]);
      await c.query('UPDATE core.refresh_token SET revocado_en = now() WHERE usuario_id = $1 AND revocado_en IS NULL', [u.id]);
      // Restablecer desbloquea la cuenta si estaba bloqueada por intentos fallidos.
      await c.query('DELETE FROM core.intento_login WHERE lower(usuario) = lower($1)', [u.usuario]);
    });
    invalidar(`sesion:${u.id}`);
    await auditar({ actorId: u.id, actor: u.nombre, rol: u.rol ?? '', accion: 'CLAVE_RESTABLECIDA_POR_CORREO', entidad: 'usuario', entidadId: u.id, ip: req.ip });
    return { ok: true, mensaje: 'Contraseña actualizada. Ya puedes ingresar.' };
  });

  app.post('/auth/logout', { preHandler: autenticar }, async (req, reply) => {
    const enCookie = (req as { cookies?: Record<string, string> }).cookies?.[COOKIE];
    const enCuerpo = (req.body as { refreshToken?: string } | undefined)?.refreshToken;
    const token = enCookie ?? enCuerpo;
    if (token) {
      await q('UPDATE core.refresh_token SET revocado_en = now() WHERE token_hash = $1', [sha256(token)]);
    }
    quitarCookie(reply);
    await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'LOGOUT', entidad: 'usuario', entidadId: req.usuario!.id, ip: req.ip });
    return reply.send({ ok: true });
  });

  /* ------------------------------------------------------------ interno */

  /**
   * Genera 8 códigos de un solo uso y guarda solo su hash.
   * Se devuelven en claro una vez: ni el soporte puede recuperarlos después.
   */
  async function generarCodigosRecuperacion(usuarioId: string): Promise<string[]> {
    const ALF = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin caracteres que se confunden (0/O, 1/I/L)
    const codigos: string[] = [];
    await q('DELETE FROM core.mfa_codigo WHERE usuario_id = $1 AND usado_en IS NULL', [usuarioId]);
    for (let i = 0; i < 8; i++) {
      // randomInt es criptográficamente seguro; Math.random no lo es.
      const crudo = Array.from({ length: 10 }, () => ALF[randomInt(ALF.length)]).join('');
      codigos.push(`${crudo.slice(0, 5)}-${crudo.slice(5)}`);
      await q(
        'INSERT INTO core.mfa_codigo (usuario_id, codigo_hash) VALUES ($1, $2)',
        [usuarioId, sha256(crudo)],
      );
    }
    return codigos;
  }

  /** Devuelve true solo la primera vez que se usa un código. */
  async function consumirCodigoRecuperacion(usuarioId: string, codigo: string): Promise<boolean> {
    const hash = sha256(codigo.replace(/[^A-Za-z0-9]/g, '').toUpperCase());
    const r = await q<{ id: string }>(
      `UPDATE core.mfa_codigo SET usado_en = now()
       WHERE usuario_id = $1 AND codigo_hash = $2 AND usado_en IS NULL
       RETURNING id`,
      [usuarioId, hash],
    );
    return r.length > 0;
  }

  // Solo acepta tickets de MFA (audiencia propia); un token de acceso aquí no sirve, y viceversa.
  const verificarTicket = (ticket: string) => verificarTicketMfa(ticket);

  async function emitirSesion(
    req: { ip: string; headers: Record<string, unknown> },
    reply: FastifyReply,
    usuarioId: string,
    nombre: string,
    rol: string,
    codigosRecuperacion?: string[],
    recordar = true,
  ) {
    const permisos = await permisosDeRol(rol);
    const acceso = await firmarAcceso({ sub: usuarioId, nombre, rol, pv: 1 });
    const { token, hash } = nuevoRefreshToken();
    const familia = crypto.randomUUID();

    await q(
      `INSERT INTO core.refresh_token (usuario_id, token_hash, familia, expira_en)
       VALUES ($1,$2,$3, now() + $4::interval)`,
      [usuarioId, hash, familia, recordar ? `${REFRESCO_DIAS} days` : '12 hours'],
    );
    await q('UPDATE core.usuario SET ultimo_acceso = now() WHERE id = $1', [usuarioId]);
    await auditar({ actorId: usuarioId, actor: nombre, rol, accion: 'LOGIN', entidad: 'usuario', entidadId: usuarioId, ip: req.ip });

    ponerCookie(reply, token, recordar);
    return reply.send({
      accessToken: acceso,
      expiraEn: ACCESO_MIN * 60,
      usuario: { id: usuarioId, nombre },
      rol,
      permisos,
      // Solo para clientes nativos; el navegador recibe el refresco en la cookie.
      ...(esNavegador(req) ? {} : { refreshToken: token }),
      ...(codigosRecuperacion ? { codigosRecuperacion } : {}),
    });
  }
}

/** DNI: 8 dígitos. RUC: 11 dígitos, empieza en 10/15/17/20 y cumple el dígito verificador (módulo 11). */
export function docValido(tipo: 'DNI' | 'RUC', n: string): boolean {
  if (tipo === 'DNI') return /^\d{8}$/.test(n);
  if (!/^(10|15|17|20)\d{9}$/.test(n)) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const r = 11 - ([...n.slice(0, 10)].reduce((s, d, i) => s + Number(d) * pesos[i], 0) % 11);
  return (r === 10 ? 0 : r === 11 ? 1 : r) === Number(n[10]);
}
