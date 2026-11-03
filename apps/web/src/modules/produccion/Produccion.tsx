import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { useApp } from '@/core/app-state';
import { num, num2, pct } from '@/core/format';
import { Boton, Buscador, Encabezado, Insignia, Tarjeta, TarjetaTitulo, Vacio } from '@/ui/primitives';
import { Paginador, filtrarTexto, usePaginado } from '@/ui/Paginador';
import { Dialogo } from '@/ui/Dialogo';
import { Icon } from '@/ui/icons';
import { desdeIso } from '@/core/fecha';
import type { Op } from '@/core/types';

const COLUMNAS = [
  { id: 'PENDIENTE', titulo: 'Pendientes', tono: 'neutral' as const },
  { id: 'EN_PROCESO', titulo: 'En proceso', tono: 'warn' as const },
  { id: 'TERMINADA', titulo: 'Terminadas', tono: 'ok' as const },
];
interface Consolidado { fecha: string; productoId: string; producto: string; pedido: number; pedidos: number; planificado: number; stock: number; porPlanificar: number }
interface Req { insumo: string; unidad: string; necesario: number; stock: number; falta: number }
const manana = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const hoy = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);

/** Tablero de producción (PDF §3.2): pedidos consolidados → OP → Pendiente → En proceso → Terminada. */
export function Produccion() {
  const { dataset, puede, refrescarDatos } = useApp();
  const ops = dataset.ops;
  const [consolidado, setConsolidado] = useState<Consolidado[]>([]);
  const [nueva, setNueva] = useState<{ productoId: string; cantidad: string; entrega: string } | null>(null);
  const [req, setReq] = useState<{ insumos: Req[]; suficiente: boolean } | null>(null);
  const [cerrar, setCerrar] = useState<{ op: Op; cantidad: string; merma: string; motivo: string } | null>(null);
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger' | 'warn'; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [tabOp, setTabOp] = useState<Op['estado']>('EN_PROCESO');
  const [qOp, setQOp] = useState('');
  const pagOps = usePaginado(filtrarTexto(ops.filter((o) => o.estado === tabOp), qOp), 10);

  const cargarConsolidado = () => api<Consolidado[]>('/produccion/consolidado').then(setConsolidado).catch(() => setConsolidado([]));
  useEffect(() => { void cargarConsolidado(); }, [dataset.ops]);

  // Requerimiento de insumos en vivo al elegir producto y cantidad.
  useEffect(() => {
    if (!nueva?.productoId || !(Number(nueva.cantidad) > 0)) { setReq(null); return; }
    const t = setTimeout(() => {
      api<{ insumos: Req[]; suficiente: boolean }>(`/produccion/requerimiento?productoId=${nueva.productoId}&cantidad=${Number(nueva.cantidad)}`).then(setReq).catch(() => setReq(null));
    }, 250);
    return () => clearTimeout(t);
  }, [nueva?.productoId, nueva?.cantidad]);

  const accion = async (fn: () => Promise<string>) => {
    setOcupado(true);
    setAviso(null);
    try { const t = await fn(); await refrescarDatos(); setAviso({ tono: 'ok', texto: t }); }
    catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo completar.' }); }
    finally { setOcupado(false); }
  };

  const crear = () => accion(async () => {
    const r = await api<{ codigo: string; insumosInsuficientes: Req[] }>('/ordenes-produccion', {
      method: 'POST', body: { productoId: nueva!.productoId, cantidad: Number(nueva!.cantidad), entrega: nueva!.entrega }, conIdempotencia: true,
    });
    setNueva(null);
    return r.insumosInsuficientes.length ? `${r.codigo} creada · atención: faltan ${r.insumosInsuficientes.map((x) => x.insumo).join(', ')}` : `${r.codigo} creada con insumos suficientes`;
  });
  const iniciar = (op: Op) => accion(async () => { await api(`/ordenes-produccion/${op.codigo}/iniciar`, { method: 'POST', body: {}, conIdempotencia: true }); return `${op.codigo} en proceso`; });
  const cerrarOp = () => accion(async () => {
    const c = cerrar!;
    await api(`/ordenes-produccion/${c.op.codigo}/cerrar`, {
      method: 'POST', conIdempotencia: true,
      body: { cantidadProducida: Number(c.cantidad), mermaReal: Number(c.merma) / 100, motivoMerma: c.motivo },
    });
    setCerrar(null);
    return `${c.op.codigo} terminada: ${num(Number(c.cantidad))} unidades ingresaron al stock`;
  });

  const conteo = (estado: string) => ops.filter((o) => o.estado === estado).length;
  const productosConReceta = dataset.productos.filter((p) => p.estado === 'ACTIVO');
  const puedePlanificar = puede('produccion.planificar');
  const puedeEjecutar = puede('produccion.ejecutar');

  return (
    <>
      <Encabezado titulo="Tablero de producción" descripcion="Pedidos consolidados por fecha de entrega → órdenes de producción con requerimiento de insumos"
        acciones={puedePlanificar && <Boton variant="primary" icono="plus" size="lg" onClick={() => setNueva({ productoId: productosConReceta[0]?.id ?? '', cantidad: '', entrega: manana() })}>Nueva orden</Boton>} />

      {aviso && <div className={`aviso aviso--${aviso.tono}`} role="status"><span className="aviso__icono">{aviso.tono === 'ok' ? '✓' : '!'}</span><div><p>{aviso.texto}</p></div></div>}

      <div className="grid grid--auto">
        <Tarjeta className="mini-stat"><span>Pendientes</span><b>{conteo('PENDIENTE')}</b></Tarjeta>
        <Tarjeta className="mini-stat"><span>En proceso</span><b>{conteo('EN_PROCESO')}</b></Tarjeta>
        <Tarjeta className="mini-stat"><span>Terminadas</span><b>{conteo('TERMINADA')}</b></Tarjeta>
        <Tarjeta className="mini-stat"><span>Unidades por planificar</span><b>{num(consolidado.reduce((s, c) => s + c.porPlanificar, 0))}</b></Tarjeta>
      </div>

      <Tarjeta padding="none">
        <div className="card__head card__head--padded"><TarjetaTitulo titulo="Pedidos consolidados" subtitulo="Lo que piden los clientes, por fecha de entrega, frente a lo ya planificado" /></div>
        {consolidado.length === 0 ? <Vacio titulo="Sin pedidos pendientes" detalle="Los pedidos registrados aparecen aquí agrupados por producto." icono="clipboard" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Entrega</th><th>Producto</th><th className="t-right">Pedidos</th><th className="t-right">Pedido</th><th className="t-right">Planificado</th><th className="t-right">Stock</th><th className="t-right">Por planificar</th><th /></tr></thead>
            <tbody>{consolidado.map((c) => (
              <tr key={c.fecha + c.productoId}>
                <td>{desdeIso(c.fecha)}{c.fecha < hoy() && <Insignia tono="danger">Vencido</Insignia>}</td>
                <td><strong>{c.producto}</strong></td>
                <td className="t-right">{c.pedidos}</td><td className="t-right">{num2(c.pedido)}</td><td className="t-right">{num2(c.planificado)}</td>
                <td className="t-right t-muted">{num2(c.stock)}</td>
                <td className="t-right">{c.porPlanificar > 0 ? <strong>{num2(c.porPlanificar)}</strong> : <Insignia tono="ok">Cubierto</Insignia>}</td>
                <td className="t-right">{puedePlanificar && c.porPlanificar > 0 && <Boton size="sm" onClick={() => setNueva({ productoId: c.productoId, cantidad: String(c.porPlanificar), entrega: c.fecha < hoy() ? hoy() : c.fecha })}>Planificar</Boton>}</td>
              </tr>))}</tbody>
          </table></div>
        )}
      </Tarjeta>

      <Tarjeta padding="none">
        <div className="ops__cab">
          <div className="ops__tabs" role="tablist">
            {COLUMNAS.map((col) => {
              const n = ops.filter((o) => o.estado === col.id).length;
              return (
                <button key={col.id} role="tab" aria-selected={tabOp === col.id} className={`ops__tab ops__tab--${col.id.toLowerCase()} ${tabOp === col.id ? 'is-activo' : ''}`} onClick={() => setTabOp(col.id)}>
                  {col.titulo}<b>{n}</b>
                </button>
              );
            })}
          </div>
          <Buscador valor={qOp} onChange={setQOp} placeholder="Buscar producto, código o responsable…" />
        </div>

        {pagOps.total === 0 ? <Vacio titulo={qOp ? 'Sin resultados' : 'Sin órdenes'} detalle={qOp ? `Nada coincide con «${qOp}».` : 'No hay órdenes en este estado.'} icono="oven" /> : (
          <ul className="ops__lista">
            {pagOps.visibles.map((op) => {
              const vencida = op.estado !== 'TERMINADA' && op.entrega < hoy();
              const iniciales = op.responsable.split(' ').map((p) => p[0]).slice(0, 2).join('');
              return (
                <li key={op.codigo} className={`op op--${op.estado.toLowerCase()}`}>
                  <span className="op__estado" aria-hidden><Icon name={op.estado === 'TERMINADA' ? 'check' : op.estado === 'EN_PROCESO' ? 'oven' : 'clock'} size={16} /></span>
                  <div className="op__principal">
                    <b>{op.producto}</b>
                    <span className="mono">{op.codigo}</span>
                  </div>
                  <div className="op__cantidad"><b>{num(op.cantidad)}</b><span>unidades</span></div>
                  <div className="op__avance">
                    <div className="op__barra"><i style={{ width: `${Math.round(op.avance * 100)}%` }} /></div>
                    <span>{pct(op.avance, 0)}</span>
                  </div>
                  <span className={`op__entrega ${vencida ? 'is-vencida' : ''}`}><Icon name="clock" size={13} />{desdeIso(op.entrega)}{vencida && ' · vencida'}</span>
                  <span className="op__resp" title={op.responsable}><i>{iniciales}</i>{op.responsable}</span>
                  <div className="op__accion">
                    {op.estado === 'PENDIENTE' && puedeEjecutar && <Boton size="sm" variant="primary" disabled={ocupado} onClick={() => void iniciar(op)}>Iniciar</Boton>}
                    {op.estado === 'EN_PROCESO' && puedeEjecutar && <Boton size="sm" variant="primary" disabled={ocupado}
                      onClick={() => setCerrar({ op, cantidad: String(op.cantidad), merma: String(Math.round(op.mermaEsperada * 1000) / 10), motivo: '' })}>Cerrar</Boton>}
                    {op.estado === 'TERMINADA' && <Insignia tono="ok" punto>En stock</Insignia>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <Paginador {...pagOps} />
      </Tarjeta>

      <Dialogo abierto={nueva !== null} titulo="Nueva orden de producción" descripcion="El requerimiento de insumos se calcula con la receta vigente y la merma estándar."
        onCerrar={() => setNueva(null)}
        acciones={<><Boton onClick={() => setNueva(null)}>Cancelar</Boton>
          <Boton variant="primary" onClick={() => void crear()} disabled={ocupado || !nueva?.productoId || !(Number(nueva?.cantidad) > 0)}>{req && !req.suficiente ? 'Crear igual (faltan insumos)' : 'Crear orden'}</Boton></>}>
        {nueva && (
          <div className="form form--2col form--dialogo">
            <label className="field field--ancho"><span className="field__label">Producto</span>
              <select className="field__input" value={nueva.productoId} onChange={(e) => setNueva({ ...nueva, productoId: e.target.value })}>
                {productosConReceta.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
              </select></label>
            <label className="field"><span className="field__label">Cantidad (unidades)</span>
              <input className="field__input" type="number" min="1" step="1" value={nueva.cantidad} onChange={(e) => setNueva({ ...nueva, cantidad: e.target.value })} /></label>
            <label className="field"><span className="field__label">Fecha de entrega</span>
              <input className="field__input" type="date" min={hoy()} value={nueva.entrega} onChange={(e) => setNueva({ ...nueva, entrega: e.target.value })} /></label>
            {req && (
              <div className="field--ancho">
                <p className="field__label">Requerimiento de insumos</p>
                <table className="table table--compacta"><tbody>{req.insumos.map((x) => (
                  <tr key={x.insumo}><td>{x.insumo}</td><td className="t-right">{num2(x.necesario)} {x.unidad}</td>
                    <td className="t-right">{x.falta > 0 ? <Insignia tono="danger">Falta {num2(x.falta)}</Insignia> : <Insignia tono="ok">Hay {num2(x.stock)}</Insignia>}</td></tr>))}</tbody></table>
              </div>
            )}
          </div>
        )}
      </Dialogo>

      <Dialogo abierto={cerrar !== null} titulo={`Cerrar ${cerrar?.op.codigo ?? ''}`} descripcion="Registra lo realmente producido: descuenta insumos, registra la merma e ingresa el producto al stock."
        onCerrar={() => setCerrar(null)}
        acciones={<><Boton onClick={() => setCerrar(null)}>Cancelar</Boton>
          <Boton variant="primary" onClick={() => void cerrarOp()} disabled={ocupado || !(Number(cerrar?.cantidad) > 0) || (Number(cerrar?.merma) > 0 && (cerrar?.motivo.trim().length ?? 0) < 3)}>Cerrar orden</Boton></>}>
        {cerrar && (
          <div className="form form--2col form--dialogo">
            <label className="field"><span className="field__label">Cantidad producida real</span>
              <input className="field__input" type="number" min="0.01" step="any" value={cerrar.cantidad} onChange={(e) => setCerrar({ ...cerrar, cantidad: e.target.value })} /></label>
            <label className="field"><span className="field__label">Merma real (%)</span>
              <input className="field__input" type="number" min="0" max="90" step="0.1" value={cerrar.merma} onChange={(e) => setCerrar({ ...cerrar, merma: e.target.value })} />
              <span className="field__ayuda">Estándar de la receta: {pct(cerrar.op.mermaEsperada)}</span></label>
            <label className="field field--ancho"><span className="field__label">Motivo de la merma {Number(cerrar.merma) > 0 ? '*' : ''}</span>
              <input className="field__input" maxLength={200} placeholder="Horno disparejo, masa pasada, quemado…" value={cerrar.motivo} onChange={(e) => setCerrar({ ...cerrar, motivo: e.target.value })} /></label>
          </div>
        )}
      </Dialogo>
    </>
  );
}
