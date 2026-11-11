import { InputNumero } from '@/ui/InputNumero';
import { ComprobanteInput } from '@/modules/almacen/Deudas';
import { Paginador, usePaginado } from '@/ui/Paginador';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/core/api';
import { exportarExcel, exportarPdf } from '@/core/exportar';
import { useApp } from '@/core/app-state';
import { money, num, num2 } from '@/core/format';
import { Boton, Buscador, Encabezado, Insignia, Tarjeta, TablaEsqueleto, Vacio } from '@/ui/primitives';
import { Dialogo } from '@/ui/Dialogo';
import { useCatalogos } from '@/core/catalogos';
import { NuevoPedido } from './NuevoPedido';
import { LineasPago, useMediosCobro, type LineaPago } from './LineasPago';

const aNumero = (x: string): number | '' => (x === '' ? '' : Number(x));

interface Item { productoId: string; producto: string; cantidad: number; precio: number; presentacion?: string | null; cantidadPresentacion?: number | null; promocionId?: string | null }
/** «2 Paquete x 6 (12 unid)» o «5 unid». */
const cantidadTxt = (i: Item) => (i.presentacion && i.cantidadPresentacion ? `${i.cantidadPresentacion} × ${i.presentacion.toLowerCase()} (${i.cantidad} unid)` : String(i.cantidad));
interface Pedido { id: string; codigo: string; clienteId: string; cliente: string; vendedor: string; estado: string; total: number; fecha_entrega: string; hora_entrega: string; observaciones: string; venta: string | null; items: Item[];
  tipoEntrega?: string; direccion?: string; motivo?: string | null; entregaObs?: string | null; observacion?: string | null; porCobrar?: number | null;
  comprobanteTipo?: string; comprobante?: { nombre: string; numero: string } | null }
// Estados desde los que se puede cancelar (máquina de estados de la API).
const CANCELABLES = ['REGISTRADO', 'CONFIRMADO', 'EN_PRODUCCION', 'LISTO'];

const ESTADOS: Record<string, { label: string; tono: 'info' | 'warn' | 'ok' | 'danger' | 'neutral' }> = {
  REGISTRADO: { label: 'Por confirmar', tono: 'neutral' }, CONFIRMADO: { label: 'Confirmado', tono: 'info' },
  EN_PRODUCCION: { label: 'En producción', tono: 'warn' }, LISTO: { label: 'Listo', tono: 'info' }, DESPACHADO: { label: 'En tránsito', tono: 'info' },
  ENTREGADO: { label: 'Entregado', tono: 'ok' }, RECHAZADO: { label: 'Rechazado', tono: 'danger' }, CANCELADO: { label: 'Cancelado', tono: 'danger' },
};
// RN-26: siguiente paso natural. Un confirmado con stock puede pasar directo a Listo (reserva el stock).
// WEB-01 (informe 03): un pedido «Por confirmar» se confirma solo desde la app; la web lo consulta.
const SIGUIENTE: Record<string, string> = { CONFIRMADO: 'LISTO', EN_PRODUCCION: 'LISTO' };
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
  // Despacho: solo el descuento autorizado; el pago real se registra al entregar.
  const [pago, setPago] = useState({ descuento: '0' });
  const { lineaNueva, revisar, aPagos, nombre: nombreMedio } = useMediosCobro();
  // Entregar y cobrar: lo que paga al recibir (una o varias formas); «no pagó» = todo queda como deuda.
  const [entrega, setEntrega] = useState<{ lineas: LineaPago[]; nota: string; voucher: string | null } | null>(null);
  // El vendedor corrige lo pedido antes de producción (el total lo recalcula el servidor).
  const [corregir, setCorregir] = useState<Array<{ productoId: string; producto: string; cantidad: string; presentacion?: string | null; promocionId?: string | null }> | null>(null);
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger'; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [motivo, setMotivo] = useState<{ destino: 'RECHAZADO' | 'CANCELADO' | 'OBSERVAR'; texto: string } | null>(null);
  // VEN-06: selección múltiple para cancelar varios pedidos con un mismo motivo.
  const [marcados, setMarcados] = useState<Set<string>>(new Set());
  const [motivoVarios, setMotivoVarios] = useState<string | null>(null);
  const { comprobantesVenta } = useCatalogos();
  const nombreComprobante = (c?: string) => comprobantesVenta.find((t) => t.codigo === c)?.nombre ?? c ?? '';

  // RN-36: aprobaciones de descuento del vendedor (la vigente de mayor % se usa al despachar).
  const [aprobaciones, setAprobaciones] = useState<Aprobacion[]>([]);
  useEffect(() => { if (sel && puede('ventas.registrar')) api<Aprobacion[]>('/descuentos/solicitudes').then(setAprobaciones).catch(() => {}); }, [sel]);
  const aprobacion = aprobaciones.filter((a) => a.vigente && a.porcentaje + 1e-6 >= Number(pago.descuento) / 100).sort((a, b) => a.porcentaje - b.porcentaje)[0];
  const pedirAprobacion = (p: Pedido) => accion(async () => {
    await api('/descuentos/solicitudes', { method: 'POST', body: { porcentaje: Number(pago.descuento) / 100, motivo: `Despacho del pedido ${p.codigo}`, clienteId: p.clienteId } });
    return `Descuento de ${pago.descuento} % enviado al Gerente para aprobación`;
  });
  const cargar = () => api<Pedido[]>('/pedidos').then((p) => { setLista(p); setCargaError(null); }).catch((e) => setCargaError(e.message));
  useEffect(() => { void cargar(); }, []);

  const filas = useMemo(() => pedidos.filter((p) => (estado === 'todos' || p.estado === estado)
    && `${p.cliente} ${p.codigo}`.toLowerCase().includes(q.toLowerCase())), [pedidos, q, estado]);
  const porEstado = (e: string) => pedidos.filter((p) => p.estado === e).length;

  const accion = async (fn: () => Promise<string>) => {
    setOcupado(true);
    setAviso(null);
    try { const t = await fn(); setSel(null); setMotivo(null); setEntrega(null); await Promise.all([cargar(), refrescarDatos()]); setAviso({ tono: 'ok', texto: t }); }
    catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo completar.' }); }
    finally { setOcupado(false); }
  };
  const avanzar = (p: Pedido, a: string, texto = '') => accion(async () => {
    await api(`/pedidos/${p.codigo}/estado`, { method: 'PATCH', body: { estado: a, motivo: texto, observaciones: texto } });
    setMotivo(null);
    return `${p.codigo} → ${ESTADOS[a].label}${a === 'LISTO' ? ' · stock reservado' : ''}`;
  });
  const observar = (p: Pedido, mensaje: string) => accion(async () => {
    await api(`/pedidos/${p.codigo}/observar`, { method: 'POST', body: { mensaje } });
    return `Observación enviada a ${p.cliente}: el pedido sigue ${ESTADOS[p.estado].label.toLowerCase()}.`;
  });
  // Despachar = vender lo pedido «por cobrar» (descuenta stock, congela costo, genera la cuenta por cobrar) y marcar despachado.
  // Cómo paga el cliente (todo, una parte o nada) se registra al entregar.
  const despachar = (p: Pedido) => accion(async () => {
    const v = await api<{ codigo: string; comprobante: { numero: string }; alertaCredito: string | null }>('/ventas', {
      method: 'POST', conIdempotencia: true,
      // Se despacha en la presentación pedida (paquete x 6): el servidor la convierte a unidades y descarga su empaque.
      body: { items: p.items.map((i) => (i.presentacion ? { productoId: i.productoId, cantidad: i.cantidadPresentacion ?? i.cantidad, presentacion: i.presentacion } : { productoId: i.productoId, cantidad: i.cantidad })), formaPago: 'CREDITO', clienteId: p.clienteId, pedidoId: p.id, descuentoPct: Number(pago.descuento) / 100,
        ...(aprobacion ? { aprobacionDescuentoId: aprobacion.id } : {}) },
    });
    return `${p.codigo} despachado · ${nombreComprobante(p.comprobanteTipo).toLowerCase() || 'comprobante'} ${v.comprobante.numero} · por cobrar al entregar${v.alertaCredito ? ` · ${v.alertaCredito}` : ''}`;
  });
  const debeEntrega = (p: Pedido) => p.porCobrar ?? p.total;
  const revisionEntrega = sel && entrega ? revisar(entrega.lineas, debeEntrega(sel)) : null;
  const entregar = (p: Pedido, conPago: boolean) => accion(async () => {
    const pagos = conPago && entrega ? aPagos(entrega.lineas) : [];
    const r = await api<{ recibo: { numero: string } | null; quedaPorCobrar: number }>(`/pedidos/${p.codigo}/estado`, {
      method: 'PATCH', body: { estado: 'ENTREGADO', motivo: '', observaciones: entrega?.nota.trim() ?? '', pagos, voucher: pagos.length ? entrega?.voucher ?? null : null } });
    return `${p.codigo} entregado${r.recibo ? ` · recibo ${r.recibo.numero} (${pagos.map((x) => `${nombreMedio(x.medio).toLowerCase()} ${money(x.monto)}`).join(' + ')})` : ' · sin pago'}${r.quedaPorCobrar > 0.009 ? ` · queda ${money(r.quedaPorCobrar)} por cobrar en Cobranza` : ' · saldado'}`;
  });

  const guardarCorreccion = (p: Pedido) => accion(async () => {
    const r = await api<{ total: number }>(`/pedidos/${p.codigo}/items`, { method: 'PUT', body: { items: corregir!.map((i) => ({ productoId: i.productoId, cantidad: Number(i.cantidad), ...(i.presentacion ? { presentacion: i.presentacion } : {}), ...(i.promocionId ? { promocionId: i.promocionId } : {}) })) } });
    setCorregir(null);
    return `${p.codigo} corregido · nuevo total ${money(r.total)} · el cliente recibió el aviso`;
  });
  const cancelarVarios = (texto: string) => accion(async () => {
    const r = await api<{ cancelados: string[]; rechazados: Array<{ codigo: string; motivo: string }> }>('/pedidos/cancelar-varios', { method: 'POST', body: { codigos: [...marcados], motivo: texto } });
    setMarcados(new Set()); setMotivoVarios(null);
    return `${r.cancelados.length} pedido(s) cancelado(s)${r.rechazados.length ? ` · no se cancelaron: ${r.rechazados.map((x) => `${x.codigo} (${x.motivo})`).join(', ')}` : ''}`;
  });
  const marcar = (codigo: string) => setMarcados((m) => { const n = new Set(m); if (n.has(codigo)) n.delete(codigo); else n.add(codigo); return n; });
  const gestiona = puede('pedidos.gestionar');
  const pagPedidos = usePaginado(filas, 25);
  return (
    <>
      <Encabezado titulo="Pedidos" descripcion="Del registro del cliente al despacho · cada cambio queda auditado"
        acciones={<>
          <Boton icono="download" onClick={() => exportarExcel('pedidos', filas.map(({ items, ...p }) => ({ ...p, productos: items.map((i) => `${cantidadTxt(i)} ${i.producto}`).join(', ') })))}>Excel</Boton>
          <Boton icono="report" onClick={exportarPdf}>PDF</Boton>
          {puede('pedidos.crear') && <Boton variant="primary" icono="plus" onClick={() => setNuevo(true)}>Registrar pedido</Boton>}
        </>} />
      {aviso && <div className={`aviso aviso--${aviso.tono}`} role="status"><span className="aviso__icono">{aviso.tono === 'ok' ? '✓' : '!'}</span><div><p>{aviso.texto}</p></div></div>}

      <div className="grid grid--auto">
        {/* Por producir = confirmados y en producción; los «por confirmar» todavía no se producen. */}
        <Tarjeta className="mini-stat"><span>Por producir</span><b>{porEstado('CONFIRMADO') + porEstado('EN_PRODUCCION')}</b></Tarjeta>
        <Tarjeta className="mini-stat"><span>Listos para despacho</span><b>{porEstado('LISTO')}</b></Tarjeta>
        <Tarjeta className="mini-stat"><span>En tránsito</span><b>{porEstado('DESPACHADO')}</b></Tarjeta>
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
        {gestiona && marcados.size > 0 && (
          <div className="toolbar toolbar--seleccion" role="region" aria-label="Pedidos seleccionados">
            {motivoVarios === null ? <>
              <span><b>{marcados.size}</b> pedido(s) seleccionado(s)</span>
              <Boton onClick={() => setMarcados(new Set())}>Quitar selección</Boton>
              <Boton variant="danger" onClick={() => setMotivoVarios('')} disabled={ocupado}>Cancelar seleccionados</Boton>
            </> : <>
              <input className="field__input" autoFocus maxLength={200} placeholder="Motivo de la cancelación (le llega a cada cliente)" aria-label="Motivo de la cancelación"
                value={motivoVarios} onChange={(e) => setMotivoVarios(e.target.value)} />
              <Boton onClick={() => setMotivoVarios(null)}>Volver</Boton>
              <Boton variant="danger" disabled={ocupado || motivoVarios.trim().length < 3} onClick={() => void cancelarVarios(motivoVarios.trim())}>Cancelar {marcados.size} pedido(s)</Boton>
            </>}
          </div>
        )}
        {cargaError ? <Vacio titulo="No se pudo cargar" detalle={cargaError} onReintentar={() => { setCargaError(null); setLista(null); void cargar(); }} />
          : lista === null ? <TablaEsqueleto columnas={6} />
          : filas.length === 0 ? <Vacio titulo="Sin pedidos" detalle="No hay pedidos con este filtro." icono="clipboard" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr>{gestiona && <th className="col-check"><input type="checkbox" aria-label="Seleccionar todos los cancelables de esta página"
              checked={pagPedidos.visibles.some((p) => CANCELABLES.includes(p.estado)) && pagPedidos.visibles.filter((p) => CANCELABLES.includes(p.estado)).every((p) => marcados.has(p.codigo))}
              onChange={(e) => setMarcados((m) => { const n = new Set(m); for (const p of pagPedidos.visibles) if (CANCELABLES.includes(p.estado)) { if (e.target.checked) n.add(p.codigo); else n.delete(p.codigo); } return n; })} /></th>}
              <th>Pedido</th><th>Cliente</th><th>Productos</th><th>Entrega</th><th className="t-right">Total</th><th className="t-right">Estado</th></tr></thead>
            <tbody>{pagPedidos.visibles.map((p) => (
              <tr key={p.id} className={`is-clickable${marcados.has(p.codigo) ? ' is-selected' : ''}`} onClick={() => { setPago({ descuento: '0' }); setMotivo(null); setEntrega(null); setSel(p); }}>
                {gestiona && <td className="col-check" onClick={(e) => e.stopPropagation()}>
                  {CANCELABLES.includes(p.estado) && <input type="checkbox" aria-label={`Seleccionar ${p.codigo}`} checked={marcados.has(p.codigo)} onChange={() => marcar(p.codigo)} />}</td>}
                <td><strong className="mono">{p.codigo}</strong>{p.venta && <div className="t-muted mono">{p.venta}</div>}</td>
                <td>{p.cliente}</td>
                <td className="t-muted">{p.items.slice(0, 2).map((i) => `${num(i.cantidad)} ${i.producto}`).join(', ')}{p.items.length > 2 ? ` +${p.items.length - 2}` : ''}</td>
                <td>{p.fecha_entrega}{p.hora_entrega ? ` · ${p.hora_entrega}` : ''}</td>
                <td className="t-right"><strong>{money(p.total)}</strong></td>
                <td className="t-right"><Insignia tono={ESTADOS[p.estado]?.tono ?? 'neutral'} punto>{ESTADOS[p.estado]?.label ?? p.estado}</Insignia>
                  {p.observacion && ['REGISTRADO', 'CONFIRMADO'].includes(p.estado) && <div><Insignia tono="warn">Observado</Insignia></div>}
                  {p.estado === 'ENTREGADO' && (p.porCobrar ?? 0) > 0.009 && <div className="t-neg">por cobrar {money(p.porCobrar!)}</div>}</td>
              </tr>))}</tbody>
          </table></div>
        )}
        <Paginador {...pagPedidos} />
        <div className="card__foot"><span className="t-muted">{num(filas.length)} pedidos · {money(filas.reduce((s, p) => s + p.total, 0))} en total</span></div>
      </Tarjeta>

      {nuevo && <NuevoPedido elegirCliente={puede('pedidos.gestionar')} onCerrar={(c) => { setNuevo(false); if (c) { setAviso({ tono: 'ok', texto: `Pedido ${c} registrado` }); void cargar(); } }} />}

      <Dialogo abierto={sel !== null} titulo={`Pedido ${sel?.codigo ?? ''}`} descripcion={sel ? `${sel.cliente} · entrega ${sel.fecha_entrega}${sel.hora_entrega ? ' ' + sel.hora_entrega : ''} · ${ESTADOS[sel.estado]?.label}` : ''}
        onCerrar={() => { setSel(null); setCorregir(null); }}
        acciones={sel && gestiona ? <>
          {['REGISTRADO', 'CONFIRMADO'].includes(sel.estado) && !corregir && <Boton onClick={() => setCorregir(sel.items.map((i) => ({ productoId: i.productoId, cantidad: String(i.presentacion && i.cantidadPresentacion ? i.cantidadPresentacion : i.cantidad), presentacion: i.presentacion, promocionId: i.promocionId,
            producto: i.presentacion ? `${i.producto} · ${i.presentacion.toLowerCase()}` : i.promocionId ? `${i.producto} · promoción` : i.producto })))} disabled={ocupado}>Corregir</Boton>}
          {corregir && <Boton variant="primary" onClick={() => void guardarCorreccion(sel)} disabled={ocupado || !corregir.length || corregir.some((i) => !(Number(i.cantidad) > 0))}>Guardar corrección</Boton>}
          {['REGISTRADO', 'CONFIRMADO'].includes(sel.estado) && <Boton onClick={() => setMotivo({ destino: 'OBSERVAR', texto: '' })} disabled={ocupado}>Observar</Boton>}
          {sel.estado === 'REGISTRADO' && <Boton onClick={() => setMotivo({ destino: 'RECHAZADO', texto: '' })} disabled={ocupado}>Rechazar</Boton>}
          {['CONFIRMADO', 'EN_PRODUCCION', 'LISTO'].includes(sel.estado) && <Boton onClick={() => setMotivo({ destino: 'CANCELADO', texto: '' })} disabled={ocupado}>Anular pedido</Boton>}
          {SIGUIENTE[sel.estado] && <Boton variant="primary" onClick={() => void avanzar(sel, SIGUIENTE[sel.estado])} disabled={ocupado}>Marcar listo</Boton>}
          {sel.estado === 'DESPACHADO' && !entrega && <Boton variant="primary" onClick={() => setEntrega({ lineas: [lineaNueva(debeEntrega(sel))], nota: '', voucher: null })} disabled={ocupado}>Entregar y cobrar</Boton>}
          {sel.estado === 'DESPACHADO' && entrega && <>
            <Boton onClick={() => void entregar(sel, false)} disabled={ocupado}>No pagó: dejar como deuda</Boton>
            {puede('cobranza.registrar') && <Boton variant="primary" onClick={() => void entregar(sel, true)} disabled={ocupado || !!revisionEntrega?.problema}>Entregar y cobrar {money(revisionEntrega?.suma ?? 0)}</Boton>}
          </>}
          {sel.estado === 'LISTO' && puede('ventas.registrar') && sel.items.length > 0 && <Boton variant="primary" onClick={() => void despachar(sel)} disabled={ocupado}>Despachar</Boton>}
        </> : <Boton onClick={() => setSel(null)}>Cerrar</Boton>}>
        {sel && (
          <>
            <table className="table table--compacta"><tbody>
              {sel.items.map((i, k) => <tr key={k}><td>{i.producto}</td><td className="t-right">{i.presentacion ? cantidadTxt(i) : num2(i.cantidad)}</td><td className="t-right">{money(i.precio * i.cantidad)}</td></tr>)}
              <tr><td><strong>Total</strong></td><td /><td className="t-right"><strong>{money(sel.total)}</strong></td></tr>
            </tbody></table>
            {corregir && <div className="form form--2col form--dialogo">
              {corregir.map((i, k) => <div key={`${i.productoId}|${i.presentacion ?? ''}|${i.promocionId ?? ''}`} className="pago-linea field--ancho">
                <label className="field"><span className="field__label">{i.producto}</span><InputNumero className="field__input" valor={aNumero(i.cantidad)} onValor={(n) => { const v = String(n); setCorregir(corregir.map((x, j) => (j === k ? { ...x, cantidad: v } : x))); }} /></label>
                {corregir.length > 1 && <button type="button" className="pago-linea__quitar" aria-label={`Quitar ${i.producto}`} onClick={() => setCorregir(corregir.filter((_, j) => j !== k))}>×</button>}
              </div>)}
            </div>}
            <p className="dialogo__nota">{sel.tipoEntrega === 'DELIVERY' ? `Entrega en: ${sel.direccion}` : 'Recojo en tienda'}{(sel as Pedido & { vehiculo?: string | null }).vehiculo ? ` · móvil ${(sel as Pedido & { vehiculo?: string | null }).vehiculo}` : ''}{sel.porCobrar != null ? ` · por cobrar ${money(sel.porCobrar)}` : ' · se cobra al entregar'}</p>
            <p className="dialogo__nota">Comprobante: {sel.comprobante ? `${sel.comprobante.nombre} ${sel.comprobante.numero}` : `${nombreComprobante(sel.comprobanteTipo)} (se emite al despachar)`}</p>
            {sel.estado === 'REGISTRADO' && <p className="dialogo__nota t-warn">Este pedido se confirma desde la app Tanta.</p>}
            {sel.observaciones && <p className="dialogo__nota">Nota del cliente: {sel.observaciones}</p>}
            {sel.observacion && <p className="dialogo__nota t-warn">Observación enviada al cliente: {sel.observacion}</p>}
            {sel.motivo && <p className="dialogo__nota">Motivo: {sel.motivo}</p>}
            {sel.entregaObs && <p className="dialogo__nota">Entrega: {sel.entregaObs}</p>}
            {motivo && (
              <div className="form form--dialogo">
                <label className="field"><span className="field__label">{motivo.destino === 'OBSERVAR' ? '¿Qué está mal en el pedido? (le llega al cliente)' : `Motivo para ${motivo.destino === 'RECHAZADO' ? 'rechazar' : 'anular'}`}</span>
                  <input className="field__input" autoFocus maxLength={200} value={motivo.texto} onChange={(e) => setMotivo({ ...motivo, texto: e.target.value })} /></label>
                <div className="form__acciones">
                  <Boton onClick={() => setMotivo(null)}>Volver</Boton>
                  <Boton variant="primary" disabled={ocupado || motivo.texto.trim().length < (motivo.destino === 'OBSERVAR' ? 5 : 3)}
                    onClick={() => void (motivo.destino === 'OBSERVAR' ? observar(sel, motivo.texto.trim()) : avanzar(sel, motivo.destino, motivo.texto.trim()))}>
                    {motivo.destino === 'OBSERVAR' ? 'Enviar observación' : 'Confirmar'}</Boton>
                </div>
              </div>
            )}
            {sel.estado === 'LISTO' && puede('ventas.registrar') && sel.items.length > 0 && (
              <div className="form form--2col form--dialogo">
                <p className="dialogo__nota field--ancho">Al despachar se registra la venta y queda por cobrar. El pago (todo, una parte o nada) se registra al entregar.</p>
                <label className="field"><span className="field__label">Descuento autorizado (%)</span>
                  <input className="field__input" type="number" min="0" max="90" step="0.5" value={pago.descuento} onChange={(e) => setPago({ ...pago, descuento: e.target.value })} />
                  {aprobacion ? <span className="field__ayuda">Aprobado por el Gerente hasta {Math.round(aprobacion.porcentaje * 100)} %</span>
                    : Number(pago.descuento) > 0 && <button type="button" className="enlace" disabled={ocupado} onClick={() => void pedirAprobacion(sel)}>Pedir aprobación si supera el máximo</button>}</label>
              </div>
            )}
            {sel.estado === 'DESPACHADO' && entrega && (
              <div className="form form--2col form--dialogo">
                <p className="dialogo__nota field--ancho">Debe {money(debeEntrega(sel))}. Registra lo que pagó al recibir; lo que falte queda como deuda en Cobranza.</p>
                {puede('cobranza.registrar') && <ComprobanteInput valor={entrega.voucher} onChange={(voucher) => setEntrega({ ...entrega, voucher })} onError={(texto) => setAviso({ tono: 'danger', texto })} />}
                {puede('cobranza.registrar') && <LineasPago lineas={entrega.lineas} onChange={(lineas) => setEntrega({ ...entrega, lineas })} debe={debeEntrega(sel)} />}
                <label className="field field--ancho"><span className="field__label">Nota de la entrega (quién recibió, hora…)</span>
                  <input className="field__input" maxLength={200} value={entrega.nota} onChange={(e) => setEntrega({ ...entrega, nota: e.target.value })} /></label>
              </div>
            )}
          </>
        )}
      </Dialogo>
    </>
  );
}
