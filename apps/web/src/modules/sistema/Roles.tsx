import { useEffect, useMemo, useState } from 'react';
import { api } from '@/core/api';
import { useApp } from '@/core/app-state';
import { Boton, Encabezado, Insignia, Tarjeta } from '@/ui/primitives';

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
      <Encabezado titulo="Roles y permisos" descripcion="Define qué puede ver y hacer cada perfil. El menú de la web y de la app se arma con esto; el servidor lo hace cumplir." />
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
