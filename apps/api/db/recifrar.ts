import { createDecipheriv, createHash } from 'node:crypto';
import { pool } from '../src/db.js';
import { cifrar, SECRETOS } from '../src/routes/sistema.js';

/**
 * Al pasar la base a otro servidor (otra CONFIG_KEY), vuelve a cifrar los secretos de Configuración
 * (Firebase, webhook, correo, token de GitHub) con la llave de este servidor. Sin esto quedan vacíos.
 *
 *   LLAVE_ANTERIOR='<CONFIG_KEY del servidor de origen>' node dist/db/recifrar.js
 *   (si el origen no tenía CONFIG_KEY:  LLAVE_ANTERIOR='config:<su JWT_SECRET>')
 *
 * Transaccional: si un solo secreto no se descifra (llave equivocada), no cambia nada.
 */
async function main() {
  const origen = process.env.LLAVE_ANTERIOR ?? '';
  if (!origen) throw new Error('Falta LLAVE_ANTERIOR');
  const vieja = createHash('sha256').update(origen).digest();
  const descifrar = (v: string) => {
    const b = Buffer.from(v.slice(7), 'base64');
    const d = createDecipheriv('aes-256-gcm', vieja, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  };

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const [seccion, campos] of Object.entries(SECRETOS)) {
      const fila = (await c.query<{ valor: Record<string, unknown> }>('SELECT valor FROM core.configuracion WHERE clave = $1 FOR UPDATE', [seccion])).rows[0];
      if (!fila) continue;
      let n = 0;
      for (const k of campos ?? []) {
        const v = fila.valor[k];
        if (typeof v !== 'string' || !v.startsWith('enc:v1:')) continue;
        try { fila.valor[k] = cifrar(descifrar(v)); } catch { throw new Error(`${seccion}.${k} no se descifra: LLAVE_ANTERIOR equivocada`); }
        n++;
      }
      if (n) await c.query('UPDATE core.configuracion SET valor = $1 WHERE clave = $2', [fila.valor, seccion]);
      console.log(`  ${seccion}: ${n} secreto(s) vuelto(s) a cifrar`);
    }
    await c.query('COMMIT');
    console.log('✓ Secretos de Configuración listos con la llave de este servidor.');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(`✗ ${(e as Error).message}`); process.exit(1); });
