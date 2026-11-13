import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, tx, num } from '../db.js';
import { autenticar, exigir, error } from '../seguridad.js';
import { auditar } from '../auditoria.js';
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
  const cambios = await tx(async (c) => (await c.query<{ codigo: string; cliente_id: string; cliente: string; estado: string; total: string; motivo: string | null; es_oferta: boolean }>(`
    UPDATE core.pedido_historial h SET notificado_en = now() FROM core.pedido p
    WHERE h.id IN (SELECT id FROM core.pedido_historial WHERE notificado_en IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED) AND p.id = h.pedido_id
    RETURNING p.codigo, p.cliente_id, p.cliente, h.estado, p.total, p.motivo, p.es_oferta`)).rows);
  for (const ch of cambios) {
    const regla = AVISO_PEDIDO[ch.estado];
    if (!regla) continue;
    const motivo = ['RECHAZADO', 'CANCELADO'].includes(ch.estado) && ch.motivo ? ` (${ch.motivo})` : '';
    await notificar([{ clienteId: ch.cliente_id }], { tipo: 'pedido', titulo: `Pedido ${ch.codigo}`, cuerpo: `Hola, ${regla.texto}${motivo}.`, ruta: `/pedidos/${ch.codigo}` });
    if (regla.area) {
      await notificar([{ permiso: regla.area }], {
        tipo: 'pedido', titulo: `${ch.codigo} · ${ch.cliente}`,
        // Oferta tomada: el vendedor la confirma y sale del stock, sin producción.
        cuerpo: ch.es_oferta && ch.estado === 'REGISTRADO' ? `Tomó una oferta · S/ ${num(ch.total).toFixed(2)} · confírmala: sale del stock, sin producción`
          : `${regla.textoArea![0].toUpperCase()}${regla.textoArea!.slice(1)} · S/ ${num(ch.total).toFixed(2)}${motivo}`, ruta: '/ventas/pedidos',
      });
    }
    void emitirEvento('pedido.aviso', { codigo: ch.codigo, estado: ch.estado });
  }
  return cambios.length;
}

const NuevoAviso = z.object({
  titulo: z.string().trim().min(3, 'Escribe un título.').max(80),
  cuerpo: z.string().trim().min(5, 'Escribe el mensaje.').max(300),
  todos: z.boolean(),
  clienteIds: z.array(z.string().uuid()).max(2000).default([]),
}).refine((d) => d.todos || d.clienteIds.length > 0, { message: 'Elige al menos un cliente.', path: ['clienteIds'] });

export async function rutasNotificaciones(app: FastifyInstance) {
  // Promociones y comunicados: clientes activos con cuántas cuentas de la app tienen, y lo ya enviado.
  app.get('/avisos-clientes', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'clientes.avisar')) return;
    const clientes = await q<Record<string, string>>(`SELECT c.id, c.nombre,
        (SELECT count(*) FROM core.usuario u WHERE u.cliente_id = c.id AND u.estado = 'ACTIVO') cuentas
      FROM core.cliente c WHERE c.estado = 'ACTIVO' ORDER BY c.nombre`);
    const historial = await q<Record<string, string>>(`SELECT a.id, a.titulo, a.cuerpo, a.todos, a.clientes, a.usuarios, u.nombre enviado_por, a.creado_en::text fecha
      FROM core.aviso_cliente a JOIN core.usuario u ON u.id = a.enviado_por ORDER BY a.creado_en DESC LIMIT 50`);
    return {
      clientes: clientes.map((c) => ({ id: c.id, nombre: c.nombre, cuentas: num(c.cuentas) })),
      historial: historial.map((a) => ({ id: a.id, titulo: a.titulo, cuerpo: a.cuerpo, todos: Boolean(a.todos), clientes: num(a.clientes), usuarios: num(a.usuarios), enviadoPor: a.enviado_por, fecha: a.fecha })),
    };
  });

  // Límite por minuto: un doble envío o una cuenta comprometida no inunda a los clientes.
  app.post('/avisos-clientes', { preHandler: autenticar, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!exigir(req, reply, 'clientes.avisar')) return;
    const p = NuevoAviso.safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues[0]?.message ?? 'Aviso inválido.'));
    const d = p.data;
    // Solo cuentas activas de clientes activos; los ids que no corresponden simplemente no reciben nada.
    const cuentas = await q<{ id: string; cliente_id: string }>(`SELECT u.id, u.cliente_id FROM core.usuario u JOIN core.cliente c ON c.id = u.cliente_id
      WHERE u.estado = 'ACTIVO' AND c.estado = 'ACTIVO' AND ($1 OR c.id = ANY($2::uuid[]))`, [d.todos, d.clienteIds]);
    if (!cuentas.length) return reply.code(422).send(error(422, 'SIN_DESTINATARIOS', 'Ningún cliente elegido tiene cuenta en la app.'));
    const clientes = new Set(cuentas.map((c) => c.cliente_id)).size;
    const fila = await q<{ id: string }>(`INSERT INTO core.aviso_cliente (titulo, cuerpo, todos, clientes, usuarios, enviado_por) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [d.titulo, d.cuerpo, d.todos, clientes, cuentas.length, req.usuario!.id]);
    await notificar(cuentas.map((c) => ({ usuarioId: c.id })), { tipo: 'promocion', titulo: d.titulo, cuerpo: d.cuerpo, ruta: '/catalogo' });
    await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'AVISO_CLIENTES', entidad: 'aviso_cliente', entidadId: fila[0].id,
      detalle: { titulo: d.titulo, todos: d.todos, clientes, usuarios: cuentas.length }, ip: req.ip });
    return reply.code(201).send({ id: fila[0].id, clientes, usuarios: cuentas.length });
  });

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
