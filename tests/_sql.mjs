// Consulta de solo lectura/limpieza para las pruebas. En local usa el contenedor tanta-pg;
// en CI (Postgres como servicio, sin ese contenedor) usa psql con las variables PG*.
import { execFileSync } from 'node:child_process';

export function sql(consulta) {
  const args = ['-t', '-A', '-c', consulta];
  try {
    return execFileSync('docker', ['exec', 'tanta-pg', 'psql', '-U', 'tanta', '-d', 'tanta', ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return execFileSync('psql', args, { encoding: 'utf8' }).trim();
  }
}

/** Script de varias sentencias en silencio (-q): solo imprime lo que devuelven los SELECT. */
export function sqlScript(script) {
  const args = ['-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', script];
  try {
    return execFileSync('docker', ['exec', 'tanta-pg', 'psql', '-U', 'tanta', '-d', 'tanta', ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    // Sin Docker o sin el contenedor (CI): psql directo. Un error del SQL se propaga con su mensaje.
    const sinContenedor = e.code === 'ENOENT' || /No such container|cannot connect|not recognized/i.test(String(e.stderr ?? ''));
    if (!sinContenedor) throw new Error(String(e.stderr ?? e.message));
    return execFileSync('psql', args, { encoding: 'utf8' }).trim();
  }
}
