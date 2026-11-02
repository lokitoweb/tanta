import { createHash } from 'node:crypto';
import { q, uno, tx } from './db.js';

/** Conexión fija para serializar la escritura de la cadena de auditoría. */
const LLAVE_CADENA = 880_2026;

function canonico(partes: { accion: string; entidad: string; entidadId: string | null; detalle: unknown; ocurridoEn: string }): string {
  // JSON canónico: claves ordenadas. Sin esto, `jsonb` puede reordenar y el hash no cuadra.
  const orden = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(orden);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).sort().map((k) => [k, orden(o[k])]));
    }
    return v;
  };
  return JSON.stringify({
    a: partes.accion,
    e: partes.entidad,
    i: partes.entidadId,
    d: orden(partes.detalle ?? {}),
    t: partes.ocurridoEn,
  });
}

/**
 * Registra un evento en la cadena.
 *
 * - Se toma un lock de asesoría para que dos procesos no lean el mismo "último hash"
 *   (antes, bajo carga, la cadena se partía en cientos de eslabones).
 * - El instante se decide en JavaScript y se guarda: así lo que se hashea es
 *   exactamente lo que se verifica después.
 */
export async function auditar(ev: {
  actorId?: string | null;
  actor?: string;
  rol?: string;
  accion: string;
  entidad: string;
  entidadId?: string | null;
  detalle?: Record<string, unknown>;
  ip?: string;
}): Promise<void> {
  const ocurridoEn = new Date().toISOString();

  try {
    await tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock($1)', [LLAVE_CADENA]);

      const estado = await c.query<{ hash_actual: string }>(
        'SELECT hash_actual FROM audit.cadena_estado WHERE id = 1 FOR UPDATE',
      );
      const previo = estado.rows[0]?.hash_actual ?? '';
      const hashActual = createHash('sha256')
        .update(previo + canonico({
          accion: ev.accion, entidad: ev.entidad, entidadId: ev.entidadId ?? null,
          detalle: ev.detalle ?? {}, ocurridoEn,
        }))
        .digest('hex');

      await c.query(
        `INSERT INTO audit.evento
           (actor_id, actor, rol, accion, entidad, entidad_id, detalle, ip, hash_anterior, hash_actual, ocurrido_en, creado_en)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
        [
          ev.actorId ?? null, ev.actor ?? '', ev.rol ?? '', ev.accion, ev.entidad,
          ev.entidadId ?? null, JSON.stringify(ev.detalle ?? {}), ev.ip ?? null,
          previo, hashActual, ocurridoEn,
        ],
      );
      await c.query('UPDATE audit.cadena_estado SET hash_actual = $1, actualizado_en = now() WHERE id = 1', [hashActual]);
    });
  } catch (e) {
    // La auditoría nunca debe tumbar la operación de negocio, pero sí dejar rastro.
    console.error('[auditoria] no se pudo registrar el evento', ev.accion, (e as Error).message);
  }
}

/** Verifica la cadena completa. Devuelve el primer eslabón roto, si hay. */
export async function verificarCadena(): Promise<{ ok: boolean; total: number; roto?: number }> {
  const filas = await q<{
    id: string; hash_anterior: string; hash_actual: string;
    detalle: string; accion: string; entidad: string; entidad_id: string | null; ocurrido_en: string;
  }>(
    `SELECT id, hash_anterior, hash_actual, detalle::text, accion, entidad, entidad_id, ocurrido_en
     FROM audit.evento ORDER BY id`,
  );

  let anterior = '';
  for (const f of filas) {
    if (f.hash_anterior !== anterior) return { ok: false, total: filas.length, roto: Number(f.id) };
    const esperado = createHash('sha256')
      .update(anterior + canonico({
        accion: f.accion, entidad: f.entidad, entidadId: f.entidad_id,
        detalle: JSON.parse(f.detalle), ocurridoEn: new Date(f.ocurrido_en).toISOString(),
      }))
      .digest('hex');
    if (esperado !== f.hash_actual) return { ok: false, total: filas.length, roto: Number(f.id) };
    anterior = f.hash_actual;
  }
  return { ok: true, total: filas.length };
}

export async function ultimoEvento(): Promise<{ accion: string; ocurridoEn: string } | null> {
  const f = await uno<{ accion: string; ocurrido_en: string }>(
    'SELECT accion, ocurrido_en::text AS ocurrido_en FROM audit.evento ORDER BY id DESC LIMIT 1',
  );
  return f ? { accion: f.accion, ocurridoEn: f.ocurrido_en } : null;
}
