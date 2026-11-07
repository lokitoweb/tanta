import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { useApp } from '@/core/app-state';
import { exportarExcel } from '@/core/exportar';
import { money, num } from '@/core/format';
import { Dialogo } from '@/ui/Dialogo';
import { InputNumero } from '@/ui/InputNumero';
import { Boton, Encabezado, Insignia, PilaEsqueleto, Segmentado, Tarjeta, TarjetaTitulo, Vacio } from '@/ui/primitives';

const aNumero = (x: string): number | '' => (x === '' ? '' : Number(x));

interface Cliente { id: string; nombre: string }
interface Fila { productoId: string; producto: string; porCliente: Record<string, number>; pedido: number }
interface InsumoHoja { insumoId: string; insumo: string; unidad: string; cantidad: number; restante: number; minimo: number; estado: 'NORMAL' | 'ALERTA' | 'FALTA' }
interface Abierta { fecha: string; fechas: string[]; clientes: Cliente[]; filas: Fila[]; insumos: InsumoHoja[]; sinReceta: string[] }
interface Hoja { codigo: string; fecha: string; estado: 'EN_PRODUCCION' | 'CERRADA'; cerradaEn: string | null; productos: number; unidades: number }
interface Resumen { op: string; productoId: string; producto: string; pedido: number; real: number | null; costo?: number | null; venta?: number | null; rentabilidad?: number | null; pctRentabilidad?: number | null }
interface Detalle extends Omit<Hoja, 'productos' | 'unidades'> { clientes: Cliente[]; filas: Fila[]; resumen: Resumen[];
  insumosUsados: Array<{ insumo: string; unidad: string; cantidad: number; costo?: number }>;
  insumosPorComprar: Array<{ insumo: string; unidad: string; stock: number; minimo: number; falta: number }> }

const dma = (x: string) => x.split('-').reverse().join('/');
const TONO = { NORMAL: 'ok', ALERTA: 'warn', FALTA: 'danger' } as const;

function Matriz({ clientes, filas, reales }: { clientes: Cliente[]; filas: Fila[]; reales?: Record<string, number | null> }) {
  return (
    <div className="table-wrap"><table className="table table--compacta">
      <thead><tr><th>Pedido</th>{clientes.map((c) => <th key={c.id} className="t-right">{c.nombre}</th>)}<th className="t-right">Pedido sistema</th>{reales && <th className="t-right">Producción real</th>}</tr></thead>
      <tbody>{filas.map((f) => (
        <tr key={f.productoId}><td><strong>{f.producto}</strong></td>
          {clientes.map((c) => <td key={c.id} className="t-right">{f.porCliente[c.id] ? num(f.porCliente[c.id]) : ''}</td>)}
          <td className="t-right"><strong>{num(f.pedido)}</strong></td>
          {reales && <td className="t-right">{reales[f.productoId] ?? '—'}</td>}</tr>
      ))}</tbody>
    </table></div>
  );
}

/** Excel de la hoja: una columna por cliente, igual que en pantalla. */
const aExcel = (nombre: string, clientes: Cliente[], filas: Fila[]) => exportarExcel(nombre, filas.map((f) => ({
  Pedido: f.producto, ...Object.fromEntries(clientes.map((c) => [c.nombre, f.porCliente[c.id] ?? ''])), 'Pedido sistema': f.pedido })));

/** Hoja de producción: pedidos confirmados por cliente, kárdex de insumos, cierre de pedidos y de producción, e historial con rentabilidad. */
export function HojaProduccion() {
  const { puede, refrescarDatos } = useApp();
  const [vista, setVista] = useState<'hoja' | 'historial'>('hoja');
  const [fecha, setFecha] = useState<string | undefined>();
  const [hoja, setHoja] = useState<Abierta | null>(null);
  const [hojas, setHojas] = useState<Hoja[]>([]);
  const [det, setDet] = useState<Detalle | null>(null);
  const [reales, setReales] = useState<Record<string, { real: string; merma: string }>>({});
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger'; texto: string } | null>(null);
  const [cargaError, setCargaError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const cargar = () => Promise.all([
    api<Abierta>(`/produccion/hoja${fecha ? `?fecha=${fecha}` : ''}`).then(setHoja),
    api<Hoja[]>('/produccion/hojas').then(setHojas),
  ]).then(() => setCargaError(null)).catch((e) => setCargaError(e.message));
  // Los pedidos entran mientras el maestro mira la hoja.
  useEffect(() => { void cargar(); const t = setInterval(() => void cargar(), 20_000); return () => clearInterval(t); }, [fecha]);

  const abrir = async (codigo: string) => {
    const d = await api<Detalle>(`/produccion/hojas/${encodeURIComponent(codigo)}`);
    setDet(d);
    setReales(Object.fromEntries(d.resumen.map((r) => [r.productoId, { real: String(r.real ?? r.pedido), merma: '0' }])));
  };
  const accion = async (fn: () => Promise<string>) => {
    setOcupado(true); setAviso(null);
    try { const t = await fn(); await Promise.all([cargar(), refrescarDatos()]); setAviso({ tono: 'ok', texto: t }); }
    catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo completar.' }); }
    finally { setOcupado(false); }
  };
  const cerrarPedidos = () => accion(async () => {
    const r = await api<{ codigo: string }>('/produccion/hoja/cerrar-pedidos', { method: 'POST', body: { fecha: hoja!.fecha } });
    return `${r.codigo}: pedidos en producción. Al terminar, indica la producción real.`;
  });
  const cerrarProduccion = () => accion(async () => {
    const r = await api<{ listos: number; sinStock: string[] }>(`/produccion/hojas/${encodeURIComponent(det!.codigo)}/cerrar`, { method: 'POST',
      body: { lineas: det!.resumen.map((x) => ({ productoId: x.productoId, real: Number(reales[x.productoId]?.real) || 0, merma: Number(reales[x.productoId]?.merma) || 0 })) } });
    const c = det!.codigo;
    await abrir(c);
    return `${c} cerrada: ${r.listos} pedido(s) listo(s) para despacho${r.sinStock.length ? ` · sin stock: ${r.sinStock.join(', ')}` : ''}.`;
  });

  const enCurso = hojas.filter((h) => h.estado === 'EN_PRODUCCION');
  const faltaInsumo = hoja?.insumos.some((i) => i.estado === 'FALTA');

  return (
    <>
      <Encabezado titulo="Hoja de producción" descripcion="Los pedidos confirmados llenan la hoja · al cerrar la producción, los panes entran al almacén y se descargan los insumos"
        acciones={<Segmentado valor={vista} onChange={setVista} opciones={[{ id: 'hoja', etiqueta: 'Hoja' }, { id: 'historial', etiqueta: 'Producciones' }]} />} />
      {aviso && <div className={`aviso aviso--${aviso.tono}`} role="status"><span className="aviso__icono">{aviso.tono === 'ok' ? '✓' : '!'}</span><div><p>{aviso.texto}</p></div></div>}
      {cargaError && <Tarjeta><Vacio titulo="No se pudo cargar" detalle={cargaError} onReintentar={() => void cargar()} /></Tarjeta>}

      {vista === 'hoja' && !cargaError && (hoja === null ? <Tarjeta><PilaEsqueleto lineas={5} /></Tarjeta> : <>
        {enCurso.length > 0 && (
          <Tarjeta>
            <TarjetaTitulo titulo="En producción" subtitulo="Indica lo producido para cerrar" />
            <div className="fila-acciones">{enCurso.map((h) => <Boton key={h.codigo} variant="primary" onClick={() => void abrir(h.codigo)}>{h.codigo} · {dma(h.fecha)}</Boton>)}</div>
          </Tarjeta>
        )}
        <Tarjeta padding="none">
          <div className="card__head card__head--padded">
            <TarjetaTitulo titulo={`Pedidos para el ${dma(hoja.fecha)}`} subtitulo="El código de lote se asigna al cerrar los pedidos" />
            <div className="fila-acciones">
              <input className="field__input" type="date" aria-label="Fecha de entrega" value={hoja.fecha} onChange={(e) => setFecha(e.target.value)} />
              <Boton icono="download" disabled={!hoja.filas.length} onClick={() => aExcel(`hoja-produccion-${hoja.fecha}`, hoja.clientes, hoja.filas)}>Excel</Boton>
              {puede('produccion.planificar') && <Boton variant="primary" disabled={ocupado || !hoja.filas.length || hoja.sinReceta.length > 0} onClick={() => void cerrarPedidos()}>Cerrar pedidos</Boton>}
            </div>
          </div>
          {hoja.filas.length ? <Matriz clientes={hoja.clientes} filas={hoja.filas} /> : <Vacio titulo="Sin pedidos confirmados para esta fecha" icono="clipboard" />}
        </Tarjeta>
        {hoja.sinReceta.length > 0 && <div className="aviso aviso--danger" role="alert"><span className="aviso__icono">!</span><div><p>Sin receta vigente: {hoja.sinReceta.join(', ')}. Créala en Recetas para poder cerrar los pedidos.</p></div></div>}
        {hoja.insumos.length > 0 && (
          <Tarjeta padding="none">
            <div className="card__head card__head--padded"><TarjetaTitulo titulo="Kárdex de insumos" subtitulo={faltaInsumo ? 'Hay insumos que no alcanzan: al cerrar la producción se exige el stock' : 'Acumulado de lo pedido; se descarga al cerrar la producción'} /></div>
            <div className="table-wrap"><table className="table table--compacta">
              <thead><tr><th>Insumo</th><th className="t-right">Cantidad</th><th className="t-right">Stock restante</th><th className="t-right">Estado</th></tr></thead>
              <tbody>{hoja.insumos.map((i) => <tr key={i.insumoId}><td>{i.insumo}</td><td className="t-right">{num(i.cantidad)} {i.unidad.toLowerCase()}</td><td className="t-right">{num(i.restante)} {i.unidad.toLowerCase()}</td>
                <td className="t-right"><Insignia tono={TONO[i.estado]} punto>{i.estado === 'NORMAL' ? 'Normal' : i.estado === 'ALERTA' ? 'Alerta' : 'Falta'}</Insignia></td></tr>)}</tbody>
            </table></div>
          </Tarjeta>
        )}
      </>)}

      {vista === 'historial' && !cargaError && (
        <Tarjeta padding="none">
          {hojas.length === 0 ? <Vacio titulo="Aún no hay producciones" icono="clipboard" /> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Lote</th><th>Fecha</th><th className="t-right">Productos</th><th className="t-right">Unidades</th><th className="t-right">Estado</th><th /></tr></thead>
              <tbody>{hojas.map((h) => <tr key={h.codigo}><td><strong>{h.codigo}</strong></td><td>{dma(h.fecha)}</td><td className="t-right">{h.productos}</td><td className="t-right">{num(h.unidades)}</td>
                <td className="t-right"><Insignia tono={h.estado === 'CERRADA' ? 'ok' : 'warn'} punto>{h.estado === 'CERRADA' ? 'Cerrada' : 'En producción'}</Insignia></td>
                <td className="t-right"><Boton onClick={() => void abrir(h.codigo)}>Ver</Boton></td></tr>)}</tbody>
            </table></div>
          )}
        </Tarjeta>
      )}

      <Dialogo abierto={det !== null} titulo={`Hoja ${det?.codigo ?? ''} - Tanta`} descripcion={det ? `Entrega ${dma(det.fecha)} · ${det.estado === 'CERRADA' ? 'cerrada' : 'en producción'}` : ''} onCerrar={() => setDet(null)}
        acciones={<>
          <Boton icono="download" onClick={() => det && aExcel(`hoja-${det.codigo.replace(' ', '-')}`, det.clientes, det.filas)}>Excel</Boton>
          {det?.estado === 'EN_PRODUCCION' && puede('produccion.ejecutar') && <Boton variant="primary" disabled={ocupado} onClick={() => void cerrarProduccion()}>{ocupado ? 'Cerrando…' : 'Cerrar producción'}</Boton>}
        </>}>
        {det && <>
          <Matriz clientes={det.clientes} filas={det.filas} reales={Object.fromEntries(det.resumen.map((r) => [r.productoId, r.real]))} />
          {det.estado === 'EN_PRODUCCION' && (
            <div className="form form--2col form--dialogo">
              {det.resumen.map((r) => <div key={r.productoId} className="pago-linea field--ancho">
                <label className="field"><span className="field__label">{r.producto}: producción real</span>
                  <InputNumero className="field__input" valor={aNumero(reales[r.productoId]?.real ?? '')} onValor={(n) => { const v = String(n); setReales({ ...reales, [r.productoId]: { real: v, merma: reales[r.productoId]?.merma ?? '0' } }); }} /></label>
                <label className="field"><span className="field__label">Merma</span>
                  <InputNumero className="field__input" valor={aNumero(reales[r.productoId]?.merma ?? '')} onValor={(n) => { const v = String(n); setReales({ ...reales, [r.productoId]: { real: reales[r.productoId]?.real ?? '', merma: v } }); }} /></label>
              </div>)}
            </div>
          )}
          {det.estado === 'CERRADA' && puede('costos.ver') && (<>
            <h4 className="hoja__titulo">Resumen de la producción</h4>
            <div className="table-wrap"><table className="table table--compacta">
              <thead><tr><th>Pedido</th><th className="t-right">Producción real</th><th className="t-right">Costo s/IGV</th><th className="t-right">Venta s/IGV</th><th className="t-right">Rentabilidad</th><th className="t-right">% rentabilidad</th></tr></thead>
              <tbody>{det.resumen.map((r) => <tr key={r.op}><td>{r.producto}</td><td className="t-right">{num(r.real ?? 0)}</td><td className="t-right">{money(r.costo ?? 0)}</td><td className="t-right">{money(r.venta ?? 0)}</td>
                <td className="t-right">{money(r.rentabilidad ?? 0)}</td><td className="t-right">{(r.pctRentabilidad ?? 0).toFixed(2)}</td></tr>)}</tbody>
            </table></div>
          </>)}
          {det.insumosUsados.length > 0 && (<>
            <h4 className="hoja__titulo">Insumos utilizados</h4>
            <div className="table-wrap"><table className="table table--compacta"><tbody>
              {det.insumosUsados.map((i) => <tr key={i.insumo}><td>{i.insumo}</td><td className="t-right">{num(i.cantidad)} {i.unidad.toLowerCase()}</td>{i.costo !== undefined && <td className="t-right">{money(i.costo)}</td>}</tr>)}
            </tbody></table></div>
          </>)}
          {det.estado === 'CERRADA' && (det.insumosPorComprar.length ? (<>
            <h4 className="hoja__titulo">Insumos por comprar (bajo el mínimo)</h4>
            <div className="table-wrap"><table className="table table--compacta">
              <thead><tr><th>Insumo</th><th className="t-right">Stock</th><th className="t-right">Mínimo</th><th className="t-right">Falta</th></tr></thead>
              <tbody>{det.insumosPorComprar.map((i) => <tr key={i.insumo}><td>{i.insumo}</td><td className="t-right">{num(i.stock)}</td><td className="t-right">{num(i.minimo)}</td><td className="t-right t-neg">{num(i.falta)} {i.unidad.toLowerCase()}</td></tr>)}</tbody>
            </table></div>
          </>) : <p className="dialogo__nota">Ningún insumo está bajo su stock mínimo.</p>)}
        </>}
      </Dialogo>
    </>
  );
}
