import { useState } from 'react';
import { api } from '@/core/api';
import { useApp } from '@/core/app-state';
import { money } from '@/core/format';
import { Boton } from '@/ui/primitives';
import { Dialogo } from '@/ui/Dialogo';
import type { Receta } from '@/core/types';

interface Linea { insumoId: string; cantidad: string }

/** Crea una versión nueva de la receta. Al guardar, el API recalcula el costo del producto. */
export function EditorReceta({ receta, onCerrar }: { receta: Receta; onCerrar: (resultado?: string) => void }) {
  const { dataset, refrescarDatos } = useApp();
  const [rend, setRend] = useState(String(receta.rendimiento));
  const [merma, setMerma] = useState(String(Math.round(receta.mermaEstandar * 1000) / 10));
  const [lineas, setLineas] = useState<Linea[]>(receta.lineas.map((l) => ({ insumoId: l.insumoId, cantidad: String(l.cantidad) })));
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const insumos = dataset.insumos;

  const set = (i: number, k: keyof Linea, v: string) => setLineas((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const libres = (actual: string) => insumos.filter((x) => x.id === actual || !lineas.some((l) => l.insumoId === x.id));

  const guardar = async () => {
    setError(null);
    setGuardando(true);
    try {
      const r = await api<{ costoConMerma: number; cifUnitario: number }>(`/recetas/${receta.productoId}`, {
        method: 'PUT',
        body: { rendimiento: Number(rend), mermaEstandar: Number(merma) / 100, lineas: lineas.map((l) => ({ insumoId: l.insumoId, cantidad: Number(l.cantidad) })) },
      });
      await refrescarDatos();
      onCerrar(`Versión ${receta.version + 1} guardada · costo unitario ${money(r.costoConMerma + r.cifUnitario)}`);
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo guardar.'); }
    finally { setGuardando(false); }
  };

  return (
    <Dialogo abierto titulo={`Nueva versión · ${receta.producto}`}
      descripcion={`La versión ${receta.version} queda en el historial; las ventas pasadas conservan su costo.`}
      onCerrar={() => onCerrar()}
      acciones={<><Boton onClick={() => onCerrar()}>Cancelar</Boton>
        <Boton variant="primary" onClick={() => void guardar()} disabled={guardando || lineas.length === 0 || lineas.some((l) => !l.insumoId || !(Number(l.cantidad) > 0))}>
          {guardando ? 'Guardando…' : `Guardar versión ${receta.version + 1}`}</Boton></>}>
      <div className="form form--2col form--dialogo">
        <label className="field"><span className="field__label">Rendimiento (unidades por tanda)</span>
          <input className="field__input" type="number" min="0.01" step="any" value={rend} onChange={(e) => setRend(e.target.value)} /></label>
        <label className="field"><span className="field__label">Merma estándar (%)</span>
          <input className="field__input" type="number" min="0" max="95" step="0.1" value={merma} onChange={(e) => setMerma(e.target.value)} /></label>
        <div className="field--ancho editor-receta">
          <div className="editor-receta__cab"><span>Insumo</span><span>Cantidad por tanda</span><span /></div>
          {lineas.map((l, i) => {
            const ins = insumos.find((x) => x.id === l.insumoId);
            return (
              <div key={i} className="editor-receta__fila">
                <select className="field__input" value={l.insumoId} onChange={(e) => set(i, 'insumoId', e.target.value)} aria-label="Insumo">
                  <option value="">Elegir…</option>
                  {libres(l.insumoId).map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
                </select>
                <div className="editor-receta__cant">
                  <input className="field__input" type="number" min="0" step="any" value={l.cantidad} onChange={(e) => set(i, 'cantidad', e.target.value)} aria-label="Cantidad" />
                  <span>{ins?.unidad ?? ''}</span>
                </div>
                <button type="button" className="iconbtn" aria-label="Quitar insumo" onClick={() => setLineas((ls) => ls.filter((_, j) => j !== i))}>×</button>
              </div>
            );
          })}
          <Boton size="sm" icono="plus" onClick={() => setLineas((ls) => [...ls, { insumoId: '', cantidad: '' }])} disabled={lineas.length >= insumos.length}>Agregar insumo</Boton>
        </div>
        {error && <p className="form__error field--ancho" role="alert">{error}</p>}
      </div>
    </Dialogo>
  );
}
