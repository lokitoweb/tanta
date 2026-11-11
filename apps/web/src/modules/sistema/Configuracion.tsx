import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, leerConfigPublica, urlApi } from '@/core/api';
import { imagenABase64 } from '@/core/imagen';
import { relativa } from '@/core/format';
import { InputNumero } from '@/ui/InputNumero';
import { Boton, Encabezado, Insignia, PilaEsqueleto, Segmentado, Tarjeta, TablaEsqueleto, TarjetaTitulo, Vacio } from '@/ui/primitives';
import { ActivacionApp, leerArchivoFirebase, type ArchivoFirebase } from './Vinculos';

type Seccion = 'marca' | 'movil' | 'legal' | 'correo' | 'integraciones';
type Datos = Record<string, Record<string, unknown>>;
interface Dispositivo { nombre: string; usuario: string; plataforma: string; version_app: string; ultimo_uso: string; push: boolean; desactualizada: boolean }

// Secciones de la app móvil que el superadmin puede apagar para todos (el permiso del rol sigue mandando).
const MODULOS: Array<[string, string, string]> = [
  ['pedidos', 'Pedidos', 'Lista y cambio de estado de pedidos'],
  ['ventas', 'Ventas', 'Nueva venta con comprobante en PDF'],
  ['cobranza', 'Cobranza', 'Cartera y registro de cobros'],
  ['produccion', 'Producción', 'Órdenes: crear, iniciar y cerrar con merma'],
  ['almacen', 'Almacén', 'Stock, kárdex y bajas con motivo'],
  ['catalogo', 'Catálogo', 'Pedidos del cliente y repetir pedido'],
];
const dominioActual = () => window.location.origin;
const MAX_FONDOS = 8;

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
  // null = cargando (esqueleto); [] = cargó y no hay dispositivos.
  const [listaDisp, setDispositivos] = useState<Dispositivo[] | null>(null);
  const [dispError, setDispError] = useState<string | null>(null);
  const dispositivos = listaDisp ?? [];
  const [cargaError, setCargaError] = useState<string | null>(null);

  const [negocio, setNegocio] = useState<Record<string, string> | null>(null);
  const cargar = async () => {
    // Primero la pública: el servidor revisa ahí el último release de GitHub y actualiza la versión.
    setNegocio({ ...(await leerConfigPublica(true)).negocio });
    const d = await api<Datos>('/sistema/config');
    // Primera vez: el servidor de las apps es este mismo dominio (no se escribe a mano).
    // Primera vez: dominio y páginas legales salen de este mismo servidor (solo por https).
    if (window.location.protocol === 'https:') {
      if (d.movil && !d.movil.urlApi) d.movil = { ...d.movil, urlApi: dominioActual() };
      if (d.legal && !d.legal.urlPrivacidad) d.legal = { ...d.legal, urlPrivacidad: `${dominioActual()}/privacidad` };
      if (d.legal && !d.legal.urlTerminos) d.legal = { ...d.legal, urlTerminos: `${dominioActual()}/terminos` };
    }
    setCfg(d);
  };
  const guardarNegocio = async () => {
    setGuardando(true);
    setAviso(null);
    try { await api('/sistema/negocio', { method: 'PUT', body: negocio }); await leerConfigPublica(true); setAviso({ tono: 'ok', texto: 'Datos del negocio guardados: ya se ven en el ingreso y en los comprobantes.' }); }
    catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo guardar.' }); }
    finally { setGuardando(false); }
  };
  const cargaInicial = () => { setCargaError(null); cargar().catch((e) => setCargaError(e instanceof Error ? e.message : 'No se pudo cargar.')); };
  const cargarDispositivos = () => { setDispError(null); setDispositivos(null); api<Dispositivo[]>('/sistema/dispositivos').then(setDispositivos).catch((e) => setDispError(e.message)); };
  useEffect(() => { cargaInicial(); cargarDispositivos(); }, []);

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

  const [destinatario, setDestinatario] = useState('');
  const [avisoFirebase, setAvisoFirebase] = useState<{ tono: 'ok' | 'danger' | 'info'; texto: string } | null>(null);
  const probar = async (ruta: string, ok: (r: Record<string, unknown>) => string, body: Record<string, unknown> = {}) => {
    setAviso(null);
    try { setAviso({ tono: 'ok', texto: ok(await api(ruta, { method: 'POST', body })) }); }
    catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'Falló la prueba.' }); }
  };

  if (!cfg) return (
    <>
      <Encabezado titulo="Configuración del sistema" />
      <Tarjeta>{cargaError ? <Vacio titulo="No se pudo cargar la configuración" detalle={cargaError} onReintentar={cargaInicial} /> : <PilaEsqueleto lineas={8} />}</Tarjeta>
    </>
  );
  const { marca, movil, legal, firebase, webhook, correo } = cfg as Record<string, Record<string, never>>;
  // El resultado de subir un archivo se muestra junto a los botones (el aviso general queda arriba, fuera de la vista).
  const cargarFirebase = async (archivo: File | undefined, esperado: ArchivoFirebase) => {
    if (!archivo) return;
    setAvisoFirebase(null);
    try {
      const datos = await leerArchivoFirebase(archivo, esperado);
      const nuevo = { ...cfg!.firebase, ...datos };
      setCfg((c) => c && { ...c, firebase: nuevo });
      if (esperado !== 'cuenta') {
        setAvisoFirebase({ tono: 'info', texto: `${archivo.name} leído: se completaron ${Object.keys(datos).length} campos. Pulsa «Guardar Firebase».` });
        return;
      }
      // La cuenta de servicio se guarda en el acto (cifrada): no se pierde si se olvida «Guardar».
      await api('/sistema/config/firebase', { method: 'PUT', body: nuevo });
      await cargar();
      setAvisoFirebase({ tono: 'ok', texto: `Cuenta de servicio guardada y cifrada (${JSON.parse(datos.cuentaServicio).client_email}). Ya puedes enviar un push de prueba.` });
    } catch (e) { setAvisoFirebase({ tono: 'danger', texto: e instanceof Error ? e.message : 'Archivo no válido.' }); }
  };
  const desactualizados = dispositivos.filter((d) => d.desactualizada).length;

  return (
    <>
      <Encabezado titulo="Configuración del sistema"
        descripcion="Solo el Superadministrador. Cada cambio queda auditado; los secretos nunca se muestran después de guardarlos." />

      <Segmentado<Seccion> valor={tab} onChange={(v) => { setTab(v); setAviso(null); }} opciones={[
        { id: 'marca', etiqueta: 'Marca' }, { id: 'movil', etiqueta: 'App móvil' },
        { id: 'legal', etiqueta: 'Legal y soporte' }, { id: 'correo', etiqueta: 'Correo (SMTP)' }, { id: 'integraciones', etiqueta: 'Integraciones' },
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

      {tab === 'marca' && (
        <Tarjeta>
          <TarjetaTitulo titulo="Fondos de la pantalla de ingreso" subtitulo="Fotos que rotan detrás de la tarjeta, en este orden. Sin fotos propias se usan los 3 fondos incluidos."
            accion={<Insignia tono="info">{(marca.fondosIngreso as string[] | undefined)?.length ?? 0} / {MAX_FONDOS}</Insignia>} />
          <EditorFondos ids={(marca.fondosIngreso as string[] | undefined) ?? []} onIds={(ids) => campo('marca', 'fondosIngreso', ids)} onError={(t) => setAviso({ tono: 'danger', texto: t })} />
          <div className="form form--2col">
            <Campo etiqueta="Segundos por fondo (3 a 30)">
              <InputNumero className="field__input" min={3} max={30} step={1} valor={(marca.fondoSegundos as number | undefined) ?? 7} onValor={(n) => campo('marca', 'fondoSegundos', n === '' ? 7 : n)} />
            </Campo>
          </div>
          <p className="dialogo__nota">Elige fotos con el centro despejado: ahí va la tarjeta (el recuadro claro de cada foto muestra lo que queda tapado). Se reducen solas antes de subirlas.</p>
          <div className="form__acciones"><Boton variant="primary" onClick={() => void guardar('marca')} disabled={guardando}>Guardar fondos</Boton></div>
        </Tarjeta>
      )}

      {tab === 'movil' && (
        <div className="pila">
          <ActivacionApp urlApi={String(movil.urlApi ?? '')} />
          <Tarjeta>
            <TarjetaTitulo titulo="Control de versiones" subtitulo="La app consulta esto al abrir. Por debajo de la mínima, obliga a actualizar." />
            <div className="form form--2col">
              <Campo etiqueta="Última versión publicada"><input className="field__input mono" placeholder="1.2.0" value={movil.versionActual ?? ''} onChange={(e) => campo('movil', 'versionActual', e.target.value.trim())} /></Campo>
              <Campo etiqueta="Versión mínima permitida"><input className="field__input mono" placeholder="1.1.0" value={movil.versionMinima ?? ''} onChange={(e) => campo('movil', 'versionMinima', e.target.value.trim())} /></Campo>
              <Campo etiqueta="Repositorio que compila la APK (GitHub)" ancho>
                <input className="field__input mono" placeholder="dueño/repositorio" value={movil.repoGithub ?? ''} onChange={(e) => campo('movil', 'repoGithub', e.target.value.trim())} />
              </Campo>
              <Campo etiqueta={`Token de GitHub · secreto · ${movil.tokenGithub === '••••••••' ? 'guardado y cifrado ✓' : movil.tokenGithub ? 'sin guardar' : 'falta'}`} ancho>
                <input className="field__input mono" type="password" autoComplete="off" placeholder="github_pat_…" value={movil.tokenGithub ?? ''} onChange={(e) => campo('movil', 'tokenGithub', e.target.value.trim())} />
              </Campo>
              <p className="dialogo__nota field--ancho">Con el token, cada vez que cambia el dominio (túnel nuevo o cambio aquí) el sistema lo publica en el repositorio y las apps instaladas se mudan solas al abrir, sin que nadie haga nada. Créalo en GitHub → Settings → Developer settings → Fine-grained tokens, solo para este repositorio y con permiso «Contents: Read and write».</p>
              <p className="dialogo__nota field--ancho">Con el repositorio indicado, cada APK que compila GitHub se detecta sola: la versión y el enlace de Android se actualizan aquí y los teléfonos reciben el aviso de actualización. La versión mínima la decides tú (obliga a actualizar).</p>
              <Campo etiqueta="Enlace Android (Google Play o APK)"><input className="field__input" type="url" placeholder="https://play.google.com/store/apps/details?id=…" value={movil.urlAndroid ?? ''} onChange={(e) => campo('movil', 'urlAndroid', e.target.value.trim())} /></Campo>
              <Campo etiqueta="Enlace App Store"><input className="field__input" type="url" placeholder="https://apps.apple.com/app/id…" value={movil.urlIos ?? ''} onChange={(e) => campo('movil', 'urlIos', e.target.value.trim())} /></Campo>
              <div className="field field--ancho">
                <span className="field__label field__label--fila">Dominio del servidor (API)
                  {String(movil.urlApi ?? '').replace(/\/api\/v1$/, '') === dominioActual() && <Insignia tono="ok" punto>Dominio detectado automáticamente</Insignia>}</span>
                <div className="campo-boton">
                  <input className="field__input mono" type="url" placeholder="https://miempresa.com" value={String(movil.urlApi ?? '').replace(/\/api\/v1$/, '')}
                    onChange={(e) => campo('movil', 'urlApi', e.target.value.trim())} />
                  <Boton onClick={() => campo('movil', 'urlApi', dominioActual())}>Restablecer a dominio actual</Boton>
                </div>
                <p className="dialogo__nota">Se completa solo con el dominio de este servidor y la APK se compila con él. Cámbialo solo si las apps deben conectarse por otra dirección (por ejemplo un túnel de pruebas o una mudanza): las apps instaladas lo leen al abrir y se cambian solas. Escribe <code>https://</code> y sin <code>/api</code> al final.</p>
              </div>
              <Campo etiqueta="Mensaje al pedir actualización" ancho><input className="field__input" maxLength={200} value={movil.mensajeActualizacion ?? ''} onChange={(e) => campo('movil', 'mensajeActualizacion', e.target.value)} /></Campo>
            </div>
            <div className="form__acciones"><Boton variant="primary" onClick={() => void guardar('movil')} disabled={guardando}>Guardar versiones</Boton></div>
          </Tarjeta>

          <Tarjeta>
            <TarjetaTitulo titulo="Módulos de la app" subtitulo="Activa o apaga secciones para todos los teléfonos. Cada usuario además solo ve lo que su rol permite."
              accion={<Insignia tono="info">{MODULOS.filter(([id]) => (movil.modulos as Record<string, boolean> | undefined)?.[id] !== false).length} / {MODULOS.length} activos</Insignia>} />
            <div className="modulos">
              {MODULOS.map(([id, nombre, desc]) => {
                const activo = (movil.modulos as Record<string, boolean> | undefined)?.[id] !== false;
                return (
                  <label key={id} className={`modulo ${activo ? 'is-on' : ''}`}>
                    <span><b>{nombre}</b><small>{desc}</small></span>
                    <input type="checkbox" role="switch" className="interruptor" checked={activo}
                      onChange={(e) => campo('movil', 'modulos', { ...(movil.modulos as Record<string, boolean> ?? {}), [id]: e.target.checked })} />
                  </label>
                );
              })}
            </div>
            <div className="form__acciones"><Boton variant="primary" onClick={() => void guardar('movil')} disabled={guardando}>Guardar módulos</Boton></div>
          </Tarjeta>

          <Tarjeta padding="none">
            <div className="card__head card__head--padded">
              <div><h3 className="card__title">Dispositivos conectados</h3>
                <p className="card__sub">{dispositivos.length} instalaciones · {desactualizados} por debajo de la versión mínima</p></div>
            </div>
            {dispError ? <Vacio titulo="No se pudo cargar" detalle={dispError} onReintentar={cargarDispositivos} />
              : listaDisp === null ? <TablaEsqueleto columnas={5} filas={3} />
              : dispositivos.length === 0 ? <Vacio titulo="Aún no hay dispositivos" detalle="Aparecen cuando alguien abre la app móvil." icono="user" /> : (
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
            <p className="dialogo__nota field--ancho">El sistema publica estas páginas en <a href="/privacidad" target="_blank" rel="noreferrer">/privacidad</a> y <a href="/terminos" target="_blank" rel="noreferrer">/terminos</a> con los datos del negocio. Usa esos enlaces en Google Play y App Store, o pon los de tu propia web.</p>
            <Campo etiqueta="Política de privacidad (URL)"><input className="field__input" type="url" placeholder="https://www.tantapanaderia.com/privacidad" value={legal.urlPrivacidad ?? ''} onChange={(e) => campo('legal', 'urlPrivacidad', e.target.value.trim())} /></Campo>
            <Campo etiqueta="Términos y condiciones (URL)"><input className="field__input" type="url" placeholder="https://www.tantapanaderia.com/terminos" value={legal.urlTerminos ?? ''} onChange={(e) => campo('legal', 'urlTerminos', e.target.value.trim())} /></Campo>
            <Campo etiqueta="Correo de soporte"><input className="field__input" type="email" value={legal.correoSoporte ?? ''} onChange={(e) => campo('legal', 'correoSoporte', e.target.value.trim())} /></Campo>
            <span />
            <Campo etiqueta="Texto de la política de privacidad (vacío = texto base según la Ley 29733)" ancho>
              <textarea className="field__input" rows={10} value={legal.textoPrivacidad ?? ''} placeholder="Deja vacío para usar el texto base con los datos del negocio, o pega aquí el tuyo." onChange={(e) => campo('legal', 'textoPrivacidad', e.target.value)} />
            </Campo>
            <Campo etiqueta="Texto de términos y condiciones (vacío = texto base)" ancho>
              <textarea className="field__input" rows={10} value={legal.textoTerminos ?? ''} placeholder="Deja vacío para usar el texto base, o pega aquí el tuyo." onChange={(e) => campo('legal', 'textoTerminos', e.target.value)} />
            </Campo>
          </div>
          <div className="form__acciones">
            <Boton onClick={() => void Promise.all(['privacidad', 'terminos'].map((d) => fetch(urlApi(`/legal/${d}`)).then((r) => r.json())))
              .then(([p, t]) => setCfg((c) => c && { ...c, legal: { ...c.legal, textoPrivacidad: c.legal.textoPrivacidad || p.texto, textoTerminos: c.legal.textoTerminos || t.texto } }))}>Cargar texto base para editar</Boton>
            <Boton variant="primary" onClick={() => void guardar('legal')} disabled={guardando}>Guardar</Boton>
          </div>
        </Tarjeta>
      )}

      {tab === 'correo' && (
        <Tarjeta>
          <TarjetaTitulo titulo="Servidor de correo (SMTP)" subtitulo="Lo usa la recuperación de contraseña y los avisos. Gmail, Outlook, Zoho, Amazon SES, tu hosting…"
            accion={<Insignia tono={correo.habilitado ? 'ok' : 'neutral'} punto>{correo.habilitado ? 'Activo' : 'Inactivo'}</Insignia>} />
          <div className="form form--2col">
            <label className="check field--ancho"><input type="checkbox" checked={!!correo.habilitado} onChange={(e) => campo('correo', 'habilitado', e.target.checked)} /> Enviar correos</label>
            <Campo etiqueta="Servidor (host)"><input className="field__input mono" placeholder="smtp.gmail.com" value={correo.host ?? ''} onChange={(e) => campo('correo', 'host', e.target.value.trim())} /></Campo>
            <Campo etiqueta="Puerto"><input className="field__input mono" type="number" min={1} max={65535} value={correo.puerto ?? 587} onChange={(e) => campo('correo', 'puerto', Number(e.target.value))} /></Campo>
            <label className="check field--ancho"><input type="checkbox" checked={!!correo.seguro} onChange={(e) => campo('correo', 'seguro', e.target.checked)} /> Conexión SSL directa (puerto 465). Con 587 se usa STARTTLS automáticamente.</label>
            <Campo etiqueta="Usuario"><input className="field__input" autoComplete="off" value={correo.usuario ?? ''} onChange={(e) => campo('correo', 'usuario', e.target.value.trim())} /></Campo>
            <Campo etiqueta="Contraseña · secreta"><input className="field__input" type="password" autoComplete="new-password" value={correo.clave ?? ''} onChange={(e) => campo('correo', 'clave', e.target.value)} /></Campo>
            <Campo etiqueta="Correo remitente"><input className="field__input" type="email" placeholder="no-responder@tantapanaderia.com" value={correo.remitente ?? ''} onChange={(e) => campo('correo', 'remitente', e.target.value.trim())} /></Campo>
            <Campo etiqueta="Nombre del remitente"><input className="field__input" value={correo.nombreRemitente ?? ''} onChange={(e) => campo('correo', 'nombreRemitente', e.target.value)} /></Campo>
          </div>
          <p className="dialogo__nota">Con Gmail usa una «contraseña de aplicación» (no la de tu cuenta). La prueba se envía al correo de tu perfil.</p>
          <div className="form__acciones">
            <Boton onClick={() => void probar('/sistema/correo/probar', (r) => `Correo de prueba enviado a ${r.para}.`)}>Enviarme una prueba</Boton>
            <Boton variant="primary" onClick={() => void guardar('correo')} disabled={guardando}>Guardar correo</Boton>
          </div>
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
              <div className="field field--ancho">
                <span className="field__label">Subir archivos de Firebase (se leen aquí y completan los campos)</span>
                <div className="subida-firebase">
                  <label className="btn btn--secondary btn--sm">google-services.json (Android)<input type="file" accept=".json,application/json" hidden onChange={(e) => { void cargarFirebase(e.target.files?.[0], 'android'); e.target.value = ''; }} /></label>
                  <label className="btn btn--secondary btn--sm">GoogleService-Info.plist (iOS)<input type="file" accept=".plist" hidden onChange={(e) => { void cargarFirebase(e.target.files?.[0], 'ios'); e.target.value = ''; }} /></label>
                  <label className="btn btn--secondary btn--sm">Cuenta de servicio (.json)<input type="file" accept=".json,application/json" hidden onChange={(e) => { void cargarFirebase(e.target.files?.[0], 'cuenta'); e.target.value = ''; }} /></label>
                </div>
                {avisoFirebase && <div className={`aviso aviso--${avisoFirebase.tono}`} role="status" style={{ marginTop: 10 }}><span className="aviso__icono">{avisoFirebase.tono === 'danger' ? '!' : '✓'}</span><div><p>{avisoFirebase.texto}</p></div></div>}
              </div>
              <Campo etiqueta="Project ID"><input className="field__input mono" value={firebase.projectId ?? ''} onChange={(e) => campo('firebase', 'projectId', e.target.value.trim())} /></Campo>
              <Campo etiqueta="Sender ID"><input className="field__input mono" value={firebase.senderId ?? ''} onChange={(e) => campo('firebase', 'senderId', e.target.value.trim())} /></Campo>
              <Campo etiqueta="API key (pública)"><input className="field__input mono" value={firebase.apiKey ?? ''} onChange={(e) => campo('firebase', 'apiKey', e.target.value.trim())} /></Campo>
              <span />
              <Campo etiqueta="App ID Android"><input className="field__input mono" placeholder="1:123:android:abc" value={firebase.appIdAndroid ?? ''} onChange={(e) => campo('firebase', 'appIdAndroid', e.target.value.trim())} /></Campo>
              <Campo etiqueta="App ID iOS"><input className="field__input mono" placeholder="1:123:ios:abc" value={firebase.appIdIos ?? ''} onChange={(e) => campo('firebase', 'appIdIos', e.target.value.trim())} /></Campo>
              <div className="guia field--ancho">
                <b>Dos archivos distintos, ambos de Firebase Console → ⚙ Configuración del proyecto:</b>
                <ol>
                  <li><b>google-services.json</b> (pestaña General → tu app Android): identifica la app; con él los teléfonos se registran para recibir avisos.</li>
                  <li><b>Cuenta de servicio</b> (pestaña Cuentas de servicio → «Generar nueva clave privada»): es la llave con la que <i>este servidor</i> envía los avisos. Sin ella se envían 0. Se guarda cifrada.</li>
                </ol>
                <span>Después, cada persona debe abrir la app, iniciar sesión y aceptar el permiso de notificaciones: su teléfono aparece con Push «Sí» en App móvil → Dispositivos.</span>
              </div>
              <Campo etiqueta={`Cuenta de servicio (JSON) · secreta · ${firebase.cuentaServicio === '••••••••' ? 'guardada y cifrada ✓' : firebase.cuentaServicio ? 'sin guardar' : 'falta'}`} ancho>
                <textarea className="field__input mono" rows={4} spellCheck={false} placeholder='{"type":"service_account","project_id":"…","private_key":"…","client_email":"…"}'
                  value={firebase.cuentaServicio ?? ''} onChange={(e) => campo('firebase', 'cuentaServicio', e.target.value)} />
              </Campo>
            </div>
            <div className="form__acciones form__acciones--entre">
              <div className="campo-boton">
                <input className="field__input" placeholder="Usuario o correo (vacío = tú)" value={destinatario} onChange={(e) => setDestinatario(e.target.value)} />
                <Boton onClick={() => void probar('/sistema/push/probar', (r) => `Push enviado a ${r.enviados} teléfono(s) de ${r.destinatario}.`, { destinatario })}>Enviar push de prueba</Boton>
              </div>
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
              <div className="field"><span className="field__label">Secreto de firma · secreto</span>
                <div className="campo-boton">
                  <input className="field__input mono" type="password" autoComplete="off" value={webhook.secreto ?? ''} onChange={(e) => campo('webhook', 'secreto', e.target.value)} />
                  <Boton onClick={() => campo('webhook', 'secreto', Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join(''))}>Generar</Boton>
                </div>
                <p className="dialogo__nota">Tu servidor verifica <code>X-Tanta-Firma: sha256=HMAC(cuerpo, secreto)</code>. Guárdalo antes de salir: no se vuelve a mostrar.</p>
              </div>
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

/** Lista ordenada de fondos: agregar varios a la vez, mover y quitar. Se guarda con «Guardar fondos». */
function EditorFondos({ ids, onIds, onError }: { ids: string[]; onIds: (ids: string[]) => void; onError: (t: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [subiendo, setSubiendo] = useState(false);
  const subir = async (archivos: File[]) => {
    setSubiendo(true);
    const nuevos = [...ids];
    try {
      for (const f of archivos.slice(0, MAX_FONDOS - ids.length)) {
        const { id } = await api<{ id: string }>('/sistema/archivos', { method: 'POST', body: { base64: await imagenABase64(f, 1600) } });
        nuevos.push(id);
      }
    } catch (e) { onError(e instanceof Error ? e.message : 'No se pudo subir.'); }
    onIds(nuevos);
    setSubiendo(false);
  };
  const mover = (i: number, d: number) => { const l = [...ids]; [l[i], l[i + d]] = [l[i + d], l[i]]; onIds(l); };
  return (
    <div className="fondos">
      {ids.map((id, i) => (
        <figure key={id} className="fondos__item">
          <div className="fondos__foto"><img src={urlApi(`/archivos/${id}`)} alt={`Fondo ${i + 1}`} /></div>
          <figcaption>
            <Boton size="sm" variant="ghost" title="Mover antes" disabled={i === 0} onClick={() => mover(i, -1)}>←</Boton>
            <Boton size="sm" variant="ghost" title="Mover después" disabled={i === ids.length - 1} onClick={() => mover(i, 1)}>→</Boton>
            <Boton size="sm" variant="ghost" onClick={() => onIds(ids.filter((x) => x !== id))}>Quitar</Boton>
          </figcaption>
        </figure>
      ))}
      {ids.length < MAX_FONDOS && (
        <button type="button" className="fondos__agregar" disabled={subiendo} onClick={() => ref.current?.click()}>{subiendo ? 'Subiendo…' : '+ Agregar fotos'}</button>
      )}
      <input ref={ref} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => { const l = Array.from(e.target.files ?? []); if (l.length) void subir(l); e.target.value = ''; }} />
    </div>
  );
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
