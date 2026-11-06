import { useCatalogos } from '@/core/catalogos';
import { money } from '@/core/format';
import { Icon } from '@/ui/icons';
import { Boton } from '@/ui/primitives';

/** Una forma de pago del cobro (efectivo, Yape…). Un pago puede tener varias: un solo recibo. */
export interface LineaPago { monto: string; medio: string; referencia: string }

/** Medios habilitados para cobranza y utilidades: lo usan «Registrar pago» y «Entregar y cobrar». */
export function useMediosCobro() {
  const medios = useCatalogos().mediosPago.filter((m) => m.enCobranza);
  const nombre = (medio: string) => medios.find((m) => m.codigo === medio)?.nombre ?? medio;
  const pideOperacion = (medio: string) => !!medios.find((m) => m.codigo === medio)?.requiereOperacion;
  const lineaNueva = (monto: number, medio = medios[0]?.codigo ?? ''): LineaPago => ({ monto: monto > 0 ? monto.toFixed(2) : '', medio, referencia: '' });
  /** Cuánto se cobra, cuánto queda y el primer dato que falta (null = listo para enviar). */
  const revisar = (lineas: LineaPago[], debe: number) => {
    const suma = lineas.reduce((s, l) => s + (Number(l.monto) || 0), 0);
    const sinOp = lineas.find((l) => pideOperacion(l.medio) && l.referencia.trim().length < 3);
    const problema = lineas.some((l) => !(Number(l.monto) > 0)) ? 'Indica el monto de cada forma de pago.'
      : suma > debe + 0.001 ? `Supera lo que debe (${money(debe)}).`
      : sinOp ? `Falta el N.° de operación de ${nombre(sinOp.medio)}.` : null;
    return { suma, queda: debe - suma, problema };
  };
  const aPagos = (lineas: LineaPago[]) => lineas.map((l) => ({ monto: Number(Number(l.monto).toFixed(2)), medio: l.medio, referencia: l.referencia.trim() }));
  return { medios, nombre, pideOperacion, lineaNueva, revisar, aPagos };
}

/** Filas de formas de pago con «Agregar otra», el resumen (cobras / queda) y lo que falta. Va dentro de un .form--2col. */
export function LineasPago({ lineas, onChange, debe }: { lineas: LineaPago[]; onChange: (l: LineaPago[]) => void; debe: number }) {
  const { medios, pideOperacion, lineaNueva, revisar } = useMediosCobro();
  const { suma, queda, problema } = revisar(lineas, debe);
  const cambiar = (i: number, c: Partial<LineaPago>) => onChange(lineas.map((l, j) => (j === i ? { ...l, ...c } : l)));
  // La nueva forma propone lo que falta y un medio distinto a los ya usados.
  const agregar = () => onChange([...lineas, lineaNueva(Math.max(queda, 0), medios.find((m) => !lineas.some((l) => l.medio === m.codigo))?.codigo)]);
  return (
    <>
      {lineas.map((l, i) => (
        <div key={i} className="pago-linea field--ancho">
          <label className="field"><span className="field__label">{lineas.length > 1 ? `Forma de pago ${i + 1}` : 'Forma de pago'}</span>
            <select className="field__input" value={l.medio} onChange={(e) => cambiar(i, { medio: e.target.value })}>{medios.map((m) => <option key={m.codigo} value={m.codigo}>{m.nombre}</option>)}</select></label>
          <label className="field"><span className="field__label">Monto (S/)</span>
            <input className="field__input" type="number" min="0.01" step="0.01" value={l.monto} onChange={(e) => cambiar(i, { monto: e.target.value })} /></label>
          <label className="field"><span className="field__label">N.° de operación {pideOperacion(l.medio) ? '(obligatorio)' : '(opcional)'}</span>
            <input className="field__input" maxLength={60} value={l.referencia} onChange={(e) => cambiar(i, { referencia: e.target.value })} /></label>
          {lineas.length > 1 && <button type="button" className="pago-linea__quitar" aria-label="Quitar forma de pago" onClick={() => onChange(lineas.filter((_, j) => j !== i))}><Icon name="close" size={16} /></button>}
        </div>
      ))}
      {lineas.length < 5 && <div className="field--ancho"><Boton icono="plus" onClick={agregar}>Agregar otra forma de pago</Boton></div>}
      <div className="pago-resumen field--ancho">
        <span>Cobras <b>{money(suma)}</b></span>
        <span className={queda > 0.009 ? 't-warn' : 't-ok'}>{queda > 0.009 ? <>Queda por cobrar <b>{money(queda)}</b></> : 'Cuenta saldada'}</span>
      </div>
      {problema && <span className="field__aviso field--ancho">{problema}</span>}
    </>
  );
}
