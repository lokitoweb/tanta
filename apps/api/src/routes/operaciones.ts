import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, tx, uno, num } from '../db.js';
import { autenticar, exigir, error } from '../seguridad.js';
import { auditar } from '../auditoria.js';
import { invalidar } from '../cache.js';
import { emitirEvento, enviarPush } from './sistema.js';

/** Idempotencia: la misma clave devuelve la misma respuesta, nunca duplica el efecto. */
async function conIdempotencia<T>(
  clave: string | undefined,
  usuarioId: string,
  ruta: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!clave) return fn();
  const previa = await uno<{ respuesta: unknown }>(
    'SELECT respuesta FROM core.idempotencia WHERE clave = $1', [clave],
  );
  if (previa) return previa.respuesta as T;

  const resultado = await fn();
  await q(
    `INSERT INTO core.idempotencia (clave, usuario_id, ruta, respuesta, expira_en)
     VALUES ($1,$2,$3,$4, now() + interval '72 hours')
     ON CONFLICT (clave) DO NOTHING`,
    [clave, usuarioId, ruta, JSON.stringify(resultado)],
  );
  return resultado;
}

export async function rutasOperaciones(app: FastifyInstance) {
  /* ------------------------------------------------------------ productos */
  const NuevoProducto = z.object({
    nombre: z.string().min(2).max(120),
    categoriaId: z.string().min(1),
    unidad: z.string().min(1).max(20).default('UNIDAD'),
    precioConIgv: z.number().min(0).max(100000),
    mermaPct: z.number().min(0).max(0.5).default(0.03),
  });

  app.post('/productos', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'maestros.editar')) return;
    const parseo = NuevoProducto.safeParse(req.body);
    if (!parseo.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', parseo.error.issues[0]?.message ?? 'Datos inválidos.'));

    const d = parseo.data;
    const fila = await uno<{ id: string }>(
      `INSERT INTO core.producto (codigo, nombre, categoria_id, unidad, precio_con_igv, merma_pct)
       VALUES ('P' || lpad((SELECT coalesce(max(substring(codigo from 2)::int), 0) + 1 FROM core.producto WHERE codigo ~ '^P[0-9]+$')::text, 3, '0'), $1,$2,$3,$4,$5)
       RETURNING id`,
      [d.nombre, d.categoriaId, d.unidad, d.precioConIgv.toFixed(4), d.mermaPct.toFixed(6)],
    );
    await auditar({
      actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol,
      accion: 'PRODUCTO_CREADO', entidad: 'producto', entidadId: fila?.id, detalle: d, ip: req.ip,
    });
    return reply.code(201).send({ id: fila?.id, ...d });
  });

  /* ------------------------------------------------- órdenes de producción */
  app.post('/ordenes-produccion/:codigo/iniciar', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'produccion.ejecutar')) return;
    const { codigo } = req.params as { codigo: string };

    const op = await uno<{ id: string; estado: string }>(
      'SELECT id, estado FROM core.orden_produccion WHERE codigo = $1', [codigo],
    );
    if (!op) return reply.code(404).send(error(404, 'OP_NO_EXISTE', 'La orden no existe.'));
    if (op.estado !== 'PENDIENTE') {
      return reply.code(409).send(error(409, 'OP_ESTADO_INVALIDO', `No se puede iniciar una orden en estado ${op.estado}.`));
    }
    await q(
      `UPDATE core.orden_produccion SET estado = 'EN_PROCESO', iniciada_en = now(), avance = greatest(avance, 0.05)
       WHERE id = $1`, [op.id],
    );
    await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'OP_INICIADA', entidad: 'orden_produccion', entidadId: codigo, ip: req.ip });
    return reply.send({ codigo, estado: 'EN_PROCESO' });
  });

  const CerrarOP = z.object({
    cantidadProducida: z.number().positive(),
    mermaReal: z.number().min(0).max(0.9).default(0),
  });

  /**
   * Cerrar una OP mueve inventario de verdad, en una sola transacción:
   * descuenta insumos según receta, registra merma e ingresa el producto terminado.
   */
  app.post('/ordenes-produccion/:codigo/cerrar', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'produccion.ejecutar')) return;
    const { codigo } = req.params as { codigo: string };
    const parseo = CerrarOP.safeParse(req.body);
    if (!parseo.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Cantidad producida inválida.'));
    const { cantidadProducida, mermaReal } = parseo.data;

    const clave = req.headers['idempotency-key'] as string | undefined;

    try {
      const resultado = await conIdempotencia(clave, req.usuario!.id, `op-cerrar:${codigo}`, () =>
        tx(async (c) => {
          const r = await c.query<{ id: string; estado: string; producto_id: string; producto: string; receta_id: string; cantidad: string }>(
            'SELECT id, estado, producto_id, producto, receta_id, cantidad FROM core.orden_produccion WHERE codigo = $1 FOR UPDATE',
            [codigo],
          );
          const op = r.rows[0];
          if (!op) throw Object.assign(new Error('OP_NO_EXISTE'), { status: 404 });
          if (op.estado !== 'EN_PROCESO') {
            throw Object.assign(new Error(op.estado === 'PENDIENTE' ? 'Primero inicia la orden (Pendiente → En proceso).' : 'OP_ESTADO_INVALIDO'), { status: 409 });
          }

          const lineas = await c.query<{ insumo_id: string; insumo: string; unidad: string; cantidad: string }>(
            `SELECT d.insumo_id, d.insumo, d.unidad, d.cantidad / r.rendimiento AS cantidad
             FROM core.receta_detalle d JOIN core.receta r ON r.id = d.receta_id WHERE d.receta_id = $1 ORDER BY d.orden`,
            [op.receta_id],
          );

          const consumidos: Array<{ insumo: string; cantidad: number }> = [];
          for (const l of lineas.rows) {
            const cantidadUsada = Number(l.cantidad) * cantidadProducida * (1 + mermaReal);
            const ins = await c.query<{ cpp: string; saldo: string }>(
              `SELECT i.cpp, coalesce((SELECT m.saldo_cantidad FROM core.movimiento_inventario m
                                       WHERE m.insumo_id = i.id ORDER BY m.id DESC LIMIT 1), i.stock) AS saldo
               FROM core.insumo i WHERE i.id = $1 FOR UPDATE`,
              [l.insumo_id],
            );
            const cpp = Number(ins.rows[0]?.cpp ?? 0);
            const saldoActual = Number(ins.rows[0]?.saldo ?? 0);
            const nuevoSaldo = saldoActual - cantidadUsada;
            // Política estricta: nunca se entrega lo que no existe. La base también lo impide
            // con ck_insumo_stock_no_negativo; aquí se devuelve un error de negocio legible.
            if (nuevoSaldo < -0.000001) {
              throw Object.assign(
                new Error(`STOCK_INSUFICIENTE:${l.insumo} (disponible ${saldoActual.toFixed(2)}, requerido ${cantidadUsada.toFixed(2)})`),
                { status: 409 },
              );
            }
            const valor = -Number((cantidadUsada * cpp).toFixed(4));
            const valorSaldo = Number((-valor + Number((saldoActual * cpp).toFixed(4))).toFixed(4));

            await c.query(
              `INSERT INTO core.movimiento_inventario
                 (tipo,item_tipo,insumo_id,documento,cantidad,costo_unitario,valor,saldo_cantidad,saldo_valor,cpp)
               VALUES ('CONSUMO_OP','INSUMO',$1,$2,$3,$4,$5,$6,$7,$8)`,
              [l.insumo_id, codigo, (-cantidadUsada).toFixed(6), cpp.toFixed(6), valor.toFixed(4),
                nuevoSaldo.toFixed(6), valorSaldo.toFixed(4), cpp.toFixed(6)],
            );
            await c.query('UPDATE core.insumo SET stock = $1, actualizado_en = now() WHERE id = $2',
              [nuevoSaldo.toFixed(6), l.insumo_id]);
            consumidos.push({ insumo: l.insumo, cantidad: Number(cantidadUsada.toFixed(3)) });
          }

          // ingreso del producto terminado al stock
          const pr = await c.query<{ costo_unitario: string; stock: string }>(
            'SELECT costo_unitario, stock FROM core.producto WHERE id = $1 FOR UPDATE', [op.producto_id],
          );
          const costoProd = Number(pr.rows[0]?.costo_unitario ?? 0);
          const stockProd = Number(pr.rows[0]?.stock ?? 0);
          const nuevoStockProd = stockProd + cantidadProducida;

          await c.query(
            `INSERT INTO core.movimiento_inventario
               (tipo,item_tipo,producto_id,documento,cantidad,costo_unitario,valor,saldo_cantidad,saldo_valor,cpp)
             VALUES ('INGRESO_PRODUCCION','PRODUCTO',$1,$2,$3,$4,$5,$6,$7,$8)`,
            [op.producto_id, codigo, cantidadProducida.toFixed(6), costoProd.toFixed(6),
              (cantidadProducida * costoProd).toFixed(4), nuevoStockProd.toFixed(6),
              ((stockProd + cantidadProducida) * costoProd).toFixed(4), costoProd.toFixed(6)],
          );
          await c.query('UPDATE core.producto SET stock = $1 WHERE id = $2', [nuevoStockProd.toFixed(6), op.producto_id]);

          await c.query(
            `UPDATE core.orden_produccion
             SET estado = 'TERMINADA', terminada_en = now(), avance = 1, merma_real = $2, cantidad_producida = $3
             WHERE id = $1`,
            [op.id, mermaReal.toFixed(6), cantidadProducida.toFixed(6)],
          );
          await c.query('SELECT core.recalcular_costos()');

          return { codigo, estado: 'TERMINADA', producto: op.producto, cantidadProducida, consumidos };
        }),
      );

      await auditar({
        actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol,
        accion: 'OP_CERRADA', entidad: 'orden_produccion', entidadId: codigo,
        detalle: { cantidadProducida, mermaReal }, ip: req.ip,
      });
      return reply.send(resultado);
    } catch (e) {
      const err = e as Error & { status?: number };
      // Sin status = error no previsto: el manejador global lo traduce o lo enmascara.
      if (!err.status) throw e;
      const status = err.status;
      return reply.code(status).send(error(status, err.message, err.message));
    }
  });

  /* --------------------------------------------------------------- ventas */
  const NuevaVenta = z.object({
    items: z.array(z.object({
      productoId: z.string().uuid(),
      // Un tope por línea evita desbordes numéricos y ventas absurdas por error de tecleo.
      cantidad: z.number().positive().max(10_000),
    })).min(1).max(50),
    formaPago: z.enum(['EFECTIVO', 'TRANSFERENCIA', 'YAPE', 'PLIN', 'CREDITO']).default('EFECTIVO'),
    clienteId: z.string().uuid().optional(),
    // Descuento autorizado (PDF §3.2): tope en Parámetros → descuento_maximo; queda auditado.
    descuentoPct: z.number().min(0).max(0.9).default(0),
    pedidoId: z.string().uuid().optional(),
  }).refine(
    // Una venta al crédito sin cliente no puede generar cuenta por cobrar.
    (v) => v.formaPago !== 'CREDITO' || !!v.clienteId,
    { message: 'Una venta al crédito requiere clienteId.', path: ['clienteId'] },
  );

  app.post('/ventas', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'ventas.registrar')) return;
    const parseo = NuevaVenta.safeParse(req.body);
    if (!parseo.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', parseo.error.issues[0]?.message ?? 'Venta inválida.'));

    const { items, formaPago, clienteId, descuentoPct, pedidoId } = parseo.data;
    const clave = req.headers['idempotency-key'] as string | undefined;

    try {
      const venta = await conIdempotencia(clave, req.usuario!.id, 'crear-venta', () =>
        tx(async (c) => {
          const param = await c.query<{ clave: string; valor: string }>(`SELECT clave, valor FROM core.parametro WHERE clave IN ('igv','descuento_maximo')`);
          const igv = Number(param.rows.find((x) => x.clave === 'igv')?.valor ?? 0.18);
          const tope = Number(param.rows.find((x) => x.clave === 'descuento_maximo')?.valor ?? 0);
          if (descuentoPct > tope + 1e-9) throw Object.assign(new Error(`El descuento máximo autorizado es ${Math.round(tope * 100)} %.`), { status: 422 });
          // El código se genera antes: cada movimiento de inventario queda trazado a su venta.
          const codigo = (await c.query<{ n: string }>(
            `SELECT 'VTA-' || to_char(now(),'YYYY') || '-' || lpad(nextval('core.venta_correlativo_seq')::text, 6, '0') AS n`,
          )).rows[0].n;
          let totalConIgv = 0;

          let netas = 0;
          let costoTotal = 0;
          const lineas: Array<Record<string, unknown>> = [];

          // Una sola consulta para todos los productos, bloqueados en orden de id
          // (orden determinista = sin deadlocks entre ventas concurrentes).
          const ids = [...new Set(items.map((i) => i.productoId))].sort();
          const prods = await c.query<{ id: string; nombre: string; precio_con_igv: string; costo_unitario: string; stock: string }>(
            `SELECT id, nombre, precio_con_igv, costo_unitario, stock
             FROM core.producto WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
            [ids],
          );
          const mapa = new Map(prods.rows.map((r) => [r.id, r]));
          const stockRestante = new Map(prods.rows.map((r) => [r.id, Number(r.stock)]));

          for (const it of items) {
            const prod = mapa.get(it.productoId);
            if (!prod) throw Object.assign(new Error('PRODUCTO_NO_EXISTE'), { status: 404 });

            const netoLinea = Number(((Number(prod.precio_con_igv) * (1 - descuentoPct) / (1 + igv)) * it.cantidad).toFixed(4));
            totalConIgv += Number(prod.precio_con_igv) * (1 - descuentoPct) * it.cantidad;
            const costoLinea = Number((Number(prod.costo_unitario) * it.cantidad).toFixed(4));
            const utilidad = Number((netoLinea - costoLinea).toFixed(4));
            const margen = netoLinea > 0 ? utilidad / netoLinea : 0;

            netas += netoLinea;
            costoTotal += costoLinea;

            lineas.push({
              productoId: prod.id, producto: prod.nombre, cantidad: it.cantidad,
              precioConIgv: Number(prod.precio_con_igv), precioNeto: Number((netoLinea / it.cantidad).toFixed(4)),
              costoUnitario: Number(prod.costo_unitario), utilidad, margen,
            });

            const nuevoStock = (stockRestante.get(prod.id) ?? 0) - it.cantidad;
            if (nuevoStock < -0.000001) {
              throw Object.assign(
                new Error(`STOCK_INSUFICIENTE:${prod.nombre} (disponible ${stockRestante.get(prod.id) ?? 0})`),
                { status: 409 },
              );
            }
            stockRestante.set(prod.id, nuevoStock);
            const valorSaldo = Number((nuevoStock * Number(prod.costo_unitario)).toFixed(4));
            await c.query(
              `INSERT INTO core.movimiento_inventario
                 (tipo,item_tipo,producto_id,documento,cantidad,costo_unitario,valor,saldo_cantidad,saldo_valor,cpp)
               VALUES ('VENTA','PRODUCTO',$1,$8,$2,$3,$4,$5,$6,$7)`,
              [prod.id, (-it.cantidad).toFixed(6), Number(prod.costo_unitario).toFixed(6),
                (-costoLinea).toFixed(4), nuevoStock.toFixed(6), valorSaldo.toFixed(4),
                Number(prod.costo_unitario).toFixed(6), codigo],
            );
            await c.query('UPDATE core.producto SET stock = $1 WHERE id = $2', [nuevoStock.toFixed(6), prod.id]);
          }

          netas = Number(netas.toFixed(4));
          costoTotal = Number(costoTotal.toFixed(4));
          const utilidad = Number((netas - costoTotal).toFixed(4));
          const margen = netas > 0 ? utilidad / netas : 0;

          totalConIgv = Number(totalConIgv.toFixed(2));

          const v = await c.query<{ id: string }>(
            `INSERT INTO core.venta (codigo,cliente_id,forma_pago,ventas_netas,costo_ventas,utilidad,margen,estado,vendedor,idempotency_key,vendedor_id,canal,descuento_pct,total_con_igv,pedido_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'CONFIRMADA',$8,$9,$10,
                     CASE WHEN $13::uuid IS NOT NULL OR EXISTS (SELECT 1 FROM core.usuario u WHERE u.cliente_id = $2) THEN 'APP' ELSE 'TERCEROS' END,
                     $11,$12,$13) RETURNING id`,
            [codigo, clienteId ?? null, formaPago, netas.toFixed(4), costoTotal.toFixed(4),
              utilidad.toFixed(4), margen.toFixed(6), req.usuario!.nombre, clave ?? null, req.usuario!.id,
              descuentoPct.toFixed(6), totalConIgv.toFixed(4), pedidoId ?? null],
          );
          const ventaId = v.rows[0].id;

          // Un solo INSERT para todas las líneas: 1 ida y vuelta en vez de N.
          if (lineas.length > 0) {
            await c.query(
              `INSERT INTO core.venta_detalle
                 (venta_id, producto_id, producto, cantidad, precio_con_igv, precio_neto, costo_unitario, utilidad, margen)
               SELECT $1, t.* FROM unnest(
                 $2::uuid[], $3::text[], $4::numeric[], $5::numeric[],
                 $6::numeric[], $7::numeric[], $8::numeric[], $9::numeric[]
               ) AS t(producto_id, producto, cantidad, precio_con_igv, precio_neto, costo_unitario, utilidad, margen)`,
              [
                ventaId,
                lineas.map((l) => l.productoId),
                lineas.map((l) => l.producto),
                lineas.map((l) => (l.cantidad as number).toFixed(6)),
                lineas.map((l) => (l.precioConIgv as number).toFixed(4)),
                lineas.map((l) => (l.precioNeto as number).toFixed(4)),
                lineas.map((l) => (l.costoUnitario as number).toFixed(6)),
                lineas.map((l) => (l.utilidad as number).toFixed(4)),
                lineas.map((l) => (l.margen as number).toFixed(6)),
              ],
            );
          }

          // La cuenta por cobrar se inserta DENTRO de la misma transacción y sin `catch`:
          // si falla, la venta no existe. Antes el error se tragaba y se perdía la deuda.
          let cxcId: string | null = null;
          if (formaPago === 'CREDITO') {
            const cliente = await c.query<{ limite_credito: string; deuda: string; dias_credito: number }>(
              `SELECT c.limite_credito, c.dias_credito,
                      coalesce((SELECT sum(x.saldo) FROM core.cuenta_por_cobrar x
                                WHERE x.cliente_id = c.id AND x.estado IN ('PENDIENTE','PARCIAL')), 0) AS deuda
               FROM core.cliente c WHERE c.id = $1`,
              [clienteId],
            );
            if (cliente.rows.length === 0) {
              throw Object.assign(new Error('CLIENTE_NO_EXISTE'), { status: 404 });
            }
            const limite = Number(cliente.rows[0].limite_credito);
            const deuda = Number(cliente.rows[0].deuda);
            if (limite > 0 && deuda + totalConIgv > limite + 0.001) {
              throw Object.assign(new Error(`Límite de crédito excedido: debe S/ ${deuda.toFixed(2)}, límite S/ ${limite.toFixed(2)} y esta venta suma S/ ${totalConIgv.toFixed(2)}.`), { status: 409 });
            }

            const cx = await c.query<{ id: string }>(
              `INSERT INTO core.cuenta_por_cobrar (cliente_id,venta_id,monto,saldo,vence_en,estado)
               VALUES ($1,$2,$3,$3, current_date + $4::int, 'PENDIENTE') RETURNING id`,
              [clienteId, ventaId, totalConIgv.toFixed(4), Number(cliente.rows[0].dias_credito) > 0 ? Number(cliente.rows[0].dias_credito) : 30],
            );
            cxcId = cx.rows[0].id;
          }

          return { codigo, ventaId, ventasNetas: netas, costoVentas: costoTotal, utilidad, margen, cxcId, lineas };
        }),
      );

      await auditar({
        actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol,
        accion: 'VENTA_REGISTRADA', entidad: 'venta', entidadId: venta.ventaId,
        detalle: { codigo: venta.codigo, monto: venta.ventasNetas, margen: venta.margen }, ip: req.ip,
      });
      void emitirEvento('venta.creada', venta);
      return reply.code(201).send(venta);
    } catch (e) {
      const err = e as Error & { status?: number };
      // Sin status = error no previsto: el manejador global lo traduce o lo enmascara.
      if (!err.status) throw e;
      const status = err.status;
      return reply.code(status).send(error(status, err.message, err.message));
    }
  });

  /* ------------------------------------------------------------- cobranza */
  const NuevaCobranza = z.object({
    cxcId: z.string().uuid(),
    monto: z.number().positive(),
    medio: z.enum(['EFECTIVO', 'TRANSFERENCIA', 'YAPE', 'PLIN']),
    referencia: z.string().max(60).optional(),
  });

  app.post('/cobranza', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'cobranza.registrar')) return;
    const parseo = NuevaCobranza.safeParse(req.body);
    if (!parseo.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Datos de cobranza inválidos.'));
    const { cxcId, monto, medio, referencia } = parseo.data;
    const clave = req.headers['idempotency-key'] as string | undefined;

    try {
      const res = await conIdempotencia(clave, req.usuario!.id, 'cobranza', () =>
        tx(async (c) => {
          const r = await c.query<{ saldo: string; estado: string }>(
            'SELECT saldo, estado FROM core.cuenta_por_cobrar WHERE id = $1 FOR UPDATE', [cxcId],
          );
          const cx = r.rows[0];
          if (!cx) throw Object.assign(new Error('CXC_NO_EXISTE'), { status: 404 });
          const saldo = Number(cx.saldo);
          if (monto > saldo + 0.001) {
            throw Object.assign(new Error('MONTO_EXCEDE_SALDO'), { status: 422 });
          }
          const nuevoSaldo = Number((saldo - monto).toFixed(4));
          const estado = nuevoSaldo <= 0.001 ? 'PAGADA' : 'PARCIAL';

          await c.query('UPDATE core.cuenta_por_cobrar SET saldo = $1, estado = $2 WHERE id = $3',
            [nuevoSaldo.toFixed(4), estado, cxcId]);
          await c.query(
            `INSERT INTO core.cobranza (cxc_id,monto,medio,referencia,registrado_por,idempotency_key)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [cxcId, monto.toFixed(4), medio, referencia ?? null, req.usuario!.id, clave ?? null],
          );
          return { cxcId, aplicado: monto, saldo: nuevoSaldo, estado };
        }),
      );
      await auditar({
        actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol,
        accion: 'COBRANZA_REGISTRADA', entidad: 'cuenta_por_cobrar', entidadId: cxcId,
        detalle: { monto, medio }, ip: req.ip,
      });
      void emitirEvento('cobro.registrado', res);
      return reply.code(201).send(res);
    } catch (e) {
      const err = e as Error & { status?: number };
      // Sin status = error no previsto: el manejador global lo traduce o lo enmascara.
      if (!err.status) throw e;
      const status = err.status;
      return reply.code(status).send(error(status, err.message, err.message));
    }
  });

  /* ------------------------------------------------------------- cartera */
  /** Cuentas por cobrar abiertas: lo que el vendedor ve en su app. */
  app.get('/cxc', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'cobranza.ver')) return;
    const filas = await q<Record<string, string>>(
      `SELECT x.id, c.nombre AS cliente, x.monto, x.saldo, x.vence_en::text AS vence_en, x.estado,
              (current_date - x.vence_en) AS dias
       FROM core.cuenta_por_cobrar x
       JOIN core.cliente c ON c.id = x.cliente_id
       WHERE x.estado IN ('PENDIENTE','PARCIAL') AND x.saldo > 0
       ORDER BY x.vence_en`,
    );
    return reply.send(filas.map((f) => ({
      id: f.id,
      cliente: f.cliente,
      monto: num(f.monto),
      saldo: num(f.saldo),
      venceEn: f.vence_en,
      diasVencido: num(f.dias),
      vencida: num(f.dias) > 0,
      estado: f.estado,
    })));
  });

  /* -------------------------------------------------------------- pedidos */
  const CambioPedido = z.object({
    estado: z.enum(['EN_PRODUCCION', 'LISTO', 'DESPACHADO', 'ENTREGADO', 'CANCELADO']),
  });

  /** Transiciones permitidas: es una máquina de estados, no un campo libre. */
  const TRANSICIONES: Record<string, string[]> = {
    REGISTRADO: ['EN_PRODUCCION', 'CANCELADO'],
    EN_PRODUCCION: ['LISTO', 'CANCELADO'],
    LISTO: ['DESPACHADO', 'CANCELADO'],
    DESPACHADO: ['ENTREGADO'],
    ENTREGADO: [],
    CANCELADO: [],
  };

  app.patch('/pedidos/:codigo/estado', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'pedidos.gestionar')) return;
    const { codigo } = req.params as { codigo: string };
    const parseo = CambioPedido.safeParse(req.body);
    if (!parseo.success) return reply.code(422).send(error(422, 'ESTADO_INVALIDO', 'Estado de pedido inválido.'));
    const destino = parseo.data.estado;

    const pedido = await uno<{ id: string; estado: string; cliente: string }>(
      'SELECT id, estado, cliente FROM core.pedido WHERE codigo = $1', [codigo],
    );
    if (!pedido) return reply.code(404).send(error(404, 'PEDIDO_NO_EXISTE', 'El pedido no existe.'));

    const permitidos = TRANSICIONES[pedido.estado] ?? [];
    if (!permitidos.includes(destino)) {
      return reply.code(409).send(error(409, 'TRANSICION_INVALIDA',
        `No se puede pasar de ${pedido.estado} a ${destino}.`));
    }

    // Condicionado al estado leído: dos vendedores a la vez no pueden saltarse la máquina de estados.
    const cambio = await q('UPDATE core.pedido SET estado = $1 WHERE id = $2 AND estado = $3 RETURNING id', [destino, pedido.id, pedido.estado]);
    if (!cambio.length) return reply.code(409).send(error(409, 'PEDIDO_CAMBIADO', 'Otro usuario cambió este pedido. Recarga e intenta de nuevo.'));
    await auditar({
      actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol,
      accion: `PEDIDO_${destino}`, entidad: 'pedido', entidadId: codigo,
      detalle: { de: pedido.estado, a: destino, cliente: pedido.cliente }, ip: req.ip,
    });
    void emitirEvento('pedido.estado', { codigo, de: pedido.estado, a: destino });
    // PDF 3.2: el cliente recibe push cuando su pedido cambia de estado.
    void uno<{ id: string }>(
      'SELECT u.id FROM core.usuario u JOIN core.pedido p ON p.cliente_id = u.cliente_id WHERE p.id = $1 LIMIT 1', [pedido.id],
    ).then((u) => u && enviarPush(u.id, `Pedido ${codigo}`, `Tu pedido ahora está: ${destino.replace('_', ' ').toLowerCase()}`)).catch(() => {});
    return reply.send({ codigo, estadoAnterior: pedido.estado, estado: destino });
  });

  /* ---------------------------------------------------------------- kárdex */
  /* --------------------------------------------------- inventario: insumos */
  // PDF 3.3: compra (actualiza el CPP), bajas con motivo y toma de inventario físico.
  const MovInsumo = z.discriminatedUnion('tipo', [
    z.object({ tipo: z.literal('COMPRA'), insumoId: z.string().uuid(), cantidad: z.number().positive().max(1_000_000),
      costoUnitario: z.number().positive().max(100_000), motivo: z.string().trim().min(3).max(200) }),
    z.object({ tipo: z.literal('MERMA'), insumoId: z.string().uuid(), cantidad: z.number().positive().max(1_000_000),
      motivo: z.string().trim().min(3).max(200) }),
    z.object({ tipo: z.literal('CONTEO'), insumoId: z.string().uuid(), cantidadContada: z.number().min(0).max(1_000_000),
      motivo: z.string().trim().min(3).max(200) }),
  ]);

  app.post('/inventario/movimientos', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'inventario.mover')) return;
    const parseo = MovInsumo.safeParse(req.body);
    if (!parseo.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Revisa cantidad, costo y motivo (mínimo 3 caracteres).'));
    const m = parseo.data;
    const clave = req.headers['idempotency-key'] as string | undefined;

    try {
      const resultado = await conIdempotencia(clave, req.usuario!.id, 'inventario-mov', () =>
        tx(async (c) => {
          const r = await c.query<{ codigo: string; nombre: string; cpp: string; stock: string }>(
            'SELECT codigo, nombre, cpp, stock FROM core.insumo WHERE id = $1 FOR UPDATE', [m.insumoId],
          );
          const ins = r.rows[0];
          if (!ins) throw Object.assign(new Error('INSUMO_NO_EXISTE'), { status: 404 });
          const saldo = Number(ins.stock);
          const cpp = Number(ins.cpp);

          let tipo: 'COMPRA' | 'MERMA' | 'AJUSTE';
          let delta: number;
          let costo = cpp;
          let nuevoCpp = cpp;
          if (m.tipo === 'COMPRA') {
            tipo = 'COMPRA'; delta = m.cantidad; costo = m.costoUnitario;
            // Costo promedio ponderado: (saldo·cpp + compra·costo) / (saldo + compra).
            nuevoCpp = (Math.max(saldo, 0) * cpp + m.cantidad * m.costoUnitario) / (Math.max(saldo, 0) + m.cantidad);
          } else if (m.tipo === 'MERMA') {
            tipo = 'MERMA'; delta = -m.cantidad;
          } else {
            tipo = 'AJUSTE'; delta = m.cantidadContada - saldo;
            if (Math.abs(delta) < 0.000001) return { insumo: ins.nombre, tipo, diferencia: 0, saldo };
          }
          const nuevoSaldo = saldo + delta;
          if (nuevoSaldo < -0.000001) {
            throw Object.assign(new Error(`STOCK_INSUFICIENTE:${ins.nombre} (disponible ${saldo.toFixed(2)})`), { status: 409 });
          }
          const valor = delta * costo;
          await c.query(
            `INSERT INTO core.movimiento_inventario
               (tipo,item_tipo,insumo_id,documento,cantidad,costo_unitario,valor,saldo_cantidad,saldo_valor,cpp,idempotency_key,registrado_por)
             VALUES ($1,'INSUMO',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [tipo, m.insumoId, m.motivo.slice(0, 200), delta.toFixed(6), costo.toFixed(6), valor.toFixed(4),
              nuevoSaldo.toFixed(6), (nuevoSaldo * nuevoCpp).toFixed(4), nuevoCpp.toFixed(6), clave ?? null, req.usuario!.id],
          );
          await c.query('UPDATE core.insumo SET stock = $1, cpp = $2, actualizado_en = now() WHERE id = $3',
            [nuevoSaldo.toFixed(6), nuevoCpp.toFixed(6), m.insumoId]);
          if (tipo === 'COMPRA') await c.query('SELECT core.recalcular_costos()');
          return { insumo: ins.nombre, tipo, diferencia: Number(delta.toFixed(3)), saldo: Number(nuevoSaldo.toFixed(3)), cpp: Number(nuevoCpp.toFixed(4)) };
        }),
      );
      invalidar('cat:'); // stock, CPP y costos nuevos se ven al instante, no tras el TTL
      void emitirEvento('inventario.movimiento', resultado);
      await auditar({
        actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol,
        accion: `INVENTARIO_${m.tipo}`, entidad: 'insumo', entidadId: m.insumoId, detalle: m, ip: req.ip,
      });
      return reply.send(resultado);
    } catch (e) {
      const err = e as Error & { status?: number };
      // Sin status = error no previsto: el manejador global lo traduce o lo enmascara.
      if (!err.status) throw e;
      const status = err.status;
      return reply.code(status).send(error(status, err.message, err.message));
    }
  });

  app.get('/kardex/:codigo', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'inventario.ver')) return;
    const { codigo } = req.params as { codigo: string };
    const filas = await q<Record<string, string>>(
      `SELECT m.id, m.creado_en::text AS fecha, m.tipo, m.documento, m.cantidad, m.costo_unitario,
              m.valor, m.saldo_cantidad, m.saldo_valor, m.cpp
       FROM core.movimiento_inventario m
       JOIN core.insumo i ON i.id = m.insumo_id
       WHERE i.codigo = $1 ORDER BY m.id`,
      [codigo],
    );
    return reply.send(filas.map((f) => ({
      fecha: f.fecha, tipo: f.tipo, documento: f.documento, cantidad: num(f.cantidad),
      costoUnitario: num(f.costo_unitario), valor: num(f.valor),
      saldoCantidad: num(f.saldo_cantidad), saldoValor: num(f.saldo_valor), cpp: num(f.cpp),
    })));
  });
}
