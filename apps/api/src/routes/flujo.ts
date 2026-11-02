import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, tx, uno, num } from '../db.js';
import { autenticar, exigir, error } from '../seguridad.js';
import { auditar } from '../auditoria.js';
import { emitirEvento } from './sistema.js';

/**
 * Flujo operativo del PDF (Fig. 2): el cliente registra su pedido → Producción consolida y
 * genera la OP con el requerimiento de insumos → (cierre de OP y venta en operaciones.ts).
 */

const hoyLima = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);

/** Insumos que necesita producir `cantidad` unidades, contra el stock actual. */
async function requerimiento(productoId: string, cantidad: number) {
  const filas = await q<Record<string, string>>(`
    SELECT i.id, i.nombre, i.unidad, i.stock, d.cantidad / r.rendimiento * $2::numeric * (1 + r.merma_estandar) AS necesario
    FROM core.receta r JOIN core.receta_detalle d ON d.receta_id = r.id JOIN core.insumo i ON i.id = d.insumo_id
    WHERE r.producto_id = $1 AND r.estado = 'VIGENTE' ORDER BY d.orden`, [productoId, cantidad]);
  return filas.map((f) => {
    const necesario = Math.round(num(f.necesario) * 1000) / 1000, stock = num(f.stock);
    return { insumoId: f.id, insumo: f.nombre, unidad: f.unidad, necesario, stock, falta: Math.max(0, Math.round((necesario - stock) * 1000) / 1000) };
  });
}

export async function rutasFlujo(app: FastifyInstance) {
  /* --------------------------------------------------------------- pedidos */
  const NuevoPedido = z.object({
    clienteId: z.string().uuid().optional(),
    items: z.array(z.object({ productoId: z.string().uuid(), cantidad: z.number().positive().max(10_000) })).min(1).max(50),
    fechaEntrega: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    horaEntrega: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).or(z.literal('')).default(''),
    observaciones: z.string().trim().max(500).default(''),
  });

  app.post('/pedidos', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'pedidos.crear')) return;
    const p = NuevoPedido.safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues[0]?.message ?? 'Pedido inválido.'));
    const d = p.data;
    if (d.fechaEntrega < hoyLima()) return reply.code(422).send(error(422, 'FECHA_PASADA', 'La fecha de entrega no puede ser anterior a hoy.'));

    // Un cliente solo pide a su nombre (aunque envíe otro clienteId): evita IDOR.
    const yo = await uno<{ cliente_id: string | null }>('SELECT cliente_id FROM core.usuario WHERE id = $1', [req.usuario!.id]);
    const clienteId = yo?.cliente_id ?? d.clienteId;
    if (!clienteId) return reply.code(422).send(error(422, 'SIN_CLIENTE', 'Elige el cliente del pedido.'));

    try {
      const r = await tx(async (c) => {
        const cli = (await c.query<{ nombre: string; estado: string }>('SELECT nombre, estado FROM core.cliente WHERE id = $1', [clienteId])).rows[0];
        if (!cli || cli.estado !== 'ACTIVO') throw Object.assign(new Error('El cliente no existe o está inactivo.'), { status: 422 });
        const ids = [...new Set(d.items.map((i) => i.productoId))];
        const prods = await c.query<{ id: string; nombre: string; precio_con_igv: string }>(
          "SELECT id, nombre, precio_con_igv FROM core.producto WHERE id = ANY($1::uuid[]) AND estado = 'ACTIVO'", [ids]);
        if (prods.rowCount !== ids.length) throw Object.assign(new Error('Hay un producto inexistente o inactivo.'), { status: 422 });
        const mapa = new Map(prods.rows.map((x) => [x.id, x]));
        const total = d.items.reduce((s, i) => s + num(mapa.get(i.productoId)!.precio_con_igv) * i.cantidad, 0);
        const cod = (await c.query<{ n: string }>(`SELECT 'PED-' || to_char(now(),'YYYY') || '-' || lpad(nextval('core.pedido_correlativo_seq')::text, 6, '0') n`)).rows[0].n;
        const ped = (await c.query<{ id: string }>(
          `INSERT INTO core.pedido (codigo, cliente_id, cliente, vendedor, estado, total, fecha_entrega, hora_entrega, observaciones, creado_por)
           VALUES ($1,$2,$3,$4,'REGISTRADO',$5,$6,$7,$8,$9) RETURNING id`,
          [cod, clienteId, cli.nombre, yo?.cliente_id ? 'App cliente' : req.usuario!.nombre, total.toFixed(4), d.fechaEntrega, d.horaEntrega, d.observaciones, req.usuario!.id])).rows[0];
        for (const i of d.items) {
          const pr = mapa.get(i.productoId)!;
          await c.query('INSERT INTO core.pedido_detalle (pedido_id, producto_id, producto, cantidad, precio_con_igv) VALUES ($1,$2,$3,$4,$5)',
            [ped.id, pr.id, pr.nombre, i.cantidad, pr.precio_con_igv]);
        }
        return { id: ped.id, codigo: cod, total: Number(total.toFixed(2)), estado: 'REGISTRADO' };
      });
      await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'PEDIDO_CREADO', entidad: 'pedido', entidadId: r.codigo, detalle: { total: r.total, items: d.items.length }, ip: req.ip });
      void emitirEvento('pedido.estado', { codigo: r.codigo, de: null, a: 'REGISTRADO' });
      return reply.code(201).send(r);
    } catch (e) {
      const err = e as Error & { status?: number };
      if (!err.status) throw e;
      return reply.code(err.status).send(error(err.status, 'PEDIDO_INVALIDO', err.message));
    }
  });

  /** Mis pedidos (cliente) o todos (quien tiene pedidos.ver), con su detalle: historial y "repetir pedido". */
  app.get('/pedidos', { preHandler: autenticar }, async (req, reply) => {
    const yo = await uno<{ cliente_id: string | null }>('SELECT cliente_id FROM core.usuario WHERE id = $1', [req.usuario!.id]);
    if (!yo?.cliente_id && !req.usuario!.permisos.has('pedidos.ver')) return reply.code(403).send(error(403, 'SIN_PERMISO', 'Falta el permiso pedidos.ver.'));
    const filas = await q<Record<string, string>>(`
      SELECT p.id, p.codigo, p.cliente, p.estado, p.total, p.fecha_entrega::text fecha_entrega, p.hora_entrega, p.observaciones, p.creado_en::text creado_en,
             coalesce(json_agg(json_build_object('productoId', d.producto_id, 'producto', d.producto, 'cantidad', d.cantidad, 'precio', d.precio_con_igv))
                      FILTER (WHERE d.id IS NOT NULL), '[]') items
      FROM core.pedido p LEFT JOIN core.pedido_detalle d ON d.pedido_id = p.id
      WHERE ($1::uuid IS NULL OR p.cliente_id = $1)
      GROUP BY p.id ORDER BY p.creado_en DESC LIMIT 200`, [yo?.cliente_id ?? null]);
    return filas.map((f) => ({ ...f, total: num(f.total), items: (f.items as unknown as Array<Record<string, unknown>>).map((i) => ({ ...i, cantidad: num(i.cantidad), precio: num(i.precio) })) }));
  });

  /* ------------------------------------------------------------ producción */
  /** Tablero consolidado: lo que piden los pedidos pendientes, por fecha de entrega y producto. */
  app.get('/produccion/consolidado', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'produccion.ver')) return;
    const filas = await q<Record<string, string>>(`
      SELECT p.fecha_entrega::text fecha, d.producto_id, d.producto, sum(d.cantidad) pedido, count(DISTINCT p.id) pedidos,
             coalesce((SELECT sum(o.cantidad) FROM core.orden_produccion o WHERE o.producto_id = d.producto_id AND o.entrega = p.fecha_entrega AND o.estado <> 'ANULADA'), 0) planificado,
             (SELECT stock FROM core.producto x WHERE x.id = d.producto_id) stock
      FROM core.pedido p JOIN core.pedido_detalle d ON d.pedido_id = p.id
      WHERE p.estado IN ('REGISTRADO','EN_PRODUCCION') AND p.fecha_entrega >= current_date - 1
      GROUP BY p.fecha_entrega, d.producto_id, d.producto ORDER BY p.fecha_entrega, d.producto`);
    return filas.map((f) => {
      const pedido = num(f.pedido), planificado = num(f.planificado);
      return { fecha: f.fecha, productoId: f.producto_id, producto: f.producto, pedido, pedidos: num(f.pedidos), planificado, stock: num(f.stock), porPlanificar: Math.max(0, pedido - planificado) };
    });
  });

  app.get('/produccion/requerimiento', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'produccion.ver')) return;
    const p = z.object({ productoId: z.string().uuid(), cantidad: z.coerce.number().positive().max(100_000) }).safeParse(req.query);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Producto y cantidad requeridos.'));
    const r = await requerimiento(p.data.productoId, p.data.cantidad);
    return { insumos: r, suficiente: r.every((x) => x.falta === 0) };
  });

  const NuevaOP = z.object({
    productoId: z.string().uuid(), cantidad: z.number().positive().max(100_000),
    entrega: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), pedidoId: z.string().uuid().optional(),
  });

  app.post('/ordenes-produccion', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'produccion.planificar')) return;
    const p = NuevaOP.safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues[0]?.message ?? 'Orden inválida.'));
    const d = p.data;
    const rec = await uno<{ id: string; producto: string; merma_estandar: string }>(
      "SELECT r.id, r.producto, r.merma_estandar FROM core.receta r JOIN core.producto x ON x.id = r.producto_id WHERE r.producto_id = $1 AND r.estado = 'VIGENTE' AND x.estado = 'ACTIVO'", [d.productoId]);
    if (!rec) return reply.code(422).send(error(422, 'SIN_RECETA', 'El producto no tiene receta vigente: créala en Recetas.'));
    const req2 = await requerimiento(d.productoId, d.cantidad);
    const op = await tx(async (c) => {
      const cod = (await c.query<{ n: string }>(`SELECT 'OP-' || to_char(now(),'YYYY') || '-' || lpad(nextval('core.op_correlativo_seq')::text, 6, '0') n`)).rows[0].n;
      await c.query(`INSERT INTO core.orden_produccion (codigo, producto_id, producto, receta_id, cantidad, estado, entrega, responsable, merma_esperada, pedido_id)
                     VALUES ($1,$2,$3,$4,$5,'PENDIENTE',$6,$7,$8,$9)`,
        [cod, d.productoId, rec.producto, rec.id, d.cantidad, d.entrega, req.usuario!.nombre, rec.merma_estandar, d.pedidoId ?? null]);
      if (d.pedidoId) await c.query("UPDATE core.pedido SET estado = 'EN_PRODUCCION' WHERE id = $1 AND estado = 'REGISTRADO'", [d.pedidoId]);
      return cod;
    });
    await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'OP_CREADA', entidad: 'orden_produccion', entidadId: op, detalle: d, ip: req.ip });
    // La OP se crea igual aunque falten insumos: Producción decide; la alerta queda en la respuesta.
    return reply.code(201).send({ codigo: op, estado: 'PENDIENTE', insumos: req2, insumosInsuficientes: req2.filter((x) => x.falta > 0) });
  });
}
