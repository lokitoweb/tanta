import { useState } from 'react';
import { api } from '@/core/api';
import { mismaFamilia, useCatalogos } from '@/core/catalogos';
import { useApp } from '@/core/app-state';
import { money } from '@/core/format';
import { Boton } from '@/ui/primitives';
import { Dialogo } from '@/ui/Dialogo';
import type { Receta } from '@/core/types';

interface Linea { insumoId: string; cantidad: string; unidad: string }

const ETIQUETA: Record<string, string> = { KG: 'kg', GR: 'gr', L: 'L', ML: 'ml', UNIDAD: 'unid', BALON: 'balón' };

/** Crea una versión nueva de la receta. Al guardar, el API convierte unidades y recalcula el costo. */
export function EditorReceta({ receta, onCerrar }: { receta: Receta; onCerrar: (resultado?: string) => void }) {
  const { dataset, refrescarDatos } = useApp();
  const { unidades } = useCatalogos();
  const [rend, setRend] = useState(String(receta.rendimiento));
  const [merma, setMerma] = useState(String(Math.round(receta.mermaEstandar * 1000) / 10));
  // Cada línea se muestra en la unidad en que se registró (gr, ml…), no en la base.
  const [lineas, setLineas] = useState<Linea[]>(receta.lineas.map((l) => {
    const x = l as typeof l & { unidadReceta?: string | null; cantidadOriginal?: number | null };
    return { insumoId: l.insumoId, cantidad: String(x.cantidadOriginal ?? l.cantidad), unidad: x.unidadReceta ?? l.unidad };
  }));
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const insumos = dataset.insumos;
  const primera = receta.version === 0;

  const set = (i: number, k: keyof Linea, v: string) => setLineas((ls) => ls.map((l, j) => {
    if (j !== i) return l;
    // Al cambiar de insumo, la unidad vuelve a la unidad base del nuevo insumo.
    if (k === 'insumoId') return { ...l, insumoId: v, unidad: insumos.find((x) => x.id === v)?.unidad ?? '' };
    return { ...l, [k]: v };
  }));
  const libres = (actual: string) => insumos.filter((x) => x.id === actual || !lineas.some((l) => l.insumoId === x.id));

  const guardar = async () => {
    setError(null);
    setGuardando(true);
    try {
      const r = await api<{ costoConMerma: number; cifUnitario: number }>(`/recetas/${receta.productoId}`, {
        method: 'PUT',
        body: { rendimiento: Number(rend), mermaEstandar: Number(merma) / 100, lineas: lineas.map((l) => ({ insumoId: l.insumoId, cantidad: Number(l.cantidad), unidad: l.unidad || undefined })) },
      });
      await refrescarDatos();
      onCerrar(`${primera ? `Receta de ${receta.producto} registrada` : `Versión ${receta.version + 1} guardada`} · insumos por unidad ${money(r.costoConMerma)}`);
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo guardar.'); }
    finally { setGuardando(false); }
  };

  return (
    <Dialogo abierto titulo={`${primera ? 'Nueva receta' : 'Nueva versión'} · ${receta.producto}`}
      descripcion={primera ? 'Agrega los insumos del lote. Al guardar se calcula el costo del producto.' : `La versión ${receta.version} queda en el historial; las ventas pasadas conservan su costo.`}
      onCerrar={() => onCerrar()}
      acciones={<><Boton onClick={() => onCerrar()}>Cancelar</Boton>
        <Boton variant="primary" onClick={() => void guardar()} disabled={guardando || lineas.length === 0 || lineas.some((l) => !l.insumoId || !(Number(l.cantidad) > 0))}>
          {guardando ? 'Guardando…' : primera ? 'Guardar receta' : `Guardar versión ${receta.version + 1}`}</Boton></>}>
      <div className="form form--2col form--dialogo">
        <label className="field"><span className="field__label">Rendimiento declarado (unidades por lote)</span>
          <input className="field__input" type="number" min="0.01" step="any" value={rend} onChange={(e) => setRend(e.target.value)} />
          <span className="field__ayuda">Si el producto tiene peso de masa, las unidades se calculan solas desde la masa.</span></label>
        <label className="field"><span className="field__label">Merma de proceso (%)</span>
          <input className="field__input" type="number" min="0" max="95" step="0.1" value={merma} onChange={(e) => setMerma(e.target.value)} /></label>
        <div className="field--ancho editor-receta">
          <div className="editor-receta__cab"><span>Insumo</span><span>Cantidad por lote</span><span /></div>
          {lineas.map((l, i) => {
            const ins = insumos.find((x) => x.id === l.insumoId);
            // MAE-07: se escribe en cualquier unidad de la familia de la unidad base del insumo (catálogo de unidades).
            const opciones = ins ? mismaFamilia(unidades, ins.unidad).map((x) => x.codigo) : [];
            return (
              <div key={i} className="editor-receta__fila">
                <select className="field__input" value={l.insumoId} onChange={(e) => set(i, 'insumoId', e.target.value)} aria-label="Insumo">
                  <option value="">Elegir…</option>
                  {libres(l.insumoId).map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
                </select>
                <div className="editor-receta__cant">
                  <input className="field__input" type="number" min="0" step="any" value={l.cantidad} onChange={(e) => set(i, 'cantidad', e.target.value)} aria-label="Cantidad" />
                  <select className="field__input editor-receta__unidad" value={l.unidad} onChange={(e) => set(i, 'unidad', e.target.value)} aria-label="Unidad" disabled={opciones.length < 2}>
                    {opciones.map((u) => <option key={u} value={u}>{ETIQUETA[u] ?? u}</option>)}
                  </select>
                </div>
                <button type="button" className="iconbtn" aria-label="Quitar insumo" onClick={() => setLineas((ls) => ls.filter((_, j) => j !== i))}>×</button>
              </div>
            );
          })}
          <Boton size="sm" icono="plus" onClick={() => setLineas((ls) => [...ls, { insumoId: '', cantidad: '', unidad: '' }])} disabled={lineas.length >= insumos.length}>Agregar insumo</Boton>
        </div>
        {error && <p className="form__error field--ancho" role="alert">{error}</p>}
      </div>
    </Dialogo>
  );
}
