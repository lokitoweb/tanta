import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { useApp } from '@/core/app-state';
import { money } from '@/core/format';
import { Dialogo } from '@/ui/Dialogo';
import { Boton, Encabezado, Insignia, Kpi, Tarjeta, Vacio } from '@/ui/primitives';

interface Pago { codigo: string; fecha: string; caja: string; medio: string; monto: number; nroOperacion: string | null; estado: string; autoriza: string; motivoAnulacion: string | null; apertura: string | null }
interface Deuda { codigo: string; estadoPago: 'PENDIENTE' | 'PARCIAL' | 'PAGADO'; documento: string; fecha: string; vencePago: string | null; dias: number | null;
  proveedor: string; banco: string; cci: string; total: number; pagado: number; saldo: number; pagos: Pago[] }
interface Caja { codigo: string; saldo: number }

const TONO = { PENDIENTE: 'warn', PARCIAL: 'info', PAGADO: 'ok' } as const;
const MEDIOS = [['EFECTIVO', 'Efectivo'], ['TRANSFERENCIA', 'Transferencia bancaria'], ['YAPE', 'Yape'], ['PLIN', 'Plin'], ['OTRO', 'Otro']];

/**
 * Deudas por pagar (informe de compra de insumos v1.1): Administración decide la caja (chica o grande) y el medio
 * de cada pago; una deuda se puede pagar en partes y desde cajas distintas (RN-10 a RN-13).
 */
export function Deudas() {
  const { puede } = useApp();
  const [deudas, setDeudas] = useState<Deuda[]>([]);
  const [filtro, setFiltro] = useState<'abiertas' | 'PAGADO'>('abiertas');
  const [caja, setCaja] = useState<Caja | null>(null);
  const [ver, setVer] = useState<Deuda | null>(null);
  const [pago, setPago] = useState<{ caja: 'CHICA' | 'GRANDE'; medio: string; monto: string; nroOperacion: string } | null>(null);
  const [anular, setAnular] = useState<{ codigo: string; motivo: string } | null>(null);
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger'; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const paga = puede('compras.pagar');

  const cargar = async () => {
    const l = await api<Deuda[]>('/deudas-compra').catch((e) => { setAviso({ tono: 'danger', texto: e.message }); return [] as Deuda[]; });
    setDeudas(l);
    setVer((v) => (v ? l.find((x) => x.codigo === v.codigo) ?? null : v));
    if (paga) api<{ abierta: Caja | null }>('/cajas/chica').then((r) => setCaja(r.abierta)).catch(() => setCaja(null));
  };
  useEffect(() => { void cargar(); }, []);

  const filas = deudas.filter((d) => (filtro === 'PAGADO' ? d.estadoPago === 'PAGADO' : d.estadoPago !== 'PAGADO'));
  const porPagar = deudas.filter((d) => d.estadoPago !== 'PAGADO');
  const vencido = porPagar.filter((d) => (d.dias ?? 1) < 0).reduce((s, d) => s + d.saldo, 0);

  const digital = pago && !['EFECTIVO', 'OTRO'].includes(pago.medio);
  const monto = Number(pago?.monto);
  const errorPago = !pago || !ver ? '' : !(monto > 0) ? 'Indica el monto.' : monto > ver.saldo + 0.005 ? `No puede superar el saldo (${money(ver.saldo)}).`
    : pago.caja === 'CHICA' && !caja ? 'No hay caja chica abierta: el vendedor debe abrirla.'
      : pago.caja === 'CHICA' && caja && monto > caja.saldo + 0.005 ? `La caja chica solo tiene ${money(caja.saldo)}: paga el resto desde caja grande.`
        : digital && pago.nroOperacion.trim().length < 3 ? 'Indica el número de operación.' : '';

  const registrar = async () => {
    if (!pago || !ver) return;
    setOcupado(true);
    try {
      const r = await api<{ codigo: string; saldo: number; estadoPago: string }>(`/compras/${ver.codigo}/pagos`, { method: 'POST', conIdempotencia: true,
        body: { caja: pago.caja, medio: pago.medio, monto, nroOperacion: pago.nroOperacion.trim() } });
      setPago(null);
      setAviso({ tono: 'ok', texto: `Pago ${r.codigo} registrado: ${r.estadoPago === 'PAGADO' ? 'deuda cancelada' : `queda ${money(r.saldo)} por pagar`}.` });
      await cargar();
    } catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo registrar.' }); }
    finally { setOcupado(false); }
  };
  const anularPago = async () => {
    if (!anular) return;
    setOcupado(true);
    try {
      await api(`/pagos-compra/${anular.codigo}/anular`, { method: 'POST', body: { motivo: anular.motivo } });
      setAviso({ tono: 'ok', texto: `Pago ${anular.codigo} anulado: el saldo de la compra se recuperó.` });
      setAnular(null);
      await cargar();
    } catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo anular.' }); }
    finally { setOcupado(false); }
  };

  return (
    <>
      <Encabezado titulo="Deudas por pagar" descripcion="Compras verificadas por Almacén · Administración elige la caja y el medio de cada pago" />
      {aviso && <div className={`aviso aviso--${aviso.tono}`} role="status"><span className="aviso__icono">{aviso.tono === 'ok' ? '✓' : '!'}</span><div><p>{aviso.texto}</p></div></div>}
      <div className="grid grid--auto">
        <Kpi label="Por pagar" valor={money(porPagar.reduce((s, d) => s + d.saldo, 0))} nota={`${porPagar.length} compra(s)`} icono="wallet" />
        <Kpi label="Vencido" valor={money(vencido)} nota="saldo con vencimiento pasado" icono="alert" />
        {paga && <Kpi label="Caja chica" valor={caja ? money(caja.saldo) : 'Cerrada'} nota={caja ? `${caja.codigo} · disponible` : 'el vendedor la abre con un monto inicial'} icono="wallet" />}
      </div>
      <div className="toolbar"><div className="chips">
        <button className={`chipfilter ${filtro === 'abiertas' ? 'is-active' : ''}`} onClick={() => setFiltro('abiertas')}>Por pagar <b>{porPagar.length}</b></button>
        <button className={`chipfilter ${filtro === 'PAGADO' ? 'is-active' : ''}`} onClick={() => setFiltro('PAGADO')}>Pagadas <b>{deudas.length - porPagar.length}</b></button>
      </div></div>

      <Dialogo abierto={ver !== null} titulo={ver ? `${ver.codigo} · ${ver.proveedor}` : ''}
        descripcion={ver ? `${ver.documento} · ${ver.fecha}${ver.vencePago ? ` · vence ${ver.vencePago}` : ''}${ver.banco ? ` · ${ver.banco}${ver.cci ? ` CCI ${ver.cci}` : ''}` : ''}` : ''}
        onCerrar={() => { setVer(null); setPago(null); setAnular(null); }}
        acciones={ver && (pago
          ? <><Boton onClick={() => setPago(null)}>Volver</Boton><Boton variant="primary" disabled={!!errorPago || ocupado} onClick={() => void registrar()}>{ocupado ? 'Registrando…' : `Pagar ${money(monto || 0)}`}</Boton></>
          : anular ? <><Boton onClick={() => setAnular(null)}>Volver</Boton><Boton variant="primary" disabled={anular.motivo.trim().length < 5 || ocupado} onClick={() => void anularPago()}>Anular pago</Boton></>
            : <>{paga && ver.saldo > 0 && <Boton variant="primary" onClick={() => setPago({ caja: 'GRANDE', medio: 'TRANSFERENCIA', monto: ver.saldo.toFixed(2), nroOperacion: '' })}>Registrar pago</Boton>}
              <Boton onClick={() => setVer(null)}>Cerrar</Boton></>)}>
        {ver && (<>
          <p className="dialogo__nota">Total {money(ver.total)} · pagado {money(ver.pagado)} · <b>saldo {money(ver.saldo)}</b></p>
          {ver.pagos.length > 0 && (
            <div className="table-wrap"><table className="table table--compacta">
              <thead><tr><th>Pago</th><th>Fecha</th><th>Caja</th><th>Medio</th><th className="t-right">Monto</th><th>Estado</th><th /></tr></thead>
              <tbody>{ver.pagos.map((p) => (
                <tr key={p.codigo}>
                  <td>{p.codigo}</td><td>{new Date(p.fecha).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' })}</td>
                  <td>{p.caja === 'CHICA' ? `Chica ${p.apertura ?? ''}` : 'Grande'}</td>
                  <td>{p.medio.toLowerCase()}{p.nroOperacion ? ` · ${p.nroOperacion}` : ''}</td>
                  <td className="t-right">{money(p.monto)}</td>
                  <td>{p.estado === 'VIGENTE' ? <Insignia tono="ok">Vigente</Insignia> : <Insignia tono="neutral">Anulado</Insignia>}</td>
                  <td>{paga && p.estado === 'VIGENTE' && !pago && !anular && <Boton onClick={() => setAnular({ codigo: p.codigo, motivo: '' })}>Anular</Boton>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
          {pago && (
            <div className="form form--2col form--dialogo">
              <label className="field"><span className="field__label">Caja</span>
                <select className="field__input" value={pago.caja} onChange={(e) => setPago({ ...pago, caja: e.target.value as 'CHICA' | 'GRANDE', medio: e.target.value === 'CHICA' ? 'EFECTIVO' : pago.medio })}>
                  <option value="GRANDE">Caja grande</option><option value="CHICA">Caja chica{caja ? ` (${money(caja.saldo)} disponible)` : ' (cerrada)'}</option></select></label>
              <label className="field"><span className="field__label">Medio</span>
                <select className="field__input" value={pago.medio} disabled={pago.caja === 'CHICA'} onChange={(e) => setPago({ ...pago, medio: e.target.value })}>
                  {MEDIOS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
              <label className="field"><span className="field__label">Monto (S/)</span>
                <input className="field__input" type="number" min="0" step="0.01" max={ver.saldo} value={pago.monto} onChange={(e) => setPago({ ...pago, monto: e.target.value })} /></label>
              <label className="field"><span className="field__label">N.° de operación{digital ? '' : ' (opcional)'}</span>
                <input className="field__input" maxLength={30} value={pago.nroOperacion} onChange={(e) => setPago({ ...pago, nroOperacion: e.target.value.toUpperCase() })} /></label>
              {errorPago && <span className="field__aviso field--ancho">{errorPago}</span>}
            </div>
          )}
          {anular && (
            <label className="field"><span className="field__label">Motivo para anular {anular.codigo}</span>
              <input className="field__input" autoFocus maxLength={300} value={anular.motivo} onChange={(e) => setAnular({ ...anular, motivo: e.target.value })} /></label>
          )}
        </>)}
      </Dialogo>

      <Tarjeta padding="none">
        {!filas.length ? <Vacio titulo={filtro === 'PAGADO' ? 'Aún no hay compras pagadas' : 'No hay deudas por pagar'} icono="wallet" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Compra</th><th>Proveedor</th><th>Documento</th><th>Vence</th><th className="t-right">Total</th><th className="t-right">Saldo</th><th>Estado</th></tr></thead>
            <tbody>{filas.map((d) => (
              <tr key={d.codigo} className="is-clickable" onClick={() => { setPago(null); setAnular(null); setVer(d); }}>
                <td><strong>{d.codigo}</strong></td><td>{d.proveedor}</td><td>{d.documento}</td>
                <td>{d.vencePago ? <span className={(d.dias ?? 0) < 0 && d.saldo > 0 ? 't-neg' : ''}>{d.vencePago}{d.saldo > 0 && d.dias !== null ? ` · ${d.dias < 0 ? `vencida hace ${-d.dias} d` : d.dias === 0 ? 'hoy' : `en ${d.dias} d`}` : ''}</span> : '—'}</td>
                <td className="t-right">{money(d.total)}</td><td className="t-right"><strong>{money(d.saldo)}</strong></td>
                <td><Insignia tono={TONO[d.estadoPago]} punto>{d.estadoPago.toLowerCase()}</Insignia></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Tarjeta>
    </>
  );
}
