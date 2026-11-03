import { useEffect, useRef, useState } from 'react';
import { leerConfigPublica, type ConfigPublica } from '@/core/api';
import { BrandMark } from '@/ui/primitives';

/**
 * Tarjeta de presentación del ingreso: se inclina con el puntero, un brillo sigue al cursor
 * y flota suavemente. Datos y logo vienen de Configuración (nada escrito en el código).
 * Con "reducir movimiento" activado en el sistema, queda quieta.
 */
export function TarjetaMarca() {
  const ref = useRef<HTMLDivElement>(null);
  const [cfg, setCfg] = useState<ConfigPublica | null>(null);
  useEffect(() => { leerConfigPublica().then(setCfg).catch(() => {}); }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let marco = 0;
    const mover = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      cancelAnimationFrame(marco);
      marco = requestAnimationFrame(() => {
        el.style.setProperty('--rx', `${(0.5 - y) * 14}deg`);
        el.style.setProperty('--ry', `${(x - 0.5) * 18}deg`);
        el.style.setProperty('--mx', `${x * 100}%`);
        el.style.setProperty('--my', `${y * 100}%`);
      });
    };
    const salir = () => { el.style.setProperty('--rx', '0deg'); el.style.setProperty('--ry', '0deg'); };
    const zona = el.parentElement ?? el;
    zona.addEventListener('pointermove', mover);
    zona.addEventListener('pointerleave', salir);
    return () => { zona.removeEventListener('pointermove', mover); zona.removeEventListener('pointerleave', salir); cancelAnimationFrame(marco); };
  }, []);

  const n = cfg?.negocio;
  return (
    <div className="tarjeta3d">
      <div className="tarjeta3d__tarjeta" ref={ref}>
        <div className="tarjeta3d__brillo" aria-hidden />
        <div className="tarjeta3d__cuerpo">
          <BrandMark variant="light" size="xl" />
        </div>
        {(n?.representante || n?.whatsapp) && (
          <div className="tarjeta3d__banda">
            <div>
              <p className="tarjeta3d__nombre">{n.representante}</p>
              <p className="tarjeta3d__rol">{n.nombre}</p>
            </div>
            {n.whatsapp && (
              <div className="tarjeta3d__contacto">
                <span>WhatsApp</span>
                <strong>{n.whatsapp}</strong>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
