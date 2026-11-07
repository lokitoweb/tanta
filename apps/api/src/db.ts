import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? 5433),
  user: process.env.PGUSER ?? 'tanta',
  password: process.env.PGPASSWORD ?? 'tanta_dev_2026',
  database: process.env.PGDATABASE ?? 'tanta',
  // Con 10 conexiones, 60 usuarios concurrentes se encolaban y el p95 llegaba a 2,9 s.
  // 25 cubre la carga real de una panadería con margen; PostgreSQL admite 120.
  max: Number(process.env.PGPOOL ?? 25),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 8_000,
  application_name: 'tanta-api',
  // pg ya devuelve `numeric` como string: el dinero nunca pasa por un float.
});

// Si PostgreSQL se reinicia, pg emite 'error' en las conexiones abiertas: sin estos oyentes,
// ese evento cierra todo el proceso. El pool abre conexiones nuevas cuando la base vuelve.
const conexionPerdida = (e: Error) => console.error('Conexión con PostgreSQL perdida:', e.message);
pool.on('error', conexionPerdida); // la conexión estaba libre
pool.on('connect', (c) => c.on('error', conexionPerdida)); // la conexión estaba en uso (transacción)

export type Cliente = pg.PoolClient;

/** Ejecuta una consulta y devuelve las filas ya tipadas. */
export async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool.query(sql, params as never[]);
  return r.rows as T[];
}

export async function uno<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
  const filas = await q<T>(sql, params);
  return filas[0] ?? null;
}

/** Transacción con rollback automático. Todo lo que mueve dinero va aquí dentro. */
export async function tx<T>(fn: (c: Cliente) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {}); // sin conexión ya no hay qué revertir: importa el error original
    throw e;
  } finally {
    c.release();
  }
}

/** numeric de PostgreSQL llega como string: se convierte solo en la frontera de la API. */
export function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'number' ? v : Number(v);
}

export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'number' ? v : Number(v);
}
