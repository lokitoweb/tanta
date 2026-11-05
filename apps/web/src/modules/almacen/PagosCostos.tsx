import { useEffect, useState } from 'react';
import { api, urlApi } from '@/core/api';
import { useCatalogos } from '@/core/catalogos';
import { useApp } from '@/core/app-state';
import { money } from '@/core/format';
import { exportarExcel } from '@/core/exportar';
import { Dialogo } from '@/ui/Dialogo';
import { Boton, Encabezado, Insignia, Kpi, Tarjeta, TablaEsqueleto, Vacio } from '@/ui/primitives';
import { ComprobanteInput } from './Deudas';

interface PagoCosto {
  codigo: string; concepto: string; cif: string | null; fecha: string; periodoMes: number; periodoAnio: number; monto: number; caja: 'CHICA' | 'GRANDE';
  apertura: string | null; medio: string; nroOperacion: string | null; estado: 'VIGENTE' | 'ANULADO'; motivoAnulacion: string | null; usuario: string; comprobanteUrl: string | null;
}
interface Cif { id: string; codigo: string; concepto: string; montoMensual: number; activo: boolean }
interface Form { costoIndirectoId: string; concepto: string; fechaOperacion: string; periodoMes: number; periodoAnio: number; monto: string; caja: 'CHICA' | 'GRANDE'; medio: string; nroOperacion: string; comprobante: string | null }

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const hoy = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);

/**
 * Excel «REGISTRAR PAGOS - COSTOS»: el pago mensual de alquiler, luz, gas… (u otro concepto) con su período,
 * caja de origen (la chica necesita estar abierta y con saldo), medio, n.° de operación y comprobante.
 * Muestra lo pagado contra lo presupuestado en Costos indirectos.
 */
export function PagosCostos() {
  const { puede } = useApp();
  const ahora = new Date(Date.now() - 5 * 3_600_000);
  const [anio, setAnio] = useState(ahora.getUTCFullYear());
  const [mes, setMes] = useState(ahora.getUTCMonth() + 1);
  const [lista, setLista] = useState<PagoCosto[] | null>(null);
  const [cifs, setCifs] = useState<Cif[]>([]);
  const [caja, setCaja] = useState<{ codigo: string; saldo: number } | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [anular, setAnular] = useState<{ codigo: string; motivo: string } | null>(null);
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger'; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [cargaError, setCargaError] = useState<string | null>(null);
  const paga = puede('compras.pagar');
  const medios = useCatalogos().mediosPago.filter((m) => m.enCompras);
  const mediosCaja = (c: string) => medios.filter((m) => c !== 'CHICA' || m.cajaChica);

  const cargar = () => {
    api<PagoCosto[]>(`/pagos-costos?anio=${anio}&mes=${mes}`).then((l) => { setLista(l); setCargaError(null); }).catch((e) => setCargaError(e.message));
    if (paga) api<{ abierta: { codigo: string; saldo: number } | null }>('/cajas/chica').then((r) => setCaja(r.abierta)).catch(() => setCaja(null));
  };
  useEffect(() => { setLista(null); cargar(); }, [anio, mes]);
  useEffect(() => { if (puede('maestros.editar')) api<{ items: Cif[] }>('/costos-indirectos').then((r) => setCifs(r.items)).catch(() => setCifs([])); }, []);

  const vigentes = (lista ?? []).filter((p) => p.estado === 'VIGENTE');
  const pagado = vigentes.reduce((s, p) => s + p.monto, 0);
  const presupuesto = cifs.filter((c) => c.activo).reduce((s, c) => s + c.montoMensual, 0);
  const pagadoDe = (id: string) => vigentes.filter((p) => p.cif === cifs.find((c) => c.id === id)?.codigo).reduce((s, p) => s + p.monto, 0);

  const nuevo = () => setForm({ costoIndirectoId: '', concepto: '', fechaOperacion: hoy(), periodoMes: mes, periodoAnio: anio, monto: '', caja: 'GRANDE',
    medio: mediosCaja('GRANDE')[0]?.codigo ?? '', nroOperacion: '', comprobante: null });
  const digital = !!form && !!medios.find((m) => m.codigo === form.medio)?.requiereOperacion;
  const monto = Number(form?.monto);
  const errorForm = !form ? '' : !form.costoIndirectoId && form.concepto.trim().length < 2 ? 'Elige el costo o escribe el concepto.'
    : !(monto > 0) ? 'Indica el monto.' : form.caja === 'CHICA' && !caja ? 'No hay caja chica abierta.'
      : form.caja === 'CHICA' && caja && monto > caja.saldo + 0.005 ? `La caja chica solo tiene ${money(caja.saldo)}.`
        : digital && form.nroOperacion.trim().length < 3 ? 'Indica el número de operación.' : '';

  const registrar = async () => {
    if (!form) return;
    setOcupado(true);
    try {
      const r = await api<{ codigo: string }>('/pagos-costos', { method: 'POST', conIdempotencia: true, body: { ...form, monto, concepto: form.concepto.trim(), nroOperacion: form.nroOperacion.trim() } });
      setForm(null); setAviso({ tono: 'ok', texto: `Pago ${r.codigo} registrado por ${money(monto)}.` }); cargar();
    } catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo registrar.' }); }
    finally { setOcupado(false); }
  };
  const confirmarAnular = async () => {
    if (!anular) return;
    setOcupado(true);
    try {
      await api(`/pagos-costos/${anular.codigo}/anular`, { method: 'POST', body: { motivo: anular.motivo } });
      setAviso({ tono: 'ok', texto: `Pago ${anular.codigo} anulado.` }); setAnular(null); cargar();
    } catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo anular.' }); }
    finally { setOcupado(false); }
  };

  return (
    <>
      <Encabezado titulo="Pagos de costos" descripcion="Alquiler, luz, gas y demás costos del mes: de qué caja salió, con qué medio y su comprobante"
        acciones={<>
          <Boton icono="download" disabled={!lista?.length} onClick={() => exportarExcel(`pagos-costos-${anio}-${mes}`, (lista ?? []).map((p) => ({ Código: p.codigo, Concepto: p.concepto, CIF: p.cif ?? '',
            Período: `${MESES[p.periodoMes - 1]} ${p.periodoAnio}`, Fecha: p.fecha, Monto: p.monto, Origen: p.caja === 'CHICA' ? `Caja chica ${p.apertura ?? ''}` : 'Caja grande',
            Usuario: p.usuario, 'Medio de pago': p.medio, Operación: p.nroOperacion ?? '', Estado: p.estado })))}>Excel</Boton>
          {paga && <Boton variant="primary" icono="plus" onClick={nuevo}>Registrar pago</Boton>}
        </>} />
      {aviso && <div className={`aviso aviso--${aviso.tono}`} role="status"><span className="aviso__icono">{aviso.tono === 'ok' ? '✓' : '!'}</span><div><p>{aviso.texto}</p></div></div>}
      <div className="toolbar">
        <div className="form form--2col" style={{ maxWidth: 420 }}>
          <label className="field"><span className="field__label">Período</span>
            <select className="field__input" value={mes} onChange={(e) => setMes(Number(e.target.value))}>{MESES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></label>
          <label className="field"><span className="field__label">Año</span>
            <input className="field__input" type="number" min={2020} max={2100} value={anio} onChange={(e) => setAnio(Number(e.target.value))} /></label>
        </div>
      </div>
      <div className="grid grid--auto">
        <Kpi label="Pagado en el período" valor={money(pagado)} nota={`${vigentes.length} pago(s)`} icono="wallet" />
        {cifs.length > 0 && <Kpi label="Presupuesto mensual" valor={money(presupuesto)} nota={`por pagar ${money(Math.max(0, presupuesto - pagado))}`} icono="ledger" />}
        {paga && <Kpi label="Caja chica" valor={caja ? money(caja.saldo) : 'Cerrada'} nota={caja ? `${caja.codigo} · disponible` : 'se abre en Comercial → Caja chica'} icono="wallet" />}
      </div>

      <Dialogo abierto={form !== null} titulo="Registrar pago de costo" descripcion="El pago queda en el período elegido y, si sale de caja chica, descuenta su saldo."
        onCerrar={() => setForm(null)}
        acciones={<><Boton onClick={() => setForm(null)}>Cancelar</Boton><Boton variant="primary" disabled={!!errorForm || ocupado} onClick={() => void registrar()}>{ocupado ? 'Registrando…' : `Pagar ${money(monto || 0)}`}</Boton></>}>
        {form && (
          <div className="form form--2col form--dialogo">
            <label className="field field--ancho"><span className="field__label">Costo indirecto (opcional)</span>
              <select className="field__input" value={form.costoIndirectoId} onChange={(e) => {
                const c = cifs.find((x) => x.id === e.target.value);
                setForm({ ...form, costoIndirectoId: e.target.value, concepto: c?.concepto ?? form.concepto, monto: c && !form.monto ? String(Math.max(0, c.montoMensual - pagadoDe(c.id)).toFixed(2)) : form.monto });
              }}>
                <option value="">Otro concepto</option>
                {cifs.filter((c) => c.activo).map((c) => <option key={c.id} value={c.id}>{c.codigo} · {c.concepto} ({money(c.montoMensual)}/mes)</option>)}</select></label>
            <label className="field field--ancho"><span className="field__label">Concepto</span>
              <input className="field__input" maxLength={120} value={form.concepto} onChange={(e) => setForm({ ...form, concepto: e.target.value })} placeholder="Alquiler del local" /></label>
            <label className="field"><span className="field__label">Fecha de la operación</span>
              <input className="field__input" type="date" max={hoy()} value={form.fechaOperacion} onChange={(e) => setForm({ ...form, fechaOperacion: e.target.value })} /></label>
            <label className="field"><span className="field__label">Período (mes y año)</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <select className="field__input" value={form.periodoMes} onChange={(e) => setForm({ ...form, periodoMes: Number(e.target.value) })}>{MESES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select>
                <input className="field__input" style={{ maxWidth: 100 }} type="number" min={2000} max={2100} aria-label="Año" value={form.periodoAnio} onChange={(e) => setForm({ ...form, periodoAnio: Number(e.target.value) })} />
              </div></label>
            <label className="field"><span className="field__label">Monto (S/)</span>
              <input className="field__input" type="number" min="0" step="0.01" value={form.monto} onChange={(e) => setForm({ ...form, monto: e.target.value })} /></label>
            <label className="field"><span className="field__label">Origen del pago</span>
              <select className="field__input" value={form.caja} onChange={(e) => setForm({ ...form, caja: e.target.value as 'CHICA' | 'GRANDE', medio: mediosCaja(e.target.value).some((m) => m.codigo === form.medio) ? form.medio : (mediosCaja(e.target.value)[0]?.codigo ?? '') })}>
                <option value="GRANDE">Caja grande</option><option value="CHICA">Caja chica{caja ? ` (${money(caja.saldo)} disponible)` : ' (cerrada)'}</option></select></label>
            <label className="field"><span className="field__label">Medio de pago</span>
              <select className="field__input" value={form.medio} onChange={(e) => setForm({ ...form, medio: e.target.value })}>
                {mediosCaja(form.caja).map((m) => <option key={m.codigo} value={m.codigo}>{m.nombre}</option>)}</select></label>
            <label className="field"><span className="field__label">N.° de operación{digital ? '' : ' (opcional)'}</span>
              <input className="field__input" maxLength={30} value={form.nroOperacion} onChange={(e) => setForm({ ...form, nroOperacion: e.target.value.toUpperCase() })} /></label>
            <ComprobanteInput valor={form.comprobante} onChange={(c) => setForm({ ...form, comprobante: c })} onError={(t) => setAviso({ tono: 'danger', texto: t })} />
            {errorForm && <span className="field__aviso field--ancho">{errorForm}</span>}
          </div>
        )}
      </Dialogo>

      <Dialogo abierto={anular !== null} titulo={`Anular ${anular?.codigo ?? ''}`} descripcion="El pago no se borra: queda anulado con su motivo y, si salió de caja chica, el dinero vuelve a su saldo."
        onCerrar={() => setAnular(null)}
        acciones={<><Boton onClick={() => setAnular(null)}>Volver</Boton><Boton variant="danger" disabled={!anular || anular.motivo.trim().length < 5 || ocupado} onClick={() => void confirmarAnular()}>Anular pago</Boton></>}>
        {anular && <label className="field"><span className="field__label">Motivo</span>
          <input className="field__input" autoFocus maxLength={300} value={anular.motivo} onChange={(e) => setAnular({ ...anular, motivo: e.target.value })} /></label>}
      </Dialogo>

      <Tarjeta padding="none">
        {cargaError ? <Vacio titulo="No se pudo cargar" detalle={cargaError} onReintentar={cargar} />
          : lista === null ? <TablaEsqueleto columnas={8} />
          : !lista.length ? <Vacio titulo={`Sin pagos en ${MESES[mes - 1].toLowerCase()} ${anio}`} icono="wallet" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Código</th><th>Concepto</th><th>Fecha</th><th>Origen</th><th>Medio</th><th className="t-right">Monto</th><th>Usuario</th><th>Estado</th><th /></tr></thead>
            <tbody>{lista.map((p) => (
              <tr key={p.codigo}>
                <td><strong>{p.codigo}</strong></td>
                <td>{p.concepto}{p.cif && <><br /><small className="t-muted">{p.cif}</small></>}</td>
                <td>{p.fecha}</td>
                <td>{p.caja === 'CHICA' ? `Caja chica ${p.apertura ?? ''}` : 'Caja grande'}</td>
                <td>{p.medio.toLowerCase()}{p.nroOperacion ? ` · ${p.nroOperacion}` : ''}{p.comprobanteUrl && <> · <a href={urlApi(p.comprobanteUrl)} target="_blank" rel="noreferrer">comprobante</a></>}</td>
                <td className="t-right">{money(p.monto)}</td><td>{p.usuario}</td>
                <td>{p.estado === 'VIGENTE' ? <Insignia tono="ok">Vigente</Insignia> : <Insignia tono="neutral">Anulado</Insignia>}</td>
                <td>{paga && p.estado === 'VIGENTE' && <Boton size="sm" onClick={() => setAnular({ codigo: p.codigo, motivo: '' })}>Anular</Boton>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Tarjeta>
    </>
  );
}
