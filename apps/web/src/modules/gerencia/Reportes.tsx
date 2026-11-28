import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { exportarExcel, exportarPdf } from '@/core/exportar';
import { money, pct } from '@/core/format';
import { Boton, Encabezado, Insignia, PilaEsqueleto, Tarjeta, TablaEsqueleto, Vacio } from '@/ui/primitives';
import { BarraFiltros, aQuery, rango, useEnVivo, type CampoFiltro, type Filtros } from '@/ui/Filtros';
import { BarrasV, LineasMultiples } from '@/ui/charts';
import { TablaReporte, type ColRep } from '@/ui/TablaReporte';
import { Dialogo } from '@/ui/Dialogo';
import { useApp } from '@/core/app-state';

interface Catalogo { codigo: string; titulo: string; columnas: ColRep[] }
interface Resultado extends Catalogo { filas: Array<Record<string, unknown>>; resumen?: Record<string, unknown>; generadoEn: string }

/* ------------- Reportes anuales (REQ-REP-02…04): gráfico sobre las mismas filas de la tabla ------------- */
const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Set', 'Oct', 'Nov', 'Dic'];
const GRAFICOS: Record<string, { titulo: string; medidas: Array<[string, string]> }> = {
  'G-14': { titulo: 'Utilidad por categoría, mes a mes', medidas: [['soles', 'Utilidad S/'], ['margen', 'Margen %']] },
  'G-15': { titulo: 'Ventas por producto, mes a mes', medidas: [['soles', 'Ventas S/'], ['unidades', 'Unidades']] },
  'G-16': { titulo: 'Rentabilidad mes a mes', medidas: [['utilidad', 'Utilidad bruta'], ['comparar', 'Ventas vs. costos vs. utilidad']] },
};
const unidades = (n: number) => `${Math.round(n).toLocaleString('es-PE')} und.`;

function GraficoAnual({ codigo, res, medida, onMedida }: { codigo: string; res: Resultado; medida?: string; onMedida: (m: string) => void }) {
  const g = GRAFICOS[codigo];
  const actual = g.medidas.some(([m]) => m === medida) ? medida! : g.medidas[0][0];
  const anio = String((res.resumen as { anio?: number } | undefined)?.anio ?? '');
  let cuerpo;
  if (codigo === 'G-16') {
    const col = (k: string) => res.filas.map((f) => Number(f[k]) || 0);
    cuerpo = actual === 'comparar'
      ? <BarrasV titulo={`${g.titulo} ${anio}`} etiquetas={MESES} formato={money} series={[
          { nombre: 'Ventas netas', valores: col('ventas'), color: 'var(--tanta-ink-800)' },
          { nombre: 'Costos totales', valores: col('costo'), color: 'var(--tanta-sand-400)' },
          { nombre: 'Utilidad bruta', valores: col('utilidad'), color: 'var(--tanta-state-ok)' }]} />
      : <BarrasV titulo={`${g.titulo} ${anio}`} etiquetas={MESES} formato={money} series={[{ nombre: 'Utilidad bruta', valores: col('utilidad'), color: 'var(--tanta-primario)' }]} />;
  } else {
    // Medida que pidió el API (la tabla ya viene en S/, % o unidades).
    const enPct = res.columnas.find((c) => c.key === 'm1')?.tipo === 'pct', enUnd = res.columnas.find((c) => c.key === 'm1')?.tipo === 'num';
    const formato = enPct ? pct : enUnd ? unidades : money;
    cuerpo = <LineasMultiples titulo={`${g.titulo} ${anio}`} etiquetas={MESES} formato={formato}
      formatoEje={enPct ? (n) => `${Math.round(n * 100)} %` : undefined}
      series={res.filas.map((f) => ({ nombre: String(f.nombre), valores: MESES.map((_, i) => Number(f[`m${i + 1}`]) || 0) }))} />;
  }
  return (
    <div className="reportes__grafico">
      <div className="reportes__grafico-cab">
        <div><h3 className="card__title">{g.titulo} · {anio}</h3>
          <p className="card__sub">{codigo === 'G-16' ? 'Barras en rojo: meses con pérdida' : 'Toca una serie en la leyenda para ocultarla o mostrarla'}</p></div>
        <div className="segmentado" role="group" aria-label="Qué mostrar">
          {g.medidas.map(([m, label]) => <button key={m} type="button" className={actual === m ? 'is-active' : ''} aria-pressed={actual === m} onClick={() => onMedida(m)}>{label}</button>)}
        </div>
      </div>
      {cuerpo}
    </div>
  );
}

const GRUPOS: Record<string, string> = { G: 'Gerencia', V: 'Ventas y cobranza', A: 'Almacén', P: 'Producción', M: 'Maestros' };
// Qué filtros tiene sentido mostrar en cada reporte (el resto no los usa).
const CAMPOS: Record<string, CampoFiltro[]> = {
  'G-06': ['cliente', 'vendedor', 'canal', 'condicion', 'estadoPago'],
  'G-14': ['anio', 'vendedor'], 'G-15': ['anio', 'categoria', 'top', 'vendedor'], 'G-16': ['anio', 'categoria', 'vendedor'],
  'G-08': [], 'G-09': ['categoria'], 'G-10': [], 'G-11': [], 'G-12': [], 'G-13': [], 'V-01': ['cliente'], 'V-02': ['cliente'], 'A-01': ['producto'], 'A-02': [], 'P-01': [], 'P-02': ['producto'], 'M-01': ['producto'],
};

const RESUMEN: Record<string, (r: Record<string, unknown>) => Array<[string, string]>> = {
  'G-06': (r) => [['Documentos', String(r.documentos)], ['Total vendido (con IGV)', money(r.total as number)], ['Utilidad bruta', money(r.utilidad as number)],
    ['Margen', pct(r.margen as number)], ['Por cobrar', String(r.porCobrar)], ['Ventas con margen negativo', String(r.ventasConMargenNegativo)]],
  'G-16': (r) => [['Año', String(r.anio)], ['Ventas netas', money(r.ventas as number)], ['Costos totales', money(r.costo as number)], ['Utilidad bruta', money(r.utilidad as number)], ['Margen', pct(r.margen as number)]],
  'G-09': (r) => [['Margen de contribución', pct(r.margenContribucion as number)], ['Punto de equilibrio', money(r.puntoEquilibrio as number)], ['Estado', r.cubierto ? 'Cubierto' : 'Por debajo']],
  'G-10': (r) => [['Merma valorizada', money(r.mermaValorizada as number)], ['% de la producción', pct(r.pctProduccion as number)]],
  'G-11': (r) => [['Por cobrar', money(r.totalPorCobrar as number)], ['Vencido', money(r.vencido as number)], ['Días promedio de cobro', String(r.diasPromedioCobro)]],
  'G-12': (r) => [['Valor del inventario', money(r.valorTotal as number)], ['Ítems críticos', String(r.criticos)]],
  'G-13': (r) => [['Pedidos entregados a tiempo', pct(r.cumplimientoPedidos as number)]],
  'M-01': (r) => [['Producto', String(r.producto)], ['Versión de receta', String(r.version)], ['Margen', pct(r.margen as number)], ['Markup', pct(r.markup as number)]],
};

/** Catálogo de reportes del PDF (Tabla 4), calculados en vivo por el API. */
export function Reportes() {
  // null = cargando el catálogo (esqueleto).
  const [catalogoCargado, setCatalogo] = useState<Catalogo[] | null>(null);
  const catalogo = catalogoCargado ?? [];
  const [codigo, setCodigo] = useState<string>('');
  const [filtros, setFiltros] = useState<Filtros>(rango(30));
  const [res, setRes] = useState<Resultado | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  const cargarCatalogo = () => {
    // ?r=A-02 abre un reporte concreto (enlaces desde Almacén, Panel…).
    const pedido = new URLSearchParams(window.location.search).get('r');
    api<Catalogo[]>('/reportes')
      .then((c) => { setCatalogo(c); setError(null); setCodigo((x) => x || (c.some((r) => r.codigo === pedido) ? pedido! : c[0]?.codigo) || ''); })
      .catch((e) => setError(e instanceof Error ? e.message : 'No se pudo cargar el catálogo.'));
  };
  useEffect(cargarCatalogo, []);

  const cargar = async () => {
    if (!codigo) return;
    if (codigo === 'M-01' && !filtros.producto) { setRes(null); setError('Elige un producto para ver su ficha de costo.'); return; }
    setCargando(true);
    try { setRes(await api<Resultado>(`/reportes/${codigo}${aQuery(filtros)}`)); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'No se pudo generar.'); }
    finally { setCargando(false); }
  };
  const hace = useEnVivo(cargar, [codigo, JSON.stringify(filtros)], 60);

  // Registro de ventas (G-06): con permiso, un clic abre la anulación (devuelve stock y cancela la deuda).
  const { rol } = useApp();
  const puedeAnular = codigo === 'G-06' && rol.permisos.includes('ventas.anular');
  const [anular, setAnular] = useState<{ codigo: string; motivo: string; error?: string; ocupado?: boolean } | null>(null);
  const confirmarAnulacion = async () => {
    if (!anular) return;
    setAnular({ ...anular, ocupado: true, error: undefined });
    try {
      await api(`/ventas/${anular.codigo}/anular`, { method: 'POST', body: { motivo: anular.motivo } });
      setAnular(null);
      void cargar();
    } catch (e) { setAnular({ ...anular, ocupado: false, error: e instanceof Error ? e.message : 'No se pudo anular.' }); }
  };

  const actual = catalogo.find((c) => c.codigo === codigo);
  const grupos = [...new Set(catalogo.map((c) => c.codigo[0]))];
  const resumen = res?.resumen && RESUMEN[codigo]?.(res.resumen);
  const faltaProducto = codigo === 'M-01' && !filtros.producto;
  const reintentar = () => { setError(null); if (codigo) void cargar(); else cargarCatalogo(); };

  return (
    <>
      <Encabezado titulo="Reportes" descripcion="Calculados en vivo desde ventas, kárdex y el motor de costeo. Montos sin IGV."
        acciones={res && <>
          <Boton icono="download" onClick={() => exportarExcel(`${codigo}-${res.titulo}`, res.filas.map((f) => Object.fromEntries(res.columnas.map((c) => [c.label, f[c.key]]))))}>Excel</Boton>
          <Boton icono="report" onClick={exportarPdf}>PDF</Boton>
        </>} />

      <div className="reportes">
        <nav className="reportes__lista" aria-label="Catálogo de reportes">
          {catalogoCargado === null && !error && <PilaEsqueleto lineas={8} />}
          {grupos.map((g) => (
            <div key={g} className="reportes__grupo">
              <p className="reportes__grupo-t">{GRUPOS[g] ?? g}</p>
              {catalogo.filter((c) => c.codigo[0] === g).map((c) => (
                <button key={c.codigo} className={`reportes__item ${c.codigo === codigo ? 'is-active' : ''}`} onClick={() => { setCodigo(c.codigo); setRes(null); }}>
                  <span className="mono">{c.codigo}</span>{c.titulo}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="pila">
          <Tarjeta>
            <div className="reportes__cab">
              <div><h2 className="card__title">{actual?.titulo ?? 'Reporte'}</h2>
                <p className="card__sub">{hace === null ? 'Cargando…' : `Actualizado hace ${hace} s · se refresca solo`}</p></div>
              {cargando && <Insignia tono="info" punto>Calculando</Insignia>}
            </div>
            <BarraFiltros valor={filtros} onChange={setFiltros} campos={CAMPOS[codigo] ?? ['categoria', 'producto', 'cliente', 'vendedor']} />
            {resumen && <div className="resumen">{resumen.map(([k, v]) => <div key={k}><span>{k}</span><b>{v}</b></div>)}</div>}
          </Tarjeta>

          {res && !error && res.codigo === codigo && GRAFICOS[codigo] && res.filas.length > 0 && (
            <Tarjeta><GraficoAnual codigo={codigo} res={res} medida={filtros.medida} onMedida={(medida) => setFiltros({ ...filtros, medida })} /></Tarjeta>
          )}
          <Tarjeta padding="none">
            {error ? (faltaProducto ? <Vacio titulo="Sin datos" detalle={error} icono="report" />
              : <Vacio titulo="No se pudo cargar" detalle={error} icono="report" onReintentar={reintentar} />)
              : catalogoCargado && !codigo ? <Vacio titulo="Sin reportes disponibles" detalle="Tu rol no tiene reportes asignados." icono="report" />
              : !res ? <TablaEsqueleto />
              : res.filas.length === 0 ? <Vacio titulo="Sin resultados" detalle="No hay movimientos con estos filtros." icono="report" />
                : <TablaReporte columnas={res.columnas} filas={res.filas}
                  onFila={puedeAnular ? (f) => setAnular({ codigo: String(f.codigo), motivo: '' }) : undefined} />}
          </Tarjeta>
        </div>
      </div>

      <Dialogo abierto={anular !== null} titulo={`Anular venta ${anular?.codigo ?? ''}`}
        descripcion="El stock vuelve al almacén y la deuda se cancela. Queda registrado en la auditoría y no se puede deshacer."
        onCerrar={() => setAnular(null)}
        acciones={<>
          <Boton onClick={() => setAnular(null)}>Cancelar</Boton>
          <Boton variant="primary" disabled={!anular || anular.motivo.trim().length < 5 || anular.ocupado} onClick={() => void confirmarAnulacion()}>
            {anular?.ocupado ? 'Anulando…' : 'Anular venta'}
          </Boton>
        </>}>
        <label className="field"><span className="field__label">Motivo</span>
          <input className="field__input" autoFocus maxLength={200} placeholder="Ej.: error de digitación" value={anular?.motivo ?? ''}
            onChange={(e) => anular && setAnular({ ...anular, motivo: e.target.value })} />
        </label>
        {anular?.error && <p className="form__error" role="alert">{anular.error}</p>}
      </Dialogo>
    </>
  );
}
