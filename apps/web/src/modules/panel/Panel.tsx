import { Link } from 'react-router-dom';
import { useApp } from '@/core/app-state';
import { money, num, pct, semaforo } from '@/core/format';
import { Boton, Encabezado, Insignia, Kpi, Progreso, Tarjeta, TarjetaTitulo } from '@/ui/primitives';
import { Icon, type NombreIcono } from '@/ui/icons';
import { hoyLargo } from '@/core/fecha';

export function Panel() {
  const { dataset, rol, sesion, navegacionVisible } = useApp();
  const k = dataset.kpis;
  const hora = new Date().getHours();
  const saludo = hora < 12 ? 'Buenos días' : hora < 19 ? 'Buenas tardes' : 'Buenas noches';
  const primerNombre = sesion.usuario.nombre.split(' ')[0];

  const accesos = navegacionVisible.flatMap((g) => g.items).filter((i) => i.ruta !== '/panel').slice(0, 4);

  return (
    <>
      <div className="saludo">
        <div>
          <p className="saludo__eyebrow">{hoyLargo()}</p>
          <h1 className="saludo__title">{saludo}, {primerNombre}</h1>
          <p className="saludo__sub">{rol.nombre} · {rol.descripcion}</p>
        </div>
        <div className="saludo__periodo">
          <span>Período</span>
          <b>{dataset.periodo.etiqueta}</b>
          <Insignia tono={dataset.periodo.estado === 'PROVISIONAL' ? 'warn' : 'ok'} punto>
            {dataset.periodo.estado === 'PROVISIONAL' ? 'Provisional' : 'Definitivo'}
          </Insignia>
        </div>
      </div>

      {rol.id === 'SOPORTE' ? (
        <Tarjeta>
          <TarjetaTitulo titulo="Acceso de soporte" subtitulo="Break-glass sin datos de negocio" />
          <p className="t-muted">
            Este perfil no puede ver pedidos, ventas, costos ni clientes. Solo métricas del sistema, registros
            de aplicación y configuración. Cada acceso requiere aprobación del Gerente y queda auditado.
          </p>
        </Tarjeta>
      ) : (
        <>
          <div className="grid grid--4">
            {(rol.id === 'GERENTE' || rol.id === 'ADMINISTRADOR') && (
              <>
                <Kpi label="Ventas netas" valor={money(k.ventasNetas)} delta={pct(k.variacionVentas)} deltaTono="up" nota="30 días" icono="up" />
                <Kpi label="Utilidad bruta" valor={money(k.utilidadBruta)} nota={pct(k.margen) + ' de margen'} icono="spark" />
                <Kpi label="Por cobrar" valor={money(k.porCobrar)} nota={money(k.vencido) + ' vencido'} icono="wallet" />
                <Kpi label="Productos activos" valor={num(dataset.productos.length)} nota={`${dataset.recetas.length} recetas vigentes`} icono="bread" />
              </>
            )}
            {rol.id === 'PRODUCCION' && (
              <>
                <Kpi label="Órdenes para hoy" valor={num(dataset.ops.filter((o) => o.estado !== 'TERMINADA').length)} nota="pendientes y en proceso" icono="oven" />
                <Kpi label="Terminadas" valor={num(dataset.ops.filter((o) => o.estado === 'TERMINADA').length)} nota="del turno" icono="check" />
                <Kpi label="Merma estándar" valor={pct(0.03)} nota="objetivo del período" icono="alert" />
                <Kpi label="Insumos bajo mínimo" valor={num(dataset.insumos.filter((i) => i.estado === 'BAJO_MINIMO').length)} nota="avisar a almacén" icono="sack" />
              </>
            )}
            {rol.id === 'ALMACEN' && (
              <>
                <Kpi label="Insumos" valor={num(dataset.insumos.length)} nota={`${dataset.insumos.filter((i) => i.estado === 'BAJO_MINIMO').length} bajo mínimo`} icono="sack" />
                <Kpi label="Bajas del día" valor={num(dataset.movimientos.filter((m) => m.cantidad < 0).length)} nota="kárdex inmutable" icono="ledger" />
                <Kpi label="Valor del stock" valor={money(dataset.insumos.reduce((s, i) => s + i.valorizado, 0))} nota="al CPP" icono="box" />
                <Kpi label="Merma valorizada" valor={money(k.mermaValorizada)} nota={pct(k.mermaPct)} icono="alert" />
              </>
            )}
            {rol.id === 'VENDEDOR' && (
              <>
                <Kpi label="Pedidos por despachar" valor={num(dataset.pedidos.filter((p) => p.estado === 'LISTO').length)} nota="confirmar entrega" icono="truck" />
                <Kpi label="En producción" valor={num(dataset.pedidos.filter((p) => p.estado === 'EN_PRODUCCION').length)} nota="seguimiento" icono="oven" />
                <Kpi label="Cartera" valor={money(k.porCobrar)} nota={money(k.vencido) + ' vencido'} icono="wallet" />
                <Kpi label="Clientes activos" valor={num(dataset.clientes.length)} nota="con y sin deuda" icono="user" />
              </>
            )}
            {rol.id === 'CLIENTE' && (() => {
              const mios = dataset.misPedidos ?? [];
              const ultimo = mios[0];
              return (
                <>
                  <Kpi label="Mi saldo" valor={money(dataset.miSaldo ?? 0)} nota="cuentas por pagar" icono="wallet" />
                  <Kpi label="Mis pedidos" valor={String(mios.length)} nota="últimos registrados" icono="clipboard" />
                  <Kpi
                    label="Último pedido"
                    valor={ultimo ? ultimo.codigo.replace('PED-2026-', '#') : '—'}
                    nota={ultimo ? money(ultimo.total) : 'sin pedidos'}
                    icono="bread"
                  />
                  <Kpi
                    label="Entrega"
                    valor={ultimo ? ultimo.fechaEntrega : '—'}
                    nota={ultimo ? ultimo.estado.toLowerCase().replace('_', ' ') : ''}
                    icono="truck"
                  />
                </>
              );
            })()}
          </div>

          <div className="grid grid--12">
            <Tarjeta className="col-7" padding="none">
              <div className="card__head card__head--padded">
                <div>
                  <h3 className="card__title">
                    {rol.id === 'PRODUCCION' ? 'Órdenes de hoy' : rol.id === 'ALMACEN' ? 'Stock crítico' : rol.id === 'VENDEDOR' ? 'Despachos pendientes' : 'Productos por margen'}
                  </h3>
                  <p className="card__sub">Lo que requiere tu atención ahora</p>
                </div>
                <Boton variant="ghost" iconoDer="chevron">Ver todo</Boton>
              </div>

              {rol.id === 'ALMACEN' ? (
                <ul className="listado">
                  {dataset.insumos.filter((i) => i.estado === 'BAJO_MINIMO').concat(dataset.insumos.slice(0, 3)).slice(0, 5).map((i) => (
                    <li key={i.id}>
                      <span className="listado__icono"><Icon name="sack" size={16} /></span>
                      <div className="listado__txt">
                        <strong>{i.nombre}</strong>
                        <span>{num(i.stock)} {i.unidad} · mínimo {num(i.minimo)}</span>
                      </div>
                      <Insignia tono={i.estado === 'BAJO_MINIMO' ? 'danger' : 'ok'} punto>
                        {i.estado === 'BAJO_MINIMO' ? 'Reponer' : 'OK'}
                      </Insignia>
                    </li>
                  ))}
                </ul>
              ) : rol.id === 'PRODUCCION' ? (
                <ul className="listado">
                  {dataset.ops.filter((o) => o.estado !== 'TERMINADA').map((o) => (
                    <li key={o.codigo}>
                      <span className="listado__icono"><Icon name="oven" size={16} /></span>
                      <div className="listado__txt">
                        <strong>{o.producto}</strong>
                        <span>{num(o.cantidad)} u · {o.responsable}</span>
                      </div>
                      <div className="listado__prog"><Progreso valor={o.avance} tono={o.estado === 'EN_PROCESO' ? 'warn' : 'ink'} /></div>
                    </li>
                  ))}
                </ul>
              ) : rol.id === 'VENDEDOR' ? (
                <ul className="listado">
                  {dataset.pedidos.filter((p) => ['LISTO', 'DESPACHADO', 'EN_PRODUCCION'].includes(p.estado)).map((p) => (
                    <li key={p.codigo}>
                      <span className="listado__icono"><Icon name="truck" size={16} /></span>
                      <div className="listado__txt">
                        <strong>{p.cliente}</strong>
                        <span>{p.codigo} · {money(p.total)}</span>
                      </div>
                      <Insignia tono={p.estado === 'LISTO' ? 'info' : 'warn'} punto>{p.estado === 'LISTO' ? 'Listo' : 'En producción'}</Insignia>
                    </li>
                  ))}
                </ul>
              ) : (
                <ul className="listado">
                  {dataset.topProductos.slice(0, 5).map((p) => {
                    const s = semaforo(p.margen, p.margenObjetivo);
                    return (
                      <li key={p.id}>
                        <span className="listado__icono"><Icon name="bread" size={16} /></span>
                        <div className="listado__txt">
                          <strong>{p.nombre}</strong>
                          <span>{money(p.ventas)} · {num(p.unidades)} u</span>
                        </div>
                        <Insignia tono={s === 'ok' ? 'ok' : s === 'warn' ? 'warn' : 'danger'}>{pct(p.margen)}</Insignia>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Tarjeta>

            <div className="col-5 apilar">
              <Tarjeta>
                <TarjetaTitulo titulo="Accesos rápidos" />
                <div className="accesos">
                  {accesos.map((a) => (
                    <Link key={a.id} to={a.ruta} className="acceso-card">
                      <Icon name={a.icono as NombreIcono} size={18} />
                      <span>{a.etiqueta}</span>
                      <Icon name="chevron" size={14} />
                    </Link>
                  ))}
                </div>
              </Tarjeta>

              <Tarjeta>
                <TarjetaTitulo titulo="Mi sesión" />
                <dl className="datos">
                  <div><dt>Perfil</dt><dd>{rol.nombre}</dd></div>
                  <div><dt>Acceso</dt><dd>{rol.perfil === 'web' ? 'Navegador' : rol.perfil === 'tablet' ? 'Tablet de planta' : 'App móvil'}</dd></div>
                  <div><dt>Permisos</dt><dd>{rol.permisos.length}</dd></div>
                  <div><dt>Última sincronización</dt><dd>hace 2 min</dd></div>
                </dl>
              </Tarjeta>
            </div>
          </div>
        </>
      )}
    </>
  );
}
