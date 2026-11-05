import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, tx, uno, num } from '../db.js';
import { autenticar, exigir, error } from '../seguridad.js';
import { auditar } from '../auditoria.js';
import { invalidar } from '../cache.js';
import { emitirEvento, guardarImagen } from './sistema.js';
import { avisar } from './notificaciones.js';
import { medioPago, exigirOperacion } from './catalogos.js';
import { falloImagen, ImagenProducto } from './maestros.js';

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
    imagenUrl: ImagenProducto,
  });

  app.post('/productos', { preHandler: autenticar, bodyLimit: 2_000_000 }, async (req, reply) => {
    if (!exigir(req, reply, 'maestros.editar')) return;
    const parseo = NuevoProducto.safeParse(req.body);
    if (!parseo.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', parseo.error.issues[0]?.message ?? 'Datos inválidos.'));

    const { imagenUrl, ...d } = parseo.data;
    // La imagen se valida antes de crear el producto: un 415/413 no deja un producto sin foto que se duplica al reintentar.
    let imagenId: string | null = null;
    if (imagenUrl?.startsWith('data:')) try { imagenId = await guardarImagen(imagenUrl, req.usuario!.id); } catch (e) { return falloImagen(reply, e); }
    const fila = await uno<{ id: string }>(
      `INSERT INTO core.producto (codigo, nombre, categoria_id, unidad, precio_con_igv, merma_pct, imagen_id)
       VALUES ('P' || lpad((SELECT coalesce(max(substring(codigo from 2)::int), 0) + 1 FROM core.producto WHERE codigo ~ '^P[0-9]+$')::text, 3, '0'), $1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [d.nombre, d.categoriaId, d.unidad, d.precioConIgv.toFixed(4), d.mermaPct.toFixed(6), imagenId],
    );
    invalidar('cat:');
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

  app.post('/ordenes-produccion/:codigo/anular', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'produccion.planificar')) return;
    const { codigo } = req.params as { codigo: string };
    const p = z.object({ motivo: z.string().trim().min(5).max(200) }).safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Indica el motivo de la anulación (mínimo 5 caracteres).'));
    try {
      await tx(async (c) => {
        const op = (await c.query<{ id: string; estado: string }>('SELECT id, estado FROM core.orden_produccion WHERE codigo = $1 FOR UPDATE', [codigo])).rows[0];
        if (!op) throw Object.assign(new Error('La orden no existe.'), { status: 404 });
        if (!['PENDIENTE', 'EN_PROCESO'].includes(op.estado)) throw Object.assign(new Error(`Una orden ${op.estado.toLowerCase()} no se anula.`), { status: 409 });
        const entregado = (await c.query<{ n: string }>(`SELECT coalesce(sum(d.cant_entregada), 0) n FROM core.requisicion q
          JOIN core.requisicion_detalle d ON d.requisicion_id = q.id WHERE q.op_id = $1`, [op.id])).rows[0].n;
        if (Number(entregado) > 0) throw Object.assign(new Error('Almacén ya entregó insumos: registra su devolución o merma antes de anular.'), { status: 409 });
        await c.query("UPDATE core.requisicion SET estado = 'ANULADA' WHERE op_id = $1", [op.id]);
        await c.query("UPDATE core.orden_produccion SET estado = 'ANULADA', motivo_anulacion = $2 WHERE id = $1", [op.id, p.data.motivo]);
      });
      await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'OP_ANULADA', entidad: 'orden_produccion', entidadId: codigo, detalle: p.data, ip: req.ip });
      return { codigo, estado: 'ANULADA' };
    } catch (e) {
      const err = e as Error & { status?: number };
      if (!err.status) throw e;
      return reply.code(err.status).send(error(err.status, 'OP_NO_ANULABLE', err.message));
    }
  });

  // A17: unidades buenas, merma en unidades con motivo del catálogo, tiempos y pesaje real.
  // Acepta también el formato anterior (cantidadProducida + mermaReal en fracción) de apps sin actualizar.
  const CerrarOP = z.object({
    unidadesBuenas: z.number().min(0).max(1_000_000).optional(),
    cantidadProducida: z.number().positive().max(1_000_000).optional(),
    unidadesMerma: z.number().min(0).max(1_000_000).optional(),
    mermaReal: z.number().min(0).max(0.9).default(0),
    motivoMermaTipo: z.enum(['CORTE', 'ROTURA', 'QUEMADO', 'DEFORME', 'OTRO']).optional(),
    motivoMerma: z.string().trim().max(200).default(''),
    horasHombreReal: z.number().min(0).max(1000).optional(),
    horasHornoReal: z.number().min(0).max(1000).optional(),
    consumoReal: z.array(z.object({ insumoId: z.string().uuid(), cantidad: z.number().min(0).max(1_000_000) })).max(60).optional(),
  }).refine((d) => d.unidadesBuenas !== undefined || d.cantidadProducida !== undefined, { message: 'Indica las unidades buenas.', path: ['unidadesBuenas'] })
    .refine((d) => {
      const merma = d.unidadesMerma ?? d.mermaReal;
      return merma === 0 || !!d.motivoMermaTipo || d.motivoMerma.length >= 3;
    }, { message: 'Indica el motivo de la merma.', path: ['motivoMerma'] });

  /**
   * Cerrar una OP mueve inventario de verdad, en una sola transacción:
   * descuenta insumos según receta, registra merma e ingresa el producto terminado.
   */
  app.post('/ordenes-produccion/:codigo/cerrar', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'produccion.ejecutar')) return;
    const { codigo } = req.params as { codigo: string };
    const parseo = CerrarOP.safeParse(req.body);
    if (!parseo.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', parseo.error.issues[0]?.message ?? 'Cantidad producida inválida.'));
    const d = parseo.data;
    const cantidadProducida = d.unidadesBuenas ?? d.cantidadProducida!;
    // Merma en unidades; con el formato anterior se deriva de la fracción.
    const unidadesMerma = d.unidadesMerma ?? (d.mermaReal > 0 ? Math.round(cantidadProducida * d.mermaReal / (1 - d.mermaReal)) : 0);
    const mermaReal = cantidadProducida + unidadesMerma > 0 ? unidadesMerma / (cantidadProducida + unidadesMerma) : 0;
    const motivoMerma = [d.motivoMermaTipo, d.motivoMerma].filter(Boolean).join(' · ');

    const clave = req.headers['idempotency-key'] as string | undefined;

    try {
      const resultado = await conIdempotencia(clave, req.usuario!.id, `op-cerrar:${codigo}`, () =>
        tx(async (c) => {
          const r = await c.query<{ id: string; estado: string; producto_id: string; producto: string; receta_id: string; cantidad: string; lotes: string | null; masa_kg: string | null }>(
            'SELECT id, estado, producto_id, producto, receta_id, cantidad, lotes, masa_kg FROM core.orden_produccion WHERE codigo = $1 FOR UPDATE',
            [codigo],
          );
          const op = r.rows[0];
          if (!op) throw Object.assign(new Error('OP_NO_EXISTE'), { status: 404 });
          if (op.estado !== 'EN_PROCESO') {
            throw Object.assign(new Error(op.estado === 'PENDIENTE' ? 'Primero inicia la orden (Pendiente → En proceso).' : 'OP_ESTADO_INVALIDO'), { status: 409 });
          }

          // Con requisición (RN-27) los insumos ya salieron cuando Almacén los entregó: aquí no se descuentan.
          const requisicion = (await c.query<{ id: string; estado: string; codigo: string }>('SELECT id, estado, codigo FROM core.requisicion WHERE op_id = $1', [op.id])).rows[0];
          if (requisicion && requisicion.estado === 'PENDIENTE') {
            throw Object.assign(new Error(`Almacén aún no entrega los insumos (${requisicion.codigo}).`), { status: 409 });
          }
          const receta = (await c.query<{ unidades_teoricas: string; unidades_esperadas: string; horas_hombre_lote: string; horas_horno_lote: string }>(
            `SELECT r.unidades_teoricas, r.unidades_esperadas, p.horas_hombre_lote, p.horas_horno_lote
             FROM core.receta r JOIN core.producto p ON p.id = r.producto_id WHERE r.id = $1`, [op.receta_id])).rows[0];
          const lotes = op.lotes !== null ? Number(op.lotes) : cantidadProducida / Math.max(Number(receta?.unidades_esperadas ?? 0), 1e-9);
          // Unidades buenas + merma no superan lo preparado (lotes × unidades teóricas), con 5 % de holgura.
          if (op.lotes !== null && cantidadProducida + unidadesMerma > lotes * Number(receta?.unidades_teoricas ?? 0) * 1.05 + 1) {
            throw Object.assign(new Error(`Buenas + merma (${cantidadProducida + unidadesMerma}) superan lo preparado (${Math.round(lotes * Number(receta?.unidades_teoricas ?? 0))} unidades).`), { status: 422 });
          }
          const lineas = await c.query<{ insumo_id: string; insumo: string; unidad: string; cantidad: string }>(
            `SELECT d.insumo_id, d.insumo, d.unidad, d.cantidad / r.rendimiento * core.factor_inventario(d.insumo_id) AS cantidad
             FROM core.receta_detalle d JOIN core.receta r ON r.id = d.receta_id WHERE d.receta_id = $1 ORDER BY d.orden`,
            [op.receta_id],
          );

          const consumidos: Array<{ insumo: string; cantidad: number }> = [];
          let costoInsumos = 0;
          if (requisicion) {
            costoInsumos = Number((await c.query<{ c: string }>('SELECT coalesce(sum(costo_entregado), 0) c FROM core.requisicion_detalle WHERE requisicion_id = $1', [requisicion.id])).rows[0].c);
            for (const x of d.consumoReal ?? []) {
              await c.query('UPDATE core.requisicion_detalle SET cant_real_usada = $3 WHERE requisicion_id = $1 AND insumo_id = $2', [requisicion.id, x.insumoId, x.cantidad.toFixed(6)]);
            }
          }
          for (const l of requisicion ? [] : lineas.rows) {
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
            costoInsumos += -valor;
          }

          // RN-28: costo real de la OP = insumos entregados + mano de obra + CIF con las tarifas vigentes.
          const t = (await c.query<Record<string, string | null>>(`SELECT
              (SELECT costo_hora_hombre FROM core.periodo_costos WHERE estado <> 'CERRADO' ORDER BY anio DESC, mes DESC LIMIT 1) hora,
              (SELECT tarifa_hora_horno FROM core.periodo_costos WHERE estado <> 'CERRADO' ORDER BY anio DESC, mes DESC LIMIT 1) th,
              (SELECT tarifa_kg_masa FROM core.periodo_costos WHERE estado <> 'CERRADO' ORDER BY anio DESC, mes DESC LIMIT 1) tk,
              (SELECT tarifa_unidad FROM core.periodo_costos WHERE estado <> 'CERRADO' ORDER BY anio DESC, mes DESC LIMIT 1) tu`)).rows[0];
          const horasHombre = d.horasHombreReal ?? lotes * Number(receta?.horas_hombre_lote ?? 0);
          const horasHorno = d.horasHornoReal ?? lotes * Number(receta?.horas_horno_lote ?? 0);
          const costoMo = horasHombre * Number(t.hora ?? 0);
          const costoCif = horasHorno * Number(t.th ?? 0) + Number(op.masa_kg ?? 0) * Number(t.tk ?? 0) + cantidadProducida * Number(t.tu ?? 0);
          const costoTotal = costoInsumos + costoMo + costoCif;

          // ingreso del producto terminado al stock
          const pr = await c.query<{ costo_unitario: string; stock: string; insumo_id: string | null }>(
            'SELECT costo_unitario, stock, insumo_id FROM core.producto WHERE id = $1 FOR UPDATE', [op.producto_id],
          );
          // El pan entra al almacén a su costo real (costo de la OP ÷ unidades buenas); sin unidades, al estándar.
          const costoProd = cantidadProducida > 0 ? costoTotal / cantidadProducida : Number(pr.rows[0]?.costo_unitario ?? 0);
          const insumoIntermedio = pr.rows[0]?.insumo_id ?? null;

          if (insumoIntermedio) {
            // PRO-13: un intermedio (masa madre) entra al almacén de INSUMOS con costo promedio ponderado.
            const ins = (await c.query<{ stock: string; cpp: string }>('SELECT stock, cpp FROM core.insumo WHERE id = $1 FOR UPDATE', [insumoIntermedio])).rows[0];
            const st = Math.max(0, Number(ins.stock)), cppAnt = Number(ins.cpp);
            const nuevoStock = st + cantidadProducida;
            const nuevoCpp = nuevoStock > 0 ? (st * cppAnt + cantidadProducida * costoProd) / nuevoStock : costoProd;
            await c.query(
              `INSERT INTO core.movimiento_inventario
                 (tipo,item_tipo,insumo_id,documento,cantidad,costo_unitario,valor,saldo_cantidad,saldo_valor,cpp,registrado_por)
               VALUES ('INGRESO_PRODUCCION','INSUMO',$1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [insumoIntermedio, codigo, cantidadProducida.toFixed(6), costoProd.toFixed(6), (cantidadProducida * costoProd).toFixed(4),
                nuevoStock.toFixed(6), (nuevoStock * nuevoCpp).toFixed(4), nuevoCpp.toFixed(6), req.usuario!.id],
            );
            await c.query('UPDATE core.insumo SET stock = $1, cpp = $2, actualizado_en = now() WHERE id = $3', [nuevoStock.toFixed(6), nuevoCpp.toFixed(6), insumoIntermedio]);
          } else {
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
          }

          await c.query(
            `UPDATE core.orden_produccion
             SET estado = 'TERMINADA', terminada_en = now(), avance = 1, merma_real = $2, cantidad_producida = $3, motivo_merma = $4,
                 unidades_buenas = $3, unidades_merma = $5, motivo_merma_tipo = $6, horas_hombre_real = $7, horas_horno_real = $8,
                 costo_total = $9, costo_unitario_real = $10
             WHERE id = $1`,
            [op.id, mermaReal.toFixed(6), cantidadProducida.toFixed(6), motivoMerma, unidadesMerma.toFixed(4), d.motivoMermaTipo ?? null,
              horasHombre.toFixed(3), horasHorno.toFixed(3), costoTotal.toFixed(4), costoProd.toFixed(6)],
          );
          await c.query('SELECT core.recalcular_costos()');

          return { codigo, estado: 'TERMINADA', producto: op.producto, cantidadProducida, unidadesMerma, consumidos,
            costoTotal: Number(costoTotal.toFixed(2)), costoUnitario: Number(costoProd.toFixed(4)),
            desglose: { insumos: Number(costoInsumos.toFixed(2)), manoDeObra: Number(costoMo.toFixed(2)), cif: Number(costoCif.toFixed(2)) } };
        }),
      );

      await auditar({
        actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol,
        accion: 'OP_CERRADA', entidad: 'orden_produccion', entidadId: codigo,
        detalle: { cantidadProducida, unidadesMerma, motivoMerma }, ip: req.ip,
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
    // Catálogo de medios de pago: el medio debe estar activo y habilitado para ventas.
    formaPago: z.string().trim().toUpperCase().max(20).default('EFECTIVO'),
    // COB-02: número de operación obligatorio si el medio lo exige (catálogo).
    referenciaPago: z.string().trim().max(60).default(''),
    // RN-36: un descuento sobre el tope solo con una aprobación vigente del Gerente.
    aprobacionDescuentoId: z.string().uuid().optional(),
    clienteId: z.string().uuid().optional(),
    // Descuento autorizado (PDF §3.2): tope en Parámetros → descuento_maximo; queda auditado.
    descuentoPct: z.number().min(0).max(0.9).default(0),
    pedidoId: z.string().uuid().optional(),
  });

  app.post('/ventas', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'ventas.registrar')) return;
    const parseo = NuevaVenta.safeParse(req.body);
    if (!parseo.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', parseo.error.issues[0]?.message ?? 'Venta inválida.'));

    const { items, formaPago, clienteId, descuentoPct, pedidoId, referenciaPago, aprobacionDescuentoId } = parseo.data;
    const clave = req.headers['idempotency-key'] as string | undefined;

    try {
      const medio = await medioPago(null, formaPago, 'ventas');
      exigirOperacion(medio, referenciaPago);
      // Una venta al crédito sin cliente no puede generar cuenta por cobrar.
      if (medio.es_credito && !clienteId) throw Object.assign(new Error('Una venta al crédito requiere el cliente.'), { status: 422 });
      const venta = await conIdempotencia(clave, req.usuario!.id, 'crear-venta', () =>
        tx(async (c) => {
          const param = await c.query<{ clave: string; valor: string }>(`SELECT clave, valor FROM core.parametro WHERE clave IN ('igv','descuento_maximo')`);
          const igv = Number(param.rows.find((x) => x.clave === 'igv')?.valor ?? 0.18);
          const tope = Number(param.rows.find((x) => x.clave === 'descuento_maximo')?.valor ?? 0);
          // RN-36: sobre el tope, el descuento necesita una aprobación vigente del Gerente para este vendedor.
          if (descuentoPct > tope + 1e-9) {
            const ap = aprobacionDescuentoId ? (await c.query<{ id: string }>(`SELECT id FROM core.descuento_aprobacion
              WHERE id = $1 AND estado = 'APROBADA' AND solicitado_por = $2 AND porcentaje + 0.000001 >= $3 AND expira_en > now()
                AND (cliente_id IS NULL OR cliente_id = $4) FOR UPDATE`, [aprobacionDescuentoId, req.usuario!.id, descuentoPct, clienteId ?? null])).rows[0] : undefined;
            if (!ap) throw Object.assign(new Error(`El descuento máximo sin autorización es ${Math.round(tope * 100)} %: solicita la aprobación del Gerente.`), { status: 422 });
          }
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
          const prods = await c.query<{ id: string; nombre: string; precio_con_igv: string; costo_unitario: string; stock: string; reservado: string }>(
            `SELECT id, nombre, precio_con_igv, costo_unitario, stock, reservado
             FROM core.producto WHERE id = ANY($1::uuid[]) AND insumo_id IS NULL ORDER BY id FOR UPDATE`, // los intermedios no se venden
            [ids],
          );
          const mapa = new Map(prods.rows.map((r) => [r.id, r]));
          const stockRestante = new Map(prods.rows.map((r) => [r.id, Number(r.stock)]));
          const reservado = new Map(prods.rows.map((r) => [r.id, Number(r.reservado)]));
          if (pedidoId) {
            // VEN-02/05: despacho de un pedido listo; no más de lo pedido. Su reserva se libera aquí.
            const ped = (await c.query<{ estado: string }>('SELECT estado FROM core.pedido WHERE id = $1 FOR UPDATE', [pedidoId])).rows[0];
            if (!ped) throw Object.assign(new Error('El pedido no existe.'), { status: 404 });
            if (ped.estado !== 'LISTO') throw Object.assign(new Error('Solo se despacha un pedido en estado Listo.'), { status: 409 });
            const pedidas = new Map((await c.query<{ producto_id: string; cantidad: string }>(
              'SELECT producto_id, sum(cantidad) cantidad FROM core.pedido_detalle WHERE pedido_id = $1 GROUP BY producto_id', [pedidoId])).rows.map((r) => [r.producto_id, Number(r.cantidad)]));
            for (const it of items) {
              if (it.cantidad > (pedidas.get(it.productoId) ?? 0) + 1e-6) throw Object.assign(new Error('No se puede despachar más de lo pedido.'), { status: 422 });
            }
            for (const [prod, cant] of pedidas) {
              if (!reservado.has(prod)) continue;
              reservado.set(prod, Math.max(0, (reservado.get(prod) ?? 0) - cant));
              await c.query('UPDATE core.producto SET reservado = greatest(reservado - $2, 0) WHERE id = $1', [prod, cant]);
            }
            for (const [prod, cant] of pedidas) if (!reservado.has(prod)) await c.query('UPDATE core.producto SET reservado = greatest(reservado - $2, 0) WHERE id = $1', [prod, cant]);
            for (const it of items) {
              await c.query('UPDATE core.pedido_detalle SET cantidad_despachada = $3 WHERE pedido_id = $1 AND producto_id = $2', [pedidoId, it.productoId, it.cantidad]);
            }
            await c.query("UPDATE core.pedido SET estado = 'DESPACHADO', despachado_en = now() WHERE id = $1", [pedidoId]);
          }

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
            // RN-29: lo reservado por pedidos listos no se vende a terceros.
            if (nuevoStock - (reservado.get(prod.id) ?? 0) < -0.000001) {
              throw Object.assign(
                new Error(`STOCK_INSUFICIENTE:${prod.nombre} (disponible ${Math.max(0, (stockRestante.get(prod.id) ?? 0) - (reservado.get(prod.id) ?? 0))})`),
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
          // RN-31/32: nota de venta con serie y correlativo únicos; base e IGV a 2 decimales (base + IGV = total).
          const serie = (await c.query<{ serie: string; correlativo: number }>(`UPDATE core.serie_comprobante SET correlativo_actual = correlativo_actual + 1
            WHERE tipo = 'NOTA_VENTA' AND activo RETURNING serie, correlativo_actual AS correlativo`)).rows[0];
          if (!serie) throw Object.assign(new Error('No hay una serie activa de nota de venta: configúrala en Parámetros.'), { status: 409 });
          const base = Number((totalConIgv / (1 + igv)).toFixed(2));
          const igvMonto = Number((totalConIgv - base).toFixed(2));

          const v = await c.query<{ id: string }>(
            `INSERT INTO core.venta (codigo,cliente_id,forma_pago,ventas_netas,costo_ventas,utilidad,margen,estado,vendedor,idempotency_key,vendedor_id,canal,descuento_pct,total_con_igv,pedido_id,
                                     serie,correlativo,base,igv,referencia_pago)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'CONFIRMADA',$8,$9,$10,
                     CASE WHEN $13::uuid IS NOT NULL OR EXISTS (SELECT 1 FROM core.usuario u WHERE u.cliente_id = $2) THEN 'APP' ELSE 'TERCEROS' END,
                     $11,$12,$13,$14,$15,$16,$17,NULLIF($18,'')) RETURNING id`,
            [codigo, clienteId ?? null, formaPago, netas.toFixed(4), costoTotal.toFixed(4),
              utilidad.toFixed(4), margen.toFixed(6), req.usuario!.nombre, clave ?? null, req.usuario!.id,
              descuentoPct.toFixed(6), totalConIgv.toFixed(4), pedidoId ?? null, serie.serie, serie.correlativo, base.toFixed(2), igvMonto.toFixed(2), referenciaPago],
          );
          const ventaId = v.rows[0].id;
          if (descuentoPct > tope + 1e-9) {
            await c.query("UPDATE core.descuento_aprobacion SET estado = 'USADA', venta_id = $2 WHERE id = $1", [aprobacionDescuentoId, ventaId]);
          }

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
          if (medio.es_credito) {
            const cliente = await c.query<{ limite_credito: string; deuda: string; dias_credito: number; condicion_pago: string }>(
              `SELECT c.limite_credito, c.dias_credito, c.condicion_pago,
                      coalesce((SELECT sum(x.saldo) FROM core.cuenta_por_cobrar x
                                WHERE x.cliente_id = c.id AND x.estado IN ('PENDIENTE','PARCIAL')), 0) AS deuda
               FROM core.cliente c WHERE c.id = $1 FOR UPDATE`,
              [clienteId],
            );
            if (cliente.rows.length === 0) {
              throw Object.assign(new Error('CLIENTE_NO_EXISTE'), { status: 404 });
            }
            // COB-03: solo los clientes con condición "crédito" compran al crédito.
            if (cliente.rows[0].condicion_pago !== 'CREDITO') {
              throw Object.assign(new Error('Este cliente compra al contado: cámbialo a crédito en su ficha para venderle a plazo.'), { status: 409 });
            }
            const limite = Number(cliente.rows[0].limite_credito);
            const deuda = Number(cliente.rows[0].deuda);
            // RN-35 / MAE-08: un cliente con crédito tiene límite definido; sin límite no hay línea (antes 0 = ilimitado).
            if (limite <= 0) throw Object.assign(new Error('Este cliente no tiene límite de crédito definido: fíjalo en su ficha para venderle a plazo.'), { status: 409 });
            if (deuda + totalConIgv > limite + 0.001) {
              throw Object.assign(new Error(`Límite de crédito excedido: debe S/ ${deuda.toFixed(2)}, límite S/ ${limite.toFixed(2)} y esta venta suma S/ ${totalConIgv.toFixed(2)}.`), { status: 409 });
            }

            const cx = await c.query<{ id: string }>(
              `INSERT INTO core.cuenta_por_cobrar (cliente_id,venta_id,monto,saldo,vence_en,estado)
               VALUES ($1,$2,$3,$3, current_date + $4::int, 'PENDIENTE') RETURNING id`,
              [clienteId, ventaId, totalConIgv.toFixed(4), Number(cliente.rows[0].dias_credito) > 0 ? Number(cliente.rows[0].dias_credito) : 30],
            );
            cxcId = cx.rows[0].id;
          }

          return { codigo, ventaId, ventasNetas: netas, costoVentas: costoTotal, utilidad, margen, cxcId, lineas,
            comprobante: { tipo: 'NOTA_VENTA', serie: serie.serie, correlativo: serie.correlativo,
              numero: `${serie.serie}-${String(serie.correlativo).padStart(8, '0')}`, base, igv: igvMonto, total: totalConIgv } };
        }),
      );

      await auditar({
        actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol,
        accion: 'VENTA_REGISTRADA', entidad: 'venta', entidadId: venta.ventaId,
        detalle: { codigo: venta.codigo, monto: venta.ventasNetas, margen: venta.margen }, ip: req.ip,
      });
      void emitirEvento('venta.creada', venta);
      avisar([{ permiso: 'alertas.ventas' }], { tipo: 'venta', titulo: `Venta ${venta.comprobante.numero}`, cuerpo: `${req.usuario!.nombre} · S/ ${venta.comprobante.total.toFixed(2)} · ${formaPago.toLowerCase()}`, ruta: '/gerencia/reportes' });
      return reply.code(201).send(venta);
    } catch (e) {
      const err = e as Error & { status?: number };
      // Sin status = error no previsto: el manejador global lo traduce o lo enmascara.
      if (!err.status) throw e;
      const status = err.status;
      return reply.code(status).send(error(status, err.message, err.message));
    }
  });

  /* -------------------------------------------------------- anular venta */
  // PDF §4.5: la venta no se borra; queda ANULADA, el stock vuelve y la deuda se cancela.
  // Si ya tiene cobros, primero hay que extornarlos: así la caja nunca descuadra.
  app.post('/ventas/:codigo/anular', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'ventas.anular')) return;
    const { codigo } = req.params as { codigo: string };
    const parseo = z.object({ motivo: z.string().trim().min(5).max(200) }).safeParse(req.body);
    if (!parseo.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Indica el motivo de la anulación (mínimo 5 caracteres).'));
    const { motivo } = parseo.data;
    try {
      const r = await tx(async (c) => {
        const v = (await c.query<{ id: string; estado: string; cerrado: boolean }>(
          `SELECT v.id, v.estado, EXISTS (SELECT 1 FROM core.periodo_costos p WHERE p.estado = 'CERRADO'
                    AND make_date(p.anio, p.mes, 1) = date_trunc('month', v.creado_en AT TIME ZONE 'America/Lima')::date) AS cerrado
           FROM core.venta v WHERE v.codigo = $1 FOR UPDATE OF v`, [codigo])).rows[0];
        if (!v) throw Object.assign(new Error('La venta no existe.'), { status: 404 });
        if (v.estado === 'ANULADA') throw Object.assign(new Error('La venta ya está anulada.'), { status: 409 });
        // Un período cerrado tiene reportes definitivos: la corrección va en el mes en curso (nota de crédito), no se reescribe el pasado.
        if (v.cerrado) throw Object.assign(new Error('La venta es de un período ya cerrado: no se puede anular.'), { status: 409 });
        const cobrado = (await c.query<{ n: string }>(
          'SELECT count(*) n FROM core.cobranza b JOIN core.cuenta_por_cobrar x ON x.id = b.cxc_id WHERE x.venta_id = $1', [v.id])).rows[0].n;
        if (Number(cobrado) > 0) throw Object.assign(new Error('La venta tiene cobros registrados: no se puede anular.'), { status: 409 });

        // Mismo orden de bloqueo que POST /ventas (por id de producto): sin deadlocks.
        const lineas = (await c.query<{ producto_id: string; cantidad: string; costo_unitario: string; stock: string; cpp: string }>(
          `SELECT d.producto_id, sum(d.cantidad) cantidad, max(d.costo_unitario) costo_unitario, p.stock, p.costo_unitario cpp
           FROM core.venta_detalle d JOIN core.producto p ON p.id = d.producto_id
           WHERE d.venta_id = $1 GROUP BY d.producto_id, p.stock, p.costo_unitario, p.id ORDER BY p.id`, [v.id])).rows;
        await c.query('SELECT 1 FROM core.producto WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [lineas.map((l) => l.producto_id)]);
        for (const l of lineas) {
          const cantidad = Number(l.cantidad);
          const saldo = Number(l.stock) + cantidad;
          const cpp = Number(l.cpp);
          await c.query(
            `INSERT INTO core.movimiento_inventario
               (tipo,item_tipo,producto_id,documento,cantidad,costo_unitario,valor,saldo_cantidad,saldo_valor,cpp,motivo_tipo,registrado_por)
             VALUES ('DEVOLUCION','PRODUCTO',$1,$2,$3,$4,$5,$6,$7,$4,'ANULACION',$8)`,
            [l.producto_id, codigo, cantidad.toFixed(6), Number(l.costo_unitario).toFixed(6), (cantidad * Number(l.costo_unitario)).toFixed(4),
              saldo.toFixed(6), (saldo * cpp).toFixed(4), req.usuario!.id],
          );
          await c.query('UPDATE core.producto SET stock = $1 WHERE id = $2', [saldo.toFixed(6), l.producto_id]);
        }
        await c.query(`UPDATE core.cuenta_por_cobrar SET estado = 'ANULADA', saldo = 0 WHERE venta_id = $1`, [v.id]);
        await c.query(`UPDATE core.venta SET estado = 'ANULADA', anulada_en = now(), anulada_por = $2, motivo_anulacion = $3 WHERE id = $1`,
          [v.id, req.usuario!.id, motivo]);
        return { codigo, ventaId: v.id, productos: lineas.length };
      });
      invalidar('cat:');
      await auditar({
        actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol,
        accion: 'VENTA_ANULADA', entidad: 'venta', entidadId: r.ventaId, detalle: { codigo, motivo }, ip: req.ip,
      });
      void emitirEvento('venta.anulada', { codigo, motivo });
      return reply.send({ codigo, estado: 'ANULADA' });
    } catch (e) {
      const err = e as Error & { status?: number };
      if (!err.status) throw e;
      return reply.code(err.status).send(error(err.status, 'NO_ANULABLE', err.message));
    }
  });

  /* ------------------------------------------------------------- cobranza */
  const NuevaCobranza = z.object({
    cxcId: z.string().uuid(),
    monto: z.number().positive(),
    medio: z.string().trim().toUpperCase().max(20),
    referencia: z.string().trim().max(60).optional(),
  });

  app.post('/cobranza', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'cobranza.registrar')) return;
    const parseo = NuevaCobranza.safeParse(req.body);
    if (!parseo.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Datos de cobranza inválidos.'));
    const { cxcId, monto, medio, referencia } = parseo.data;
    const clave = req.headers['idempotency-key'] as string | undefined;

    try {
      exigirOperacion(await medioPago(null, medio, 'cobranza'), referencia ?? '');
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
    estado: z.enum(['CONFIRMADO', 'RECHAZADO', 'EN_PRODUCCION', 'LISTO', 'DESPACHADO', 'ENTREGADO', 'CANCELADO']),
    motivo: z.string().trim().max(200).default(''),
    observaciones: z.string().trim().max(250).default(''),
  }).refine((d) => !['RECHAZADO', 'CANCELADO'].includes(d.estado) || d.motivo.length >= 3, { message: 'Indica el motivo.', path: ['motivo'] });

  /** Transiciones permitidas: es una máquina de estados, no un campo libre. */
  // RN-26: Registrado → Confirmado → En producción → Listo → Despachado → Entregado; Rechazado y Cancelado con motivo.
  // Con stock suficiente, un pedido confirmado puede pasar directo a Listo.
  const TRANSICIONES: Record<string, string[]> = {
    REGISTRADO: ['CONFIRMADO', 'RECHAZADO', 'CANCELADO'],
    CONFIRMADO: ['EN_PRODUCCION', 'LISTO', 'CANCELADO'],
    EN_PRODUCCION: ['LISTO', 'CANCELADO'],
    LISTO: ['DESPACHADO', 'CANCELADO'],
    DESPACHADO: ['ENTREGADO'],
    ENTREGADO: [],
    RECHAZADO: [],
    CANCELADO: [],
  };

  app.patch('/pedidos/:codigo/estado', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'pedidos.gestionar')) return;
    const { codigo } = req.params as { codigo: string };
    const parseo = CambioPedido.safeParse(req.body);
    if (!parseo.success) return reply.code(422).send(error(422, 'ESTADO_INVALIDO', parseo.error.issues[0]?.message ?? 'Estado de pedido inválido.'));
    const destino = parseo.data.estado;
    const { motivo, observaciones } = parseo.data;

    const pedido = await uno<{ id: string; estado: string; cliente: string }>(
      'SELECT id, estado, cliente FROM core.pedido WHERE codigo = $1', [codigo],
    );
    if (!pedido) return reply.code(404).send(error(404, 'PEDIDO_NO_EXISTE', 'El pedido no existe.'));

    const permitidos = TRANSICIONES[pedido.estado] ?? [];
    if (!permitidos.includes(destino)) {
      return reply.code(409).send(error(409, 'TRANSICION_INVALIDA',
        `No se puede pasar de ${pedido.estado} a ${destino}.`));
    }

    // Despachar es vender: se hace con POST /ventas indicando el pedido (descuenta stock y libera la reserva).
    if (destino === 'DESPACHADO') return reply.code(409).send(error(409, 'USA_DESPACHO', 'Despacha el pedido con "Despachar y vender".'));
    try {
      await tx(async (c) => {
        // Condicionado al estado leído: dos vendedores a la vez no pueden saltarse la máquina de estados.
        const cambio = await c.query(`UPDATE core.pedido SET estado = $1,
            motivo = CASE WHEN $1 IN ('RECHAZADO','CANCELADO') THEN $4 ELSE motivo END,
            confirmado_en = CASE WHEN $1 = 'CONFIRMADO' THEN now() ELSE confirmado_en END,
            entregado_en = CASE WHEN $1 = 'ENTREGADO' THEN now() ELSE entregado_en END,
            entrega_obs = CASE WHEN $1 = 'ENTREGADO' THEN $5 ELSE entrega_obs END
          WHERE id = $2 AND estado = $3 RETURNING id`, [destino, pedido.id, pedido.estado, motivo, observaciones]);
        if (!cambio.rowCount) throw Object.assign(new Error('Otro usuario cambió este pedido. Recarga e intenta de nuevo.'), { status: 409 });
        const lineas = (await c.query<{ producto_id: string; producto: string; cantidad: string }>(
          'SELECT producto_id, producto, sum(cantidad) cantidad FROM core.pedido_detalle WHERE pedido_id = $1 GROUP BY producto_id, producto ORDER BY producto_id', [pedido.id])).rows;
        if (destino === 'LISTO') {
          // RN-29 / APT-04: el pedido listo reserva su stock; queda fuera de la venta a terceros.
          for (const l of lineas) {
            const p = (await c.query<{ stock: string; reservado: string }>('SELECT stock, reservado FROM core.producto WHERE id = $1 FOR UPDATE', [l.producto_id])).rows[0];
            const disponible = num(p.stock) - num(p.reservado);
            if (disponible + 1e-6 < num(l.cantidad)) {
              throw Object.assign(new Error(`No hay stock para reservar ${l.producto}: disponible ${disponible.toFixed(0)}, pedido ${num(l.cantidad).toFixed(0)}.`), { status: 409 });
            }
            await c.query('UPDATE core.producto SET reservado = reservado + $2 WHERE id = $1', [l.producto_id, l.cantidad]);
          }
        }
        if (pedido.estado === 'LISTO' && destino === 'CANCELADO') {
          for (const l of lineas) await c.query('UPDATE core.producto SET reservado = greatest(reservado - $2, 0) WHERE id = $1', [l.producto_id, l.cantidad]);
        }
      });
    } catch (e) {
      const err = e as Error & { status?: number };
      if (!err.status) throw e;
      return reply.code(err.status).send(error(err.status, 'PEDIDO_INVALIDO', err.message));
    }
    await auditar({
      actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol,
      accion: `PEDIDO_${destino}`, entidad: 'pedido', entidadId: codigo,
      detalle: { de: pedido.estado, a: destino, cliente: pedido.cliente, motivo: motivo || undefined }, ip: req.ip,
    });
    void emitirEvento('pedido.estado', { codigo, de: pedido.estado, a: destino });
    // Los avisos al cliente y a cada área salen del historial del pedido (notificaciones.ts).
    return reply.send({ codigo, estadoAnterior: pedido.estado, estado: destino });
  });

  /* ------------------------------------------------ inventario: productos */
  // PDF §3.3: baja de producto terminado (merma, vencimiento) o devolución de un cliente.
  const MovProducto = z.object({
    productoId: z.string().uuid(),
    cantidad: z.number().positive().max(100_000),
    motivoTipo: z.enum(['MERMA', 'VENCIMIENTO', 'DEVOLUCION']),
    motivo: z.string().trim().min(3).max(200),
  });

  app.post('/inventario/productos', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'inventario.mover')) return;
    const parseo = MovProducto.safeParse(req.body);
    if (!parseo.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Revisa producto, cantidad y motivo (mínimo 3 caracteres).'));
    const m = parseo.data;
    const clave = req.headers['idempotency-key'] as string | undefined;
    try {
      const r = await conIdempotencia(clave, req.usuario!.id, 'inventario-prod', () =>
        tx(async (c) => {
          const p = (await c.query<{ nombre: string; stock: string; costo_unitario: string }>(
            'SELECT nombre, stock, costo_unitario FROM core.producto WHERE id = $1 FOR UPDATE', [m.productoId])).rows[0];
          if (!p) throw Object.assign(new Error('El producto no existe.'), { status: 404 });
          const delta = m.motivoTipo === 'DEVOLUCION' ? m.cantidad : -m.cantidad;
          const saldo = Number(p.stock) + delta;
          if (saldo < -0.000001) throw Object.assign(new Error(`Stock insuficiente de ${p.nombre} (disponible ${Number(p.stock).toFixed(2)}).`), { status: 409 });
          const costo = Number(p.costo_unitario);
          await c.query(
            `INSERT INTO core.movimiento_inventario
               (tipo,item_tipo,producto_id,documento,cantidad,costo_unitario,valor,saldo_cantidad,saldo_valor,cpp,idempotency_key,registrado_por,motivo_tipo)
             VALUES ($1,'PRODUCTO',$2,$3,$4,$5,$6,$7,$8,$5,$9,$10,$11)`,
            [m.motivoTipo === 'DEVOLUCION' ? 'DEVOLUCION' : 'MERMA', m.productoId, m.motivo, delta.toFixed(6), costo.toFixed(6),
              (delta * costo).toFixed(4), saldo.toFixed(6), (saldo * costo).toFixed(4), clave ?? null, req.usuario!.id, m.motivoTipo],
          );
          await c.query('UPDATE core.producto SET stock = $1 WHERE id = $2', [saldo.toFixed(6), m.productoId]);
          return { producto: p.nombre, tipo: m.motivoTipo, diferencia: delta, saldo: Number(saldo.toFixed(3)) };
        }),
      );
      invalidar('cat:');
      await auditar({
        actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol,
        accion: `INVENTARIO_PRODUCTO_${m.motivoTipo}`, entidad: 'producto', entidadId: m.productoId, detalle: m, ip: req.ip,
      });
      return reply.send(r);
    } catch (e) {
      const err = e as Error & { status?: number };
      if (!err.status) throw e;
      return reply.code(err.status).send(error(err.status, 'MOVIMIENTO_INVALIDO', err.message));
    }
  });

  /* ---------------------------------------------------------------- kárdex */
  /* --------------------------------------------------- inventario: insumos */
  // PDF 3.3: compra (actualiza el CPP), bajas con motivo y toma de inventario físico.
  const MovInsumo = z.discriminatedUnion('tipo', [
    z.object({ tipo: z.literal('MERMA'), insumoId: z.string().uuid(), cantidad: z.number().positive().max(1_000_000),
      motivoTipo: z.enum(['CONSUMO', 'MERMA', 'VENCIMIENTO', 'AJUSTE']).default('MERMA'),
      motivo: z.string().trim().min(3).max(200) }),
    z.object({ tipo: z.literal('CONTEO'), insumoId: z.string().uuid(), cantidadContada: z.number().min(0).max(1_000_000),
      motivo: z.string().trim().min(3).max(200) }),
  ]);

  app.post('/inventario/movimientos', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'inventario.mover')) return;
    // RN-06 (compra de insumos): el stock por compra solo ingresa al verificar la compra en Almacén.
    if ((req.body as { tipo?: unknown } | null)?.tipo === 'COMPRA') {
      return reply.code(422).send(error(422, 'USA_COMPRAS', 'Las compras se registran en Compras y el stock ingresa cuando Almacén las verifica.'));
    }
    const parseo = MovInsumo.safeParse(req.body);
    if (!parseo.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Revisa cantidad, costo y motivo (mínimo 3 caracteres).'));
    const m = parseo.data;
    // INF-TEC-001: las diferencias de conteo se ajustan solo con aprobación del Gerente (POST /conteos).
    if (m.tipo === 'CONTEO' && !req.usuario!.permisos.has('conteo.aprobar')) {
      return reply.code(403).send(error(403, 'REQUIERE_APROBACION', 'El ajuste por conteo requiere aprobación: regístralo en Conteo físico.'));
    }
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

          let tipo: 'MERMA' | 'AJUSTE';
          let delta: number;
          const costo = cpp;
          const nuevoCpp = cpp;
          if (m.tipo === 'MERMA') {
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
               (tipo,item_tipo,insumo_id,documento,cantidad,costo_unitario,valor,saldo_cantidad,saldo_valor,cpp,idempotency_key,registrado_por,motivo_tipo)
             VALUES ($1,'INSUMO',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [tipo, m.insumoId, m.motivo.slice(0, 200), delta.toFixed(6), costo.toFixed(6), valor.toFixed(4),
              nuevoSaldo.toFixed(6), (nuevoSaldo * nuevoCpp).toFixed(4), nuevoCpp.toFixed(6), clave ?? null, req.usuario!.id,
              m.tipo === 'MERMA' ? m.motivoTipo : m.tipo === 'CONTEO' ? 'AJUSTE' : null],
          );
          await c.query('UPDATE core.insumo SET stock = $1, cpp = $2, actualizado_en = now() WHERE id = $3',
            [nuevoSaldo.toFixed(6), nuevoCpp.toFixed(6), m.insumoId]);
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

  // Kárdex por insumo (INS-…) o producto (P…). Sin permiso de valorización, solo cantidades.
  app.get('/kardex/:codigo', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'inventario.ver')) return;
    const { codigo } = req.params as { codigo: string };
    if (!/^[A-Z0-9-]{1,20}$/.test(codigo)) return reply.code(422).send(error(422, 'CODIGO_INVALIDO', 'Código inválido.'));
    const filas = await q<Record<string, string>>(
      `SELECT * FROM (
         SELECT m.id, m.creado_en::text AS fecha, m.tipo, m.documento, m.cantidad, m.costo_unitario,
                m.valor, m.saldo_cantidad, m.saldo_valor, m.cpp, a.nombre AS almacen, m.lote, m.vence_en::text AS vence
         FROM core.movimiento_inventario m LEFT JOIN core.almacen a ON a.id = m.almacen_id
         -- Por id y no por código: así usa los índices de insumo_id / producto_id.
         WHERE m.insumo_id = (SELECT id FROM core.insumo WHERE codigo = $1)
            OR m.producto_id = (SELECT id FROM core.producto WHERE codigo = $1)
         ORDER BY m.id DESC LIMIT 1000
       ) x ORDER BY id`,
      [codigo],
    );
    const valoriza = req.usuario!.permisos.has('costos.ver') || req.usuario!.permisos.has('inventario.mover');
    return reply.send(filas.map((f) => ({
      fecha: f.fecha, tipo: f.tipo, documento: f.documento, almacen: f.almacen ?? '', lote: f.lote ?? '', vence: f.vence ?? '', cantidad: num(f.cantidad), saldoCantidad: num(f.saldo_cantidad),
      ...(valoriza ? { costoUnitario: num(f.costo_unitario), valor: num(f.valor), saldoValor: num(f.saldo_valor), cpp: num(f.cpp) } : {}),
    })));
  });
}
