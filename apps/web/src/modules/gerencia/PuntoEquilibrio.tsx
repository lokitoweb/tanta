import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { money, num } from '@/core/format';
import { Encabezado, PilaEsqueleto, Tarjeta, TarjetaTitulo, Vacio } from '@/ui/primitives';

interface Mes { mes: number; gastos: number; porTipo: Array<{ tipo: string; monto: number }> }
interface Producto { id: string; nombre: string; ganancia: number; meses: Array<{ mes: number; vendido: number; equilibrio: number | null; alcanzado: boolean }>; dias: number[] }
interface Datos { anio: number; meses: Mes[]; dias: string[]; productos: Producto[] }

const NOMBRE = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Set', 'Oct', 'Nov', 'Dic'];
const ANIO = new Date().getFullYear();

/** Análisis mensual: cuántas unidades de cada pan cubren los gastos del mes (gastos ÷ ganancia por unidad). */
export function PuntoEquilibrio() {
  const [anio, setAnio] = useState(ANIO);
  const [d, setD] = useState<Datos | null>(null);
  const [cargaError, setCargaError] = useState<string | null>(null);
  const cargar = () => { setD(null); api<Datos>(`/analisis/punto-equilibrio?anio=${anio}`).then((x) => { setD(x); setCargaError(null); }).catch((e) => setCargaError(e.message)); };
  useEffect(cargar, [anio]);
  const corto = (mes: number) => `${NOMBRE[mes - 1]} ${String(anio).slice(2)}`;

  return (
    <>
      <Encabezado titulo="Punto de equilibrio" descripcion="Gastos del mes ÷ ganancia por unidad (venta sin IGV − costo). Cada pan se calcula por separado."
        acciones={<select className="field__input" aria-label="Año" value={anio} onChange={(e) => setAnio(Number(e.target.value))}>{[ANIO, ANIO - 1, ANIO - 2].map((a) => <option key={a}>{a}</option>)}</select>} />
      {cargaError ? <Tarjeta><Vacio titulo="No se pudo cargar" detalle={cargaError} onReintentar={cargar} /></Tarjeta>
        : d === null ? <Tarjeta><PilaEsqueleto lineas={5} /></Tarjeta> : <>
        <Tarjeta padding="none">
          <div className="card__head card__head--padded"><TarjetaTitulo titulo="Gastos por mes" subtitulo="Pagos de costos y gastos registrados; los costos de producción ya están en el costo del pan" /></div>
          <div className="table-wrap"><table className="table table--compacta">
            <thead><tr><th>Mes</th><th>Detalle</th><th className="t-right">Punto de equilibrio</th></tr></thead>
            <tbody>{d.meses.map((m) => <tr key={m.mes}><td><strong>{corto(m.mes)}</strong></td><td className="t-muted">{m.porTipo.map((t) => `${t.tipo} ${money(t.monto)}`).join(' · ') || 'Sin gastos registrados'}</td><td className="t-right"><strong>{money(m.gastos)}</strong></td></tr>)}</tbody>
          </table></div>
        </Tarjeta>
        <Tarjeta padding="none">
          <div className="card__head card__head--padded"><TarjetaTitulo titulo="Unidades vendidas frente al punto de equilibrio" subtitulo="Vendidas / necesarias · en verde, las que ya lo pasaron" /></div>
          {d.productos.length === 0 ? <Vacio titulo="Sin productos activos" icono="chart" /> : (
            <div className="table-wrap"><table className="table table--compacta">
              <thead><tr><th>Pedido</th><th className="t-right">Ganancia x unidad</th>{d.meses.map((m) => <th key={m.mes} className="t-right">{corto(m.mes)}</th>)}{d.dias.map((x) => <th key={x} className="t-right">{x.slice(8)}/{x.slice(5, 7)}</th>)}</tr></thead>
              <tbody>{d.productos.map((p) => <tr key={p.id}><td><strong>{p.nombre}</strong></td><td className="t-right">{p.ganancia > 0 ? money(p.ganancia) : <span className="t-neg">{money(p.ganancia)}</span>}</td>
                {p.meses.map((m) => <td key={m.mes} className={`t-right ${m.alcanzado ? 't-ok' : ''}`}>{num(m.vendido)}{m.equilibrio ? ` / ${num(m.equilibrio)}` : ''}</td>)}
                {p.dias.map((x, i) => <td key={i} className="t-right t-muted">{num(x)}</td>)}</tr>)}</tbody>
            </table></div>
          )}
          <p className="dialogo__nota">Un pan sin costo o sin ganancia no muestra cantidad: define su receta o revisa su precio.</p>
        </Tarjeta>
      </>}
    </>
  );
}
