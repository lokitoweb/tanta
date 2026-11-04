import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, tx, num } from '../db.js';
import { autenticar, error } from '../seguridad.js';
import { emitirEvento, enviarPush } from './sistema.js';

/**
 * Centro de notificaciones (INF-TEC-001 A11) y avisos por área. Cada aviso se guarda para el usuario
 * (se ve aunque el celular no tenga push) y además sale por push. El destino se define por permiso:
 * Gerencia decide en Roles quién recibe qué, sin tocar código.
 */

export interface Aviso { tipo: string; titulo: string; cuerpo: string; ruta?: string }
export type Destino = { permiso: string } | { usuarioId: string } | { clienteId: string };

async function usuariosDe(d: Destino): Promise<string[]> {
  if ('usuarioId' in d) return [d.usuarioId];
  if ('clienteId' in d) return (await q<{ id: string }>(`SELECT id FROM core.usuario WHERE cliente_id = $1 AND estado = 'ACTIVO'`, [d.clienteId])).map((u) => u.id);
  return (await q<{ id: string }>(`SELECT DISTINCT ur.usuario_id id FROM core.usuario_rol ur
    JOIN core.rol_permiso rp ON rp.rol_id = ur.rol_id JOIN core.usuario u ON u.id = ur.usuario_id
    WHERE rp.permiso_id = $1 AND u.estado = 'ACTIVO'`, [d.permiso])).map((u) => u.id);
}

/** Guarda el aviso para cada destinatario (sin repetir usuarios) y lo envía por push. */
export async function notificar(destinos: Destino[], a: Aviso): Promise<number> {
  const ids = [...new Set((await Promise.all(destinos.map(usuariosDe))).flat())];
  if (!ids.length) return 0;
  await q(`INSERT INTO core.notificacion (usuario_id, tipo, titulo, cuerpo, ruta)
    SELECT u, $2, $3, $4, $5 FROM unnest($1::uuid[]) u`, [ids, a.tipo, a.titulo.slice(0, 120), a.cuerpo.slice(0, 300), a.ruta ?? '']);
  for (const id of ids) void enviarPush(id, a.titulo, a.cuerpo).catch(() => {});
  return ids.length;
}

/** Sin esperar ni romper la operación principal: un aviso fallido no deshace una venta. */
export const avisar = (destinos: Destino[], a: Aviso) => void notificar(destinos, a).catch(() => {});

// PED-05 / PED-08 / VEN-03: quién se entera de cada estado del pedido. El cliente, siempre.
const AVISO_PEDIDO: Record<string, { area?: string; texto: string; textoArea?: string }> = {
  REGISTRADO: { area: 'pedidos.gestionar', texto: 'recibimos tu pedido; te avisaremos cuando lo confirmemos', textoArea: 'pedido nuevo por confirmar' },
  CONFIRMADO: { area: 'produccion.planificar', texto: 'tu pedido fue confirmado', textoArea: 'pedido confirmado para producir' },
  RECHAZADO: { texto: 'tu pedido fue rechazado' },
  EN_PRODUCCION: { texto: 'tu pedido está en producción' },
  LISTO: { area: 'pedidos.gestionar', texto: 'tu pedido está listo', textoArea: 'pedido listo para despachar' },
  DESPACHADO: { texto: 'tu pedido salió a entrega' },
  ENTREGADO: { texto: 'tu pedido fue entregado. ¡Gracias por tu compra!' },
  CANCELADO: { area: 'pedidos.gestionar', texto: 'tu pedido fue cancelado', textoArea: 'pedido cancelado' },
};

/** Envía los avisos de los cambios de estado registrados por el trigger. SKIP LOCKED: cada cambio sale una vez. */
export async function despacharAvisosPedido(): Promise<number> {
  const cambios = await tx(async (c) => (await c.query<{ codigo: string; cliente_id: string; cliente: string; estado: string; total: string; motivo: string | null }>(`
    UPDATE core.pedido_historial h SET notificado_en = now() FROM core.pedido p
    WHERE h.id IN (SELECT id FROM core.pedido_historial WHERE notificado_en IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED) AND p.id = h.pedido_id
    RETURNING p.codigo, p.cliente_id, p.cliente, h.estado, p.total, p.motivo`)).rows);
  for (const ch of cambios) {
    const regla = AVISO_PEDIDO[ch.estado];
    if (!regla) continue;
    const motivo = ['RECHAZADO', 'CANCELADO'].includes(ch.estado) && ch.motivo ? ` (${ch.motivo})` : '';
    await notificar([{ clienteId: ch.cliente_id }], { tipo: 'pedido', titulo: `Pedido ${ch.codigo}`, cuerpo: `Hola, ${regla.texto}${motivo}.`, ruta: `/pedidos/${ch.codigo}` });
    if (regla.area) {
      await notificar([{ permiso: regla.area }], {
        tipo: 'pedido', titulo: `${ch.codigo} · ${ch.cliente}`,
        cuerpo: `${regla.textoArea![0].toUpperCase()}${regla.textoArea!.slice(1)} · S/ ${num(ch.total).toFixed(2)}${motivo}`, ruta: '/ventas/pedidos',
      });
    }
    void emitirEvento('pedido.aviso', { codigo: ch.codigo, estado: ch.estado });
  }
  return cambios.length;
}

export async function rutasNotificaciones(app: FastifyInstance) {
  app.get('/notificaciones', { preHandler: autenticar }, async (req) => {
    const filas = await q<Record<string, string>>(`SELECT id, tipo, titulo, cuerpo, ruta, leida_en IS NOT NULL leida, creado_en::text fecha
      FROM core.notificacion WHERE usuario_id = $1 ORDER BY id DESC LIMIT 100`, [req.usuario!.id]);
    const pendientes = await q<{ n: string }>('SELECT count(*) n FROM core.notificacion WHERE usuario_id = $1 AND leida_en IS NULL', [req.usuario!.id]);
    return { noLeidas: num(pendientes[0].n), avisos: filas.map((f) => ({ ...f, id: num(f.id), leida: Boolean(f.leida) })) };
  });

  // Marca leídos los avisos indicados, o todos si no se indica ninguno. Solo los propios.
  app.post('/notificaciones/leidas', { preHandler: autenticar }, async (req, reply) => {
    const p = z.object({ ids: z.array(z.number().int().positive()).max(200).optional() }).safeParse(req.body ?? {});
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Avisos inválidos.'));
    const r = await q(`UPDATE core.notificacion SET leida_en = now() WHERE usuario_id = $1 AND leida_en IS NULL
      AND ($2::bigint[] IS NULL OR id = ANY($2::bigint[])) RETURNING id`, [req.usuario!.id, p.data.ids ?? null]);
    return { marcadas: r.length };
  });

  // A09: línea de tiempo del pedido. El cliente solo ve los suyos.
  app.get('/pedidos/:codigo/historial', { preHandler: autenticar }, async (req, reply) => {
    const { codigo } = req.params as { codigo: string };
    const yo = await q<{ cliente_id: string | null }>('SELECT cliente_id FROM core.usuario WHERE id = $1', [req.usuario!.id]);
    const cli = yo[0]?.cliente_id ?? null;
    if (!cli && !req.usuario!.permisos.has('pedidos.ver')) return reply.code(403).send(error(403, 'SIN_PERMISO', 'Falta el permiso pedidos.ver.'));
    const filas = await q<{ estado: string; fecha: string }>(`SELECT h.estado, h.creado_en::text fecha FROM core.pedido_historial h JOIN core.pedido p ON p.id = h.pedido_id
      WHERE p.codigo = $1 AND ($2::uuid IS NULL OR p.cliente_id = $2) ORDER BY h.id`, [codigo, cli]);
    if (!filas.length) return reply.code(404).send(error(404, 'PEDIDO_NO_EXISTE', 'El pedido no existe.'));
    return filas;
  });
}
