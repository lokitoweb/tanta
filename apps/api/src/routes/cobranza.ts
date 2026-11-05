import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, tx, uno, num } from '../db.js';
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

export async function rutasCobranza(app: FastifyInstance) {
  /* ------------------------------------------------------------- recibos */
  // RN-34 / COB-05: un pago del cliente se aplica a los documentos elegidos o, si no se eligen,
  // a los más antiguos primero. Nunca supera el saldo. Genera un recibo con correlativo (COB-08).
  const NuevoRecibo = z.object({
    clienteId: z.string().uuid(),
    monto: z.number().positive().max(10_000_000),
    medio: z.string().trim().toUpperCase().max(20),
    referencia: z.string().trim().max(60).default(''),
    cxcIds: z.array(z.string().uuid()).max(100).optional(),
  });

  app.post('/cobranza/recibos', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'cobranza.registrar')) return;
    const p = NuevoRecibo.safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues[0]?.message ?? 'Pago inválido.'));
    const d = p.data;
    try { exigirOperacion(await medioPago(null, d.medio, 'cobranza'), d.referencia); } catch (e) {
      return reply.code(422).send(error(422, 'MEDIO_INVALIDO', (e as Error).message));
    }
    const clave = req.headers['idempotency-key'] as string | undefined;
    if (clave) {
      const previo = await uno<{ numero: string }>('SELECT numero FROM core.recibo WHERE idempotency_key = $1', [clave]);
      if (previo) return reply.code(201).send(await detalleRecibo(previo.numero));
    }
    try {
      const numero = await tx(async (c) => {
        // Documentos abiertos del cliente, del más antiguo al más nuevo, bloqueados para el cálculo.
        const docs = (await c.query<{ id: string; saldo: string }>(`SELECT id, saldo FROM core.cuenta_por_cobrar
            WHERE cliente_id = $1 AND estado IN ('PENDIENTE','PARCIAL') AND saldo > 0 AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
            ORDER BY vence_en, creado_en, id FOR UPDATE`, [d.clienteId, d.cxcIds ?? null])).rows;
        if (!docs.length) throw fallo(422, 'El cliente no tiene documentos por cobrar.');
        const total = docs.reduce((s, x) => s + num(x.saldo), 0);
        if (d.monto > total + 0.001) throw fallo(422, `El pago supera el saldo: el cliente debe S/ ${total.toFixed(2)}.`);
        const serie = (await c.query<{ serie: string; correlativo: number }>(`UPDATE core.serie_comprobante SET correlativo_actual = correlativo_actual + 1
            WHERE tipo = 'RECIBO' AND activo RETURNING serie, correlativo_actual AS correlativo`)).rows[0];
        if (!serie) throw fallo(409, 'No hay una serie activa de recibos: configúrala en Parámetros.');
        const num_ = `${serie.serie}-${String(serie.correlativo).padStart(8, '0')}`;
        const rec = (await c.query<{ id: string }>(`INSERT INTO core.recibo (numero, cliente_id, monto, medio, referencia, registrado_por, idempotency_key)
            VALUES ($1,$2,$3,$4,NULLIF($5,''),$6,$7) RETURNING id`, [num_, d.clienteId, d.monto.toFixed(2), d.medio, d.referencia, req.usuario!.id, clave ?? null])).rows[0];
        let resto = d.monto;
        for (const doc of docs) {
          if (resto <= 0.0001) break;
          const aplica = Math.min(resto, num(doc.saldo));
          const saldo = Number((num(doc.saldo) - aplica).toFixed(4));
          await c.query('UPDATE core.cuenta_por_cobrar SET saldo = $2, estado = $3 WHERE id = $1', [doc.id, saldo.toFixed(4), saldo <= 0.001 ? 'PAGADA' : 'PARCIAL']);
          await c.query(`INSERT INTO core.cobranza (cxc_id, monto, medio, referencia, registrado_por, recibo_id)
              VALUES ($1,$2,$3,NULLIF($4,''),$5,$6)`, [doc.id, aplica.toFixed(4), d.medio, d.referencia, req.usuario!.id, rec.id]);
          resto = Number((resto - aplica).toFixed(4));
        }
        return num_;
      });
      const r = await detalleRecibo(numero);
      await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'RECIBO_EMITIDO', entidad: 'recibo', entidadId: numero, detalle: { monto: d.monto, medio: d.medio, documentos: r.aplicaciones.length }, ip: req.ip });
      void emitirEvento('cobro.registrado', r);
      return reply.code(201).send(r);
    } catch (e) {
      const err = e as Error & { status?: number };
      if (!err.status) throw e;
      return reply.code(err.status).send(error(err.status, 'COBRO_INVALIDO', err.message));
    }
  });

  async function detalleRecibo(numero: string) {
    const r = await uno<Record<string, string>>(`SELECT r.numero, r.monto, r.medio, r.referencia, r.creado_en::text fecha, c.nombre cliente, u.nombre vendedor
      FROM core.recibo r JOIN core.cliente c ON c.id = r.cliente_id LEFT JOIN core.usuario u ON u.id = r.registrado_por WHERE r.numero = $1`, [numero]);
    const ap = await q<Record<string, string>>(`SELECT coalesce(v.serie || '-' || lpad(v.correlativo::text, 8, '0'), v.codigo, 'Saldo') documento, b.monto, x.saldo
      FROM core.cobranza b JOIN core.recibo r ON r.id = b.recibo_id JOIN core.cuenta_por_cobrar x ON x.id = b.cxc_id LEFT JOIN core.venta v ON v.id = x.venta_id
      WHERE r.numero = $1 ORDER BY b.creado_en`, [numero]);
    return { ...r, monto: num(r!.monto), aplicaciones: ap.map((a) => ({ documento: a.documento, aplicado: num(a.monto), saldo: num(a.saldo) })) };
  }

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
    const p = z.object({ fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).safeParse(req.query);
    const fecha = (p.success && p.data.fecha) || new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
    const filas = await q<Record<string, string>>(`
      SELECT b.medio, coalesce(u.nombre, '—') vendedor, count(*) pagos, sum(b.monto) monto
      FROM core.cobranza b LEFT JOIN core.usuario u ON u.id = b.registrado_por
      WHERE (b.creado_en AT TIME ZONE 'America/Lima')::date = $1::date
      GROUP BY b.medio, u.nombre ORDER BY b.medio, u.nombre`, [fecha]);
    const lineas = filas.map((f) => ({ medio: f.medio, vendedor: f.vendedor, pagos: num(f.pagos), monto: num(f.monto) }));
    const porMedio = Object.entries(lineas.reduce<Record<string, number>>((a, l) => ({ ...a, [l.medio]: (a[l.medio] ?? 0) + l.monto }), {})).map(([medio, monto]) => ({ medio, monto }));
    return { fecha, total: lineas.reduce((s, l) => s + l.monto, 0), porMedio, lineas };
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
