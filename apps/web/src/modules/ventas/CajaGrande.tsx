import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { useApp } from '@/core/app-state';
import { money } from '@/core/format';
import { exportarExcel } from '@/core/exportar';
import { Dialogo } from '@/ui/Dialogo';
import { Boton, Encabezado, Insignia, Kpi, Tarjeta, TablaEsqueleto, Vacio } from '@/ui/primitives';

interface Cuenta { codigo: string; nombre: string; tipo: 'EFECTIVO' | 'BANCO' | 'BILLETERA'; banco: string | null; numero: string | null; activo: boolean; saldo: number }
interface Movimiento { codigo: string; cuenta: string; cuentaNombre: string; tipo: string; monto: number; concepto: string; referencia: string | null; estado: string; fecha: string; usuario: string; motivoAnulacion: string | null }
interface Datos { cuentas: Cuenta[]; total: number; movimientos: Movimiento[] }
type Form = { tipo: 'DEPOSITO' | 'SALDO_INICIAL' | 'AJUSTE'; cuenta: string; cuentaDestino: string; monto: string; signo: 1 | -1; concepto: string; nroOperacion: string };

const TIPO: Record<string, string> = {
  SALDO_INICIAL: 'Saldo inicial', AJUSTE: 'Ajuste', RENDICION: 'Rendición de vendedor', ANULACION_COBRO: 'Cobro anulado', CIERRE_CAJA_CHICA: 'Cierre de caja chica', FONDO_CAJA_CHICA: 'Fondo de caja chica',
  PAGO_COMPRA: 'Pago a proveedor', PAGO_COSTO: 'Pago de costo', DEPOSITO_SALIDA: 'Depósito (sale)', DEPOSITO_ENTRADA: 'Depósito (entra)',
};
const MANUALES = new Set(['SALDO_INICIAL', 'AJUSTE', 'DEPOSITO_SALIDA', 'DEPOSITO_ENTRADA']);
const ICONO = { EFECTIVO: 'wallet', BANCO: 'chart', BILLETERA: 'wallet' } as const;
const fecha = (x: string) => new Date(x).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' });

/**
 * Caja grande: donde termina todo el dinero (rendiciones de los vendedores, cierres de caja chica) y de donde salen
 * los pagos grandes a proveedores y costos. Saldo por cuenta, depósito del efectivo al banco y su historial.
 */
export function CajaGrande() {
  const { puede } = useApp();
  const gestiona = puede('caja.grande.gestionar');
  const [datos, setDatos] = useState<Datos | null>(null);
  const [cuenta, setCuenta] = useState('');
  const [cargaError, setCargaError] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [anular, setAnular] = useState<{ codigo: string; motivo: string } | null>(null);
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger'; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const cargar = () => api<Datos>(`/caja-grande${cuenta ? `?cuenta=${encodeURIComponent(cuenta)}` : ''}`)
    .then((d) => { setDatos(d); setCargaError(null); }).catch((e) => setCargaError(e.message));
  useEffect(() => { void cargar(); }, [cuenta]); // eslint-disable-line react-hooks/exhaustive-deps

  const activas = (datos?.cuentas ?? []).filter((k) => k.activo);
  const sinMovimientos = (c: string) => !datos?.movimientos.some((m) => m.cuenta === c && m.estado === 'VIGENTE') && (activas.find((k) => k.codigo === c)?.saldo ?? 0) === 0;
  const abrir = (tipo: Form['tipo']) => {
    const efectivo = activas.find((k) => k.tipo === 'EFECTIVO')?.codigo ?? activas[0]?.codigo ?? '';
    setForm({ tipo, cuenta: efectivo, cuentaDestino: activas.find((k) => k.codigo !== efectivo)?.codigo ?? '', monto: '', signo: 1, concepto: '', nroOperacion: '' });
  };
  const monto = Number(form?.monto);
  const origen = activas.find((k) => k.codigo === form?.cuenta);
  const error = !form ? '' : !(monto > 0) ? 'Indica el monto.'
    : form.tipo === 'DEPOSITO' && form.cuenta === form.cuentaDestino ? 'Elige dos cuentas distintas.'
      : (form.tipo === 'DEPOSITO' || (form.tipo === 'AJUSTE' && form.signo < 0)) && origen && monto > origen.saldo + 0.005 ? `${origen.nombre} solo tiene ${money(origen.saldo)}.`
        : form.tipo === 'AJUSTE' && form.concepto.trim().length < 5 ? 'Indica el motivo del ajuste.' : '';

  const enviar = async () => {
    if (!form) return;
    setOcupado(true);
    try {
      const body = form.tipo === 'DEPOSITO' ? { tipo: 'DEPOSITO', cuenta: form.cuenta, cuentaDestino: form.cuentaDestino, monto, concepto: form.concepto.trim(), nroOperacion: form.nroOperacion.trim() }
        : form.tipo === 'AJUSTE' ? { tipo: 'AJUSTE', cuenta: form.cuenta, monto: monto * form.signo, concepto: form.concepto.trim() }
          : { tipo: 'SALDO_INICIAL', cuenta: form.cuenta, monto, concepto: form.concepto.trim() || 'Saldo inicial' };
      await api('/caja-grande/movimientos', { method: 'POST', body });
      setAviso({ tono: 'ok', texto: form.tipo === 'DEPOSITO' ? `Depósito de ${money(monto)} registrado.` : form.tipo === 'AJUSTE' ? 'Ajuste registrado.' : 'Saldo inicial registrado.' });
      setForm(null);
      await cargar();
    } catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo registrar.' }); }
    finally { setOcupado(false); }
  };
  const anularMov = async () => {
    if (!anular) return;
    setOcupado(true);
    try {
      await api(`/caja-grande/movimientos/${anular.codigo}/anular`, { method: 'POST', body: { motivo: anular.motivo.trim() } });
      setAviso({ tono: 'ok', texto: `Movimiento ${anular.codigo} anulado.` });
      setAnular(null);
      await cargar();
    } catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo anular.' }); }
    finally { setOcupado(false); }
  };

  return (
    <>
      <Encabezado titulo="Caja grande" descripcion="Todo el dinero del negocio por cuenta: lo que rinden los vendedores entra aquí y de aquí salen los pagos grandes"
        acciones={<>
          <Boton icono="download" disabled={!datos?.movimientos.length} onClick={() => exportarExcel('caja-grande', (datos?.movimientos ?? []).map((m) => ({
            Movimiento: m.codigo, Fecha: fecha(m.fecha), Cuenta: m.cuentaNombre, Tipo: TIPO[m.tipo] ?? m.tipo, Concepto: m.concepto, Referencia: m.referencia ?? '',
            Monto: m.monto, Estado: m.estado, Usuario: m.usuario })))}>Excel</Boton>
          {gestiona && <Boton onClick={() => abrir('AJUSTE')}>Ajuste</Boton>}
          {gestiona && <Boton variant="primary" icono="plus" onClick={() => abrir('DEPOSITO')} disabled={activas.length < 2}>Depósito</Boton>}
        </>} />
      {aviso && <div className={`aviso aviso--${aviso.tono}`} role="status"><span className="aviso__icono">{aviso.tono === 'ok' ? '✓' : '!'}</span><div><p>{aviso.texto}</p></div></div>}

      <div className="grid grid--auto">
        <Kpi label="Total en caja grande" valor={datos ? money(datos.total) : '…'} nota={`${activas.length} cuenta(s) activa(s)`} icono="wallet" />
        {activas.map((k) => (
          <button key={k.codigo} type="button" className={`kpi-boton ${cuenta === k.codigo ? 'is-active' : ''}`} onClick={() => setCuenta(cuenta === k.codigo ? '' : k.codigo)} aria-pressed={cuenta === k.codigo}>
            <Kpi label={k.nombre} valor={money(k.saldo)} nota={[k.tipo === 'EFECTIVO' ? 'Efectivo' : k.banco ?? (k.tipo === 'BILLETERA' ? 'Billetera' : 'Banco'), k.numero].filter(Boolean).join(' · ')} icono={ICONO[k.tipo]} />
          </button>
        ))}
      </div>
      {gestiona && activas.some((k) => sinMovimientos(k.codigo)) && (
        <div className="aviso aviso--info" role="status"><span className="aviso__icono">i</span><div>
          <p>Hay cuentas sin saldo inicial. Registra cuánto dinero tiene hoy cada una para empezar a llevar la caja grande.</p>
          <Boton size="sm" onClick={() => { abrir('SALDO_INICIAL'); setForm((f) => f && { ...f, cuenta: activas.find((k) => sinMovimientos(k.codigo))!.codigo }); }}>Registrar saldo inicial</Boton>
        </div></div>
      )}

      <Tarjeta padding="none">
        <div className="card__head card__head--padded">
          <div><h3 className="card__title">Movimientos{cuenta ? ` · ${activas.find((k) => k.codigo === cuenta)?.nombre ?? cuenta}` : ''}</h3>
            <p className="card__sub">Toca una cuenta para ver solo sus movimientos. Nada se borra: lo anulado queda con su motivo.</p></div>
          {cuenta && <Boton size="sm" onClick={() => setCuenta('')}>Ver todas</Boton>}
        </div>
        {cargaError ? <Vacio titulo="No se pudo cargar" detalle={cargaError} onReintentar={() => { setCargaError(null); setDatos(null); void cargar(); }} />
          : datos === null ? <TablaEsqueleto columnas={6} />
          : !datos.movimientos.length ? <Vacio titulo="Sin movimientos" detalle="Empieza registrando el saldo inicial de cada cuenta." icono="wallet" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Fecha</th><th>Cuenta</th><th>Movimiento</th><th>Concepto</th><th className="t-right">Monto</th><th>Estado</th>{gestiona && <th />}</tr></thead>
            <tbody>{datos.movimientos.map((m) => (
              <tr key={m.codigo} className={m.estado === 'ANULADO' ? 'is-anulado' : ''}>
                <td>{fecha(m.fecha)}<div className="t-muted mono">{m.codigo}</div></td>
                <td>{m.cuentaNombre}</td>
                <td>{TIPO[m.tipo] ?? m.tipo}{m.referencia && <div className="t-muted">{m.referencia}</div>}</td>
                <td>{m.concepto}<div className="t-muted">{m.usuario}</div></td>
                <td className={`t-right ${m.monto < 0 ? 't-neg' : ''}`}><strong>{m.monto > 0 ? '+' : ''}{money(m.monto)}</strong></td>
                <td>{m.estado === 'VIGENTE' ? <Insignia tono="ok">Vigente</Insignia> : <span title={m.motivoAnulacion ?? ''}><Insignia tono="neutral">Anulado</Insignia></span>}</td>
                {gestiona && <td>{m.estado === 'VIGENTE' && MANUALES.has(m.tipo) && <Boton size="sm" onClick={() => setAnular({ codigo: m.codigo, motivo: '' })}>Anular</Boton>}</td>}
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Tarjeta>

      <Dialogo abierto={form !== null}
        titulo={form?.tipo === 'DEPOSITO' ? 'Depósito entre cuentas' : form?.tipo === 'AJUSTE' ? 'Ajuste de saldo' : 'Saldo inicial'}
        descripcion={form?.tipo === 'DEPOSITO' ? 'Por ejemplo, el efectivo de la caja fuerte que se deposita al banco.' : form?.tipo === 'AJUSTE' ? 'Corrige una diferencia del saldo con su motivo; queda auditado.' : 'Cuánto dinero tiene hoy la cuenta. Se registra una sola vez por cuenta.'}
        onCerrar={() => setForm(null)}
        acciones={<><Boton onClick={() => setForm(null)}>Cancelar</Boton><Boton variant="primary" disabled={!!error || ocupado} onClick={() => void enviar()}>{ocupado ? 'Guardando…' : 'Registrar'}</Boton></>}>
        {form && (
          <div className="form form--2col form--dialogo">
            <label className="field"><span className="field__label">{form.tipo === 'DEPOSITO' ? 'Sale de' : 'Cuenta'}</span>
              <select className="field__input" value={form.cuenta} onChange={(e) => setForm({ ...form, cuenta: e.target.value })}>
                {activas.filter((k) => form.tipo !== 'SALDO_INICIAL' || sinMovimientos(k.codigo)).map((k) => <option key={k.codigo} value={k.codigo}>{k.nombre} · {money(k.saldo)}</option>)}
              </select></label>
            {form.tipo === 'DEPOSITO' && (
              <label className="field"><span className="field__label">Entra a</span>
                <select className="field__input" value={form.cuentaDestino} onChange={(e) => setForm({ ...form, cuentaDestino: e.target.value })}>
                  {activas.filter((k) => k.codigo !== form.cuenta).map((k) => <option key={k.codigo} value={k.codigo}>{k.nombre} · {money(k.saldo)}</option>)}
                </select></label>
            )}
            {form.tipo === 'AJUSTE' && (
              <label className="field"><span className="field__label">Tipo de ajuste</span>
                <select className="field__input" value={form.signo} onChange={(e) => setForm({ ...form, signo: Number(e.target.value) as 1 | -1 })}>
                  <option value={1}>Sobrante (suma)</option><option value={-1}>Faltante (resta)</option>
                </select></label>
            )}
            <label className="field"><span className="field__label">Monto (S/)</span>
              <input className="field__input" type="number" min="0" step="0.01" autoFocus value={form.monto} onChange={(e) => setForm({ ...form, monto: e.target.value })} /></label>
            {form.tipo === 'DEPOSITO' && (
              <label className="field"><span className="field__label">N.° de operación (opcional)</span>
                <input className="field__input" maxLength={30} value={form.nroOperacion} onChange={(e) => setForm({ ...form, nroOperacion: e.target.value.toUpperCase() })} /></label>
            )}
            <label className="field field--ancho"><span className="field__label">{form.tipo === 'AJUSTE' ? 'Motivo' : 'Concepto (opcional)'}</span>
              <input className="field__input" maxLength={200} value={form.concepto} onChange={(e) => setForm({ ...form, concepto: e.target.value })} /></label>
            {error && <span className="field__aviso field--ancho">{error}</span>}
          </div>
        )}
      </Dialogo>

      <Dialogo abierto={anular !== null} titulo={`Anular ${anular?.codigo ?? ''}`} descripcion="El movimiento no se borra: queda anulado con su motivo. Un depósito se anula completo (sus dos cuentas)."
        onCerrar={() => setAnular(null)}
        acciones={<><Boton onClick={() => setAnular(null)}>Cancelar</Boton><Boton variant="primary" disabled={(anular?.motivo.trim().length ?? 0) < 5 || ocupado} onClick={() => void anularMov()}>Anular</Boton></>}>
        {anular && <label className="field"><span className="field__label">Motivo</span>
          <input className="field__input" autoFocus maxLength={300} value={anular.motivo} onChange={(e) => setAnular({ ...anular, motivo: e.target.value })} /></label>}
      </Dialogo>
    </>
  );
}
