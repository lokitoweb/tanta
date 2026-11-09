import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { money } from '@/core/format';
import type { MedioPago } from '@/core/catalogos';

export interface Origen { caja: 'CHICA' | 'GRANDE'; aperturaCodigo: string; cuentaCaja: string }
interface Abierta { codigo: string; saldo: number; abiertaPor: string; propia?: boolean }
interface Cuenta { codigo: string; nombre: string; saldo: number }

/** Cajas abiertas y cuentas de caja grande con su saldo, para elegir de dónde sale un pago. */
export function useCajas(activo: boolean) {
  const [abiertas, setAbiertas] = useState<Abierta[]>([]);
  const [cuentas, setCuentas] = useState<Cuenta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const cargar = () => {
    if (!activo) return;
    Promise.all([api<{ abiertas: Abierta[] }>('/cajas/chica'), api<Cuenta[]>('/caja-grande/cuentas')])
      .then(([c, k]) => { setAbiertas(c.abiertas ?? []); setCuentas(k); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : 'No se pudieron leer las cajas.'));
  };
  useEffect(cargar, [activo]); // eslint-disable-line react-hooks/exhaustive-deps
  return { abiertas, cuentas, error, recargar: cargar };
}

/** Origen inicial de un pago: caja grande, con la cuenta asignada al medio (o la primera). */
export const origenInicial = (cuentas: Cuenta[], medio?: MedioPago): Origen =>
  ({ caja: 'GRANDE', aperturaCodigo: '', cuentaCaja: medio?.cuentaCaja ?? cuentas[0]?.codigo ?? '' });

/** Cuánto hay disponible en el origen elegido (para avisar antes de enviar). */
export function disponible(o: Origen, cajas: { abiertas: Abierta[]; cuentas: Cuenta[] }) {
  if (o.caja === 'CHICA') {
    const a = cajas.abiertas.find((x) => x.codigo === o.aperturaCodigo);
    return a ? { saldo: a.saldo, nombre: `la caja chica ${a.codigo}` } : null;
  }
  const k = cajas.cuentas.find((x) => x.codigo === o.cuentaCaja);
  return k ? { saldo: k.saldo, nombre: k.nombre } : null;
}

/** Caja (grande o chica) y, según cuál, la cuenta de caja grande o la caja chica abierta de la que sale el dinero. */
export function SelectorOrigen({ valor, onChange, cajas, medios, medio, onMedio }: {
  valor: Origen; onChange: (o: Origen) => void; cajas: { abiertas: Abierta[]; cuentas: Cuenta[] };
  medios: MedioPago[]; medio: string; onMedio: (m: string) => void;
}) {
  const deCaja = (c: string) => medios.filter((m) => c !== 'CHICA' || m.cajaChica);
  const cambiarCaja = (caja: 'CHICA' | 'GRANDE') => {
    const ms = deCaja(caja);
    const m = ms.some((x) => x.codigo === medio) ? medio : (ms[0]?.codigo ?? '');
    onMedio(m);
    const propia = cajas.abiertas.find((a) => a.propia) ?? cajas.abiertas[0];
    onChange({ caja, aperturaCodigo: caja === 'CHICA' ? (propia?.codigo ?? '') : '',
      cuentaCaja: caja === 'GRANDE' ? (medios.find((x) => x.codigo === m)?.cuentaCaja ?? cajas.cuentas[0]?.codigo ?? '') : '' });
  };
  return (
    <>
      <label className="field"><span className="field__label">Caja</span>
        <select className="field__input" value={valor.caja} onChange={(e) => cambiarCaja(e.target.value as 'CHICA' | 'GRANDE')}>
          <option value="GRANDE">Caja grande</option>
          <option value="CHICA" disabled={!cajas.abiertas.length}>Caja chica{cajas.abiertas.length ? '' : ' (ninguna abierta)'}</option>
        </select></label>
      <label className="field"><span className="field__label">Medio</span>
        <select className="field__input" value={medio} onChange={(e) => {
          onMedio(e.target.value);
          // En caja grande, el medio sugiere su cuenta (Yape → su cuenta); se puede cambiar.
          const cta = medios.find((x) => x.codigo === e.target.value)?.cuentaCaja;
          if (valor.caja === 'GRANDE' && cta) onChange({ ...valor, cuentaCaja: cta });
        }}>
          {deCaja(valor.caja).map((m) => <option key={m.codigo} value={m.codigo}>{m.nombre}</option>)}
        </select></label>
      {valor.caja === 'GRANDE' ? (
        <label className="field field--ancho"><span className="field__label">Sale de la cuenta</span>
          <select className="field__input" value={valor.cuentaCaja} onChange={(e) => onChange({ ...valor, cuentaCaja: e.target.value })}>
            {cajas.cuentas.map((k) => <option key={k.codigo} value={k.codigo}>{k.nombre} · {money(k.saldo)} disponible</option>)}
          </select>
          <span className="field__ayuda">Las cuentas y su saldo se ven en Operación → Caja grande.</span></label>
      ) : (
        <label className="field field--ancho"><span className="field__label">Caja chica</span>
          <select className="field__input" value={valor.aperturaCodigo} onChange={(e) => onChange({ ...valor, aperturaCodigo: e.target.value })}>
            {cajas.abiertas.map((a) => <option key={a.codigo} value={a.codigo}>{a.codigo} · {a.abiertaPor} · {money(a.saldo)} disponible</option>)}
          </select></label>
      )}
    </>
  );
}
