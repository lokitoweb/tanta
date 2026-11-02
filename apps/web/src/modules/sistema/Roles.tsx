import { useEffect, useMemo, useState } from 'react';
import { api } from '@/core/api';
import { useApp } from '@/core/app-state';
import { Boton, Encabezado, Insignia, Tarjeta } from '@/ui/primitives';
import { Dialogo } from '@/ui/Dialogo';

const BASE = new Set(['SUPERADMIN', 'GERENTE', 'ADMINISTRADOR', 'PRODUCCION', 'ALMACEN', 'VENDEDOR', 'CLIENTE', 'SOPORTE']);

interface Rol { id: string; nombre: string; descripcion: string; perfil: string }
interface Permiso { id: string; grupo: string; descripcion: string }

/** Matriz rol × permiso. Lo que se marca aquí define el menú y lo que el API deja hacer, al instante. */
export function Roles() {
  const { recargarSesion, sesion } = useApp();
  const [roles, setRoles] = useState<Rol[]>([]);
  const [permisos, setPermisos] = useState<Permiso[]>([]);
  const [asignados, setAsignados] = useState<Set<string>>(new Set());
  const [rolId, setRolId] = useState<string>('');
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger'; texto: string } | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [nuevo, setNuevo] = useState<{ nombre: string; descripcion: string; perfil: string } | null>(null);
  const crearRol = async () => {
    setGuardando(true);
    setAviso(null);
    try {
      const r = await api<{ id: string }>('/sistema/roles', { method: 'POST', body: nuevo });
      setNuevo(null);
      await cargar();
      setRolId(r.id);
      setAviso({ tono: 'ok', texto: 'Rol creado. Marca sus permisos y guarda; luego asígnalo en Usuarios y roles.' });
    } catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo crear.' }); }
    finally { setGuardando(false); }
  };
  const eliminarRol = async () => {
    if (!window.confirm('¿Eliminar este rol? Solo se puede si ningún usuario lo tiene.')) return;
    try { await api(`/sistema/roles/${rolId}`, { method: 'DELETE' }); setRolId(''); await cargar(); setAviso({ tono: 'ok', texto: 'Rol eliminado.' }); }
    catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo eliminar.' }); }
  };

  const cargar = async () => {
    const d = await api<{ roles: Rol[]; permisos: Permiso[]; asignados: string[] }>('/sistema/roles');
    setRoles(d.roles);
    setPermisos(d.permisos);
    setAsignados(new Set(d.asignados));
    setRolId((r) => r || d.roles.find((x) => x.id !== 'SUPERADMIN')?.id || '');
  };
  useEffect(() => { void cargar(); }, []);

  const grupos = useMemo(() => {
    const m = new Map<string, Permiso[]>();
    for (const p of permisos) m.set(p.grupo, [...(m.get(p.grupo) ?? []), p]);
    return [...m.entries()];
  }, [permisos]);

  const protegido = rolId === 'SUPERADMIN';
  const tiene = (p: string) => asignados.has(`${rolId}:${p}`);
  const alternar = (p: string) => setAsignados((s) => {
    const n = new Set(s);
    const k = `${rolId}:${p}`;
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });

  const guardar = async () => {
    setGuardando(true);
    setAviso(null);
    try {
      const lista = permisos.filter((p) => tiene(p.id)).map((p) => p.id);
      await api(`/sistema/roles/${rolId}/permisos`, { method: 'PUT', body: { permisos: lista } });
      await cargar();
      if (sesion.rolId === rolId) await recargarSesion();
      setAviso({ tono: 'ok', texto: 'Permisos guardados. Los usuarios de este rol ven el cambio en su próxima acción.' });
    } catch (e) {
      setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo guardar.' });
    } finally {
      setGuardando(false);
    }
  };

  const rol = roles.find((r) => r.id === rolId);

  return (
    <>
      <Encabezado titulo="Roles y permisos" descripcion="Define qué puede ver y hacer cada perfil. El menú de la web y de la app se arma con esto; el servidor lo hace cumplir."
        acciones={<Boton variant="primary" icono="plus" onClick={() => setNuevo({ nombre: '', descripcion: '', perfil: 'web' })}>Nuevo rol</Boton>} />
      <Dialogo abierto={nuevo !== null} titulo="Nuevo rol" descripcion="Nace solo con el panel de inicio; luego marcas sus permisos en la matriz."
        onCerrar={() => setNuevo(null)}
        acciones={<><Boton onClick={() => setNuevo(null)}>Cancelar</Boton><Boton variant="primary" disabled={guardando || (nuevo?.nombre.trim().length ?? 0) < 3} onClick={() => void crearRol()}>Crear rol</Boton></>}>
        {nuevo && (
          <div className="form form--2col form--dialogo">
            <label className="field"><span className="field__label">Nombre</span><input className="field__input" maxLength={40} placeholder="Cajero, Repartidor…" value={nuevo.nombre} onChange={(e) => setNuevo({ ...nuevo, nombre: e.target.value })} /></label>
            <label className="field"><span className="field__label">Dónde trabaja</span>
              <select className="field__input" value={nuevo.perfil} onChange={(e) => setNuevo({ ...nuevo, perfil: e.target.value })}><option value="web">Web</option><option value="app">App móvil</option><option value="tablet">Tablet</option></select></label>
            <label className="field field--ancho"><span className="field__label">Descripción</span><input className="field__input" maxLength={120} value={nuevo.descripcion} onChange={(e) => setNuevo({ ...nuevo, descripcion: e.target.value })} /></label>
          </div>
        )}
      </Dialogo>
      {aviso && <div className={`aviso aviso--${aviso.tono}`} role="status"><span className="aviso__icono">{aviso.tono === 'ok' ? '✓' : '!'}</span><div><p>{aviso.texto}</p></div></div>}

      <div className="grid grid--12">
        <Tarjeta className="col-4" padding="none">
          <div className="card__head card__head--padded"><div><h3 className="card__title">Roles</h3><p className="card__sub">{roles.length} perfiles</p></div></div>
          <ul className="lista-roles">
            {roles.map((r) => (
              <li key={r.id}>
                <button className={`lista-roles__item ${r.id === rolId ? 'is-active' : ''}`} onClick={() => { setRolId(r.id); setAviso(null); }}>
                  <strong>{r.nombre}</strong>
                  <span>{permisos.filter((p) => asignados.has(`${r.id}:${p.id}`)).length} permisos · {r.perfil}</span>
                </button>
              </li>
            ))}
          </ul>
        </Tarjeta>

        <Tarjeta className="col-8" padding="none">
          <div className="card__head card__head--padded">
            <div><h3 className="card__title">{rol?.nombre}</h3><p className="card__sub">{rol?.descripcion}</p></div>
            {!BASE.has(rolId) && rolId && <Boton variant="ghost" onClick={() => void eliminarRol()}>Eliminar rol</Boton>}
            {protegido ? <Insignia tono="info">Tiene todo · protegido</Insignia>
              : <Boton variant="primary" onClick={() => void guardar()} disabled={guardando}>{guardando ? 'Guardando…' : 'Guardar permisos'}</Boton>}
          </div>
          <div className="permisos">
            {grupos.map(([grupo, ps]) => (
              <fieldset key={grupo} className="permisos__grupo" disabled={protegido}>
                <legend>{grupo}</legend>
                {ps.map((p) => (
                  <label key={p.id} className="check check--bloque">
                    <input type="checkbox" checked={protegido || tiene(p.id)} onChange={() => alternar(p.id)} />
                    <span><strong>{p.descripcion}</strong><code>{p.id}</code></span>
                  </label>
                ))}
              </fieldset>
            ))}
          </div>
        </Tarjeta>
      </div>
    </>
  );
}
