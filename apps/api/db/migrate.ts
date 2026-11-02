import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';

const aqui = dirname(fileURLToPath(import.meta.url));
const DIR = join(aqui, '..', '..', 'db', 'migrations');
const LLAVE_MIGRACION = 727274; // pg_advisory_lock: un solo migrador a la vez

/**
 * Migrador mínimo y ordenado.
 * - Cada archivo .sql se aplica una sola vez, en orden alfabético, dentro de una transacción.
 * - Un lock de PostgreSQL impide que dos arranques simultáneos apliquen la misma migración.
 * - El checksum es SHA-256 del archivo: si alguien edita una migración ya aplicada, se detiene.
 * - Al final asegura el rol de aplicación (sin superusuario) con permisos mínimos.
 */
async function main() {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS core;
    CREATE TABLE IF NOT EXISTS core.schema_migracion (
      version     text PRIMARY KEY,
      aplicada_en timestamptz NOT NULL DEFAULT now(),
      checksum    text NOT NULL
    );
  `);
  const lock = await pool.connect();
  await lock.query('SELECT pg_advisory_lock($1)', [LLAVE_MIGRACION]);
  try {
    const archivos = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();
    const aplicadas = new Map(
      (await pool.query<{ version: string; checksum: string }>('SELECT version, checksum FROM core.schema_migracion')).rows.map((r) => [r.version, r.checksum]),
    );

    let nuevas = 0;
    for (const archivo of archivos) {
      const version = archivo.replace(/\.sql$/, '');
      // Se normalizan los finales de línea: el mismo archivo da el mismo hash en Windows y Linux.
      const sql = (await readFile(join(DIR, archivo), 'utf8')).replace(/\r\n/g, '\n');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previo = aplicadas.get(version);
      if (previo !== undefined) {
        if (previo.length !== 64) {
          // Registro antiguo (antes no era un hash): se actualiza al formato verificable.
          await pool.query('UPDATE core.schema_migracion SET checksum = $1 WHERE version = $2', [checksum, version]);
        } else if (previo !== checksum) {
          console.error(`✗ ${version} fue modificada después de aplicarse. Crea una migración nueva en vez de editarla.`);
          process.exit(1);
        }
        continue;
      }
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(sql);
        await c.query('INSERT INTO core.schema_migracion (version, checksum) VALUES ($1,$2)', [version, checksum]);
        await c.query('COMMIT');
        console.log(`✓ ${version} aplicada`);
        nuevas++;
      } catch (e) {
        await c.query('ROLLBACK');
        console.error(`✗ ${version} falló:`, (e as Error).message);
        process.exit(1);
      } finally {
        c.release();
      }
    }

    await asegurarRolAplicacion();
    const total = (await pool.query('SELECT count(*)::int AS n FROM core.schema_migracion')).rows[0].n;
    console.log(`\nMigraciones: ${nuevas} nuevas · ${total} en total`);
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [LLAVE_MIGRACION]).catch(() => undefined);
    lock.release();
    await pool.end();
  }
}

/**
 * Rol con el que atiende el API en producción: NO superusuario y NO dueño de las tablas.
 * Puede leer/escribir datos, pero no desactivar triggers, borrar la auditoría ni ejecutar
 * programas del sistema (COPY … PROGRAM). Idempotente: se reaplica en cada despliegue.
 */
async function asegurarRolAplicacion() {
  const usuario = process.env.APP_DB_USER;
  const clave = process.env.APP_DB_PASSWORD;
  if (!usuario || !clave) {
    if (process.env.NODE_ENV === 'production') {
      console.error('✗ APP_DB_PASSWORD es obligatorio en producción (el API no debe usar el usuario dueño).');
      process.exit(1);
    }
    return; // desarrollo: se usa el mismo usuario
  }
  if (!/^[a-z_][a-z0-9_]{2,40}$/.test(usuario)) throw new Error('APP_DB_USER inválido');
  if (clave.length < 16) throw new Error('APP_DB_PASSWORD debe tener al menos 16 caracteres');
  const literal = (await pool.query<{ q: string }>('SELECT quote_literal($1) AS q', [clave])).rows[0].q;
  const existe = (await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [usuario])).rowCount;
  await pool.query(`${existe ? 'ALTER' : 'CREATE'} ROLE ${usuario} WITH LOGIN PASSWORD ${literal} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  const db = (await pool.query<{ d: string }>('SELECT current_database() AS d')).rows[0].d;
  await pool.query(`
    GRANT CONNECT, TEMPORARY ON DATABASE "${db}" TO ${usuario};
    GRANT USAGE ON SCHEMA core, audit, report TO ${usuario};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO ${usuario};
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA core, audit TO ${usuario};
    GRANT SELECT ON ALL TABLES IN SCHEMA report TO ${usuario};
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA core, audit TO ${usuario};
    -- Auditoría: solo leer e insertar (sin UPDATE/DELETE/TRUNCATE).
    REVOKE ALL ON ALL TABLES IN SCHEMA audit FROM ${usuario};
    GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA audit TO ${usuario};
    GRANT UPDATE ON audit.cadena_estado TO ${usuario};
    -- El historial de migraciones no lo toca la aplicación.
    REVOKE INSERT, UPDATE, DELETE ON core.schema_migracion FROM ${usuario};
  `);
  console.log(`· rol de aplicación ${usuario} verificado (sin privilegios de administración)`);
}

await main();
