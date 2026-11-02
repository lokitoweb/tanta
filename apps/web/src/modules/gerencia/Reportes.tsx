import { useMemo, useState } from 'react';
import reportesJson from '@/config/reportes.json';
import { useApp } from '@/core/app-state';
import { money, num, pct } from '@/core/format';
import { Boton, Encabezado, Insignia, Tarjeta, Vacio } from '@/ui/primitives';
import { Icon } from '@/ui/icons';

interface Reporte { codigo: string; nombre: string; detalle: string; perfil: string; grupo: string }
const REPORTES = reportesJson.reportes as Reporte[];

export function Reportes() {
  const { dataset } = useApp();
  const [grupo, setGrupo] = useState('todos');
  const grupos = useMemo(() => ['todos', ...Array.from(new Set(REPORTES.map((r) => r.grupo)))], []);
  const lista = REPORTES.filter((r) => grupo === 'todos' || r.grupo === grupo);

  return (
    <>
      <Encabezado
        titulo="Reportes"
        descripcion="Catálogo del Informe Ejecutivo · todos admiten filtros por fecha, categoría y cliente, y exportación"
        acciones={<Boton icono="download">Exportar todo</Boton>}
      />

      <div className="grid grid--4">
        <Tarjeta className="mini-stat"><span>Ventas del período</span><b>{money(dataset.kpis.ventasNetas)}</b></Tarjeta>
        <Tarjeta className="mini-stat"><span>Utilidad bruta</span><b>{money(dataset.kpis.utilidadBruta)}</b></Tarjeta>
        <Tarjeta className="mini-stat"><span>Margen</span><b>{pct(dataset.kpis.margen)}</b></Tarjeta>
        <Tarjeta className="mini-stat"><span>Tickets</span><b>{num(dataset.kpis.tickets)}</b></Tarjeta>
      </div>

      <div className="chips chips--fila">
        {grupos.map((g) => (
          <button key={g} className={`chipfilter ${grupo === g ? 'is-active' : ''}`} onClick={() => setGrupo(g)}>
            {g === 'todos' ? 'Todos' : g}
          </button>
        ))}
      </div>

      <div className="grid grid--3">
        {lista.map((r) => (
          <article className="repcard" key={r.codigo}>
            <header className="repcard__head">
              <span className="repcard__cod">{r.codigo}</span>
              <Insignia tono="neutral">{r.grupo}</Insignia>
            </header>
            <h3 className="repcard__nombre">{r.nombre}</h3>
            <p className="repcard__detalle">{r.detalle}</p>
            <footer className="repcard__foot">
              <span className="t-muted">{r.perfil}</span>
              <button className="repcard__link">
                Ver <Icon name="chevron" size={14} />
              </button>
            </footer>
          </article>
        ))}
      </div>

      {lista.length === 0 && <Vacio titulo="Sin reportes en este grupo" icono="report" />}
    </>
  );
}
