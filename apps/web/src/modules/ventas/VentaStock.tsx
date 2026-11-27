import { useEffect, useMemo, useState } from 'react';
import { api } from '@/core/api';
import { useCatalogos } from '@/core/catalogos';
import { money } from '@/core/format';
import { Boton } from '@/ui/primitives';
import { Dialogo } from '@/ui/Dialogo';

const hoy = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
interface Disponible { id: string; codigo: string; nombre: string; precio: number; stock: number; apartado: number; vencido: number; libre: number; venceHoy: number;
  proximoVence: string | null; promocion: { id: string; titulo: string; precio: number } | null }
interface Aprobacion { id: string; porcentaje: number; estado: string; vigente: boolean; cliente: string | null }
export interface Direccion { id: string | null; direccion: string; referencia: string; principal: boolean }

/** Dirección de entrega: se elige de las registradas del cliente (no se escribe) o recojo en tienda. */
export function SelectorDireccion({ direcciones, valor, onChange, ayuda }: { direcciones: Direccion[]; valor: string; onChange: (v: string) => void; ayuda: string }) {
  return (
    <label className="field"><span className="field__label">Entrega</span>
      <select className="field__input" value={valor} onChange={(e) => onChange(e.target.value)}>
        {direcciones.map((d) => <option key={d.direccion} value={d.direccion}>{d.direccion}{d.referencia ? ` (${d.referencia})` : ''}{d.principal ? ' · principal' : ''}</option>)}
        <option value="">Recojo en tienda</option>
      </select>
      <span className="field__ayuda">{direcciones.length ? ayuda : `Sin direcciones registradas: ${ayuda.charAt(0).toLowerCase()}${ayuda.slice(1)}`}</span></label>
  );
}

/**
 * Venta de stock (respuesta del ingeniero): el vendedor vende pan ya producido. Ve lo que queda libre (sin lo apartado
 * ni lo vencido) y lo que vence hoy; pone el precio de cada producto. Bajar el precio necesita la aprobación del Gerente
 * por encima del tope de Parámetros. El pan queda apartado y el pedido pasa directo a Despacho (sale del almacén al despachar).
 */
export function VentaStock({ onCerrar }: { onCerrar: (codigo?: string) => void }) {
  const { comprobantesVenta } = useCatalogos();
  const [datos, setDatos] = useState<{ descuentoMaximo: number; productos: Disponible[] } | null>(null);
  const [clientes, setClientes] = useState<Array<{ id: string; nombre: string }>>([]);
  const [clienteId, setClienteId] = useState('');
  const [direcciones, setDirecciones] = useState<Direccion[]>([]);
  const [direccion, setDireccion] = useState('');
  const [lineas, setLineas] = useState<Array<{ productoId: string; cantidad: string; precio: string; promocionId?: string }>>([]);
  const [comprobante, setComprobante] = useState('');
  const [fecha, setFecha] = useState(hoy());
  const [obs, setObs] = useState('');
  const [aprobaciones, setAprobaciones] = useState<Aprobacion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [nota, setNota] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const cargarAprobaciones = () => api<Aprobacion[]>('/descuentos/solicitudes').then(setAprobaciones).catch(() => {});
  useEffect(() => {
    api<{ clientes: Array<{ id: string; nombre: string }> }>('/reportes-filtros').then((r) => { setClientes(r.clientes); setClienteId(r.clientes[0]?.id ?? ''); }).catch((e) => setError(e.message));
    void cargarAprobaciones();
  }, []);
  useEffect(() => { if (!comprobante && comprobantesVenta[0]) setComprobante(comprobantesVenta[0].codigo); }, [comprobantesVenta, comprobante]);
  // Precios según la lista del cliente elegido: al cambiar de cliente, las líneas sin oferta toman su precio.
  useEffect(() => {
    if (!clienteId) return;
    api<{ descuentoMaximo: number; productos: Disponible[] }>(`/ventas-stock/productos?clienteId=${clienteId}`).then((r) => {
      setDatos(r);
      setLineas((ls) => ls.map((l) => { const p = r.productos.find((x) => x.id === l.productoId); return l.promocionId || !p ? l : { ...l, precio: String(p.precio) }; }));
    }).catch((e) => setError(e.message));
  }, [clienteId]);
  useEffect(() => {
    if (!clienteId) return;
    api<{ direcciones: Direccion[] }>(`/clientes/${clienteId}/direcciones`).then((r) => { setDirecciones(r.direcciones); setDireccion(r.direcciones[0]?.direccion ?? ''); }).catch(() => setDirecciones([]));
  }, [clienteId]);

  const prod = (id: string) => datos?.productos.find((p) => p.id === id);
  const conStock = (datos?.productos ?? []).filter((p) => p.libre > 0);
  const agregar = (id: string) => {
    const p = prod(id);
    if (!p || lineas.some((l) => l.productoId === id)) return;
    // Con oferta vigente, se propone el precio de la oferta (ya aprobado al publicarla).
    setLineas([...lineas, { productoId: id, cantidad: '1', precio: String(p.promocion?.precio ?? p.precio), promocionId: p.promocion?.id }]);
  };
  const base = (l: { productoId: string; promocionId?: string }) => (l.promocionId ? prod(l.productoId)?.promocion?.precio : prod(l.productoId)?.precio) ?? 0;
  const rebaja = (l: { productoId: string; precio: string; promocionId?: string }) => { const b = base(l); return b > 0 ? Math.max(0, 1 - Number(l.precio) / b) : 0; };
  const mayorRebaja = Math.max(0, ...lineas.map(rebaja));
  const tope = datos?.descuentoMaximo ?? 0;
  const pideAprobacion = mayorRebaja > tope + 1e-6;
  const cliente = clientes.find((c) => c.id === clienteId)?.nombre ?? '';
  const aprobacion = useMemo(() => aprobaciones.filter((a) => a.vigente && a.porcentaje + 1e-6 >= mayorRebaja && (!a.cliente || a.cliente === cliente))
    .sort((a, b) => a.porcentaje - b.porcentaje)[0], [aprobaciones, mayorRebaja, cliente]);
  const total = lineas.reduce((s, l) => s + Number(l.precio) * (Number(l.cantidad) || 0), 0);
  const faltaStock = lineas.find((l) => Number(l.cantidad) > (prod(l.productoId)?.libre ?? 0));
  const valido = clienteId && lineas.length > 0 && lineas.every((l) => Number.isInteger(Number(l.cantidad)) && Number(l.cantidad) > 0 && Number(l.precio) >= 0 && l.precio !== '')
    && !faltaStock && (!pideAprobacion || aprobacion) && fecha >= hoy();

  const pedir = async () => {
    setError(null); setOcupado(true);
    try {
      await api('/descuentos/solicitudes', { method: 'POST', body: { porcentaje: Math.min(0.9, Number(mayorRebaja.toFixed(4))), clienteId, paraStock: true,
        motivo: `Venta de stock a ${cliente}: ${lineas.map((l) => `${l.cantidad} ${prod(l.productoId)?.nombre} a ${money(Number(l.precio))}`).join(', ')}`.slice(0, 200) } });
      setNota(`Se pidió al Gerente aprobar una rebaja de ${Math.ceil(mayorRebaja * 100)} %. Cuando la apruebe, pulsa «Actualizar» y registra la venta.`);
      await cargarAprobaciones();
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo pedir la aprobación.'); }
    finally { setOcupado(false); }
  };
  const guardar = async () => {
    setError(null); setOcupado(true);
    try {
      const r = await api<{ codigo: string }>('/pedidos/stock', { method: 'POST', conIdempotencia: true, body: {
        clienteId, items: lineas.map((l) => ({ productoId: l.productoId, cantidad: Number(l.cantidad), precio: Number(l.precio), ...(l.promocionId ? { promocionId: l.promocionId } : {}) })),
        fechaEntrega: fecha, direccion, tipoEntrega: direccion ? 'DELIVERY' : 'RECOJO', observaciones: obs, ...(comprobante ? { comprobanteTipo: comprobante } : {}),
        ...(pideAprobacion && aprobacion ? { aprobacionId: aprobacion.id } : {}) } });
      onCerrar(r.codigo);
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo registrar.'); }
    finally { setOcupado(false); }
  };

  return (
    <Dialogo abierto titulo="Venta de stock" descripcion="Pan ya producido: se aparta ahora, no pasa por producción y va directo a Despacho." onCerrar={() => onCerrar()}
      acciones={<><Boton onClick={() => onCerrar()}>Cancelar</Boton>
        {pideAprobacion && !aprobacion && <Boton onClick={() => void pedir()} disabled={ocupado || !lineas.length}>Pedir aprobación al Gerente</Boton>}
        <Boton variant="primary" disabled={!valido || ocupado} onClick={() => void guardar()}>{ocupado ? 'Registrando…' : `Registrar · ${money(total)}`}</Boton></>}>
      <div className="form form--2col form--dialogo">
        <label className="field"><span className="field__label">Cliente</span>
          <select className="field__input" value={clienteId} onChange={(e) => setClienteId(e.target.value)}>{clientes.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select></label>
        <SelectorDireccion direcciones={direcciones} valor={direccion} onChange={setDireccion} ayuda="Agrégalas en Maestros → Clientes." />

        <div className="field--ancho">
          <table className="table table--compacta">
            <thead><tr><th>Pan</th><th className="t-right">Libre</th><th className="t-right">Cantidad</th><th className="t-right">Precio lista</th><th className="t-right">Precio de venta</th><th className="t-right">Importe</th><th /></tr></thead>
            <tbody>{lineas.map((l, k) => {
              const p = prod(l.productoId)!;
              const r = rebaja(l);
              return (
                <tr key={l.productoId}>
                  <td>{p.nombre}{l.promocionId && <div className="t-muted">oferta «{p.promocion?.titulo}»</div>}{p.venceHoy > 0 && <div className="t-warn">{p.venceHoy} vencen hoy</div>}</td>
                  <td className="t-right">{p.libre}</td>
                  <td className="t-right"><input className="field__input field__input--corto" type="number" min="1" step="1" max={p.libre} aria-label={`Cantidad de ${p.nombre}`} value={l.cantidad}
                    onChange={(e) => setLineas(lineas.map((x, j) => (j === k ? { ...x, cantidad: e.target.value } : x)))} /></td>
                  <td className="t-right">{money(base(l))}</td>
                  <td className="t-right"><input className="field__input field__input--corto" type="number" min="0" step="0.05" aria-label={`Precio de ${p.nombre}`} value={l.precio}
                    onChange={(e) => setLineas(lineas.map((x, j) => (j === k ? { ...x, precio: e.target.value } : x)))} />
                    {r > 0.0001 && <div className={r > tope + 1e-6 ? 't-warn' : 't-muted'}>−{Math.round(r * 1000) / 10} %</div>}</td>
                  <td className="t-right">{money(Number(l.precio) * (Number(l.cantidad) || 0))}</td>
                  <td><button type="button" className="iconbtn" aria-label={`Quitar ${p.nombre}`} onClick={() => setLineas(lineas.filter((_, j) => j !== k))}>×</button></td>
                </tr>);
            })}</tbody>
          </table>
          <label className="field"><span className="field__label">Agregar pan con stock</span>
            <select className="field__input" value="" onChange={(e) => agregar(e.target.value)} disabled={!datos}>
              <option value="">{datos ? (conStock.length ? 'Elige un producto…' : 'No hay pan libre en el almacén') : 'Cargando…'}</option>
              {conStock.filter((p) => !lineas.some((l) => l.productoId === p.id)).map((p) =>
                <option key={p.id} value={p.id}>{p.nombre} · quedan {p.libre}{p.venceHoy ? ` (${p.venceHoy} vencen hoy)` : ''} · {money(p.promocion?.precio ?? p.precio)}{p.promocion ? ' oferta' : ''}</option>)}
            </select></label>
        </div>

        <label className="field"><span className="field__label">Fecha de entrega</span><input className="field__input" type="date" min={hoy()} value={fecha} onChange={(e) => setFecha(e.target.value)} /></label>
        <label className="field"><span className="field__label">Comprobante</span>
          <select className="field__input" value={comprobante} onChange={(e) => setComprobante(e.target.value)}>
            {comprobantesVenta.map((t) => <option key={t.codigo} value={t.codigo}>{t.nombre}{t.requiereRuc ? ' (requiere RUC)' : ''}</option>)}</select></label>
        <label className="field field--ancho"><span className="field__label">Observaciones</span><input className="field__input" maxLength={500} value={obs} onChange={(e) => setObs(e.target.value)} /></label>

        <p className="dialogo__nota field--ancho">
          {tope > 0 ? `Puedes bajar el precio hasta ${Math.round(tope * 100)} % sin aprobación; más que eso lo aprueba el Gerente.` : 'Bajar el precio de lista lo aprueba el Gerente (Parámetros → venta_stock_descuento_maximo).'}
          {pideAprobacion && (aprobacion ? ` Aprobado por el Gerente hasta ${Math.round(aprobacion.porcentaje * 100)} %.` : ' Esta venta necesita aprobación.')}
          {pideAprobacion && !aprobacion && <> <button type="button" className="enlace" onClick={() => void cargarAprobaciones()}>Actualizar</button></>}
        </p>
        {faltaStock && <p className="form__error field--ancho" role="alert">Solo quedan {prod(faltaStock.productoId)?.libre} de {prod(faltaStock.productoId)?.nombre}.</p>}
        {nota && <p className="dialogo__nota field--ancho t-ok">{nota}</p>}
        {error && <p className="form__error field--ancho" role="alert">{error}</p>}
      </div>
    </Dialogo>
  );
}
