import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { money } from '@/core/format';
import { Boton, Encabezado, Insignia, Kpi, PilaEsqueleto, Tarjeta, TablaEsqueleto, Vacio } from '@/ui/primitives';

interface Apertura {
  codigo: string; estado: 'ABIERTA' | 'CERRADA'; montoInicial: number; pagado: number; saldo: number; abiertaEn: string; abiertaPor: string;
  cerradaEn: string | null; cerradaPor: string | null; montoContado: number | null; observacion: string | null;
  pagos: Array<{ codigo: string; compra: string; proveedor: string; monto: number; fecha: string; estado: string }>;
}
const fecha = (x: string) => new Date(x).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' });

/**
 * Caja chica de cada usuario que cobra (audio del cliente, 09/11/2026): la abre con un fondo que sale del efectivo de
 * caja grande (puede ser 0), paga sus gastos desde ella y al cerrarla cuenta el efectivo, que vuelve a caja grande.
 * Lo cobrado se rinde aparte en Cobranza (rendición del día) y también termina en caja grande.
 */
export function CajaChica() {
  const [datos, setDatos] = useState<{ abierta: Apertura | null; abiertas: Apertura[]; historial: Apertura[] } | null>(null);
  const [monto, setMonto] = useState('');
  const [contado, setContado] = useState('');
  const [obs, setObs] = useState('');
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger'; texto: string } | null>(null);
  const [cargaError, setCargaError] = useState<string | null>(null);
  const cargar = () => api<{ abierta: Apertura | null; abiertas: Apertura[]; historial: Apertura[] }>('/cajas/chica').then((d) => { setDatos(d); setCargaError(null); }).catch((e) => setCargaError(e.message));
  useEffect(() => { void cargar(); }, []);
  const accion = async (fn: () => Promise<string>) => {
    try { setAviso({ tono: 'ok', texto: await fn() }); await cargar(); } catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo completar.' }); }
  };
  const a = datos?.abierta;

  return (
    <>
      <Encabezado titulo="Caja chica" descripcion="Tu caja del día · el fondo sale del efectivo de caja grande · al cerrarla, lo contado vuelve a caja grande" />
      {aviso && <div className={`aviso aviso--${aviso.tono}`} role="status"><span className="aviso__icono">{aviso.tono === 'ok' ? '✓' : '!'}</span><div><p>{aviso.texto}</p></div></div>}
      {datos === null && !cargaError && <Tarjeta><PilaEsqueleto lineas={3} /></Tarjeta>}
      {a ? (<>
        <div className="grid grid--auto">
          <Kpi label="Disponible" valor={money(a.saldo)} nota={`${a.codigo} · abierta por ${a.abiertaPor}`} icono="wallet" />
          <Kpi label="Fondo inicial" valor={money(a.montoInicial)} nota={fecha(a.abiertaEn)} icono="clock" />
          <Kpi label="Gastos y pagos" valor={money(a.pagado)} nota={`${a.pagos.filter((p) => p.estado === 'VIGENTE').length} movimiento(s)`} icono="chart" />
        </div>
        <Tarjeta>
          <h3 className="card__title">Cerrar caja</h3>
          <p className="t-muted">Cuenta el efectivo que queda: vuelve a la caja grande y la diferencia queda registrada.</p>
          <div className="form form--2col">
            <label className="field"><span className="field__label">Efectivo contado (S/)</span>
              <input className="field__input" type="number" min="0" step="0.01" value={contado} onChange={(e) => setContado(e.target.value)} /></label>
            <label className="field"><span className="field__label">Observación</span>
              <input className="field__input" maxLength={200} value={obs} onChange={(e) => setObs(e.target.value)} /></label>
          </div>
          {contado !== '' && <p className="dialogo__nota">Esperado {money(a.saldo)} · diferencia {money(Number(contado) - a.saldo)}</p>}
          <div className="form__acciones"><Boton variant="primary" disabled={contado === '' || Number(contado) < 0} onClick={() => void accion(async () => {
            const r = await api<{ diferencia: number }>(`/cajas/chica/${a.codigo}/cerrar`, { method: 'POST', body: { montoContado: Number(contado), observacion: obs } });
            setContado(''); setObs('');
            return `Caja ${a.codigo} cerrada${r.diferencia ? ` con una diferencia de ${money(r.diferencia)}` : ' sin diferencias'}: ${money(Number(contado))} volvió a la caja grande.`;
          })}>Cerrar caja</Boton></div>
        </Tarjeta>
      </>) : datos && (
        <Tarjeta>
          <h3 className="card__title">Abrir caja chica</h3>
          <p className="t-muted">No tienes una caja abierta. El fondo sale del efectivo de la caja grande; si solo vas a cobrar, puede ser 0.</p>
          <div className="form form--2col">
            <label className="field"><span className="field__label">Fondo inicial (S/)</span>
              <input className="field__input" type="number" min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} /></label>
          </div>
          <div className="form__acciones"><Boton variant="primary" disabled={monto === '' || !(Number(monto) >= 0)} onClick={() => void accion(async () => {
            const r = await api<{ codigo: string }>('/cajas/chica/abrir', { method: 'POST', body: { montoInicial: Number(monto) } });
            setMonto('');
            return `Caja ${r.codigo} abierta con ${money(Number(monto))}.`;
          })}>Abrir caja</Boton></div>
        </Tarjeta>
      )}
      <Tarjeta padding="none">
        {datos && datos.abiertas.some((x) => x.codigo !== a?.codigo) && (
          <div className="card__head card__head--padded"><div><h3 className="card__title">Cajas abiertas ahora</h3>
            <p className="card__sub">{datos.abiertas.filter((x) => x.codigo !== a?.codigo).map((x) => `${x.codigo} · ${x.abiertaPor} · ${money(x.saldo)}`).join('  ·  ')}</p></div></div>
        )}
        {cargaError ? <Vacio titulo="No se pudo cargar" detalle={cargaError} onReintentar={() => { setCargaError(null); setDatos(null); void cargar(); }} />
          : datos === null ? <TablaEsqueleto columnas={7} />
          : !datos.historial.length ? <Vacio titulo="Sin aperturas de caja" icono="wallet" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Caja</th><th>Abierta</th><th>Cerrada</th><th className="t-right">Inicial</th><th className="t-right">Pagado</th><th className="t-right">Contado</th><th>Estado</th></tr></thead>
            <tbody>{datos.historial.map((h) => (
              <tr key={h.codigo}><td><strong>{h.codigo}</strong></td><td>{fecha(h.abiertaEn)} · {h.abiertaPor}</td><td>{h.cerradaEn ? `${fecha(h.cerradaEn)} · ${h.cerradaPor}` : '—'}</td>
                <td className="t-right">{money(h.montoInicial)}</td><td className="t-right">{money(h.pagado)}</td>
                <td className="t-right">{h.montoContado === null ? '—' : <>{money(h.montoContado)}{Math.abs(h.montoContado - h.saldo) > 0.005 && <small className="t-neg"> ({money(h.montoContado - h.saldo)})</small>}</>}</td>
                <td>{h.estado === 'ABIERTA' ? <Insignia tono="ok" punto>Abierta</Insignia> : <Insignia tono="neutral">Cerrada</Insignia>}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Tarjeta>
    </>
  );
}
