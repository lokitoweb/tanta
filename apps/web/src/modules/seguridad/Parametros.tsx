import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { useApp } from '@/core/app-state';
import { Boton, Encabezado, Insignia, Tarjeta, TablaEsqueleto, TarjetaTitulo, Vacio } from '@/ui/primitives';
import { Icon } from '@/ui/icons';

interface Parametro { clave: string; valor: string; tipo: string; descripcion: string }

const ETIQUETAS: Record<string, string> = {
  igv: 'IGV vigente',
  moneda: 'Moneda',
  margen_objetivo_global: 'Margen objetivo global',
  permitir_saldo_negativo: 'Permitir saldo negativo',
  hora_corte_mismo_dia: 'Hora de corte para entrega el mismo día',
};

export function Parametros() {
  const { refrescarDatos } = useApp();
  // null = cargando (esqueleto).
  const [lista, setFilas] = useState<Parametro[] | null>(null);
  const filas = lista ?? [];
  const [editando, setEditando] = useState<string | null>(null);
  const [valor, setValor] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [cargaError, setCargaError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const cargar = async () => {
    try {
      setFilas(await api<Parametro[]>('/parametros'));
      setCargaError(null);
    } catch (e) {
      setCargaError(e instanceof Error ? e.message : 'No se pudieron cargar los parámetros.');
    }
  };
  const recargar = () => { setCargaError(null); setFilas(null); void cargar(); };

  useEffect(() => { void cargar(); }, []);

  const abrir = (p: Parametro) => {
    setEditando(p.clave);
    setValor(p.valor);
    setError(null);
  };

  const guardar = async () => {
    if (!editando) return;
    setGuardando(true);
    setError(null);
    try {
      await api(`/parametros/${editando}`, { method: 'PATCH', body: { valor } });
      setEditando(null);
      await cargar();
      await refrescarDatos();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar.');
    } finally {
      setGuardando(false);
    }
  };

  const formatear = (p: Parametro) => {
    if (p.tipo === 'porcentaje') return `${(Number(p.valor) * 100).toFixed(2)} %`;
    if (p.tipo === 'booleano') return p.valor === 'true' ? 'Sí' : 'No';
    return p.valor;
  };

  return (
    <>
      <Encabezado
        titulo="Parámetros del sistema"
        descripcion="Lo que se cambia aquí afecta a todo el sistema de inmediato. Cada cambio queda registrado con su valor anterior."
      />

      {error && <div className="aviso aviso--danger"><span className="aviso__icono">!</span><div><strong>No se pudo aplicar</strong><p>{error}</p></div></div>}

      <div className="grid grid--12">
        <Tarjeta className="col-8" padding="none">
          <div className="card__head card__head--padded">
            <div>
              <h3 className="card__title">Valores vigentes</h3>
              <p className="card__sub">{filas.length} parámetros · el IGV se aplica a toda venta nueva</p>
            </div>
            <Boton variant="ghost" icono="sync" onClick={recargar}>Recargar</Boton>
          </div>

          {cargaError ? <Vacio titulo="No se pudo cargar" detalle={cargaError} onReintentar={recargar} />
            : lista === null ? <TablaEsqueleto filas={4} columnas={4} />
            : filas.length === 0 ? <Vacio titulo="Sin parámetros" icono="settings" />
            : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Parámetro</th>
                    <th>Clave</th>
                    <th className="t-right">Valor</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filas.map((p) => (
                    <tr key={p.clave}>
                      <td>
                        <div className="celda-doble">
                          <strong>{ETIQUETAS[p.clave] ?? p.clave}</strong>
                          <span>{p.descripcion}</span>
                        </div>
                      </td>
                      <td><span className="mono t-muted">{p.clave}</span></td>
                      <td className="t-right">
                        {editando === p.clave ? (
                          <input
                            className="field__input field__input--mini"
                            value={valor}
                            onChange={(e) => setValor(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') void guardar(); }}
                            autoFocus
                          />
                        ) : (
                          <strong>{formatear(p)}</strong>
                        )}
                      </td>
                      <td className="t-right">
                        {editando === p.clave ? (
                          <div className="acciones-fila">
                            <Boton size="sm" variant="primary" onClick={() => void guardar()} disabled={guardando}>
                              {guardando ? '…' : 'Guardar'}
                            </Boton>
                            <Boton size="sm" variant="ghost" onClick={() => setEditando(null)}>Cancelar</Boton>
                          </div>
                        ) : (
                          <Boton size="sm" icono="settings" onClick={() => abrir(p)}>Editar</Boton>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Tarjeta>

        <Tarjeta className="col-4">
          <TarjetaTitulo titulo="Cómo funciona" subtitulo="Diseño que protege al negocio" />
          <ul className="notas">
            <li>
              <Icon name="shield" size={16} />
              <div>
                <strong>Los porcentajes se guardan como fracción</strong>
                <p>0,18 es 18 %. Si escribes 18 se rechaza: evita un IGV de 1800 %.</p>
              </div>
            </li>
            <li>
              <Icon name="ledger" size={16} />
              <div>
                <strong>Historial completo</strong>
                <p>Cada cambio guarda el valor anterior, el nuevo y quién lo hizo.</p>
              </div>
            </li>
            <li>
              <Icon name="alert" size={16} />
              <div>
                <strong>El IGV afecta ventas nuevas</strong>
                <p>Las ventas ya registradas conservan su precio neto congelado.</p>
              </div>
            </li>
          </ul>
          <div className="notas__pie">
            <Insignia tono="ok" punto>Cambios auditados</Insignia>
          </div>
        </Tarjeta>
      </div>
      <Series />
    </>
  );
}

/** MAE-14: series de nota de venta y recibo. Una serie nueva reemplaza a la activa; los números nunca se reutilizan. */
function Series() {
  // null = cargando (esqueleto).
  const [series, setSeries] = useState<Array<{ tipo: string; serie: string; correlativoActual: number; activo: boolean }> | null>(null);
  const [nueva, setNueva] = useState({ tipo: 'NOTA_VENTA', serie: '' });
  const [mensaje, setMensaje] = useState('');
  const [cargaError, setCargaError] = useState<string | null>(null);
  const cargar = () => api<NonNullable<typeof series>>('/series').then((s) => { setSeries(s); setCargaError(null); }).catch((e) => setCargaError(e.message));
  useEffect(() => { void cargar(); }, []);
  const crear = async () => {
    try { await api('/series', { method: 'POST', body: nueva }); setMensaje(`Serie ${nueva.serie.toUpperCase()} activa.`); setNueva({ ...nueva, serie: '' }); await cargar(); }
    catch (e) { setMensaje(e instanceof Error ? e.message : 'No se pudo crear.'); }
  };
  return (
    <Tarjeta>
      <TarjetaTitulo titulo="Series de comprobantes" subtitulo="Nota de venta y recibo de cobranza · correlativo único" />
      {cargaError ? <Vacio titulo="No se pudo cargar" detalle={cargaError} onReintentar={() => { setCargaError(null); setSeries(null); void cargar(); }} />
        : series === null ? <TablaEsqueleto filas={2} columnas={4} />
        : <div className="table-wrap"><table className="table table--compacta">
        <thead><tr><th>Tipo</th><th>Serie</th><th className="t-right">Último número</th><th>Estado</th></tr></thead>
        <tbody>{series.map((s) => <tr key={s.tipo + s.serie}><td>{s.tipo === 'RECIBO' ? 'Recibo' : 'Nota de venta'}</td><td>{s.serie}</td><td className="t-right">{s.correlativoActual}</td>
          <td><Insignia tono={s.activo ? 'ok' : 'neutral'} punto>{s.activo ? 'Activa' : 'Histórica'}</Insignia></td></tr>)}</tbody>
      </table></div>}
      <div className="form form--2col">
        <label className="field"><span className="field__label">Tipo</span>
          <select className="field__input" value={nueva.tipo} onChange={(e) => setNueva({ ...nueva, tipo: e.target.value })}><option value="NOTA_VENTA">Nota de venta</option><option value="RECIBO">Recibo</option></select></label>
        <label className="field"><span className="field__label">Nueva serie (4 caracteres)</span>
          <input className="field__input" maxLength={4} value={nueva.serie} onChange={(e) => setNueva({ ...nueva, serie: e.target.value.toUpperCase() })} /></label>
      </div>
      <div className="form__acciones">{mensaje && <span className="t-muted">{mensaje}</span>}<Boton variant="primary" disabled={!/^[A-Z0-9]{4}$/.test(nueva.serie)} onClick={() => void crear()}>Activar serie</Boton></div>
    </Tarjeta>
  );
}
