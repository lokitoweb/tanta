import { useEffect, useState } from 'react';
import { leerConfigPublica, urlApi, type ConfigPublica } from '@/core/api';

// Fondos incluidos: se usan mientras no se suban fotos en Configuración → Marca.
const INCLUIDOS = ['/ingreso/horno.svg', '/ingreso/vitrina.svg', '/ingreso/mesa.svg'];

/** Fondos del panel de ingreso que se reemplazan con un fundido. Con «reducir movimiento» no rotan solos. */
export function FondosIngreso() {
  const [marca, setMarca] = useState<ConfigPublica['marca'] | null>(null);
  const [actual, setActual] = useState(0);
  useEffect(() => { leerConfigPublica().then((c) => setMarca(c.marca)).catch(() => {}); }, []);

  const propios = marca?.fondosIngreso ?? [];
  const fondos = propios.length ? propios.map((id) => urlApi(`/archivos/${id}`)) : INCLUIDOS;
  const segundos = marca?.fondoSegundos ?? 7;

  // Depende de `actual`: al elegir un fondo a mano, el tiempo vuelve a contar desde cero.
  useEffect(() => {
    if (fondos.length < 2 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const t = setTimeout(() => setActual((i) => (i + 1) % fondos.length), segundos * 1000);
    return () => clearTimeout(t);
  }, [actual, fondos.length, segundos]);

  // Evita mostrar los incluidos un instante antes de las fotos propias.
  if (!marca) return null;
  return (
    <div className="fondos-ingreso">
      {fondos.map((src, i) => <img key={src} src={src} alt="" className={`fondos-ingreso__img ${propios.length ? '' : 'fondos-ingreso__img--incluido'} ${i === actual ? 'is-activo' : ''}`} />)}
      {fondos.length > 1 && (
        <div className="fondos-ingreso__puntos">
          {fondos.map((src, i) => (
            <button key={src} type="button" className={i === actual ? 'is-activo' : ''} aria-label={`Ver fondo ${i + 1}`} onClick={() => setActual(i)}><i /></button>
          ))}
        </div>
      )}
    </div>
  );
}
