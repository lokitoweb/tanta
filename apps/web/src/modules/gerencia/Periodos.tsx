import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { useApp } from '@/core/app-state';
import { money, pct } from '@/core/format';
import { Boton, Encabezado, Insignia, Tarjeta } from '@/ui/primitives';
import { Dialogo } from '@/ui/Dialogo';

interface Periodo {
  id: string; anio: number; mes: number; estado: 'ABIERTO' | 'CALCULADO' | 'CERRADO';
  cifTotal: number; cerradoEn: string | null; ventas: number; netas: number;
}

const MES = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre'];

export function Periodos() {
  const { refrescarDatos } = useApp();
  const [periodos, setPeriodos] = useState<Periodo[]>([]);
  const [confirmar, setConfirmar] = useState<Periodo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trabajando, setTrabajando] = useState(false);
  const [cargando, setCargando] = useState(true);

  const cargar = async () => {
    try {
      setPeriodos(await api<Periodo[]>('/periodos'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudieron cargar los períodos.');
    } finally {
      setCargando(false);
    }
  };

  useEffect(() => { void cargar(); }, []);

  const cerrar = async () => {
    if (!confirmar) return;
    setTrabajando(true);
    setError(null);
    try {
      await api(`/periodos/${confirmar.id}/cerrar`, { method: 'POST' });
      setConfirmar(null);
      await cargar();
      await refrescarDatos();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cerrar el período.');
    } finally {
      setTrabajando(false);
    }
  };

  const tono = (e: string) => (e === 'CERRADO' ? 'ok' : e === 'CALCULADO' ? 'info' : 'warn') as 'ok' | 'info' | 'warn';

  return (
    <>
      <Encabezado
        titulo="Períodos de costo"
        descripcion="Al cerrar un período el margen pasa de provisional a definitivo. Es la única operación que congela la historia."
      />

      {error && <div className="aviso aviso--danger"><span className="aviso__icono">!</span><div><strong>Error</strong><p>{error}</p></div></div>}

      <Tarjeta padding="none">
        <div className="card__head card__head--padded">
          <div>
            <h3 className="card__title">Períodos</h3>
            <p className="card__sub">Un período cerrado no se puede reabrir sin una acción auditada de Gerencia</p>
          </div>
        </div>

        {cargando ? (
          <div className="tabla-cargando">Cargando períodos…</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Período</th>
                  <th className="t-right">Ventas netas</th>
                  <th className="t-right">CIF</th>
                  <th className="t-right">Estado</th>
                  <th className="t-right">Cerrado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {periodos.map((p) => (
                  <tr key={p.id}>
                    <td><strong>{MES[p.mes]} {p.anio}</strong></td>
                    <td className="t-right">{money(p.netas)}</td>
                    <td className="t-right t-muted">{money(p.cifTotal)}</td>
                    <td className="t-right"><Insignia tono={tono(p.estado)} punto>{p.estado}</Insignia></td>
                    <td className="t-right t-muted">{p.cerradoEn ? new Date(p.cerradoEn).toLocaleDateString('es-PE') : '—'}</td>
                    <td className="t-right">
                      {p.estado === 'CERRADO' ? (
                        <span className="t-muted">Definitivo</span>
                      ) : (
                        <Boton size="sm" variant="primary" onClick={() => setConfirmar(p)}>Cerrar período</Boton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Tarjeta>

      <Dialogo
        abierto={confirmar !== null}
        titulo="Cerrar el período de costos"
        descripcion="Esta acción congela el margen del período. No se puede deshacer sin una reapertura auditada."
        onCerrar={() => setConfirmar(null)}
        acciones={
          <>
            <Boton onClick={() => setConfirmar(null)}>Cancelar</Boton>
            <Boton variant="primary" onClick={() => void cerrar()} disabled={trabajando}>
              {trabajando ? 'Cerrando…' : 'Sí, cerrar el período'}
            </Boton>
          </>
        }
      >
        {confirmar && (
          <dl className="datos">
            <div><dt>Período</dt><dd>{MES[confirmar.mes]} {confirmar.anio}</dd></div>
            <div><dt>Ventas netas</dt><dd>{money(confirmar.netas)}</dd></div>
            <div><dt>Documentos</dt><dd>{confirmar.ventas}</dd></div>
            <div><dt>Margen actual</dt><dd>{pct(0)}</dd></div>
          </dl>
        )}
        <p className="dialogo__nota">
          Después del cierre, el dashboard mostrará los datos como <strong>definitivos</strong> y los
          reportes dejarán de recalcularse con la receta actual.
        </p>
      </Dialogo>
    </>
  );
}
