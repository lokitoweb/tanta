import { useEffect, useState } from 'react';
import { api, useClaveMinima } from '@/core/api';
import { useApp } from '@/core/app-state';
import { Encabezado, Insignia, Tarjeta, TarjetaTitulo, Boton } from '@/ui/primitives';
import { Tabla, type Columna } from '@/ui/Tabla';
import { Icon } from '@/ui/icons';
import { fechaHora } from '@/core/format';
import { Dialogo } from '@/ui/Dialogo';
import type { Usuario } from '@/core/types';


export function Usuarios() {
  const { dataset, sesion, refrescarDatos, puede } = useApp();
  // Matriz de permisos: el Gerente consulta; solo quien gestiona crea, cambia rol o bloquea.
  const gestiona = puede('usuarios.gestionar');
  const [usuarios, setUsuarios] = useState<Usuario[]>(dataset.usuarios ?? []);
  const [nuevo, setNuevo] = useState(false);
  const claveMin = useClaveMinima();
  const [form, setForm] = useState({ nombre: '', usuario: '', clave: '', rol: 'VENDEDOR', clienteId: '' });
  // Roles y clientes vienen de la base: un rol creado en «Roles y permisos» aparece aquí al instante.
  const [roles, setRoles] = useState<Array<{ id: string; nombre: string }>>([]);
  const [clientes, setClientes] = useState<Array<{ id: string; nombre: string }>>([]);
  type Edicion = { u: Usuario; nombre: string; usuario: string; rol: string; clienteId: string; clave: string };
  const [edicion, setEdicion] = useState<Edicion | null>(null);
  const editar = (u: Usuario) => { setError(null); setEdicion({ u, nombre: u.nombre, usuario: u.usuario, rol: u.rolId ?? 'VENDEDOR', clienteId: u.clienteId ?? '', clave: '' }); };
  const [opcionesError, setOpcionesError] = useState<string | null>(null);
  const cargarOpciones = () => {
    if (!gestiona) return;
    setOpcionesError(null);
    const falla = (que: string) => (e: Error) => setOpcionesError(`No se pudieron cargar ${que}: ${e.message}`);
    api<Array<{ id: string; nombre: string }>>('/roles-asignables').then(setRoles).catch(falla('los roles'));
    api<{ clientes: Array<{ id: string; nombre: string }> }>('/reportes-filtros').then((r) => setClientes(r.clientes)).catch(falla('los clientes'));
  };
  useEffect(cargarOpciones, []);
  // Guarda solo lo que cambió: datos, rol (no el propio) y clave (si se escribió una nueva).
  const guardarEdicion = async () => {
    if (!edicion) return;
    const { u, nombre, usuario, rol, clienteId, clave } = edicion;
    setGuardando(true);
    setError(null);
    try {
      if (nombre !== u.nombre || usuario !== u.usuario) await api(`/usuarios/${u.id}`, { method: 'PATCH', body: { nombre, usuario } });
      if (u.id !== sesion.usuario.id && (rol !== u.rolId || (rol === 'CLIENTE' && clienteId !== (u.clienteId ?? '')))) {
        await api(`/usuarios/${u.id}/rol`, { method: 'PATCH', body: { rol, ...(rol === 'CLIENTE' ? { clienteId } : {}) } });
      }
      if (clave) await api(`/usuarios/${u.id}/clave`, { method: 'PATCH', body: { clave } });
      setEdicion(null);
      await refrescarDatos();
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo guardar el usuario.'); await refrescarDatos(); }
    finally { setGuardando(false); }
  };
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => { setUsuarios(dataset.usuarios ?? []); }, [dataset.usuarios]);

  const crear = async () => {
    setGuardando(true);
    setError(null);
    try {
      await api('/usuarios', { method: 'POST', body: { ...form, clienteId: form.rol === 'CLIENTE' ? form.clienteId : undefined } });
      setNuevo(false);
      setForm({ nombre: '', usuario: '', clave: '', rol: 'VENDEDOR', clienteId: '' });
      await refrescarDatos();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo crear el usuario.');
    } finally {
      setGuardando(false);
    }
  };

  const cambiarEstado = async (u: Usuario) => {
    const nuevoEstado = u.estado === 'ACTIVO' ? 'BLOQUEADO' : 'ACTIVO';
    setError(null);
    try {
      await api(`/usuarios/${u.id}/estado`, { method: 'PATCH', body: { estado: nuevoEstado } });
      setUsuarios((prev) => prev.map((x) => (x.id === u.id ? { ...x, estado: nuevoEstado } : x)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cambiar el estado.');
    }
  };

  const columnas: Array<Columna<Usuario>> = [
    {
      key: 'nombre', header: 'Usuario',
      render: (u) => (
        <div className="celda-doble">
          <strong>{u.nombre}{u.id === sesion.usuario.id ? ' · tú' : ''}</strong>
          <span>@{u.usuario}</span>
        </div>
      ),
    },
    { key: 'rol', header: 'Rol', render: (u) => <Insignia tono="neutral">{u.rol}</Insignia> },
    { key: 'ultimoAcceso', header: 'Último acceso', render: (u) => <span className="t-muted">{u.ultimoAcceso ? fechaHora(u.ultimoAcceso) : 'nunca'}</span> },
    {
      key: 'estado', header: 'Estado', align: 'right',
      render: (u) => u.estado === 'ACTIVO'
        ? <Insignia tono="ok" punto>Activo</Insignia>
        : <Insignia tono="danger" punto>Bloqueado</Insignia>,
    },
    {
      key: 'acciones', header: '', align: 'right',
      render: (u) => gestiona && (
        <span className="acciones-fila">
        <Boton size="sm" variant="ghost" onClick={() => editar(u)}>Editar</Boton>
        <Boton
          size="sm"
          variant={u.estado === 'ACTIVO' ? 'ghost' : 'secondary'}
          onClick={() => void cambiarEstado(u)}
          disabled={u.id === sesion.usuario.id}
          title={u.id === sesion.usuario.id ? 'No puedes bloquear tu propia cuenta' : undefined}
        >
          {u.estado === 'ACTIVO' ? 'Bloquear' : 'Reactivar'}
        </Boton>
        </span>
      ),
    },
  ];

  return (
    <>
      <Encabezado
        titulo="Usuarios y roles"
        descripcion="El rol define qué ve cada persona · el costo y el margen solo los ve Gerencia y Administración"
        acciones={gestiona && <Boton variant="primary" icono="plus" onClick={() => { setError(null); setNuevo(true); }}>Nuevo usuario</Boton>}
      />

      {error && <div className="aviso aviso--danger"><span className="aviso__icono">!</span><div><strong>Error</strong><p>{error}</p></div></div>}
      {opcionesError && <div className="aviso aviso--danger" role="status"><span className="aviso__icono">!</span><div><p>{opcionesError}. No podrás asignar roles hasta que carguen.</p></div>
        <Boton size="sm" onClick={cargarOpciones}>Reintentar</Boton></div>}

      <div className="grid grid--12">
        <Tarjeta className="col-8" padding="none">
          <div className="card__head card__head--padded">
            <div>
              <h3 className="card__title">Cuentas</h3>
              <p className="card__sub">{usuarios.length} usuarios · al bloquear se revocan sus sesiones</p>
            </div>
          </div>
          <Tabla columnas={columnas} filas={usuarios} clave={(u) => u.id} buscar="Buscar por nombre, usuario o rol…" />
        </Tarjeta>

        <Tarjeta className="col-4">
          <TarjetaTitulo titulo="Perfiles del sistema" subtitulo="Permisos por rol, no por persona" />
          <ul className="roleslista">
            {Object.entries(
              usuarios.reduce<Record<string, number>>((acc, u) => {
                acc[u.rol] = (acc[u.rol] ?? 0) + 1;
                return acc;
              }, {}),
            ).map(([nombre, cantidad]) => (
              <li key={nombre}>
                <span className="roleslista__icono"><Icon name="shield" size={16} /></span>
                <div>
                  <p className="roleslista__nombre">{nombre}</p>
                  <p className="roleslista__desc">{cantidad} {cantidad === 1 ? 'usuario' : 'usuarios'}</p>
                </div>
              </li>
            ))}
          </ul>
        </Tarjeta>
      </div>

      <Dialogo
        abierto={nuevo}
        titulo="Nuevo usuario"
        descripcion="La contraseña se guarda cifrada con Argon2id. Pídele a la persona que la cambie en Mi perfil al ingresar."
        onCerrar={() => setNuevo(false)}
        acciones={
          <>
            <Boton onClick={() => setNuevo(false)}>Cancelar</Boton>
            <Boton variant="primary" onClick={() => void crear()} disabled={guardando}>
              {guardando ? 'Creando…' : 'Crear usuario'}
            </Boton>
          </>
        }
      >
        <div className="form form--compacto">
          <label className="field">
            <span className="field__label">Nombre completo</span>
            <input className="field__input" value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} />
          </label>
          <label className="field">
            <span className="field__label">Usuario</span>
            <input className="field__input" value={form.usuario} onChange={(e) => setForm({ ...form, usuario: e.target.value.toLowerCase() })} placeholder="nombre.apellido" />
          </label>
          <label className="field">
            <span className="field__label">Contraseña inicial</span>
            <input className="field__input" type="text" value={form.clave} onChange={(e) => setForm({ ...form, clave: e.target.value })} placeholder={`mínimo ${claveMin} caracteres`} />
          </label>
          <label className="field">
            <span className="field__label">Rol</span>
            <select className="field__input" value={form.rol} onChange={(e) => setForm({ ...form, rol: e.target.value })}>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.nombre}</option>)}
            </select>
          </label>
          {form.rol === 'CLIENTE' && (
            <label className="field">
              <span className="field__label">Ficha de cliente</span>
              <select className="field__input" value={form.clienteId} onChange={(e) => setForm({ ...form, clienteId: e.target.value })}>
                <option value="">Elegir…</option>{clientes.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </select>
            </label>
          )}
        </div>
      </Dialogo>
      <Dialogo abierto={edicion !== null} titulo={`Editar usuario · ${edicion?.u.nombre ?? ''}`}
        descripcion="Si cambias el rol o la contraseña, sus sesiones abiertas se cierran y vuelve a ingresar."
        onCerrar={() => setEdicion(null)}
        acciones={<><Boton onClick={() => setEdicion(null)}>Cancelar</Boton>
          <Boton variant="primary" disabled={guardando || (edicion?.rol === 'CLIENTE' && !edicion.clienteId)} onClick={() => void guardarEdicion()}>{guardando ? 'Guardando…' : 'Guardar cambios'}</Boton></>}>
        {edicion && (
          <div className="form form--compacto">
            {error && <p className="form__error" role="alert">{error}</p>}
            <label className="field"><span className="field__label">Nombre completo</span>
              <input className="field__input" value={edicion.nombre} onChange={(e) => setEdicion({ ...edicion, nombre: e.target.value })} /></label>
            <label className="field"><span className="field__label">Usuario</span>
              <input className="field__input" value={edicion.usuario} onChange={(e) => setEdicion({ ...edicion, usuario: e.target.value.toLowerCase() })} /></label>
            <label className="field"><span className="field__label">Rol</span>
              <select className="field__input" value={edicion.rol} disabled={edicion.u.id === sesion.usuario.id} title={edicion.u.id === sesion.usuario.id ? 'No puedes cambiar tu propio rol' : undefined}
                onChange={(e) => setEdicion({ ...edicion, rol: e.target.value })}>
                {!roles.some((r) => r.id === edicion.rol) && <option value={edicion.rol}>{edicion.u.rol}</option>}
                {roles.map((r) => <option key={r.id} value={r.id}>{r.nombre}</option>)}</select></label>
            {edicion.rol === 'CLIENTE' && (
              <label className="field"><span className="field__label">Ficha de cliente</span>
                <select className="field__input" value={edicion.clienteId} onChange={(e) => setEdicion({ ...edicion, clienteId: e.target.value })}><option value="">Elegir…</option>{clientes.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select></label>
            )}
            <label className="field"><span className="field__label">Nueva contraseña</span>
              <input className="field__input" type="text" autoComplete="new-password" value={edicion.clave} onChange={(e) => setEdicion({ ...edicion, clave: e.target.value })} placeholder={`déjala vacía para no cambiarla · mínimo ${claveMin}`} /></label>
          </div>
        )}
      </Dialogo>
    </>
  );
}
