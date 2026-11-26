import { useEffect, useMemo, useState } from 'react';
import { api } from '@/core/api';
import { useApp } from '@/core/app-state';
import { exportarExcel } from '@/core/exportar';
import { num } from '@/core/format';
import { Boton, Encabezado, Insignia, Segmentado, Tarjeta, TablaEsqueleto, Vacio } from '@/ui/primitives';

interface Lote { id: number; productoId: string; codigo: string; producto: string; lote: string; vence: string | null; ingreso: string; diasEnAlmacen: number;
  cantidadInicial: number; saldo: number; dias: number | null; estado: 'VENCIDO' | 'VENCE_HOY' | 'VIGENTE' | 'SIN_VENCIMIENTO' }
const dma = (x: string | null) => (x ? x.split('-').reverse().join('/') : '—');
const ESTADO = { VENCIDO: ['danger', 'Vencido'], VENCE_HOY: ['warn', 'Vence hoy'], VIGENTE: ['ok', 'Vigente'], SIN_VENCIMIENTO: ['neutral', 'Sin vencimiento'] } as const;

/**
 * Pan por lote (respuesta del ingeniero): cada producción es un lote con su vencimiento (vida útil del producto).
 * El pan vencido ya no se vende ni se aparta; aquí Almacén lo retira (merma por vencimiento) y el stock queda al día.
 */
export function Vencimientos() {
  const { puede, refrescarDatos } = useApp();
  const [lotes, setLotes] = useState<Lote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vista, setVista] = useState<'todos' | 'atencion'>('atencion');
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger'; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const cargar = () => api<Lote[]>('/lotes-producto').then((l) => { setLotes(l); setError(null); }).catch((e) => setError(e.message));
  useEffect(() => { void cargar(); }, []);

  const filas = useMemo(() => (lotes ?? []).filter((l) => vista === 'todos' || l.estado === 'VENCIDO' || l.estado === 'VENCE_HOY' || (l.dias !== null && l.dias <= 1)), [lotes, vista]);
  const vencidos = (lotes ?? []).filter((l) => l.estado === 'VENCIDO');
  const porProducto = [...new Map(vencidos.map((l) => [l.productoId, l.producto])).entries()];
  const total = (xs: Lote[]) => xs.reduce((s, l) => s + l.saldo, 0);

  const retirar = async (productoIds?: string[]) => {
    setOcupado(true); setAviso(null);
    try {
      const r = await api<{ retirados: Array<{ producto: string; cantidad: number }>; unidades: number }>('/lotes-producto/retirar-vencidos', { method: 'POST', body: productoIds ? { productoIds } : {} });
      setAviso({ tono: 'ok', texto: `Retirado: ${r.retirados.map((x) => `${num(x.cantidad)} ${x.producto}`).join(', ')}. Quedó como merma por vencimiento y el stock se actualizó.` });
      await Promise.all([cargar(), refrescarDatos()]);
    } catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo retirar.' }); }
    finally { setOcupado(false); }
  };

  return (
    <>
      <Encabezado titulo="Pan por vencer" descripcion="Cada producción es un lote con su vencimiento · lo vencido no se vende: retíralo para que el stock quede al día"
        acciones={<>
          <Boton icono="download" disabled={!filas.length} onClick={() => exportarExcel('pan-por-lote', filas.map((l) => ({ Producto: l.producto, Lote: l.lote, Ingreso: l.ingreso, 'Días en almacén': l.diasEnAlmacen, Vence: l.vence ?? '', Quedan: l.saldo, Estado: ESTADO[l.estado][1] })))}>Excel</Boton>
          {puede('inventario.mover') && <Boton variant="danger" disabled={ocupado || !vencidos.length} onClick={() => void retirar()}>Retirar todo lo vencido ({num(total(vencidos))})</Boton>}
        </>} />
      {aviso && <div className={`aviso aviso--${aviso.tono}`} role="status"><span className="aviso__icono">{aviso.tono === 'ok' ? '✓' : '!'}</span><div><p>{aviso.texto}</p></div></div>}

      <div className="grid grid--auto">
        <Tarjeta className="mini-stat"><span>Vencido en almacén</span><b className={vencidos.length ? 't-neg' : ''}>{num(total(vencidos))}</b></Tarjeta>
        <Tarjeta className="mini-stat"><span>Vence hoy</span><b>{num(total((lotes ?? []).filter((l) => l.estado === 'VENCE_HOY')))}</b></Tarjeta>
        <Tarjeta className="mini-stat"><span>Vigente</span><b>{num(total((lotes ?? []).filter((l) => l.estado === 'VIGENTE' || l.estado === 'SIN_VENCIMIENTO')))}</b></Tarjeta>
      </div>

      {porProducto.length > 0 && puede('inventario.mover') && (
        <Tarjeta>
          <p className="t-muted">Retirar por producto:</p>
          <div className="fila-acciones">{porProducto.map(([id, nombre]) => (
            <Boton key={id} size="sm" disabled={ocupado} onClick={() => void retirar([id])}>{nombre} · {num(total(vencidos.filter((l) => l.productoId === id)))}</Boton>))}</div>
        </Tarjeta>
      )}

      <Tarjeta padding="none">
        <div className="toolbar"><Segmentado valor={vista} onChange={setVista} opciones={[{ id: 'atencion', etiqueta: 'Vencido y por vencer' }, { id: 'todos', etiqueta: 'Todos los lotes' }]} /></div>
        {error ? <Vacio titulo="No se pudo cargar" detalle={error} onReintentar={() => void cargar()} />
          : lotes === null ? <TablaEsqueleto columnas={7} />
          : !filas.length ? <Vacio titulo={vista === 'atencion' ? 'Nada vencido ni por vencer' : 'No hay pan en el almacén'} icono="box" />
          : <div className="table-wrap"><table className="table">
              <thead><tr><th>Producto</th><th>Lote</th><th>Ingreso</th><th className="t-right">Días en almacén</th><th>Vence</th><th className="t-right">Quedan</th><th className="t-right">Estado</th></tr></thead>
              <tbody>{filas.map((l) => <tr key={l.id}><td><strong>{l.producto}</strong><div className="t-muted mono">{l.codigo}</div></td><td className="mono">{l.lote}</td>
                <td>{dma(l.ingreso)}</td><td className="t-right">{l.diasEnAlmacen}</td><td>{dma(l.vence)}</td><td className="t-right"><strong>{num(l.saldo)}</strong></td>
                <td className="t-right"><Insignia tono={ESTADO[l.estado][0]} punto>{ESTADO[l.estado][1]}</Insignia></td></tr>)}</tbody>
            </table></div>}
      </Tarjeta>
    </>
  );
}
