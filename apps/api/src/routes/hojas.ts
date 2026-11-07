import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, tx, uno, num } from '../db.js';
import { autenticar, exigir, error } from '../seguridad.js';
import { auditar } from '../auditoria.js';
import { calcularOrden, fechaEntregaSugerida, reservarListo } from './flujo.js';
import { cierreOP } from './operaciones.js';
import { avisar } from './notificaciones.js';

/**
 * Hoja de producción (LOT 1001…): el maestro ve en tiempo real los pedidos confirmados por cliente, cierra los pedidos
 * (pasan a producción y nace una OP por producto) y cierra la producción con lo realmente horneado. Reutiliza el motor
 * de las OP: sin requisición, los insumos se descargan al cerrar y el pan entra al almacén a su costo real.
 * Las líneas de promoción no entran: salen del stock.
 */

type Fila = { productoId: string; producto: string; porCliente: Record<string, number>; pedido: number };

async function matriz(filtro: string, params: unknown[]) {
  const lineas = await q<Record<string, string>>(`
    SELECT p.cliente_id, p.cliente, d.producto_id, d.producto, sum(d.cantidad) cantidad
    FROM core.pedido p JOIN core.pedido_detalle d ON d.pedido_id = p.id
    WHERE d.promocion_id IS NULL AND ${filtro}
    GROUP BY p.cliente_id, p.cliente, d.producto_id, d.producto ORDER BY p.cliente, d.producto`, params);
  const clientes = new Map<string, string>();
  const filas = new Map<string, Fila>();
  for (const l of lineas) {
    clientes.set(l.cliente_id, l.cliente);
    const f = filas.get(l.producto_id) ?? { productoId: l.producto_id, producto: l.producto, porCliente: {}, pedido: 0 };
    f.porCliente[l.cliente_id] = num(l.cantidad);
    f.pedido += num(l.cantidad);
    filas.set(l.producto_id, f);
  }
  return { clientes: [...clientes].map(([id, nombre]) => ({ id, nombre })), filas: [...filas.values()] };
}

/** Kárdex de la hoja: lo que consumirán los panes pedidos y cómo queda cada insumo frente a su mínimo. */
async function insumosDe(filas: Fila[]) {
  const acumulado = new Map<string, { insumoId: string; insumo: string; unidad: string; cantidad: number; stock: number }>();
  const sinReceta: string[] = [];
  for (const f of filas) {
    const calc = await calcularOrden(f.productoId, f.pedido, 'PROPORCIONAL');
    if (!calc) { sinReceta.push(f.producto); continue; }
    for (const i of calc.insumos) {
      const a = acumulado.get(i.insumoId) ?? { insumoId: i.insumoId, insumo: i.insumo, unidad: i.unidad, cantidad: 0, stock: i.stock };
      a.cantidad += i.necesario;
      acumulado.set(i.insumoId, a);
    }
  }
  const minimos = new Map((await q<{ id: string; minimo: string }>('SELECT id, minimo FROM core.insumo WHERE id = ANY($1::uuid[])', [[...acumulado.keys()]])).map((m) => [m.id, num(m.minimo)]));
  const insumos = [...acumulado.values()].map((a) => {
    const restante = a.stock - a.cantidad, minimo = minimos.get(a.insumoId) ?? 0;
    return { ...a, cantidad: Number(a.cantidad.toFixed(3)), restante: Number(restante.toFixed(3)), minimo, estado: restante < 0 ? 'FALTA' : restante < minimo ? 'ALERTA' : 'NORMAL' };
  });
  return { insumos, sinReceta };
}

async function detalleHoja(codigo: string, verCostos: boolean) {
  const h = await uno<Record<string, string>>(`SELECT h.id, h.codigo, h.fecha::text, h.estado, h.creado_en::text, h.cerrada_en::text, u.nombre cerrada_por
    FROM core.hoja_produccion h LEFT JOIN core.usuario u ON u.id = h.cerrada_por WHERE h.codigo = $1`, [codigo]);
  if (!h) return null;
  const { clientes, filas } = await matriz('p.hoja_id = $1', [h.id]);
  const ops = await q<Record<string, string>>(`SELECT o.codigo, o.producto_id, o.producto, o.cantidad, o.cantidad_producida, o.costo_total, p.precio_con_igv
    FROM core.orden_produccion o JOIN core.producto p ON p.id = o.producto_id WHERE o.hoja_id = $1 AND o.estado <> 'ANULADA' ORDER BY o.producto`, [h.id]);
  const igv = num((await uno<{ valor: string }>("SELECT valor FROM core.parametro WHERE clave = 'igv'"))?.valor ?? '0.18');
  const resumen = ops.map((o) => {
    const real = o.cantidad_producida === null ? null : num(o.cantidad_producida);
    const venta = real === null ? null : Number((real * num(o.precio_con_igv) / (1 + igv)).toFixed(2));
    const costo = o.costo_total === null ? null : num(o.costo_total);
    const rentabilidad = venta === null || costo === null ? null : Number((venta - costo).toFixed(2));
    return { op: o.codigo, productoId: o.producto_id, producto: o.producto, pedido: num(o.cantidad), real,
      ...(verCostos ? { costo, venta, rentabilidad, pctRentabilidad: venta && rentabilidad !== null ? Number((rentabilidad / venta * 100).toFixed(2)) : null } : {}) };
  });
  const usados = await q<Record<string, string>>(`SELECT i.nombre insumo, i.unidad_inventario unidad, sum(-m.cantidad) cantidad, sum(-m.valor) costo
    FROM core.movimiento_inventario m JOIN core.insumo i ON i.id = m.insumo_id
    WHERE m.tipo = 'CONSUMO_OP' AND m.documento = ANY($1::text[]) GROUP BY i.nombre, i.unidad_inventario ORDER BY i.nombre`, [ops.map((o) => o.codigo)]);
  const porComprar = await q<Record<string, string>>(`SELECT nombre insumo, unidad_inventario unidad, stock, minimo, minimo - stock falta FROM core.insumo
    WHERE activo AND maneja_stock AND stock < minimo ORDER BY (minimo - stock) DESC LIMIT 100`);
  const n = (x: string) => num(x);
  return {
    codigo: h.codigo, fecha: h.fecha, estado: h.estado, creadoEn: h.creado_en, cerradaEn: h.cerrada_en, cerradaPor: h.cerrada_por, clientes, filas, resumen,
    insumosUsados: usados.map((u) => ({ insumo: u.insumo, unidad: u.unidad, cantidad: n(u.cantidad), ...(verCostos ? { costo: n(u.costo) } : {}) })),
    insumosPorComprar: porComprar.map((p) => ({ insumo: p.insumo, unidad: p.unidad, stock: n(p.stock), minimo: n(p.minimo), falta: n(p.falta) })),
  };
}

const Fecha = z.object({ fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
const fallo = (status: number, mensaje: string) => Object.assign(new Error(mensaje), { status });

export async function rutasHojas(app: FastifyInstance) {
  // Pedidos confirmados que aún no se cierran, por fecha de entrega: es lo que el maestro ve llenarse en tiempo real.
  app.get('/produccion/hoja', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'produccion.ver')) return;
    const p = Fecha.safeParse(req.query);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Fecha inválida.'));
    const fechas = (await q<{ fecha: string }>(`SELECT DISTINCT p.fecha_entrega::text fecha FROM core.pedido p JOIN core.pedido_detalle d ON d.pedido_id = p.id
      WHERE p.estado = 'CONFIRMADO' AND d.promocion_id IS NULL ORDER BY 1 LIMIT 30`)).map((f) => f.fecha);
    const fecha = p.data.fecha ?? fechas[0] ?? await fechaEntregaSugerida();
    const { clientes, filas } = await matriz("p.estado = 'CONFIRMADO' AND p.fecha_entrega = $1::date", [fecha]);
    return { fecha, fechas, clientes, filas, ...(await insumosDe(filas)) };
  });

  // Historial: toda hoja, en curso o cerrada.
  app.get('/produccion/hojas', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'produccion.ver')) return;
    const filas = await q<Record<string, string>>(`SELECT h.codigo, h.fecha::text, h.estado, h.cerrada_en::text,
        (SELECT count(*) FROM core.orden_produccion o WHERE o.hoja_id = h.id) productos,
        (SELECT coalesce(sum(o.cantidad_producida), 0) FROM core.orden_produccion o WHERE o.hoja_id = h.id) unidades
      FROM core.hoja_produccion h ORDER BY h.creado_en DESC LIMIT 200`);
    return filas.map((f) => ({ codigo: f.codigo, fecha: f.fecha, estado: f.estado, cerradaEn: f.cerrada_en, productos: num(f.productos), unidades: num(f.unidades) }));
  });

  app.get('/produccion/hojas/:codigo', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'produccion.ver')) return;
    const d = await detalleHoja((req.params as { codigo: string }).codigo, req.usuario!.permisos.has('costos.ver'));
    return d ?? reply.code(404).send(error(404, 'NO_ENCONTRADO', 'La hoja no existe.'));
  });

  // Cerrar pedidos: pasan a producción, nace el lote y una OP por producto (sin requisición: se descarga al cerrar).
  app.post('/produccion/hoja/cerrar-pedidos', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'produccion.planificar')) return;
    const p = z.object({ fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Elige la fecha de entrega.') }).safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues[0]?.message ?? 'Fecha inválida.'));
    try {
      const codigo = await tx(async (c) => {
        const pedidos = (await c.query<{ id: string }>(`SELECT p.id FROM core.pedido p WHERE p.estado = 'CONFIRMADO' AND p.fecha_entrega = $1::date
          AND EXISTS (SELECT 1 FROM core.pedido_detalle d WHERE d.pedido_id = p.id AND d.promocion_id IS NULL) ORDER BY p.id FOR UPDATE`, [p.data.fecha])).rows.map((x) => x.id);
        if (!pedidos.length) throw fallo(409, 'No hay pedidos confirmados para esa fecha.');
        const lineas = (await c.query<{ producto_id: string; cantidad: string }>(`SELECT producto_id, sum(cantidad) cantidad FROM core.pedido_detalle
          WHERE pedido_id = ANY($1::uuid[]) AND promocion_id IS NULL GROUP BY producto_id ORDER BY producto_id`, [pedidos])).rows;
        const cod = (await c.query<{ n: string }>(`SELECT 'LOT ' || nextval('core.hoja_produccion_seq') n`)).rows[0].n;
        const hojaId = (await c.query<{ id: string }>('INSERT INTO core.hoja_produccion (codigo, fecha, creado_por) VALUES ($1,$2,$3) RETURNING id', [cod, p.data.fecha, req.usuario!.id])).rows[0].id;
        for (const l of lineas) {
          const rec = (await c.query<{ id: string; producto: string; merma_estandar: string }>(`SELECT r.id, r.producto, r.merma_estandar FROM core.receta r WHERE r.producto_id = $1 AND r.estado = 'VIGENTE'`, [l.producto_id])).rows[0];
          const calc = rec ? await calcularOrden(l.producto_id, num(l.cantidad), 'PROPORCIONAL') : null;
          if (!rec || !calc) {
            const n = (await c.query<{ nombre: string }>('SELECT nombre FROM core.producto WHERE id = $1', [l.producto_id])).rows[0]?.nombre;
            throw fallo(422, `${n ?? 'Un producto'} no tiene receta vigente: créala en Recetas antes de cerrar los pedidos.`);
          }
          const op = (await c.query<{ n: string }>(`SELECT 'OP-' || to_char(now(),'YYYY') || '-' || lpad(nextval('core.op_correlativo_seq')::text, 6, '0') n`)).rows[0].n;
          // lotes NULL: el maestro puede producir más que lo pedido (460 de 450); el costo se calcula con lo real.
          await c.query(`INSERT INTO core.orden_produccion (codigo, producto_id, producto, receta_id, cantidad, estado, entrega, responsable, merma_esperada, criterio,
              unidades_esperadas, masa_kg, hoja_id, iniciada_en, avance) VALUES ($1,$2,$3,$4,$5,'EN_PROCESO',$6,$7,$8,'PROPORCIONAL',$9,$10,$11,now(),0.05)`,
            [op, l.producto_id, rec.producto, rec.id, l.cantidad, p.data.fecha, req.usuario!.nombre, rec.merma_estandar, calc.unidadesObtenidas, calc.masaKg, hojaId]);
        }
        await c.query(`UPDATE core.pedido SET estado = 'EN_PRODUCCION', hoja_id = $2 WHERE id = ANY($1::uuid[])`, [pedidos, hojaId]);
        return cod;
      });
      await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'HOJA_PEDIDOS_CERRADOS', entidad: 'hoja_produccion', entidadId: codigo, detalle: p.data, ip: req.ip });
      return reply.code(201).send({ codigo, estado: 'EN_PRODUCCION' });
    } catch (e) {
      const err = e as Error & { status?: number };
      if (!err.status) throw e;
      return reply.code(err.status).send(error(err.status, 'HOJA_INVALIDA', err.message));
    }
  });

  const Cierre = z.object({ lineas: z.array(z.object({ productoId: z.string().uuid(), real: z.number().min(0).max(100_000), merma: z.number().min(0).max(100_000).default(0) })).min(1).max(100) });

  // Cerrar producción: cada pan entra al almacén con lo real, se descargan los insumos y los pedidos quedan listos.
  app.post('/produccion/hojas/:codigo/cerrar', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'produccion.ejecutar')) return;
    const { codigo } = req.params as { codigo: string };
    const p = Cierre.safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Indica la producción real de cada pan.'));
    try {
      const r = await tx(async (c) => {
        const h = (await c.query<{ id: string; estado: string }>('SELECT id, estado FROM core.hoja_produccion WHERE codigo = $1 FOR UPDATE', [codigo])).rows[0];
        if (!h) throw fallo(404, 'La hoja no existe.');
        if (h.estado !== 'EN_PRODUCCION') throw fallo(409, 'La producción de esta hoja ya se cerró.');
        const ops = (await c.query<{ codigo: string; producto_id: string; producto: string }>(`SELECT codigo, producto_id, producto FROM core.orden_produccion
          WHERE hoja_id = $1 AND estado = 'EN_PROCESO' ORDER BY producto_id`, [h.id])).rows;
        const reales = new Map(p.data.lineas.map((l) => [l.productoId, l]));
        for (const op of ops) {
          const l = reales.get(op.producto_id);
          if (!l) throw fallo(422, `Falta la producción real de ${op.producto}.`);
          const total = l.real + l.merma;
          await cierreOP(c, { codigo: op.codigo, cantidadProducida: l.real, unidadesMerma: l.merma, mermaReal: total > 0 ? l.merma / total : 0, motivoMerma: '', usuarioId: req.usuario!.id });
        }
        await c.query(`UPDATE core.hoja_produccion SET estado = 'CERRADA', cerrada_por = $2, cerrada_en = now() WHERE id = $1`, [h.id, req.usuario!.id]);
        // Con lo producido, los pedidos del lote quedan listos por orden de llegada; el que no alcance sigue en producción.
        const pedidos = (await c.query<{ id: string; codigo: string }>(`SELECT id, codigo FROM core.pedido WHERE hoja_id = $1 AND estado = 'EN_PRODUCCION' ORDER BY creado_en FOR UPDATE`, [h.id])).rows;
        const sinStock: string[] = [];
        for (const x of pedidos) {
          if (await reservarListo(c, x.id)) await c.query(`UPDATE core.pedido SET estado = 'LISTO' WHERE id = $1`, [x.id]);
          else sinStock.push(x.codigo);
        }
        return { listos: pedidos.length - sinStock.length, sinStock };
      });
      await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'HOJA_PRODUCCION_CERRADA', entidad: 'hoja_produccion', entidadId: codigo, detalle: { ...p.data, ...r }, ip: req.ip });
      if (r.sinStock.length) avisar([{ permiso: 'pedidos.gestionar' }], { tipo: 'pedido', titulo: `${codigo}: faltó producción`, cuerpo: `Sin stock para ${r.sinStock.join(', ')}: siguen en producción.`, ruta: '/ventas/pedidos' });
      return { codigo, estado: 'CERRADA', ...r };
    } catch (e) {
      const err = e as Error & { status?: number };
      if (!err.status) throw e;
      return reply.code(err.status).send(error(err.status, 'HOJA_INVALIDA', err.message.replace(/^STOCK_INSUFICIENTE:/, 'Stock insuficiente de ')));
    }
  });
}
