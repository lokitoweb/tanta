import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { q, tx, uno, num } from '../db.js';
import { autenticar, exigir, error } from '../seguridad.js';
import { auditar } from '../auditoria.js';
import { notificar } from './notificaciones.js';
import { actor, fallo, responder } from './almacen.js';

/**
 * Deudas por pagar y cajas (informe de compra de insumos v1.1, secciones 3.2, 5.5 y RN-10 a RN-13).
 * Saldo de una compra = total − pagos vigentes. Caja chica: apertura del vendedor; saldo disponible =
 * monto inicial − pagos vigentes contra esa apertura.
 */

/** Saldo disponible de una apertura de caja chica. */
const saldoCaja = async (c: PoolClient | null, aperturaId: string) => {
  const sql = `SELECT a.monto_inicial - coalesce((SELECT sum(p.monto) FROM core.pago_compra p WHERE p.apertura_id = a.id AND p.estado = 'VIGENTE'), 0) saldo
    FROM core.caja_apertura a WHERE a.id = $1`;
  return num((c ? (await c.query<{ saldo: string }>(sql, [aperturaId])).rows[0] : await uno<{ saldo: string }>(sql, [aperturaId]))?.saldo ?? '0');
};

/** Recalcula el estado del pago de la compra (3.2). */
export async function actualizarEstadoPago(c: PoolClient, compraId: string) {
  await c.query(`UPDATE core.compra k SET estado_pago = CASE WHEN x.pagado <= 0 THEN 'PENDIENTE' WHEN x.pagado + 0.005 >= k.total THEN 'PAGADO' ELSE 'PARCIAL' END
    FROM (SELECT coalesce(sum(monto), 0) pagado FROM core.pago_compra WHERE compra_id = $1 AND estado = 'VIGENTE') x WHERE k.id = $1`, [compraId]);
}

/** RN-09: al anular una compra, sus pagos vigentes pasan a ANULADO (el dinero vuelve a su caja). */
export async function anularPagosDeCompra(c: PoolClient, compraId: string, usuarioId: string, motivo: string) {
  const r = await c.query(`UPDATE core.pago_compra SET estado = 'ANULADO', anulado_por = $2, anulado_en = now(), motivo_anulacion = $3
    WHERE compra_id = $1 AND estado = 'VIGENTE' RETURNING id`, [compraId, usuarioId, `Compra anulada: ${motivo}`.slice(0, 300)]);
  await actualizarEstadoPago(c, compraId);
  return r.rowCount ?? 0;
}

export async function rutasPagos(app: FastifyInstance) {
  /* --------------------------------------------------------------- caja chica */
  app.get('/cajas/chica', { preHandler: autenticar }, async (req, reply) => {
    if (!['caja.abrir', 'compras.pagar'].some((x) => req.usuario!.permisos.has(x))) return reply.code(403).send(error(403, 'SIN_PERMISO', 'Falta el permiso caja.abrir.'));
    const filas = await q<Record<string, string>>(`
      SELECT a.id, a.codigo, a.estado, a.monto_inicial, a.abierta_en::text abierta_en, a.cerrada_en::text cerrada_en, a.monto_contado, a.observacion,
             ua.nombre abierta_por, uc.nombre cerrada_por,
             coalesce((SELECT sum(p.monto) FROM core.pago_compra p WHERE p.apertura_id = a.id AND p.estado = 'VIGENTE'), 0) pagado,
             coalesce((SELECT json_agg(json_build_object('codigo', p.codigo, 'compra', k.codigo, 'proveedor', pr.razon_social, 'monto', p.monto,
               'fecha', p.fecha_pago, 'estado', p.estado) ORDER BY p.fecha_pago DESC)
               FROM core.pago_compra p JOIN core.compra k ON k.id = p.compra_id JOIN core.proveedor pr ON pr.id = k.proveedor_id WHERE p.apertura_id = a.id), '[]') pagos
      FROM core.caja_apertura a JOIN core.usuario ua ON ua.id = a.abierta_por LEFT JOIN core.usuario uc ON uc.id = a.cerrada_por
      ORDER BY a.abierta_en DESC LIMIT 30`);
    const lista = filas.map((f) => ({
      id: f.id, codigo: f.codigo, estado: f.estado, montoInicial: num(f.monto_inicial), pagado: num(f.pagado), saldo: num(f.monto_inicial) - num(f.pagado),
      abiertaEn: f.abierta_en, abiertaPor: f.abierta_por, cerradaEn: f.cerrada_en, cerradaPor: f.cerrada_por,
      montoContado: f.monto_contado === null ? null : num(f.monto_contado), observacion: f.observacion,
      pagos: (f.pagos as unknown as Array<Record<string, string>>).map((p) => ({ ...p, monto: num(p.monto) })),
    }));
    return { abierta: lista.find((a) => a.estado === 'ABIERTA') ?? null, historial: lista };
  });

  // El vendedor abre la caja chica con su monto inicial (5.6). Solo una abierta a la vez.
  app.post('/cajas/chica/abrir', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'caja.abrir')) return;
    const p = z.object({ montoInicial: z.number().positive().max(1_000_000) }).safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Indica el monto inicial (mayor a cero).'));
    return responder(reply, 'CAJA_INVALIDA', async () => {
      const r = await tx(async (c) => {
        if ((await c.query(`SELECT 1 FROM core.caja_apertura WHERE tipo = 'CHICA' AND estado = 'ABIERTA'`)).rowCount) throw fallo(409, 'Ya hay una caja chica abierta: ciérrala antes de abrir otra.');
        const codigo = `CCH-${String(num((await c.query<{ n: string }>(`SELECT coalesce(max(substring(codigo from 5)::int), 0) + 1 n FROM core.caja_apertura WHERE codigo ~ '^CCH-[0-9]+$'`)).rows[0].n)).padStart(5, '0')}`;
        await c.query('INSERT INTO core.caja_apertura (codigo, monto_inicial, abierta_por) VALUES ($1,$2,$3)', [codigo, p.data.montoInicial.toFixed(2), req.usuario!.id]);
        return codigo;
      });
      await auditar({ ...actor(req), accion: 'CAJA_CHICA_ABIERTA', entidad: 'caja_apertura', entidadId: r, detalle: p.data });
      return reply.code(201).send({ codigo: r, estado: 'ABIERTA', montoInicial: p.data.montoInicial, saldo: p.data.montoInicial });
    });
  });

  // Cierre: se registra lo contado y la diferencia contra el saldo esperado.
  app.post('/cajas/chica/:codigo/cerrar', { preHandler: autenticar }, async (req, reply) => {
    if (!['caja.abrir', 'compras.pagar'].some((x) => req.usuario!.permisos.has(x))) return reply.code(403).send(error(403, 'SIN_PERMISO', 'Falta el permiso caja.abrir.'));
    const { codigo } = req.params as { codigo: string };
    const p = z.object({ montoContado: z.number().min(0).max(1_000_000), observacion: z.string().trim().max(200).default('') }).safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Indica el efectivo contado.'));
    return responder(reply, 'CAJA_INVALIDA', async () => {
      const r = await tx(async (c) => {
        const a = (await c.query<{ id: string }>(`SELECT id FROM core.caja_apertura WHERE codigo = $1 AND estado = 'ABIERTA' FOR UPDATE`, [codigo])).rows[0];
        if (!a) throw fallo(409, 'La caja no está abierta.');
        const esperado = await saldoCaja(c, a.id);
        await c.query(`UPDATE core.caja_apertura SET estado = 'CERRADA', cerrada_por = $2, cerrada_en = now(), monto_contado = $3, observacion = NULLIF($4,'') WHERE id = $1`,
          [a.id, req.usuario!.id, p.data.montoContado.toFixed(2), p.data.observacion]);
        return { esperado, diferencia: Math.round((p.data.montoContado - esperado) * 100) / 100 };
      });
      await auditar({ ...actor(req), accion: 'CAJA_CHICA_CERRADA', entidad: 'caja_apertura', entidadId: codigo, detalle: { ...p.data, ...r } });
      return { codigo, estado: 'CERRADA', ...r };
    });
  });

  /* ----------------------------------------------------------- deudas por pagar */
  app.get('/deudas-compra', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'deudas.ver')) return;
    const p = z.object({ estadoPago: z.enum(['PENDIENTE', 'PARCIAL', 'PAGADO']).optional() }).safeParse(req.query);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Filtro inválido.'));
    const filas = await q<Record<string, unknown>>(`
      SELECT k.codigo, k.estado_pago, k.doc_tipo, k.serie, k.nro, k.fecha_compra::text fecha, k.vence_pago::text vence_pago, k.total,
             pr.razon_social proveedor, pr.banco, pr.cci,
             coalesce((SELECT sum(monto) FROM core.pago_compra WHERE compra_id = k.id AND estado = 'VIGENTE'), 0) pagado,
             CASE WHEN k.vence_pago IS NULL THEN NULL ELSE k.vence_pago - (now() AT TIME ZONE 'America/Lima')::date END dias,
             coalesce((SELECT json_agg(json_build_object('codigo', g.codigo, 'fecha', g.fecha_pago, 'caja', g.caja, 'medio', g.medio_pago, 'monto', g.monto,
               'nroOperacion', g.nro_operacion, 'estado', g.estado, 'autoriza', u.nombre, 'motivoAnulacion', g.motivo_anulacion, 'apertura', a.codigo) ORDER BY g.fecha_pago)
               FROM core.pago_compra g JOIN core.usuario u ON u.id = g.usuario_autoriza LEFT JOIN core.caja_apertura a ON a.id = g.apertura_id WHERE g.compra_id = k.id), '[]') pagos
      FROM core.compra k JOIN core.proveedor pr ON pr.id = k.proveedor_id
      WHERE k.estado = 'VERIFICADA' AND ($1::text IS NULL OR k.estado_pago = $1)
      ORDER BY (k.estado_pago = 'PAGADO'), k.vence_pago NULLS LAST, k.fecha_compra LIMIT 300`, [p.data.estadoPago ?? null]);
    return filas.map((f) => ({
      codigo: f.codigo, estadoPago: f.estado_pago, documento: `${String(f.doc_tipo).replace('_', ' ')} ${f.serie}-${f.nro}`, fecha: f.fecha, vencePago: f.vence_pago,
      dias: f.dias === null ? null : num(f.dias as string), proveedor: f.proveedor, banco: f.banco ?? '', cci: f.cci ?? '',
      total: num(f.total as string), pagado: num(f.pagado as string), saldo: Math.round((num(f.total as string) - num(f.pagado as string)) * 100) / 100,
      pagos: (f.pagos as Array<Record<string, string>>).map((g) => ({ ...g, monto: num(g.monto) })),
    }));
  });

  /* ------------------------------------------------------------------- pagos */
  const Pago = z.object({
    caja: z.enum(['CHICA', 'GRANDE']),
    medio: z.enum(['EFECTIVO', 'PLIN', 'YAPE', 'TRANSFERENCIA', 'OTRO']),
    monto: z.number().positive().max(10_000_000),
    nroOperacion: z.string().trim().toUpperCase().max(30).default(''),
  }).refine((d) => d.caja !== 'CHICA' || d.medio === 'EFECTIVO', { message: 'La caja chica solo paga en efectivo.', path: ['medio'] })
    .refine((d) => ['EFECTIVO', 'OTRO'].includes(d.medio) || d.nroOperacion.length >= 3, { message: 'RN-12: indica el número de operación del pago digital o la transferencia.', path: ['nroOperacion'] });

  // RN-10 a RN-13: Administración decide caja y medio; varios pagos por compra; nunca más que el saldo.
  app.post('/compras/:codigo/pagos', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'compras.pagar')) return;
    const { codigo } = req.params as { codigo: string };
    const p = Pago.safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues[0]?.message ?? 'Pago inválido.'));
    const d = p.data;
    const clave = (req.headers['idempotency-key'] as string | undefined) ?? null;
    if (clave) {
      const previo = await uno<{ codigo: string }>('SELECT codigo FROM core.pago_compra WHERE idempotency_key = $1', [clave]);
      if (previo) return reply.code(201).send({ codigo: previo.codigo, repetido: true });
    }
    return responder(reply, 'PAGO_INVALIDO', async () => {
      const r = await tx(async (c) => {
        const k = (await c.query<{ id: string; estado: string; total: string }>('SELECT id, estado, total FROM core.compra WHERE codigo = $1 FOR UPDATE', [codigo])).rows[0];
        if (!k) throw fallo(404, 'La compra no existe.');
        // Se paga lo que Almacén confirmó: una compra sin verificar todavía puede cambiar de monto.
        if (k.estado !== 'VERIFICADA') throw fallo(409, `Solo se paga una compra verificada (esta está ${k.estado.replace('_', ' ').toLowerCase()}).`);
        const pagado = num((await c.query<{ s: string }>(`SELECT coalesce(sum(monto), 0) s FROM core.pago_compra WHERE compra_id = $1 AND estado = 'VIGENTE'`, [k.id])).rows[0].s);
        const saldo = Math.round((num(k.total) - pagado) * 100) / 100;
        if (d.monto > saldo + 0.005) throw fallo(422, `RN-13: el pago supera el saldo de la compra (S/ ${saldo.toFixed(2)}).`);
        let aperturaId: string | null = null;
        if (d.caja === 'CHICA') {
          // RN-11: apertura vigente y sin superar su saldo; se bloquea para que dos pagos no la sobregiren.
          const a = (await c.query<{ id: string; codigo: string }>(`SELECT id, codigo FROM core.caja_apertura WHERE tipo = 'CHICA' AND estado = 'ABIERTA' FOR UPDATE`)).rows[0];
          if (!a) throw fallo(409, 'RN-11: no hay una caja chica abierta. Paga desde caja grande o pide al vendedor que abra caja.');
          const disponible = await saldoCaja(c, a.id);
          if (d.monto > disponible + 0.005) throw fallo(422, `RN-11: la caja chica ${a.codigo} solo tiene S/ ${disponible.toFixed(2)} disponibles. Las deudas mayores se pagan desde caja grande.`);
          aperturaId = a.id;
        }
        const cod = `PAG-${String(num((await c.query<{ n: string }>(`SELECT coalesce(max(substring(codigo from 5)::int), 0) + 1 n FROM core.pago_compra WHERE codigo ~ '^PAG-[0-9]+$'`)).rows[0].n)).padStart(6, '0')}`;
        await c.query(`INSERT INTO core.pago_compra (codigo, compra_id, caja, medio_pago, monto, nro_operacion, apertura_id, usuario_autoriza, idempotency_key)
          VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),$7,$8,$9)`, [cod, k.id, d.caja, d.medio, d.monto.toFixed(2), d.nroOperacion, aperturaId, req.usuario!.id, clave]);
        await actualizarEstadoPago(c, k.id);
        const estado = (await c.query<{ estado_pago: string }>('SELECT estado_pago FROM core.compra WHERE id = $1', [k.id])).rows[0].estado_pago;
        return { codigo: cod, estadoPago: estado, saldo: Math.round((saldo - d.monto) * 100) / 100 };
      });
      await auditar({ ...actor(req), accion: 'PAGO_COMPRA_REGISTRADO', entidad: 'pago_compra', entidadId: r.codigo, detalle: { compra: codigo, ...d } });
      return reply.code(201).send({ ...r, compra: codigo });
    });
  });

  // Un pago mal registrado se anula con motivo (no se borra: RN-15); el saldo de la compra y de la caja se recupera.
  app.post('/pagos-compra/:codigo/anular', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'compras.pagar')) return;
    const { codigo } = req.params as { codigo: string };
    const p = z.object({ motivo: z.string().trim().min(5).max(300) }).safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Indica el motivo (mínimo 5 caracteres).'));
    return responder(reply, 'PAGO_INVALIDO', async () => {
      const compra = await tx(async (c) => {
        const g = (await c.query<{ compra_id: string; codigo: string }>(`UPDATE core.pago_compra g SET estado = 'ANULADO', anulado_por = $2, anulado_en = now(), motivo_anulacion = $3
          FROM core.compra k WHERE g.codigo = $1 AND g.estado = 'VIGENTE' AND k.id = g.compra_id RETURNING g.compra_id, k.codigo`, [codigo, req.usuario!.id, p.data.motivo])).rows[0];
        if (!g) throw fallo(409, 'El pago no existe o ya está anulado.');
        await actualizarEstadoPago(c, g.compra_id);
        return g.codigo;
      });
      await auditar({ ...actor(req), accion: 'PAGO_COMPRA_ANULADO', entidad: 'pago_compra', entidadId: codigo, detalle: { compra, motivo: p.data.motivo } });
      return { codigo, estado: 'ANULADO', compra };
    });
  });
}

/** Sección 8: recordatorio diario a Administración de compras con saldo que vencen pronto o ya vencieron. */
export async function despacharAvisosPago(): Promise<number> {
  const filas = await tx(async (c) => (await c.query<{ codigo: string; proveedor: string; saldo: string; dias: number }>(`
    UPDATE core.compra k SET alerta_pago_en = (now() AT TIME ZONE 'America/Lima')::date FROM core.proveedor pr
    WHERE k.id IN (SELECT id FROM core.compra WHERE estado = 'VERIFICADA' AND estado_pago <> 'PAGADO' AND vence_pago IS NOT NULL
        AND vence_pago <= (now() AT TIME ZONE 'America/Lima')::date + coalesce((SELECT valor::int FROM core.parametro WHERE clave = 'dias_alerta_pago'), 3)
        AND (alerta_pago_en IS NULL OR alerta_pago_en < (now() AT TIME ZONE 'America/Lima')::date)
      ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED) AND pr.id = k.proveedor_id
    RETURNING k.codigo, pr.razon_social proveedor,
      k.total - coalesce((SELECT sum(monto) FROM core.pago_compra WHERE compra_id = k.id AND estado = 'VIGENTE'), 0) saldo,
      k.vence_pago - (now() AT TIME ZONE 'America/Lima')::date dias`)).rows);
  for (const f of filas) {
    const cuando = f.dias < 0 ? `venció hace ${-f.dias} día(s)` : f.dias === 0 ? 'vence hoy' : `vence en ${f.dias} día(s)`;
    await notificar([{ permiso: 'compras.pagar' }], { tipo: 'compra', titulo: `Deuda ${f.codigo} por pagar`, cuerpo: `${f.proveedor}: S/ ${num(f.saldo).toFixed(2)} ${cuando}`, ruta: '/compras/deudas' });
  }
  return filas.length;
}

