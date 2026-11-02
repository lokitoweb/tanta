import type { ReactNode } from 'react';
import { Icon } from './icons';

/** Diálogo modal sencillo: fondo oscuro, tarjeta centrada, cierre con Escape. */
export function Dialogo({ abierto, titulo, descripcion, children, onCerrar, acciones }: {
  abierto: boolean;
  titulo: string;
  descripcion?: string;
  children: ReactNode;
  onCerrar: () => void;
  acciones?: ReactNode;
}) {
  if (!abierto) return null;
  return (
    <div
      className="dialogo__fondo"
      role="dialog"
      aria-modal="true"
      aria-label={titulo}
      onClick={onCerrar}
      onKeyDown={(e) => { if (e.key === 'Escape') onCerrar(); }}
      tabIndex={-1}
    >
      <div className="dialogo" onClick={(e) => e.stopPropagation()}>
        <header className="dialogo__head">
          <div>
            <h2 className="dialogo__titulo">{titulo}</h2>
            {descripcion && <p className="dialogo__desc">{descripcion}</p>}
          </div>
          <button className="dialogo__cerrar" onClick={onCerrar} aria-label="Cerrar">
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="dialogo__cuerpo">{children}</div>
        {acciones && <footer className="dialogo__pie">{acciones}</footer>}
      </div>
    </div>
  );
}
