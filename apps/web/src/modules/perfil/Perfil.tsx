import { useEffect, useRef, useState } from 'react';
import { api, regenerarRecuperacion } from '@/core/api';
import { useApp } from '@/core/app-state';
import { imagenABase64 } from '@/core/imagen';
import { fechaHora } from '@/core/format';
import { Avatar, Boton, Encabezado, Tarjeta, TarjetaTitulo } from '@/ui/primitives';
import { Dialogo } from '@/ui/Dialogo';

interface PerfilDatos {
  id: string; nombre: string; usuario: string; email: string; telefono: string;
  rol: string; fotoUrl: string | null; creado_en: string; ultimo_acceso: string | null; codigos_mfa: string;
}

/** Mi perfil: datos de contacto, foto, contraseña y códigos de respaldo. Cada usuario, cualquier rol. */
export function Perfil() {
  const { recargarSesion, cerrarSesion } = useApp();
  const [p, setP] = useState<PerfilDatos | null>(null);
  const [form, setForm] = useState({ nombre: '', email: '', telefono: '' });
  const [clave, setClave] = useState({ actual: '', nueva: '', repetir: '' });
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger'; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [codigos, setCodigos] = useState<string[] | null>(null);
  const archivo = useRef<HTMLInputElement>(null);

  const cargar = async () => {
    const d = await api<PerfilDatos>('/perfil');
    setP(d);
    setForm({ nombre: d.nombre, email: d.email, telefono: d.telefono });
  };
  useEffect(() => { void cargar(); }, []);

  const ejecutar = async (clave: string, fn: () => Promise<string>) => {
    setOcupado(clave);
    setAviso(null);
    try { setAviso({ tono: 'ok', texto: await fn() }); }
    catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo completar.' }); }
    finally { setOcupado(null); }
  };

  const guardarDatos = () => ejecutar('datos', async () => {
    await api('/perfil', { method: 'PATCH', body: form });
    await Promise.all([cargar(), recargarSesion()]);
    return 'Datos actualizados.';
  });

  const subirFoto = (f: File) => ejecutar('foto', async () => {
    await api('/perfil/foto', { method: 'PUT', body: { base64: await imagenABase64(f) } });
    await Promise.all([cargar(), recargarSesion()]);
    return 'Foto actualizada.';
  });

  const cambiarClave = () => ejecutar('clave', async () => {
    if (clave.nueva !== clave.repetir) throw new Error('Las contraseñas nuevas no coinciden.');
    await api('/perfil/clave', { method: 'POST', body: { actual: clave.actual, nueva: clave.nueva } });
    setClave({ actual: '', nueva: '', repetir: '' });
    // El servidor cerró todas las sesiones, incluida esta: se vuelve a ingresar con la clave nueva.
    setTimeout(() => void cerrarSesion(), 1500);
    return 'Contraseña cambiada. Por seguridad se cerrarán tus sesiones; vuelve a ingresar.';
  });

  const fuerza = clave.nueva.length >= 14 ? 'fuerte' : clave.nueva.length >= 10 ? 'aceptable' : clave.nueva ? 'débil' : '';

  if (!p) return <div className="tabla-cargando">Cargando perfil…</div>;

  return (
    <>
      <Encabezado titulo="Mi perfil" descripcion="Tus datos, tu foto y la seguridad de tu cuenta. Cada cambio queda auditado." />

      {aviso && (
        <div className={`aviso aviso--${aviso.tono}`} role="status">
          <span className="aviso__icono">{aviso.tono === 'ok' ? '✓' : '!'}</span><div><p>{aviso.texto}</p></div>
        </div>
      )}

      <div className="grid grid--12">
        <Tarjeta className="col-4">
          <div className="perfil-ficha">
            <Avatar nombre={p.nombre} fotoUrl={p.fotoUrl} size="lg" />
            <h3>{p.nombre}</h3>
            <p className="t-muted">{p.rol} · @{p.usuario}</p>
            <input ref={archivo} type="file" accept="image/png,image/jpeg,image/webp" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void subirFoto(f); e.target.value = ''; }} />
            <Boton icono="user" onClick={() => archivo.current?.click()} disabled={ocupado === 'foto'}>
              {ocupado === 'foto' ? 'Subiendo…' : p.fotoUrl ? 'Cambiar foto' : 'Subir foto'}
            </Boton>
            <dl className="datos datos--compacto">
              <div><dt>Miembro desde</dt><dd>{fechaHora(p.creado_en)}</dd></div>
              {p.ultimo_acceso && <div><dt>Último acceso</dt><dd>{fechaHora(p.ultimo_acceso)}</dd></div>}
            </dl>
          </div>
        </Tarjeta>

        <div className="col-8 pila">
          <Tarjeta>
            <TarjetaTitulo titulo="Datos de contacto" subtitulo="Se usan para avisos y para recuperar tu cuenta" />
            <form className="form form--2col" onSubmit={(e) => { e.preventDefault(); void guardarDatos(); }}>
              <label className="field"><span className="field__label">Nombre completo</span>
                <input className="field__input" required minLength={3} maxLength={120} value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} />
              </label>
              <label className="field"><span className="field__label">Correo</span>
                <input className="field__input" type="email" maxLength={160} autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </label>
              <label className="field"><span className="field__label">Teléfono</span>
                <input className="field__input" type="tel" maxLength={30} autoComplete="tel" value={form.telefono} onChange={(e) => setForm({ ...form, telefono: e.target.value })} />
              </label>
              <div className="form__acciones"><Boton variant="primary" type="submit" disabled={ocupado === 'datos'}>{ocupado === 'datos' ? 'Guardando…' : 'Guardar cambios'}</Boton></div>
            </form>
          </Tarjeta>

          <Tarjeta>
            <TarjetaTitulo titulo="Cambiar contraseña" subtitulo="Mínimo 10 caracteres. Al cambiarla se cierran tus sesiones en otros equipos." />
            <form className="form form--2col" onSubmit={(e) => { e.preventDefault(); void cambiarClave(); }}>
              <label className="field"><span className="field__label">Contraseña actual</span>
                <input className="field__input" type="password" required autoComplete="current-password" value={clave.actual} onChange={(e) => setClave({ ...clave, actual: e.target.value })} />
              </label>
              <span />
              <label className="field"><span className="field__label">Nueva contraseña</span>
                <input className="field__input" type="password" required minLength={10} maxLength={128} autoComplete="new-password" value={clave.nueva} onChange={(e) => setClave({ ...clave, nueva: e.target.value })} />
                {fuerza && <span className={`field__aviso field__aviso--${fuerza}`}>Seguridad: {fuerza}</span>}
              </label>
              <label className="field"><span className="field__label">Repite la nueva</span>
                <input className="field__input" type="password" required autoComplete="new-password" value={clave.repetir} onChange={(e) => setClave({ ...clave, repetir: e.target.value })} />
              </label>
              <div className="form__acciones">
                <Boton variant="primary" type="submit" disabled={ocupado === 'clave' || clave.nueva.length < 10 || clave.nueva !== clave.repetir}>
                  {ocupado === 'clave' ? 'Cambiando…' : 'Cambiar contraseña'}
                </Boton>
              </div>
            </form>
          </Tarjeta>

          <Tarjeta>
            <TarjetaTitulo titulo="Verificación en dos pasos" subtitulo={`${p.codigos_mfa} códigos de respaldo sin usar`}
              accion={<Boton icono="shield" onClick={() => void ejecutar('mfa', async () => { setCodigos(await regenerarRecuperacion()); return 'Se generaron códigos nuevos; los anteriores quedan anulados.'; })}>Generar códigos</Boton>} />
          </Tarjeta>
        </div>
      </div>

      <Dialogo abierto={codigos !== null} titulo="Códigos de recuperación"
        descripcion="Guárdalos en un lugar seguro. Cada uno sirve una sola vez si pierdes el teléfono."
        onCerrar={() => { setCodigos(null); void cargar(); }}
        acciones={<Boton variant="primary" onClick={() => { setCodigos(null); void cargar(); }}>Ya los guardé</Boton>}>
        <ul className="mfa__lista">{codigos?.map((c) => <li key={c} className="mfa__item">{c}</li>)}</ul>
      </Dialogo>
    </>
  );
}
