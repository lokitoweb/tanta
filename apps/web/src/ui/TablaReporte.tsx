import { Paginador, filtrarTexto, usePaginado } from './Paginador';
import { Buscador } from './primitives';
import { useMemo, useState } from 'react';
import { money, num2, pct } from '@/core/format';
import { Insignia } from './primitives';
import { Icon, type NombreIcono } from './icons';

/** Botón de una fila (Anular, Ajustar precio…): no abre la edición. visible decide si aplica a esa fila. */
export interface AccionFila { etiqueta: string | ((f: Fila) => string); icono: NombreIcono | ((f: Fila) => NombreIcono); onClick: (f: Fila) => void; visible?: (f: Fila) => boolean; peligro?: boolean | ((f: Fila) => boolean) }
const valorDe = <T,>(v: T | ((f: Fila) => T), f: Fila): T => (typeof v === 'function' ? (v as (f: Fila) => T)(f) : v);

export interface ColRep { key: string; label: string; tipo?: 'dinero' | 'pct' | 'num' | 'texto' | 'fecha' | 'semaforo' }
type Fila = Record<string, unknown>;

const SEMAFORO: Record<string, { tono: 'ok' | 'warn' | 'danger'; txt: string }> = {
  verde: { tono: 'ok', txt: 'En objetivo' }, ambar: { tono: 'warn', txt: 'Cerca' }, rojo: { tono: 'danger', txt: 'Bajo objetivo' },
};

export function formatear(v: unknown, tipo?: ColRep['tipo'], fila?: Fila): React.ReactNode {
  if (v === null || v === undefined || v === '') return <span className="t-muted">—</span>;
  if (typeof v === 'boolean') return <Insignia tono={v ? 'ok' : 'neutral'} punto>{v ? 'Sí' : 'No'}</Insignia>;
  // Filas de reporte que traen su propio formato (G-01, G-09); un campo «tipo» de negocio (tipo de insumo) no cuenta.
  const t = (tipo === 'dinero' && ['dinero', 'pct', 'num'].includes(String(fila?.tipo))) ? fila!.tipo as ColRep['tipo'] : tipo;
  if (t === 'dinero') return money(v as number);
  if (t === 'pct') return pct(v as number);
  if (t === 'num') return Number.isInteger(v) ? (v as number).toLocaleString('es-PE') : num2(v as number);
  if (t === 'fecha') return String(v).slice(0, 16).replace('T', ' ');
  if (t === 'semaforo') { const s = SEMAFORO[String(v)]; return s ? <Insignia tono={s.tono} punto>{s.txt}</Insignia> : String(v); }
  return String(v);
}

/** Tabla de reporte: columnas tipadas, orden por clic, buscador, paginación y totales de columnas de dinero. */
export function TablaReporte({ columnas, filas, onFila, onEliminar, acciones = [] }: { columnas: ColRep[]; filas: Fila[]; onFila?: (f: Fila) => void; acciones?: AccionFila[];
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
  // El total sigue a la búsqueda: suma lo que se ve, no todo el reporte.
  const sumables = columnas.filter((c) => c.tipo === 'dinero' && ordenadas.length > 1 && ordenadas.every((f) => typeof f[c.key] === 'number' && !f.tipo));

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
          })}{(onEliminar || acciones.length > 0) && <th className="t-right"><span className="sr-only">Acciones</span></th>}</tr>
        </thead>
        <tbody>
          {pag.visibles.map((f, i) => (
            <tr key={i} className={onFila ? 'is-clickable' : ''} onClick={onFila ? () => onFila(f) : undefined}>
              {columnas.map((c) => (
                <td key={c.key} className={`${['dinero', 'pct', 'num'].includes(c.tipo ?? '') ? 't-right' : ''} ${c.tipo === 'pct' && typeof f[c.key] === 'number' && (f[c.key] as number) < 0 ? 't-neg' : ''}`}>
                  {formatear(f[c.key], c.tipo, f)}
                </td>))}
              {(onEliminar || acciones.length > 0) && (
                <td className="t-right t-acciones">
                  {acciones.filter((a) => !a.visible || a.visible(f)).map((a) => {
                    const etiqueta = valorDe(a.etiqueta, f);
                    return (
                      <button key={etiqueta} type="button" className={`btn-icono ${valorDe(a.peligro ?? false, f) ? 'btn-icono--peligro' : ''}`} title={etiqueta}
                        aria-label={`${etiqueta} ${String(f[columnas[1]?.key] ?? f[columnas[0]?.key] ?? '')}`}
                        onClick={(e) => { e.stopPropagation(); a.onClick(f); }}><Icon name={valorDe(a.icono, f)} size={16} /></button>);
                  })}
                  {onEliminar && (
                  <button type="button" className="btn-icono btn-icono--peligro" title="Eliminar" aria-label={`Eliminar ${String(f[columnas[0]?.key] ?? '')}`}
                    onClick={(e) => { e.stopPropagation(); onEliminar(f); }}><Icon name="trash" size={16} /></button>)}
                </td>)}
            </tr>
          ))}
        </tbody>
        {sumables.length > 0 && (
          <tfoot><tr>{columnas.map((c, i) => (
            <td key={c.key} className={sumables.includes(c) ? 't-right' : ''}>
              {i === 0 ? <strong>Total</strong> : sumables.includes(c) ? <strong>{money(ordenadas.reduce((s, f) => s + (f[c.key] as number), 0))}</strong> : null}
            </td>))}</tr></tfoot>
        )}
      </table>
    </div>
    <Paginador {...pag} />
    </>
  );
}
