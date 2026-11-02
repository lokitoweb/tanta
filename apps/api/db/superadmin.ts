import { pool } from '../src/db.js';
import { hashClave } from '../src/seguridad.js';

/**
 * Crea (o restablece) el primer Superadministrador de una instalación nueva.
 * La contraseña la elige quien despliega: no existe ninguna clave por defecto en el código.
 *
 *   SUPERADMIN_USUARIO=admin SUPERADMIN_CLAVE='…' node dist/db/superadmin.js
 *
 * Al primer ingreso el sistema exige configurar la verificación en dos pasos (producción).
 */
async function main() {
  const usuario = (process.env.SUPERADMIN_USUARIO ?? '').trim().toLowerCase();
  const clave = process.env.SUPERADMIN_CLAVE ?? '';
  if (!/^[a-z0-9._-]{3,40}$/.test(usuario)) throw new Error('SUPERADMIN_USUARIO: 3-40 caracteres a-z, 0-9, . _ -');
  if (clave.length < 12) throw new Error('SUPERADMIN_CLAVE: mínimo 12 caracteres');

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query<{ id: string }>(
      `INSERT INTO core.usuario (nombre, usuario, clave_hash) VALUES ('Superadministrador', $1, $2)
       ON CONFLICT ((lower(usuario))) DO UPDATE SET clave_hash = EXCLUDED.clave_hash, estado = 'ACTIVO'
       RETURNING id`,
      [usuario, hashClave(clave)],
    );
    const id = r.rows[0].id;
    await c.query('DELETE FROM core.usuario_rol WHERE usuario_id = $1', [id]);
    await c.query("INSERT INTO core.usuario_rol (usuario_id, rol_id) VALUES ($1, 'SUPERADMIN')", [id]);
    await c.query('UPDATE core.refresh_token SET revocado_en = now() WHERE usuario_id = $1 AND revocado_en IS NULL', [id]);
    await c.query('COMMIT');
    console.log(`✓ Superadministrador "${usuario}" listo.`);
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(`✗ ${(e as Error).message}`); process.exit(1); });
