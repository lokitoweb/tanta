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
