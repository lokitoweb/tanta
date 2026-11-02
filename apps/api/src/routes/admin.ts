import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { q, tx, uno, num } from '../db.js';
import { autenticar, exigir, error, hashClave } from '../seguridad.js';
import { auditar, verificarCadena, ultimoEvento } from '../auditoria.js';

/**
 * Administración del sistema.
 * Todo lo que el cliente puede cambiar sin tocar código: parámetros de negocio,
 * usuarios, precios y cierre de períodos de costo.
 */
/** Solo un Superadmin crea, bloquea o cambia la clave de otro Superadmin (evita autoelevarse). */
async function protegeSuperadmin(req: FastifyRequest, reply: FastifyReply, objetivo: { rol?: string; usuarioId?: string }) {
  if (req.usuario!.rol === 'SUPERADMIN') return true;
  const esSuper = objetivo.rol === 'SUPERADMIN' || (objetivo.usuarioId && await uno(
    "SELECT 1 FROM core.usuario_rol WHERE usuario_id = $1 AND rol_id = 'SUPERADMIN'", [objetivo.usuarioId]));
  if (!esSuper) return true;
  reply.code(403).send(error(403, 'SIN_PERMISO', 'Solo el Superadministrador gestiona cuentas de Superadministrador.'));
  return false;
}

export async function rutasAdmin(app: FastifyInstance) {
  /* ------------------------------------------------------- parámetros */
  const TIPOS = new Set(['texto', 'numero', 'porcentaje', 'booleano']);

  app.get('/parametros', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'parametros.gestionar')) return;
    const filas = await q<{ clave: string; valor: string; tipo: string; descripcion: string }>(
      'SELECT clave, valor, tipo, descripcion FROM core.parametro ORDER BY clave',
    );
    return reply.send(filas);
  });

  const Cambio = z.object({ valor: z.string().min(1).max(120) });

  app.patch('/parametros/:clave', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'parametros.gestionar')) return;
    const { clave } = req.params as { clave: string };
    const parseo = Cambio.safeParse(req.body);
    if (!parseo.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Valor inválido.'));

    const actual = await uno<{ valor: string; tipo: string }>(
      'SELECT valor, tipo FROM core.parametro WHERE clave = $1', [clave],
    );
    if (!actual) return reply.code(404).send(error(404, 'PARAMETRO_NO_EXISTE', 'El parámetro no existe.'));

    const nuevo = parseo.data.valor.trim();
    // Validación por tipo: un IGV de "abc" no puede llegar a la base.
    if (actual.tipo === 'porcentaje' || actual.tipo === 'numero') {
      const n = Number(nuevo.replace(',', '.'));
      if (!Number.isFinite(n)) {
        return reply.code(422).send(error(422, 'VALOR_NO_NUMERICO', 'Este parámetro debe ser numérico.'));
      }
      if (actual.tipo === 'porcentaje' && (n < 0 || n > 1)) {
        return reply.code(422).send(error(422, 'PORCENTAJE_FUERA_DE_RANGO', 'El porcentaje debe estar entre 0 y 1 (0.18 = 18 %).'));
      }
    }
    if (actual.tipo === 'booleano' && !['true', 'false'].includes(nuevo.toLowerCase())) {
      return reply.code(422).send(error(422, 'BOOLEANO_INVALIDO', 'Usa true o false.'));
    }

    await tx(async (c) => {
      await c.query('UPDATE core.parametro SET valor = $1 WHERE clave = $2', [nuevo, clave]);
      await c.query(
        'INSERT INTO audit.parametro_historial (clave, valor_antes, valor_nuevo, usuario_id) VALUES ($1,$2,$3,$4)',
        [clave, actual.valor, nuevo, req.usuario!.id],
      );
    });
    await auditar({
      actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol,
      accion: 'PARAMETRO_CAMBIADO', entidad: 'parametro', entidadId: clave,
      detalle: { antes: actual.valor, despues: nuevo }, ip: req.ip,
    });
    return reply.send({ clave, valor: nuevo, tipo: actual.tipo });
  });

  /* ---------------------------------------------------------- usuarios */
  const NuevoUsuario = z.object({
    nombre: z.string().min(3).max(120),
    usuario: z.string().min(3).max(40).regex(/^[a-z0-9._-]+$/, 'Solo minúsculas, números, punto, guion y guion bajo.'),
    clave: z.string().min(8).max(120),
    rol: z.string().min(1),
  });

  app.post('/usuarios', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'usuarios.gestionar')) return;
    const parseo = NuevoUsuario.safeParse(req.body);
    if (!parseo.success) {
      return reply.code(422).send(error(422, 'DATOS_INVALIDOS', parseo.error.issues[0]?.message ?? 'Datos inválidos.'));
    }
    const d = parseo.data;

    if (!(await protegeSuperadmin(req, reply, { rol: d.rol }))) return;
    const rolExiste = await uno('SELECT 1 FROM core.rol WHERE id = $1', [d.rol]);
    if (!rolExiste) return reply.code(422).send(error(422, 'ROL_INEXISTENTE', 'El rol indicado no existe.'));

    const existe = await uno('SELECT 1 FROM core.usuario WHERE lower(usuario) = lower($1)', [d.usuario]);
    if (existe) return reply.code(409).send(error(409, 'USUARIO_DUPLICADO', 'Ese nombre de usuario ya está en uso.'));

    const creado = await tx(async (c) => {
      const r = await c.query<{ id: string }>(
        'INSERT INTO core.usuario (nombre, usuario, clave_hash) VALUES ($1,$2,$3) RETURNING id',
        [d.nombre, d.usuario.toLowerCase(), hashClave(d.clave)],
      );
      await c.query('INSERT INTO core.usuario_rol (usuario_id, rol_id) VALUES ($1,$2)', [r.rows[0].id, d.rol]);
      return r.rows[0].id;
    });

    await auditar({
      actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol,
      accion: 'USUARIO_CREADO', entidad: 'usuario', entidadId: creado,
      detalle: { usuario: d.usuario, rol: d.rol }, ip: req.ip,
    });
    return reply.code(201).send({ id: creado, usuario: d.usuario, rol: d.rol });
  });

  const Estado = z.object({ estado: z.enum(['ACTIVO', 'BLOQUEADO']) });

  app.patch('/usuarios/:id/estado', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'usuarios.gestionar')) return;
    const { id } = req.params as { id: string };
    const parseo = Estado.safeParse(req.body);
    if (!parseo.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Estado inválido.'));

    if (!(await protegeSuperadmin(req, reply, { usuarioId: id }))) return;
    if (id === req.usuario!.id && parseo.data.estado === 'BLOQUEADO') {
      return reply.code(409).send(error(409, 'NO_PUEDES_BLOQUEARTE', 'No puedes bloquear tu propia cuenta.'));
    }
    const fila = await uno<{ nombre: string }>('SELECT nombre FROM core.usuario WHERE id = $1', [id]);
    if (!fila) return reply.code(404).send(error(404, 'USUARIO_NO_EXISTE', 'El usuario no existe.'));

    await q('UPDATE core.usuario SET estado = $1 WHERE id = $2', [parseo.data.estado, id]);
    // Al bloquear, se revocan las sesiones activas de inmediato.
    if (parseo.data.estado === 'BLOQUEADO') {
      await q('UPDATE core.refresh_token SET revocado_en = now() WHERE usuario_id = $1 AND revocado_en IS NULL', [id]);
    }
    await auditar({
      actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol,
      accion: `USUARIO_${parseo.data.estado}`, entidad: 'usuario', entidadId: id,
      detalle: { nombre: fila.nombre }, ip: req.ip,
    });
    return reply.send({ id, estado: parseo.data.estado });
  });

  const NuevaClave = z.object({ clave: z.string().min(8).max(120) });

  app.patch('/usuarios/:id/clave', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'usuarios.gestionar')) return;
    const { id } = req.params as { id: string };
    const parseo = NuevaClave.safeParse(req.body);
    if (!parseo.success) return reply.code(422).send(error(422, 'CLAVE_CORTA', 'La contraseña debe tener al menos 8 caracteres.'));
    if (!(await protegeSuperadmin(req, reply, { usuarioId: id }))) return;

    await q('UPDATE core.usuario SET clave_hash = $1 WHERE id = $2', [hashClave(parseo.data.clave), id]);
    await q('UPDATE core.refresh_token SET revocado_en = now() WHERE usuario_id = $1 AND revocado_en IS NULL', [id]);
    await auditar({
      actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol,
      accion: 'CLAVE_RESTABLECIDA', entidad: 'usuario', entidadId: id, ip: req.ip,
    });
    return reply.send({ id, ok: true });
  });

  /* ------------------------------------------------------- precios */
  const Precio = z.object({ precioConIgv: z.number().positive().max(100000) });

  app.patch('/productos/:id/precio', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'maestros.editar')) return;
    const { id } = req.params as { id: string };
    const parseo = Precio.safeParse(req.body);
    if (!parseo.success) return reply.code(422).send(error(422, 'PRECIO_INVALIDO', 'El precio debe ser mayor que cero.'));

    const antes = await uno<{ nombre: string; precio_con_igv: string }>(
      'SELECT nombre, precio_con_igv FROM core.producto WHERE id = $1', [id],
    );
    if (!antes) return reply.code(404).send(error(404, 'PRODUCTO_NO_EXISTE', 'El producto no existe.'));

    await q('UPDATE core.producto SET precio_con_igv = $1 WHERE id = $2', [parseo.data.precioConIgv.toFixed(4), id]);
    await auditar({
      actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol,
      accion: 'PRECIO_CAMBIADO', entidad: 'producto', entidadId: id,
      detalle: { producto: antes.nombre, antes: num(antes.precio_con_igv), despues: parseo.data.precioConIgv },
      ip: req.ip,
    });
    return reply.send({ id, precioConIgv: parseo.data.precioConIgv });
  });

  /* ------------------------------------------------------- períodos */
  app.get('/periodos', { preHandler: autenticar }, async (req, reply) => {
    const filas = await q<Record<string, string>>(`
      SELECT p.id, p.anio, p.mes, p.estado, p.cif_total, p.cerrado_en::text AS cerrado_en,
             (SELECT count(*) FROM core.venta v
               WHERE date_trunc('month', v.creado_en) = make_date(p.anio, p.mes, 1)) AS ventas,
             (SELECT coalesce(sum(v.ventas_netas),0) FROM core.venta v
               WHERE v.estado = 'CONFIRMADA'
                 AND date_trunc('month', v.creado_en) = make_date(p.anio, p.mes, 1)) AS netas
      FROM core.periodo_costos p
      ORDER BY p.anio DESC, p.mes DESC`);
    return reply.send(filas.map((f) => ({
      id: f.id, anio: num(f.anio), mes: num(f.mes), estado: f.estado,
      cifTotal: num(f.cif_total), cerradoEn: f.cerrado_en, ventas: num(f.ventas), netas: num(f.netas),
    })));
  });

  /**
   * Cerrar un período congela el margen: a partir de aquí los reportes son DEFINITIVOS.
   * Es irreversible sin una reapertura explícita y auditada.
   */
  app.post('/periodos/:id/cerrar', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'periodos.cerrar')) return;
    const { id } = req.params as { id: string };

    try {
      const res = await tx(async (c) => {
        const r = await c.query<{ estado: string; anio: number; mes: number }>(
          'SELECT estado, anio, mes FROM core.periodo_costos WHERE id = $1 FOR UPDATE', [id],
        );
        const p = r.rows[0];
        if (!p) throw Object.assign(new Error('PERIODO_NO_EXISTE'), { status: 404 });
        if (p.estado === 'CERRADO') throw Object.assign(new Error('PERIODO_YA_CERRADO'), { status: 409 });

        const ventas = await c.query<{ netas: string; costo: string }>(
          `SELECT coalesce(sum(ventas_netas),0) AS netas, coalesce(sum(costo_ventas),0) AS costo
           FROM core.venta
           WHERE estado = 'CONFIRMADA'
             AND date_trunc('month', creado_en) = make_date($1, $2, 1)`,
          [p.anio, p.mes],
        );
        const netas = num(ventas.rows[0]?.netas);
        const costo = num(ventas.rows[0]?.costo);

        await c.query(
          `UPDATE core.periodo_costos SET estado = 'CERRADO', cerrado_en = now() WHERE id = $1`, [id],
        );
        return { id, anio: p.anio, mes: p.mes, estado: 'CERRADO', ventasNetas: netas, costo, margen: netas > 0 ? (netas - costo) / netas : 0 };
      });

      await auditar({
        actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol,
        accion: 'PERIODO_CERRADO', entidad: 'periodo_costos', entidadId: id,
        detalle: { anio: res.anio, mes: res.mes, margen: res.margen }, ip: req.ip,
      });
      return reply.send(res);
    } catch (e) {
      const err = e as Error & { status?: number };
      // Sin status = error no previsto: el manejador global lo traduce o lo enmascara.
      if (!err.status) throw e;
      const status = err.status;
      return reply.code(status).send(error(status, err.message, err.message));
    }
  });

  /* ------------------------------------------------------ auditoría */
  app.get('/auditoria', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'usuarios.gestionar')) return;
    const filas = await q<Record<string, string>>(
      `SELECT id, actor, rol, accion, entidad, entidad_id, detalle::text AS detalle, ocurrido_en::text AS creado_en
       FROM audit.evento ORDER BY id DESC LIMIT 100`,
    );
    return reply.send(filas.map((f) => ({
      id: num(f.id), actor: f.actor, rol: f.rol, accion: f.accion,
      entidad: f.entidad, entidadId: f.entidad_id,
      detalle: JSON.parse(f.detalle), creadoEn: f.creado_en,
    })));
  });

  /** Verifica la cadena de auditoría: si alguien tocó un evento, se detecta aquí. */
  app.get('/auditoria/verificar', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'usuarios.gestionar')) return;
    const r = await verificarCadena();
    const ultimo = await ultimoEvento();
    return reply.code(r.ok ? 200 : 409).send({ ...r, ultimo });
  });
}
