import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { Boton, Encabezado, Insignia, Tarjeta, TablaEsqueleto, Vacio } from '@/ui/primitives';

interface Solicitud { id: string; porcentaje: number; motivo: string; estado: string; creado_en: string; solicitante: string; cliente: string | null; resuelto_por: string | null; vigente: boolean }
const TONO: Record<string, 'warn' | 'ok' | 'danger' | 'ink'> = { PENDIENTE: 'warn', APROBADA: 'ok', RECHAZADA: 'danger', USADA: 'ink' };

/** RN-36 / VEN-07: el Gerente aprueba o rechaza descuentos sobre el máximo. La aprobación vale 24 h y una sola venta. */
export function Aprobaciones() {
  const [filas, setFilas] = useState<Solicitud[] | null>(null);
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger'; texto: string } | null>(null);
  const [cargaError, setCargaError] = useState<string | null>(null);
  const cargar = () => api<Solicitud[]>('/descuentos/solicitudes').then((f) => { setFilas(f); setCargaError(null); }).catch((e) => setCargaError(e.message));
  useEffect(() => { void cargar(); }, []);
  const resolver = async (s: Solicitud, aprobar: boolean) => {
    try {
      await api(`/descuentos/solicitudes/${s.id}/resolver`, { method: 'POST', body: { aprobar } });
      setAviso({ tono: 'ok', texto: `Descuento de ${Math.round(s.porcentaje * 100)} % para ${s.solicitante} ${aprobar ? 'aprobado por 24 h' : 'rechazado'}.` });
    } catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo resolver.' }); }
    await cargar();
  };

  return (
    <>
      <Encabezado titulo="Aprobaciones" descripcion="Descuentos mayores al máximo permitido · últimos 30 días" />
      {aviso && <div className={`aviso aviso--${aviso.tono}`} role="status"><span className="aviso__icono">{aviso.tono === 'ok' ? '✓' : '!'}</span><div><p>{aviso.texto}</p></div></div>}
      <Tarjeta padding="none">
        {cargaError ? <Vacio titulo="No se pudo cargar" detalle={cargaError} onReintentar={() => { setCargaError(null); setFilas(null); void cargar(); }} />
          : filas === null ? <TablaEsqueleto columnas={7} />
          : !filas.length ? <Vacio titulo="Sin solicitudes" icono="check" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Fecha</th><th>Vendedor</th><th>Cliente</th><th className="t-right">Descuento</th><th>Motivo</th><th>Estado</th><th /></tr></thead>
            <tbody>{filas.map((s) => (
              <tr key={s.id}>
                <td>{new Date(s.creado_en).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' })}</td><td>{s.solicitante}</td><td>{s.cliente ?? '—'}</td>
                <td className="t-right"><strong>{Math.round(s.porcentaje * 1000) / 10} %</strong></td><td>{s.motivo}</td>
                <td><Insignia tono={TONO[s.estado]} punto>{s.estado.toLowerCase()}{s.resuelto_por ? ` · ${s.resuelto_por}` : ''}</Insignia></td>
                <td className="t-right">{s.estado === 'PENDIENTE' && <><Boton onClick={() => void resolver(s, false)}>Rechazar</Boton> <Boton variant="primary" onClick={() => void resolver(s, true)}>Aprobar</Boton></>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Tarjeta>
    </>
  );
}
