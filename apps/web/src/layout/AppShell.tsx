import { useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useApp } from '@/core/app-state';
import { Avatar, BrandMark } from '@/ui/primitives';
import { Icon, type NombreIcono } from '@/ui/icons';
import { fechaCorta } from '@/core/fecha';
import { regenerarRecuperacion } from '@/core/api';
import { Dialogo } from '@/ui/Dialogo';
import { Boton } from '@/ui/primitives';

export function AppShell() {
  const { rol, sesion, navegacionVisible, cerrarSesion, dataset } = useApp();
  const [menu, setMenu] = useState(false);
  const [menuMovil, setMenuMovil] = useState(false);
  // Preferencia de cada usuario en su navegador; sin almacenamiento, el menú arranca colapsado.
  const [fijo, setFijo] = useState(() => { try { return localStorage.getItem('tanta.menu.fijo') === '1'; } catch { return false; } });
  // Tras colapsar con el botón, el hover no lo reabre hasta que el mouse salga del menú.
  const [forzarCierre, setForzarCierre] = useState(false);
  const alternarFijo = (e: React.MouseEvent<HTMLButtonElement>) => {
    const nuevo = !fijo;
    try { localStorage.setItem('tanta.menu.fijo', nuevo ? '1' : '0'); } catch { /* sin almacenamiento */ }
    setFijo(nuevo);
    if (!nuevo) { setForzarCierre(true); e.currentTarget.blur(); }
  };
  const loc = useLocation();
  const [codigos, setCodigos] = useState<{ lista?: string[]; error?: string } | null>(null);
  const pedirCodigos = async () => {
    try { setCodigos({ lista: await regenerarRecuperacion() }); }
    catch (e) { setCodigos({ error: e instanceof Error ? e.message : 'No se pudieron generar.' }); }
  };

  const { grupo, item } = useMemo(() => {
    for (const g of navegacionVisible) {
      const it = g.items.find((i) => loc.pathname === i.ruta || loc.pathname.startsWith(i.ruta + '/'));
      if (it) return { grupo: g.titulo, item: it };
    }
    return { grupo: '', item: undefined };
  }, [navegacionVisible, loc.pathname]);

  return (
    <div className={`shell ${menuMovil ? 'shell--menu' : ''} ${fijo ? 'shell--fijo' : ''} ${forzarCierre ? 'shell--cerrado' : ''}`}>
      <a href="#contenido" className="saltar-contenido">Saltar al contenido</a>

      <aside className="sidebar" onMouseLeave={() => setForzarCierre(false)}>
        <div className="sidebar__brand">
          <span className="sidebar__logo"><BrandMark variant="dark" size="sm" /></span>
          <button className="sidebar__fijar" onClick={alternarFijo} aria-pressed={fijo}
            aria-label={fijo ? 'Colapsar menú' : 'Mantener menú abierto'} title={fijo ? 'Colapsar menú' : 'Mantener menú abierto'}>
            <Icon name="panel" size={18} />
          </button>
        </div>

        <nav className="sidebar__nav">
          {navegacionVisible.map((g) => (
            <div className="navgroup" key={g.titulo}>
              <p className="navgroup__title">{g.titulo}</p>
              {g.items.map((i) => (
                <NavLink
                  key={i.id}
                  to={i.ruta}
                  end
                  className={({ isActive }) => `navitem ${isActive ? 'is-active' : ''}`}
                  onClick={() => setMenuMovil(false)}
                  title={i.etiqueta}
                >
                  <Icon name={i.icono as NombreIcono} size={18} />
                  <span>{i.etiqueta}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar__foot">
          <div className="perfil">
            <Avatar nombre={sesion.usuario.nombre} />
            <div className="perfil__txt">
              <p className="perfil__nombre">{sesion.usuario.nombre}</p>
              <p className="perfil__rol">{rol.nombre}</p>
            </div>
            <button className="perfil__btn" onClick={() => setMenu((v) => !v)} title="Cuenta">
              <Icon name="chevron" size={15} />
            </button>
          </div>

          {menu && (
            <div className="cambiar-rol">
              <p className="cambiar-rol__titulo">Sesión activa</p>
              <div className="cambiar-rol__dato">
                <Icon name="shield" size={15} />
                <span>{rol.nombre}</span>
              </div>
              <div className="cambiar-rol__dato">
                <Icon name="user" size={15} />
                <span>{sesion.usuario.nombre}</span>
              </div>
              <div className="cambiar-rol__dato">
                <Icon name="check" size={15} />
                <span>{rol.permisos.length} permisos</span>
              </div>
              <button className="cambiar-rol__salir" onClick={() => void pedirCodigos()}>
                <Icon name="shield" size={15} /> Códigos de recuperación
              </button>
              <button className="cambiar-rol__salir" onClick={() => void cerrarSesion()}>
                <Icon name="logout" size={15} /> Cerrar sesión
              </button>
            </div>
          )}
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar__left">
            <button className="topbar__menu" onClick={() => setMenuMovil((v) => !v)} aria-label="Menú">
              <Icon name="menu" size={20} />
            </button>
            <nav className="crumbs" aria-label="Ruta">
              {grupo && <span className="crumbs__item">{grupo}</span>}
              {item && <><Icon name="chevron" size={12} /><span className="crumbs__item crumbs__item--actual">{item.etiqueta}</span></>}
            </nav>
          </div>

          <div className="topbar__right">
            <span className="chip chip--periodo" title="Período de costos">
              <Icon name="clock" size={14} />
              {dataset.periodo.etiqueta}
              <b className="chip__estado">{dataset.periodo.estado === 'PROVISIONAL' ? 'Provisional' : 'Definitivo'}</b>
            </span>
            <span className="chip chip--sync" title="Conectado">
              <Icon name="sync" size={14} />
              <span className="chip__txt">En línea</span>
            </span>
            <button className="iconbtn" aria-label="Notificaciones">
              <Icon name="bell" size={18} />
              <i className="iconbtn__dot" />
            </button>
            <span className="topbar__fecha">{fechaCorta(new Date())}</span>
          </div>
        </header>

        <main className="content" id="contenido" tabIndex={-1}>
          <Outlet />
        </main>

        <Dialogo
          abierto={codigos !== null}
          titulo="Códigos de recuperación"
          descripcion="Sirven para entrar si pierdes el teléfono. Cada uno funciona una sola vez; los anteriores quedan anulados."
          onCerrar={() => setCodigos(null)}
          acciones={<Boton variant="primary" onClick={() => setCodigos(null)}>Ya los guardé</Boton>}
        >
          {codigos?.error && <p className="form__error" role="alert">{codigos.error}</p>}
          {codigos?.lista && <ul className="mfa__lista">{codigos.lista.map((c) => <li key={c} className="mfa__item">{c}</li>)}</ul>}
        </Dialogo>
      </div>
    </div>
  );
}
