import { useMemo, useState } from 'react';
import { money, num2, pct } from '@/core/format';
import { Insignia } from './primitives';

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

/** Tabla de reporte: columnas tipadas, orden por clic y totales de columnas de dinero. */
export function TablaReporte({ columnas, filas, onFila }: { columnas: ColRep[]; filas: Fila[]; onFila?: (f: Fila) => void }) {
  const [orden, setOrden] = useState<{ key: string; asc: boolean } | null>(null);
  const ordenadas = useMemo(() => {
    if (!orden) return filas;
    return [...filas].sort((a, b) => {
      const x = a[orden.key], y = b[orden.key];
      const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''), 'es');
      return orden.asc ? r : -r;
    });
  }, [filas, orden]);
  const sumables = columnas.filter((c) => c.tipo === 'dinero' && filas.length > 1 && filas.every((f) => typeof f[c.key] === 'number' && !f.tipo));

  return (
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
          })}</tr>
        </thead>
        <tbody>
          {ordenadas.map((f, i) => (
            <tr key={i} className={onFila ? 'is-clickable' : ''} onClick={onFila ? () => onFila(f) : undefined}>
              {columnas.map((c) => (
                <td key={c.key} className={`${['dinero', 'pct', 'num'].includes(c.tipo ?? '') ? 't-right' : ''} ${c.tipo === 'pct' && typeof f[c.key] === 'number' && (f[c.key] as number) < 0 ? 't-neg' : ''}`}>
                  {formatear(f[c.key], c.tipo, f)}
                </td>))}
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
  );
}
