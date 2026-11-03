import { useEffect, useMemo, useState } from 'react';
import { Icon } from './icons';

/** Corta una lista en páginas; vuelve a la 1 cuando cambia el total (p. ej. al buscar). */
export function usePaginado<T>(filas: T[], porPagina = 25) {
  const [pagina, setPagina] = useState(1);
  const paginas = Math.max(1, Math.ceil(filas.length / porPagina));
  useEffect(() => { setPagina(1); }, [filas.length]);
  const actual = Math.min(pagina, paginas);
  const visibles = useMemo(() => filas.slice((actual - 1) * porPagina, actual * porPagina), [filas, actual, porPagina]);
  return { visibles, pagina: actual, paginas, setPagina, total: filas.length, porPagina };
}

/** Filtra por texto sobre todos los campos visibles de cada fila (sin tildes ni mayúsculas). */
const normal = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export function filtrarTexto<T>(filas: T[], texto: string): T[] {
  const q = normal(texto.trim());
  if (!q) return filas;
  return filas.filter((f) => normal(Object.values(f as Record<string, unknown>).filter((v) => typeof v !== 'object').join(' ')).includes(q));
}

export function Paginador({ pagina, paginas, setPagina, total, porPagina }: ReturnType<typeof usePaginado<unknown>>) {
  if (total <= porPagina) return null;
  const desde = (pagina - 1) * porPagina + 1;
  const hasta = Math.min(total, pagina * porPagina);
  // Números alrededor de la página actual, con extremos siempre visibles.
  const nums = [...new Set([1, pagina - 1, pagina, pagina + 1, paginas])].filter((n) => n >= 1 && n <= paginas).sort((a, b) => a - b);
  return (
    <nav className="paginador" aria-label="Paginación">
      <span className="paginador__info">{desde}–{hasta} de {total.toLocaleString('es-PE')}</span>
      <div className="paginador__btns">
        <button type="button" aria-label="Página anterior" disabled={pagina === 1} onClick={() => setPagina(pagina - 1)}><Icon name="chevron" size={15} /></button>
        {nums.map((n, i) => (
          <span key={n} className="paginador__grupo">
            {i > 0 && n - nums[i - 1] > 1 && <span className="paginador__puntos">…</span>}
            <button type="button" className={n === pagina ? 'is-activo' : ''} aria-current={n === pagina ? 'page' : undefined} onClick={() => setPagina(n)}>{n}</button>
          </span>
        ))}
        <button type="button" aria-label="Página siguiente" disabled={pagina === paginas} onClick={() => setPagina(pagina + 1)}><Icon name="chevron" size={15} /></button>
      </div>
    </nav>
  );
}
