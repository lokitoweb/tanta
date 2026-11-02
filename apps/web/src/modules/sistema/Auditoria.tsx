import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { Boton, Buscador, Encabezado, Insignia, Tarjeta, Vacio } from '@/ui/primitives';
import { Dialogo } from '@/ui/Dialogo';

interface Evento { id: number; actor: string; rol: string; accion: string; entidad: string; entidadId: string | null; detalle: unknown; creadoEn: string }
interface Verificacion { ok: boolean; total: number; roto?: number }

const tono = (a: string) => /ELIMIN|BLOQUE|REUSO|FALL|ANUL/.test(a) ? 'danger' : /CLAVE|MFA|ROL|CONFIG|PARAMETRO|PRECIO/.test(a) ? 'warn' : 'neutral';

/** Bitácora inmutable: quién hizo qué y cuándo. La cadena de hashes se puede verificar aquí. */
export function Auditoria() {
  const [eventos, setEventos] = useState<Evento[]>([]);
  const [texto, setTexto] = useState('');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [hayMas, setHayMas] = useState(false);
  const [detalle, setDetalle] = useState<Evento | null>(null);
  const [verif, setVerif] = useState<Verificacion | null>(null);

  const consulta = (antesDe?: number) => '?' + new URLSearchParams(Object.entries({ texto, desde, hasta, antesDe: antesDe ? String(antesDe) : '' }).filter(([, v]) => v)).toString();
  const cargar = async (mas = false) => {
    const lote = await api<Evento[]>(`/auditoria${consulta(mas ? eventos.at(-1)?.id : undefined)}`);
    setEventos((e) => (mas ? [...e, ...lote] : lote));
    setHayMas(lote.length === 50);
  };
  useEffect(() => { const t = setTimeout(() => void cargar(), 300); return () => clearTimeout(t); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [texto, desde, hasta]);

  return (
    <>
      <Encabezado titulo="Auditoría" descripcion="Cada acción sensible queda registrada y encadenada con hash: no se puede editar ni borrar."
        acciones={<Boton icono="shield" onClick={() => void api<Verificacion>('/auditoria/verificar').then(setVerif)}>Verificar integridad</Boton>} />
      {verif && (
        <div className={`aviso aviso--${verif.ok ? 'ok' : 'danger'}`} role="status">
          <span className="aviso__icono">{verif.ok ? '✓' : '!'}</span>
          <div><strong>{verif.ok ? 'Cadena íntegra' : 'Cadena alterada'}</strong>
            <p>{verif.ok ? `${verif.total} eventos verificados: ninguno fue modificado.` : `El evento ${verif.roto} no coincide con su hash.`}</p></div>
        </div>
      )}
      <Tarjeta padding="none">
        <div className="card__head card__head--padded">
          <div className="filtros">
            <Buscador valor={texto} onChange={setTexto} placeholder="Usuario o registro…" />
            <label className="filtros__campo"><span>Desde</span><input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} /></label>
            <label className="filtros__campo"><span>Hasta</span><input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} /></label>
          </div>
        </div>
        {eventos.length === 0 ? <Vacio titulo="Sin eventos" detalle="No hay registros con estos filtros." icono="ledger" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Fecha</th><th>Usuario</th><th>Acción</th><th>Registro</th></tr></thead>
            <tbody>{eventos.map((e) => (
              <tr key={e.id} className="is-clickable" onClick={() => setDetalle(e)}>
                <td className="t-muted mono">{e.creadoEn.slice(0, 19).replace('T', ' ')}</td>
                <td><div className="celda-doble"><strong>{e.actor}</strong><span>{e.rol}</span></div></td>
                <td><Insignia tono={tono(e.accion)}>{e.accion.replace(/_/g, ' ').toLowerCase()}</Insignia></td>
                <td className="t-muted">{e.entidad}{e.entidadId ? ` · ${String(e.entidadId).slice(0, 18)}` : ''}</td>
              </tr>))}</tbody>
          </table></div>
        )}
        {hayMas && <div className="form__acciones form__acciones--centro"><Boton onClick={() => void cargar(true)}>Cargar más</Boton></div>}
      </Tarjeta>
      <Dialogo abierto={detalle !== null} titulo={detalle?.accion.replace(/_/g, ' ') ?? ''} descripcion={detalle ? `${detalle.actor} · ${detalle.creadoEn}` : ''}
        onCerrar={() => setDetalle(null)} acciones={<Boton variant="primary" onClick={() => setDetalle(null)}>Cerrar</Boton>}>
        <pre className="json">{JSON.stringify(detalle?.detalle ?? {}, null, 2)}</pre>
      </Dialogo>
    </>
  );
}
