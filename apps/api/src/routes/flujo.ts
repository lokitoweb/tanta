import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, tx, uno, num, type Cliente } from '../db.js';
import { autenticar, exigir, error } from '../seguridad.js';
import { auditar } from '../auditoria.js';
import { emitirEvento } from './sistema.js';
import { avisar } from './notificaciones.js';

import { presentacionesDe } from './operaciones.js';

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

const hoyMasDias = (ms: number) => new Date(Date.now() - 5 * 3_600_000 + ms).toISOString();

/** Entrega al día siguiente; el mismo día si se pide antes de la hora de corte (parámetro administrable). */
export async function fechaEntregaSugerida(horasMinimas = 0): Promise<string> {
  const corte = (await uno<{ valor: string }>("SELECT valor FROM core.parametro WHERE clave = 'hora_corte_mismo_dia'"))?.valor ?? '00:00';
  const ahora = hoyMasDias(0);
  const base = ahora.slice(11, 16) < corte ? ahora.slice(0, 10) : hoyMasDias(86_400_000).slice(0, 10);
  // Un producto con anticipación propia corre la entrega en lugar de rechazar el pedido.
  const minima = hoyMasDias(horasMinimas * 3_600_000).slice(0, 10);
  return base > minima ? base : minima;
}

type ItemPedido = { productoId: string; cantidad: number; presentacion?: string; promocionId?: string };
type LineaPedido = ItemPedido & { unidades: number; precioUnidad: number; importe: number; nombre: string };

/** Valida productos, presentaciones y promociones contra la base y calcula el precio de cada línea. El cliente nunca fija el precio. */
async function armarLineas(c: Cliente, items: ItemPedido[]) {
  const ids = [...new Set(items.map((i) => i.productoId))];
  const prods = await c.query<{ id: string; nombre: string; precio_con_igv: string; anticipacion_horas: number }>(
    "SELECT id, nombre, precio_con_igv, anticipacion_horas FROM core.producto WHERE id = ANY($1::uuid[]) AND estado = 'ACTIVO' AND insumo_id IS NULL", [ids]);
  if (prods.rowCount !== ids.length) throw Object.assign(new Error('Hay un producto inexistente o inactivo.'), { status: 422 });
  const mapa = new Map(prods.rows.map((x) => [x.id, x]));
  const pres = await presentacionesDe(c, items);
  const hoy = hoyMasDias(0).slice(0, 10);
  const lineas: LineaPedido[] = [];
  for (const i of items) {
    const p = mapa.get(i.productoId)!;
    if (i.promocionId) {
      if (items.some((x) => x.productoId === i.productoId && x !== i)) throw Object.assign(new Error(`${p.nombre} va una sola vez: con promoción o sin ella.`), { status: 422 });
      const promo = (await c.query<{ precio_con_igv: string }>('SELECT precio_con_igv FROM core.promocion WHERE id = $1 AND producto_id = $2 AND activa AND $3::date BETWEEN desde AND hasta', [i.promocionId, i.productoId, hoy])).rows[0];
      if (!promo) throw Object.assign(new Error(`La promoción de ${p.nombre} ya no está vigente.`), { status: 409 });
      lineas.push({ ...i, nombre: p.nombre, presentacion: undefined, unidades: i.cantidad, precioUnidad: num(promo.precio_con_igv), importe: num(promo.precio_con_igv) * i.cantidad });
    } else if (!i.presentacion) {
      lineas.push({ ...i, nombre: p.nombre, unidades: i.cantidad, precioUnidad: num(p.precio_con_igv), importe: num(p.precio_con_igv) * i.cantidad });
    } else {
      const x = pres.get(`${i.productoId}|${i.presentacion}`);
      if (!x) throw Object.assign(new Error(`${p.nombre} no se vende en la presentación ${i.presentacion}.`), { status: 422 });
      lineas.push({ ...i, nombre: p.nombre, unidades: i.cantidad * x.equivalencia, precioUnidad: x.precio / x.equivalencia, importe: x.precio * i.cantidad });
    }
  }
  return { lineas, total: lineas.reduce((s, i) => s + i.importe, 0), horas: Math.max(0, ...prods.rows.map((x) => Number(x.anticipacion_horas))) };
}

/** Las promociones venden lo que hay: se reserva al pedir y no pasa a producción. */
async function reservarPromos(c: Cliente, lineas: LineaPedido[]) {
  for (const l of lineas.filter((x) => x.promocionId).sort((a, b) => a.productoId.localeCompare(b.productoId))) {
    const p = (await c.query<{ stock: string; reservado: string }>('SELECT stock, reservado FROM core.producto WHERE id = $1 FOR UPDATE', [l.productoId])).rows[0];
    const disponible = num(p.stock) - num(p.reservado);
    if (disponible + 1e-6 < l.unidades) throw Object.assign(new Error(`Solo quedan ${Math.max(0, Math.floor(disponible))} de ${l.nombre} en promoción.`), { status: 409 });
    await c.query('UPDATE core.producto SET reservado = reservado + $2 WHERE id = $1', [l.productoId, l.unidades]);
  }
}

export async function liberarPromos(c: Cliente, pedidoId: string) {
  for (const l of (await c.query<{ producto_id: string; cantidad: string }>('SELECT producto_id, sum(cantidad) cantidad FROM core.pedido_detalle WHERE pedido_id = $1 AND promocion_id IS NOT NULL GROUP BY producto_id ORDER BY producto_id', [pedidoId])).rows) {
    await c.query('UPDATE core.producto SET reservado = greatest(reservado - $2, 0) WHERE id = $1', [l.producto_id, l.cantidad]);
  }
}

/** RN-29 / APT-04: un pedido listo reserva su stock (lo de promoción ya está reservado). Sin stock: error, o false si no es estricto. */
export async function reservarListo(c: Cliente, pedidoId: string, estricto = false): Promise<boolean> {
  const lineas = (await c.query<{ producto_id: string; producto: string; cantidad: string }>(
    'SELECT producto_id, producto, sum(cantidad) cantidad FROM core.pedido_detalle WHERE pedido_id = $1 AND promocion_id IS NULL GROUP BY producto_id, producto ORDER BY producto_id', [pedidoId])).rows;
  const stock = new Map<string, number>();
  for (const l of lineas) {
    const p = (await c.query<{ stock: string; reservado: string }>('SELECT stock, reservado FROM core.producto WHERE id = $1 FOR UPDATE', [l.producto_id])).rows[0];
    const disponible = num(p.stock) - num(p.reservado);
    stock.set(l.producto_id, disponible);
    if (disponible + 1e-6 < num(l.cantidad)) {
      if (!estricto) return false;
      throw Object.assign(new Error(`No hay stock para reservar ${l.producto}: disponible ${disponible.toFixed(0)}, pedido ${num(l.cantidad).toFixed(0)}.`), { status: 409 });
    }
  }
  for (const l of lineas) await c.query('UPDATE core.producto SET reservado = reservado + $2 WHERE id = $1', [l.producto_id, l.cantidad]);
  return true;
}

async function guardarLineas(c: Cliente, pedidoId: string, lineas: LineaPedido[]) {
  for (const i of lineas) {
    await c.query(`INSERT INTO core.pedido_detalle (pedido_id, producto_id, producto, cantidad, precio_con_igv, presentacion_codigo, cantidad_presentacion, promocion_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [pedidoId, i.productoId, i.nombre, i.unidades, i.precioUnidad.toFixed(4), i.presentacion ?? null, i.presentacion ? i.cantidad : null, i.promocionId ?? null]);
  }
}

export async function rutasFlujo(app: FastifyInstance) {
  // Cuándo llegaría un pedido hecho ahora: el cliente lo ve antes de confirmar.
  app.get('/pedidos/entrega-estimada', { preHandler: autenticar }, async () => ({ fecha: await fechaEntregaSugerida() }));

  /* --------------------------------------------------------------- pedidos */
  const NuevoPedido = z.object({
    clienteId: z.string().uuid().optional(),
    // Con presentación (paquete x 6) la cantidad va en presentaciones; sin ella, en unidades.
    items: z.array(z.object({ productoId: z.string().uuid(), cantidad: z.number().positive().max(10_000), presentacion: z.string().trim().toUpperCase().max(20).optional(), promocionId: z.string().uuid().optional() })).min(1).max(50),
    // Al cliente la entrega se le calcula; el personal puede indicar otra fecha por una excepción.
    fechaEntrega: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    horaEntrega: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).or(z.literal('')).default(''),
    observaciones: z.string().trim().max(500).default(''),
    // PED-03: recojo en tienda o delivery (con dirección).
    tipoEntrega: z.enum(['RECOJO', 'DELIVERY']).optional(),
    direccion: z.string().trim().max(200).default(''),
    // Boleta, factura o nota de pedido (Maestros → Catálogos → Comprobantes de venta).
    comprobanteTipo: z.string().trim().toUpperCase().max(20).optional(),
    // Sin forma de pago: el cliente no paga al pedir. Cómo paga (o si queda debiendo) se registra al entregar.
  }).refine((d) => d.tipoEntrega !== 'DELIVERY' || d.direccion.length >= 5, { message: 'Indica la dirección de entrega.', path: ['direccion'] });

  app.post('/pedidos', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'pedidos.crear')) return;
    const p = NuevoPedido.safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues[0]?.message ?? 'Pedido inválido.'));
    const d = p.data;
    // Un cliente solo pide a su nombre (aunque envíe otro clienteId): evita IDOR.
    const yo = await uno<{ cliente_id: string | null }>('SELECT cliente_id FROM core.usuario WHERE id = $1', [req.usuario!.id]);
    const clienteId = yo?.cliente_id ?? d.clienteId;
    if (!clienteId) return reply.code(422).send(error(422, 'SIN_CLIENTE', 'Elige el cliente del pedido.'));
    const fechaPedida = yo?.cliente_id ? undefined : d.fechaEntrega;
    if (fechaPedida && fechaPedida < hoyLima()) return reply.code(422).send(error(422, 'FECHA_PASADA', 'La fecha de entrega no puede ser anterior a hoy.'));

    try {
      const r = await tx(async (c) => {
        const cli = (await c.query<{ nombre: string; estado: string; direccion: string; doc_tipo: string }>('SELECT c.nombre, c.estado, c.direccion, c.doc_tipo FROM core.cliente c WHERE c.id = $1 FOR UPDATE', [clienteId])).rows[0];
        if (!cli || cli.estado !== 'ACTIVO') throw Object.assign(new Error('El cliente no existe o está inactivo.'), { status: 422 });
        const comp = (await c.query<{ codigo: string; nombre: string; requiere_ruc: boolean }>(
          `SELECT codigo, nombre, requiere_ruc FROM core.tipo_comprobante_venta WHERE activo AND ($1::text IS NULL OR codigo = $1) ORDER BY orden, codigo LIMIT 1`, [d.comprobanteTipo ?? null])).rows[0];
        if (!comp) throw Object.assign(new Error('Ese tipo de comprobante no existe o está inactivo.'), { status: 422 });
        if (comp.requiere_ruc && cli.doc_tipo !== 'RUC') throw Object.assign(new Error(`La ${comp.nombre.toLowerCase()} requiere un cliente con RUC: elige otro comprobante o actualiza el documento.`), { status: 422 });
        // El cliente envía a una de sus direcciones (máximo en Parámetros); sin ninguna registrada, a la que escriba.
        if (yo?.cliente_id && d.direccion) {
          const suyas = (await direccionesDe(clienteId)).map((x) => x.direccion.trim().toLowerCase());
          if (suyas.length && !suyas.includes(d.direccion.toLowerCase())) throw Object.assign(new Error('Elige una de tus direcciones de entrega (o agrégala en tu perfil).'), { status: 422 });
        }
        const { lineas, total, horas } = await armarLineas(c, d.items);
        await reservarPromos(c, lineas);
        const fechaEntrega = fechaPedida ?? await fechaEntregaSugerida(horas);
        // PED-04 / CP-09: si el personal fija la fecha, respeta la anticipación del producto más exigente (hora de Lima, UTC−5).
        const entrega = Date.parse(`${fechaEntrega}T${d.horaEntrega || '23:59'}:00-05:00`);
        if (fechaPedida && horas > 0 && entrega < Date.now() + horas * 3_600_000) {
          throw Object.assign(new Error(`Este pedido se pide con ${horas} h de anticipación: elige una entrega posterior.`), { status: 422 });
        }
        // La entrega es en la tienda del cliente: su dirección registrada, salvo que indique otra.
        const direccion = d.direccion || (await c.query<{ direccion: string }>('SELECT direccion FROM core.direccion_cliente WHERE cliente_id = $1 ORDER BY creado_en DESC LIMIT 1', [clienteId])).rows[0]?.direccion || cli.direccion || '';
        const tipoEntrega = d.tipoEntrega ?? (direccion ? 'DELIVERY' : 'RECOJO');
        // PED-09: el pedido que registra el vendedor ya queda confirmado; el del cliente espera confirmación (PED-08).
        const estadoInicial = yo?.cliente_id ? 'REGISTRADO' : 'CONFIRMADO';
        const cod = (await c.query<{ n: string }>(`SELECT 'PED-' || to_char(now(),'YYYY') || '-' || lpad(nextval('core.pedido_correlativo_seq')::text, 6, '0') n`)).rows[0].n;
        const ped = (await c.query<{ id: string }>(
          `INSERT INTO core.pedido (codigo, cliente_id, cliente, vendedor, estado, total, fecha_entrega, hora_entrega, observaciones, creado_por, tipo_entrega, direccion, confirmado_en, comprobante_tipo)
           VALUES ($1,$2,$3,$4,$10,$5,$6,$7,$8,$9,$11,$12, CASE WHEN $10 = 'CONFIRMADO' THEN now() END, $13) RETURNING id`,
          [cod, clienteId, cli.nombre, yo?.cliente_id ? 'App cliente' : req.usuario!.nombre, total.toFixed(4), fechaEntrega, d.horaEntrega, d.observaciones, req.usuario!.id,
            estadoInicial, tipoEntrega, tipoEntrega === 'DELIVERY' ? direccion : '', comp.codigo])).rows[0];
        await guardarLineas(c, ped.id, lineas);
        return { id: ped.id, codigo: cod, total: Number(total.toFixed(2)), estado: estadoInicial, fechaEntrega, comprobanteTipo: comp.codigo };
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
             p.tipo_entrega AS "tipoEntrega", p.direccion, (SELECT ve.placa FROM core.vehiculo ve WHERE ve.id = p.vehiculo_id) vehiculo, p.motivo, p.entregado_en::text AS "entregadoEn", p.entrega_obs AS "entregaObs",
             p.observacion_vendedor AS "observacion", p.observado_en::text AS "observadoEn", p.comprobante_tipo AS "comprobanteTipo",
             -- El comprobante emitido al despachar, para descargarlo (sin costos: solo lo que el cliente pagó).
             (SELECT json_build_object('tipo', v.comprobante_tipo, 'nombre', coalesce(t.nombre, v.comprobante_tipo), 'numero', v.serie || '-' || lpad(v.correlativo::text, 8, '0'),
                'fecha', v.creado_en, 'base', v.base, 'igv', v.igv, 'total', v.total_con_igv, 'vendedor', v.vendedor,
                'lineas', (SELECT json_agg(json_build_object('producto', vd.producto, 'cantidad', vd.cantidad, 'precio', vd.precio_con_igv) ORDER BY vd.id) FROM core.venta_detalle vd WHERE vd.venta_id = v.id))
              FROM core.venta v LEFT JOIN core.tipo_comprobante_venta t ON t.codigo = v.comprobante_tipo
              WHERE v.pedido_id = p.id AND v.estado = 'CONFIRMADA' AND v.serie IS NOT NULL LIMIT 1) AS comprobante,
             (SELECT sum(x.saldo) FROM core.venta v JOIN core.cuenta_por_cobrar x ON x.venta_id = v.id WHERE v.pedido_id = p.id AND v.estado = 'CONFIRMADA') AS "porCobrar",
             coalesce(json_agg(json_build_object('productoId', d.producto_id, 'producto', d.producto, 'cantidad', d.cantidad, 'precio', d.precio_con_igv, 'despachado', d.cantidad_despachada,
               'presentacion', d.presentacion_codigo, 'cantidadPresentacion', d.cantidad_presentacion) ORDER BY d.id)
                      FILTER (WHERE d.id IS NOT NULL), '[]') items
      FROM core.pedido p LEFT JOIN core.pedido_detalle d ON d.pedido_id = p.id
      WHERE ($1::uuid IS NULL OR p.cliente_id = $1)
      GROUP BY p.id ORDER BY p.creado_en DESC LIMIT 200`, [yo?.cliente_id ?? null]);
    return filas.map((f) => ({ ...f, total: num(f.total), porCobrar: f.porCobrar === null ? null : num(f.porCobrar), items: (f.items as unknown as Array<Record<string, unknown>>).map((i) => ({ ...i, cantidad: num(i.cantidad), precio: num(i.precio), despachado: num(i.despachado as string),
      cantidadPresentacion: i.cantidadPresentacion === null ? null : num(i.cantidadPresentacion as string) })) }));
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
    const cambiado = await tx(async (c) => {
      const r = await c.query("UPDATE core.pedido SET estado = 'CANCELADO', motivo = $2 WHERE id = $1 AND estado = $3 RETURNING id", [ped.id, p.data.motivo, ped.estado]);
      if (r.rowCount) await liberarPromos(c, ped.id);
      return Boolean(r.rowCount);
    });
    if (!cambiado) return reply.code(409).send(error(409, 'PEDIDO_CAMBIADO', 'El pedido cambió: recarga e intenta de nuevo.'));
    await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'PEDIDO_CANCELADO', entidad: 'pedido', entidadId: codigo, detalle: p.data, ip: req.ip });
    void emitirEvento('pedido.estado', { codigo, de: ped.estado, a: 'CANCELADO' });
    return { codigo, estado: 'CANCELADO' };
  });

  // El vendedor revisa el pedido y, si algo no cuadra («siempre pides 48 y pediste 4»), le avisa al cliente.
  // El pedido no se mueve: el cliente lo anula y lo vuelve a hacer, o el vendedor lo confirma tras hablar con él.
  app.post('/pedidos/:codigo/observar', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'pedidos.gestionar')) return;
    const { codigo } = req.params as { codigo: string };
    const p = z.object({ mensaje: z.string().trim().min(5, 'Escribe qué está mal en el pedido (mínimo 5 caracteres).').max(300) }).safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues[0]?.message ?? 'Mensaje inválido.'));
    const ped = await uno<{ cliente_id: string; cliente: string }>(`UPDATE core.pedido SET observacion_vendedor = $2, observado_en = now(), observado_por = $3
      WHERE codigo = $1 AND estado IN ('REGISTRADO','CONFIRMADO') RETURNING cliente_id, cliente`, [codigo, p.data.mensaje, req.usuario!.id]);
    if (!ped) return reply.code(409).send(error(409, 'NO_OBSERVABLE', 'Solo se observa un pedido por confirmar o confirmado (antes de producción).'));
    await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'PEDIDO_OBSERVADO', entidad: 'pedido', entidadId: codigo, detalle: p.data, ip: req.ip });
    avisar([{ clienteId: ped.cliente_id }], { tipo: 'pedido', titulo: `Revisa tu pedido ${codigo}`,
      cuerpo: `${req.usuario!.nombre}: ${p.data.mensaje} · Si está mal, anúlalo y vuelve a hacerlo.`, ruta: `/pedidos/${codigo}` });
    void emitirEvento('pedido.observado', { codigo });
    return { codigo, observacion: p.data.mensaje };
  });

  // El vendedor corrige lo pedido (antes de producción) tras hablar con el cliente: el total se recalcula y el cliente recibe el aviso.
  app.put('/pedidos/:codigo/items', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'pedidos.gestionar')) return;
    const { codigo } = req.params as { codigo: string };
    const p = z.object({ items: NuevoPedido.innerType().shape.items }).safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues[0]?.message ?? 'Pedido inválido.'));
    try {
      const r = await tx(async (c) => {
        const ped = (await c.query<{ id: string; estado: string; cliente_id: string; total: string }>('SELECT id, estado, cliente_id, total FROM core.pedido WHERE codigo = $1 FOR UPDATE', [codigo])).rows[0];
        if (!ped) throw Object.assign(new Error('El pedido no existe.'), { status: 404 });
        if (!['REGISTRADO', 'CONFIRMADO'].includes(ped.estado)) throw Object.assign(new Error('Solo se corrige un pedido antes de producción.'), { status: 409 });
        const antes = (await c.query('SELECT producto, cantidad FROM core.pedido_detalle WHERE pedido_id = $1 ORDER BY id', [ped.id])).rows;
        await liberarPromos(c, ped.id);
        await c.query('DELETE FROM core.pedido_detalle WHERE pedido_id = $1', [ped.id]);
        const { lineas, total } = await armarLineas(c, p.data.items);
        await reservarPromos(c, lineas);
        await guardarLineas(c, ped.id, lineas);
        await c.query('UPDATE core.pedido SET total = $2, observacion_vendedor = NULL, observado_en = NULL, observado_por = NULL WHERE id = $1', [ped.id, total.toFixed(4)]);
        return { clienteId: ped.cliente_id, total: Number(total.toFixed(2)), antes, despues: lineas.map((l) => ({ producto: l.nombre, cantidad: l.unidades })) };
      });
      await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'PEDIDO_CORREGIDO', entidad: 'pedido', entidadId: codigo, detalle: { antes: r.antes, despues: r.despues, total: r.total }, ip: req.ip });
      avisar([{ clienteId: r.clienteId }], { tipo: 'pedido', titulo: `Tu pedido ${codigo} fue corregido`, cuerpo: `${req.usuario!.nombre} ajustó tu pedido. Nuevo total: S/ ${r.total.toFixed(2)}.`, ruta: `/pedidos/${codigo}` });
      void emitirEvento('pedido.corregido', { codigo });
      return { codigo, total: r.total };
    } catch (e) {
      const err = e as Error & { status?: number };
      if (!err.status) throw e;
      return reply.code(err.status).send(error(err.status, 'PEDIDO_INVALIDO', err.message));
    }
  });

  /* ------------------------------------------------- direcciones (cliente) */
  /** La principal (registro o ficha que mantiene la empresa) va primero y no se borra desde la app; luego las guardadas. */
  const direccionesDe = (cli: string) => q<{ id: string | null; direccion: string; referencia: string; principal: boolean }>(
    `SELECT id, direccion, referencia, principal FROM (
       SELECT NULL::text id, direccion, '' referencia, true principal, NULL::timestamptz creado_en FROM core.cliente WHERE id = $1 AND length(trim(direccion)) >= 5
       UNION ALL SELECT id::text, direccion, coalesce(referencia, ''), false, creado_en FROM core.direccion_cliente WHERE cliente_id = $1) d
     ORDER BY principal DESC, creado_en`, [cli]);
  const maxDirecciones = async () => {
    const v = Number((await uno<{ valor: string }>("SELECT valor FROM core.parametro WHERE clave = 'cliente_max_direcciones'"))?.valor);
    return Number.isInteger(v) && v >= 1 ? v : 4;
  };
  const clienteDe = async (usuarioId: string) => (await uno<{ cliente_id: string | null }>('SELECT cliente_id FROM core.usuario WHERE id = $1', [usuarioId]))?.cliente_id ?? null;

  app.get('/mis-direcciones', { preHandler: autenticar }, async (req, reply) => {
    const cli = await clienteDe(req.usuario!.id);
    if (!cli) return reply.code(403).send(error(403, 'SOLO_CLIENTES', 'Solo para cuentas de cliente.'));
    return direccionesDe(cli);
  });

  // Ficha del cliente (rol Cliente): contacto, documento, celular y direcciones. El documento lo mantiene la empresa.
  app.get('/mi-ficha', { preHandler: autenticar }, async (req, reply) => {
    const cli = await clienteDe(req.usuario!.id);
    if (!cli) return reply.code(403).send(error(403, 'SOLO_CLIENTES', 'Solo para cuentas de cliente.'));
    const f = await uno<Record<string, string>>(`SELECT nombre, contacto, doc_tipo "docTipo", doc_numero "docNumero", telefono, email FROM core.cliente WHERE id = $1`, [cli]);
    return { ...f, direcciones: await direccionesDe(cli), maxDirecciones: await maxDirecciones() };
  });

  app.patch('/mi-ficha', { preHandler: autenticar }, async (req, reply) => {
    const cli = await clienteDe(req.usuario!.id);
    if (!cli) return reply.code(403).send(error(403, 'SOLO_CLIENTES', 'Solo para cuentas de cliente.'));
    const p = z.object({ contacto: z.string().trim().max(120), telefono: z.string().trim().min(6, 'Escribe tu celular.').max(30).regex(/^[0-9+ ()-]*$/, 'Celular inválido') }).safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues[0]?.message ?? 'Datos inválidos.'));
    await q('UPDATE core.cliente SET contacto = $2, telefono = $3 WHERE id = $1', [cli, p.data.contacto, p.data.telefono]);
    await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'CLIENTE_FICHA_ACTUALIZADA', entidad: 'cliente', entidadId: cli, detalle: p.data, ip: req.ip });
    return p.data;
  });

  app.post('/mis-direcciones', { preHandler: autenticar }, async (req, reply) => {
    const cli = await clienteDe(req.usuario!.id);
    if (!cli) return reply.code(403).send(error(403, 'SOLO_CLIENTES', 'Solo para cuentas de cliente.'));
    const p = z.object({ direccion: z.string().trim().min(5).max(200), referencia: z.string().trim().max(120).default('') }).safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Escribe la dirección completa.'));
    // Parámetros → cliente_max_direcciones, contando la dirección principal registrada.
    const [actuales, max] = [(await direccionesDe(cli)).length, await maxDirecciones()];
    if (actuales >= max) return reply.code(409).send(error(409, 'LIMITE', `Puedes tener hasta ${max} direcciones: elimina una para agregar otra.`));
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
