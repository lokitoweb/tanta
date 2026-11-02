import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { useApp } from '@/core/app-state';
import { Encabezado, Insignia, Tarjeta, TarjetaTitulo, Boton } from '@/ui/primitives';
import { Tabla, type Columna } from '@/ui/Tabla';
import { Icon } from '@/ui/icons';
import { fechaHora } from '@/core/format';
import { Dialogo } from '@/ui/Dialogo';
import type { Usuario } from '@/core/types';

const ROLES = ['GERENTE', 'ADMINISTRADOR', 'PRODUCCION', 'ALMACEN', 'VENDEDOR', 'CLIENTE', 'SOPORTE'];

export function Usuarios() {
  const { dataset, sesion, refrescarDatos } = useApp();
  const [usuarios, setUsuarios] = useState<Usuario[]>(dataset.usuarios ?? []);
  const [nuevo, setNuevo] = useState(false);
  const [form, setForm] = useState({ nombre: '', usuario: '', clave: '', rol: 'VENDEDOR' });
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => { setUsuarios(dataset.usuarios ?? []); }, [dataset.usuarios]);

  const crear = async () => {
    setGuardando(true);
    setError(null);
    try {
      await api('/usuarios', { method: 'POST', body: form });
      setNuevo(false);
      setForm({ nombre: '', usuario: '', clave: '', rol: 'VENDEDOR' });
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
      render: (u) => (
        <Boton
          size="sm"
          variant={u.estado === 'ACTIVO' ? 'ghost' : 'secondary'}
          onClick={() => void cambiarEstado(u)}
          disabled={u.id === sesion.usuario.id}
          title={u.id === sesion.usuario.id ? 'No puedes bloquear tu propia cuenta' : undefined}
        >
          {u.estado === 'ACTIVO' ? 'Bloquear' : 'Reactivar'}
        </Boton>
      ),
    },
  ];

  return (
    <>
      <Encabezado
        titulo="Usuarios y roles"
        descripcion="El rol define qué ve cada persona · el costo y el margen solo los ve Gerencia y Administración"
        acciones={<Boton variant="primary" icono="plus" onClick={() => { setError(null); setNuevo(true); }}>Nuevo usuario</Boton>}
      />

      {error && <div className="aviso aviso--danger"><span className="aviso__icono">!</span><div><strong>Error</strong><p>{error}</p></div></div>}

      <div className="grid grid--12">
        <Tarjeta className="col-8" padding="none">
          <div className="card__head card__head--padded">
            <div>
              <h3 className="card__title">Cuentas</h3>
              <p className="card__sub">{usuarios.length} usuarios · al bloquear se revocan sus sesiones</p>
            </div>
          </div>
          <Tabla columnas={columnas} filas={usuarios} clave={(u) => u.id} />
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
        descripcion="La contraseña se guarda con scrypt. La persona debe cambiarla en su primer ingreso."
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
            <input className="field__input" type="text" value={form.clave} onChange={(e) => setForm({ ...form, clave: e.target.value })} placeholder="mínimo 8 caracteres" />
          </label>
          <label className="field">
            <span className="field__label">Rol</span>
            <select className="field__input" value={form.rol} onChange={(e) => setForm({ ...form, rol: e.target.value })}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
        </div>
      </Dialogo>
    </>
  );
}
