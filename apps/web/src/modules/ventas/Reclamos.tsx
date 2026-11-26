import { useEffect, useMemo, useState } from 'react';
import { api } from '@/core/api';
import { useApp } from '@/core/app-state';
import { exportarExcel } from '@/core/exportar';
import { Boton, Buscador, Encabezado, Insignia, Tarjeta, TablaEsqueleto, Vacio } from '@/ui/primitives';
import { Dialogo } from '@/ui/Dialogo';
import { VerComprobante } from '@/ui/VerComprobante';

type Estado = 'ABIERTO' | 'EN_PROCESO' | 'RESUELTO' | 'CERRADO';
interface Reclamo { id: string; codigo: string; estado: Estado; tipo: string; tipoNombre: string; descripcion: string; resolucion: string | null; creadoEn: string;
  resueltoEn: string | null; cliente: string; pedido: string | null; conFoto: boolean; ultimaRespuesta: string | null; mensajes: number }
interface Paso { id: number; autor: string; deCliente: boolean; mensaje: string; estado: string | null; creadoEn: string }
export const ESTADOS_RECLAMO: Record<Estado, { label: string; tono: 'danger' | 'warn' | 'ok' | 'neutral' }> = {
  ABIERTO: { label: 'Abierto', tono: 'danger' }, EN_PROCESO: { label: 'En proceso', tono: 'warn' }, RESUELTO: { label: 'Resuelto', tono: 'ok' }, CERRADO: { label: 'Cerrado', tono: 'neutral' },
};
const fecha = (x: string) => new Date(x).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' });

/** Reclamos de los clientes (registrados desde la app): responder, llevarlos por sus estados y resolverlos. Todo queda en el seguimiento. */
export function Reclamos() {
  const { puede } = useApp();
  const [lista, setLista] = useState<Reclamo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<Estado | 'todos'>('todos');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<(Reclamo & { seguimiento: Paso[] }) | null>(null);
  const [mensaje, setMensaje] = useState('');
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger'; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const gestiona = puede('reclamos.gestionar');

  const cargar = () => api<Reclamo[]>('/reclamos').then((l) => { setLista(l); setError(null); }).catch((e) => setError(e.message));
  useEffect(() => { void cargar(); }, []);
  const abrir = (codigo: string) => api<Reclamo & { seguimiento: Paso[] }>(`/reclamos/${codigo}`).then((r) => { setSel(r); setMensaje(''); }).catch((e) => setAviso({ tono: 'danger', texto: e.message }));
  const filas = useMemo(() => (lista ?? []).filter((r) => (filtro === 'todos' || r.estado === filtro) && `${r.codigo} ${r.cliente} ${r.pedido ?? ''} ${r.tipoNombre}`.toLowerCase().includes(q.toLowerCase())), [lista, filtro, q]);
  const cuenta = (e: Estado) => (lista ?? []).filter((r) => r.estado === e).length;

  const responder = async (estado?: 'EN_PROCESO' | 'RESUELTO' | 'CERRADO') => {
    if (!sel) return;
    setOcupado(true); setAviso(null);
    try {
      const r = await api<{ estado: Estado }>(`/reclamos/${sel.codigo}/seguimiento`, { method: 'POST', body: { mensaje: mensaje.trim(), ...(estado ? { estado } : {}) } });
      setAviso({ tono: 'ok', texto: `${sel.codigo}: respuesta enviada al cliente · ${ESTADOS_RECLAMO[r.estado].label.toLowerCase()}` });
      await Promise.all([cargar(), abrir(sel.codigo)]);
    } catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo enviar.' }); }
    finally { setOcupado(false); }
  };

  return (
    <>
      <Encabezado titulo="Reclamos" descripcion="Los registra el cliente desde la app · cada respuesta le llega como aviso y queda en el seguimiento"
        acciones={<Boton icono="download" disabled={!filas.length} onClick={() => exportarExcel('reclamos', filas.map((r) => ({ Reclamo: r.codigo, Fecha: r.creadoEn.slice(0, 10), Cliente: r.cliente, Pedido: r.pedido ?? '',
          Motivo: r.tipoNombre, Estado: ESTADOS_RECLAMO[r.estado].label, Detalle: r.descripcion, Resolución: r.resolucion ?? '' })))}>Excel</Boton>} />
      {aviso && <div className={`aviso aviso--${aviso.tono}`} role="status"><span className="aviso__icono">{aviso.tono === 'ok' ? '✓' : '!'}</span><div><p>{aviso.texto}</p></div></div>}
      <div className="grid grid--auto">
        {(Object.keys(ESTADOS_RECLAMO) as Estado[]).map((e) => <Tarjeta key={e} className="mini-stat"><span>{ESTADOS_RECLAMO[e].label}</span><b>{cuenta(e)}</b></Tarjeta>)}
      </div>
      <Tarjeta padding="none">
        <div className="toolbar">
          <Buscador valor={q} onChange={setQ} placeholder="Buscar por cliente, reclamo o pedido…" />
          <div className="chips">
            <button className={`chipfilter ${filtro === 'todos' ? 'is-active' : ''}`} onClick={() => setFiltro('todos')}>Todos</button>
            {(Object.keys(ESTADOS_RECLAMO) as Estado[]).map((e) => <button key={e} className={`chipfilter ${filtro === e ? 'is-active' : ''}`} onClick={() => setFiltro(e)}>{ESTADOS_RECLAMO[e].label} <b>{cuenta(e)}</b></button>)}
          </div>
        </div>
        {error ? <Vacio titulo="No se pudo cargar" detalle={error} onReintentar={() => void cargar()} />
          : lista === null ? <TablaEsqueleto columnas={6} />
          : !filas.length ? <Vacio titulo="Sin reclamos" detalle="No hay reclamos con este filtro." icono="check" />
          : <div className="table-wrap"><table className="table">
              <thead><tr><th>Reclamo</th><th>Cliente</th><th>Motivo</th><th>Pedido</th><th>Última respuesta</th><th className="t-right">Estado</th></tr></thead>
              <tbody>{filas.map((r) => <tr key={r.id} className="is-clickable" onClick={() => void abrir(r.codigo)}>
                <td><strong className="mono">{r.codigo}</strong><div className="t-muted">{fecha(r.creadoEn)}</div></td><td>{r.cliente}</td><td>{r.tipoNombre}</td>
                <td className="mono">{r.pedido ?? '—'}</td><td className="t-muted">{r.ultimaRespuesta ? fecha(r.ultimaRespuesta) : 'Sin respuesta'}</td>
                <td className="t-right"><Insignia tono={ESTADOS_RECLAMO[r.estado].tono} punto>{ESTADOS_RECLAMO[r.estado].label}</Insignia></td></tr>)}</tbody>
            </table></div>}
      </Tarjeta>

      <Dialogo abierto={sel !== null} titulo={`Reclamo ${sel?.codigo ?? ''}`} descripcion={sel ? `${sel.cliente} · ${sel.tipoNombre}${sel.pedido ? ` · pedido ${sel.pedido}` : ''} · ${ESTADOS_RECLAMO[sel.estado].label}` : ''}
        onCerrar={() => setSel(null)}
        acciones={sel && gestiona && sel.estado !== 'CERRADO' ? <>
          <Boton onClick={() => void responder()} disabled={ocupado || mensaje.trim().length < 2}>Responder</Boton>
          {sel.estado !== 'RESUELTO' && <Boton variant="primary" onClick={() => void responder('RESUELTO')} disabled={ocupado || mensaje.trim().length < 2} title="Lo que escribas queda como la solución">Resolver</Boton>}
          {sel.estado === 'RESUELTO' && <Boton onClick={() => void responder('CERRADO')} disabled={ocupado || mensaje.trim().length < 2}>Cerrar reclamo</Boton>}
        </> : <Boton onClick={() => setSel(null)}>Cerrar</Boton>}>
        {sel && <>
          <p className="dialogo__nota"><b>El cliente escribió ({fecha(sel.creadoEn)}):</b> {sel.descripcion}</p>
          {sel.conFoto && <VerComprobante url={`/reclamos/${sel.codigo}/foto`} texto="Ver foto adjunta" titulo={`Foto del reclamo ${sel.codigo}`} />}
          {sel.resolucion && <p className="dialogo__nota t-ok"><b>Solución:</b> {sel.resolucion}</p>}
          <ul className="seguimiento">
            {sel.seguimiento.map((p) => <li key={p.id} className={p.deCliente ? 'seguimiento__cliente' : ''}>
              <span className="t-muted">{p.autor} · {fecha(p.creadoEn)}{p.estado ? ` · ${ESTADOS_RECLAMO[p.estado as Estado]?.label.toLowerCase() ?? p.estado}` : ''}</span><p>{p.mensaje}</p></li>)}
            {!sel.seguimiento.length && <li className="t-muted">Aún no hay respuestas.</li>}
          </ul>
          {gestiona && sel.estado !== 'CERRADO' && <label className="field"><span className="field__label">Respuesta al cliente</span>
            <textarea className="field__input" rows={3} maxLength={1000} value={mensaje} onChange={(e) => setMensaje(e.target.value)} placeholder="Ej.: Le reponemos los 5 panes en el próximo pedido." /></label>}
        </>}
      </Dialogo>
    </>
  );
}
