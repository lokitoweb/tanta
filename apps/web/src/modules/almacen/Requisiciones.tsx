import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { useApp } from '@/core/app-state';
import { num2 } from '@/core/format';
import { desdeIso } from '@/core/fecha';
import { Boton, Encabezado, Insignia, Segmentado, Tarjeta, Vacio } from '@/ui/primitives';
import { Dialogo } from '@/ui/Dialogo';
import { Paginador, usePaginado } from '@/ui/Paginador';

interface Linea { insumoId: string; insumo: string; unidad: string; solicitada: number; entregada: number; stock: number }
interface Requisicion { codigo: string; estado: string; creado_en: string; op: string; producto: string; cantidad: number; lotes: number | null; entrega: string; lineas: Linea[] }

const ESTADO: Record<string, { txt: string; tono: 'warn' | 'info' | 'ok' | 'neutral' }> = {
  PENDIENTE: { txt: 'Pendiente', tono: 'warn' }, PARCIAL: { txt: 'Parcial', tono: 'info' }, ATENDIDA: { txt: 'Atendida', tono: 'ok' }, ANULADA: { txt: 'Anulada', tono: 'neutral' },
};

/** A18/A19: Almacén entrega a Producción lo que pide cada OP; el stock baja al confirmar (RN-27). */
export function Requisiciones() {
  const { refrescarDatos } = useApp();
  const [vista, setVista] = useState<'PENDIENTES' | 'TODAS'>('PENDIENTES');
  const [lista, setLista] = useState<Requisicion[] | null>(null);
  const [sel, setSel] = useState<{ r: Requisicion; cant: Record<string, string> } | null>(null);
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger'; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const pag = usePaginado(lista ?? [], 15);

  const cargar = () => api<Requisicion[]>(`/requisiciones?estado=${vista}`).then(setLista).catch((e) => { setLista([]); setAviso({ tono: 'danger', texto: e.message }); });
  useEffect(() => { void cargar(); }, [vista]);

  const abrir = (r: Requisicion) => setSel({ r, cant: Object.fromEntries(r.lineas.map((l) => [l.insumoId, String(Math.max(0, Math.round((l.solicitada - l.entregada) * 1000) / 1000))])) });
  const entregar = async () => {
    if (!sel) return;
    setOcupado(true);
    try {
      const r = await api<{ estado: string }>(`/requisiciones/${sel.r.codigo}/atender`, {
        method: 'POST', body: { lineas: sel.r.lineas.map((l) => ({ insumoId: l.insumoId, cantidad: Number(sel.cant[l.insumoId] || 0) })) },
      });
      setAviso({ tono: 'ok', texto: `${sel.r.codigo} ${r.estado === 'ATENDIDA' ? 'atendida por completo' : 'atendida en parte'}: el stock ya se descontó.` });
      setSel(null);
      await Promise.all([cargar(), refrescarDatos()]);
    } catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo entregar.' }); }
    finally { setOcupado(false); }
  };

  return (
    <>
      <Encabezado titulo="Requisiciones de producción" descripcion="Cada orden de producción pide sus insumos aquí. El stock baja cuando confirmas la entrega, no cuando se crea la orden." />
      {aviso && <div className={`aviso aviso--${aviso.tono}`} role="status"><span className="aviso__icono">{aviso.tono === 'ok' ? '✓' : '!'}</span><div><p>{aviso.texto}</p></div></div>}
      <Segmentado valor={vista} onChange={setVista} opciones={[{ id: 'PENDIENTES', etiqueta: 'Por atender' }, { id: 'TODAS', etiqueta: 'Todas' }]} />
      <Tarjeta padding="none">
        {lista === null ? <div className="tabla-cargando">Cargando requisiciones…</div>
          : lista.length === 0 ? <Vacio titulo="Sin requisiciones por atender" detalle="Aparecen cuando Producción crea una orden." icono="clipboard" />
            : (
              <div className="table-wrap"><table className="table">
                <thead><tr><th>Requisición</th><th>Orden</th><th>Producto</th><th className="t-right">Lotes</th><th>Entrega</th><th className="t-right">Insumos</th><th className="t-right">Estado</th></tr></thead>
                <tbody>{pag.visibles.map((r) => {
                  const falta = r.lineas.some((l) => l.solicitada - l.entregada > l.stock + 1e-6);
                  return (
                    <tr key={r.codigo} className="is-clickable" onClick={() => ['PENDIENTE', 'PARCIAL'].includes(r.estado) && abrir(r)}>
                      <td><strong className="mono">{r.codigo}</strong></td>
                      <td className="mono">{r.op}</td>
                      <td>{r.producto}</td>
                      <td className="t-right">{r.lotes !== null ? num2(r.lotes) : '—'}</td>
                      <td>{desdeIso(r.entrega)}</td>
                      <td className="t-right">{r.lineas.length}{falta && <> <Insignia tono="danger">Falta stock</Insignia></>}</td>
                      <td className="t-right"><Insignia tono={ESTADO[r.estado]?.tono ?? 'neutral'} punto>{ESTADO[r.estado]?.txt ?? r.estado}</Insignia></td>
                    </tr>
                  );
                })}</tbody>
              </table></div>
            )}
        <Paginador {...pag} />
      </Tarjeta>

      <Dialogo abierto={sel !== null} titulo={`Entregar ${sel?.r.codigo ?? ''}`} descripcion={sel ? `${sel.r.op} · ${sel.r.producto} · ${num2(sel.r.cantidad)} unidades` : ''}
        onCerrar={() => setSel(null)}
        acciones={<><Boton onClick={() => setSel(null)}>Cancelar</Boton>
          <Boton variant="primary" disabled={ocupado} onClick={() => void entregar()}>{ocupado ? 'Registrando…' : 'Confirmar entrega'}</Boton></>}>
        {sel && (
          <table className="table table--compacta">
            <thead><tr><th>Insumo</th><th className="t-right">Solicitado</th><th className="t-right">Entregado</th><th className="t-right">Stock</th><th className="t-right">Entregar ahora</th></tr></thead>
            <tbody>{sel.r.lineas.map((l) => {
              const v = Number(sel.cant[l.insumoId] || 0);
              return (
                <tr key={l.insumoId}>
                  <td>{l.insumo}</td>
                  <td className="t-right">{num2(l.solicitada)} {l.unidad}</td>
                  <td className="t-right t-muted">{num2(l.entregada)}</td>
                  <td className={`t-right ${v > l.stock + 1e-6 ? 't-neg' : ''}`}>{num2(l.stock)}</td>
                  <td className="t-right"><input className="field__input entrega__input" type="number" min="0" step="any" value={sel.cant[l.insumoId]}
                    onChange={(e) => setSel({ ...sel, cant: { ...sel.cant, [l.insumoId]: e.target.value } })} aria-label={`Entregar ${l.insumo}`} /></td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </Dialogo>
    </>
  );
}
