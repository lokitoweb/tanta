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
  const [cambio, setCambio] = useState<{ u: Usuario; rol: string; clienteId: string } | null>(null);
  const [opcionesError, setOpcionesError] = useState<string | null>(null);
  const cargarOpciones = () => {
    if (!gestiona) return;
    setOpcionesError(null);
    const falla = (que: string) => (e: Error) => setOpcionesError(`No se pudieron cargar ${que}: ${e.message}`);
    api<Array<{ id: string; nombre: string }>>('/roles-asignables').then(setRoles).catch(falla('los roles'));
    api<{ clientes: Array<{ id: string; nombre: string }> }>('/reportes-filtros').then((r) => setClientes(r.clientes)).catch(falla('los clientes'));
  };
  useEffect(cargarOpciones, []);
  const cambiarRol = async () => {
    if (!cambio) return;
    setGuardando(true);
    setError(null);
    try {
      await api(`/usuarios/${cambio.u.id}/rol`, { method: 'PATCH', body: { rol: cambio.rol, ...(cambio.rol === 'CLIENTE' ? { clienteId: cambio.clienteId } : {}) } });
      setCambio(null);
      await refrescarDatos();
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo cambiar el rol.'); }
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
        <Boton size="sm" variant="ghost" disabled={u.id === sesion.usuario.id} onClick={() => setCambio({ u, rol: u.rolId ?? 'VENDEDOR', clienteId: '' })}>Cambiar rol</Boton>
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
      <Dialogo abierto={cambio !== null} titulo={`Cambiar rol · ${cambio?.u.nombre ?? ''}`} descripcion="Sus sesiones abiertas se cierran: vuelve a ingresar con el rol nuevo."
        onCerrar={() => setCambio(null)}
        acciones={<><Boton onClick={() => setCambio(null)}>Cancelar</Boton><Boton variant="primary" disabled={guardando || (cambio?.rol === 'CLIENTE' && !cambio.clienteId)} onClick={() => void cambiarRol()}>Cambiar rol</Boton></>}>
        {cambio && (
          <div className="form form--compacto">
            <label className="field"><span className="field__label">Rol</span>
              <select className="field__input" value={cambio.rol} onChange={(e) => setCambio({ ...cambio, rol: e.target.value })}>{roles.map((r) => <option key={r.id} value={r.id}>{r.nombre}</option>)}</select></label>
            {cambio.rol === 'CLIENTE' && (
              <label className="field"><span className="field__label">Ficha de cliente</span>
                <select className="field__input" value={cambio.clienteId} onChange={(e) => setCambio({ ...cambio, clienteId: e.target.value })}><option value="">Elegir…</option>{clientes.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select></label>
            )}
          </div>
        )}
      </Dialogo>
    </>
  );
}
