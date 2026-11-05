import { Paginador, filtrarTexto, usePaginado } from './Paginador';
import { Buscador } from './primitives';
import { useMemo, useState } from 'react';
import { money, num2, pct } from '@/core/format';
import { Insignia } from './primitives';
import { Icon } from './icons';

export interface ColRep { key: string; label: string; tipo?: 'dinero' | 'pct' | 'num' | 'texto' | 'fecha' | 'semaforo' }
type Fila = Record<string, unknown>;

const SEMAFORO: Record<string, { tono: 'ok' | 'warn' | 'danger'; txt: string }> = {
  verde: { tono: 'ok', txt: 'En objetivo' }, ambar: { tono: 'warn', txt: 'Cerca' }, rojo: { tono: 'danger', txt: 'Bajo objetivo' },
};

export function formatear(v: unknown, tipo?: ColRep['tipo'], fila?: Fila): React.ReactNode {
  if (v === null || v === undefined || v === '') return <span className="t-muted">—</span>;
  if (typeof v === 'boolean') return <Insignia tono={v ? 'ok' : 'neutral'} punto>{v ? 'Sí' : 'No'}</Insignia>;
  const t = (fila?.tipo && tipo === 'dinero') ? fila.tipo as ColRep['tipo'] : tipo; // filas que traen su propio tipo (G-01, G-09)
  if (t === 'dinero') return money(v as number);
  if (t === 'pct') return pct(v as number);
  if (t === 'num') return Number.isInteger(v) ? (v as number).toLocaleString('es-PE') : num2(v as number);
  if (t === 'fecha') return String(v).slice(0, 16).replace('T', ' ');
  if (t === 'semaforo') { const s = SEMAFORO[String(v)]; return s ? <Insignia tono={s.tono} punto>{s.txt}</Insignia> : String(v); }
  return String(v);
}

/** Tabla de reporte: columnas tipadas, orden por clic, buscador, paginación y totales de columnas de dinero. */
export function TablaReporte({ columnas, filas, onFila, onEliminar }: { columnas: ColRep[]; filas: Fila[]; onFila?: (f: Fila) => void;
  /** Si existe, cada fila muestra un botón de eliminar (no abre la edición). */
  onEliminar?: (f: Fila) => void }) {
  const [orden, setOrden] = useState<{ key: string; asc: boolean } | null>(null);
  const [texto, setTexto] = useState('');
  const ordenadas = useMemo(() => {
    const base = filtrarTexto(filas, texto);
    if (!orden) return base;
    return [...base].sort((a, b) => {
      const x = a[orden.key], y = b[orden.key];
      const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''), 'es');
      return orden.asc ? r : -r;
    });
  }, [filas, orden, texto]);
  const pag = usePaginado(ordenadas, 50);
  const sumables = columnas.filter((c) => c.tipo === 'dinero' && filas.length > 1 && filas.every((f) => typeof f[c.key] === 'number' && !f.tipo));

  return (
    <>
    {filas.length > 10 && <div className="tabla__barra"><Buscador valor={texto} onChange={setTexto} placeholder="Buscar en el reporte…" /><span className="t-muted">{ordenadas.length} filas</span></div>}
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>{columnas.map((c) => {
            const der = ['dinero', 'pct', 'num'].includes(c.tipo ?? '');
            const activo = orden?.key === c.key;
            return (
              <th key={c.key} className={der ? 't-right' : ''} aria-sort={activo ? (orden!.asc ? 'ascending' : 'descending') : 'none'}>
                <button className="th-orden" onClick={() => setOrden({ key: c.key, asc: activo ? !orden!.asc : false })}>
                  {c.label}{activo ? (orden!.asc ? ' ↑' : ' ↓') : ''}
                </button>
              </th>);
          })}{onEliminar && <th className="t-right"><span className="sr-only">Acciones</span></th>}</tr>
        </thead>
        <tbody>
          {pag.visibles.map((f, i) => (
            <tr key={i} className={onFila ? 'is-clickable' : ''} onClick={onFila ? () => onFila(f) : undefined}>
              {columnas.map((c) => (
                <td key={c.key} className={`${['dinero', 'pct', 'num'].includes(c.tipo ?? '') ? 't-right' : ''} ${c.tipo === 'pct' && typeof f[c.key] === 'number' && (f[c.key] as number) < 0 ? 't-neg' : ''}`}>
                  {formatear(f[c.key], c.tipo, f)}
                </td>))}
              {onEliminar && (
                <td className="t-right">
                  <button type="button" className="btn-icono btn-icono--peligro" title="Eliminar" aria-label={`Eliminar ${String(f[columnas[0]?.key] ?? '')}`}
                    onClick={(e) => { e.stopPropagation(); onEliminar(f); }}><Icon name="trash" size={16} /></button>
                </td>)}
            </tr>
          ))}
        </tbody>
        {sumables.length > 0 && (
          <tfoot><tr>{columnas.map((c, i) => (
            <td key={c.key} className={sumables.includes(c) ? 't-right' : ''}>
              {i === 0 ? <strong>Total</strong> : sumables.includes(c) ? <strong>{money(filas.reduce((s, f) => s + (f[c.key] as number), 0))}</strong> : null}
            </td>))}</tr></tfoot>
        )}
      </table>
    </div>
    <Paginador {...pag} />
    </>
  );
}
