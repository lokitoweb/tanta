import { useEffect, useRef } from 'react';

/**
 * Para menús desplegables: cierra con un clic fuera del contenedor o con Esc.
 * El ref va en el elemento que envuelve al botón y al menú, para que el botón siga alternando.
 */
export function useCerrarAfuera(abierto: boolean, cerrar: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) cerrar(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') cerrar(); };
    document.addEventListener('pointerdown', fuera);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', fuera); document.removeEventListener('keydown', esc); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cerrar solo cambia un estado
  }, [abierto]);
  return ref;
}
