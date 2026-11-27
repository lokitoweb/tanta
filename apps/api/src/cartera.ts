import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { uno } from './db.js';
import { error, type UsuarioActual } from './seguridad.js';

/**
 * Cartera por vendedor: quien no tiene «pedidos.ver_todos» (el rol Vendedor) ve solo lo suyo.
 * - Clientes: los asignados a él (ficha → Vendedor asignado) y los que no tienen vendedor (cartera libre).
 * - Pedidos: los que él registró, los de sus clientes y, de los clientes sin vendedor, los que el cliente hizo en la app.
 * Las cuentas de cliente tienen su propio filtro (solo lo suyo) en cada ruta.
 */

/** Id del vendedor cuya cartera se filtra, o null si ve todo. */
export const vendedorDe = (u: UsuarioActual) => (u.permisos.has('pedidos.ver_todos') ? null : u.id);

/** Condición SQL: `c` = alias de core.cliente, `v` = parámetro con vendedorDe(). */
export const clienteVisible = (c: string, v: string) =>
  `(${v}::uuid IS NULL OR ${c}.vendedor_id IS NULL OR ${c}.vendedor_id = ${v}::uuid)`;

/** Condición SQL: `p` = alias de core.pedido, `c` = su core.cliente, `v` = parámetro con vendedorDe(). */
export const pedidoVisible = (p: string, c: string, v: string) =>
  `(${v}::uuid IS NULL OR ${p}.creado_por = ${v}::uuid OR ${c}.vendedor_id = ${v}::uuid
    OR (${c}.vendedor_id IS NULL AND EXISTS (SELECT 1 FROM core.usuario x WHERE x.id = ${p}.creado_por AND x.cliente_id IS NOT NULL)))`;

const esCuentaCliente = async (id: string) => Boolean((await uno<{ cliente_id: string | null }>('SELECT cliente_id FROM core.usuario WHERE id = $1', [id]))?.cliente_id);

/** ¿El pedido o el cliente es de su cartera? Para personal sin «pedidos.ver_todos». */
export async function enCartera(u: UsuarioActual, tipo: 'pedido' | 'cliente', clave: string): Promise<boolean> {
  const v = vendedorDe(u);
  if (!v || await esCuentaCliente(u.id)) return true;
  if (tipo === 'cliente') {
    if (!/^[0-9a-f-]{36}$/i.test(clave)) return true; // la ruta valida el id y responde
    return Boolean(await uno(`SELECT 1 FROM core.cliente c WHERE c.id = $1 AND ${clienteVisible('c', '$2')}`, [clave, v]));
  }
  // Un pedido que no existe lo responde la ruta (404 propio).
  const r = await uno<{ ok: boolean }>(`SELECT ${pedidoVisible('p', 'c', '$2')} ok FROM core.pedido p JOIN core.cliente c ON c.id = p.cliente_id WHERE p.codigo = $1`, [clave, v]);
  return !r || r.ok;
}

/**
 * Toda ruta de un pedido (/pedidos/:codigo…) o cliente (/clientes/:id…) concreto pasa por aquí después de autenticar:
 * fuera de su cartera responde como si no existiera (404). Así ninguna ruta nueva se olvida del filtro.
 */
export function protegerCartera(app: FastifyInstance) {
  app.addHook('onRoute', (r) => {
    const tipo = /\/pedidos\/:codigo(\/|$)/.test(r.url) ? 'pedido' : /\/clientes\/:id(\/|$)/.test(r.url) ? 'cliente' : null;
    if (!tipo) return;
    const guardia = async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.usuario) return;
      const { codigo, id } = req.params as { codigo?: string; id?: string };
      if (!(await enCartera(req.usuario, tipo, (tipo === 'pedido' ? codigo : id) ?? ''))) {
        return reply.code(404).send(error(404, 'NO_ENCONTRADO', tipo === 'pedido' ? 'El pedido no existe o no es de tu cartera.' : 'El cliente no existe o no es de tu cartera.'));
      }
    };
    const previos = r.preHandler ? (Array.isArray(r.preHandler) ? r.preHandler : [r.preHandler]) : [];
    r.preHandler = [...previos, guardia as preHandlerHookHandler];
  });
}
