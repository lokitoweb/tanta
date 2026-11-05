import { Paginador, usePaginado } from '@/ui/Paginador';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/core/api';
import { useCatalogos } from '@/core/catalogos';
import { exportarExcel, exportarPdf } from '@/core/exportar';
import { useApp } from '@/core/app-state';
import { money, num, num2 } from '@/core/format';
import { Boton, Buscador, Encabezado, Insignia, Tarjeta, TablaEsqueleto, Vacio } from '@/ui/primitives';
import { Dialogo } from '@/ui/Dialogo';
import { NuevoPedido } from './NuevoPedido';

interface Item { productoId: string; producto: string; cantidad: number; precio: number }
interface Pedido { id: string; codigo: string; clienteId: string; cliente: string; vendedor: string; estado: string; total: number; fecha_entrega: string; hora_entrega: string; observaciones: string; venta: string | null; items: Item[];
  tipoEntrega?: string; direccion?: string; pagoEntrega?: string; motivo?: string | null; entregaObs?: string | null }

const ESTADOS: Record<string, { label: string; tono: 'info' | 'warn' | 'ok' | 'danger' | 'neutral' }> = {
  REGISTRADO: { label: 'Por confirmar', tono: 'neutral' }, CONFIRMADO: { label: 'Confirmado', tono: 'info' },
  EN_PRODUCCION: { label: 'En producción', tono: 'warn' }, LISTO: { label: 'Listo', tono: 'info' }, DESPACHADO: { label: 'Despachado', tono: 'info' },
  ENTREGADO: { label: 'Entregado', tono: 'ok' }, RECHAZADO: { label: 'Rechazado', tono: 'danger' }, CANCELADO: { label: 'Cancelado', tono: 'danger' },
};
// RN-26: siguiente paso natural. Un confirmado con stock puede pasar directo a Listo (reserva el stock).
const SIGUIENTE: Record<string, string> = { REGISTRADO: 'CONFIRMADO', CONFIRMADO: 'LISTO', EN_PRODUCCION: 'LISTO' };
interface Aprobacion { id: string; porcentaje: number; estado: string; vigente: boolean }

/** Pedidos: registro, avance por estados y despacho con venta vinculada (trazabilidad pedido → venta). */
export function Pedidos() {
  const { puede, refrescarDatos } = useApp();
  // null = cargando (esqueleto); [] = cargó y no hay pedidos.
  const [lista, setLista] = useState<Pedido[] | null>(null);
  const [cargaError, setCargaError] = useState<string | null>(null);
  const pedidos = lista ?? [];
  const [q, setQ] = useState('');
  const [estado, setEstado] = useState('todos');
  const [nuevo, setNuevo] = useState(false);
  const [sel, setSel] = useState<Pedido | null>(null);
  const [pago, setPago] = useState({ formaPago: '', descuento: '0', referencia: '' });
  const medios = useCatalogos().mediosPago.filter((m) => m.enVentas);
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger'; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [motivo, setMotivo] = useState<{ destino: 'RECHAZADO' | 'CANCELADO' | 'ENTREGADO'; texto: string } | null>(null);

  // RN-36: aprobaciones de descuento del vendedor (la vigente de mayor % se usa al despachar).
  const [aprobaciones, setAprobaciones] = useState<Aprobacion[]>([]);
  useEffect(() => { if (sel && puede('ventas.registrar')) api<Aprobacion[]>('/descuentos/solicitudes').then(setAprobaciones).catch(() => {}); }, [sel]);
  const aprobacion = aprobaciones.filter((a) => a.vigente && a.porcentaje + 1e-6 >= Number(pago.descuento) / 100).sort((a, b) => a.porcentaje - b.porcentaje)[0];
  const pedirAprobacion = (p: Pedido) => accion(async () => {
    await api('/descuentos/solicitudes', { method: 'POST', body: { porcentaje: Number(pago.descuento) / 100, motivo: `Despacho del pedido ${p.codigo}`, clienteId: p.clienteId } });
    return `Descuento de ${pago.descuento} % enviado al Gerente para aprobación`;
  });
  const conReferencia = !!medios.find((m) => m.codigo === pago.formaPago)?.requiereOperacion;
  const cargar = () => api<Pedido[]>('/pedidos').then((p) => { setLista(p); setCargaError(null); }).catch((e) => setCargaError(e.message));
  useEffect(() => { void cargar(); }, []);

  const filas = useMemo(() => pedidos.filter((p) => (estado === 'todos' || p.estado === estado)
    && `${p.cliente} ${p.codigo}`.toLowerCase().includes(q.toLowerCase())), [pedidos, q, estado]);
  const porEstado = (e: string) => pedidos.filter((p) => p.estado === e).length;

  const accion = async (fn: () => Promise<string>) => {
    setOcupado(true);
    setAviso(null);
    try { const t = await fn(); setSel(null); await Promise.all([cargar(), refrescarDatos()]); setAviso({ tono: 'ok', texto: t }); }
    catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo completar.' }); }
    finally { setOcupado(false); }
  };
  const avanzar = (p: Pedido, a: string, texto = '') => accion(async () => {
    await api(`/pedidos/${p.codigo}/estado`, { method: 'PATCH', body: { estado: a, motivo: texto, observaciones: texto } });
    setMotivo(null);
    return `${p.codigo} → ${ESTADOS[a].label}${a === 'LISTO' ? ' · stock reservado' : ''}`;
  });
  // Despachar = vender lo pedido (descuenta stock, congela costo, genera CxC si es crédito) y marcar despachado.
  const despachar = (p: Pedido) => accion(async () => {
    const v = await api<{ codigo: string; comprobante: { numero: string } }>('/ventas', {
      method: 'POST', conIdempotencia: true,
      body: { items: p.items.map((i) => ({ productoId: i.productoId, cantidad: i.cantidad })), formaPago: pago.formaPago, clienteId: p.clienteId, pedidoId: p.id, descuentoPct: Number(pago.descuento) / 100,
        referenciaPago: pago.referencia.trim(), ...(aprobacion ? { aprobacionDescuentoId: aprobacion.id } : {}) },
    });
    return `${p.codigo} despachado · nota de venta ${v.comprobante.numero}`;
  });

  const gestiona = puede('pedidos.gestionar');
  const pagPedidos = usePaginado(filas, 25);
  return (
    <>
      <Encabezado titulo="Pedidos" descripcion="Del registro del cliente al despacho · cada cambio queda auditado"
        acciones={<>
          <Boton icono="download" onClick={() => exportarExcel('pedidos', filas.map(({ items, ...p }) => ({ ...p, productos: items.map((i) => `${i.cantidad} ${i.producto}`).join(', ') })))}>Excel</Boton>
          <Boton icono="report" onClick={exportarPdf}>PDF</Boton>
          {puede('pedidos.crear') && <Boton variant="primary" icono="plus" onClick={() => setNuevo(true)}>Registrar pedido</Boton>}
        </>} />
      {aviso && <div className={`aviso aviso--${aviso.tono}`} role="status"><span className="aviso__icono">{aviso.tono === 'ok' ? '✓' : '!'}</span><div><p>{aviso.texto}</p></div></div>}

      <div className="grid grid--auto">
        <Tarjeta className="mini-stat"><span>Por producir</span><b>{porEstado('EN_PRODUCCION') + porEstado('REGISTRADO')}</b></Tarjeta>
        <Tarjeta className="mini-stat"><span>Listos para despacho</span><b>{porEstado('LISTO')}</b></Tarjeta>
        <Tarjeta className="mini-stat"><span>En reparto</span><b>{porEstado('DESPACHADO')}</b></Tarjeta>
        <Tarjeta className="mini-stat"><span>Entregados</span><b>{porEstado('ENTREGADO')}</b></Tarjeta>
      </div>

      <Tarjeta padding="none">
        <div className="toolbar">
          <Buscador valor={q} onChange={setQ} placeholder="Buscar por cliente o código…" />
          <div className="chips">
            <button className={`chipfilter ${estado === 'todos' ? 'is-active' : ''}`} onClick={() => setEstado('todos')}>Todos</button>
            {Object.entries(ESTADOS).map(([k, v]) => (
              <button key={k} className={`chipfilter ${estado === k ? 'is-active' : ''}`} onClick={() => setEstado(k)}>{v.label} <b>{porEstado(k)}</b></button>))}
          </div>
        </div>
        {cargaError ? <Vacio titulo="No se pudo cargar" detalle={cargaError} onReintentar={() => { setCargaError(null); setLista(null); void cargar(); }} />
          : lista === null ? <TablaEsqueleto columnas={6} />
          : filas.length === 0 ? <Vacio titulo="Sin pedidos" detalle="No hay pedidos con este filtro." icono="clipboard" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Pedido</th><th>Cliente</th><th>Productos</th><th>Entrega</th><th className="t-right">Total</th><th className="t-right">Estado</th></tr></thead>
            <tbody>{pagPedidos.visibles.map((p) => (
              <tr key={p.id} className="is-clickable" onClick={() => { setPago({ formaPago: medios.some((m) => m.codigo === p.pagoEntrega) ? p.pagoEntrega! : medios[0]?.codigo ?? '', descuento: '0', referencia: '' }); setSel(p); }}>
                <td><strong className="mono">{p.codigo}</strong>{p.venta && <div className="t-muted mono">{p.venta}</div>}</td>
                <td>{p.cliente}</td>
                <td className="t-muted">{p.items.slice(0, 2).map((i) => `${num(i.cantidad)} ${i.producto}`).join(', ')}{p.items.length > 2 ? ` +${p.items.length - 2}` : ''}</td>
                <td>{p.fecha_entrega}{p.hora_entrega ? ` · ${p.hora_entrega}` : ''}</td>
                <td className="t-right"><strong>{money(p.total)}</strong></td>
                <td className="t-right"><Insignia tono={ESTADOS[p.estado]?.tono ?? 'neutral'} punto>{ESTADOS[p.estado]?.label ?? p.estado}</Insignia></td>
              </tr>))}</tbody>
          </table></div>
        )}
        <Paginador {...pagPedidos} />
        <div className="card__foot"><span className="t-muted">{num(filas.length)} pedidos · {money(filas.reduce((s, p) => s + p.total, 0))} en total</span></div>
      </Tarjeta>

      {nuevo && <NuevoPedido elegirCliente={puede('pedidos.gestionar')} onCerrar={(c) => { setNuevo(false); if (c) { setAviso({ tono: 'ok', texto: `Pedido ${c} registrado` }); void cargar(); } }} />}

      <Dialogo abierto={sel !== null} titulo={`Pedido ${sel?.codigo ?? ''}`} descripcion={sel ? `${sel.cliente} · entrega ${sel.fecha_entrega}${sel.hora_entrega ? ' ' + sel.hora_entrega : ''} · ${ESTADOS[sel.estado]?.label}` : ''}
        onCerrar={() => setSel(null)}
        acciones={sel && gestiona ? <>
          {sel.estado === 'REGISTRADO' && <Boton onClick={() => setMotivo({ destino: 'RECHAZADO', texto: '' })} disabled={ocupado}>Rechazar</Boton>}
          {['CONFIRMADO', 'EN_PRODUCCION', 'LISTO'].includes(sel.estado) && <Boton onClick={() => setMotivo({ destino: 'CANCELADO', texto: '' })} disabled={ocupado}>Anular pedido</Boton>}
          {SIGUIENTE[sel.estado] && <Boton variant="primary" onClick={() => void avanzar(sel, SIGUIENTE[sel.estado])} disabled={ocupado}>{sel.estado === 'REGISTRADO' ? 'Confirmar' : 'Marcar listo'}</Boton>}
          {sel.estado === 'DESPACHADO' && <Boton variant="primary" onClick={() => setMotivo({ destino: 'ENTREGADO', texto: '' })} disabled={ocupado}>Confirmar entrega</Boton>}
          {sel.estado === 'LISTO' && puede('ventas.registrar') && sel.items.length > 0 && <Boton variant="primary" onClick={() => void despachar(sel)} disabled={ocupado || (conReferencia && pago.referencia.trim().length < 3)}>Despachar y vender</Boton>}
        </> : <Boton onClick={() => setSel(null)}>Cerrar</Boton>}>
        {sel && (
          <>
            <table className="table table--compacta"><tbody>
              {sel.items.map((i) => <tr key={i.productoId}><td>{i.producto}</td><td className="t-right">{num2(i.cantidad)}</td><td className="t-right">{money(i.precio * i.cantidad)}</td></tr>)}
              <tr><td><strong>Total</strong></td><td /><td className="t-right"><strong>{money(sel.total)}</strong></td></tr>
            </tbody></table>
            <p className="dialogo__nota">{sel.tipoEntrega === 'DELIVERY' ? `Delivery a: ${sel.direccion}` : 'Recojo en tienda'} · paga contra entrega con {(medios.find((m) => m.codigo === sel.pagoEntrega)?.nombre ?? sel.pagoEntrega ?? 'efectivo').toLowerCase()}</p>
            {sel.observaciones && <p className="dialogo__nota">Observaciones: {sel.observaciones}</p>}
            {sel.motivo && <p className="dialogo__nota">Motivo: {sel.motivo}</p>}
            {sel.entregaObs && <p className="dialogo__nota">Entrega: {sel.entregaObs}</p>}
            {motivo && (
              <div className="form form--dialogo">
                <label className="field"><span className="field__label">{motivo.destino === 'ENTREGADO' ? 'Observación de la entrega (quién recibió, hora…)' : `Motivo para ${motivo.destino === 'RECHAZADO' ? 'rechazar' : 'anular'}`}</span>
                  <input className="field__input" autoFocus maxLength={200} value={motivo.texto} onChange={(e) => setMotivo({ ...motivo, texto: e.target.value })} /></label>
                <div className="form__acciones">
                  <Boton onClick={() => setMotivo(null)}>Volver</Boton>
                  <Boton variant="primary" disabled={ocupado || (motivo.destino !== 'ENTREGADO' && motivo.texto.trim().length < 3)} onClick={() => void avanzar(sel, motivo.destino, motivo.texto.trim())}>
                    {motivo.destino === 'ENTREGADO' ? 'Confirmar entrega' : 'Confirmar'}</Boton>
                </div>
              </div>
            )}
            {sel.estado === 'LISTO' && puede('ventas.registrar') && sel.items.length > 0 && (
              <div className="form form--2col form--dialogo">
                <label className="field"><span className="field__label">Forma de pago</span>
                  <select className="field__input" value={pago.formaPago} onChange={(e) => setPago({ ...pago, formaPago: e.target.value })}>{medios.map((m) => <option key={m.codigo} value={m.codigo}>{m.nombre}</option>)}</select></label>
                <label className="field"><span className="field__label">Descuento autorizado (%)</span>
                  <input className="field__input" type="number" min="0" max="90" step="0.5" value={pago.descuento} onChange={(e) => setPago({ ...pago, descuento: e.target.value })} />
                  {aprobacion ? <span className="field__ayuda">Aprobado por el Gerente hasta {Math.round(aprobacion.porcentaje * 100)} %</span>
                    : Number(pago.descuento) > 0 && <button type="button" className="enlace" disabled={ocupado} onClick={() => void pedirAprobacion(sel)}>Pedir aprobación si supera el máximo</button>}</label>
                {conReferencia && <label className="field field--ancho"><span className="field__label">N.° de operación</span>
                  <input className="field__input" maxLength={60} value={pago.referencia} onChange={(e) => setPago({ ...pago, referencia: e.target.value })} /></label>}
              </div>
            )}
          </>
        )}
      </Dialogo>
    </>
  );
}
