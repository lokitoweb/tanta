import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { Boton, PilaEsqueleto } from '@/ui/primitives';
import { Dialogo } from '@/ui/Dialogo';
import type { Direccion } from '@/modules/ventas/VentaStock';

/**
 * Direcciones de entrega de un cliente (las mismas que él ve y edita en Mi perfil de la app). La principal es la de su ficha;
 * el resto se agregan aquí hasta el máximo de Parámetros (cliente_max_direcciones). En los pedidos se eligen, no se escriben.
 */
export function DireccionesCliente({ clienteId, nombre, onCerrar }: { clienteId: string; nombre: string; onCerrar: () => void }) {
  const [datos, setDatos] = useState<{ direcciones: Direccion[]; maxDirecciones: number } | null>(null);
  const [nueva, setNueva] = useState({ direccion: '', referencia: '' });
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const cargar = () => api<{ direcciones: Direccion[]; maxDirecciones: number }>(`/clientes/${clienteId}/direcciones`).then(setDatos).catch((e) => setError(e.message));
  useEffect(() => { void cargar(); }, [clienteId]);
  const hacer = async (fn: () => Promise<unknown>) => {
    setOcupado(true); setError(null);
    try { await fn(); await cargar(); } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo guardar.'); } finally { setOcupado(false); }
  };
  const lleno = datos ? datos.direcciones.length >= datos.maxDirecciones : true;
  return (
    <Dialogo abierto titulo={`Direcciones de ${nombre}`} descripcion={datos ? `${datos.direcciones.length} de ${datos.maxDirecciones} · en los pedidos se elige una de estas` : ''} onCerrar={onCerrar}
      acciones={<Boton onClick={onCerrar}>Cerrar</Boton>}>
      {!datos ? <PilaEsqueleto lineas={3} /> : <>
        <table className="table table--compacta"><tbody>
          {datos.direcciones.map((d) => <tr key={d.id ?? 'principal'}><td>{d.direccion}{d.referencia && <div className="t-muted">{d.referencia}</div>}</td>
            <td className="t-right">{d.principal ? <span className="t-muted">Principal (se cambia en la ficha)</span>
              : <Boton size="sm" disabled={ocupado} onClick={() => void hacer(() => api(`/clientes/${clienteId}/direcciones/${d.id}`, { method: 'DELETE' }))}>Quitar</Boton>}</td></tr>)}
          {!datos.direcciones.length && <tr><td className="t-muted">Sin direcciones: agrega la primera.</td></tr>}
        </tbody></table>
        {lleno ? <p className="dialogo__nota">Llegó al máximo de direcciones: quita una para agregar otra.</p> : (
          <div className="form form--2col form--dialogo">
            <label className="field field--ancho"><span className="field__label">Nueva dirección</span>
              <input className="field__input" maxLength={200} placeholder="Calle, número, distrito" value={nueva.direccion} onChange={(e) => setNueva({ ...nueva, direccion: e.target.value })} /></label>
            <label className="field"><span className="field__label">Referencia (opcional)</span>
              <input className="field__input" maxLength={120} value={nueva.referencia} onChange={(e) => setNueva({ ...nueva, referencia: e.target.value })} /></label>
            <div className="field"><span className="field__label">&nbsp;</span>
              <Boton variant="primary" disabled={ocupado || nueva.direccion.trim().length < 5}
                onClick={() => void hacer(async () => { await api(`/clientes/${clienteId}/direcciones`, { method: 'POST', body: { direccion: nueva.direccion.trim(), referencia: nueva.referencia.trim() } }); setNueva({ direccion: '', referencia: '' }); })}>Agregar</Boton></div>
          </div>)}
        {error && <p className="form__error" role="alert">{error}</p>}
      </>}
    </Dialogo>
  );
}
