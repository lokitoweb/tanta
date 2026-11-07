import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { useApp } from '@/core/app-state';
import { money, num } from '@/core/format';
import { Dialogo } from '@/ui/Dialogo';
import { InputNumero } from '@/ui/InputNumero';
import { Boton, Encabezado, Insignia, PilaEsqueleto, Tarjeta, TarjetaTitulo, Vacio } from '@/ui/primitives';

const aNumero = (x: string): number | '' => (x === '' ? '' : Number(x));

interface Item { productoId: string; producto: string; cantidad: number; presentacion: string | null; cantidadPresentacion: number | null }
interface Pedido { id: string; codigo: string; cliente: string; estado: 'LISTO' | 'DESPACHADO'; total: number; direccion: string; fecha: string; observaciones: string; vehiculo: string | null; items: Item[]; empaques: Array<{ insumo: string; cantidad: number }> }
interface Vehiculo { id: string; placa: string; descripcion: string; conductor: string; activo: boolean }
interface Empaque { id: string; nombre: string; unidad: string; stock: number }
interface Datos { pedidos: Pedido[]; vehiculos: Vehiculo[]; empaques: Empaque[] }

const NUEVO = { placa: '', descripcion: '', conductor: '', activo: true };

/** Despacho: el encargado empaca, registra los materiales usados y carga el pedido a la móvil (pasa a «En tránsito»). */
export function Despacho() {
  const { puede, refrescarDatos } = useApp();
  const [datos, setDatos] = useState<Datos | null>(null);
  const [cargaError, setCargaError] = useState<string | null>(null);
  const [cargarA, setCargarA] = useState<{ p: Pedido; vehiculoId: string; empaques: Record<string, string> } | null>(null);
  const [vehiculo, setVehiculo] = useState<(typeof NUEVO & { id?: string }) | null>(null);
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger'; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const gestiona = puede('despacho.gestionar');

  const cargar = () => api<Datos>('/despacho').then((d) => { setDatos(d); setCargaError(null); }).catch((e) => setCargaError(e.message));
  useEffect(() => { void cargar(); }, []);
  const accion = async (fn: () => Promise<string>) => {
    setOcupado(true); setAviso(null);
    try { const t = await fn(); setCargarA(null); setVehiculo(null); await Promise.all([cargar(), refrescarDatos()]); setAviso({ tono: 'ok', texto: t }); }
    catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo completar.' }); }
    finally { setOcupado(false); }
  };

  const activos = datos?.vehiculos.filter((v) => v.activo) ?? [];
  const porDespachar = datos?.pedidos.filter((p) => p.estado === 'LISTO') ?? [];
  const enTransito = datos?.pedidos.filter((p) => p.estado === 'DESPACHADO') ?? [];

  const subir = () => accion(async () => {
    const { p, vehiculoId, empaques } = cargarA!;
    await api('/ventas', { method: 'POST', conIdempotencia: true, body: {
      pedidoId: p.id, vehiculoId,
      empaques: Object.entries(empaques).filter(([, c]) => Number(c) > 0).map(([insumoId, c]) => ({ insumoId, cantidad: Number(c) })),
      items: p.items.map((i) => (i.presentacion ? { productoId: i.productoId, cantidad: Number(i.cantidadPresentacion ?? i.cantidad), presentacion: i.presentacion } : { productoId: i.productoId, cantidad: Number(i.cantidad) })),
    } });
    return `${p.codigo} en tránsito en la móvil ${activos.find((v) => v.id === vehiculoId)?.placa ?? ''}.`;
  });
  const guardarVehiculo = () => accion(async () => {
    const { id, ...d } = vehiculo!;
    await api(id ? `/vehiculos/${id}` : '/vehiculos', { method: id ? 'PATCH' : 'POST', body: d });
    return `Vehículo ${d.placa.toUpperCase()} guardado.`;
  });

  return (
    <>
      <Encabezado titulo="Despacho" descripcion="Pedidos listos por empacar y cargar · la móvil que lleva cada pedido queda registrada" />
      {aviso && <div className={`aviso aviso--${aviso.tono}`} role="status"><span className="aviso__icono">{aviso.tono === 'ok' ? '✓' : '!'}</span><div><p>{aviso.texto}</p></div></div>}

      <Dialogo abierto={cargarA !== null} titulo={`Cargar ${cargarA?.p.codigo ?? ''} a la móvil`} descripcion={cargarA ? `${cargarA.p.cliente} · ${cargarA.p.direccion || 'sin dirección registrada'}` : ''} onCerrar={() => setCargarA(null)}
        acciones={<><Boton onClick={() => setCargarA(null)}>Cancelar</Boton><Boton variant="primary" disabled={ocupado || !cargarA?.vehiculoId} onClick={() => void subir()}>{ocupado ? 'Cargando…' : 'Cargar: pasa a En tránsito'}</Boton></>}>
        {cargarA && <div className="form form--2col form--dialogo">
          <label className="field field--ancho"><span className="field__label">Vehículo</span>
            <select className="field__input" value={cargarA.vehiculoId} onChange={(e) => setCargarA({ ...cargarA, vehiculoId: e.target.value })}>
              <option value="">Elige la móvil</option>
              {activos.map((v) => <option key={v.id} value={v.id}>{v.placa}{v.descripcion ? ` · ${v.descripcion}` : ''}{v.conductor ? ` · ${v.conductor}` : ''}</option>)}
            </select></label>
          {(datos?.empaques ?? []).map((e) => (
            <label key={e.id} className="field"><span className="field__label">{e.nombre} (hay {num(e.stock)} {e.unidad.toLowerCase()})</span>
              <InputNumero className="field__input" valor={aNumero(cargarA.empaques[e.id] ?? '')} onValor={(n) => { const v = String(n); setCargarA({ ...cargarA, empaques: { ...cargarA.empaques, [e.id]: v } }); }} /></label>
          ))}
          {!datos?.empaques.length && <p className="dialogo__nota field--ancho">Sin materiales de empaque: regístralos como insumos de un tipo marcado «empaque» en Catálogos.</p>}
        </div>}
      </Dialogo>

      <Dialogo abierto={vehiculo !== null} titulo={vehiculo?.id ? 'Editar vehículo' : 'Nuevo vehículo'} onCerrar={() => setVehiculo(null)}
        acciones={<><Boton onClick={() => setVehiculo(null)}>Cancelar</Boton><Boton variant="primary" disabled={ocupado || (vehiculo?.placa.trim().length ?? 0) < 3} onClick={() => void guardarVehiculo()}>Guardar</Boton></>}>
        {vehiculo && <div className="form form--2col form--dialogo">
          <label className="field"><span className="field__label">Placa</span><input className="field__input" maxLength={12} value={vehiculo.placa} onChange={(e) => setVehiculo({ ...vehiculo, placa: e.target.value })} /></label>
          <label className="field"><span className="field__label">Descripción</span><input className="field__input" maxLength={80} placeholder="Furgón blanco" value={vehiculo.descripcion} onChange={(e) => setVehiculo({ ...vehiculo, descripcion: e.target.value })} /></label>
          <label className="field"><span className="field__label">Conductor</span><input className="field__input" maxLength={80} value={vehiculo.conductor} onChange={(e) => setVehiculo({ ...vehiculo, conductor: e.target.value })} /></label>
          <label className="field"><span className="field__label">Estado</span>
            <select className="field__input" value={vehiculo.activo ? 'si' : 'no'} onChange={(e) => setVehiculo({ ...vehiculo, activo: e.target.value === 'si' })}><option value="si">Activo</option><option value="no">Inactivo</option></select></label>
        </div>}
      </Dialogo>

      {cargaError ? <Tarjeta><Vacio titulo="No se pudo cargar" detalle={cargaError} onReintentar={() => void cargar()} /></Tarjeta>
        : datos === null ? <Tarjeta><PilaEsqueleto lineas={4} /></Tarjeta> : <>
        <Tarjeta padding="none">
          <div className="card__head card__head--padded"><TarjetaTitulo titulo="Por despachar" subtitulo={`${porDespachar.length} pedido(s) listos`} /></div>
          {porDespachar.length === 0 ? <Vacio titulo="No hay pedidos listos" icono="truck" /> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Pedido</th><th>Cliente</th><th>Productos</th><th className="t-right">Total</th><th /></tr></thead>
              <tbody>{porDespachar.map((p) => <tr key={p.id}><td><strong>{p.codigo}</strong></td><td>{p.cliente}<div className="t-muted">{p.direccion}</div></td>
                <td className="t-muted">{p.items.map((i) => `${i.producto} × ${num(Number(i.cantidad))}`).join(' · ')}</td><td className="t-right">{money(p.total)}</td>
                <td className="t-right">{gestiona && <Boton variant="primary" disabled={!activos.length} onClick={() => { setAviso(null); setCargarA({ p, vehiculoId: activos.length === 1 ? activos[0].id : '', empaques: {} }); }}>Cargar a móvil</Boton>}</td></tr>)}</tbody>
            </table></div>
          )}
        </Tarjeta>
        <Tarjeta padding="none">
          <div className="card__head card__head--padded"><TarjetaTitulo titulo="En tránsito" subtitulo="El vendedor marca la llegada: recién ahí pasa a cobranza" /></div>
          {enTransito.length === 0 ? <Vacio titulo="Nada en tránsito" icono="truck" /> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Pedido</th><th>Cliente</th><th>Móvil</th><th>Empaques</th></tr></thead>
              <tbody>{enTransito.map((p) => <tr key={p.id}><td><strong>{p.codigo}</strong></td><td>{p.cliente}</td><td><Insignia tono="info" punto>{p.vehiculo ?? 'Sin móvil'}</Insignia></td>
                <td className="t-muted">{p.empaques.map((e) => `${e.insumo} × ${num(Number(e.cantidad))}`).join(' · ') || '—'}</td></tr>)}</tbody>
            </table></div>
          )}
        </Tarjeta>
        <Tarjeta padding="none">
          <div className="card__head card__head--padded">
            <TarjetaTitulo titulo="Vehículos" subtitulo="Las móviles de reparto" />
            {gestiona && <Boton icono="plus" onClick={() => setVehiculo({ ...NUEVO })}>Nuevo vehículo</Boton>}
          </div>
          {datos.vehiculos.length === 0 ? <Vacio titulo="Registra tu primer vehículo" icono="truck" /> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Placa</th><th>Descripción</th><th>Conductor</th><th>Estado</th><th /></tr></thead>
              <tbody>{datos.vehiculos.map((v) => <tr key={v.id}><td><strong>{v.placa}</strong></td><td>{v.descripcion}</td><td>{v.conductor}</td><td><Insignia tono={v.activo ? 'ok' : 'neutral'} punto>{v.activo ? 'Activo' : 'Inactivo'}</Insignia></td>
                <td className="t-right">{gestiona && <Boton onClick={() => setVehiculo({ ...v })}>Editar</Boton>}</td></tr>)}</tbody>
            </table></div>
          )}
        </Tarjeta>
      </>}
    </>
  );
}
