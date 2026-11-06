import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '@/core/app-state';
import { money, num, pct, semaforo } from '@/core/format';
import { Boton, Encabezado, Insignia, Kpi, Progreso, Tarjeta, TarjetaTitulo } from '@/ui/primitives';
import { Icon, type NombreIcono } from '@/ui/icons';
import { useState } from 'react';
import { api } from '@/core/api';
import { useEnVivo, aQuery, rango as rangoDias } from '@/ui/Filtros';
import { SelectorFechas, etiquetaRango, type Rango } from '@/ui/SelectorFechas';

export function Panel() {
  const { dataset, rol, sesion, navegacionVisible, puede } = useApp();
  const navegar = useNavigate();
  const hoyIso = new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
  // Merma estándar real: promedio de las recetas vigentes (antes era un 3 % fijo).
  const mermaRecetas = dataset.recetas.length ? dataset.recetas.reduce((s, r) => s + r.mermaEstandar, 0) / dataset.recetas.length : 0;
  const bajasHoy = dataset.movimientos.filter((m) => m.cantidad < 0 && m.fecha.startsWith(hoyIso)).length;
  // La vista sale de los permisos, no del nombre del rol: un rol creado desde
  // Roles y permisos (o el Superadmin) recibe el panel que le corresponde.
  const vista = puede('costos.ver') ? 'GERENCIA' : puede('produccion.ejecutar') ? 'PRODUCCION'
    : puede('inventario.mover') ? 'ALMACEN' : puede('cobranza.ver') ? 'VENDEDOR' : puede('catalogo.ver') ? 'CLIENTE' : 'SOPORTE';
  const k = dataset.kpis;
  // Ventas y utilidad del rango elegido, recalculadas cada 30 s (solo perfiles con tablero).
  const conTablero = puede('dashboard.ver');
  const [rango, setRango] = useState<Rango>(() => rangoDias(30));
  const [res, setRes] = useState<Record<string, { actual: number; variacion: number }> | null>(null);
  const hace = useEnVivo(async () => {
    if (!conTablero) return;
    const r = await api<{ filas: Array<{ indicador: string; actual: number; variacion: number }> }>(`/reportes/G-01${aQuery(rango)}`);
    setRes(Object.fromEntries(r.filas.map((x) => [x.indicador, x])));
  }, [rango.desde, rango.hasta, conTablero], 30);
  const ventas = res?.['Ventas netas'] ?? { actual: k.ventasNetas, variacion: k.variacionVentas };
  const utilidad = res?.['Utilidad bruta']?.actual ?? k.utilidadBruta;
  const margen = res?.['Margen bruto %']?.actual ?? k.margen;
  const hora = new Date().getHours();
  const saludo = hora < 12 ? 'Buenos días' : hora < 19 ? 'Buenas tardes' : 'Buenas noches';
  const primerNombre = sesion.usuario.nombre.split(' ')[0];

  const accesos = navegacionVisible.flatMap((g) => g.items).filter((i) => i.ruta !== '/panel').slice(0, 4);

  return (
    <>
      <div className="saludo">
        <div>
          <h1 className="saludo__title">{saludo}, {primerNombre}</h1>
          <p className="saludo__sub">{rol.nombre} · {rol.descripcion}</p>
        </div>
        {conTablero && (
          <div className="saludo__acciones">
            <span className="en-vivo" title="Se actualiza solo cada 30 segundos"><i />En vivo · {hace === null ? 'cargando' : hace < 5 ? 'recién actualizado' : `hace ${hace} s`}</span>
            <SelectorFechas valor={rango} onChange={setRango} />
          </div>
        )}
      </div>

      {vista === 'SOPORTE' ? (
        <Tarjeta>
          <TarjetaTitulo titulo="Acceso de soporte" subtitulo="Break-glass sin datos de negocio" />
          <p className="t-muted">
            Este perfil no puede ver pedidos, ventas, costos ni clientes. Solo métricas del sistema, registros
            de aplicación y configuración. Cada acceso requiere aprobación del Gerente y queda auditado.
          </p>
        </Tarjeta>
      ) : (
        <>
          <div className="grid grid--auto">
            {vista === 'GERENCIA' && (
              <>
                <Kpi label="Ventas netas" valor={money(ventas.actual)} delta={pct(ventas.variacion)} deltaTono={ventas.variacion >= 0 ? 'up' : 'down'} nota={`${etiquetaRango(rango).toLowerCase()} · vs. período anterior`} icono="up" />
                <Kpi label="Utilidad bruta" valor={money(utilidad)} nota={pct(margen) + ' de margen'} icono="spark" />
                <Kpi label="Por cobrar" valor={money(k.porCobrar)} nota={money(k.vencido) + ' vencido'} icono="wallet" />
                <Kpi label="Productos activos" valor={num(dataset.productos.length)} nota={`${dataset.recetas.length} recetas vigentes`} icono="bread" />
              </>
            )}
            {vista === 'PRODUCCION' && (
              <>
                <Kpi label="Órdenes abiertas" valor={num(dataset.ops.filter((o) => o.estado !== 'TERMINADA').length)} nota="pendientes y en proceso" icono="oven" />
                <Kpi label="Terminadas" valor={num(dataset.ops.filter((o) => o.estado === 'TERMINADA').length)} nota="del turno" icono="check" />
                <Kpi label="Merma estándar" valor={pct(mermaRecetas)} nota="promedio de las recetas vigentes" icono="alert" />
                <Kpi label="Insumos bajo mínimo" valor={num(dataset.insumos.filter((i) => i.estado === 'BAJO_MINIMO').length)} nota="avisar a almacén" icono="sack" />
              </>
            )}
            {vista === 'ALMACEN' && (
              <>
                <Kpi label="Insumos" valor={num(dataset.insumos.length)} nota={`${dataset.insumos.filter((i) => i.estado === 'BAJO_MINIMO').length} bajo mínimo`} icono="sack" />
                <Kpi label="Salidas de hoy" valor={num(bajasHoy)} nota="consumos, ventas y mermas" icono="ledger" />
                <Kpi label="Valor del stock" valor={money(dataset.insumos.reduce((s, i) => s + i.valorizado, 0))} nota="al CPP" icono="box" />
                <Kpi label="Merma valorizada" valor={money(k.mermaValorizada)} nota={pct(k.mermaPct)} icono="alert" />
              </>
            )}
            {vista === 'VENDEDOR' && (
              <>
                <Kpi label="Pedidos por despachar" valor={num(dataset.pedidos.filter((p) => p.estado === 'LISTO').length)} nota="confirmar entrega" icono="truck" />
                <Kpi label="En producción" valor={num(dataset.pedidos.filter((p) => p.estado === 'EN_PRODUCCION').length)} nota="seguimiento" icono="oven" />
                <Kpi label="Cartera" valor={money(k.porCobrar)} nota={money(k.vencido) + ' vencido'} icono="wallet" />
                <Kpi label="Clientes activos" valor={num(dataset.clientes.length)} nota="con y sin deuda" icono="user" />
              </>
            )}
            {vista === 'CLIENTE' && (() => {
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
            {vista !== 'CLIENTE' && <Tarjeta className="col-7" padding="none">
              <div className="card__head card__head--padded">
                <div>
                  <h3 className="card__title">
                    {vista === 'PRODUCCION' ? 'Órdenes de hoy' : vista === 'ALMACEN' ? 'Stock crítico' : vista === 'VENDEDOR' ? 'Despachos pendientes' : 'Productos por margen'}
                  </h3>
                  <p className="card__sub">Lo que requiere tu atención ahora</p>
                </div>
                <Boton variant="ghost" iconoDer="chevron" onClick={() => navegar(vista === 'PRODUCCION' ? '/produccion' : vista === 'ALMACEN' ? '/almacen' : vista === 'VENDEDOR' ? '/ventas/pedidos' : '/gerencia/dashboard')}>Ver todo</Boton>
              </div>

              {vista === 'ALMACEN' ? (
                <ul className="listado">
                  {dataset.insumos.filter((i) => i.estado === 'BAJO_MINIMO').slice(0, 5).map((i) => (
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
              ) : vista === 'PRODUCCION' ? (
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
              ) : vista === 'VENDEDOR' ? (
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
            </Tarjeta>}

            <div className={`${vista === 'CLIENTE' ? 'col-12' : 'col-5'} apilar`}>
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
