import { useMemo, useState } from 'react';
import { exportarExcel, exportarPdf } from '@/core/exportar';
import { useApp } from '@/core/app-state';
import { money, moneyShort, num, pct, semaforo, eje } from '@/core/format';
import { AreaSerie, BarrasH, Dona } from '@/ui/charts';
import { Boton, Encabezado, Insignia, Kpi, Progreso, Segmentado, Tarjeta, TarjetaTitulo } from '@/ui/primitives';
import { desdeIso } from '@/core/fecha';

type Periodo = 'mes' | 'semana' | 'anio';

export function Dashboard() {
  const { dataset } = useApp();
  const [periodo, setPeriodo] = useState<Periodo>('mes');

  const serie = useMemo(() => {
    const n = periodo === 'semana' ? 7 : periodo === 'mes' ? 30 : 30;
    return dataset.dias.slice(-n).map((d) => ({ label: desdeIso(d.fecha), a: d.ventasNetas, b: d.costo }));
  }, [dataset.dias, periodo]);

  const k = dataset.kpis;
  const brecha = k.margen - k.margenObjetivo;

  const categorias = dataset.categorias.map((c) => ({
    label: c.nombre,
    valor: c.margen,
    nota: `obj. ${pct(c.margenObjetivo, 0)}`,
    tono: semaforo(c.margen, c.margenObjetivo),
  }));

  const sobreMeta = brecha >= 0;
  const hoyIso = new Date().toISOString().slice(0, 10);
  const hoyEnCurso = dataset.dias[dataset.dias.length - 1]?.fecha === hoyIso;
  const alertas = [
    sobreMeta
      ? { tono: 'ok' as const, titulo: 'Margen sobre objetivo', detalle: `${pct(k.margen)} frente a ${pct(k.margenObjetivo, 0)} meta · +${(brecha * 100).toFixed(1)} pp`, accion: 'Ver G-01' }
      : { tono: 'danger' as const, titulo: 'Margen bajo objetivo', detalle: `${pct(k.margen)} frente a ${pct(k.margenObjetivo, 0)} meta · ${(Math.abs(brecha) * 100).toFixed(1)} pp por debajo`, accion: 'Ver G-01' },
    { tono: 'warn' as const, titulo: 'Cartera vencida', detalle: `${money(k.vencido)} por cobrar fuera de plazo`, accion: 'Ver cobranza' },
    { tono: 'info' as const, titulo: 'Período abierto', detalle: 'CIF provisional · se congela al cierre del mes', accion: 'Ver CIF' },
  ];

  return (
    <>
      <Encabezado
        titulo="Costos y márgenes"
        descripcion={`${dataset.periodo.etiqueta} · datos ${dataset.periodo.estado === 'PROVISIONAL' ? 'provisionales hasta el cierre del período' : 'definitivos'}${hoyEnCurso ? ' · el día de hoy aún está en curso' : ''}`}
        acciones={
          <>
            <Segmentado
              opciones={[{ id: 'semana', etiqueta: '7 días' }, { id: 'mes', etiqueta: '30 días' }, { id: 'anio', etiqueta: 'Año' }]}
              valor={periodo}
              onChange={setPeriodo}
            />
            <Boton icono="download" onClick={() => exportarExcel('rentabilidad-productos', dataset.topProductos.map((p) => ({ ...p })))}>Excel</Boton>
            <Boton icono="report" onClick={exportarPdf}>PDF</Boton>
          </>
        }
      />

      <div className="grid grid--4">
        <Kpi label="Ventas netas" valor={moneyShort(k.ventasNetas)} delta={pct(k.variacionVentas)} deltaTono="up" nota="vs. mes anterior" icono="up" />
        <Kpi label="Costo de ventas" valor={moneyShort(k.costoVentas)} nota={`${pct(k.costoVentas / k.ventasNetas)} de la venta`} icono="box" />
        <Kpi label="Utilidad bruta" valor={moneyShort(k.utilidadBruta)} delta={`${pct(k.margen)} de margen`} deltaTono="up" nota="sobre ventas netas" icono="spark" />
        <Kpi
          label="Margen de utilidad"
          valor={pct(k.margen)}
          delta={sobreMeta ? `${(brecha * 100).toFixed(1)} pp sobre meta` : `${(Math.abs(brecha) * 100).toFixed(1)} pp bajo meta`}
          deltaTono={sobreMeta ? 'up' : 'down'}
          nota={`objetivo ${pct(k.margenObjetivo, 0)}`}
          icono="chart"
        />
      </div>

      <div className="grid grid--12">
        <Tarjeta className="col-8">
          <TarjetaTitulo
            titulo="Ventas netas frente a costo de lo vendido"
            subtitulo={`${serie.length} días · la distancia entre las líneas es la utilidad bruta`}
            accion={<Insignia tono={k.margen >= k.margenObjetivo ? 'ok' : 'warn'}>{pct(k.margen)} margen</Insignia>}
          />
          <AreaSerie datos={serie} etiquetaA="Ventas netas" etiquetaB="Costo de ventas" alto={260} formato={eje} />
        </Tarjeta>

        <Tarjeta className="col-4">
          <TarjetaTitulo titulo="Participación por categoría" subtitulo="Sobre ventas netas del período" />
          <Dona
            partes={dataset.categorias.map((c) => ({ label: c.nombre, valor: c.ventas }))}
            centro={moneyShort(k.ventasNetas)}
            sub="ventas netas"
          />
        </Tarjeta>

        <Tarjeta className="col-7">
          <TarjetaTitulo titulo="Margen por categoría" subtitulo="Contra el objetivo definido en Maestros · semáforo de márgenes" />
          <BarrasH
            filas={categorias.map((c) => ({ ...c, valor: c.valor }))}
            formato={(n) => pct(n, 1)}
          />
          <div className="semaforo">
            <span><i className="dot dot--ok" /> En objetivo</span>
            <span><i className="dot dot--warn" /> Hasta 5 pp debajo</span>
            <span><i className="dot dot--danger" /> Más de 5 pp debajo</span>
          </div>
          <div className="resumen-margen">
            <div>
              <span>Margen global</span>
              <b>{pct(k.margen)}</b>
            </div>
            <div>
              <span>Objetivo ponderado</span>
              <b>{pct(k.margenObjetivo, 0)}</b>
            </div>
            <div>
              <span>Brecha</span>
              <b className={sobreMeta ? 't-pos' : 't-neg'}>
                {sobreMeta ? '+' : '−'}{(Math.abs(brecha) * 100).toFixed(1)} pp
              </b>
            </div>
            <div>
              <span>Soles en juego</span>
              <b>{moneyShort(k.ventasNetas * Math.abs(brecha))}</b>
            </div>
          </div>
        </Tarjeta>

        <Tarjeta className="col-5">
          <TarjetaTitulo titulo="Alertas del período" subtitulo="Lo que requiere una decisión esta semana" />
          <ul className="alertas">
            {alertas.map((a) => (
              <li key={a.titulo} className={`alerta alerta--${a.tono}`}>
                <span className="alerta__marca" />
                <div>
                  <p className="alerta__titulo">{a.titulo}</p>
                  <p className="alerta__detalle">{a.detalle}</p>
                </div>
                <span className="alerta__accion">{a.accion}</span>
              </li>
            ))}
          </ul>
          <div className="mini-kpis">
            <div>
              <span>Por cobrar</span>
              <b>{money(k.porCobrar)}</b>
              <Progreso valor={k.vencido / Math.max(k.porCobrar, 1)} tono="danger" />
              <small>{money(k.vencido)} vencido</small>
            </div>
            <div>
              <span>Merma valorizada</span>
              <b>{money(k.mermaValorizada)}</b>
              <Progreso valor={k.mermaPct / 0.05} tono="warn" />
              <small>{pct(k.mermaPct)} de la producción</small>
            </div>
          </div>
        </Tarjeta>

        <Tarjeta className="col-12" padding="none">
          <div className="card__head card__head--padded">
            <div>
              <h3 className="card__title">Productos por aporte a la utilidad</h3>
              <p className="card__sub">Ordenados por utilidad del período · {num(k.tickets)} tickets procesados</p>
            </div>
            <Boton variant="ghost" iconoDer="chevron">Ver G-02</Boton>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th>Categoría</th>
                  <th className="t-right">Unidades</th>
                  <th className="t-right">Ventas</th>
                  <th className="t-right">Utilidad</th>
                  <th className="t-right">Margen</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {dataset.topProductos.map((p) => {
                  const s = semaforo(p.margen, p.margenObjetivo);
                  return (
                    <tr key={p.id}>
                      <td><strong>{p.nombre}</strong></td>
                      <td className="t-muted">{dataset.categorias.find((c) => c.id === p.categoria)?.nombre}</td>
                      <td className="t-right">{num(p.unidades)}</td>
                      <td className="t-right">{money(p.ventas)}</td>
                      <td className="t-right">{money(p.utilidad)}</td>
                      <td className="t-right">
                        <Insignia tono={s === 'ok' ? 'ok' : s === 'warn' ? 'warn' : 'danger'}>{pct(p.margen)}</Insignia>
                      </td>
                      <td className="t-right t-muted">{pct(p.margenObjetivo, 0)} obj.</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Tarjeta>
      </div>
    </>
  );
}
