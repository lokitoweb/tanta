import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { q, tx, num } from '../db.js';
import { autenticar, exigir, error } from '../seguridad.js';
import { auditar } from '../auditoria.js';
import { actor, fallo, responder } from './almacen.js';

/**
 * Caja grande (audio del cliente, 09/11/2026): repositorio de todos los ingresos, en efectivo (caja fuerte) y en
 * cuentas bancarias o billeteras. Libro de movimientos: saldo de una cuenta = suma de sus movimientos vigentes.
 * Toda salida se valida contra el saldo con la cuenta bloqueada (dos pagos a la vez no la sobregiran).
 * Nada se borra: un movimiento se anula junto con el documento que lo originó.
 */

export type TipoMovimiento = 'SALDO_INICIAL' | 'AJUSTE' | 'RENDICION' | 'CIERRE_CAJA_CHICA' | 'FONDO_CAJA_CHICA'
  | 'PAGO_COMPRA' | 'PAGO_COSTO' | 'DEPOSITO_SALIDA' | 'DEPOSITO_ENTRADA';

const dos = (n: number) => Math.round(n * 100) / 100;

/** Registra un movimiento (+ entra, − sale). Una salida no puede superar el saldo de la cuenta. */
export async function moverCaja(c: PoolClient, m: { cuenta: string; monto: number; tipo: TipoMovimiento; concepto: string; referencia?: string | null; origenId?: string | null; usuarioId: string }) {
  const monto = dos(m.monto);
  if (monto === 0) return null;
  const cta = (await c.query<{ nombre: string }>('SELECT nombre FROM core.cuenta_caja WHERE codigo = $1 AND activo FOR UPDATE', [m.cuenta])).rows[0];
  if (!cta) throw fallo(422, `La cuenta de caja grande ${m.cuenta} no existe o está inactiva.`);
  if (monto < 0) {
    const saldo = num((await c.query<{ s: string }>('SELECT core.saldo_cuenta($1) s', [m.cuenta])).rows[0].s);
    if (-monto > saldo + 0.005) throw fallo(422, `Caja grande: «${cta.nombre}» solo tiene S/ ${saldo.toFixed(2)} disponibles.`);
  }
  return (await c.query<{ codigo: string }>(`INSERT INTO core.movimiento_caja (cuenta, tipo, monto, concepto, referencia, origen_id, usuario_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING codigo`, [m.cuenta, m.tipo, monto.toFixed(2), m.concepto.slice(0, 200), m.referencia ?? null, m.origenId ?? null, m.usuarioId])).rows[0].codigo;
}

/** Anula los movimientos de un documento (pago anulado, caja reabierta…): el dinero vuelve a su cuenta. */
export async function anularMovimientos(c: PoolClient, origenId: string, usuarioId: string, motivo: string) {
  await c.query(`UPDATE core.movimiento_caja SET estado = 'ANULADO', anulado_por = $2, anulado_en = now(), motivo_anulacion = $3
    WHERE origen_id = $1 AND estado = 'VIGENTE'`, [origenId, usuarioId, motivo.slice(0, 300)]);
}

/** Cuenta donde se guarda el efectivo: la del medio de pago en efectivo (el que sale de caja chica). */
export async function cuentaEfectivo(c: PoolClient): Promise<string> {
  const r = (await c.query<{ cuenta: string }>(`SELECT coalesce(
      (SELECT m.cuenta_caja FROM core.medio_pago m JOIN core.cuenta_caja k ON k.codigo = m.cuenta_caja AND k.activo WHERE m.caja_chica AND m.activo ORDER BY m.orden LIMIT 1),
      (SELECT codigo FROM core.cuenta_caja WHERE tipo = 'EFECTIVO' AND activo ORDER BY orden LIMIT 1)) cuenta`)).rows[0];
  if (!r?.cuenta) throw fallo(422, 'No hay una cuenta de efectivo en caja grande: créala en Maestros → Catálogos → Cuentas de caja.');
  return r.cuenta;
}

export async function rutasCajaGrande(app: FastifyInstance) {
  app.get('/caja-grande', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'caja.grande.ver')) return;
    const p = z.object({ cuenta: z.string().trim().toUpperCase().max(20).optional(), limite: z.coerce.number().int().min(1).max(1000).default(300) }).safeParse(req.query);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Filtro inválido.'));
    const cuentas = await q<Record<string, string>>(`SELECT k.codigo, k.nombre, k.tipo, k.banco, b.nombre banco_nombre, k.numero, k.activo, core.saldo_cuenta(k.codigo) saldo
      FROM core.cuenta_caja k LEFT JOIN core.banco b ON b.codigo = k.banco ORDER BY k.activo DESC, k.orden, k.codigo`);
    const movimientos = await q<Record<string, string>>(`SELECT m.codigo, m.cuenta, k.nombre cuenta_nombre, m.tipo, m.monto, m.concepto, m.referencia, m.estado,
        m.creado_en::text creado_en, u.nombre usuario, m.motivo_anulacion
      FROM core.movimiento_caja m JOIN core.cuenta_caja k ON k.codigo = m.cuenta JOIN core.usuario u ON u.id = m.usuario_id
      WHERE ($1::text IS NULL OR m.cuenta = $1) ORDER BY m.creado_en DESC, m.codigo DESC LIMIT $2`, [p.data.cuenta ?? null, p.data.limite]);
    return {
      cuentas: cuentas.map((k) => ({ codigo: k.codigo, nombre: k.nombre, tipo: k.tipo, banco: k.banco_nombre, numero: k.numero, activo: Boolean(k.activo), saldo: num(k.saldo) })),
      total: dos(cuentas.filter((k) => k.activo).reduce((t, k) => t + num(k.saldo), 0)),
      movimientos: movimientos.map((m) => ({ codigo: m.codigo, cuenta: m.cuenta, cuentaNombre: m.cuenta_nombre, tipo: m.tipo, monto: num(m.monto), concepto: m.concepto,
        referencia: m.referencia, estado: m.estado, fecha: m.creado_en, usuario: m.usuario, motivoAnulacion: m.motivo_anulacion })),
    };
  });

  // Para elegir de qué cuenta sale un pago: cuentas activas con su saldo (quien paga lo necesita aunque no vea el libro).
  app.get('/caja-grande/cuentas', { preHandler: autenticar }, async (req, reply) => {
    if (!['compras.pagar', 'caja.grande.ver'].some((x) => req.usuario!.permisos.has(x))) return reply.code(403).send(error(403, 'SIN_PERMISO', 'Falta el permiso compras.pagar.'));
    return (await q<{ codigo: string; nombre: string; tipo: string; saldo: string }>(`SELECT codigo, nombre, tipo, core.saldo_cuenta(codigo) saldo FROM core.cuenta_caja WHERE activo ORDER BY orden, codigo`))
      .map((k) => ({ codigo: k.codigo, nombre: k.nombre, tipo: k.tipo, saldo: num(k.saldo) }));
  });

  // Movimientos manuales: saldo inicial (una vez por cuenta), depósito entre cuentas y ajuste con motivo.
  const Manual = z.discriminatedUnion('tipo', [
    z.object({ tipo: z.literal('SALDO_INICIAL'), cuenta: z.string().trim().toUpperCase(), monto: z.number().positive().max(100_000_000), concepto: z.string().trim().max(200).default('Saldo inicial') }),
    z.object({ tipo: z.literal('DEPOSITO'), cuenta: z.string().trim().toUpperCase(), cuentaDestino: z.string().trim().toUpperCase(), monto: z.number().positive().max(100_000_000),
      concepto: z.string().trim().max(200).default(''), nroOperacion: z.string().trim().toUpperCase().max(30).default('') }),
    z.object({ tipo: z.literal('AJUSTE'), cuenta: z.string().trim().toUpperCase(), monto: z.number().min(-100_000_000).max(100_000_000).refine((n) => n !== 0, 'El ajuste no puede ser 0'),
      concepto: z.string().trim().min(5, 'Indica el motivo del ajuste (mínimo 5 caracteres)').max(200) }),
  ]);

  app.post('/caja-grande/movimientos', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'caja.grande.gestionar')) return;
    const p = Manual.safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues[0]?.message ?? 'Movimiento inválido.'));
    const d = p.data;
    const u = req.usuario!.id;
    return responder(reply, 'MOVIMIENTO_INVALIDO', async () => {
      const codigos = await tx(async (c) => {
        if (d.tipo === 'SALDO_INICIAL') {
          await c.query('SELECT 1 FROM core.cuenta_caja WHERE codigo = $1 FOR UPDATE', [d.cuenta]);
          if ((await c.query(`SELECT 1 FROM core.movimiento_caja WHERE cuenta = $1 AND estado = 'VIGENTE' LIMIT 1`, [d.cuenta])).rowCount) {
            throw fallo(409, 'La cuenta ya tiene movimientos: corrige su saldo con un ajuste.');
          }
          return [await moverCaja(c, { cuenta: d.cuenta, monto: d.monto, tipo: 'SALDO_INICIAL', concepto: d.concepto || 'Saldo inicial', usuarioId: u })];
        }
        if (d.tipo === 'AJUSTE') return [await moverCaja(c, { cuenta: d.cuenta, monto: d.monto, tipo: 'AJUSTE', concepto: d.concepto, usuarioId: u })];
        if (d.cuenta === d.cuentaDestino) throw fallo(422, 'Elige dos cuentas distintas.');
        // Bloqueo en orden fijo: dos depósitos cruzados (A→B y B→A) no se traban.
        await c.query('SELECT 1 FROM core.cuenta_caja WHERE codigo = ANY($1) ORDER BY codigo FOR UPDATE', [[d.cuenta, d.cuentaDestino]]);
        const ref = d.nroOperacion ? `Op. ${d.nroOperacion}` : null;
        const concepto = d.concepto || 'Depósito entre cuentas';
        // Las dos patas comparten origen: se anulan juntas.
        const par = randomUUID();
        const salida = await moverCaja(c, { cuenta: d.cuenta, monto: -d.monto, tipo: 'DEPOSITO_SALIDA', concepto, referencia: ref, origenId: par, usuarioId: u });
        const entrada = await moverCaja(c, { cuenta: d.cuentaDestino, monto: d.monto, tipo: 'DEPOSITO_ENTRADA', concepto, referencia: ref, origenId: par, usuarioId: u });
        return [salida, entrada];
      });
      await auditar({ ...actor(req), accion: `CAJA_GRANDE_${d.tipo}`, entidad: 'movimiento_caja', entidadId: codigos.join(', '), detalle: d });
      return reply.code(201).send({ codigos });
    });
  });

  // Anular un movimiento manual (los de pagos, rendiciones y caja chica se anulan desde su documento).
  app.post('/caja-grande/movimientos/:codigo/anular', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'caja.grande.gestionar')) return;
    const { codigo } = req.params as { codigo: string };
    const p = z.object({ motivo: z.string().trim().min(5).max(300) }).safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Indica el motivo (mínimo 5 caracteres).'));
    return responder(reply, 'MOVIMIENTO_INVALIDO', async () => {
      const anulados = await tx(async (c) => {
        const m = (await c.query<{ tipo: string; origen_id: string | null }>(`SELECT tipo, origen_id FROM core.movimiento_caja WHERE codigo = $1 AND estado = 'VIGENTE'`, [codigo])).rows[0];
        if (!m) throw fallo(409, 'El movimiento no existe o ya está anulado.');
        if (!['SALDO_INICIAL', 'AJUSTE', 'DEPOSITO_SALIDA', 'DEPOSITO_ENTRADA'].includes(m.tipo)) {
          throw fallo(409, 'Este movimiento viene de un pago, una rendición o una caja chica: anúlalo desde ese documento.');
        }
        // Un depósito se anula completo: sus dos patas comparten origen.
        const filas = (await c.query<{ codigo: string; cuenta: string; monto: string }>(`SELECT codigo, cuenta, monto FROM core.movimiento_caja
          WHERE estado = 'VIGENTE' AND (codigo = $1 OR ($2::uuid IS NOT NULL AND origen_id = $2)) ORDER BY cuenta FOR UPDATE`,
          [codigo, m.tipo.startsWith('DEPOSITO') ? m.origen_id : null])).rows;
        // Bloquea las cuentas (como moverCaja) antes de mirar su saldo: sin esto, un pago simultáneo la deja en negativo.
        await c.query('SELECT 1 FROM core.cuenta_caja WHERE codigo = ANY($1) ORDER BY codigo FOR UPDATE', [[...new Set(filas.map((f) => f.cuenta))]]);
        // Anular una entrada no puede dejar la cuenta en negativo (ese dinero ya se usó).
        for (const f of filas.filter((x) => num(x.monto) > 0)) {
          const saldo = num((await c.query<{ s: string }>('SELECT core.saldo_cuenta($1) s', [f.cuenta])).rows[0].s);
          if (saldo - num(f.monto) < -0.005) throw fallo(422, `No se puede anular: la cuenta ${f.cuenta} quedaría en negativo (ya se usó ese dinero).`);
        }
        await c.query(`UPDATE core.movimiento_caja SET estado = 'ANULADO', anulado_por = $2, anulado_en = now(), motivo_anulacion = $3 WHERE codigo = ANY($1)`,
          [filas.map((f) => f.codigo), req.usuario!.id, p.data.motivo]);
        return filas.map((f) => f.codigo);
      });
      await auditar({ ...actor(req), accion: 'CAJA_GRANDE_ANULADO', entidad: 'movimiento_caja', entidadId: anulados.join(', '), detalle: { motivo: p.data.motivo } });
      return { anulados };
    });
  });
}
