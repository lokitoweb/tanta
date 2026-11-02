import type { ReactNode } from 'react';
import { useApp } from '@/core/app-state';
import { Icon } from './icons';

export interface Columna<T> {
  key: string;
  header: string;
  align?: 'left' | 'right' | 'center';
  width?: string;
  /** Si se define, la columna solo se muestra al rol que tenga el permiso (field-level security). */
  permiso?: string;
  render?: (row: T) => ReactNode;
  valor?: (row: T) => string | number;
}

interface Props<T> {
  columnas: Array<Columna<T>>;
  filas: T[];
  clave: (row: T) => string;
  onFila?: (row: T) => void;
  densa?: boolean;
  vacio?: ReactNode;
}

export function Tabla<T>({ columnas, filas, clave, onFila, densa, vacio }: Props<T>) {
  const { puede } = useApp();
  const visibles = columnas.filter((c) => !c.permiso || puede(c.permiso));

  if (filas.length === 0 && vacio) return <>{vacio}</>;

  return (
    <div className={`table-wrap ${densa ? 'table-wrap--densa' : ''}`}>
      <table className="table">
        <thead>
          <tr>
            {visibles.map((c) => (
              <th key={c.key} style={{ width: c.width, textAlign: c.align ?? 'left' }}>{c.header}</th>
            ))}
            {onFila && <th className="table__chev" />}
          </tr>
        </thead>
        <tbody>
          {filas.map((fila) => (
            <tr key={clave(fila)} onClick={onFila ? () => onFila(fila) : undefined} className={onFila ? 'is-clickable' : ''}>
              {visibles.map((c) => (
                <td key={c.key} style={{ textAlign: c.align ?? 'left' }}>
                  {c.render ? c.render(fila) : String(c.valor ? c.valor(fila) : (fila as Record<string, unknown>)[c.key] ?? '')}
                </td>
              ))}
              {onFila && <td className="table__chev"><Icon name="chevron" size={15} /></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
