import { VerComprobante } from '@/ui/VerComprobante';
import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { useCatalogos } from '@/core/catalogos';
import { money } from '@/core/format';
import { ComprobanteInput } from '@/modules/almacen/Deudas';
import { Dialogo } from '@/ui/Dialogo';
import { InputNumero } from '@/ui/InputNumero';
import { Boton, Encabezado, Insignia, PilaEsqueleto, Tarjeta, Vacio } from '@/ui/primitives';

const aNumero = (x: string): number | '' => (x === '' ? '' : Number(x));

interface Gasto { codigo: string; concepto: string; fecha: string; monto: number; medio: string; estado: string; usuario: string; comprobanteUrl: string | null;
  tipoGastoNombre: string | null; docTipo: string | null; docSerie: string | null; docNumero: string | null; autorizadoPor: string | null }

const hoy = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
const nuevo = () => ({ fecha: hoy(), docTipo: '', serie: '', numero: '', tipo: '', glosa: '', monto: '', autorizado: '', medio: '', imagen: null as string | null });

/** Gastos de caja chica (menú, gasolina, distribución…): salen de la caja abierta y entran a la liquidación diaria. */
export function Gastos() {
  const cat = useCatalogos();
  const tipos = cat.tiposGasto;
  const medios = cat.mediosPago.filter((m) => m.cajaChica);
  const [lista, setLista] = useState<Gasto[] | null>(null);
  const [cargaError, setCargaError] = useState<string | null>(null);
  const [form, setForm] = useState<ReturnType<typeof nuevo> | null>(null);
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger'; texto: string } | null>(null);
  const [guardando, setGuardando] = useState(false);

  const cargar = () => api<Gasto[]>('/pagos-costos').then((l) => { setLista(l.filter((x) => x.tipoGastoNombre)); setCargaError(null); }).catch((e) => setCargaError(e.message));
  useEffect(() => { void cargar(); }, []);

  const valido = form && form.tipo && form.glosa.trim().length >= 2 && Number(form.monto) > 0 && form.autorizado.trim().length >= 2 && (form.medio || medios[0]);
  const guardar = async () => {
    if (!form) return;
    setGuardando(true);
    try {
      const r = await api<{ codigo: string }>('/pagos-costos', { method: 'POST', conIdempotencia: true, body: {
        concepto: form.glosa.trim(), fechaOperacion: form.fecha, periodoMes: Number(form.fecha.slice(5, 7)), periodoAnio: Number(form.fecha.slice(0, 4)), monto: Number(form.monto),
        caja: 'CHICA', medio: form.medio || medios[0].codigo, tipoGasto: form.tipo, docTipo: form.docTipo || null, docSerie: form.serie, docNumero: form.numero, autorizadoPor: form.autorizado.trim(), comprobante: form.imagen } });
      setForm(null);
      setAviso({ tono: 'ok', texto: `Gasto ${r.codigo} registrado.` });
      await cargar();
    } catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo registrar.' }); }
    finally { setGuardando(false); }
  };

  return (
    <>
      <Encabezado titulo="Gastos" descripcion="Gastos de caja chica: menú, gasolina y otros de distribución · entran a la liquidación diaria"
        acciones={<Boton variant="primary" icono="plus" onClick={() => { setAviso(null); setForm(nuevo()); }}>Registrar gasto</Boton>} />
      {aviso && <div className={`aviso aviso--${aviso.tono}`} role="status"><span className="aviso__icono">{aviso.tono === 'ok' ? '✓' : '!'}</span><div><p>{aviso.texto}</p></div></div>}

      <Dialogo abierto={form !== null} titulo="Registrar gasto" descripcion="Sale de la caja chica abierta." onCerrar={() => setForm(null)}
        acciones={<><Boton onClick={() => setForm(null)}>Cancelar</Boton><Boton variant="primary" disabled={!valido || guardando} onClick={() => void guardar()}>{guardando ? 'Registrando…' : 'Registrar gasto'}</Boton></>}>
        {form && <div className="form form--2col form--dialogo">
          <label className="field"><span className="field__label">Fecha</span><input className="field__input" type="date" max={hoy()} value={form.fecha} onChange={(e) => setForm({ ...form, fecha: e.target.value })} /></label>
          <label className="field"><span className="field__label">Tipo de gasto</span>
            <select className="field__input" value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value })}><option value="">Elige</option>{tipos.map((t) => <option key={t.codigo} value={t.codigo}>{t.nombre}</option>)}</select></label>
          <label className="field"><span className="field__label">Documento</span>
            <select className="field__input" value={form.docTipo} onChange={(e) => setForm({ ...form, docTipo: e.target.value })}><option value="">Sin documento</option>{cat.tiposDocumento.map((t) => <option key={t.codigo} value={t.codigo}>{t.nombre}</option>)}</select></label>
          <div className="pago-linea">
            <label className="field"><span className="field__label">Serie</span><input className="field__input" maxLength={10} value={form.serie} onChange={(e) => setForm({ ...form, serie: e.target.value })} /></label>
            <label className="field"><span className="field__label">N.°</span><input className="field__input" maxLength={20} value={form.numero} onChange={(e) => setForm({ ...form, numero: e.target.value })} /></label>
          </div>
          <label className="field field--ancho"><span className="field__label">Glosa</span><input className="field__input" maxLength={120} placeholder="Gasto de menú" value={form.glosa} onChange={(e) => setForm({ ...form, glosa: e.target.value })} /></label>
          <label className="field"><span className="field__label">Monto (S/)</span><InputNumero className="field__input" valor={aNumero(form.monto)} onValor={(n) => { const v = String(n); setForm({ ...form, monto: v }); }} /></label>
          <label className="field"><span className="field__label">Autorizado por</span><input className="field__input" maxLength={80} value={form.autorizado} onChange={(e) => setForm({ ...form, autorizado: e.target.value })} /></label>
          {medios.length > 1 && <label className="field"><span className="field__label">Medio de pago</span>
            <select className="field__input" value={form.medio || medios[0].codigo} onChange={(e) => setForm({ ...form, medio: e.target.value })}>{medios.map((m) => <option key={m.codigo} value={m.codigo}>{m.nombre}</option>)}</select></label>}
          <ComprobanteInput valor={form.imagen} onChange={(imagen) => setForm({ ...form, imagen })} onError={(t) => setAviso({ tono: 'danger', texto: t })} />
        </div>}
      </Dialogo>

      <Tarjeta padding="none">
        {cargaError ? <Vacio titulo="No se pudo cargar" detalle={cargaError} onReintentar={() => void cargar()} />
          : lista === null ? <PilaEsqueleto lineas={4} />
          : lista.length === 0 ? <Vacio titulo="Aún no hay gastos registrados" icono="wallet" /> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Código</th><th>Fecha</th><th>Documento</th><th>Tipo</th><th>Glosa</th><th>Autorizó</th><th className="t-right">Monto</th><th>Estado</th></tr></thead>
              <tbody>{lista.map((g) => <tr key={g.codigo}><td>{g.codigo}{g.comprobanteUrl && <div><VerComprobante url={g.comprobanteUrl} texto="Ver imagen" titulo={`Gasto ${g.codigo}`} /></div>}</td>
                <td>{g.fecha.split('-').reverse().join('/')}</td><td>{[g.docTipo, g.docSerie, g.docNumero].filter(Boolean).join(' ') || '—'}</td><td>{g.tipoGastoNombre}</td><td>{g.concepto}</td><td>{g.autorizadoPor}</td>
                <td className="t-right"><strong>{money(g.monto)}</strong></td><td><Insignia tono={g.estado === 'VIGENTE' ? 'ok' : 'danger'} punto>{g.estado === 'VIGENTE' ? 'Vigente' : 'Anulado'}</Insignia></td></tr>)}</tbody>
            </table></div>
          )}
      </Tarjeta>
    </>
  );
}
