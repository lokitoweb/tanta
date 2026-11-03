import { useEffect, useState } from 'react';
import demo from '@/config/demo.json';
import { ApiError, activarMfa, enrolarMfa, login, verificarMfa } from '@/core/api';
import { Boton } from '@/ui/primitives';
import { TarjetaMarca } from './TarjetaMarca';
import { Recuperar } from './Recuperar';
import { api, leerConfigPublica, type ConfigPublica } from '@/core/api';
import { Icon } from '@/ui/icons';

/** Mensaje claro para el usuario; nunca revela si el usuario existe. */
function mensajeError(e: unknown, defecto: string): string {
  if (e instanceof ApiError && e.status === 429) return 'Demasiados intentos. Espera un minuto antes de volver a intentar.';
  if (e instanceof TypeError) return 'No hay conexión con el servidor. Revisa tu internet.';
  return e instanceof Error ? e.message : defecto;
}

interface DemoUsuario { rol: string; usuario: string; nombre: string }
const usuarios = demo.usuarios as DemoUsuario[];

type Paso =
  | { tipo: 'credenciales' }
  | { tipo: 'codigo'; ticket: string; nombre: string }
  | { tipo: 'enrolar'; ticket: string; secreto: string; otpauth: string; nombre: string }
  | { tipo: 'codigos'; codigos: string[] };

export function Acceso({ onSesion }: { onSesion: () => void }) {
  const esDev = import.meta.env.DEV;
  const [paso, setPaso] = useState<Paso>({ tipo: 'credenciales' });
  const [usuario, setUsuario] = useState(esDev ? 'osquilcate' : '');
  const [clave, setClave] = useState<string>(esDev ? demo.clave : '');
  const [codigo, setCodigo] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [trabajando, setTrabajando] = useState(false);
  const [verClave, setVerClave] = useState(false);
  const [recordar, setRecordar] = useState(() => { try { return localStorage.getItem('tanta.recordar') !== '0'; } catch { return true; } });
  const [usarRecuperacion, setUsarRecuperacion] = useState(false);
  const [mayus, setMayus] = useState(false);
  const [recuperando, setRecuperando] = useState(false);
  const [avisoOk, setAvisoOk] = useState<string | null>(null);
  // El enlace solo aparece si el Superadmin configuró el correo (si no, no serviría).
  const [puedeRecuperar, setPuedeRecuperar] = useState(false);
  useEffect(() => { api<{ disponible: boolean }>('/auth/recuperar/disponible', { sinAuth: true }).then((r) => setPuedeRecuperar(r.disponible)).catch(() => {}); }, []);
  const detectarMayus = (e: React.KeyboardEvent) => setMayus(e.getModifierState?.('CapsLock') ?? false);

  const entrar = async () => {
    setError(undefined);
    setTrabajando(true);
    try {
      const r = await login(usuario.trim(), clave, recordar);
      if ('accessToken' in r) {
        onSesion();
        return;
      }
      if ('mfaRequerido' in r) {
        setPaso({ tipo: 'codigo', ticket: r.ticket, nombre: r.usuario.nombre });
        setCodigo('');
        return;
      }
      // El perfil exige segundo factor y aún no está dado de alta.
      const alta = await enrolarMfa(r.ticket);
      setPaso({
        tipo: 'enrolar', ticket: r.ticket, secreto: alta.secreto,
        otpauth: alta.otpauth, nombre: r.usuario.nombre,
      });
      setCodigo('');
    } catch (e) {
      setError(mensajeError(e, 'No se pudo iniciar sesión.'));
      setClave('');
    } finally {
      setTrabajando(false);
    }
  };

  const confirmarCodigo = async () => {
    if (paso.tipo === 'credenciales') return;
    setError(undefined);
    setTrabajando(true);
    try {
      if (paso.tipo === 'enrolar') {
        const r = await activarMfa(paso.ticket, codigo);
        if (r.codigosRecuperacion?.length) {
          // Se muestran una sola vez: si se pierden, hay que regenerarlos con la sesión abierta.
          setPaso({ tipo: 'codigos', codigos: r.codigosRecuperacion });
          return;
        }
      } else if (paso.tipo === 'codigo') {
        await verificarMfa(paso.ticket, codigo);
      }
      onSesion();
    } catch (e) {
      setError(mensajeError(e, 'Código inválido.'));
      setCodigo('');
    } finally {
      setTrabajando(false);
    }
  };

  const elegirDemo = (u: DemoUsuario) => {
    setUsuario(u.usuario);
    setClave(demo.clave);
    setError(undefined);
  };

  const volver = () => {
    setPaso({ tipo: 'credenciales' });
    setCodigo('');
    setError(undefined);
  };

  return (
    <div className="acceso">
      <aside className="acceso__marca">
        <div className="acceso__top">
          <span className="acceso__eyebrow">Sistema Integral de Gestión</span>
        </div>

        <TarjetaMarca />

        <PieMarca />
      </aside>

      <main className="acceso__form">
        <div className="acceso__caja">
          <header className="acceso__head">
            <h1>
              {recuperando ? 'Recuperar contraseña' : paso.tipo === 'credenciales' ? 'Iniciar sesión'
                : paso.tipo === 'codigo' ? 'Verificación en dos pasos'
                  : 'Activa la verificación en dos pasos'}
            </h1>
            <p>
              {recuperando ? 'Te enviaremos un código a tu correo registrado.' : paso.tipo === 'credenciales' ? 'Ingresa con tu usuario y contraseña.'
                : paso.tipo === 'codigo' ? `Escribe el código de tu app autenticadora, ${paso.nombre}.`
                  : 'Tu perfil puede mover dinero y usuarios: protege la cuenta con un segundo factor.'}
            </p>
          </header>

          {recuperando && <Recuperar onVolver={(aviso) => { setRecuperando(false); setAvisoOk(aviso ?? null); setClave(''); }} />}

          {!recuperando && paso.tipo === 'credenciales' && (
            <form className="form" onSubmit={(e) => { e.preventDefault(); void entrar(); }}>
              <label className="field">
                <span className="field__label">Usuario</span>
                <div className="field__grupo field__grupo--icono">
                <Icon name="user" size={17} />
                <input
                  className="field__input"
                  value={usuario}
                  onChange={(e) => setUsuario(e.target.value)}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  maxLength={60}
                  autoFocus={!esDev}
                  placeholder="Tu usuario"
                />
                </div>
              </label>

              <div className="field">
                <span className="field__label field__label--fila">
                  <label htmlFor="clave">Contraseña</label>
                  {puedeRecuperar && (
                    <button type="button" className="acceso__olvido" onClick={() => { setError(undefined); setAvisoOk(null); setRecuperando(true); }}>¿Olvidaste tu contraseña?</button>
                  )}
                </span>
                <div className="field__grupo field__grupo--icono">
                  <Icon name="shield" size={17} />
                  <input
                    id="clave"
                    placeholder="Tu contraseña"
                    className="field__input"
                    type={verClave ? 'text' : 'password'}
                    value={clave}
                    onChange={(e) => setClave(e.target.value)}
                    autoComplete="current-password"
                    required
                    maxLength={128}
                    onKeyUp={detectarMayus}
                    onKeyDown={detectarMayus}
                  />
                  <button type="button" className="field__ojo" onClick={() => setVerClave((v) => !v)}
                    aria-label={verClave ? 'Ocultar contraseña' : 'Mostrar contraseña'} aria-pressed={verClave}>
                    <Icon name="eye" size={17} />
                  </button>
                </div>
                {mayus && <span className="field__aviso"><Icon name="alert" size={13} /> Bloq Mayús está activado</span>}
              </div>

              <label className="check acceso__recordar">
                <input type="checkbox" checked={recordar}
                  onChange={(e) => { setRecordar(e.target.checked); try { localStorage.setItem('tanta.recordar', e.target.checked ? '1' : '0'); } catch { /* sin almacenamiento */ } }} />
                Mantener sesión iniciada
              </label>
              {avisoOk && <p className="form__ok" role="status"><Icon name="check" size={15} /> {avisoOk}</p>}
              {error && (
                <p className="form__error" role="alert">
                  <Icon name="alert" size={15} /> {error}
                </p>
              )}

              <Boton variant="primary" size="lg" full type="submit" iconoDer="chevron" disabled={trabajando || !usuario.trim() || !clave}>
                {trabajando ? 'Verificando…' : 'Entrar al sistema'}
              </Boton>

              {esDev && (
                <fieldset className="roles">
                  <legend className="field__label">Acceso rápido de demostración</legend>
                  <div className="roles__grid">
                    {usuarios.map((u) => (
                      <button
                        key={u.usuario}
                        type="button"
                        className={`rol-chip ${usuario === u.usuario ? 'is-active' : ''}`}
                        onClick={() => elegirDemo(u)}
                        aria-pressed={usuario === u.usuario}
                      >
                        <Icon name="user" size={17} />
                        <span className="rol-chip__nombre">{u.rol}</span>
                        <span className="rol-chip__perfil">{u.usuario}</span>
                      </button>
                    ))}
                  </div>
                  <p className="roles__nota">
                    Los siete perfiles existen en la base de datos con permisos distintos. Un vendedor no
                    recibe el costo ni el margen: el servidor no se los envía.
                  </p>
                </fieldset>
              )}

              <p className="acceso__legal">
                Al ingresar aceptas la política de privacidad (Ley 29733). Los accesos quedan auditados.
              </p>
            </form>
          )}

          {paso.tipo === 'enrolar' && (
            <form className="form" onSubmit={(e) => { e.preventDefault(); if (codigo.length === 6) void confirmarCodigo(); }}>
              <div className="mfa__secreto">
                <span className="field__label">Clave secreta</span>
                <code className="mfa__clave">{paso.secreto}</code>
                <p className="mfa__ayuda">
                  Escanéala o cópiala en Google Authenticator, Authy o 1Password. Después confirma con el
                  primer código que genere.
                </p>
              </div>

              <label className="field">
                <span className="field__label">Código de 6 dígitos</span>
                <input
                  className="field__input mfa__codigo"
                  value={codigo}
                  onChange={(e) => setCodigo(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="000000"
                  autoFocus
                />
              </label>

              {error && <p className="form__error" role="alert"><Icon name="alert" size={15} /> {error}</p>}

              <Boton variant="primary" size="lg" full type="submit" disabled={trabajando || codigo.length !== 6}>
                {trabajando ? 'Activando…' : 'Activar y entrar'}
              </Boton>
              <button type="button" className="mfa__volver" onClick={volver}>Volver</button>
            </form>
          )}

          {paso.tipo === 'codigo' && (
            <form className="form" onSubmit={(e) => { e.preventDefault(); void confirmarCodigo(); }}>
              <label className="field">
                <span className="field__label">
                  {usarRecuperacion ? 'Código de recuperación' : 'Código de 6 dígitos'}
                </span>
                <input
                  className={`field__input ${usarRecuperacion ? 'mfa__recuperacion' : 'mfa__codigo'}`}
                  value={codigo}
                  onChange={(e) => setCodigo(
                    usarRecuperacion
                      ? e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10)
                      : e.target.value.replace(/\D/g, '').slice(0, 6),
                  )}
                  inputMode={usarRecuperacion ? 'text' : 'numeric'}
                  autoComplete="one-time-code"
                  placeholder={usarRecuperacion ? 'XXXXX-XXXXX' : '000000'}
                  autoFocus
                />
              </label>

              {error && <p className="form__error" role="alert"><Icon name="alert" size={15} /> {error}</p>}

              <Boton
                variant="primary" size="lg" full type="submit" iconoDer="chevron"
                disabled={trabajando || (usarRecuperacion ? codigo.length < 8 : codigo.length !== 6)}
              >
                {trabajando ? 'Verificando…' : 'Verificar y entrar'}
              </Boton>
              <button
                type="button"
                className="mfa__volver"
                onClick={() => { setUsarRecuperacion((v) => !v); setCodigo(''); setError(undefined); }}
              >
                {usarRecuperacion ? 'Usar el código del teléfono' : 'Perdí el teléfono · usar código de recuperación'}
              </button>
              <button type="button" className="mfa__volver" onClick={volver}>Usar otra cuenta</button>
            </form>
          )}

          {paso.tipo === 'codigos' && (
            <div className="form">
              <div className="mfa__secreto">
                <span className="field__label">Guarda estos códigos ahora</span>
                <p className="mfa__ayuda">
                  Cada uno sirve una sola vez, si pierdes el teléfono. No se pueden volver a mostrar.
                </p>
              </div>

              <ul className="mfa__lista">
                {paso.codigos.map((c) => (
                  <li key={c} className="mfa__item">{c}</li>
                ))}
              </ul>

              <Boton variant="primary" size="lg" full onClick={onSesion} iconoDer="chevron">
                Los guardé, entrar al sistema
              </Boton>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

/** Pie del panel de marca: datos del negocio (Configuración → Marca), centrados. */
function PieMarca() {
  const [cfg, setCfg] = useState<ConfigPublica | null>(null);
  useEffect(() => { leerConfigPublica().then(setCfg).catch(() => {}); }, []);
  const n = cfg?.negocio;
  return (
    <div className="acceso__pie">
      {n?.direccion && <p>{n.direccion}</p>}
      <p className="acceso__version">© {new Date().getFullYear()} {n?.nombre ?? cfg?.marca.nombreApp ?? ''}{n?.ruc ? ` · RUC ${n.ruc}` : ''}</p>
    </div>
  );
}
