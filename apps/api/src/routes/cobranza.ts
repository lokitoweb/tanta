import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, tx, uno, num, type Cliente } from '../db.js';
import { autenticar, exigir, error } from '../seguridad.js';
import { auditar } from '../auditoria.js';
import { emitirEvento } from './sistema.js';
import { avisar } from './notificaciones.js';
import { medioPago, exigirOperacion } from './catalogos.js';

/**
 * Cobranza y ventas del INF-TEC-001 (M07/M08): recibo aplicado a varios documentos (RN-34),
 * cierre del día (COB-09), estado de cuenta (COB-06), aprobación de descuentos (RN-36) y series (MAE-14).
 */

const fallo = (status: number, mensaje: string) => Object.assign(new Error(mensaje), { status });

const hoyLima = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
const Fecha = z.object({ fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

/* ------------------------------------------------------------- recibos */
// RN-34 / COB-05: un pago del cliente se aplica a los documentos elegidos o, si no se eligen,
// a los más antiguos primero. Nunca supera el saldo. Genera un recibo con correlativo (COB-08).
// Un pago puede venir en varias formas (p. ej. S/ 50 en efectivo + S/ 50 por Yape): «pagos».
export const LineaPago = z.object({
  monto: z.number({ message: 'Indica el monto de cada forma de pago' }).positive('Cada monto debe ser mayor que cero').max(10_000_000),
  medio: z.string().trim().toUpperCase().min(1, 'Elige la forma de pago').max(20),
  referencia: z.string().trim().max(60).default(''),
});
export type Pago = z.infer<typeof LineaPago>;

/**
 * Emite un recibo dentro de la transacción `c`: lo usan Cobranza (cobrar una deuda) y la entrega del
 * pedido (cobrar al dejar la mercadería). Un solo camino = un solo cálculo, el mismo cierre del día.
 */
export async function emitirRecibo(c: Cliente, d: { clienteId: string; cxcIds?: string[]; pagos: Pago[]; usuarioId: string; clave?: string }): Promise<string> {
  for (const x of d.pagos) exigirOperacion(await medioPago(c, x.medio, 'cobranza'), x.referencia);
  const monto = Number(d.pagos.reduce((s, x) => s + x.monto, 0).toFixed(2));
  // Documentos abiertos del cliente, del más antiguo al más nuevo, bloqueados para el cálculo.
  const docs = (await c.query<{ id: string; saldo: string }>(`SELECT id, saldo FROM core.cuenta_por_cobrar
      WHERE cliente_id = $1 AND estado IN ('PENDIENTE','PARCIAL') AND saldo > 0 AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
      ORDER BY vence_en, creado_en, id FOR UPDATE`, [d.clienteId, d.cxcIds ?? null])).rows;
  if (!docs.length) throw fallo(422, 'El cliente no tiene documentos por cobrar.');
  const total = docs.reduce((s, x) => s + num(x.saldo), 0);
  if (monto > total + 0.001) throw fallo(422, `El pago supera el saldo: el cliente debe S/ ${total.toFixed(2)}.`);
  const serie = (await c.query<{ serie: string; correlativo: number }>(`UPDATE core.serie_comprobante SET correlativo_actual = correlativo_actual + 1
      WHERE tipo = 'RECIBO' AND activo RETURNING serie, correlativo_actual AS correlativo`)).rows[0];
  if (!serie) throw fallo(409, 'No hay una serie activa de recibos: configúrala en Parámetros.');
  const numero = `${serie.serie}-${String(serie.correlativo).padStart(8, '0')}`;
  // El recibo guarda la forma principal (la de mayor monto); cada forma queda en su línea de cobranza,
  // así el cierre del día cuadra por forma de pago.
  const principal = d.pagos.reduce((a, b) => (b.monto > a.monto ? b : a));
  const rec = (await c.query<{ id: string }>(`INSERT INTO core.recibo (numero, cliente_id, monto, medio, referencia, registrado_por, idempotency_key)
      VALUES ($1,$2,$3,$4,NULLIF($5,''),$6,$7) RETURNING id`, [numero, d.clienteId, monto.toFixed(2), principal.medio,
      d.pagos.length > 1 ? d.pagos.map((x) => `${x.medio} ${x.monto.toFixed(2)}${x.referencia ? ` (${x.referencia})` : ''}`).join(' + ').slice(0, 200) : principal.referencia,
      d.usuarioId, d.clave ?? null])).rows[0];
  // Cada forma de pago se aplica a los documentos más antiguos que aún tienen saldo.
  const saldos = docs.map((x) => ({ id: x.id, saldo: num(x.saldo) }));
  for (const pago of d.pagos) {
    let resto = pago.monto;
    for (const doc of saldos) {
      if (resto <= 0.0001) break;
      if (doc.saldo <= 0.0001) continue;
      const aplica = Number(Math.min(resto, doc.saldo).toFixed(4));
      doc.saldo = Number((doc.saldo - aplica).toFixed(4));
      await c.query('UPDATE core.cuenta_por_cobrar SET saldo = $2, estado = $3 WHERE id = $1', [doc.id, doc.saldo.toFixed(4), doc.saldo <= 0.001 ? 'PAGADA' : 'PARCIAL']);
      await c.query(`INSERT INTO core.cobranza (cxc_id, monto, medio, referencia, registrado_por, recibo_id)
          VALUES ($1,$2,$3,NULLIF($4,''),$5,$6)`, [doc.id, aplica.toFixed(4), pago.medio, pago.referencia, d.usuarioId, rec.id]);
      resto = Number((resto - aplica).toFixed(4));
    }
  }
  return numero;
}

export async function detalleRecibo(numero: string) {
  const r = await uno<Record<string, string>>(`SELECT r.numero, r.monto, r.medio, r.referencia, r.creado_en::text fecha, c.nombre cliente, u.nombre vendedor
    FROM core.recibo r JOIN core.cliente c ON c.id = r.cliente_id LEFT JOIN core.usuario u ON u.id = r.registrado_por WHERE r.numero = $1`, [numero]);
  const ap = await q<Record<string, string>>(`SELECT coalesce(v.serie || '-' || lpad(v.correlativo::text, 8, '0'), v.codigo, 'Saldo') documento, b.monto, x.saldo
    FROM core.cobranza b JOIN core.recibo r ON r.id = b.recibo_id JOIN core.cuenta_por_cobrar x ON x.id = b.cxc_id LEFT JOIN core.venta v ON v.id = x.venta_id
    WHERE r.numero = $1 ORDER BY b.creado_en`, [numero]);
  const pagos = await q<Record<string, string>>(`SELECT b.medio, b.referencia, sum(b.monto) monto FROM core.cobranza b JOIN core.recibo r ON r.id = b.recibo_id
    WHERE r.numero = $1 GROUP BY b.medio, b.referencia ORDER BY sum(b.monto) DESC`, [numero]);
  return { ...r, monto: num(r!.monto), pagos: pagos.map((p) => ({ medio: p.medio, referencia: p.referencia, monto: num(p.monto) })),
    aplicaciones: ap.map((a) => ({ documento: a.documento, aplicado: num(a.monto), saldo: num(a.saldo) })) };
}

/* ------------------------------------------------- caja del vendedor (día) */
// Cada día empieza en cero: lo cobrado se agrupa por fecha (hora de Lima) y por quien lo registró.
// El vendedor rinde su día y la persona encargada de caja lo recibe (sin abrir ni cerrar caja a mano).
export async function resumenDia(fecha: string, vendedorId?: string) {
  const filas = await q<Record<string, string>>(`
    SELECT b.registrado_por vendedor_id, coalesce(u.nombre, '—') vendedor, b.medio, count(*) pagos, sum(b.monto) monto
    FROM core.cobranza b LEFT JOIN core.usuario u ON u.id = b.registrado_por
    WHERE (b.creado_en AT TIME ZONE 'America/Lima')::date = $1::date AND ($2::uuid IS NULL OR b.registrado_por = $2)
    GROUP BY b.registrado_por, u.nombre, b.medio ORDER BY u.nombre, b.medio`, [fecha, vendedorId ?? null]);
  const rend = await q<Record<string, string>>(`SELECT r.id, r.vendedor_id, coalesce(u.nombre, '—') vendedor, r.esperado, r.total, r.efectivo_esperado, r.efectivo_entregado, r.nota, r.estado,
      r.efectivo_recibido, r.nota_caja, r.recibido_en::text, x.nombre recibido_por, r.actualizado_en::text
    FROM core.rendicion_cobranza r LEFT JOIN core.usuario u ON u.id = r.vendedor_id LEFT JOIN core.usuario x ON x.id = r.recibido_por
    WHERE r.fecha = $1::date AND ($2::uuid IS NULL OR r.vendedor_id = $2)`, [fecha, vendedorId ?? null]);
  const porVendedor = new Map<string, { vendedorId: string; vendedor: string; porMedio: Record<string, number>; pagos: number }>();
  for (const f of filas) {
    const v = porVendedor.get(f.vendedor_id) ?? { vendedorId: f.vendedor_id, vendedor: f.vendedor, porMedio: {}, pagos: 0 };
    v.porMedio[f.medio] = Number(num(f.monto).toFixed(2));
    v.pagos += num(f.pagos);
    porVendedor.set(f.vendedor_id, v);
  }
  for (const r of rend) if (!porVendedor.has(r.vendedor_id)) porVendedor.set(r.vendedor_id, { vendedorId: r.vendedor_id, vendedor: r.vendedor, porMedio: {}, pagos: 0 });
  return [...porVendedor.values()].map((v) => {
    const total = Number(Object.values(v.porMedio).reduce((s, x) => s + x, 0).toFixed(2));
    const r = rend.find((x) => x.vendedor_id === v.vendedorId);
    const rendicion = r ? {
      id: r.id, estado: r.estado, total: num(r.total), efectivoEsperado: num(r.efectivo_esperado), efectivoEntregado: num(r.efectivo_entregado),
      efectivoRecibido: r.efectivo_recibido === null ? null : num(r.efectivo_recibido), nota: r.nota, notaCaja: r.nota_caja,
      recibidoPor: r.recibido_por, recibidoEn: r.recibido_en, actualizadoEn: r.actualizado_en,
      // Diferencia de caja: lo que entregó (o lo que recibió caja) contra el efectivo cobrado.
      diferencia: Number(((r.efectivo_recibido === null ? num(r.efectivo_entregado) : num(r.efectivo_recibido)) - num(r.efectivo_esperado)).toFixed(2)),
      // Cobros registrados después de rendir: hay que volver a rendir (o caja los ve aparte).
      desactualizada: Math.abs(num(r.total) - total) > 0.009,
    } : null;
    return { ...v, total, efectivo: v.porMedio.EFECTIVO ?? 0, rendicion };
  });
}

export async function rutasCobranza(app: FastifyInstance) {
  const NuevoRecibo = z.object({
    clienteId: z.string().uuid(),
    monto: z.number().positive().max(10_000_000).optional(),
    medio: z.string().trim().toUpperCase().max(20).optional(),
    referencia: z.string().trim().max(60).default(''),
    pagos: z.array(LineaPago).min(1).max(5).optional(),
    cxcIds: z.array(z.string().uuid()).max(100).optional(),
  }).transform((d, ctx) => {
    // «monto/medio/referencia» sueltos = una sola forma (versiones anteriores de la app).
    const pagos = d.pagos ?? (d.monto && d.medio ? [{ monto: d.monto, medio: d.medio, referencia: d.referencia }] : []);
    if (!pagos.length) ctx.addIssue({ code: 'custom', message: 'Indica el monto y la forma de pago.' });
    return { clienteId: d.clienteId, cxcIds: d.cxcIds, pagos, monto: Number(pagos.reduce((s, x) => s + x.monto, 0).toFixed(2)) };
  });

  app.post('/cobranza/recibos', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'cobranza.registrar')) return;
    const p = NuevoRecibo.safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues[0]?.message ?? 'Pago inválido.'));
    const d = p.data;
    const clave = req.headers['idempotency-key'] as string | undefined;
    if (clave) {
      const previo = await uno<{ numero: string }>('SELECT numero FROM core.recibo WHERE idempotency_key = $1', [clave]);
      if (previo) return reply.code(201).send(await detalleRecibo(previo.numero));
    }
    try {
      const numero = await tx((c) => emitirRecibo(c, { ...d, usuarioId: req.usuario!.id, clave }));
      const r = await detalleRecibo(numero);
      await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'RECIBO_EMITIDO', entidad: 'recibo', entidadId: numero, detalle: { monto: d.monto, pagos: d.pagos.map((x) => ({ medio: x.medio, monto: x.monto })), documentos: r.aplicaciones.length }, ip: req.ip });
      void emitirEvento('cobro.registrado', r);
      return reply.code(201).send(r);
    } catch (e) {
      const err = e as Error & { status?: number };
      if (!err.status) throw e;
      return reply.code(err.status).send(error(err.status, 'COBRO_INVALIDO', err.message));
    }
  });

  /* ---------------------------------------------- mi día y rendición de caja */
  // El vendedor ve lo que cobró hoy (por forma de pago y por recibo) y lo que dejó como deuda al entregar.
  app.get('/cobranza/mi-dia', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'cobranza.registrar')) return;
    const p = Fecha.safeParse(req.query);
    const fecha = (p.success && p.data.fecha) || hoyLima();
    const yo = req.usuario!.id;
    const resumen = (await resumenDia(fecha, yo))[0] ?? { porMedio: {}, total: 0, efectivo: 0, pagos: 0, rendicion: null };
    const cobros = await q<Record<string, string>>(`SELECT coalesce(r.numero, '—') recibo, c.nombre cliente, b.medio, b.referencia, sum(b.monto) monto,
        to_char(min(b.creado_en) AT TIME ZONE 'America/Lima', 'HH24:MI') hora
      FROM core.cobranza b JOIN core.cuenta_por_cobrar x ON x.id = b.cxc_id JOIN core.cliente c ON c.id = x.cliente_id LEFT JOIN core.recibo r ON r.id = b.recibo_id
      WHERE b.registrado_por = $1 AND (b.creado_en AT TIME ZONE 'America/Lima')::date = $2::date
      GROUP BY r.numero, c.nombre, b.medio, b.referencia ORDER BY min(b.creado_en) DESC`, [yo, fecha]);
    // Entregas del día: cuánto se cobró en el momento y cuánto quedó por cobrar.
    const entregas = await q<Record<string, string>>(`SELECT p.codigo, p.cliente, p.total, coalesce(x.saldo, 0) saldo
      FROM core.pedido p LEFT JOIN core.venta v ON v.pedido_id = p.id AND v.estado = 'CONFIRMADA' LEFT JOIN core.cuenta_por_cobrar x ON x.venta_id = v.id
      WHERE p.entregado_por = $1 AND (p.entregado_en AT TIME ZONE 'America/Lima')::date = $2::date ORDER BY p.entregado_en DESC`, [yo, fecha]);
    return {
      fecha, ...resumen,
      cobros: cobros.map((x) => ({ ...x, monto: num(x.monto) })),
      entregas: entregas.map((x) => ({ codigo: x.codigo, cliente: x.cliente, total: num(x.total), quedaPorCobrar: num(x.saldo) })),
    };
  });

  // Rendir el día: el servidor calcula lo esperado (nadie lo escribe a mano); el vendedor declara el efectivo que entrega.
  app.post('/cobranza/rendiciones', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'cobranza.registrar')) return;
    const p = z.object({ fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), efectivoEntregado: z.number({ message: 'Indica el efectivo que entregas' }).min(0).max(10_000_000),
      nota: z.string().trim().max(300).default('') }).safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues[0]?.message ?? 'Rendición inválida.'));
    const fecha = p.data.fecha ?? hoyLima();
    if (fecha > hoyLima()) return reply.code(422).send(error(422, 'FECHA_FUTURA', 'No se puede rendir un día que aún no llega.'));
    const r = (await resumenDia(fecha, req.usuario!.id))[0];
    if (!r || r.total <= 0) return reply.code(422).send(error(422, 'SIN_COBROS', 'No tienes cobros registrados ese día.'));
    const fila = await uno<{ id: string; estado: string }>(`INSERT INTO core.rendicion_cobranza (vendedor_id, fecha, esperado, total, efectivo_esperado, efectivo_entregado, nota)
      VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,''))
      ON CONFLICT (vendedor_id, fecha) DO UPDATE SET esperado = EXCLUDED.esperado, total = EXCLUDED.total, efectivo_esperado = EXCLUDED.efectivo_esperado,
        efectivo_entregado = EXCLUDED.efectivo_entregado, nota = EXCLUDED.nota, actualizado_en = now()
        WHERE core.rendicion_cobranza.estado = 'PENDIENTE'
      RETURNING id, estado`, [req.usuario!.id, fecha, JSON.stringify(r.porMedio), r.total.toFixed(2), r.efectivo.toFixed(2), p.data.efectivoEntregado.toFixed(2), p.data.nota]);
    if (!fila) return reply.code(409).send(error(409, 'YA_RECIBIDA', 'Caja ya recibió tu rendición de ese día.'));
    await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'RENDICION_ENVIADA', entidad: 'rendicion_cobranza', entidadId: fila.id,
      detalle: { fecha, total: r.total, efectivo: r.efectivo, entregado: p.data.efectivoEntregado }, ip: req.ip });
    const dif = p.data.efectivoEntregado - r.efectivo;
    avisar([{ permiso: 'caja.rendiciones' }], { tipo: 'cobranza', titulo: `Rendición de ${req.usuario!.nombre}`,
      cuerpo: `${fecha} · cobró S/ ${r.total.toFixed(2)} · entrega S/ ${p.data.efectivoEntregado.toFixed(2)} en efectivo${Math.abs(dif) > 0.009 ? ` (diferencia S/ ${dif.toFixed(2)})` : ''}`, ruta: '/ventas/cobranza' });
    return reply.code(201).send({ id: fila.id, estado: fila.estado, fecha, ...r });
  });

  // La persona encargada de caja confirma lo que recibió; la diferencia queda registrada.
  app.post('/cobranza/rendiciones/:id/recibir', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'caja.rendiciones')) return;
    const { id } = req.params as { id: string };
    const p = z.object({ efectivoRecibido: z.number({ message: 'Indica el efectivo recibido' }).min(0).max(10_000_000), nota: z.string().trim().max(300).default('') }).safeParse(req.body);
    if (!p.success || !z.string().uuid().safeParse(id).success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.success ? 'Rendición inválida.' : p.error.issues[0]?.message ?? 'Datos inválidos.'));
    const r = await uno<{ fecha: string; vendedor_id: string; efectivo_esperado: string }>(`UPDATE core.rendicion_cobranza SET estado = 'RECIBIDA', efectivo_recibido = $2, nota_caja = NULLIF($3,''),
        recibido_por = $4, recibido_en = now(), actualizado_en = now()
      WHERE id = $1 AND estado = 'PENDIENTE' RETURNING fecha::text, vendedor_id, efectivo_esperado`, [id, p.data.efectivoRecibido.toFixed(2), p.data.nota, req.usuario!.id]);
    if (!r) return reply.code(409).send(error(409, 'YA_RECIBIDA', 'La rendición no existe o ya fue recibida.'));
    const dif = Number((p.data.efectivoRecibido - num(r.efectivo_esperado)).toFixed(2));
    await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'RENDICION_RECIBIDA', entidad: 'rendicion_cobranza', entidadId: id,
      detalle: { fecha: r.fecha, recibido: p.data.efectivoRecibido, diferencia: dif }, ip: req.ip });
    avisar([{ usuarioId: r.vendedor_id }], { tipo: 'cobranza', titulo: 'Rendición recibida',
      cuerpo: `Caja recibió tu rendición del ${r.fecha}: S/ ${p.data.efectivoRecibido.toFixed(2)} en efectivo${Math.abs(dif) > 0.009 ? ` · diferencia S/ ${dif.toFixed(2)}` : ' · cuadra'}.`, ruta: '/ventas/cobranza' });
    return { id, estado: 'RECIBIDA', diferencia: dif };
  });

  app.get('/cobranza/recibos/:numero', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'cobranza.ver')) return;
    const { numero } = req.params as { numero: string };
    if (!(await uno('SELECT 1 FROM core.recibo WHERE numero = $1', [numero]))) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'El recibo no existe.'));
    return detalleRecibo(numero);
  });

  /* ----------------------------------------------------- cierre del día */
  // COB-09: total por forma de pago y por vendedor; suma exactamente los pagos del día.
  app.get('/cobranza/cierre', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'cobranza.ver')) return;
    const p = Fecha.safeParse(req.query);
    const fecha = (p.success && p.data.fecha) || hoyLima();
    const filas = await q<Record<string, string>>(`
      SELECT b.medio, coalesce(u.nombre, '—') vendedor, count(*) pagos, sum(b.monto) monto
      FROM core.cobranza b LEFT JOIN core.usuario u ON u.id = b.registrado_por
      WHERE (b.creado_en AT TIME ZONE 'America/Lima')::date = $1::date
      GROUP BY b.medio, u.nombre ORDER BY b.medio, u.nombre`, [fecha]);
    const lineas = filas.map((f) => ({ medio: f.medio, vendedor: f.vendedor, pagos: num(f.pagos), monto: num(f.monto) }));
    const porMedio = Object.entries(lineas.reduce<Record<string, number>>((a, l) => ({ ...a, [l.medio]: (a[l.medio] ?? 0) + l.monto }), {})).map(([medio, monto]) => ({ medio, monto }));
    // Días anteriores (30) con cobros que caja aún no recibe: no se pierden aunque no se rindan a tiempo.
    const pendientes = await q<Record<string, string>>(`
      SELECT d.fecha::text, d.registrado_por vendedor_id, coalesce(u.nombre, '—') vendedor, d.total, r.estado
      FROM (SELECT (b.creado_en AT TIME ZONE 'America/Lima')::date fecha, b.registrado_por, sum(b.monto) total FROM core.cobranza b
            WHERE b.creado_en > now() - interval '31 days' GROUP BY 1, 2) d
      LEFT JOIN core.rendicion_cobranza r ON r.vendedor_id = d.registrado_por AND r.fecha = d.fecha
      LEFT JOIN core.usuario u ON u.id = d.registrado_por
      WHERE d.fecha < $1::date AND coalesce(r.estado, 'SIN_RENDIR') <> 'RECIBIDA' ORDER BY d.fecha DESC, u.nombre LIMIT 60`, [fecha]);
    return { fecha, total: lineas.reduce((s, l) => s + l.monto, 0), porMedio, lineas, vendedores: await resumenDia(fecha),
      pendientes: pendientes.map((x) => ({ fecha: x.fecha, vendedorId: x.vendedor_id, vendedor: x.vendedor, total: num(x.total), estado: x.estado ?? 'SIN_RENDIR' })) };
  });

  /* ------------------------------------------------------- estado de cuenta */
  // COB-06 / V-03: documentos, pagos y saldo. El cliente solo ve el suyo.
  app.get('/estado-cuenta', { preHandler: autenticar }, async (req, reply) => {
    const yo = await uno<{ cliente_id: string | null }>('SELECT cliente_id FROM core.usuario WHERE id = $1', [req.usuario!.id]);
    const pedido = z.object({ clienteId: z.string().uuid().optional() }).safeParse(req.query);
    const clienteId = yo?.cliente_id ?? (pedido.success ? pedido.data.clienteId : undefined);
    if (!clienteId) return reply.code(422).send(error(422, 'SIN_CLIENTE', 'Elige el cliente.'));
    if (!yo?.cliente_id && !req.usuario!.permisos.has('cobranza.ver')) return reply.code(403).send(error(403, 'SIN_PERMISO', 'Falta el permiso cobranza.ver.'));
    const cli = await uno<Record<string, string>>('SELECT nombre, doc_tipo, doc_numero, condicion_pago, limite_credito, dias_credito FROM core.cliente WHERE id = $1', [clienteId]);
    if (!cli) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'El cliente no existe.'));
    const documentos = await q<Record<string, string>>(`
      SELECT coalesce(v.serie || '-' || lpad(v.correlativo::text, 8, '0'), v.codigo, 'Documento') documento, (x.creado_en AT TIME ZONE 'America/Lima')::date::text fecha,
             x.vence_en::text vence, x.monto, x.monto - x.saldo pagado, x.saldo, x.estado, CASE WHEN x.saldo > 0 THEN greatest(current_date - x.vence_en, 0) ELSE 0 END dias_vencido
      FROM core.cuenta_por_cobrar x LEFT JOIN core.venta v ON v.id = x.venta_id
      WHERE x.cliente_id = $1 AND x.estado <> 'ANULADA' ORDER BY x.creado_en DESC LIMIT 300`, [clienteId]);
    const pagos = await q<Record<string, string>>(`
      SELECT coalesce(r.numero, '—') recibo, (b.creado_en AT TIME ZONE 'America/Lima')::date::text fecha, b.medio, b.referencia, b.monto
      FROM core.cobranza b JOIN core.cuenta_por_cobrar x ON x.id = b.cxc_id LEFT JOIN core.recibo r ON r.id = b.recibo_id
      WHERE x.cliente_id = $1 ORDER BY b.creado_en DESC LIMIT 300`, [clienteId]);
    const doc = documentos.map((x) => ({ documento: x.documento, fecha: x.fecha, vence: x.vence, monto: num(x.monto), pagado: num(x.pagado), saldo: num(x.saldo), estado: x.estado, diasVencido: num(x.dias_vencido) }));
    return {
      cliente: { nombre: cli.nombre, documento: `${cli.doc_tipo} ${cli.doc_numero ?? ''}`.trim(), condicion: cli.condicion_pago, limiteCredito: num(cli.limite_credito), diasCredito: num(cli.dias_credito) },
      saldo: doc.reduce((s, x) => s + x.saldo, 0), vencido: doc.filter((x) => x.diasVencido > 0).reduce((s, x) => s + x.saldo, 0),
      documentos: doc, pagos: pagos.map((x) => ({ ...x, monto: num(x.monto) })),
    };
  });

  /* --------------------------------------------------- descuentos (RN-36) */
  const Solicitud = z.object({ porcentaje: z.number().positive().max(0.9), motivo: z.string().trim().min(5).max(200), clienteId: z.string().uuid().optional() });

  app.post('/descuentos/solicitudes', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'ventas.registrar')) return;
    const p = Solicitud.safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Indica el porcentaje y el motivo (mínimo 5 caracteres).'));
    const tope = num((await uno<{ valor: string }>("SELECT valor FROM core.parametro WHERE clave = 'descuento_maximo'"))?.valor ?? '0');
    if (p.data.porcentaje <= tope + 1e-9) return reply.code(422).send(error(422, 'SIN_APROBACION', `Hasta ${Math.round(tope * 100)} % no necesita aprobación.`));
    const r = await uno<{ id: string }>('INSERT INTO core.descuento_aprobacion (solicitado_por, cliente_id, porcentaje, motivo) VALUES ($1,$2,$3,$4) RETURNING id',
      [req.usuario!.id, p.data.clienteId ?? null, p.data.porcentaje, p.data.motivo]);
    await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'DESCUENTO_SOLICITADO', entidad: 'descuento_aprobacion', entidadId: r!.id, detalle: p.data, ip: req.ip });
    avisar([{ permiso: 'descuentos.aprobar' }], { tipo: 'descuento', titulo: 'Descuento por aprobar', cuerpo: `${req.usuario!.nombre} pide ${Math.round(p.data.porcentaje * 100)} %: ${p.data.motivo}`, ruta: '/ventas/aprobaciones' });
    return reply.code(201).send({ id: r!.id, estado: 'PENDIENTE' });
  });

  app.get('/descuentos/solicitudes', { preHandler: autenticar }, async (req, reply) => {
    const aprueba = req.usuario!.permisos.has('descuentos.aprobar');
    if (!aprueba && !req.usuario!.permisos.has('ventas.registrar')) return reply.code(403).send(error(403, 'SIN_PERMISO', 'Sin permiso.'));
    const filas = await q<Record<string, string>>(`
      SELECT a.id, a.porcentaje, a.motivo, a.estado, a.creado_en::text, a.expira_en::text, u.nombre solicitante, c.nombre cliente, r.nombre resuelto_por
      FROM core.descuento_aprobacion a JOIN core.usuario u ON u.id = a.solicitado_por
      LEFT JOIN core.cliente c ON c.id = a.cliente_id LEFT JOIN core.usuario r ON r.id = a.resuelto_por
      WHERE ($1 OR a.solicitado_por = $2) AND a.creado_en > now() - interval '30 days'
      ORDER BY (a.estado = 'PENDIENTE') DESC, a.creado_en DESC LIMIT 200`, [aprueba, req.usuario!.id]);
    return filas.map((f) => ({ ...f, porcentaje: num(f.porcentaje), vigente: f.estado === 'APROBADA' && Date.parse(f.expira_en) > Date.now() }));
  });

  app.post('/descuentos/solicitudes/:id/resolver', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'descuentos.aprobar')) return;
    const { id } = req.params as { id: string };
    const p = z.object({ aprobar: z.boolean() }).safeParse(req.body);
    if (!p.success || !z.string().uuid().safeParse(id).success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Solicitud inválida.'));
    const r = await uno<{ solicitado_por: string; porcentaje: string }>(`UPDATE core.descuento_aprobacion SET estado = $2, resuelto_por = $3, resuelto_en = now(), expira_en = now() + interval '24 hours'
      WHERE id = $1 AND estado = 'PENDIENTE' RETURNING solicitado_por, porcentaje`, [id, p.data.aprobar ? 'APROBADA' : 'RECHAZADA', req.usuario!.id]);
    if (!r) return reply.code(409).send(error(409, 'YA_RESUELTA', 'La solicitud ya fue resuelta.'));
    await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: p.data.aprobar ? 'DESCUENTO_APROBADO' : 'DESCUENTO_RECHAZADO', entidad: 'descuento_aprobacion', entidadId: id, detalle: { porcentaje: num(r.porcentaje) }, ip: req.ip });
    avisar([{ usuarioId: r.solicitado_por }], { tipo: 'descuento', titulo: 'Descuento', cuerpo: `Tu descuento de ${Math.round(num(r.porcentaje) * 100)} % fue ${p.data.aprobar ? 'aprobado (24 h)' : 'rechazado'}`, ruta: '/ventas/pedidos' });
    return { id, estado: p.data.aprobar ? 'APROBADA' : 'RECHAZADA' };
  });

  /* ---------------------------------------------------- series (MAE-14) */
  app.get('/series', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'parametros.gestionar')) return;
    return (await q<Record<string, string>>('SELECT tipo, serie, correlativo_actual, activo FROM core.serie_comprobante ORDER BY tipo, serie'))
      .map((s) => ({ ...s, correlativoActual: num(s.correlativo_actual) }));
  });

  // Una serie nueva pasa a ser la activa de su tipo; la anterior queda en el historial (no se reutiliza).
  app.post('/series', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'parametros.gestionar')) return;
    const p = z.object({ tipo: z.enum(['NOTA_VENTA', 'RECIBO']), serie: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4}$/, 'La serie tiene 4 letras o números') }).safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues[0]?.message ?? 'Serie inválida.'));
    try {
      await tx(async (c) => {
        if ((await c.query('SELECT 1 FROM core.serie_comprobante WHERE tipo = $1 AND serie = $2', [p.data.tipo, p.data.serie])).rowCount) throw fallo(409, 'Esa serie ya existe: no se reutiliza.');
        await c.query('UPDATE core.serie_comprobante SET activo = false WHERE tipo = $1', [p.data.tipo]);
        await c.query('INSERT INTO core.serie_comprobante (tipo, serie) VALUES ($1,$2)', [p.data.tipo, p.data.serie]);
      });
    } catch (e) {
      const err = e as Error & { status?: number };
      if (!err.status) throw e;
      return reply.code(err.status).send(error(err.status, 'SERIE_INVALIDA', err.message));
    }
    await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'SERIE_CREADA', entidad: 'serie_comprobante', entidadId: p.data.serie, detalle: p.data, ip: req.ip });
    return reply.code(201).send({ ...p.data, activo: true });
  });
}

/**
 * COB-10: avisa al vendedor del cliente y a Gerencia de los documentos por cobrar vencidos:
 * el día del vencimiento y luego cada 7 días mientras quede saldo. SKIP LOCKED: con varias
 * instancias del API cada aviso sale una sola vez.
 */
export async function despacharAlertasCobranza(): Promise<number> {
  const filas = await tx(async (c) => (await c.query<{ cliente: string; vendedor_id: string | null; saldo: string; dias: number; doc: string }>(`
    UPDATE core.cuenta_por_cobrar x SET alerta_en = (now() AT TIME ZONE 'America/Lima')::date
    FROM core.cliente cl
    WHERE x.id IN (SELECT id FROM core.cuenta_por_cobrar
        WHERE estado IN ('PENDIENTE','PARCIAL') AND saldo > 0 AND vence_en <= (now() AT TIME ZONE 'America/Lima')::date
          AND (alerta_en IS NULL OR alerta_en <= (now() AT TIME ZONE 'America/Lima')::date - 7)
        ORDER BY id LIMIT 1000 FOR UPDATE SKIP LOCKED)
      AND cl.id = x.cliente_id
    RETURNING cl.nombre cliente, cl.vendedor_id, x.saldo,
      (now() AT TIME ZONE 'America/Lima')::date - x.vence_en dias,
      coalesce((SELECT v.codigo FROM core.venta v WHERE v.id = x.venta_id), 'documento') doc`)).rows);
  // Un resumen por destinatario y ronda: con muchas deudas vencidas no se inunda la campana.
  const resumen = (xs: typeof filas) => {
    const f = xs[0];
    const total = xs.reduce((t, x) => t + num(x.saldo), 0);
    const clientes = [...new Set(xs.map((x) => x.cliente))];
    return xs.length === 1
      ? { tipo: 'cobranza', ruta: '/ventas/cobranza', titulo: `Deuda vencida: ${f.cliente}`,
          cuerpo: `${f.doc}: S/ ${num(f.saldo).toFixed(2)} ${f.dias === 0 ? 'vence hoy' : `vencido hace ${f.dias} día(s)`}` }
      : { tipo: 'cobranza', ruta: '/ventas/cobranza', titulo: `${xs.length} deudas vencidas por cobrar`,
          cuerpo: `S/ ${total.toFixed(2)} · ${clientes.slice(0, 3).join(', ')}${clientes.length > 3 ? ` y ${clientes.length - 3} más` : ''}` };
  };
  if (filas.length) avisar([{ permiso: 'dashboard.ver' }], resumen(filas));
  const porVendedor = new Map<string, typeof filas>();
  for (const f of filas) if (f.vendedor_id) porVendedor.set(f.vendedor_id, [...(porVendedor.get(f.vendedor_id) ?? []), f]);
  for (const [vendedor, xs] of porVendedor) avisar([{ usuarioId: vendedor }], resumen(xs));
  return filas.length;
}
