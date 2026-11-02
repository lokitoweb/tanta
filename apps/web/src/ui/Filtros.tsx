import { useEffect, useState } from 'react';
import { api } from '@/core/api';

export interface Filtros { desde: string; hasta: string; categoria?: string; producto?: string; cliente?: string; vendedor?: string }
interface Opciones { categorias: Array<{ id: string; nombre: string }>; productos: Array<{ id: string; nombre: string }>; clientes: Array<{ id: string; nombre: string }>; vendedores: string[] }

const iso = (d: Date) => d.toISOString().slice(0, 10);
export const rango = (dias: number): Pick<Filtros, 'desde' | 'hasta'> => ({ desde: iso(new Date(Date.now() - (dias - 1) * 86_400_000)), hasta: iso(new Date()) });
export const aQuery = (f: Filtros) => '?' + new URLSearchParams(Object.entries(f).filter(([, v]) => v) as Array<[string, string]>).toString();

let opcionesCache: Promise<Opciones> | null = null;

/** Filtros del PDF §5.4: fecha, categoría, producto, cliente y vendedor. Muestra solo los que se pidan. */
export function BarraFiltros({ valor, onChange, campos = ['categoria', 'producto', 'cliente', 'vendedor'] }: {
  valor: Filtros; onChange: (f: Filtros) => void; campos?: Array<'categoria' | 'producto' | 'cliente' | 'vendedor'>;
}) {
  const [op, setOp] = useState<Opciones | null>(null);
  useEffect(() => { (opcionesCache ??= api<Opciones>('/reportes-filtros')).then(setOp).catch(() => { opcionesCache = null; }); }, []);
  const dias = Math.round((Date.parse(valor.hasta) - Date.parse(valor.desde)) / 86_400_000) + 1;
  const set = (k: keyof Filtros, v: string) => onChange({ ...valor, [k]: v || undefined });

  return (
    <div className="filtros" role="search">
      <div className="filtros__rapidos" role="group" aria-label="Rango rápido">
        {[7, 30, 90].map((n) => (
          <button key={n} className={`chipfilter ${dias === n && valor.hasta === iso(new Date()) ? 'is-active' : ''}`} onClick={() => onChange({ ...valor, ...rango(n) })}>{n} días</button>
        ))}
      </div>
      <label className="filtros__campo"><span>Desde</span><input type="date" value={valor.desde} max={valor.hasta} onChange={(e) => e.target.value && set('desde', e.target.value)} /></label>
      <label className="filtros__campo"><span>Hasta</span><input type="date" value={valor.hasta} min={valor.desde} onChange={(e) => e.target.value && set('hasta', e.target.value)} /></label>
      {campos.includes('categoria') && (
        <label className="filtros__campo"><span>Categoría</span>
          <select value={valor.categoria ?? ''} onChange={(e) => set('categoria', e.target.value)}><option value="">Todas</option>{op?.categorias.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select>
        </label>)}
      {campos.includes('producto') && (
        <label className="filtros__campo"><span>Producto</span>
          <select value={valor.producto ?? ''} onChange={(e) => set('producto', e.target.value)}><option value="">Todos</option>{op?.productos.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select>
        </label>)}
      {campos.includes('cliente') && (
        <label className="filtros__campo"><span>Cliente</span>
          <select value={valor.cliente ?? ''} onChange={(e) => set('cliente', e.target.value)}><option value="">Todos</option>{op?.clientes.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select>
        </label>)}
      {campos.includes('vendedor') && (
        <label className="filtros__campo"><span>Vendedor</span>
          <select value={valor.vendedor ?? ''} onChange={(e) => set('vendedor', e.target.value)}><option value="">Todos</option>{op?.vendedores.map((v) => <option key={v} value={v}>{v}</option>)}</select>
        </label>)}
    </div>
  );
}

/** Refresca cada `segundos` mientras la pestaña está visible; devuelve hace cuánto fue la última carga. */
export function useEnVivo(cargar: () => Promise<void>, deps: unknown[], segundos = 30) {
  const [ultima, setUltima] = useState<number>(0);
  const [ahora, setAhora] = useState(Date.now());
  useEffect(() => {
    let vivo = true;
    const tick = async () => { if (document.visibilityState === 'visible') { await cargar().catch(() => {}); if (vivo) setUltima(Date.now()); } };
    void tick();
    const t = setInterval(tick, segundos * 1000);
    const reloj = setInterval(() => setAhora(Date.now()), 5000);
    const alVolver = () => { if (document.visibilityState === 'visible') void tick(); };
    document.addEventListener('visibilitychange', alVolver);
    return () => { vivo = false; clearInterval(t); clearInterval(reloj); document.removeEventListener('visibilitychange', alVolver); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ultima ? Math.max(0, Math.round((ahora - ultima) / 1000)) : null;
}
