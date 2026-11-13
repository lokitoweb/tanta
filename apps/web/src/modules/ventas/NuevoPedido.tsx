import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { useApp } from '@/core/app-state';
import { useCatalogos } from '@/core/catalogos';
import { money } from '@/core/format';
import { Boton } from '@/ui/primitives';
import { Dialogo } from '@/ui/Dialogo';

export interface ItemPedido { productoId: string; cantidad: number; presentacion?: string; promocionId?: string; nombre?: string; precio?: number }
const hoy = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);

/**
 * Registrar un pedido: cliente, productos y observaciones. La entrega la calcula el servidor con la hora de corte
 * (el personal puede fijar otra fecha) y va a la tienda del cliente. El cliente no elige cliente: el API lo asigna a su cuenta.
 */
export function NuevoPedido({ inicial = [], elegirCliente, onCerrar }: {
  inicial?: ItemPedido[]; elegirCliente: boolean; onCerrar: (codigo?: string) => void;
}) {
  const { dataset } = useApp();
  const productos = dataset.productos.filter((p) => p.estado === 'ACTIVO' && !p.insumoId); // los intermedios no se venden
  const [clientes, setClientes] = useState<Array<{ id: string; nombre: string }>>([]);
  const [clienteId, setClienteId] = useState('');
  const [items, setItems] = useState<Array<{ productoId: string; cantidad: string; presentacion: string; promocionId?: string; nombre?: string; precio?: number }>>(
    inicial.length ? inicial.map((i) => ({ productoId: i.productoId, cantidad: String(i.cantidad), presentacion: i.presentacion ?? '', promocionId: i.promocionId, nombre: i.nombre, precio: i.precio })) : [{ productoId: productos[0]?.id ?? '', cantidad: '1', presentacion: '' }]);
  const [fecha, setFecha] = useState('');
  const [estimada, setEstimada] = useState('');
  // El cliente envía a una de sus direcciones (hasta el máximo de Parámetros); se agregan en su perfil.
  const [misDirecciones, setMisDirecciones] = useState<string[]>([]);
  useEffect(() => { if (!elegirCliente) api<Array<{ direccion: string }>>('/mis-direcciones').then((l) => { setMisDirecciones(l.map((x) => x.direccion)); if (l[0]) setDireccion(l[0].direccion); }).catch(() => {}); }, [elegirCliente]);
  // Boleta, factura o nota de pedido: el catálogo administrable; la factura exige RUC (lo valida la API).
  const { comprobantesVenta } = useCatalogos();
  const [comprobante, setComprobante] = useState('');
  useEffect(() => { if (!comprobante && comprobantesVenta[0]) setComprobante(comprobantesVenta[0].codigo); }, [comprobantesVenta, comprobante]);
  useEffect(() => { api<{ fecha: string }>('/pedidos/entrega-estimada').then((r) => setEstimada(r.fecha)).catch(() => {}); }, []);
  const [obs, setObs] = useState('');
  const [direccion, setDireccion] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    if (elegirCliente) api<{ clientes: Array<{ id: string; nombre: string }> }>('/reportes-filtros').then((r) => { setClientes(r.clientes); setClienteId(r.clientes[0]?.id ?? ''); }).catch((e) => setError(`No se pudieron cargar los clientes: ${e.message}`));
  }, [elegirCliente]);

  // Presentaciones de venta del producto (unidad + paquetes): cada una con su precio.
  // Presentaciones vendibles: el SKU #1 (si no es la unidad suelta) y las del SKU #2…
  const presDe = (id: string) => {
    const p = productos.find((x) => x.id === id);
    if (!p) return [];
    const eq = p.presentacionEquivalencia ?? 1;
    const sku1 = p.presentacionCodigo && eq !== 1
      ? [{ presentacion: p.presentacionCodigo, nombre: p.presentacionNombre ?? p.presentacionCodigo, precioConIgv: Math.round(p.precioConIgv * eq * 100) / 100 }] : [];
    return [...sku1, ...(p.presentaciones ?? []).filter((x) => x.activo)];
  };
  const precio = (id: string, pres: string) => (pres ? presDe(id).find((x) => x.presentacion === pres)?.precioConIgv : productos.find((p) => p.id === id)?.precioConIgv) ?? 0;
  const total = items.reduce((s, i) => s + (i.precio ?? precio(i.productoId, i.presentacion)) * (Number(i.cantidad) || 0), 0);
  const valido = items.length > 0 && items.every((i) => i.productoId && Number(i.cantidad) > 0) && (!fecha || fecha >= hoy()) && (!elegirCliente || clienteId);

  const guardar = async () => {
    setError(null);
    setGuardando(true);
    try {
      const r = await api<{ codigo: string; pedidos?: Array<{ codigo: string; esOferta: boolean }> }>('/pedidos', {
        method: 'POST', conIdempotencia: true,
        body: { ...(elegirCliente ? { clienteId } : {}), items: items.map((i) => ({ productoId: i.productoId, cantidad: Number(i.cantidad), ...(i.presentacion ? { presentacion: i.presentacion } : {}), ...(i.promocionId ? { promocionId: i.promocionId } : {}) })), ...(fecha ? { fechaEntrega: fecha } : {}), observaciones: obs, direccion, ...(comprobante ? { comprobanteTipo: comprobante } : {}) },
      });
      // Con oferta y productos regulares salen dos pedidos: la oferta va aparte (sin producción, se cobra por separado).
      const oferta = r.pedidos?.find((x) => x.esOferta), regular = r.pedidos?.find((x) => !x.esOferta);
      onCerrar(oferta && regular ? `${regular.codigo} y la oferta ${oferta.codigo} (se cobra aparte)` : r.codigo);
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo registrar.'); }
    finally { setGuardando(false); }
  };

  return (
    <Dialogo abierto titulo="Registrar pedido" descripcion={estimada ? `Se entrega en tu tienda el ${estimada.split('-').reverse().join('/')}.` : 'Se entrega en la tienda del cliente.'} onCerrar={() => onCerrar()}
      acciones={<><Boton onClick={() => onCerrar()}>Cancelar</Boton><Boton variant="primary" disabled={!valido || guardando} onClick={() => void guardar()}>{guardando ? 'Registrando…' : `Registrar · ${money(total)}`}</Boton></>}>
      <div className="form form--2col form--dialogo">
        {elegirCliente && (
          <label className="field field--ancho"><span className="field__label">Cliente</span>
            <select className="field__input" value={clienteId} onChange={(e) => setClienteId(e.target.value)}>{clientes.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select></label>
        )}
        <div className="field--ancho editor-receta">
          <div className="editor-receta__cab"><span>Producto y presentación</span><span>Cantidad</span><span /></div>
          {items.map((it, i) => (
            <div key={i} className="editor-receta__fila">
              <div className="linea-pedido">
                {it.promocionId ? <span className="field__input">{it.nombre} · {money(it.precio ?? 0)} (promoción)</span> : <>
                <select className="field__input" value={it.productoId} aria-label="Producto" onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, productoId: e.target.value, presentacion: '' } : x))}>
                  {productos.map((p) => <option key={p.id} value={p.id}>{p.nombre} · {money(p.precioConIgv)}</option>)}
                </select>
                {presDe(it.productoId).length > 0 && (
                  <select className="field__input" value={it.presentacion} aria-label="Presentación" onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, presentacion: e.target.value } : x))}>
                    <option value="">Unidad · {money(precio(it.productoId, ''))}</option>
                    {presDe(it.productoId).map((x) => <option key={x.presentacion} value={x.presentacion}>{x.nombre} · {money(x.precioConIgv)}</option>)}
                  </select>
                )}
                </>}
              </div>
              <div className="editor-receta__cant"><input className="field__input" type="number" min="1" step="1" aria-label="Cantidad" value={it.cantidad} onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, cantidad: e.target.value } : x))} /></div>
              <button type="button" className="iconbtn" aria-label="Quitar" onClick={() => setItems(items.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          <Boton size="sm" icono="plus" onClick={() => setItems([...items, { productoId: productos[0]?.id ?? '', cantidad: '1', presentacion: '' }])}>Agregar producto</Boton>
        </div>
        {elegirCliente && <label className="field"><span className="field__label">Fecha de entrega (opcional)</span><input className="field__input" type="date" min={hoy()} value={fecha} onChange={(e) => setFecha(e.target.value)} /><span className="field__ayuda">Sin fecha: {estimada ? estimada.split('-').reverse().join('/') : 'según la hora de corte'}</span></label>}
        {!elegirCliente && misDirecciones.length > 0
          ? <label className="field"><span className="field__label">Dirección de entrega</span>
              <select className="field__input" value={direccion} onChange={(e) => setDireccion(e.target.value)}>{misDirecciones.map((d) => <option key={d} value={d}>{d}</option>)}</select>
              <span className="field__ayuda">Agrega o quita direcciones en Mi perfil.</span></label>
          : <label className="field"><span className="field__label">Dirección de entrega</span><input className="field__input" maxLength={200} value={direccion} onChange={(e) => setDireccion(e.target.value)} placeholder={elegirCliente ? 'La registrada del cliente' : 'Tu tienda: calle, número, distrito'} /></label>}
        <label className="field"><span className="field__label">Comprobante</span>
          <select className="field__input" value={comprobante} onChange={(e) => setComprobante(e.target.value)}>
            {comprobantesVenta.map((t) => <option key={t.codigo} value={t.codigo}>{t.nombre}{t.requiereRuc ? ' (requiere RUC)' : ''}</option>)}</select></label>
        <label className="field field--ancho"><span className="field__label">Observaciones / personalización</span><input className="field__input" maxLength={500} value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Ej.: torta con mensaje «Feliz cumpleaños Ana»" /></label>
        {error && <p className="form__error field--ancho" role="alert">{error}</p>}
      </div>
    </Dialogo>
  );
}
