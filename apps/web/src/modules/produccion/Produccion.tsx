import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { useApp } from '@/core/app-state';
import { num, num2, pct } from '@/core/format';
import { Boton, Buscador, Encabezado, Insignia, Tarjeta, TarjetaTitulo, TablaEsqueleto, Vacio } from '@/ui/primitives';
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
interface Req { insumo: string; unidad: string; necesario: number; stock: number; falta: number; costo?: number; saldo?: number; estado?: string }
interface Calculo { insumos: Req[]; suficiente: boolean; unidadesPorLote: number; lotesEquivalentes: number; lotes: number; unidadesObtenidas: number; masaKg: number; costoInsumos: number }
interface Presupuesto { panesAPreparar: number; lotes: number; masaKg: number; harinaKg: number; costoInsumos: number; costoEstimado: number; ventaNeta: number; margenEstimado: number; insumos: Array<{ insumo: string; unidad: string; consumo: number; costo: number; falta: boolean; pctPanadero: number | null }> }
const MOTIVOS = [['CORTE', 'Corte'], ['ROTURA', 'Rotura'], ['QUEMADO', 'Quemado'], ['DEFORME', 'Deforme'], ['OTRO', 'Otro']];
const manana = () => new Date(Date.now() - 5 * 3_600_000 + 86_400_000).toISOString().slice(0, 10); // hora de Lima, como hoy()
const hoy = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);

/** Tablero de producción (PDF §3.2): pedidos consolidados → OP → Pendiente → En proceso → Terminada. */
export function Produccion() {
  const { dataset, puede, refrescarDatos } = useApp();
  const ops = dataset.ops;
  // null = cargando (esqueleto); [] = cargó y no hay pedidos pendientes.
  const [consolidadoCargado, setConsolidado] = useState<Consolidado[] | null>(null);
  const [consolidadoError, setConsolidadoError] = useState<string | null>(null);
  const consolidado = consolidadoCargado ?? [];
  const [nueva, setNueva] = useState<{ productoId: string; cantidad: string; entrega: string; criterio: 'PROPORCIONAL' | 'LOTES_COMPLETOS' } | null>(null);
  const [req, setReq] = useState<Calculo | null>(null);
  const [cerrar, setCerrar] = useState<{ op: Op; buenas: string; merma: string; motivoTipo: string; motivo: string; horasHombre: string; horasHorno: string } | null>(null);
  const [anular, setAnular] = useState<{ op: Op; motivo: string } | null>(null);
  const [presu, setPresu] = useState<{ productoId: string; cantidad: string; merma: string; res: Presupuesto | null } | null>(null);
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger' | 'warn'; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [tabOp, setTabOp] = useState<Op['estado']>('EN_PROCESO');
  const [qOp, setQOp] = useState('');
  const pagOps = usePaginado(filtrarTexto(ops.filter((o) => o.estado === tabOp), qOp), 10);

  const cargarConsolidado = () => api<Consolidado[]>('/produccion/consolidado').then((c) => { setConsolidado(c); setConsolidadoError(null); }).catch((e) => setConsolidadoError(e.message));
  useEffect(() => { void cargarConsolidado(); }, [dataset.ops]);

  // Requerimiento de insumos en vivo al elegir producto y cantidad.
  useEffect(() => {
    if (!nueva?.productoId || !(Number(nueva.cantidad) > 0)) { setReq(null); return; }
    const t = setTimeout(() => {
      api<Calculo>(`/produccion/requerimiento?productoId=${nueva.productoId}&cantidad=${Number(nueva.cantidad)}&criterio=${nueva.criterio}`).then(setReq).catch(() => setReq(null));
    }, 250);
    return () => clearTimeout(t);
  }, [nueva?.productoId, nueva?.cantidad, nueva?.criterio]);

  // Presupuesto de un pedido (W20) recalculado al escribir.
  useEffect(() => {
    if (!presu?.productoId || !(Number(presu.cantidad) > 0)) return;
    const t = setTimeout(() => {
      const merma = presu.merma === '' ? '' : `&merma=${Number(presu.merma) / 100}`;
      api<Presupuesto>(`/produccion/presupuesto?productoId=${presu.productoId}&cantidad=${Math.round(Number(presu.cantidad))}${merma}`)
        .then((res) => setPresu((p) => p && { ...p, res })).catch(() => setPresu((p) => p && { ...p, res: null }));
    }, 250);
    return () => clearTimeout(t);
  }, [presu?.productoId, presu?.cantidad, presu?.merma]);

  const accion = async (fn: () => Promise<string>) => {
    setOcupado(true);
    setAviso(null);
    try { const t = await fn(); await refrescarDatos(); setAviso({ tono: 'ok', texto: t }); }
    catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo completar.' }); }
    finally { setOcupado(false); }
  };

  const crear = () => accion(async () => {
    const r = await api<{ codigo: string; insumosInsuficientes: Req[] }>('/ordenes-produccion', {
      method: 'POST', body: { productoId: nueva!.productoId, cantidad: Number(nueva!.cantidad), entrega: nueva!.entrega, criterio: nueva!.criterio }, conIdempotencia: true,
    });
    setNueva(null);
    return r.insumosInsuficientes.length ? `${r.codigo} creada y requisición enviada a Almacén · faltan ${r.insumosInsuficientes.map((x) => x.insumo).join(', ')}` : `${r.codigo} creada y requisición enviada a Almacén`;
  });
  const iniciar = (op: Op) => accion(async () => { await api(`/ordenes-produccion/${op.codigo}/iniciar`, { method: 'POST', body: {}, conIdempotencia: true }); return `${op.codigo} en proceso`; });
  const cerrarOp = () => accion(async () => {
    const c = cerrar!;
    const r = await api<{ costoUnitario?: number }>(`/ordenes-produccion/${c.op.codigo}/cerrar`, {
      method: 'POST', conIdempotencia: true,
      body: {
        unidadesBuenas: Number(c.buenas), unidadesMerma: Number(c.merma || 0), motivoMermaTipo: Number(c.merma) > 0 ? c.motivoTipo : undefined, motivoMerma: c.motivo,
        horasHombreReal: c.horasHombre === '' ? undefined : Number(c.horasHombre), horasHornoReal: c.horasHorno === '' ? undefined : Number(c.horasHorno),
      },
    });
    setCerrar(null);
    return `${c.op.codigo} terminada: ${num(Number(c.buenas))} unidades al stock${r.costoUnitario !== undefined ? ` a S/ ${r.costoUnitario.toFixed(4)} c/u (costo real)` : ''}`;
  });
  const anularOp = () => accion(async () => {
    await api(`/ordenes-produccion/${anular!.op.codigo}/anular`, { method: 'POST', body: { motivo: anular!.motivo } });
    const cod = anular!.op.codigo;
    setAnular(null);
    return `${cod} anulada`;
  });

  const conteo = (estado: string) => ops.filter((o) => o.estado === estado).length;
  const productosConReceta = dataset.productos.filter((p) => p.estado === 'ACTIVO');
  const puedePlanificar = puede('produccion.planificar');
  const puedeEjecutar = puede('produccion.ejecutar');
  // Sin costos.ver el API no envía soles: las columnas de costo no se muestran.
  const verCosto = puede('costos.ver');

  return (
    <>
      <Encabezado titulo="Tablero de producción" descripcion="Pedidos consolidados por fecha de entrega → órdenes de producción con requerimiento de insumos"
        acciones={<>
          <Boton icono="report" onClick={() => setPresu({ productoId: productosConReceta[0]?.id ?? '', cantidad: '', merma: '', res: null })}>Presupuesto</Boton>
          {puedePlanificar && <Boton variant="primary" icono="plus" size="lg" onClick={() => setNueva({ productoId: productosConReceta[0]?.id ?? '', cantidad: '', entrega: manana(), criterio: 'LOTES_COMPLETOS' })}>Nueva orden</Boton>}
        </>} />

      {aviso && <div className={`aviso aviso--${aviso.tono}`} role="status"><span className="aviso__icono">{aviso.tono === 'ok' ? '✓' : '!'}</span><div><p>{aviso.texto}</p></div></div>}

      <div className="grid grid--auto">
        <Tarjeta className="mini-stat"><span>Pendientes</span><b>{conteo('PENDIENTE')}</b></Tarjeta>
        <Tarjeta className="mini-stat"><span>En proceso</span><b>{conteo('EN_PROCESO')}</b></Tarjeta>
        <Tarjeta className="mini-stat"><span>Terminadas</span><b>{conteo('TERMINADA')}</b></Tarjeta>
        <Tarjeta className="mini-stat"><span>Unidades por planificar</span><b>{num(consolidado.reduce((s, c) => s + c.porPlanificar, 0))}</b></Tarjeta>
      </div>

      <Tarjeta padding="none">
        <div className="card__head card__head--padded"><TarjetaTitulo titulo="Pedidos consolidados" subtitulo="Lo que piden los clientes, por fecha de entrega, frente a lo ya planificado" /></div>
        {consolidadoError ? <Vacio titulo="No se pudo cargar" detalle={consolidadoError} onReintentar={() => { setConsolidadoError(null); setConsolidado(null); void cargarConsolidado(); }} />
          : consolidadoCargado === null ? <TablaEsqueleto columnas={7} />
          : consolidado.length === 0 ? <Vacio titulo="Sin pedidos pendientes" detalle="Los pedidos registrados aparecen aquí agrupados por producto." icono="clipboard" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Entrega</th><th>Producto</th><th className="t-right">Pedidos</th><th className="t-right">Pedido</th><th className="t-right">Planificado</th><th className="t-right">Stock</th><th className="t-right">Por planificar</th><th /></tr></thead>
            <tbody>{consolidado.map((c) => (
              <tr key={c.fecha + c.productoId}>
                <td>{desdeIso(c.fecha)}{c.fecha < hoy() && <Insignia tono="danger">Vencido</Insignia>}</td>
                <td><strong>{c.producto}</strong></td>
                <td className="t-right">{c.pedidos}</td><td className="t-right">{num2(c.pedido)}</td><td className="t-right">{num2(c.planificado)}</td>
                <td className="t-right t-muted">{num2(c.stock)}</td>
                <td className="t-right">{c.porPlanificar > 0 ? <strong>{num2(c.porPlanificar)}</strong> : <Insignia tono="ok">Cubierto</Insignia>}</td>
                <td className="t-right">{puedePlanificar && c.porPlanificar > 0 && <Boton size="sm" onClick={() => setNueva({ productoId: c.productoId, cantidad: String(c.porPlanificar), entrega: c.fecha < hoy() ? hoy() : c.fecha, criterio: 'LOTES_COMPLETOS' })}>Planificar</Boton>}</td>
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
                      onClick={() => setCerrar({ op, buenas: String(op.cantidad), merma: '0', motivoTipo: 'QUEMADO', motivo: '', horasHombre: '', horasHorno: '' })}>Cerrar</Boton>}
                    {op.estado !== 'TERMINADA' && puedePlanificar && <button type="button" className="op__anular" title="Anular orden" aria-label={`Anular ${op.codigo}`} onClick={() => setAnular({ op, motivo: '' })}>×</button>}
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
            <label className="field field--ancho"><span className="field__label">Criterio de preparación</span>
              <select className="field__input" value={nueva.criterio} onChange={(e) => setNueva({ ...nueva, criterio: e.target.value as 'PROPORCIONAL' })}>
                <option value="LOTES_COMPLETOS">Lotes completos (se redondea hacia arriba)</option>
                <option value="PROPORCIONAL">Proporcional (lotes fraccionados)</option>
              </select></label>
            {req && (
              <div className="field--ancho">
                <div className="calculo-op">
                  <div><span>Unidades por lote</span><b>{num2(req.unidadesPorLote)}</b></div>
                  <div><span>Lotes equivalentes</span><b>{num2(req.lotesEquivalentes)}</b></div>
                  <div><span>Lotes a preparar</span><b>{num2(req.lotes)}</b></div>
                  <div><span>Unidades que se obtendrán</span><b>{num2(req.unidadesObtenidas)}</b></div>
                  <div><span>Masa total</span><b>{num2(req.masaKg)} kg</b></div>
                  {verCosto && <div><span>Costo de insumos</span><b>S/ {req.costoInsumos.toFixed(2)}</b></div>}
                </div>
                <table className="table table--compacta">
                  <thead><tr><th>Insumo</th><th className="t-right">Consumo</th>{verCosto && <th className="t-right">Costo</th>}<th className="t-right">Stock</th><th className="t-right">Saldo</th><th className="t-right">Estado</th></tr></thead>
                  <tbody>{req.insumos.map((x) => (
                  <tr key={x.insumo}><td>{x.insumo}</td><td className="t-right">{num2(x.necesario)} {x.unidad}</td>{verCosto && <td className="t-right">S/ {(x.costo ?? 0).toFixed(2)}</td>}
                    <td className="t-right">{num2(x.stock)}</td><td className={`t-right ${(x.saldo ?? 0) < 0 ? 't-neg' : ''}`}>{num2(x.saldo ?? 0)}</td>
                    <td className="t-right">{x.falta > 0 ? <Insignia tono="danger">FALTA</Insignia> : <Insignia tono="ok">OK</Insignia>}</td></tr>))}</tbody></table>
                <p className="dialogo__nota">Al crear la orden se envía la requisición a Almacén; el stock baja cuando Almacén entrega.</p>
              </div>
            )}
          </div>
        )}
      </Dialogo>

      <Dialogo abierto={cerrar !== null} titulo={`Cerrar ${cerrar?.op.codigo ?? ''}`} descripcion="Unidades buenas al almacén de panes a su costo real; la merma queda registrada con su motivo."
        onCerrar={() => setCerrar(null)}
        acciones={<><Boton onClick={() => setCerrar(null)}>Cancelar</Boton>
          <Boton variant="primary" onClick={() => void cerrarOp()} disabled={ocupado || !(Number(cerrar?.buenas) >= 0) || cerrar?.buenas === ''}>Cerrar orden</Boton></>}>
        {cerrar && (
          <div className="form form--2col form--dialogo">
            <label className="field"><span className="field__label">Unidades buenas</span>
              <input className="field__input" type="number" min="0" step="1" value={cerrar.buenas} onChange={(e) => setCerrar({ ...cerrar, buenas: e.target.value })} /></label>
            <label className="field"><span className="field__label">Unidades de merma</span>
              <input className="field__input" type="number" min="0" step="1" value={cerrar.merma} onChange={(e) => setCerrar({ ...cerrar, merma: e.target.value })} />
              <span className="field__ayuda">Estándar de la receta: {pct(cerrar.op.mermaEsperada)}</span></label>
            {Number(cerrar.merma) > 0 && <>
              <label className="field"><span className="field__label">Motivo de la merma *</span>
                <select className="field__input" value={cerrar.motivoTipo} onChange={(e) => setCerrar({ ...cerrar, motivoTipo: e.target.value })}>
                  {MOTIVOS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                </select></label>
              <label className="field"><span className="field__label">Observación</span>
                <input className="field__input" maxLength={200} placeholder="Opcional" value={cerrar.motivo} onChange={(e) => setCerrar({ ...cerrar, motivo: e.target.value })} /></label>
            </>}
            <label className="field"><span className="field__label">Horas hombre reales</span>
              <input className="field__input" type="number" min="0" step="0.1" placeholder="Vacío = estándar del pan" value={cerrar.horasHombre} onChange={(e) => setCerrar({ ...cerrar, horasHombre: e.target.value })} /></label>
            <label className="field"><span className="field__label">Horas de horno reales</span>
              <input className="field__input" type="number" min="0" step="0.1" placeholder="Vacío = estándar del pan" value={cerrar.horasHorno} onChange={(e) => setCerrar({ ...cerrar, horasHorno: e.target.value })} /></label>
          </div>
        )}
      </Dialogo>

      <Dialogo abierto={anular !== null} titulo={`Anular ${anular?.op.codigo ?? ''}`} descripcion="La requisición pendiente se anula. Si Almacén ya entregó insumos, primero registra su devolución o merma."
        onCerrar={() => setAnular(null)}
        acciones={<><Boton onClick={() => setAnular(null)}>Cancelar</Boton>
          <Boton variant="primary" onClick={() => void anularOp()} disabled={ocupado || (anular?.motivo.trim().length ?? 0) < 5}>Anular orden</Boton></>}>
        {anular && <label className="field"><span className="field__label">Motivo</span>
          <input className="field__input" autoFocus maxLength={200} value={anular.motivo} onChange={(e) => setAnular({ ...anular, motivo: e.target.value })} /></label>}
      </Dialogo>

      <Dialogo abierto={presu !== null} titulo="Presupuesto de un pedido" descripcion="Panes a preparar (redondeo hacia arriba), masa, harina, consumo por insumo y costo, sin crear la orden."
        onCerrar={() => setPresu(null)} acciones={<Boton onClick={() => setPresu(null)}>Cerrar</Boton>}>
        {presu && (
          <div className="form form--2col form--dialogo">
            <label className="field field--ancho"><span className="field__label">Producto</span>
              <select className="field__input" value={presu.productoId} onChange={(e) => setPresu({ ...presu, productoId: e.target.value, res: null })}>
                {productosConReceta.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
              </select></label>
            <label className="field"><span className="field__label">Panes buenos que se necesitan</span>
              <input className="field__input" type="number" min="1" step="1" value={presu.cantidad} onChange={(e) => setPresu({ ...presu, cantidad: e.target.value })} /></label>
            <label className="field"><span className="field__label">Merma (%)</span>
              <input className="field__input" type="number" min="0" max="90" step="0.1" placeholder="Vacío = la de la receta" value={presu.merma} onChange={(e) => setPresu({ ...presu, merma: e.target.value })} /></label>
            {presu.res && Number(presu.cantidad) > 0 && (
              <div className="field--ancho">
                <div className="calculo-op">
                  <div><span>Panes a preparar</span><b>{num(presu.res.panesAPreparar)}</b></div>
                  <div><span>Lotes</span><b>{num2(presu.res.lotes)}</b></div>
                  <div><span>Masa total</span><b>{num2(presu.res.masaKg)} kg</b></div>
                  <div><span>Harina total</span><b>{num2(presu.res.harinaKg)} kg</b></div>
                  {verCosto && <div><span>Costo estimado</span><b>S/ {presu.res.costoEstimado.toFixed(2)}</b></div>}
                  {verCosto && <div><span>Margen estimado</span><b>{pct(presu.res.margenEstimado)}</b></div>}
                </div>
                <table className="table table--compacta">
                  <thead><tr><th>Insumo</th><th className="t-right">% panadero</th><th className="t-right">Consumo</th>{verCosto && <th className="t-right">Costo</th>}<th /></tr></thead>
                  <tbody>{presu.res.insumos.map((x) => (
                    <tr key={x.insumo}><td>{x.insumo}</td><td className="t-right t-muted">{x.pctPanadero !== null ? pct(x.pctPanadero) : '—'}</td>
                      <td className="t-right">{num2(x.consumo)} {x.unidad}</td>{verCosto && <td className="t-right">S/ {x.costo.toFixed(2)}</td>}
                      <td className="t-right">{x.falta && <Insignia tono="danger">Falta stock</Insignia>}</td></tr>))}</tbody></table>
              </div>
            )}
          </div>
        )}
      </Dialogo>
    </>
  );
}
