import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';

const aqui = dirname(fileURLToPath(import.meta.url));
const DIR = join(aqui, '..', '..', 'db', 'migrations');

/**
 * Migrador mínimo y ordenado.
 * - Cada archivo .sql se aplica una sola vez, en orden alfabético.
 * - Cada migración corre dentro de una transacción: si falla, no deja el esquema a medias.
 * - El registro vive en core.schema_migracion para que el despliegue sea idempotente.
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

  const archivos = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();
  const aplicadas = new Set(
    (await pool.query<{ version: string }>('SELECT version FROM core.schema_migracion')).rows.map((r) => r.version),
  );

  let nuevas = 0;
  for (const archivo of archivos) {
    const version = archivo.replace(/\.sql$/, '');
    if (aplicadas.has(version)) {
      console.log(`· ${version} ya aplicada`);
      continue;
    }
    const sql = await readFile(join(DIR, archivo), 'utf8');
    const checksum = Buffer.from(sql).toString('base64').slice(0, 32);
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

  const total = (await pool.query('SELECT count(*)::int AS n FROM core.schema_migracion')).rows[0].n;
  console.log(`\nMigraciones: ${nuevas} nuevas · ${total} en total`);
  await pool.end();
}

await main();
