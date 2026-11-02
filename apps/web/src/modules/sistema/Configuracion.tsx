import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, leerConfigPublica, urlApi } from '@/core/api';
import { imagenABase64 } from '@/core/imagen';
import { relativa } from '@/core/format';
import { Boton, Encabezado, Insignia, Segmentado, Tarjeta, TarjetaTitulo, Vacio } from '@/ui/primitives';

type Seccion = 'marca' | 'movil' | 'legal' | 'integraciones';
type Datos = Record<string, Record<string, unknown>>;
interface Dispositivo { nombre: string; usuario: string; plataforma: string; version_app: string; ultimo_uso: string; push: boolean; desactualizada: boolean }

const EVENTOS: Array<[string, string]> = [
  ['venta.creada', 'Venta registrada'], ['cobro.registrado', 'Cobro registrado'], ['pedido.estado', 'Cambio de estado de pedido'],
  ['inventario.movimiento', 'Movimiento de inventario'], ['usuario.eliminado', 'Cuenta eliminada'],
];

/** Todo lo que antes exigía tocar código: marca, versión de la app, legal, Firebase y webhook. */
export function Configuracion() {
  const [tab, setTab] = useState<Seccion>('marca');
  const [cfg, setCfg] = useState<Datos | null>(null);
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger' | 'info'; texto: string } | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [dispositivos, setDispositivos] = useState<Dispositivo[]>([]);

  const [negocio, setNegocio] = useState<Record<string, string> | null>(null);
  const cargar = async () => {
    setCfg(await api<Datos>('/sistema/config'));
    setNegocio({ ...(await leerConfigPublica(true)).negocio });
  };
  const guardarNegocio = async () => {
    setGuardando(true);
    setAviso(null);
    try { await api('/sistema/negocio', { method: 'PUT', body: negocio }); await leerConfigPublica(true); setAviso({ tono: 'ok', texto: 'Datos del negocio guardados: ya se ven en el ingreso y en los comprobantes.' }); }
    catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo guardar.' }); }
    finally { setGuardando(false); }
  };
  useEffect(() => { void cargar(); void api<Dispositivo[]>('/sistema/dispositivos').then(setDispositivos).catch(() => {}); }, []);

  const campo = (s: string, k: string, v: unknown) => setCfg((c) => c && { ...c, [s]: { ...c[s], [k]: v } });

  const guardar = async (...secciones: string[]) => {
    setGuardando(true);
    setAviso(null);
    try {
      for (const s of secciones) await api(`/sistema/config/${s}`, { method: 'PUT', body: cfg![s] });
      await cargar();
      await leerConfigPublica(true);
      setAviso({ tono: 'ok', texto: 'Guardado. La web y las apps toman el cambio sin reinstalar ni desplegar.' });
    } catch (e) {
      setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo guardar.' });
    } finally {
      setGuardando(false);
    }
  };

  const probar = async (ruta: string, ok: (r: Record<string, unknown>) => string) => {
    setAviso(null);
    try { setAviso({ tono: 'info', texto: ok(await api(ruta, { method: 'POST', body: {} })) }); }
    catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'Falló la prueba.' }); }
  };

  if (!cfg) return <div className="tabla-cargando">Cargando configuración…</div>;
  const { marca, movil, legal, firebase, webhook } = cfg as Record<string, Record<string, never>>;
  const desactualizados = dispositivos.filter((d) => d.desactualizada).length;

  return (
    <>
      <Encabezado titulo="Configuración del sistema"
        descripcion="Solo el Superadministrador. Cada cambio queda auditado; los secretos nunca se muestran después de guardarlos." />

      <Segmentado<Seccion> valor={tab} onChange={(v) => { setTab(v); setAviso(null); }} opciones={[
        { id: 'marca', etiqueta: 'Marca' }, { id: 'movil', etiqueta: 'App móvil' },
        { id: 'legal', etiqueta: 'Legal y soporte' }, { id: 'integraciones', etiqueta: 'Integraciones' },
      ]} />

      {aviso && <div className={`aviso aviso--${aviso.tono}`} role="status"><span className="aviso__icono">{aviso.tono === 'danger' ? '!' : '✓'}</span><div><p>{aviso.texto}</p></div></div>}

      {tab === 'marca' && negocio && (
        <Tarjeta>
          <TarjetaTitulo titulo="Datos del negocio" subtitulo="Aparecen en la tarjeta de ingreso, en los comprobantes y en el contacto de la app" />
          <div className="form form--2col">
            {([['nombre', 'Nombre comercial'], ['ruc', 'RUC'], ['claim', 'Lema (tarjeta)'], ['representante', 'Representante'],
              ['telefono', 'Teléfono'], ['whatsapp', 'WhatsApp'], ['email', 'Correo'], ['direccion', 'Dirección']] as Array<[string, string]>).map(([k, l]) => (
              <Campo key={k} etiqueta={l}><input className="field__input" value={negocio[k] ?? ''} onChange={(e) => setNegocio({ ...negocio, [k]: e.target.value })} /></Campo>
            ))}
          </div>
          <div className="form__acciones"><Boton variant="primary" onClick={() => void guardarNegocio()} disabled={guardando}>Guardar datos del negocio</Boton></div>
        </Tarjeta>
      )}
      {tab === 'marca' && (
        <Tarjeta>
          <TarjetaTitulo titulo="Identidad" subtitulo="Logo y nombre que ven la pantalla de ingreso, el menú y la app" />
          <div className="form form--2col">
            <Campo etiqueta="Nombre de la app"><input className="field__input" maxLength={40} value={marca.nombreApp ?? ''} onChange={(e) => campo('marca', 'nombreApp', e.target.value)} /></Campo>
            <span />
            <Campo etiqueta="Color principal"><input className="field__input field__color" type="color" value={marca.colorPrimario ?? '#2B1D16'} onChange={(e) => campo('marca', 'colorPrimario', e.target.value.toUpperCase())} /></Campo>
            <Campo etiqueta="Color de acento"><input className="field__input field__color" type="color" value={marca.colorAcento ?? '#C9A27A'} onChange={(e) => campo('marca', 'colorAcento', e.target.value.toUpperCase())} /></Campo>
            <SubirImagen etiqueta="Logo (PNG transparente, horizontal)" id={marca.logoId} onId={(id) => campo('marca', 'logoId', id)} onError={(t) => setAviso({ tono: 'danger', texto: t })} />
            <SubirImagen etiqueta="Ícono de la app (cuadrado, 1024×1024)" id={marca.iconoId} cuadrado onId={(id) => campo('marca', 'iconoId', id)} onError={(t) => setAviso({ tono: 'danger', texto: t })} />
          </div>
          <p className="dialogo__nota">El ícono que aparece en la pantalla del celular lo fija la tienda al publicar cada versión; este ícono se usa dentro de la app y para generar el de la próxima publicación.</p>
          <div className="form__acciones"><Boton variant="primary" onClick={() => void guardar('marca')} disabled={guardando}>Guardar marca</Boton></div>
        </Tarjeta>
      )}

      {tab === 'movil' && (
        <div className="pila">
          <Tarjeta>
            <TarjetaTitulo titulo="Control de versiones" subtitulo="La app consulta esto al abrir. Por debajo de la mínima, obliga a actualizar." />
            <div className="form form--2col">
              <Campo etiqueta="Versión publicada en tiendas"><input className="field__input mono" placeholder="1.2.0" value={movil.versionActual ?? ''} onChange={(e) => campo('movil', 'versionActual', e.target.value.trim())} /></Campo>
              <Campo etiqueta="Versión mínima permitida"><input className="field__input mono" placeholder="1.1.0" value={movil.versionMinima ?? ''} onChange={(e) => campo('movil', 'versionMinima', e.target.value.trim())} /></Campo>
              <Campo etiqueta="Enlace Google Play"><input className="field__input" type="url" placeholder="https://play.google.com/store/apps/details?id=…" value={movil.urlAndroid ?? ''} onChange={(e) => campo('movil', 'urlAndroid', e.target.value.trim())} /></Campo>
              <Campo etiqueta="Enlace App Store"><input className="field__input" type="url" placeholder="https://apps.apple.com/app/id…" value={movil.urlIos ?? ''} onChange={(e) => campo('movil', 'urlIos', e.target.value.trim())} /></Campo>
              <Campo etiqueta="Mensaje al pedir actualización" ancho><input className="field__input" maxLength={200} value={movil.mensajeActualizacion ?? ''} onChange={(e) => campo('movil', 'mensajeActualizacion', e.target.value)} /></Campo>
            </div>
            <div className="form__acciones"><Boton variant="primary" onClick={() => void guardar('movil')} disabled={guardando}>Guardar versiones</Boton></div>
          </Tarjeta>

          <Tarjeta padding="none">
            <div className="card__head card__head--padded">
              <div><h3 className="card__title">Dispositivos conectados</h3>
                <p className="card__sub">{dispositivos.length} instalaciones · {desactualizados} por debajo de la versión mínima</p></div>
            </div>
            {dispositivos.length === 0 ? <Vacio titulo="Aún no hay dispositivos" detalle="Aparecen cuando alguien abre la app móvil." icono="user" /> : (
              <div className="table-wrap"><table className="table">
                <thead><tr><th>Usuario</th><th>Plataforma</th><th>Versión</th><th>Push</th><th className="t-right">Último uso</th></tr></thead>
                <tbody>{dispositivos.map((d, i) => (
                  <tr key={i}>
                    <td><div className="celda-doble"><strong>{d.nombre}</strong><span>@{d.usuario}</span></div></td>
                    <td>{d.plataforma === 'ios' ? 'iOS' : d.plataforma === 'android' ? 'Android' : 'Web'}</td>
                    <td><span className="mono">{d.version_app}</span> {d.desactualizada && <Insignia tono="danger">Desactualizada</Insignia>}</td>
                    <td>{d.push ? <Insignia tono="ok">Sí</Insignia> : <Insignia>No</Insignia>}</td>
                    <td className="t-right t-muted">{relativa(d.ultimo_uso)}</td>
                  </tr>))}</tbody>
              </table></div>
            )}
          </Tarjeta>
        </div>
      )}

      {tab === 'legal' && (
        <Tarjeta>
          <TarjetaTitulo titulo="Legal y soporte" subtitulo="Apple y Google exigen una política de privacidad pública y un contacto de soporte" />
          <div className="form form--2col">
            <Campo etiqueta="Política de privacidad (URL)"><input className="field__input" type="url" placeholder="https://www.tantapanaderia.com/privacidad" value={legal.urlPrivacidad ?? ''} onChange={(e) => campo('legal', 'urlPrivacidad', e.target.value.trim())} /></Campo>
            <Campo etiqueta="Términos y condiciones (URL)"><input className="field__input" type="url" placeholder="https://www.tantapanaderia.com/terminos" value={legal.urlTerminos ?? ''} onChange={(e) => campo('legal', 'urlTerminos', e.target.value.trim())} /></Campo>
            <Campo etiqueta="Correo de soporte"><input className="field__input" type="email" value={legal.correoSoporte ?? ''} onChange={(e) => campo('legal', 'correoSoporte', e.target.value.trim())} /></Campo>
          </div>
          <div className="form__acciones"><Boton variant="primary" onClick={() => void guardar('legal')} disabled={guardando}>Guardar</Boton></div>
        </Tarjeta>
      )}

      {tab === 'integraciones' && (
        <div className="pila">
          <Tarjeta>
            <TarjetaTitulo titulo="Firebase · notificaciones push" subtitulo="Firebase Console → Configuración del proyecto. La app lee estos datos al abrir: no hace falta recompilarla."
              accion={<Insignia tono={firebase.habilitado ? 'ok' : 'neutral'} punto>{firebase.habilitado ? 'Activo' : 'Inactivo'}</Insignia>} />
            <div className="form form--2col">
              <label className="check"><input type="checkbox" checked={!!firebase.habilitado} onChange={(e) => campo('firebase', 'habilitado', e.target.checked)} /> Enviar notificaciones push</label>
              <span />
              <Campo etiqueta="Project ID"><input className="field__input mono" value={firebase.projectId ?? ''} onChange={(e) => campo('firebase', 'projectId', e.target.value.trim())} /></Campo>
              <Campo etiqueta="Sender ID"><input className="field__input mono" value={firebase.senderId ?? ''} onChange={(e) => campo('firebase', 'senderId', e.target.value.trim())} /></Campo>
              <Campo etiqueta="API key (pública)"><input className="field__input mono" value={firebase.apiKey ?? ''} onChange={(e) => campo('firebase', 'apiKey', e.target.value.trim())} /></Campo>
              <span />
              <Campo etiqueta="App ID Android"><input className="field__input mono" placeholder="1:123:android:abc" value={firebase.appIdAndroid ?? ''} onChange={(e) => campo('firebase', 'appIdAndroid', e.target.value.trim())} /></Campo>
              <Campo etiqueta="App ID iOS"><input className="field__input mono" placeholder="1:123:ios:abc" value={firebase.appIdIos ?? ''} onChange={(e) => campo('firebase', 'appIdIos', e.target.value.trim())} /></Campo>
              <Campo etiqueta="Cuenta de servicio (JSON) · secreta" ancho>
                <textarea className="field__input mono" rows={4} spellCheck={false} placeholder='{"type":"service_account","project_id":"…","private_key":"…","client_email":"…"}'
                  value={firebase.cuentaServicio ?? ''} onChange={(e) => campo('firebase', 'cuentaServicio', e.target.value)} />
              </Campo>
            </div>
            <div className="form__acciones">
              <Boton onClick={() => void probar('/sistema/push/probar', (r) => `Push enviado a ${r.enviados} dispositivo(s) tuyos.`)}>Enviarme una prueba</Boton>
              <Boton variant="primary" onClick={() => void guardar('firebase')} disabled={guardando}>Guardar Firebase</Boton>
            </div>
          </Tarjeta>

          <Tarjeta>
            <TarjetaTitulo titulo="Webhook" subtitulo="Avisa a otro sistema (ERP, contabilidad, WhatsApp) en cada evento. Cuerpo firmado con HMAC-SHA256 en X-Tanta-Firma."
              accion={<Insignia tono={webhook.habilitado ? 'ok' : 'neutral'} punto>{webhook.habilitado ? 'Activo' : 'Inactivo'}</Insignia>} />
            <div className="form form--2col">
              <label className="check"><input type="checkbox" checked={!!webhook.habilitado} onChange={(e) => campo('webhook', 'habilitado', e.target.checked)} /> Enviar eventos</label>
              <span />
              <Campo etiqueta="URL de destino (https)"><input className="field__input" type="url" placeholder="https://erp.miempresa.com/tanta" value={webhook.url ?? ''} onChange={(e) => campo('webhook', 'url', e.target.value.trim())} /></Campo>
              <Campo etiqueta="Secreto de firma · secreto"><input className="field__input mono" type="password" autoComplete="off" value={webhook.secreto ?? ''} onChange={(e) => campo('webhook', 'secreto', e.target.value)} /></Campo>
              <fieldset className="field field--ancho"><legend className="field__label">Eventos</legend>
                <div className="checks">{EVENTOS.map(([id, txt]) => (
                  <label key={id} className="check"><input type="checkbox" checked={(webhook.eventos as string[] ?? []).includes(id)}
                    onChange={(e) => campo('webhook', 'eventos', e.target.checked ? [...(webhook.eventos as string[] ?? []), id] : (webhook.eventos as string[]).filter((x) => x !== id))} /> {txt}</label>
                ))}</div>
              </fieldset>
            </div>
            <div className="form__acciones">
              <Boton onClick={() => void probar('/sistema/webhook/probar', (r) => r.ok ? `El destino respondió ${r.status}.` : `El destino no respondió bien (${r.status || String(r.detalle)}).`)}>Probar</Boton>
              <Boton variant="primary" onClick={() => void guardar('webhook')} disabled={guardando}>Guardar webhook</Boton>
            </div>
          </Tarjeta>
        </div>
      )}
    </>
  );
}

function Campo({ etiqueta, children, ancho }: { etiqueta: string; children: ReactNode; ancho?: boolean }) {
  return <label className={`field ${ancho ? 'field--ancho' : ''}`}><span className="field__label">{etiqueta}</span>{children}</label>;
}

function SubirImagen({ etiqueta, id, cuadrado, onId, onError }: { etiqueta: string; id: string | null; cuadrado?: boolean; onId: (id: string | null) => void; onError: (t: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [subiendo, setSubiendo] = useState(false);
  const subir = async (f: File) => {
    setSubiendo(true);
    try {
      const { id } = await api<{ id: string }>('/sistema/archivos', { method: 'POST', body: { base64: await imagenABase64(f, cuadrado ? 1024 : 800, 'image/png') } });
      onId(id);
    } catch (e) { onError(e instanceof Error ? e.message : 'No se pudo subir.'); }
    finally { setSubiendo(false); }
  };
  return (
    <div className="field">
      <span className="field__label">{etiqueta}</span>
      <div className={`subir-img ${cuadrado ? 'subir-img--cuadrado' : ''}`}>
        {id ? <img src={urlApi(`/archivos/${id}`)} alt="" /> : <span className="t-muted">Sin imagen</span>}
      </div>
      <input ref={ref} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void subir(f); e.target.value = ''; }} />
      <div className="form__acciones form__acciones--izq">
        <Boton size="sm" onClick={() => ref.current?.click()} disabled={subiendo}>{subiendo ? 'Subiendo…' : id ? 'Reemplazar' : 'Subir'}</Boton>
        {id && <Boton size="sm" variant="ghost" onClick={() => onId(null)}>Quitar</Boton>}
      </div>
    </div>
  );
}
