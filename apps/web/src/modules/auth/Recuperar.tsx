import { useState } from 'react';
import { api, useClaveMinima } from '@/core/api';
import { Boton } from '@/ui/primitives';
import { Icon } from '@/ui/icons';

/** Recuperar contraseña: código de 6 dígitos por correo (SMTP configurado por el Superadmin). */
export function Recuperar({ onVolver }: { onVolver: (aviso?: string) => void }) {
  const [paso, setPaso] = useState<'pedir' | 'cambiar'>('pedir');
  const claveMin = useClaveMinima();
  const [identificador, setIdentificador] = useState('');
  const [codigo, setCodigo] = useState('');
  const [nueva, setNueva] = useState('');
  const [repetir, setRepetir] = useState('');
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trabajando, setTrabajando] = useState(false);

  const correr = async (fn: () => Promise<void>) => {
    setError(null);
    setTrabajando(true);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo completar.'); } finally { setTrabajando(false); }
  };

  const pedir = () => correr(async () => {
    const r = await api<{ mensaje: string }>('/auth/recuperar', { method: 'POST', body: { identificador: identificador.trim() }, sinAuth: true });
    setMensaje(r.mensaje);
    setPaso('cambiar');
  });

  const cambiar = () => correr(async () => {
    if (nueva !== repetir) throw new Error('Las contraseñas no coinciden.');
    const r = await api<{ mensaje: string }>('/auth/restablecer', { method: 'POST', body: { identificador: identificador.trim(), codigo, nueva }, sinAuth: true });
    onVolver(r.mensaje);
  });

  return paso === 'pedir' ? (
    <form className="form" onSubmit={(e) => { e.preventDefault(); void pedir(); }}>
      <label className="field">
        <span className="field__label">Usuario o correo</span>
        <div className="field__grupo field__grupo--icono">
          <Icon name="user" size={17} />
          <input className="field__input" value={identificador} onChange={(e) => setIdentificador(e.target.value)} required minLength={3} maxLength={160} autoComplete="username" autoFocus />
        </div>
      </label>
      {error && <p className="form__error" role="alert"><Icon name="alert" size={15} /> {error}</p>}
      <Boton variant="primary" size="lg" full type="submit" disabled={trabajando || identificador.trim().length < 3}>{trabajando ? 'Enviando…' : 'Enviarme un código'}</Boton>
      <button type="button" className="mfa__volver" onClick={() => onVolver()}>Volver a iniciar sesión</button>
    </form>
  ) : (
    <form className="form" onSubmit={(e) => { e.preventDefault(); void cambiar(); }}>
      {mensaje && <p className="form__ok" role="status"><Icon name="check" size={15} /> {mensaje}</p>}
      <label className="field">
        <span className="field__label">Código de 6 dígitos</span>
        <input className="field__input mfa__codigo" value={codigo} onChange={(e) => setCodigo(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" autoFocus />
      </label>
      <label className="field">
        <span className="field__label">Contraseña nueva (mínimo {claveMin} caracteres)</span>
        <input className="field__input" type="password" value={nueva} onChange={(e) => setNueva(e.target.value)} minLength={10} maxLength={128} autoComplete="new-password" required />
      </label>
      <label className="field">
        <span className="field__label">Repite la contraseña</span>
        <input className="field__input" type="password" value={repetir} onChange={(e) => setRepetir(e.target.value)} autoComplete="new-password" required />
      </label>
      {error && <p className="form__error" role="alert"><Icon name="alert" size={15} /> {error}</p>}
      <Boton variant="primary" size="lg" full type="submit" disabled={trabajando || codigo.length !== 6 || nueva.length < claveMin || nueva !== repetir}>{trabajando ? 'Guardando…' : 'Cambiar contraseña'}</Boton>
      <button type="button" className="mfa__volver" onClick={() => { setPaso('pedir'); setCodigo(''); }}>No me llegó: pedir otro código</button>
      <button type="button" className="mfa__volver" onClick={() => onVolver()}>Volver a iniciar sesión</button>
    </form>
  );
}
