import { useState } from 'react';
import demo from '@/config/demo.json';
import { activarMfa, enrolarMfa, login, verificarMfa } from '@/core/api';
import { BrandMark, Boton } from '@/ui/primitives';
import { Icon } from '@/ui/icons';

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
  const [usarRecuperacion, setUsarRecuperacion] = useState(false);

  const entrar = async () => {
    setError(undefined);
    setTrabajando(true);
    try {
      const r = await login(usuario.trim(), clave);
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
      setError(e instanceof Error ? e.message : 'No se pudo iniciar sesión.');
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
      setError(e instanceof Error ? e.message : 'Código inválido.');
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

        <div className="tarjeta-marca">
          <div className="tarjeta-marca__cuerpo">
            <BrandMark variant="light" size="xl" />
            <p className="tarjeta-marca__claim">Pan de masa madre</p>
          </div>
          <div className="tarjeta-marca__banda">
            <div>
              <p className="tarjeta-marca__nombre">Oscar Quilcate Rosell</p>
              <p className="tarjeta-marca__rol">Representante</p>
            </div>
            <div className="tarjeta-marca__contacto">
              <span>WhatsApp</span>
              <strong>985 649 922</strong>
            </div>
          </div>
        </div>

        <div className="acceso__pie">
          <p>Pedidos · Producción · Almacén · Ventas · Cobranza · Costos</p>
          <p className="acceso__version">v0.1 · Lima, Perú</p>
        </div>
      </aside>

      <main className="acceso__form">
        <div className="acceso__caja">
          <header className="acceso__head">
            <h1>
              {paso.tipo === 'credenciales' ? 'Bienvenido de nuevo'
                : paso.tipo === 'codigo' ? 'Verificación en dos pasos'
                  : 'Activa la verificación en dos pasos'}
            </h1>
            <p>
              {paso.tipo === 'credenciales' ? 'Ingresa con tu cuenta para continuar.'
                : paso.tipo === 'codigo' ? `Escribe el código de tu app autenticadora, ${paso.nombre}.`
                  : 'Tu perfil puede mover dinero y usuarios: protege la cuenta con un segundo factor.'}
            </p>
          </header>

          {paso.tipo === 'credenciales' && (
            <form className="form" onSubmit={(e) => { e.preventDefault(); void entrar(); }}>
              <label className="field">
                <span className="field__label">Usuario</span>
                <input
                  className="field__input"
                  value={usuario}
                  onChange={(e) => setUsuario(e.target.value)}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </label>

              <label className="field">
                <span className="field__label">Contraseña</span>
                <div className="field__grupo">
                  <input
                    className="field__input"
                    type={verClave ? 'text' : 'password'}
                    value={clave}
                    onChange={(e) => setClave(e.target.value)}
                    autoComplete="current-password"
                  />
                  <button type="button" className="field__ojo" onClick={() => setVerClave((v) => !v)} aria-label="Mostrar contraseña">
                    <Icon name="eye" size={17} />
                  </button>
                </div>
              </label>

              {error && (
                <p className="form__error" role="alert">
                  <Icon name="alert" size={15} /> {error}
                </p>
              )}

              <Boton variant="primary" size="lg" full type="submit" iconoDer="chevron" disabled={trabajando}>
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
            <div className="form">
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

              <Boton variant="primary" size="lg" full onClick={() => void confirmarCodigo()} disabled={trabajando || codigo.length !== 6}>
                {trabajando ? 'Activando…' : 'Activar y entrar'}
              </Boton>
              <button type="button" className="mfa__volver" onClick={volver}>Volver</button>
            </div>
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
