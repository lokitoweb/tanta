import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, uno, num } from '../db.js';
import { autenticar, exigir, error } from '../seguridad.js';
import { auditar } from '../auditoria.js';
import { notificar } from './notificaciones.js';

/**
 * Despacho y promociones. Cargar un pedido a la móvil es el mismo POST /ventas de siempre (descuenta stock, genera la
 * cuenta por cobrar y pasa el pedido a DESPACHADO, «En tránsito»), con el vehículo y los empaques usados.
 */

const Vehiculo = z.object({
  placa: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,12}$/, 'Placa inválida'),
  descripcion: z.string().trim().max(80).default(''),
  conductor: z.string().trim().max(80).default(''),
  activo: z.boolean().default(true),
});

const hoyLima = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);

const Promocion = z.object({
  productoId: z.string().uuid(),
  titulo: z.string().trim().min(3, 'Escribe el título.').max(80),
  precioConIgv: z.number().positive('Indica el precio de promoción.').max(100_000),
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  activa: z.boolean().default(true),
  avisar: z.boolean().default(false),
}).refine((d) => d.hasta >= d.desde, { message: 'La fecha final no puede ser anterior a la inicial.', path: ['hasta'] });

export async function rutasDespacho(app: FastifyInstance) {
  /* ---------------------------------------------------------------- despacho */
  app.get('/despacho', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'despacho.ver')) return;
    const pedidos = await q<Record<string, unknown>>(`
      SELECT p.id, p.codigo, p.cliente, p.estado, p.total, p.direccion, p.fecha_entrega::text fecha, p.observaciones, ve.placa vehiculo,
             coalesce((SELECT json_agg(json_build_object('productoId', d.producto_id, 'producto', d.producto, 'cantidad', d.cantidad, 'presentacion', d.presentacion_codigo,
               'cantidadPresentacion', d.cantidad_presentacion) ORDER BY d.id) FROM core.pedido_detalle d WHERE d.pedido_id = p.id), '[]') items,
             coalesce((SELECT json_agg(json_build_object('insumo', e.insumo, 'cantidad', e.cantidad) ORDER BY e.id) FROM core.pedido_empaque e WHERE e.pedido_id = p.id), '[]') empaques
      FROM core.pedido p LEFT JOIN core.vehiculo ve ON ve.id = p.vehiculo_id
      WHERE p.estado IN ('LISTO','DESPACHADO') ORDER BY p.estado DESC, p.fecha_entrega, p.creado_en LIMIT 200`);
    const vehiculos = await q<Record<string, unknown>>('SELECT id, placa, descripcion, conductor, activo FROM core.vehiculo ORDER BY activo DESC, placa');
    const empaques = await q<Record<string, string>>(`SELECT i.id, i.nombre, i.unidad_inventario unidad, i.stock FROM core.insumo i JOIN core.tipo_insumo t ON t.codigo = i.tipo
      WHERE t.es_empaque AND i.activo ORDER BY i.nombre`);
    return {
      pedidos: pedidos.map((p) => ({ ...p, total: num(p.total as string) })),
      vehiculos, empaques: empaques.map((e) => ({ ...e, stock: num(e.stock) })),
    };
  });

  app.post('/vehiculos', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'despacho.gestionar')) return;
    const p = Vehiculo.safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues[0]?.message ?? 'Vehículo inválido.'));
    const d = p.data;
    if (await uno('SELECT 1 FROM core.vehiculo WHERE placa = $1', [d.placa])) return reply.code(409).send(error(409, 'PLACA_REPETIDA', 'Ya existe un vehículo con esa placa.'));
    const f = await uno<{ id: string }>('INSERT INTO core.vehiculo (placa, descripcion, conductor, activo) VALUES ($1,$2,$3,$4) RETURNING id', [d.placa, d.descripcion, d.conductor, d.activo]);
    await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'VEHICULO_CREADO', entidad: 'vehiculo', entidadId: f!.id, detalle: d, ip: req.ip });
    return reply.code(201).send({ id: f!.id, ...d });
  });

  app.patch('/vehiculos/:id', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'despacho.gestionar')) return;
    const { id } = req.params as { id: string };
    const p = Vehiculo.safeParse(req.body);
    if (!p.success || !z.string().uuid().safeParse(id).success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.success ? 'Vehículo inválido.' : p.error.issues[0]?.message ?? 'Vehículo inválido.'));
    const d = p.data;
    if (await uno('SELECT 1 FROM core.vehiculo WHERE placa = $1 AND id <> $2', [d.placa, id])) return reply.code(409).send(error(409, 'PLACA_REPETIDA', 'Ya existe un vehículo con esa placa.'));
    const r = await q('UPDATE core.vehiculo SET placa=$2, descripcion=$3, conductor=$4, activo=$5 WHERE id=$1 RETURNING id', [id, d.placa, d.descripcion, d.conductor, d.activo]);
    if (!r.length) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'El vehículo no existe.'));
    await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'VEHICULO_EDITADO', entidad: 'vehiculo', entidadId: id, detalle: d, ip: req.ip });
    return { id, ...d };
  });

  /* ------------------------------------------------------------- promociones */
  // Lo que ve el cliente: promociones vigentes con stock disponible (stock − reservado).
  app.get('/promociones/vigentes', { preHandler: autenticar }, async () => {
    const igv = num((await uno<{ valor: string }>("SELECT valor FROM core.parametro WHERE clave = 'igv'"))?.valor ?? '0.18');
    const filas = await q<Record<string, string>>(`SELECT x.id, x.producto_id, p.nombre producto, x.titulo, x.precio_con_igv, p.precio_con_igv precio_normal, x.hasta::text, p.imagen_id,
        greatest(p.stock - p.reservado, 0) disponible
      FROM core.promocion x JOIN core.producto p ON p.id = x.producto_id
      WHERE x.activa AND p.estado = 'ACTIVO' AND $1::date BETWEEN x.desde AND x.hasta AND p.stock - p.reservado >= 1 ORDER BY x.hasta, p.nombre`, [hoyLima()]);
    return filas.map((f) => ({ id: f.id, productoId: f.producto_id, producto: f.producto, titulo: f.titulo, precioConIgv: num(f.precio_con_igv), precioNormal: num(f.precio_normal),
      hasta: f.hasta, imagenId: f.imagen_id, disponible: Math.floor(num(f.disponible)), precioNeto: Number((num(f.precio_con_igv) / (1 + igv)).toFixed(4)) }));
  });

  app.get('/promociones', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'promociones.gestionar')) return;
    const filas = await q<Record<string, string>>(`SELECT x.id, x.producto_id, p.nombre producto, x.titulo, x.precio_con_igv, p.precio_con_igv precio_normal, x.desde::text, x.hasta::text, x.activa,
        greatest(p.stock - p.reservado, 0) disponible,
        coalesce((SELECT sum(d.cantidad) FROM core.pedido_detalle d JOIN core.pedido k ON k.id = d.pedido_id WHERE d.promocion_id = x.id AND k.estado NOT IN ('CANCELADO','RECHAZADO')), 0) vendidas
      FROM core.promocion x JOIN core.producto p ON p.id = x.producto_id ORDER BY x.hasta DESC, x.creado_en DESC LIMIT 200`);
    return filas.map((f) => ({ id: f.id, productoId: f.producto_id, producto: f.producto, titulo: f.titulo, precioConIgv: num(f.precio_con_igv), precioNormal: num(f.precio_normal),
      desde: f.desde, hasta: f.hasta, activa: Boolean(f.activa), disponible: num(f.disponible), vendidas: num(f.vendidas) }));
  });

  const avisarPromocion = async (d: z.infer<typeof Promocion>) => {
    const cuentas = await q<{ id: string }>(`SELECT u.id FROM core.usuario u JOIN core.cliente c ON c.id = u.cliente_id WHERE u.estado = 'ACTIVO' AND c.estado = 'ACTIVO'`);
    await notificar(cuentas.map((u) => ({ usuarioId: u.id })), { tipo: 'promocion', titulo: d.titulo, cuerpo: `A S/ ${d.precioConIgv.toFixed(2)} hasta el ${d.hasta.split('-').reverse().join('/')}, mientras haya stock.`, ruta: '/catalogo' });
  };

  app.post('/promociones', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'promociones.gestionar')) return;
    const p = Promocion.safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues[0]?.message ?? 'Promoción inválida.'));
    const d = p.data;
    if (!(await uno(`SELECT 1 FROM core.producto WHERE id = $1 AND estado = 'ACTIVO'`, [d.productoId]))) return reply.code(422).send(error(422, 'PRODUCTO_INVALIDO', 'El producto no existe o está inactivo.'));
    const f = await uno<{ id: string }>(`INSERT INTO core.promocion (producto_id, titulo, precio_con_igv, desde, hasta, activa, creado_por) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [d.productoId, d.titulo, d.precioConIgv.toFixed(4), d.desde, d.hasta, d.activa, req.usuario!.id]);
    await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'PROMOCION_CREADA', entidad: 'promocion', entidadId: f!.id, detalle: d, ip: req.ip });
    if (d.avisar && d.activa) await avisarPromocion(d);
    return reply.code(201).send({ id: f!.id });
  });

  app.patch('/promociones/:id', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'promociones.gestionar')) return;
    const { id } = req.params as { id: string };
    const p = Promocion.safeParse(req.body);
    if (!p.success || !z.string().uuid().safeParse(id).success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.success ? 'Promoción inválida.' : p.error.issues[0]?.message ?? 'Promoción inválida.'));
    const d = p.data;
    const r = await q('UPDATE core.promocion SET producto_id=$2, titulo=$3, precio_con_igv=$4, desde=$5, hasta=$6, activa=$7 WHERE id=$1 RETURNING id',
      [id, d.productoId, d.titulo, d.precioConIgv.toFixed(4), d.desde, d.hasta, d.activa]);
    if (!r.length) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'La promoción no existe.'));
    await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'PROMOCION_EDITADA', entidad: 'promocion', entidadId: id, detalle: d, ip: req.ip });
    if (d.avisar && d.activa) await avisarPromocion(d);
    return { id };
  });
}
