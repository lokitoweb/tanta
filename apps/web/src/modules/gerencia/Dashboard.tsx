import { useState } from 'react';
import { api } from '@/core/api';
import { exportarExcel, exportarPdf } from '@/core/exportar';
import { money, moneyShort, num, pct } from '@/core/format';
import { AreaSerie, BarrasH, Dona } from '@/ui/charts';
import { Boton, Encabezado, Insignia, Kpi, Progreso, Tarjeta, TarjetaTitulo, Vacio } from '@/ui/primitives';
import { Dialogo } from '@/ui/Dialogo';
import { BarraFiltros, aQuery, rango, useEnVivo, type Filtros } from '@/ui/Filtros';
import { TablaReporte, type ColRep } from '@/ui/TablaReporte';

interface Fila { [k: string]: string | number }
interface Datos {
  kpis: Array<{ indicador: string; actual: number; anterior: number; variacion: number }>;
  puntoEquilibrio: { margenContribucion: number; puntoEquilibrio: number; cubierto: boolean };
  cxc: { totalPorCobrar: number; vencido: number; diasPromedioCobro: number; tramos: Array<{ tramo: string; saldo: number }> };
  serie: Array<{ fecha: string; ventas: number; utilidad: number; tickets: number }>;
  categorias: Fila[]; top: Fila[]; bottom: Fila[];
  alertas: Array<{ producto: string; margen: number; objetivo: number }>;
}
interface Ficha { titulo: string; columnas: ColRep[]; filas: Array<Record<string, unknown>>; resumen: Record<string, number | string> }

const TONO = { verde: 'ok', ambar: 'warn', rojo: 'danger' } as const;

/** Dashboard gerencial (PDF §5.4): datos reales del período, comparados con el anterior. */
export function Dashboard() {
  const [filtros, setFiltros] = useState<Filtros>(rango(30));
  const [d, setD] = useState<Datos | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ficha, setFicha] = useState<Ficha | null>(null);
  const [lista, setLista] = useState<'top' | 'bottom'>('top');

  const hace = useEnVivo(async () => {
    try { setD(await api<Datos>(`/dashboard${aQuery(filtros)}`)); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'No se pudo cargar.'); }
  }, [JSON.stringify(filtros)], 30);

  const abrirFicha = async (nombre: string) => {
    const op = await api<{ productos: Array<{ id: string; nombre: string }> }>('/reportes-filtros');
    const id = op.productos.find((p) => p.nombre === nombre)?.id;
    if (id) setFicha(await api<Ficha>(`/reportes/M-01?producto=${id}`));
  };

  if (error && !d) return <Vacio titulo="No se pudo cargar el dashboard" detalle={error} icono="chart" />;
  if (!d) return <div className="tabla-cargando">Calculando indicadores…</div>;

  const k = Object.fromEntries(d.kpis.map((x) => [x.indicador, x]));
  const delta = (x?: { variacion: number }, esPuntos = false) => x && ({
    delta: `${x.variacion >= 0 ? '+' : ''}${esPuntos ? (x.variacion * 100).toFixed(1) + ' pts' : pct(x.variacion)}`,
    deltaTono: (Math.abs(x.variacion) < 0.001 ? 'flat' : x.variacion > 0 ? 'up' : 'down') as 'up' | 'down' | 'flat',
  });
  const pe = d.puntoEquilibrio;
  const ventas = k['Ventas netas']?.actual ?? 0;
  const productos = lista === 'top' ? d.top : d.bottom;

  return (
    <>
      <Encabezado titulo="Costos, rentabilidad y márgenes"
        descripcion={`En vivo · ${hace === null ? 'cargando' : `actualizado hace ${hace} s`} · montos sin IGV`}
        acciones={<>
          <Boton icono="download" onClick={() => exportarExcel('dashboard-productos', [...d.top, ...d.bottom])}>Excel</Boton>
          <Boton icono="report" onClick={exportarPdf}>PDF</Boton>
        </>} />

      <Tarjeta><BarraFiltros valor={filtros} onChange={setFiltros} campos={['categoria', 'vendedor']} /></Tarjeta>

      <div className="grid grid--4">
        <Kpi label="Ventas netas" valor={money(ventas)} {...delta(k['Ventas netas'])} nota="vs. período anterior" icono="chart" />
        <Kpi label="Utilidad bruta" valor={money(k['Utilidad bruta']?.actual ?? 0)} {...delta(k['Utilidad bruta'])} nota={`costo ${money(k['Costo de ventas']?.actual ?? 0)}`} icono="wallet" />
        <Kpi label="Margen bruto" valor={pct(k['Margen bruto %']?.actual ?? 0)} {...delta(k['Margen bruto %'], true)} nota="utilidad ÷ ventas netas" icono="spark" />
        <Kpi label="Tickets" valor={num(k.Tickets?.actual ?? 0)} {...delta(k.Tickets)} nota={`ticket promedio ${money(ventas / Math.max(1, k.Tickets?.actual ?? 1))}`} icono="report" />
      </div>

      {d.alertas.length > 0 && (
        <div className="aviso aviso--danger" role="alert">
          <span className="aviso__icono">!</span>
          <div><strong>{d.alertas.length} productos por debajo de su margen objetivo</strong>
            <p>{d.alertas.slice(0, 6).map((a) => `${a.producto} (${pct(a.margen)} vs ${pct(a.objetivo)})`).join(' · ')}</p></div>
        </div>
      )}

      <div className="grid grid--12">
        <Tarjeta className="col-8">
          <TarjetaTitulo titulo="Ventas y utilidad por día" subtitulo={`${filtros.desde} a ${filtros.hasta}`} />
          {d.serie.some((s) => s.ventas > 0)
            ? <AreaSerie datos={d.serie.map((s) => ({ label: s.fecha.slice(5), a: s.ventas, b: s.utilidad }))} etiquetaA="Ventas netas" etiquetaB="Utilidad" formato={moneyShort} />
            : <Vacio titulo="Sin ventas en el rango" icono="chart" />}
        </Tarjeta>
        <Tarjeta className="col-4">
          <TarjetaTitulo titulo="Punto de equilibrio" subtitulo="Costos fijos ÷ margen de contribución" />
          <div className="equilibrio">
            <b>{money(pe.puntoEquilibrio)}</b>
            <span>ventas mínimas para no perder</span>
            <Progreso valor={pe.puntoEquilibrio ? Math.min(1, ventas / pe.puntoEquilibrio / 2) : 0} tono={pe.cubierto ? 'ok' : 'danger'} />
            <Insignia tono={pe.cubierto ? 'ok' : 'danger'} punto>{pe.cubierto ? `Cubierto · margen de seguridad ${money(ventas - pe.puntoEquilibrio)}` : 'Por debajo del equilibrio'}</Insignia>
            <span className="t-muted">Margen de contribución {pct(pe.margenContribucion)}</span>
          </div>
        </Tarjeta>
      </div>

      <div className="grid grid--12">
        <Tarjeta className="col-7">
          <TarjetaTitulo titulo="Margen por categoría" subtitulo="Semáforo contra el objetivo definido en Maestros" />
          <BarrasH formato={(n) => pct(n)} filas={d.categorias.map((c) => ({
            label: String(c.nombre), valor: Number(c.margen), nota: `objetivo ${pct(Number(c.objetivo))} · ${money(Number(c.ventas))}`,
            tono: TONO[c.semaforo as keyof typeof TONO],
          }))} />
        </Tarjeta>
        <Tarjeta className="col-5">
          <TarjetaTitulo titulo="Cuentas por cobrar" subtitulo={`${money(d.cxc.vencido)} vencido · cobro en ${d.cxc.diasPromedioCobro} días promedio`} />
          <Dona centro={moneyShort(d.cxc.totalPorCobrar)} sub="por cobrar" partes={d.cxc.tramos.map((t) => ({ label: t.tramo, valor: t.saldo }))} />
        </Tarjeta>
      </div>

      <Tarjeta padding="none">
        <div className="card__head card__head--padded">
          <div><h3 className="card__title">Rentabilidad por producto</h3><p className="card__sub">Clic en un producto para ver su ficha de costo</p></div>
          <div className="segmentado" role="group">
            <button className={lista === 'top' ? 'is-active' : ''} onClick={() => setLista('top')}>10 más rentables</button>
            <button className={lista === 'bottom' ? 'is-active' : ''} onClick={() => setLista('bottom')}>10 menos rentables</button>
          </div>
        </div>
        <TablaReporte onFila={(f) => void abrirFicha(String(f.nombre))} filas={productos} columnas={[
          { key: 'nombre', label: 'Producto' }, { key: 'categoria', label: 'Categoría' }, { key: 'unidades', label: 'Unidades', tipo: 'num' },
          { key: 'ventas', label: 'Ventas', tipo: 'dinero' }, { key: 'utilidad', label: 'Utilidad', tipo: 'dinero' },
          { key: 'margen', label: 'Margen', tipo: 'pct' }, { key: 'semaforo', label: 'Estado', tipo: 'semaforo' },
        ]} />
      </Tarjeta>

      <Dialogo abierto={ficha !== null} titulo={`Ficha de costo · ${ficha?.resumen.producto ?? ''}`}
        descripcion={ficha ? `Receta v${ficha.resumen.version} · rinde ${ficha.resumen.rendimiento} u · margen ${pct(Number(ficha.resumen.margen))} · markup ${pct(Number(ficha.resumen.markup))}` : ''}
        onCerrar={() => setFicha(null)} acciones={<Boton variant="primary" onClick={() => setFicha(null)}>Cerrar</Boton>}>
        {ficha && <TablaReporte columnas={ficha.columnas} filas={ficha.filas} />}
      </Dialogo>
    </>
  );
}
