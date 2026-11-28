import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/core/api';
import { exportarExcel, exportarPdf } from '@/core/exportar';
import { money, pct } from '@/core/format';
import { Boton, Encabezado, Insignia, Tarjeta, TablaEsqueleto, Vacio } from '@/ui/primitives';
import { BarraFiltros, aQuery, rango, useEnVivo, type CampoFiltro, type Filtros } from '@/ui/Filtros';
import { BarrasV, LineasMultiples } from '@/ui/charts';
import { TablaReporte, type ColRep } from '@/ui/TablaReporte';
import { Dialogo } from '@/ui/Dialogo';
import { useApp } from '@/core/app-state';
import { Icon } from '@/ui/icons';
import { useCerrarAfuera } from '@/ui/useCerrarAfuera';

interface Catalogo { codigo: string; titulo: string; columnas: ColRep[] }
interface Resultado extends Catalogo { filas: Array<Record<string, unknown>>; resumen?: Record<string, unknown>; generadoEn: string }

/* ------------- Selector de reporte: arriba, con buscador y grupos (reemplaza la lista lateral) ------------- */
function SelectorReporte({ catalogo, codigo, cargando, onElegir }: { catalogo: Catalogo[]; codigo: string; cargando: boolean; onElegir: (codigo: string) => void }) {
  const [abierto, setAbierto] = useState(false);
  const [busca, setBusca] = useState('');
  const [grupo, setGrupo] = useState('');
  const cerrar = () => { setAbierto(false); setBusca(''); };
  const ref = useCerrarAfuera(abierto, cerrar);
  const entrada = useRef<HTMLInputElement>(null);
  useEffect(() => { if (abierto) entrada.current?.focus(); }, [abierto]);
  const actual = catalogo.find((c) => c.codigo === codigo);
  const grupos = [...new Set(catalogo.map((c) => c.codigo[0]))];
  // Sin tildes ni mayúsculas: «rentabilidad», «g-16» o «categoria» encuentran lo mismo.
  const norm = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const visibles = useMemo(() => catalogo.filter((c) => (!grupo || c.codigo[0] === grupo) && (!busca || norm(`${c.codigo} ${c.titulo} ${GRUPOS[c.codigo[0]] ?? ''}`).includes(norm(busca)))),
    [catalogo, grupo, busca]);
  const elegir = (c: string) => { onElegir(c); cerrar(); };

  return (
    <div className="selrep" ref={ref}>
      <button type="button" className="selrep__boton" aria-haspopup="dialog" aria-expanded={abierto} disabled={cargando && !actual} onClick={() => (abierto ? cerrar() : setAbierto(true))}>
        <span className="selrep__codigo mono">{actual?.codigo ?? '—'}</span>
        <span className="selrep__texto">
          <small>{actual ? GRUPOS[actual.codigo[0]] ?? 'Reporte' : 'Reporte'}</small>
          <b>{actual?.titulo ?? (cargando ? 'Cargando reportes…' : 'Elige un reporte')}</b>
        </span>
        <span className="selrep__cambiar">Cambiar reporte <Icon name="chevron" size={16} /></span>
      </button>
      {abierto && (
        <div className="selrep__panel" role="dialog" aria-label="Elegir reporte">
          <div className="selrep__buscar">
            <Icon name="search" size={18} />
            <input ref={entrada} value={busca} placeholder="Buscar reporte por nombre o código…" aria-label="Buscar reporte"
              onChange={(e) => setBusca(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && visibles[0]) elegir(visibles[0].codigo); }} />
            <span className="selrep__total">{visibles.length} de {catalogo.length}</span>
          </div>
          <div className="selrep__chips" role="group" aria-label="Área">
            <button type="button" className={!grupo ? 'is-active' : ''} aria-pressed={!grupo} onClick={() => setGrupo('')}>Todos</button>
            {grupos.map((g) => (
              <button key={g} type="button" className={grupo === g ? 'is-active' : ''} aria-pressed={grupo === g} onClick={() => setGrupo(grupo === g ? '' : g)}>
                {GRUPOS[g] ?? g}<span>{catalogo.filter((c) => c.codigo[0] === g).length}</span>
              </button>
            ))}
          </div>
          <div className="selrep__lista">
            {visibles.length === 0 && <p className="selrep__vacio">Ningún reporte coincide con «{busca}».</p>}
            {grupos.filter((g) => visibles.some((c) => c.codigo[0] === g)).map((g) => (
              <section key={g} className="selrep__grupo">
                <p className="selrep__grupo-t">{GRUPOS[g] ?? g}</p>
                {visibles.filter((c) => c.codigo[0] === g).map((c) => (
                  <button key={c.codigo} type="button" className={`selrep__item ${c.codigo === codigo ? 'is-active' : ''}`} onClick={() => elegir(c.codigo)}>
                    <span className="mono">{c.codigo}</span>{c.titulo}{GRAFICOS[c.codigo] && <em className="selrep__marca">Gráfico</em>}
                  </button>
                ))}
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

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
        <div className="pila">
          <Tarjeta>
            <div className="reportes__cab">
              <SelectorReporte catalogo={catalogo} cargando={catalogoCargado === null && !error} codigo={codigo}
                onElegir={(c) => { if (c !== codigo) { setCodigo(c); setRes(null); } }} />
              <div className="reportes__estado">
                {cargando && <Insignia tono="info" punto>Calculando</Insignia>}
                <span className="card__sub">{hace === null ? 'Cargando…' : `Actualizado hace ${hace} s · se refresca solo`}</span>
              </div>
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
