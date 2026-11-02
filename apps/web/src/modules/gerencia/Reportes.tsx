import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { exportarExcel, exportarPdf } from '@/core/exportar';
import { money, pct } from '@/core/format';
import { Boton, Encabezado, Insignia, Tarjeta, Vacio } from '@/ui/primitives';
import { BarraFiltros, aQuery, rango, useEnVivo, type Filtros } from '@/ui/Filtros';
import { TablaReporte, type ColRep } from '@/ui/TablaReporte';
import { Dialogo } from '@/ui/Dialogo';
import { useApp } from '@/core/app-state';

interface Catalogo { codigo: string; titulo: string; columnas: ColRep[] }
interface Resultado extends Catalogo { filas: Array<Record<string, unknown>>; resumen?: Record<string, unknown>; generadoEn: string }

const GRUPOS: Record<string, string> = { G: 'Gerencia', V: 'Ventas y cobranza', A: 'Almacén', M: 'Maestros' };
// Qué filtros tiene sentido mostrar en cada reporte (el resto no los usa).
const CAMPOS: Record<string, Array<'categoria' | 'producto' | 'cliente' | 'vendedor'>> = {
  'G-08': [], 'G-09': ['categoria'], 'G-10': [], 'G-11': [], 'G-12': [], 'G-13': [], 'V-01': ['cliente'], 'V-02': ['cliente'], 'A-01': ['producto'], 'A-02': [], 'M-01': ['producto'],
};

const RESUMEN: Record<string, (r: Record<string, unknown>) => Array<[string, string]>> = {
  'G-06': (r) => [['Ventas con margen negativo', String(r.ventasConMargenNegativo)]],
  'G-09': (r) => [['Margen de contribución', pct(r.margenContribucion as number)], ['Punto de equilibrio', money(r.puntoEquilibrio as number)], ['Estado', r.cubierto ? 'Cubierto' : 'Por debajo']],
  'G-10': (r) => [['Merma valorizada', money(r.mermaValorizada as number)], ['% de la producción', pct(r.pctProduccion as number)]],
  'G-11': (r) => [['Por cobrar', money(r.totalPorCobrar as number)], ['Vencido', money(r.vencido as number)], ['Días promedio de cobro', String(r.diasPromedioCobro)]],
  'G-12': (r) => [['Valor del inventario', money(r.valorTotal as number)], ['Ítems críticos', String(r.criticos)]],
  'G-13': (r) => [['Pedidos entregados a tiempo', pct(r.cumplimientoPedidos as number)]],
  'M-01': (r) => [['Producto', String(r.producto)], ['Versión de receta', String(r.version)], ['Margen', pct(r.margen as number)], ['Markup', pct(r.markup as number)]],
};

/** Catálogo de reportes del PDF (Tabla 4), calculados en vivo por el API. */
export function Reportes() {
  const [catalogo, setCatalogo] = useState<Catalogo[]>([]);
  const [codigo, setCodigo] = useState<string>('');
  const [filtros, setFiltros] = useState<Filtros>(rango(30));
  const [res, setRes] = useState<Resultado | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  useEffect(() => {
    // ?r=A-02 abre un reporte concreto (enlaces desde Almacén, Panel…).
    const pedido = new URLSearchParams(window.location.search).get('r');
    api<Catalogo[]>('/reportes')
      .then((c) => { setCatalogo(c); setCodigo((x) => x || (c.some((r) => r.codigo === pedido) ? pedido! : c[0]?.codigo) || ''); })
      .catch((e) => setError(e instanceof Error ? e.message : 'No se pudo cargar el catálogo.'));
  }, []);

  const cargar = async () => {
    if (!codigo) return;
    if (codigo === 'M-01' && !filtros.producto) { setRes(null); setError('Elige un producto para ver su ficha de costo.'); return; }
    setCargando(true);
    try { setRes(await api<Resultado>(`/reportes/${codigo}${aQuery(filtros)}`)); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'No se pudo generar.'); }
    finally { setCargando(false); }
  };
  const hace = useEnVivo(cargar, [codigo, JSON.stringify(filtros)], 60);

  // G-06 lista ventas: con permiso, un clic abre la anulación (devuelve stock y cancela la deuda).
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

  return (
    <>
      <Encabezado titulo="Reportes" descripcion="Calculados en vivo desde ventas, kárdex y el motor de costeo. Montos sin IGV."
        acciones={res && <>
          <Boton icono="download" onClick={() => exportarExcel(`${codigo}-${res.titulo}`, res.filas.map((f) => Object.fromEntries(res.columnas.map((c) => [c.label, f[c.key]]))))}>Excel</Boton>
          <Boton icono="report" onClick={exportarPdf}>PDF</Boton>
        </>} />

      <div className="reportes">
        <nav className="reportes__lista" aria-label="Catálogo de reportes">
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

          <Tarjeta padding="none">
            {error ? <Vacio titulo="Sin datos" detalle={error} icono="report" />
              : res && res.filas.length === 0 ? <Vacio titulo="Sin resultados" detalle="No hay movimientos con estos filtros." icono="report" />
                : res && <TablaReporte columnas={res.columnas} filas={res.filas}
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
