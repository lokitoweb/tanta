import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { useApp } from '@/core/app-state';
import { money } from '@/core/format';
import { Boton } from '@/ui/primitives';
import { Dialogo } from '@/ui/Dialogo';

export interface ItemPedido { productoId: string; cantidad: number; presentacion?: string }
const manana = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const hoy = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);

/**
 * Registrar un pedido (PDF §3.2): cliente, productos, fecha y hora de entrega, observaciones.
 * El cliente de la app no elige cliente: el API lo asigna a su propia cuenta.
 */
export function NuevoPedido({ inicial = [], elegirCliente, onCerrar }: {
  inicial?: ItemPedido[]; elegirCliente: boolean; onCerrar: (codigo?: string) => void;
}) {
  const { dataset } = useApp();
  const productos = dataset.productos.filter((p) => p.estado === 'ACTIVO' && !p.insumoId); // los intermedios no se venden
  const [clientes, setClientes] = useState<Array<{ id: string; nombre: string }>>([]);
  const [clienteId, setClienteId] = useState('');
  const [items, setItems] = useState<Array<{ productoId: string; cantidad: string; presentacion: string }>>(
    inicial.length ? inicial.map((i) => ({ productoId: i.productoId, cantidad: String(i.cantidad), presentacion: i.presentacion ?? '' })) : [{ productoId: productos[0]?.id ?? '', cantidad: '1', presentacion: '' }]);
  const [fecha, setFecha] = useState(manana());
  const [hora, setHora] = useState('08:00');
  const [obs, setObs] = useState('');
  const [tipoEntrega, setTipoEntrega] = useState<'RECOJO' | 'DELIVERY'>('RECOJO');
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
  const total = items.reduce((s, i) => s + precio(i.productoId, i.presentacion) * (Number(i.cantidad) || 0), 0);
  const valido = items.length > 0 && items.every((i) => i.productoId && Number(i.cantidad) > 0) && fecha >= hoy() && (!elegirCliente || clienteId);

  const guardar = async () => {
    setError(null);
    setGuardando(true);
    try {
      const r = await api<{ codigo: string }>('/pedidos', {
        method: 'POST', conIdempotencia: true,
        body: { ...(elegirCliente ? { clienteId } : {}), items: items.map((i) => ({ productoId: i.productoId, cantidad: Number(i.cantidad), ...(i.presentacion ? { presentacion: i.presentacion } : {}) })), fechaEntrega: fecha, horaEntrega: hora, observaciones: obs, tipoEntrega, direccion },
      });
      onCerrar(r.codigo);
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo registrar.'); }
    finally { setGuardando(false); }
  };

  return (
    <Dialogo abierto titulo="Registrar pedido" descripcion="Producción lo verá consolidado por fecha de entrega." onCerrar={() => onCerrar()}
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
                <select className="field__input" value={it.productoId} aria-label="Producto" onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, productoId: e.target.value, presentacion: '' } : x))}>
                  {productos.map((p) => <option key={p.id} value={p.id}>{p.nombre} · {money(p.precioConIgv)}</option>)}
                </select>
                {presDe(it.productoId).length > 0 && (
                  <select className="field__input" value={it.presentacion} aria-label="Presentación" onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, presentacion: e.target.value } : x))}>
                    <option value="">Unidad · {money(precio(it.productoId, ''))}</option>
                    {presDe(it.productoId).map((x) => <option key={x.presentacion} value={x.presentacion}>{x.nombre} · {money(x.precioConIgv)}</option>)}
                  </select>
                )}
              </div>
              <div className="editor-receta__cant"><input className="field__input" type="number" min="1" step="1" aria-label="Cantidad" value={it.cantidad} onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, cantidad: e.target.value } : x))} /></div>
              <button type="button" className="iconbtn" aria-label="Quitar" onClick={() => setItems(items.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          <Boton size="sm" icono="plus" onClick={() => setItems([...items, { productoId: productos[0]?.id ?? '', cantidad: '1', presentacion: '' }])}>Agregar producto</Boton>
        </div>
        <label className="field"><span className="field__label">Fecha de entrega</span><input className="field__input" type="date" min={hoy()} value={fecha} onChange={(e) => setFecha(e.target.value)} /></label>
        <label className="field"><span className="field__label">Hora</span><input className="field__input" type="time" value={hora} onChange={(e) => setHora(e.target.value)} /></label>
        <label className="field"><span className="field__label">Tipo de entrega</span><select className="field__input" value={tipoEntrega} onChange={(e) => setTipoEntrega(e.target.value as 'RECOJO')}><option value="RECOJO">Recojo en tienda</option><option value="DELIVERY">Delivery</option></select></label>
        {tipoEntrega === 'DELIVERY' ? <label className="field"><span className="field__label">Dirección de entrega</span><input className="field__input" maxLength={200} value={direccion} onChange={(e) => setDireccion(e.target.value)} placeholder="Calle, número, distrito" /></label> : <span />}
        <label className="field field--ancho"><span className="field__label">Observaciones / personalización</span><input className="field__input" maxLength={500} value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Ej.: torta con mensaje «Feliz cumpleaños Ana»" /></label>
        {error && <p className="form__error field--ancho" role="alert">{error}</p>}
      </div>
    </Dialogo>
  );
}
