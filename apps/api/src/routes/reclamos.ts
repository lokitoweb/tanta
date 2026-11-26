import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, tx, uno } from '../db.js';
import { autenticar, error } from '../seguridad.js';
import { auditar } from '../auditoria.js';
import { emitirEvento, guardarImagen } from './sistema.js';
import { avisar } from './notificaciones.js';

/**
 * Reclamos (pedido del ingeniero): el cliente lo registra desde la app (con su pedido y una foto si quiere), la panadería
 * responde y lo lleva por sus estados (Abierto → En proceso → Resuelto → Cerrado) y cada paso queda en el seguimiento.
 * Los motivos son un catálogo (Maestros → Catálogos → Tipos de reclamo). El cliente solo ve los suyos.
 */

const ESTADOS = ['ABIERTO', 'EN_PROCESO', 'RESUELTO', 'CERRADO'] as const;
const NOMBRE: Record<string, string> = { ABIERTO: 'abierto', EN_PROCESO: 'en proceso', RESUELTO: 'resuelto', CERRADO: 'cerrado' };
const fallo = (status: number, mensaje: string) => Object.assign(new Error(mensaje), { status });

type Quien = { clienteId: string | null; gestiona: boolean; ve: boolean };
async function quien(usuarioId: string, permisos: Set<string>): Promise<Quien> {
  const u = await uno<{ cliente_id: string | null }>('SELECT cliente_id FROM core.usuario WHERE id = $1', [usuarioId]);
  return { clienteId: u?.cliente_id ?? null, gestiona: permisos.has('reclamos.gestionar'), ve: permisos.has('reclamos.ver') || permisos.has('reclamos.gestionar') };
}

const LISTA = `SELECT r.id, r.codigo, r.estado, r.tipo, t.nombre "tipoNombre", r.descripcion, r.resolucion, r.creado_en "creadoEn", r.resuelto_en "resueltoEn",
    c.nombre cliente, r.cliente_id "clienteId", p.codigo pedido, (r.foto_id IS NOT NULL) "conFoto",
    (SELECT max(s.creado_en) FROM core.reclamo_seguimiento s WHERE s.reclamo_id = r.id) "ultimaRespuesta",
    (SELECT count(*)::int FROM core.reclamo_seguimiento s WHERE s.reclamo_id = r.id) mensajes
  FROM core.reclamo r JOIN core.tipo_reclamo t ON t.codigo = r.tipo JOIN core.cliente c ON c.id = r.cliente_id LEFT JOIN core.pedido p ON p.id = r.pedido_id`;

export async function rutasReclamos(app: FastifyInstance) {
  app.get('/reclamos', { preHandler: autenticar }, async (req, reply) => {
    const yo = await quien(req.usuario!.id, req.usuario!.permisos);
    if (!yo.clienteId && !yo.ve) return reply.code(403).send(error(403, 'SIN_PERMISO', 'Falta el permiso reclamos.ver.'));
    const f = z.object({ estado: z.enum(ESTADOS).optional() }).safeParse(req.query);
    return q(`${LISTA} WHERE ($1::uuid IS NULL OR r.cliente_id = $1) AND ($2::text IS NULL OR r.estado = $2)
      ORDER BY (r.estado IN ('ABIERTO','EN_PROCESO')) DESC, r.creado_en DESC LIMIT 300`, [yo.clienteId, f.success ? f.data.estado ?? null : null]);
  });

  app.get('/reclamos/:codigo', { preHandler: autenticar }, async (req, reply) => {
    const yo = await quien(req.usuario!.id, req.usuario!.permisos);
    const r = await uno<Record<string, unknown>>(`${LISTA} WHERE r.codigo = $1`, [(req.params as { codigo: string }).codigo]);
    if (!r || (yo.clienteId ? r.clienteId !== yo.clienteId : !yo.ve)) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'El reclamo no existe.'));
    const seguimiento = await q(`SELECT id, autor, de_cliente "deCliente", mensaje, estado, creado_en "creadoEn" FROM core.reclamo_seguimiento WHERE reclamo_id = $1 ORDER BY id`, [r.id]);
    return { ...r, seguimiento };
  });

  // Foto adjunta: privada, la ve el cliente dueño o el personal de reclamos.
  app.get('/reclamos/:codigo/foto', { preHandler: autenticar }, async (req, reply) => {
    const yo = await quien(req.usuario!.id, req.usuario!.permisos);
    const f = await uno<{ mime: string; datos: Buffer; cliente_id: string }>(`SELECT a.mime, a.datos, r.cliente_id FROM core.reclamo r JOIN core.archivo a ON a.id = r.foto_id WHERE r.codigo = $1`,
      [(req.params as { codigo: string }).codigo]);
    if (!f || (yo.clienteId ? f.cliente_id !== yo.clienteId : !yo.ve)) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'Foto no encontrada.'));
    return reply.header('Content-Type', f.mime).header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'").send(f.datos);
  });

  const Nuevo = z.object({
    tipo: z.string().trim().toUpperCase().max(20),
    descripcion: z.string().trim().min(10, 'Cuéntanos qué pasó (mínimo 10 caracteres).').max(1000),
    pedido: z.string().trim().max(30).optional(),
    foto: z.string().max(1_500_000).startsWith('data:').optional(),
  });

  app.post('/reclamos', { preHandler: autenticar, bodyLimit: 2_000_000 }, async (req, reply) => {
    const yo = await quien(req.usuario!.id, req.usuario!.permisos);
    if (!yo.clienteId || !req.usuario!.permisos.has('reclamos.crear')) return reply.code(403).send(error(403, 'SOLO_CLIENTES', 'Los reclamos los registra el cliente desde su cuenta.'));
    const p = Nuevo.safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues[0]?.message ?? 'Reclamo inválido.'));
    const d = p.data;
    try {
      if (!(await uno('SELECT 1 FROM core.tipo_reclamo WHERE codigo = $1 AND activo', [d.tipo]))) throw fallo(422, 'Elige el motivo del reclamo.');
      const pedido = d.pedido ? await uno<{ id: string }>('SELECT id FROM core.pedido WHERE codigo = $1 AND cliente_id = $2', [d.pedido, yo.clienteId]) : null;
      if (d.pedido && !pedido) throw fallo(422, 'Ese pedido no es tuyo o no existe.');
      const foto = d.foto ? await guardarImagen(d.foto, req.usuario!.id, true) : null;
      const r = await tx(async (c) => (await c.query<{ codigo: string }>(`INSERT INTO core.reclamo (codigo, cliente_id, pedido_id, tipo, descripcion, foto_id, creado_por)
        VALUES ('RCL-' || to_char(now(),'YYYY') || '-' || lpad(nextval('core.reclamo_correlativo_seq')::text, 6, '0'), $1,$2,$3,$4,$5,$6) RETURNING codigo`,
        [yo.clienteId, pedido?.id ?? null, d.tipo, d.descripcion, foto, req.usuario!.id])).rows[0]);
      await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'RECLAMO_REGISTRADO', entidad: 'reclamo', entidadId: r.codigo,
        detalle: { tipo: d.tipo, pedido: d.pedido, foto: Boolean(foto) }, ip: req.ip });
      avisar([{ permiso: 'reclamos.gestionar' }], { tipo: 'reclamo', titulo: `Reclamo ${r.codigo}`, cuerpo: `${req.usuario!.nombre}: ${d.descripcion.slice(0, 160)}`, ruta: '/ventas/reclamos' });
      void emitirEvento('reclamo.nuevo', { codigo: r.codigo });
      return reply.code(201).send({ codigo: r.codigo, estado: 'ABIERTO' });
    } catch (e) {
      const err = e as Error & { status?: number; codigo?: string };
      if (!err.status) throw e;
      return reply.code(err.status).send(error(err.status, err.codigo ?? 'RECLAMO_INVALIDO', err.message));
    }
  });

  // Seguimiento: el cliente escribe (si estaba resuelto, se reabre); la panadería responde y cambia el estado.
  // Resolverlo exige escribir la solución, que queda como «resolución» del reclamo.
  const Paso = z.object({ mensaje: z.string().trim().min(2, 'Escribe el mensaje.').max(1000), estado: z.enum(['EN_PROCESO', 'RESUELTO', 'CERRADO']).optional() });

  app.post('/reclamos/:codigo/seguimiento', { preHandler: autenticar }, async (req, reply) => {
    const yo = await quien(req.usuario!.id, req.usuario!.permisos);
    const { codigo } = req.params as { codigo: string };
    const p = Paso.safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues[0]?.message ?? 'Mensaje inválido.'));
    if (!yo.clienteId && !yo.gestiona) return reply.code(403).send(error(403, 'SIN_PERMISO', 'Falta el permiso reclamos.gestionar.'));
    if (yo.clienteId && p.data.estado) return reply.code(403).send(error(403, 'SIN_PERMISO', 'El estado del reclamo lo cambia la panadería.'));
    try {
      const r = await tx(async (c) => {
        const rec = (await c.query<{ id: string; estado: string; cliente_id: string }>('SELECT id, estado, cliente_id FROM core.reclamo WHERE codigo = $1 FOR UPDATE', [codigo])).rows[0];
        if (!rec || (yo.clienteId && rec.cliente_id !== yo.clienteId)) throw fallo(404, 'El reclamo no existe.');
        if (rec.estado === 'CERRADO') throw fallo(409, 'El reclamo está cerrado: registra uno nuevo si el problema sigue.');
        // El cliente que responde a un reclamo resuelto lo reabre; la panadería, sin estado, lo pone en proceso si estaba abierto.
        const destino = yo.clienteId ? (rec.estado === 'RESUELTO' ? 'EN_PROCESO' : null) : p.data.estado ?? (rec.estado === 'ABIERTO' ? 'EN_PROCESO' : null);
        await c.query(`INSERT INTO core.reclamo_seguimiento (reclamo_id, usuario_id, autor, de_cliente, mensaje, estado) VALUES ($1,$2,$3,$4,$5,$6)`,
          [rec.id, req.usuario!.id, req.usuario!.nombre, Boolean(yo.clienteId), p.data.mensaje, destino]);
        if (destino) {
          await c.query(`UPDATE core.reclamo SET estado = $2,
              resolucion = CASE WHEN $2 = 'RESUELTO' THEN $3 ELSE resolucion END,
              resuelto_por = CASE WHEN $2 = 'RESUELTO' THEN $4::uuid ELSE resuelto_por END,
              resuelto_en = CASE WHEN $2 = 'RESUELTO' THEN now() WHEN $2 = 'EN_PROCESO' THEN NULL ELSE resuelto_en END,
              asignado_a = coalesce(asignado_a, CASE WHEN $5 THEN NULL ELSE $4::uuid END) WHERE id = $1`,
            [rec.id, destino, p.data.mensaje, req.usuario!.id, Boolean(yo.clienteId)]);
        }
        return { clienteId: rec.cliente_id, de: rec.estado, a: destino ?? rec.estado };
      });
      await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: r.de === r.a ? 'RECLAMO_RESPONDIDO' : `RECLAMO_${r.a}`, entidad: 'reclamo', entidadId: codigo,
        detalle: { de: r.de, a: r.a }, ip: req.ip });
      if (yo.clienteId) avisar([{ permiso: 'reclamos.gestionar' }], { tipo: 'reclamo', titulo: `Reclamo ${codigo}`, cuerpo: `El cliente respondió: ${p.data.mensaje.slice(0, 160)}`, ruta: '/ventas/reclamos' });
      else avisar([{ clienteId: r.clienteId }], { tipo: 'reclamo', titulo: `Tu reclamo ${codigo}${r.a !== r.de ? ` está ${NOMBRE[r.a]}` : ''}`, cuerpo: p.data.mensaje.slice(0, 200), ruta: `/reclamos/${codigo}` });
      void emitirEvento('reclamo.seguimiento', { codigo, estado: r.a });
      return { codigo, estado: r.a };
    } catch (e) {
      const err = e as Error & { status?: number };
      if (!err.status) throw e;
      return reply.code(err.status).send(error(err.status, 'RECLAMO_INVALIDO', err.message));
    }
  });
}
