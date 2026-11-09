import { VerComprobante } from '@/ui/VerComprobante';
import { useEffect, useState } from 'react';
import { api, urlApi } from '@/core/api';
import { imagenABase64 } from '@/core/imagen';
import { useCatalogos } from '@/core/catalogos';
import { useApp } from '@/core/app-state';
import { money } from '@/core/format';
import { Dialogo } from '@/ui/Dialogo';
import { Boton, Encabezado, Insignia, Kpi, Tarjeta, TablaEsqueleto, Vacio } from '@/ui/primitives';
import { SelectorOrigen, disponible, origenInicial, useCajas, type Origen } from './OrigenPago';

interface Pago { codigo: string; fecha: string; caja: string; cuenta?: string | null; medio: string; monto: number; nroOperacion: string | null; estado: string; autoriza: string; motivoAnulacion: string | null; apertura: string | null; comprobanteUrl: string | null }
interface Deuda { codigo: string; estadoPago: 'PENDIENTE' | 'PARCIAL' | 'PAGADO'; documento: string; fecha: string; vencePago: string | null; dias: number | null;
  proveedor: string; ruc: string; cuentas: Array<{ banco: string; numero: string }>; total: number; pagado: number; saldo: number; pagos: Pago[] }

const TONO = { PENDIENTE: 'warn', PARCIAL: 'info', PAGADO: 'ok' } as const;

/**
 * Deudas por pagar (informe de compra de insumos v1.1): Administración decide la caja (chica o grande) y el medio
 * de cada pago; una deuda se puede pagar en partes y desde cajas distintas (RN-10 a RN-13).
 */
export function Deudas() {
  const { puede } = useApp();
  // null = cargando (esqueleto); [] = cargó y no hay deudas.
  const [lista, setLista] = useState<Deuda[] | null>(null);
  const [cargaError, setCargaError] = useState<string | null>(null);
  const deudas = lista ?? [];
  const [filtro, setFiltro] = useState<'abiertas' | 'PAGADO'>('abiertas');
  const [ver, setVer] = useState<Deuda | null>(null);
  const [pago, setPago] = useState<{ origen: Origen; medio: string; monto: string; nroOperacion: string; comprobante: string | null } | null>(null);
  const [anular, setAnular] = useState<{ codigo: string; motivo: string } | null>(null);
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger'; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const paga = puede('compras.pagar');
  const medios = useCatalogos().mediosPago.filter((m) => m.enCompras);
  const cajas = useCajas(paga);

  const cargar = async () => {
    cajas.recargar();
    const l = await api<Deuda[]>('/deudas-compra').catch((e) => { setCargaError(e.message); return null; });
    if (!l) return;
    setLista(l);
    setCargaError(null);
    setVer((v) => (v ? l.find((x) => x.codigo === v.codigo) ?? null : v));
  };
  useEffect(() => { void cargar(); }, []);

  const filas = deudas.filter((d) => (filtro === 'PAGADO' ? d.estadoPago === 'PAGADO' : d.estadoPago !== 'PAGADO'));
  const porPagar = deudas.filter((d) => d.estadoPago !== 'PAGADO');
  const vencido = porPagar.filter((d) => (d.dias ?? 1) < 0).reduce((s, d) => s + d.saldo, 0);

  const digital = !!pago && !!medios.find((m) => m.codigo === pago.medio)?.requiereOperacion;
  const origen = pago ? disponible(pago.origen, cajas) : null;
  const monto = Number(pago?.monto);
  const errorPago = !pago || !ver ? '' : !(monto > 0) ? 'Indica el monto.' : monto > ver.saldo + 0.005 ? `No puede superar el saldo (${money(ver.saldo)}).`
    : !origen ? (pago.origen.caja === 'CHICA' ? 'Elige la caja chica.' : 'Elige la cuenta de caja grande.')
      : monto > origen.saldo + 0.005 ? `${origen.nombre} solo tiene ${money(origen.saldo)} disponibles.`
        : digital && pago.nroOperacion.trim().length < 3 ? 'Indica el número de operación.' : '';

  const registrar = async () => {
    if (!pago || !ver) return;
    setOcupado(true);
    try {
      const r = await api<{ codigo: string; saldo: number; estadoPago: string }>(`/compras/${ver.codigo}/pagos`, { method: 'POST', conIdempotencia: true,
        body: { ...pago.origen, medio: pago.medio, monto, nroOperacion: pago.nroOperacion.trim(), comprobante: pago.comprobante } });
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
        {paga && <Kpi label="Caja grande" valor={money(cajas.cuentas.reduce((t, k) => t + k.saldo, 0))} nota={`${cajas.cuentas.length} cuenta(s) · ${cajas.abiertas.length} caja(s) chica(s) abierta(s)`} icono="wallet" />}
      </div>
      <div className="toolbar"><div className="chips">
        <button className={`chipfilter ${filtro === 'abiertas' ? 'is-active' : ''}`} onClick={() => setFiltro('abiertas')}>Por pagar <b>{porPagar.length}</b></button>
        <button className={`chipfilter ${filtro === 'PAGADO' ? 'is-active' : ''}`} onClick={() => setFiltro('PAGADO')}>Pagadas <b>{deudas.length - porPagar.length}</b></button>
      </div></div>

      <Dialogo abierto={ver !== null} titulo={ver ? `${ver.codigo} · ${ver.proveedor}` : ''}
        descripcion={ver ? `${ver.documento} · ${ver.fecha}${ver.vencePago ? ` · vence ${ver.vencePago}` : ''}${ver.ruc ? ` · RUC ${ver.ruc}` : ''}` : ''}
        onCerrar={() => { setVer(null); setPago(null); setAnular(null); }}
        acciones={ver && (pago
          ? <><Boton onClick={() => setPago(null)}>Volver</Boton><Boton variant="primary" disabled={!!errorPago || ocupado} onClick={() => void registrar()}>{ocupado ? 'Registrando…' : `Pagar ${money(monto || 0)}`}</Boton></>
          : anular ? <><Boton onClick={() => setAnular(null)}>Volver</Boton><Boton variant="primary" disabled={anular.motivo.trim().length < 5 || ocupado} onClick={() => void anularPago()}>Anular pago</Boton></>
            : <>{paga && ver.saldo > 0 && <Boton variant="primary" onClick={() => { cajas.recargar(); const m = medios[0]; setPago({ origen: origenInicial(cajas.cuentas, m), medio: m?.codigo ?? '', monto: ver.saldo.toFixed(2), nroOperacion: '', comprobante: null }); }}>Registrar pago</Boton>}
              <Boton onClick={() => setVer(null)}>Cerrar</Boton></>)}>
        {ver && (<>
          <p className="dialogo__nota">Total {money(ver.total)} · pagado {money(ver.pagado)} · <b>saldo {money(ver.saldo)}</b></p>
          {ver.cuentas.length > 0 && <p className="dialogo__nota">Cuentas del proveedor: {ver.cuentas.map((k) => `${k.banco} ${k.numero}`).join(' · ')}</p>}
          {ver.pagos.length > 0 && (
            <div className="table-wrap"><table className="table table--compacta">
              <thead><tr><th>Pago</th><th>Fecha</th><th>Caja</th><th>Medio</th><th className="t-right">Monto</th><th>Estado</th><th /></tr></thead>
              <tbody>{ver.pagos.map((p) => (
                <tr key={p.codigo}>
                  <td>{p.codigo}</td><td>{new Date(p.fecha).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' })}</td>
                  <td>{p.caja === 'CHICA' ? `Chica ${p.apertura ?? ''}` : `Grande${p.cuenta ? ` · ${p.cuenta}` : ''}`}</td>
                  <td>{p.medio.toLowerCase()}{p.nroOperacion ? ` · ${p.nroOperacion}` : ''}{p.comprobanteUrl && <> · <VerComprobante url={p.comprobanteUrl} texto="comprobante" /></>}</td>
                  <td className="t-right">{money(p.monto)}</td>
                  <td>{p.estado === 'VIGENTE' ? <Insignia tono="ok">Vigente</Insignia> : <Insignia tono="neutral">Anulado</Insignia>}</td>
                  <td>{paga && p.estado === 'VIGENTE' && !pago && !anular && <Boton onClick={() => setAnular({ codigo: p.codigo, motivo: '' })}>Anular</Boton>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
          {pago && (
            <div className="form form--2col form--dialogo">
              <SelectorOrigen valor={pago.origen} onChange={(o) => setPago((x) => x && { ...x, origen: o })} cajas={cajas} medios={medios}
                medio={pago.medio} onMedio={(m) => setPago((x) => x && { ...x, medio: m })} />
              <label className="field"><span className="field__label">Monto (S/)</span>
                <input className="field__input" type="number" min="0" step="0.01" max={ver.saldo} value={pago.monto} onChange={(e) => setPago({ ...pago, monto: e.target.value })} /></label>
              <label className="field"><span className="field__label">N.° de operación{digital ? '' : ' (opcional)'}</span>
                <input className="field__input" maxLength={30} value={pago.nroOperacion} onChange={(e) => setPago({ ...pago, nroOperacion: e.target.value.toUpperCase() })} /></label>
              <ComprobanteInput valor={pago.comprobante} onChange={(c) => setPago({ ...pago, comprobante: c })} onError={(t) => setAviso({ tono: 'danger', texto: t })} />
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
        {cargaError ? <Vacio titulo="No se pudo cargar" detalle={cargaError} onReintentar={() => { setCargaError(null); setLista(null); void cargar(); }} />
          : lista === null ? <TablaEsqueleto columnas={7} />
          : !filas.length ? <Vacio titulo={filtro === 'PAGADO' ? 'Aún no hay compras pagadas' : 'No hay deudas por pagar'} icono="wallet" /> : (
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

/** Imagen del comprobante (voucher, captura de Yape): opcional, PNG/JPEG/WebP; se reduce antes de enviarla. */
export function ComprobanteInput({ valor, onChange, onError }: { valor: string | null; onChange: (v: string | null) => void; onError: (t: string) => void }) {
  return (
    <div className="field field--ancho">
      <span className="field__label">Imagen del comprobante (opcional)</span>
      <div className="campo-imagen">
        {valor ? <img src={valor} alt="Comprobante" /> : <span className="campo-imagen__vacio">Sin imagen</span>}
        <label className="btn btn--secondary btn--md">{valor ? 'Cambiar' : 'Subir'}
          <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => {
            const f = e.target.files?.[0]; e.target.value = '';
            if (f) imagenABase64(f, 1200).then(onChange, (er: Error) => onError(er.message));
          }} /></label>
        {valor && <Boton onClick={() => onChange(null)}>Quitar</Boton>}
      </div>
    </div>
  );
}
