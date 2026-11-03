import { useState } from 'react';
import { Icon } from '@/ui/icons';

/** Rango en ISO (AAAA-MM-DD), ambos días incluidos. */
export interface Rango { desde: string; hasta: string }

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const deIso = (s: string) => { const [a, m, d] = s.split('-').map(Number); return new Date(a, m - 1, d); };
const dmy = (s: string) => s.split('-').reverse().join('/');
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

/** Accesos rápidos: se calculan al abrir, así "Hoy" siempre es hoy. */
function atajos(): Array<[string, Rango]> {
  const hoy = new Date();
  const menos = (n: number) => iso(new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - n));
  return [
    ['Hoy', { desde: iso(hoy), hasta: iso(hoy) }],
    ['Ayer', { desde: menos(1), hasta: menos(1) }],
    ['Últimos 7 días', { desde: menos(6), hasta: iso(hoy) }],
    ['Últimos 30 días', { desde: menos(29), hasta: iso(hoy) }],
    ['Este mes', { desde: iso(new Date(hoy.getFullYear(), hoy.getMonth(), 1)), hasta: iso(hoy) }],
    ['Mes anterior', { desde: iso(new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1)), hasta: iso(new Date(hoy.getFullYear(), hoy.getMonth(), 0)) }],
  ];
}

export function etiquetaRango(r: Rango): string {
  return atajos().find(([, x]) => x.desde === r.desde && x.hasta === r.hasta)?.[0] ?? 'Personalizado';
}

/**
 * Selector de rango: botón compacto (atajo · desde · hasta) que abre un panel con accesos rápidos,
 * calendario de un mes (primer clic = inicio, segundo = fin) y "Aplicar". Sin librerías.
 */
export function SelectorFechas({ valor, onChange }: { valor: Rango; onChange: (r: Rango) => void }) {
  const [abierto, setAbierto] = useState(false);
  const [borrador, setBorrador] = useState<Rango>(valor);
  const [eligiendoFin, setEligiendoFin] = useState(false);
  const [mes, setMes] = useState(() => { const d = deIso(valor.hasta); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const hoy = iso(new Date());

  const abrir = () => { setBorrador(valor); setEligiendoFin(false); const d = deIso(valor.hasta); setMes(new Date(d.getFullYear(), d.getMonth(), 1)); setAbierto(true); };
  const aplicar = (r = borrador) => { onChange(r); setAbierto(false); };
  const elegir = (d: string) => {
    if (!eligiendoFin) { setBorrador({ desde: d, hasta: d > borrador.hasta ? d : borrador.hasta }); setEligiendoFin(true); return; }
    setBorrador(d < borrador.desde ? { desde: d, hasta: borrador.desde } : { desde: borrador.desde, hasta: d });
    setEligiendoFin(false);
  };

  // Semanas de lunes a domingo, con los días de los meses vecinos atenuados.
  const inicio = new Date(mes.getFullYear(), mes.getMonth(), 1 - ((mes.getDay() + 6) % 7));
  const dias = Array.from({ length: 42 }, (_, i) => new Date(inicio.getFullYear(), inicio.getMonth(), inicio.getDate() + i));

  return (
    <div className="fechas">
      <button type="button" className="fechas__boton" onClick={abrir} aria-haspopup="dialog" aria-expanded={abierto}>
        <Icon name="clock" size={15} />
        <b>{etiquetaRango(valor)}</b>
        <span className="fechas__sep" />{dmy(valor.desde)}
        <span className="fechas__sep" />{dmy(valor.hasta)}
        <Icon name="down" size={14} />
      </button>
      {abierto && (
        <>
          <button className="cuenta__fondo" aria-label="Cerrar" onClick={() => setAbierto(false)} />
          <div className="fechas__panel" role="dialog" aria-label="Elegir rango de fechas">
            <div className="fechas__atajos">
              <p>Accesos rápidos</p>
              {atajos().map(([t, r]) => (
                <button key={t} type="button" className={r.desde === borrador.desde && r.hasta === borrador.hasta ? 'is-active' : ''} onClick={() => aplicar(r)}>
                  {t}{r.desde === borrador.desde && r.hasta === borrador.hasta && <Icon name="check" size={15} />}
                </button>
              ))}
            </div>
            <div className="fechas__cal">
              <div className="fechas__campos">
                {/* Solo muestran la fecha: se eligen en el calendario de abajo (sin un segundo calendario). */}
                <button type="button" className={!eligiendoFin ? 'is-activo' : ''} onClick={() => setEligiendoFin(false)}><span>Desde</span><b>{dmy(borrador.desde)}</b></button>
                <button type="button" className={eligiendoFin ? 'is-activo' : ''} onClick={() => setEligiendoFin(true)}><span>Hasta</span><b>{dmy(borrador.hasta)}</b></button>
              </div>
              <div className="fechas__mes">
                <button type="button" aria-label="Mes anterior" onClick={() => setMes(new Date(mes.getFullYear(), mes.getMonth() - 1, 1))}><Icon name="chevron" size={16} /></button>
                <b>{MESES[mes.getMonth()]} de {mes.getFullYear()}</b>
                <button type="button" aria-label="Mes siguiente" onClick={() => setMes(new Date(mes.getFullYear(), mes.getMonth() + 1, 1))}><Icon name="chevron" size={16} /></button>
              </div>
              <div className="fechas__grilla">
                {['L', 'M', 'X', 'J', 'V', 'S', 'D'].map((d) => <span key={d} className="fechas__dsem">{d}</span>)}
                {dias.map((d) => {
                  const s = iso(d);
                  const clase = [
                    d.getMonth() !== mes.getMonth() && 'is-fuera',
                    s >= borrador.desde && s <= borrador.hasta && 'is-rango',
                    (s === borrador.desde || s === borrador.hasta) && 'is-borde',
                    s === hoy && 'is-hoy',
                  ].filter(Boolean).join(' ');
                  return <button key={s} type="button" className={clase} onClick={() => elegir(s)}>{d.getDate()}</button>;
                })}
              </div>
              <div className="fechas__pie">
                <span>{eligiendoFin ? 'Elige el día final' : 'Elige el día inicial'}</span>
                <button type="button" className="btn btn--primary btn--sm" onClick={() => aplicar()}>Aplicar</button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
