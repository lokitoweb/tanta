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

/** Caja chica (informe de compra de insumos 5.6): el vendedor la abre con un monto inicial; Administración paga compras desde ella. */
export function CajaChica() {
  const [datos, setDatos] = useState<{ abierta: Apertura | null; historial: Apertura[] } | null>(null);
  const [monto, setMonto] = useState('');
  const [contado, setContado] = useState('');
  const [obs, setObs] = useState('');
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger'; texto: string } | null>(null);
  const [cargaError, setCargaError] = useState<string | null>(null);
  const cargar = () => api<{ abierta: Apertura | null; historial: Apertura[] }>('/cajas/chica').then((d) => { setDatos(d); setCargaError(null); }).catch((e) => setCargaError(e.message));
  useEffect(() => { void cargar(); }, []);
  const accion = async (fn: () => Promise<string>) => {
    try { setAviso({ tono: 'ok', texto: await fn() }); await cargar(); } catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo completar.' }); }
  };
  const a = datos?.abierta;

  return (
    <>
      <Encabezado titulo="Caja chica" descripcion="Se abre con un monto inicial · Administración paga compras pequeñas desde aquí · al cerrar se cuenta el efectivo" />
      {aviso && <div className={`aviso aviso--${aviso.tono}`} role="status"><span className="aviso__icono">{aviso.tono === 'ok' ? '✓' : '!'}</span><div><p>{aviso.texto}</p></div></div>}
      {datos === null && !cargaError && <Tarjeta><PilaEsqueleto lineas={3} /></Tarjeta>}
      {a ? (<>
        <div className="grid grid--auto">
          <Kpi label="Disponible" valor={money(a.saldo)} nota={`${a.codigo} · abierta por ${a.abiertaPor}`} icono="wallet" />
          <Kpi label="Monto inicial" valor={money(a.montoInicial)} nota={fecha(a.abiertaEn)} icono="clock" />
          <Kpi label="Pagado a proveedores" valor={money(a.pagado)} nota={`${a.pagos.filter((p) => p.estado === 'VIGENTE').length} pago(s)`} icono="chart" />
        </div>
        <Tarjeta>
          <h3 className="card__title">Cerrar caja</h3>
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
            return `Caja ${a.codigo} cerrada${r.diferencia ? ` con una diferencia de ${money(r.diferencia)}` : ' sin diferencias'}.`;
          })}>Cerrar caja</Boton></div>
        </Tarjeta>
      </>) : datos && (
        <Tarjeta>
          <h3 className="card__title">Abrir caja chica</h3>
          <p className="t-muted">No hay caja abierta. Sin ella, Administración solo puede pagar desde caja grande.</p>
          <div className="form form--2col">
            <label className="field"><span className="field__label">Monto inicial (S/)</span>
              <input className="field__input" type="number" min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} /></label>
          </div>
          <div className="form__acciones"><Boton variant="primary" disabled={!(Number(monto) > 0)} onClick={() => void accion(async () => {
            const r = await api<{ codigo: string }>('/cajas/chica/abrir', { method: 'POST', body: { montoInicial: Number(monto) } });
            setMonto('');
            return `Caja ${r.codigo} abierta con ${money(Number(monto))}.`;
          })}>Abrir caja</Boton></div>
        </Tarjeta>
      )}
      <Tarjeta padding="none">
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
