import { useEffect, useMemo, useState } from 'react';
import { api } from '@/core/api';
import { Dialogo } from '@/ui/Dialogo';
import { Boton, Buscador, Encabezado, Insignia, PilaEsqueleto, Tarjeta, TarjetaTitulo, Vacio } from '@/ui/primitives';

interface ClienteAviso { id: string; nombre: string; cuentas: number }
interface Enviado { id: string; titulo: string; cuerpo: string; todos: boolean; clientes: number; usuarios: number; enviadoPor: string; fecha: string }
interface Datos { clientes: ClienteAviso[]; historial: Enviado[] }

const fecha = (x: string) => new Date(x).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' });
const VACIO = { titulo: '', cuerpo: '' };

/** Promociones y comunicados a todos los clientes o a los elegidos. Llegan a quienes tienen cuenta en la app. */
export function AvisosClientes() {
  const [datos, setDatos] = useState<Datos | null>(null);
  const [cargaError, setCargaError] = useState<string | null>(null);
  const [form, setForm] = useState(VACIO);
  const [todos, setTodos] = useState(true);
  const [elegidos, setElegidos] = useState<string[]>([]);
  const [buscar, setBuscar] = useState('');
  const [confirmar, setConfirmar] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger'; texto: string } | null>(null);

  const cargar = () => api<Datos>('/avisos-clientes').then((d) => { setDatos(d); setCargaError(null); }).catch((e) => setCargaError(e.message));
  useEffect(() => { void cargar(); }, []);

  const conApp = useMemo(() => (datos?.clientes ?? []).filter((c) => c.cuentas > 0), [datos]);
  const lista = (datos?.clientes ?? []).filter((c) => c.nombre.toLowerCase().includes(buscar.trim().toLowerCase()));
  const destinos = todos ? conApp.length : elegidos.length;
  const sinApp = (datos?.clientes.length ?? 0) - conApp.length;
  const problema = form.titulo.trim().length < 3 ? 'Escribe un título.' : form.cuerpo.trim().length < 5 ? 'Escribe el mensaje.'
    : destinos === 0 ? (todos ? 'Ningún cliente tiene cuenta en la app.' : 'Elige al menos un cliente.') : null;
  const alternar = (id: string) => setElegidos((e) => (e.includes(id) ? e.filter((x) => x !== id) : [...e, id]));

  const enviar = async () => {
    setEnviando(true);
    try {
      const r = await api<{ clientes: number }>('/avisos-clientes', { method: 'POST', body: { titulo: form.titulo.trim(), cuerpo: form.cuerpo.trim(), todos, clienteIds: todos ? [] : elegidos } });
      setForm(VACIO); setElegidos([]); setTodos(true);
      setAviso({ tono: 'ok', texto: `Aviso enviado a ${r.clientes} cliente(s).` });
      await cargar();
    } catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo enviar.' }); }
    finally { setEnviando(false); setConfirmar(false); }
  };

  return (
    <>
      <Encabezado titulo="Avisos a clientes" descripcion="Promociones y comunicados · llegan a la campana y como notificación del celular" />
      {aviso && <div className={`aviso aviso--${aviso.tono}`} role="status"><span className="aviso__icono">{aviso.tono === 'ok' ? '✓' : '!'}</span><div><p>{aviso.texto}</p></div></div>}

      <Dialogo abierto={confirmar} titulo="¿Enviar este aviso?" descripcion={`Lo recibirán ${destinos} cliente(s). Una vez enviado no se puede retirar.`}
        onCerrar={() => setConfirmar(false)}
        acciones={<><Boton onClick={() => setConfirmar(false)}>Cancelar</Boton><Boton variant="primary" disabled={enviando} onClick={() => void enviar()}>{enviando ? 'Enviando…' : 'Enviar aviso'}</Boton></>}>
        <p><strong>{form.titulo}</strong></p>
        <p className="t-muted">{form.cuerpo}</p>
      </Dialogo>

      {cargaError ? <Tarjeta><Vacio titulo="No se pudo cargar" detalle={cargaError} onReintentar={() => { setCargaError(null); void cargar(); }} /></Tarjeta>
        : datos === null ? <Tarjeta><PilaEsqueleto lineas={4} /></Tarjeta> : (
        <div className="grid grid--12">
          <Tarjeta className="col-7">
            <TarjetaTitulo titulo="Nuevo aviso" subtitulo="Revisa bien el texto: no se puede retirar después de enviarlo" />
            <div className="form">
              <label className="field"><span className="field__label">Título</span>
                <input className="field__input" maxLength={80} placeholder="Ej.: 2x1 en pan francés este sábado" value={form.titulo} onChange={(e) => setForm({ ...form, titulo: e.target.value })} /></label>
              <label className="field"><span className="field__label">Mensaje</span>
                <textarea className="field__input" rows={4} maxLength={300} value={form.cuerpo} onChange={(e) => setForm({ ...form, cuerpo: e.target.value })} />
                <span className="field__ayuda">{form.cuerpo.length} de 300 caracteres</span></label>
              <fieldset className="avisos-destino">
                <legend className="field__label">Para quién</legend>
                <label><input type="radio" checked={todos} onChange={() => setTodos(true)} /> Todos los clientes con app ({conApp.length})</label>
                <label><input type="radio" checked={!todos} onChange={() => setTodos(false)} /> Elegir clientes{!todos && elegidos.length > 0 ? ` (${elegidos.length})` : ''}</label>
              </fieldset>
              {!todos && (
                <div className="avisos-clientes">
                  <Buscador valor={buscar} onChange={setBuscar} placeholder="Buscar cliente…" />
                  {lista.map((c) => (
                    <label key={c.id} className={c.cuentas ? '' : 'is-sin-app'}>
                      <input type="checkbox" disabled={!c.cuentas} checked={elegidos.includes(c.id)} onChange={() => alternar(c.id)} />
                      <span>{c.nombre}</span>
                      {!c.cuentas && <Insignia tono="warn">Sin app</Insignia>}
                    </label>
                  ))}
                </div>
              )}
              {sinApp > 0 && <span className="field__aviso">{sinApp} de {datos.clientes.length} clientes aún no tienen cuenta en la app: no recibirán el aviso.</span>}
              <div className="fila-acciones">
                <Boton variant="primary" icono="bell" disabled={problema !== null} onClick={() => { setAviso(null); setConfirmar(true); }}>Enviar aviso</Boton>
                {problema && <span className="t-muted">{problema}</span>}
              </div>
            </div>
          </Tarjeta>

          <Tarjeta className="col-5">
            <TarjetaTitulo titulo="Enviados" subtitulo="Últimos 50 avisos" />
            {datos.historial.length === 0 ? <Vacio titulo="Aún no se envían avisos" icono="bell" /> : (
              <ul className="avisos-enviados">
                {datos.historial.map((a) => (
                  <li key={a.id}>
                    <strong>{a.titulo}</strong>
                    <p>{a.cuerpo}</p>
                    <small>{fecha(a.fecha)} · {a.enviadoPor} · {a.todos ? 'todos' : 'elegidos'} · {a.clientes} cliente(s)</small>
                  </li>
                ))}
              </ul>
            )}
          </Tarjeta>
        </div>
      )}
    </>
  );
}
