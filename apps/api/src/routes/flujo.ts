import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, tx, uno, num } from '../db.js';
import { autenticar, exigir, error } from '../seguridad.js';
import { auditar } from '../auditoria.js';
import { emitirEvento } from './sistema.js';
import { avisar } from './notificaciones.js';
import { medioPago } from './catalogos.js';

/**
 * Flujo operativo del PDF (Fig. 2): el cliente registra su pedido → Producción consolida y
 * genera la OP con el requerimiento de insumos → (cierre de OP y venta en operaciones.ts).
 */

const hoyLima = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);

export type Criterio = 'PROPORCIONAL' | 'LOTES_COMPLETOS';

/**
 * Lotes de una orden (RN-18/19): equivalentes = cantidad ÷ unidades esperadas por lote;
 * con "lotes completos" se redondea hacia arriba. Devuelve unidades que se obtendrían y masa.
 */
export async function calcularOrden(productoId: string, cantidad: number, criterio: Criterio) {
  const r = await uno<Record<string, string>>(
    `SELECT r.id, r.producto, r.merma_estandar, r.unidades_esperadas, r.masa_lote_kg, r.costo_lote
     FROM core.receta r WHERE r.producto_id = $1 AND r.estado = 'VIGENTE'`, [productoId]);
  if (!r || !(num(r.unidades_esperadas) > 0)) return null;
  const porLote = num(r.unidades_esperadas);
  const equivalentes = cantidad / porLote;
  const lotes = criterio === 'LOTES_COMPLETOS' ? Math.ceil(equivalentes - 1e-9) : equivalentes;
  const lineas = await q<Record<string, string>>(`
    SELECT i.id, i.nombre, i.unidad_inventario unidad, i.stock, i.cpp, d.cantidad * core.factor_inventario(i.id) cantidad
    FROM core.receta_detalle d JOIN core.insumo i ON i.id = d.insumo_id WHERE d.receta_id = $1 ORDER BY d.orden`, [r.id]);
  // RN-20: consumo = cantidad de receta × lotes · RN-21: saldo = stock − consumo; negativo = FALTA.
  const insumos = lineas.map((l) => {
    const necesario = num(l.cantidad) * lotes, stock = num(l.stock), saldo = stock - necesario;
    return {
      insumoId: l.id, insumo: l.nombre, unidad: l.unidad, necesario: Math.round(necesario * 10000) / 10000,
      costo: Math.round(necesario * num(l.cpp) * 100) / 100, stock, saldo: Math.round(saldo * 10000) / 10000,
      falta: Math.max(0, Math.round(-saldo * 10000) / 10000), estado: saldo < -1e-9 ? 'FALTA' : 'OK',
    };
  });
  return {
    recetaId: r.id, producto: r.producto, mermaEstandar: num(r.merma_estandar), criterio,
    unidadesPorLote: Math.round(porLote * 100) / 100, lotesEquivalentes: Math.round(equivalentes * 1000) / 1000,
    lotes: Math.round(lotes * 1000) / 1000, unidadesObtenidas: Math.round(lotes * porLote * 10) / 10,
    masaKg: Math.round(lotes * num(r.masa_lote_kg) * 1000) / 1000,
    costoInsumos: Math.round(insumos.reduce((s, i) => s + i.costo, 0) * 100) / 100, insumos,
  };
}

/** Insumos que necesita producir `cantidad` unidades, contra el stock actual. */
async function requerimiento(productoId: string, cantidad: number, criterio: Criterio = 'PROPORCIONAL') {
  return (await calcularOrden(productoId, cantidad, criterio))?.insumos ?? [];
}

export async function rutasFlujo(app: FastifyInstance) {
  /* --------------------------------------------------------------- pedidos */
  const NuevoPedido = z.object({
    clienteId: z.string().uuid().optional(),
    items: z.array(z.object({ productoId: z.string().uuid(), cantidad: z.number().positive().max(10_000) })).min(1).max(50),
    fechaEntrega: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    horaEntrega: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).or(z.literal('')).default(''),
    observaciones: z.string().trim().max(500).default(''),
    // PED-03: recojo en tienda o delivery (con dirección).
    tipoEntrega: z.enum(['RECOJO', 'DELIVERY']).default('RECOJO'),
    direccion: z.string().trim().max(200).default(''),
    // Sin pasarela: el cliente paga al recibir; indica cómo para que el vendedor lleve vuelto o POS.
    pagoEntrega: z.string().trim().toUpperCase().max(20).default('EFECTIVO'),
  }).refine((d) => d.tipoEntrega !== 'DELIVERY' || d.direccion.length >= 5, { message: 'Indica la dirección de entrega.', path: ['direccion'] });

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
        const pago = await medioPago(c, d.pagoEntrega, 'ventas');
        const cli = (await c.query<{ nombre: string; estado: string; limite_credito: string; deuda: string; condicion_pago: string }>(
          `SELECT c.nombre, c.estado, c.limite_credito, c.condicion_pago,
                  coalesce((SELECT sum(x.saldo) FROM core.cuenta_por_cobrar x WHERE x.cliente_id = c.id AND x.estado IN ('PENDIENTE','PARCIAL')), 0) deuda
           FROM core.cliente c WHERE c.id = $1 FOR UPDATE`, [clienteId])).rows[0];
        if (!cli || cli.estado !== 'ACTIVO') throw Object.assign(new Error('El cliente no existe o está inactivo.'), { status: 422 });
        const ids = [...new Set(d.items.map((i) => i.productoId))];
        const prods = await c.query<{ id: string; nombre: string; precio_con_igv: string; anticipacion_horas: number }>(
          "SELECT id, nombre, precio_con_igv, anticipacion_horas FROM core.producto WHERE id = ANY($1::uuid[]) AND estado = 'ACTIVO' AND insumo_id IS NULL", [ids]);
        if (prods.rowCount !== ids.length) throw Object.assign(new Error('Hay un producto inexistente o inactivo.'), { status: 422 });
        const mapa = new Map(prods.rows.map((x) => [x.id, x]));
        const total = d.items.reduce((s, i) => s + num(mapa.get(i.productoId)!.precio_con_igv) * i.cantidad, 0);
        // PED-04 / CP-09: anticipación mínima del producto más exigente (hora de Lima, UTC−5).
        const horas = Math.max(0, ...prods.rows.map((x) => Number(x.anticipacion_horas)));
        const entrega = Date.parse(`${d.fechaEntrega}T${d.horaEntrega || '08:00'}:00-05:00`);
        if (horas > 0 && entrega < Date.now() + horas * 3_600_000) {
          const lento = prods.rows.find((x) => Number(x.anticipacion_horas) === horas)!.nombre;
          throw Object.assign(new Error(`${lento} se pide con ${horas} h de anticipación: elige una entrega posterior.`), { status: 422 });
        }
        if (pago.es_credito && cli.condicion_pago !== 'CREDITO') throw Object.assign(new Error('Tu cuenta compra al contado: elige cómo pagarás al recibir.'), { status: 422 });
        // PED-04 / RN-35: con línea de crédito, el pedido no puede superar el saldo disponible.
        // Solo si paga al crédito: un pedido contra entrega no consume línea.
        if (pago.es_credito && num(cli.limite_credito) <= 0) throw Object.assign(new Error('Tu cuenta no tiene línea de crédito definida: elige cómo pagarás al recibir.'), { status: 409 });
        if (pago.es_credito && num(cli.deuda) + total > num(cli.limite_credito) + 0.001) {
          throw Object.assign(new Error(`Supera la línea de crédito: debe S/ ${num(cli.deuda).toFixed(2)} de S/ ${num(cli.limite_credito).toFixed(2)}.`), { status: 409 });
        }
        // PED-09: el pedido que registra el vendedor ya queda confirmado; el del cliente espera confirmación (PED-08).
        const estadoInicial = yo?.cliente_id ? 'REGISTRADO' : 'CONFIRMADO';
        const cod = (await c.query<{ n: string }>(`SELECT 'PED-' || to_char(now(),'YYYY') || '-' || lpad(nextval('core.pedido_correlativo_seq')::text, 6, '0') n`)).rows[0].n;
        const ped = (await c.query<{ id: string }>(
          `INSERT INTO core.pedido (codigo, cliente_id, cliente, vendedor, estado, total, fecha_entrega, hora_entrega, observaciones, creado_por, tipo_entrega, direccion, confirmado_en, pago_entrega)
           VALUES ($1,$2,$3,$4,$10,$5,$6,$7,$8,$9,$11,$12, CASE WHEN $10 = 'CONFIRMADO' THEN now() END, $13) RETURNING id`,
          [cod, clienteId, cli.nombre, yo?.cliente_id ? 'App cliente' : req.usuario!.nombre, total.toFixed(4), d.fechaEntrega, d.horaEntrega, d.observaciones, req.usuario!.id,
            estadoInicial, d.tipoEntrega, d.direccion, d.pagoEntrega])).rows[0];
        for (const i of d.items) {
          const pr = mapa.get(i.productoId)!;
          await c.query('INSERT INTO core.pedido_detalle (pedido_id, producto_id, producto, cantidad, precio_con_igv) VALUES ($1,$2,$3,$4,$5)',
            [ped.id, pr.id, pr.nombre, i.cantidad, pr.precio_con_igv]);
        }
        return { id: ped.id, codigo: cod, total: Number(total.toFixed(2)), estado: estadoInicial };
      });
      await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'PEDIDO_CREADO', entidad: 'pedido', entidadId: r.codigo, detalle: { total: r.total, items: d.items.length }, ip: req.ip });
      void emitirEvento('pedido.estado', { codigo: r.codigo, de: null, a: r.estado });
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
      SELECT p.id, p.codigo, p.cliente_id AS "clienteId", p.cliente, p.estado, p.vendedor,
             (SELECT v.codigo FROM core.venta v WHERE v.pedido_id = p.id AND v.estado = 'CONFIRMADA' LIMIT 1) AS venta, p.total, p.fecha_entrega::text fecha_entrega, p.hora_entrega, p.observaciones, p.creado_en::text creado_en,
             p.tipo_entrega AS "tipoEntrega", p.direccion, p.pago_entrega AS "pagoEntrega", p.motivo, p.entregado_en::text AS "entregadoEn", p.entrega_obs AS "entregaObs",
             coalesce(json_agg(json_build_object('productoId', d.producto_id, 'producto', d.producto, 'cantidad', d.cantidad, 'precio', d.precio_con_igv, 'despachado', d.cantidad_despachada))
                      FILTER (WHERE d.id IS NOT NULL), '[]') items
      FROM core.pedido p LEFT JOIN core.pedido_detalle d ON d.pedido_id = p.id
      WHERE ($1::uuid IS NULL OR p.cliente_id = $1)
      GROUP BY p.id ORDER BY p.creado_en DESC LIMIT 200`, [yo?.cliente_id ?? null]);
    return filas.map((f) => ({ ...f, total: num(f.total), items: (f.items as unknown as Array<Record<string, unknown>>).map((i) => ({ ...i, cantidad: num(i.cantidad), precio: num(i.precio), despachado: num(i.despachado as string) })) }));
  });

  // PED-07: el cliente cancela su pedido, con motivo, solo antes de que pase a producción.
  app.post('/pedidos/:codigo/cancelar', { preHandler: autenticar }, async (req, reply) => {
    const { codigo } = req.params as { codigo: string };
    const p = z.object({ motivo: z.string().trim().min(3).max(200) }).safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Indica el motivo de la cancelación.'));
    const yo = await uno<{ cliente_id: string | null }>('SELECT cliente_id FROM core.usuario WHERE id = $1', [req.usuario!.id]);
    const ped = await uno<{ id: string; estado: string; cliente_id: string }>('SELECT id, estado, cliente_id FROM core.pedido WHERE codigo = $1', [codigo]);
    // Un cliente solo ve y cancela lo suyo: a uno ajeno se le responde como si no existiera.
    if (!ped || (yo?.cliente_id && ped.cliente_id !== yo.cliente_id) || (!yo?.cliente_id && !req.usuario!.permisos.has('pedidos.gestionar'))) {
      return reply.code(404).send(error(404, 'PEDIDO_NO_EXISTE', 'El pedido no existe.'));
    }
    if (!['REGISTRADO', 'CONFIRMADO'].includes(ped.estado)) {
      return reply.code(409).send(error(409, 'PEDIDO_EN_CURSO', 'El pedido ya pasó a producción: solo el vendedor puede anularlo.'));
    }
    const r = await q("UPDATE core.pedido SET estado = 'CANCELADO', motivo = $2 WHERE id = $1 AND estado = $3 RETURNING id", [ped.id, p.data.motivo, ped.estado]);
    if (!r.length) return reply.code(409).send(error(409, 'PEDIDO_CAMBIADO', 'El pedido cambió: recarga e intenta de nuevo.'));
    await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'PEDIDO_CANCELADO', entidad: 'pedido', entidadId: codigo, detalle: p.data, ip: req.ip });
    void emitirEvento('pedido.estado', { codigo, de: ped.estado, a: 'CANCELADO' });
    return { codigo, estado: 'CANCELADO' };
  });

  /* ------------------------------------------------- direcciones (cliente) */
  const clienteDe = async (usuarioId: string) => (await uno<{ cliente_id: string | null }>('SELECT cliente_id FROM core.usuario WHERE id = $1', [usuarioId]))?.cliente_id ?? null;

  app.get('/mis-direcciones', { preHandler: autenticar }, async (req, reply) => {
    const cli = await clienteDe(req.usuario!.id);
    if (!cli) return reply.code(403).send(error(403, 'SOLO_CLIENTES', 'Solo para cuentas de cliente.'));
    return q('SELECT id, direccion, referencia FROM core.direccion_cliente WHERE cliente_id = $1 ORDER BY creado_en', [cli]);
  });

  app.post('/mis-direcciones', { preHandler: autenticar }, async (req, reply) => {
    const cli = await clienteDe(req.usuario!.id);
    if (!cli) return reply.code(403).send(error(403, 'SOLO_CLIENTES', 'Solo para cuentas de cliente.'));
    const p = z.object({ direccion: z.string().trim().min(5).max(200), referencia: z.string().trim().max(120).default('') }).safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Escribe la dirección completa.'));
    if (Number((await uno<{ n: string }>('SELECT count(*) n FROM core.direccion_cliente WHERE cliente_id = $1', [cli]))?.n) >= 10) {
      return reply.code(409).send(error(409, 'LIMITE', 'Puedes guardar hasta 10 direcciones.'));
    }
    const r = await uno('INSERT INTO core.direccion_cliente (cliente_id, direccion, referencia) VALUES ($1,$2,$3) RETURNING id, direccion, referencia', [cli, p.data.direccion, p.data.referencia]);
    return reply.code(201).send(r);
  });

  app.delete('/mis-direcciones/:id', { preHandler: autenticar }, async (req, reply) => {
    const cli = await clienteDe(req.usuario!.id);
    const { id } = req.params as { id: string };
    if (!cli || !z.string().uuid().safeParse(id).success) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'Dirección no encontrada.'));
    const r = await q('DELETE FROM core.direccion_cliente WHERE id = $1 AND cliente_id = $2 RETURNING id', [id, cli]);
    if (!r.length) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'Dirección no encontrada.'));
    return { ok: true };
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
      WHERE p.estado IN ('CONFIRMADO','EN_PRODUCCION') AND p.fecha_entrega >= current_date - 1
      GROUP BY p.fecha_entrega, d.producto_id, d.producto ORDER BY p.fecha_entrega, d.producto`);
    return filas.map((f) => {
      const pedido = num(f.pedido), planificado = num(f.planificado);
      return { fecha: f.fecha, productoId: f.producto_id, producto: f.producto, pedido, pedidos: num(f.pedidos), planificado, stock: num(f.stock), porPlanificar: Math.max(0, pedido - planificado) };
    });
  });

  app.get('/produccion/requerimiento', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'produccion.ver')) return;
    const p = z.object({ productoId: z.string().uuid(), cantidad: z.coerce.number().positive().max(100_000),
      criterio: z.enum(['PROPORCIONAL', 'LOTES_COMPLETOS']).default('PROPORCIONAL') }).safeParse(req.query);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Producto y cantidad requeridos.'));
    const c = await calcularOrden(p.data.productoId, p.data.cantidad, p.data.criterio);
    if (!c) return reply.code(422).send(error(422, 'SIN_RECETA', 'El producto no tiene receta vigente.'));
    return { ...c, suficiente: c.insumos.every((x) => x.falta === 0) };
  });

  // PRO-10 / RN-22 / RN-23: presupuesto de N panes. Los panes a preparar se redondean
  // hacia ARRIBA (corrige H-08: con ROUNDDOWN no se llega a lo pedido).
  app.get('/produccion/presupuesto', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'produccion.ver')) return;
    const p = z.object({ productoId: z.string().uuid(), cantidad: z.coerce.number().int().positive().max(1_000_000),
      merma: z.coerce.number().min(0).max(0.9).optional() }).safeParse(req.query);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Producto y cantidad requeridos.'));
    const r = await uno<Record<string, string>>(`SELECT r.id, r.merma_estandar, r.masa_lote_kg, r.unidades_teoricas, p.peso_masa_g, p.precio_con_igv, p.costo_unitario,
        (SELECT valor::numeric FROM core.parametro WHERE clave = 'igv') igv,
        (SELECT sum(d.peso_kg) FROM core.receta_detalle d JOIN core.insumo i ON i.id = d.insumo_id WHERE d.receta_id = r.id AND i.tipo = 'HARINA') harina
      FROM core.receta r JOIN core.producto p ON p.id = r.producto_id WHERE r.producto_id = $1 AND r.estado = 'VIGENTE'`, [p.data.productoId]);
    if (!r || !(num(r.unidades_teoricas) > 0)) return reply.code(422).send(error(422, 'SIN_RECETA', 'El producto no tiene receta vigente.'));
    const merma = p.data.merma ?? num(r.merma_estandar);
    const panes = Math.ceil(p.data.cantidad / (1 - merma) - 1e-9);
    const lotes = panes / num(r.unidades_teoricas);
    const masa = lotes * num(r.masa_lote_kg);
    const lineas = await q<Record<string, string>>(`SELECT i.id, i.nombre, i.unidad_inventario unidad, i.cpp, i.stock, d.cantidad * core.factor_inventario(i.id) cantidad, d.pct_panadero
      FROM core.receta_detalle d JOIN core.insumo i ON i.id = d.insumo_id WHERE d.receta_id = $1 ORDER BY d.orden`, [r.id]);
    const insumos = lineas.map((l) => {
      const consumo = num(l.cantidad) * lotes;
      return { insumoId: l.id, insumo: l.nombre, unidad: l.unidad, pctPanadero: l.pct_panadero === null ? null : num(l.pct_panadero),
        consumo: Math.round(consumo * 1000) / 1000, costo: Math.round(consumo * num(l.cpp) * 100) / 100, stock: num(l.stock), falta: consumo > num(l.stock) };
    });
    const costoInsumos = insumos.reduce((s, i) => s + i.costo, 0);
    const neto = num(r.precio_con_igv) / (1 + num(r.igv || '0.18'));
    return {
      cantidad: p.data.cantidad, merma, panesAPreparar: panes, lotes: Math.round(lotes * 1000) / 1000,
      masaKg: Math.round(masa * 1000) / 1000, harinaKg: Math.round(lotes * num(r.harina ?? '0') * 1000) / 1000,
      costoInsumos: Math.round(costoInsumos * 100) / 100,
      costoEstimado: Math.round(p.data.cantidad * num(r.costo_unitario) * 100) / 100,
      ventaNeta: Math.round(p.data.cantidad * neto * 100) / 100,
      margenEstimado: neto > 0 ? (neto - num(r.costo_unitario)) / neto : 0,
      insumos,
    };
  });

  const NuevaOP = z.object({
    productoId: z.string().uuid(), cantidad: z.number().positive().max(100_000),
    entrega: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), pedidoId: z.string().uuid().optional(),
    criterio: z.enum(['PROPORCIONAL', 'LOTES_COMPLETOS']).default('PROPORCIONAL'),
  });

  app.post('/ordenes-produccion', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'produccion.planificar')) return;
    const p = NuevaOP.safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues[0]?.message ?? 'Orden inválida.'));
    const d = p.data;
    const rec = await uno<{ id: string; producto: string; merma_estandar: string }>(
      "SELECT r.id, r.producto, r.merma_estandar FROM core.receta r JOIN core.producto x ON x.id = r.producto_id WHERE r.producto_id = $1 AND r.estado = 'VIGENTE' AND x.estado = 'ACTIVO'", [d.productoId]);
    if (!rec) return reply.code(422).send(error(422, 'SIN_RECETA', 'El producto no tiene receta vigente: créala en Recetas.'));
    const calc = await calcularOrden(d.productoId, d.cantidad, d.criterio);
    if (!calc) return reply.code(422).send(error(422, 'SIN_RECETA', 'La receta no tiene unidades por lote: revisa la receta.'));
    const req2 = calc.insumos;
    const op = await tx(async (c) => {
      const cod = (await c.query<{ n: string }>(`SELECT 'OP-' || to_char(now(),'YYYY') || '-' || lpad(nextval('core.op_correlativo_seq')::text, 6, '0') n`)).rows[0].n;
      const opId = (await c.query<{ id: string }>(`INSERT INTO core.orden_produccion (codigo, producto_id, producto, receta_id, cantidad, estado, entrega, responsable, merma_esperada, pedido_id,
                        criterio, lotes, unidades_esperadas, masa_kg)
                     VALUES ($1,$2,$3,$4,$5,'PENDIENTE',$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [cod, d.productoId, rec.producto, rec.id, d.cantidad, d.entrega, req.usuario!.nombre, rec.merma_estandar, d.pedidoId ?? null,
          d.criterio, calc.lotes, calc.unidadesObtenidas, calc.masaKg])).rows[0].id;
      // PRO-05: la OP genera su requisición; Almacén descuenta el stock al entregar (RN-27).
      const reqId = (await c.query<{ id: string }>(`INSERT INTO core.requisicion (codigo, op_id)
        VALUES ('REQ-' || to_char(now(),'YYYY') || '-' || lpad(nextval('core.requisicion_correlativo_seq')::text, 6, '0'), $1) RETURNING id`, [opId])).rows[0].id;
      for (const i of calc.insumos) {
        await c.query('INSERT INTO core.requisicion_detalle (requisicion_id, insumo_id, insumo, unidad, cant_solicitada) VALUES ($1,$2,$3,$4,$5)',
          [reqId, i.insumoId, i.insumo, i.unidad, i.necesario]);
      }
      // PED-08: solo un pedido confirmado pasa a producción.
      if (d.pedidoId) await c.query("UPDATE core.pedido SET estado = 'EN_PRODUCCION' WHERE id = $1 AND estado = 'CONFIRMADO'", [d.pedidoId]);
      return cod;
    });
    avisar([{ permiso: 'requisiciones.atender' }], { tipo: 'requisicion', titulo: `Requisición de ${op}`, cuerpo: `Producción pide insumos para ${d.cantidad} unidades${req2.some((x) => x.falta > 0) ? ' · hay insumos que faltan' : ''}`, ruta: '/almacen/requisiciones' });
    await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'OP_CREADA', entidad: 'orden_produccion', entidadId: op, detalle: d, ip: req.ip });
    // La OP se crea igual aunque falten insumos: Producción decide; la alerta queda en la respuesta.
    return reply.code(201).send({ codigo: op, estado: 'PENDIENTE', calculo: { lotes: calc.lotes, unidadesObtenidas: calc.unidadesObtenidas, masaKg: calc.masaKg, costoInsumos: calc.costoInsumos },
      insumos: req2, insumosInsuficientes: req2.filter((x) => x.falta > 0) });
  });

  /* --------------------------------------------------------- requisiciones */
  // A18/A19: Almacén ve lo pendiente y entrega; cada entrega es una salida del kárdex con la OP como documento.
  app.get('/requisiciones', { preHandler: autenticar }, async (req, reply) => {
    const u = req.usuario!;
    if (!u.permisos.has('requisiciones.atender') && !u.permisos.has('produccion.ver')) return reply.code(403).send(error(403, 'SIN_PERMISO', 'No tienes permiso.'));
    const p = z.object({ estado: z.enum(['PENDIENTES', 'TODAS']).default('PENDIENTES') }).safeParse(req.query);
    const filas = await q<Record<string, unknown>>(`
      SELECT q.codigo, q.estado, q.creado_en::text, o.codigo op, o.producto, o.cantidad, o.lotes, o.entrega::text,
             coalesce(json_agg(json_build_object('insumoId', d.insumo_id, 'insumo', d.insumo, 'unidad', d.unidad,
               'solicitada', d.cant_solicitada, 'entregada', d.cant_entregada, 'stock', i.stock) ORDER BY d.insumo), '[]') lineas
      FROM core.requisicion q JOIN core.orden_produccion o ON o.id = q.op_id
      JOIN core.requisicion_detalle d ON d.requisicion_id = q.id JOIN core.insumo i ON i.id = d.insumo_id
      WHERE ($1 = 'TODAS' OR q.estado IN ('PENDIENTE','PARCIAL'))
      GROUP BY q.id, o.id ORDER BY q.creado_en DESC LIMIT 200`, [p.success ? p.data.estado : 'PENDIENTES']);
    return filas.map((f) => ({ ...f, cantidad: num(f.cantidad as string), lotes: f.lotes === null ? null : num(f.lotes as string),
      lineas: (f.lineas as Array<Record<string, string>>).map((l) => ({ ...l, solicitada: num(l.solicitada), entregada: num(l.entregada), stock: num(l.stock) })) }));
  });

  const Entrega = z.object({ lineas: z.array(z.object({ insumoId: z.string().uuid(), cantidad: z.number().min(0).max(1_000_000) })).min(1).max(60) });

  app.post('/requisiciones/:codigo/atender', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'requisiciones.atender')) return;
    const { codigo } = req.params as { codigo: string };
    const p = Entrega.safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Revisa las cantidades entregadas.'));
    try {
      const r = await tx(async (c) => {
        const qq = (await c.query<{ id: string; estado: string; op: string; op_estado: string }>(`SELECT q.id, q.estado, o.codigo op, o.estado op_estado
          FROM core.requisicion q JOIN core.orden_produccion o ON o.id = q.op_id WHERE q.codigo = $1 FOR UPDATE OF q`, [codigo])).rows[0];
        if (!qq) throw Object.assign(new Error('La requisición no existe.'), { status: 404 });
        if (!['PENDIENTE', 'PARCIAL'].includes(qq.estado) || ['TERMINADA', 'ANULADA'].includes(qq.op_estado)) {
          throw Object.assign(new Error(`La requisición está ${qq.estado.toLowerCase()} y su OP ${qq.op_estado.toLowerCase()}.`), { status: 409 });
        }
        // Mismo orden de bloqueo que las compras (por id): sin deadlocks.
        for (const l of [...p.data.lineas].sort((a, b) => a.insumoId.localeCompare(b.insumoId))) {
          if (l.cantidad <= 0) continue;
          const det = (await c.query<{ cant_solicitada: string; cant_entregada: string }>(
            'SELECT cant_solicitada, cant_entregada FROM core.requisicion_detalle WHERE requisicion_id = $1 AND insumo_id = $2', [qq.id, l.insumoId])).rows[0];
          if (!det) throw Object.assign(new Error('Un insumo no pertenece a la requisición.'), { status: 422 });
          const ins = (await c.query<{ nombre: string; stock: string; cpp: string }>('SELECT nombre, stock, cpp FROM core.insumo WHERE id = $1 FOR UPDATE', [l.insumoId])).rows[0];
          const saldo = num(ins.stock) - l.cantidad;
          if (saldo < -1e-6) throw Object.assign(new Error(`Stock insuficiente de ${ins.nombre}: hay ${num(ins.stock).toFixed(3)}, se quiere entregar ${l.cantidad}.`), { status: 409 });
          const cpp = num(ins.cpp);
          await c.query(`INSERT INTO core.movimiento_inventario
              (tipo,item_tipo,insumo_id,documento,cantidad,costo_unitario,valor,saldo_cantidad,saldo_valor,cpp,motivo_tipo,registrado_por)
            VALUES ('CONSUMO_OP','INSUMO',$1,$2,$3,$4,$5,$6,$7,$4,'CONSUMO',$8)`,
            [l.insumoId, qq.op, (-l.cantidad).toFixed(6), cpp.toFixed(6), (-l.cantidad * cpp).toFixed(4), saldo.toFixed(6), (saldo * cpp).toFixed(4), req.usuario!.id]);
          await c.query(`UPDATE core.insumo SET stock = $1, estado = CASE WHEN $1::numeric < minimo THEN 'BAJO_MINIMO' ELSE 'OK' END, actualizado_en = now() WHERE id = $2`, [saldo.toFixed(6), l.insumoId]);
          await c.query('UPDATE core.requisicion_detalle SET cant_entregada = cant_entregada + $3, costo_entregado = costo_entregado + $4 WHERE requisicion_id = $1 AND insumo_id = $2',
            [qq.id, l.insumoId, l.cantidad.toFixed(6), (l.cantidad * cpp).toFixed(4)]);
        }
        const pend = (await c.query<{ n: string }>('SELECT count(*) n FROM core.requisicion_detalle WHERE requisicion_id = $1 AND cant_entregada + 0.000001 < cant_solicitada', [qq.id])).rows[0].n;
        const estado = Number(pend) === 0 ? 'ATENDIDA' : 'PARCIAL';
        await c.query('UPDATE core.requisicion SET estado = $2, atendida_en = now(), atendida_por = $3 WHERE id = $1', [qq.id, estado, req.usuario!.id]);
        return { codigo, op: qq.op, estado };
      });
      await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'REQUISICION_ATENDIDA', entidad: 'requisicion', entidadId: codigo, detalle: p.data, ip: req.ip });
      void emitirEvento('inventario.movimiento', r);
      return r;
    } catch (e) {
      const err = e as Error & { status?: number };
      if (!err.status) throw e;
      return reply.code(err.status).send(error(err.status, 'REQUISICION_INVALIDA', err.message));
    }
  });
}
