import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { useApp } from '@/core/app-state';
import { money, num2 as num } from '@/core/format';
import { Dialogo } from '@/ui/Dialogo';
import { Boton, Encabezado, Insignia, Tarjeta, Vacio } from '@/ui/primitives';

interface Conteo { id: string; codigo: string; estado: string; observacion: string; motivoRechazo: string | null; fecha: string; registradoPor: string; resueltoPor: string | null;
  items: Array<{ insumo: string; unidad: string; sistema: number; contado: number; diferencia: number; valor?: number }> }
const TONO: Record<string, 'warn' | 'ok' | 'danger'> = { PENDIENTE: 'warn', APROBADO: 'ok', RECHAZADO: 'danger' };

/** Conteo físico (M05): el Almacén cuenta y envía; el Gerente aprueba y recién entonces se ajusta el stock. */
export function Conteos() {
  const { dataset, puede, refrescarDatos } = useApp();
  const [conteos, setConteos] = useState<Conteo[]>([]);
  const [contado, setContado] = useState<Record<string, string> | null>(null);
  const [observacion, setObservacion] = useState('');
  const [ver, setVer] = useState<Conteo | null>(null);
  const [motivo, setMotivo] = useState('');
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger'; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const cargar = () => api<Conteo[]>('/conteos').then(setConteos).catch((e) => setAviso({ tono: 'danger', texto: e.message }));
  useEffect(() => { void cargar(); }, []);
  const accion = async (fn: () => Promise<string>) => {
    setOcupado(true);
    try { const t = await fn(); await Promise.all([cargar(), refrescarDatos()]); setAviso({ tono: 'ok', texto: t }); }
    catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo completar.' }); }
    finally { setOcupado(false); }
  };

  const insumos = dataset.insumos;
  const llenos = contado ? Object.entries(contado).filter(([, v]) => v.trim() !== '' && Number(v) >= 0) : [];
  const enviar = () => accion(async () => {
    const r = await api<{ codigo: string; diferencias: number }>('/conteos', { method: 'POST', body: { observacion, items: llenos.map(([insumoId, v]) => ({ insumoId, contado: Number(v) })) } });
    setContado(null);
    setObservacion('');
    return `Conteo ${r.codigo} enviado a aprobación con ${r.diferencias} diferencia(s).`;
  });
  const resolver = (k: Conteo, aprobar: boolean) => accion(async () => {
    const r = await api<{ ajustes: number }>(`/conteos/${k.id}/resolver`, { method: 'POST', body: { aprobar, motivo } });
    setVer(null);
    setMotivo('');
    return aprobar ? `${k.codigo} aprobado: ${r.ajustes} ajuste(s) en el kárdex.` : `${k.codigo} rechazado.`;
  });

  return (
    <>
      <Encabezado titulo="Conteo físico" descripcion="Conteo contra el sistema · las diferencias se ajustan solo con aprobación del Gerente"
        acciones={puede('inventario.mover') && <Boton variant="primary" icono="plus" onClick={() => setContado({})}>Nuevo conteo</Boton>} />
      {aviso && <div className={`aviso aviso--${aviso.tono}`} role="status"><span className="aviso__icono">{aviso.tono === 'ok' ? '✓' : '!'}</span><div><p>{aviso.texto}</p></div></div>}

      <Dialogo abierto={contado !== null} titulo="Nuevo conteo" descripcion="Ingresa lo contado; deja en blanco lo que no contaste."
        onCerrar={() => setContado(null)}
        acciones={<><Boton onClick={() => setContado(null)}>Cancelar</Boton><Boton variant="primary" disabled={!llenos.length || ocupado} onClick={() => void enviar()}>Enviar a aprobación ({llenos.length})</Boton></>}>
        {contado && (<>
          <table className="table table--compacta">
            <thead><tr><th>Insumo</th><th className="t-right">Sistema</th><th className="t-right">Contado</th><th className="t-right">Diferencia</th></tr></thead>
            <tbody>{insumos.map((i) => {
              const v = contado[i.id] ?? '';
              const d = v.trim() === '' ? null : Number(v) - i.stock;
              return (
                <tr key={i.id}>
                  <td>{i.nombre}</td><td className="t-right">{num(i.stock)} {i.unidad.toLowerCase()}</td>
                  <td><input className="field__input t-right" type="number" min="0" step="0.001" value={v} onChange={(e) => setContado({ ...contado, [i.id]: e.target.value })} /></td>
                  <td className={`t-right ${d && d < 0 ? 't-neg' : ''}`}>{d === null ? '—' : Math.abs(d) < 0.0005 ? 'OK' : num(d)}</td>
                </tr>
              );
            })}</tbody>
          </table>
          <label className="field"><span className="field__label">Observación</span>
            <input className="field__input" maxLength={200} placeholder="Inventario mensual" value={observacion} onChange={(e) => setObservacion(e.target.value)} /></label>
        </>)}
      </Dialogo>

      <Dialogo abierto={ver !== null} titulo={`Conteo ${ver?.codigo ?? ''}`} descripcion={ver ? `${ver.registradoPor} · ${new Date(ver.fecha).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' })}${ver.observacion ? ` · ${ver.observacion}` : ''}` : ''}
        onCerrar={() => setVer(null)}
        acciones={ver?.estado === 'PENDIENTE' && puede('conteo.aprobar')
          ? <><Boton disabled={ocupado || motivo.trim().length < 3} onClick={() => void resolver(ver, false)}>Rechazar</Boton><Boton variant="primary" disabled={ocupado} onClick={() => void resolver(ver, true)}>Aprobar y ajustar</Boton></>
          : <Boton onClick={() => setVer(null)}>Cerrar</Boton>}>
        {ver && (<>
          <table className="table table--compacta">
            <thead><tr><th>Insumo</th><th className="t-right">Sistema</th><th className="t-right">Contado</th><th className="t-right">Diferencia</th>{ver.items[0]?.valor !== undefined && <th className="t-right">Valor</th>}</tr></thead>
            <tbody>{ver.items.map((i) => (
              <tr key={i.insumo}><td>{i.insumo}</td><td className="t-right">{num(i.sistema)}</td><td className="t-right">{num(i.contado)}</td>
                <td className={`t-right ${i.diferencia < 0 ? 't-neg' : ''}`}>{Math.abs(i.diferencia) < 0.0005 ? 'OK' : num(i.diferencia)}</td>
                {i.valor !== undefined && <td className="t-right">{money(i.valor)}</td>}</tr>
            ))}</tbody>
          </table>
          {ver.motivoRechazo && <p className="dialogo__nota">Motivo del rechazo: {ver.motivoRechazo}</p>}
          {ver.estado === 'PENDIENTE' && puede('conteo.aprobar') && (
            <label className="field"><span className="field__label">Motivo (solo para rechazar)</span>
              <input className="field__input" maxLength={200} value={motivo} onChange={(e) => setMotivo(e.target.value)} /></label>
          )}
        </>)}
      </Dialogo>

      <Tarjeta padding="none">
        {!conteos.length ? <Vacio titulo="Sin conteos registrados" icono="clipboard" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Código</th><th>Fecha</th><th>Registró</th><th className="t-right">Ítems</th><th className="t-right">Diferencias</th><th>Estado</th></tr></thead>
            <tbody>{conteos.map((k) => (
              <tr key={k.id} className="is-clickable" onClick={() => setVer(k)}>
                <td><strong>{k.codigo}</strong></td><td>{new Date(k.fecha).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' })}</td><td>{k.registradoPor}</td>
                <td className="t-right">{k.items.length}</td><td className="t-right">{k.items.filter((i) => Math.abs(i.diferencia) >= 0.0005).length}</td>
                <td><Insignia tono={TONO[k.estado]} punto>{k.estado.toLowerCase()}{k.resueltoPor ? ` · ${k.resueltoPor}` : ''}</Insignia></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Tarjeta>
    </>
  );
}
