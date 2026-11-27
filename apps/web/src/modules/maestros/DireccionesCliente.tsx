import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { Boton, PilaEsqueleto } from '@/ui/primitives';
import { Dialogo } from '@/ui/Dialogo';
import type { Direccion } from '@/modules/ventas/VentaStock';

type Datos = { direcciones: Direccion[]; maxDirecciones: number };
const vacia = { alias: '', direccion: '', referencia: '', telefono: '' };

/**
 * Direcciones de entrega (OBS-03-04): alias, dirección, referencia y teléfono; editar, marcar como principal y quitar.
 * La misma lista para el cliente (Mi perfil: base /mis-direcciones) y para el personal (Maestros → Clientes).
 * Una sola principal por cliente; los pedidos guardan su copia, así que un cambio no altera el historial.
 */
export function ListaDirecciones({ leer, base, onCambio }: { leer: string; base: string; onCambio?: (texto: string) => void }) {
  const [datos, setDatos] = useState<Datos | null>(null);
  const [form, setForm] = useState(vacia);
  const [editando, setEditando] = useState<string | null>(null); // 'principal', un id o null (nueva)
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const cargar = () => api<Datos>(leer).then(setDatos).catch((e) => setError(e.message));
  useEffect(() => { void cargar(); }, [leer]);
  const hacer = async (fn: () => Promise<unknown>, ok: string) => {
    setOcupado(true); setError(null);
    try { await fn(); await cargar(); setForm(vacia); setEditando(null); onCambio?.(ok); }
    catch (e) { setError(e instanceof Error ? e.message : 'No se pudo guardar.'); } finally { setOcupado(false); }
  };
  if (!datos) return error ? <p className="form__error" role="alert">{error}</p> : <PilaEsqueleto lineas={3} />;
  const clave = (d: Direccion) => d.id ?? 'principal';
  const lleno = datos.direcciones.length >= datos.maxDirecciones;
  const guardar = () => hacer(() => api(editando ? `${base}/${editando}` : base, { method: editando ? 'PATCH' : 'POST', body: {
    alias: form.alias.trim(), direccion: form.direccion.trim(), referencia: form.referencia.trim(), telefono: form.telefono.trim() } }), editando ? 'Dirección actualizada.' : 'Dirección agregada.');
  return (<>
    <table className="table table--compacta"><tbody>
      {datos.direcciones.map((d) => <tr key={clave(d)}>
        <td><strong>{d.alias || (d.principal ? 'Principal' : 'Dirección')}</strong>{d.principal && <> <span className="badge">Principal</span></>}
          <div>{d.direccion}</div>
          {(d.referencia || d.telefono) && <div className="t-muted">{[d.referencia, d.telefono && `Tel. ${d.telefono}`].filter(Boolean).join(' · ')}</div>}</td>
        <td className="t-right t-acciones">
          <Boton size="sm" disabled={ocupado} onClick={() => { setError(null); setEditando(clave(d)); setForm({ alias: d.alias ?? '', direccion: d.direccion, referencia: d.referencia ?? '', telefono: d.telefono ?? '' }); }}>Editar</Boton>
          {!d.principal && <> <Boton size="sm" disabled={ocupado} onClick={() => void hacer(() => api(`${base}/${d.id}/principal`, { method: 'POST' }), 'Dirección principal cambiada.')}>Hacer principal</Boton>
            {' '}<Boton size="sm" disabled={ocupado} onClick={() => void hacer(() => api(`${base}/${d.id}`, { method: 'DELETE' }), 'Dirección quitada.')}>Quitar</Boton></>}
        </td></tr>)}
      {!datos.direcciones.length && <tr><td className="t-muted">Sin direcciones: agrega la primera (será la principal).</td></tr>}
    </tbody></table>
    {lleno && !editando ? <p className="dialogo__nota">Llegó al máximo de {datos.maxDirecciones} direcciones: quita una para agregar otra.</p> : (
      <form className="form form--2col form--dialogo" onSubmit={(e) => { e.preventDefault(); void guardar(); }}>
        <p className="field--ancho card__sub">{editando ? 'Editar dirección' : 'Nueva dirección'}</p>
        <label className="field"><span className="field__label">Alias</span>
          <input className="field__input" maxLength={40} placeholder="Casa, Local, Oficina…" value={form.alias} onChange={(e) => setForm({ ...form, alias: e.target.value })} /></label>
        <label className="field"><span className="field__label">Teléfono de contacto (opcional)</span>
          <input className="field__input" type="tel" maxLength={30} value={form.telefono} onChange={(e) => setForm({ ...form, telefono: e.target.value })} /></label>
        <label className="field field--ancho"><span className="field__label">Dirección</span>
          <input className="field__input" required minLength={5} maxLength={200} placeholder="Calle, número, distrito" value={form.direccion} onChange={(e) => setForm({ ...form, direccion: e.target.value })} /></label>
        <label className="field field--ancho"><span className="field__label">Referencia (opcional)</span>
          <input className="field__input" maxLength={120} value={form.referencia} onChange={(e) => setForm({ ...form, referencia: e.target.value })} /></label>
        <div className="form__acciones field--ancho">
          {editando && <Boton type="button" onClick={() => { setEditando(null); setForm(vacia); }}>Cancelar</Boton>}
          <Boton variant="primary" type="submit" icono={editando ? undefined : 'plus'} disabled={ocupado || form.direccion.trim().length < 5}>{editando ? 'Guardar cambios' : 'Agregar dirección'}</Boton>
        </div>
      </form>)}
    {error && <p className="form__error" role="alert">{error}</p>}
  </>);
}

export function DireccionesCliente({ clienteId, nombre, onCerrar }: { clienteId: string; nombre: string; onCerrar: () => void }) {
  return (
    <Dialogo abierto titulo={`Direcciones de ${nombre}`} descripcion="En los pedidos se elige una de estas · la principal viene marcada" onCerrar={onCerrar}
      acciones={<Boton onClick={onCerrar}>Cerrar</Boton>}>
      <ListaDirecciones leer={`/clientes/${clienteId}/direcciones`} base={`/clientes/${clienteId}/direcciones`} />
    </Dialogo>
  );
}
