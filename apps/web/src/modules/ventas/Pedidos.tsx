import { useEffect, useMemo, useState } from 'react';
import { api } from '@/core/api';
import { exportarExcel, exportarPdf } from '@/core/exportar';
import { useApp } from '@/core/app-state';
import { money, num, num2 } from '@/core/format';
import { Boton, Buscador, Encabezado, Insignia, Tarjeta, Vacio } from '@/ui/primitives';
import { Dialogo } from '@/ui/Dialogo';
import { NuevoPedido } from './NuevoPedido';

interface Item { productoId: string; producto: string; cantidad: number; precio: number }
interface Pedido { id: string; codigo: string; clienteId: string; cliente: string; vendedor: string; estado: string; total: number; fecha_entrega: string; hora_entrega: string; observaciones: string; venta: string | null; items: Item[] }

const ESTADOS: Record<string, { label: string; tono: 'info' | 'warn' | 'ok' | 'danger' | 'neutral' }> = {
  REGISTRADO: { label: 'Registrado', tono: 'neutral' }, EN_PRODUCCION: { label: 'En producción', tono: 'warn' },
  LISTO: { label: 'Listo', tono: 'info' }, DESPACHADO: { label: 'Despachado', tono: 'info' },
  ENTREGADO: { label: 'Entregado', tono: 'ok' }, CANCELADO: { label: 'Cancelado', tono: 'danger' },
};
const SIGUIENTE: Record<string, string> = { REGISTRADO: 'EN_PRODUCCION', EN_PRODUCCION: 'LISTO', DESPACHADO: 'ENTREGADO' };
const MEDIOS = ['EFECTIVO', 'TRANSFERENCIA', 'YAPE', 'PLIN', 'CREDITO'];

/** Pedidos: registro, avance por estados y despacho con venta vinculada (trazabilidad pedido → venta). */
export function Pedidos() {
  const { puede, refrescarDatos } = useApp();
  const [pedidos, setPedidos] = useState<Pedido[]>([]);
  const [q, setQ] = useState('');
  const [estado, setEstado] = useState('todos');
  const [nuevo, setNuevo] = useState(false);
  const [sel, setSel] = useState<Pedido | null>(null);
  const [pago, setPago] = useState({ formaPago: 'EFECTIVO', descuento: '0' });
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger'; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const cargar = () => api<Pedido[]>('/pedidos').then(setPedidos).catch((e) => setAviso({ tono: 'danger', texto: e.message }));
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
  const avanzar = (p: Pedido, a: string) => accion(async () => {
    await api(`/pedidos/${p.codigo}/estado`, { method: 'PATCH', body: { estado: a } });
    return `${p.codigo} → ${ESTADOS[a].label}`;
  });
  // Despachar = vender lo pedido (descuenta stock, congela costo, genera CxC si es crédito) y marcar despachado.
  const despachar = (p: Pedido) => accion(async () => {
    const v = await api<{ codigo: string }>('/ventas', {
      method: 'POST', conIdempotencia: true,
      body: { items: p.items.map((i) => ({ productoId: i.productoId, cantidad: i.cantidad })), formaPago: pago.formaPago, clienteId: p.clienteId, pedidoId: p.id, descuentoPct: Number(pago.descuento) / 100 },
    });
    await api(`/pedidos/${p.codigo}/estado`, { method: 'PATCH', body: { estado: 'DESPACHADO' } });
    return `${p.codigo} despachado · venta ${v.codigo}`;
  });

  const gestiona = puede('pedidos.gestionar');
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
        {filas.length === 0 ? <Vacio titulo="Sin pedidos" detalle="No hay pedidos con este filtro." icono="clipboard" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Pedido</th><th>Cliente</th><th>Productos</th><th>Entrega</th><th className="t-right">Total</th><th className="t-right">Estado</th></tr></thead>
            <tbody>{filas.map((p) => (
              <tr key={p.id} className="is-clickable" onClick={() => { setPago({ formaPago: 'EFECTIVO', descuento: '0' }); setSel(p); }}>
                <td><strong className="mono">{p.codigo}</strong>{p.venta && <div className="t-muted mono">{p.venta}</div>}</td>
                <td>{p.cliente}</td>
                <td className="t-muted">{p.items.slice(0, 2).map((i) => `${num(i.cantidad)} ${i.producto}`).join(', ')}{p.items.length > 2 ? ` +${p.items.length - 2}` : ''}</td>
                <td>{p.fecha_entrega}{p.hora_entrega ? ` · ${p.hora_entrega}` : ''}</td>
                <td className="t-right"><strong>{money(p.total)}</strong></td>
                <td className="t-right"><Insignia tono={ESTADOS[p.estado]?.tono ?? 'neutral'} punto>{ESTADOS[p.estado]?.label ?? p.estado}</Insignia></td>
              </tr>))}</tbody>
          </table></div>
        )}
        <div className="card__foot"><span className="t-muted">{num(filas.length)} pedidos · {money(filas.reduce((s, p) => s + p.total, 0))} en total</span></div>
      </Tarjeta>

      {nuevo && <NuevoPedido elegirCliente={puede('pedidos.gestionar')} onCerrar={(c) => { setNuevo(false); if (c) { setAviso({ tono: 'ok', texto: `Pedido ${c} registrado` }); void cargar(); } }} />}

      <Dialogo abierto={sel !== null} titulo={`Pedido ${sel?.codigo ?? ''}`} descripcion={sel ? `${sel.cliente} · entrega ${sel.fecha_entrega}${sel.hora_entrega ? ' ' + sel.hora_entrega : ''} · ${ESTADOS[sel.estado]?.label}` : ''}
        onCerrar={() => setSel(null)}
        acciones={sel && gestiona ? <>
          {!['ENTREGADO', 'CANCELADO', 'DESPACHADO'].includes(sel.estado) && <Boton onClick={() => void avanzar(sel, 'CANCELADO')} disabled={ocupado}>Cancelar pedido</Boton>}
          {SIGUIENTE[sel.estado] && <Boton variant="primary" onClick={() => void avanzar(sel, SIGUIENTE[sel.estado])} disabled={ocupado}>Pasar a {ESTADOS[SIGUIENTE[sel.estado]].label.toLowerCase()}</Boton>}
          {sel.estado === 'LISTO' && puede('ventas.registrar') && sel.items.length > 0 && <Boton variant="primary" onClick={() => void despachar(sel)} disabled={ocupado}>Despachar y vender</Boton>}
        </> : <Boton onClick={() => setSel(null)}>Cerrar</Boton>}>
        {sel && (
          <>
            <table className="table table--compacta"><tbody>
              {sel.items.map((i) => <tr key={i.productoId}><td>{i.producto}</td><td className="t-right">{num2(i.cantidad)}</td><td className="t-right">{money(i.precio * i.cantidad)}</td></tr>)}
              <tr><td><strong>Total</strong></td><td /><td className="t-right"><strong>{money(sel.total)}</strong></td></tr>
            </tbody></table>
            {sel.observaciones && <p className="dialogo__nota">Observaciones: {sel.observaciones}</p>}
            {sel.estado === 'LISTO' && puede('ventas.registrar') && sel.items.length > 0 && (
              <div className="form form--2col form--dialogo">
                <label className="field"><span className="field__label">Forma de pago</span>
                  <select className="field__input" value={pago.formaPago} onChange={(e) => setPago({ ...pago, formaPago: e.target.value })}>{MEDIOS.map((m) => <option key={m} value={m}>{m[0] + m.slice(1).toLowerCase()}</option>)}</select></label>
                <label className="field"><span className="field__label">Descuento autorizado (%)</span>
                  <input className="field__input" type="number" min="0" max="90" step="0.5" value={pago.descuento} onChange={(e) => setPago({ ...pago, descuento: e.target.value })} /></label>
              </div>
            )}
          </>
        )}
      </Dialogo>
    </>
  );
}
