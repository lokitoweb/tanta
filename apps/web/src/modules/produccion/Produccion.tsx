import { useApp } from '@/core/app-state';
import { num, pct } from '@/core/format';
import { Boton, Encabezado, Insignia, Progreso, Tarjeta } from '@/ui/primitives';
import { Icon } from '@/ui/icons';
import { desdeIso } from '@/core/fecha';

const COLUMNAS = [
  { id: 'PENDIENTE', titulo: 'Pendientes', tono: 'neutral' as const },
  { id: 'EN_PROCESO', titulo: 'En proceso', tono: 'warn' as const },
  { id: 'TERMINADA', titulo: 'Terminadas', tono: 'ok' as const },
];

export function Produccion() {
  const { dataset } = useApp();
  const ops = dataset.ops;

  const conteo = (estado: string) => ops.filter((o) => o.estado === estado).length;
  const mermaProm = ops.reduce((s, o) => s + o.mermaEsperada, 0) / Math.max(ops.length, 1);

  return (
    <>
      <Encabezado
        titulo="Tablero de producción"
        descripcion="Órdenes del día · funciona sin conexión: lo que registres se sincroniza al recuperar señal"
        acciones={
          <>
            <Insignia tono="info" punto>Modo tablet</Insignia>
            <Boton variant="primary" icono="plus" size="lg">Nueva orden</Boton>
          </>
        }
      />

      <div className="grid grid--4">
        <Tarjeta className="mini-stat"><span>Pendientes</span><b>{conteo('PENDIENTE')}</b></Tarjeta>
        <Tarjeta className="mini-stat"><span>En proceso</span><b>{conteo('EN_PROCESO')}</b></Tarjeta>
        <Tarjeta className="mini-stat"><span>Terminadas hoy</span><b>{conteo('TERMINADA')}</b></Tarjeta>
        <Tarjeta className="mini-stat"><span>Merma estándar</span><b>{pct(mermaProm)}</b></Tarjeta>
      </div>

      <div className="board">
        {COLUMNAS.map((col) => {
          const items = ops.filter((o) => o.estado === col.id);
          return (
            <section className="board__col" key={col.id}>
              <header className="board__head">
                <h3>{col.titulo}</h3>
                <Insignia tono={col.tono}>{items.length}</Insignia>
              </header>

              <div className="board__list">
                {items.map((op) => (
                  <article className={`opcard opcard--${col.id.toLowerCase()}`} key={op.codigo}>
                    <div className="opcard__top">
                      <span className="opcard__cod">{op.codigo}</span>
                      <span className="opcard__fecha"><Icon name="clock" size={13} /> {desdeIso(op.entrega)}</span>
                    </div>
                    <h4 className="opcard__producto">{op.producto}</h4>
                    <p className="opcard__cantidad">{num(op.cantidad)} <span>unidades</span></p>
                    <Progreso valor={op.avance} tono={col.id === 'TERMINADA' ? 'ok' : 'ink'} />
                    <div className="opcard__foot">
                      <span className="opcard__resp">{op.responsable}</span>
                      {col.id === 'PENDIENTE' && <Boton size="sm" variant="primary" icono="check">Iniciar</Boton>}
                      {col.id === 'EN_PROCESO' && <Boton size="sm" variant="primary" icono="check">Cerrar</Boton>}
                      {col.id === 'TERMINADA' && <Insignia tono="ok" punto>Producto en stock</Insignia>}
                    </div>
                  </article>
                ))}

                {items.length === 0 && (
                  <div className="board__vacio">Sin órdenes en esta columna</div>
                )}
              </div>
            </section>
          );
        })}
      </div>

      <Tarjeta className="aviso-sync">
        <Icon name="sync" size={18} />
        <div>
          <strong>Registro local activo</strong>
          <p>Toda operación se guarda en el dispositivo y se envía con clave de idempotencia. Nunca se pierde un cierre de producción.</p>
        </div>
      </Tarjeta>
    </>
  );
}
