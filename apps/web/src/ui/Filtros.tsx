import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { SelectorFechas } from '@/ui/SelectorFechas';

export interface Filtros { desde: string; hasta: string; categoria?: string; producto?: string; cliente?: string; vendedor?: string;
  /** Registro de ventas. */ canal?: string; condicion?: string; estadoPago?: string;
  /** Reportes anuales: año, S/ · % · unidades y Top N. */ anio?: string; medida?: string; top?: string }
export type CampoFiltro = 'categoria' | 'producto' | 'cliente' | 'vendedor' | 'anio' | 'canal' | 'condicion' | 'estadoPago' | 'top';
interface Opciones { categorias: Array<{ id: string; nombre: string }>; productos: Array<{ id: string; nombre: string }>; clientes: Array<{ id: string; nombre: string }>; vendedores: string[] }

// Fecha local (Lima), no UTC: de noche el UTC ya es "mañana".
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const rango = (dias: number): Pick<Filtros, 'desde' | 'hasta'> => { const h = new Date(); return { desde: iso(new Date(h.getFullYear(), h.getMonth(), h.getDate() - (dias - 1))), hasta: iso(h) }; };
export const aQuery = (f: Filtros) => '?' + new URLSearchParams(Object.entries(f).filter(([, v]) => v) as Array<[string, string]>).toString();

let opcionesCache: Promise<Opciones> | null = null;
const anioActual = new Date().getFullYear();

/** Filtros del PDF §5.4: fecha, categoría, producto, cliente y vendedor. Muestra solo los que se pidan. */
export function BarraFiltros({ valor, onChange, campos = ['categoria', 'producto', 'cliente', 'vendedor'] }: {
  valor: Filtros; onChange: (f: Filtros) => void; campos?: CampoFiltro[];
}) {
  const [op, setOp] = useState<Opciones | null>(null);
  useEffect(() => { (opcionesCache ??= api<Opciones>('/reportes-filtros')).then(setOp).catch(() => { opcionesCache = null; }); }, []);
  const set = (k: keyof Filtros, v: string) => onChange({ ...valor, [k]: v || undefined });

  return (
    <div className="filtros" role="search">
      {/* Un reporte anual se filtra por año (Ene–Dic); los demás, por rango de fechas. */}
      {campos.includes('anio') ? (
        <label className="filtros__campo"><span>Año</span>
          <select value={valor.anio ?? String(anioActual)} onChange={(e) => set('anio', e.target.value)}>
            {Array.from({ length: 6 }, (_, i) => anioActual - i).map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
      ) : <div className="filtros__campo"><span>Fechas</span><SelectorFechas valor={valor} onChange={(r) => onChange({ ...valor, ...r })} /></div>}
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
      {campos.includes('canal') && (
        <label className="filtros__campo"><span>Canal</span>
          <select value={valor.canal ?? ''} onChange={(e) => set('canal', e.target.value)}><option value="">Todos</option><option value="APP">Pedido por app</option><option value="TERCEROS">Venta a terceros</option></select>
        </label>)}
      {campos.includes('condicion') && (
        <label className="filtros__campo"><span>Condición</span>
          <select value={valor.condicion ?? ''} onChange={(e) => set('condicion', e.target.value)}><option value="">Todas</option><option value="CONTADO">Contado</option><option value="CREDITO">Crédito</option></select>
        </label>)}
      {campos.includes('estadoPago') && (
        <label className="filtros__campo"><span>Estado de pago</span>
          <select value={valor.estadoPago ?? ''} onChange={(e) => set('estadoPago', e.target.value)}><option value="">Todos</option><option value="PAGADO">Pagado</option><option value="PARCIAL">Pago parcial</option><option value="PENDIENTE">Pendiente</option><option value="VENCIDO">Vencido</option></select>
        </label>)}
      {campos.includes('top') && (
        <label className="filtros__campo"><span>Mostrar</span>
          <select value={valor.top ?? ''} onChange={(e) => set('top', e.target.value)}><option value="">Todos los productos</option><option value="5">Top 5 más vendidos</option><option value="10">Top 10 más vendidos</option></select>
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
