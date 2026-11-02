import { useState } from 'react';
import { api } from '@/core/api';
import { exportarExcel, exportarPdf } from '@/core/exportar';
import { Dialogo } from '@/ui/Dialogo';
import { useApp } from '@/core/app-state';
import { money, num, pct } from '@/core/format';
import { Boton, Encabezado, Insignia, Kpi, Progreso, Tarjeta, TarjetaTitulo, Vacio } from '@/ui/primitives';
import { Tabla, type Columna } from '@/ui/Tabla';
import type { Cliente } from '@/core/types';

interface Cxc { id: string; cliente: string; monto: number; saldo: number; venceEn: string; diasVencido: number }
const MEDIOS = ['EFECTIVO', 'TRANSFERENCIA', 'YAPE', 'PLIN'];

export function Cobranza() {
  const { dataset, puede, refrescarDatos } = useApp();
  const k = dataset.kpis;
  const totalAging = dataset.aging.reduce((s, a) => s + a.monto, 0);
  const limiteTotal = dataset.clientes.reduce((s, c) => s + c.limiteCredito, 0);
  const [cuentas, setCuentas] = useState<Cxc[] | null>(null);
  const [pago, setPago] = useState<{ cxcId: string; monto: string; medio: string; referencia: string } | null>(null);
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger'; texto: string } | null>(null);
  const [guardando, setGuardando] = useState(false);

  const abrirPago = async () => {
    setAviso(null);
    const c = await api<Cxc[]>('/cxc');
    setCuentas(c);
    setPago({ cxcId: c[0]?.id ?? '', monto: c[0] ? c[0].saldo.toFixed(2) : '', medio: 'EFECTIVO', referencia: '' });
  };
  const cuenta = cuentas?.find((c) => c.id === pago?.cxcId);
  const registrar = async () => {
    if (!pago) return;
    setGuardando(true);
    try {
      await api('/cobranza', { method: 'POST', conIdempotencia: true, body: { cxcId: pago.cxcId, monto: Number(pago.monto), medio: pago.medio, ...(pago.referencia ? { referencia: pago.referencia } : {}) } });
      setPago(null);
      await refrescarDatos();
      setAviso({ tono: 'ok', texto: `Pago de ${money(Number(pago.monto))} registrado a ${cuenta?.cliente ?? 'la cuenta'}.` });
    } catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo registrar.' }); }
    finally { setGuardando(false); }
  };

  const columnas: Array<Columna<Cliente>> = [
    {
      key: 'nombre', header: 'Cliente',
      render: (c) => (
        <div className="celda-doble">
          <strong>{c.nombre}</strong>
          <span>{c.docTipo} · lista {c.listaPrecio.toLowerCase()}</span>
        </div>
      ),
    },
    { key: 'saldo', header: 'Saldo', align: 'right', render: (c) => <strong>{money(c.saldo)}</strong> },
    {
      key: 'vencido', header: 'Vencido', align: 'right',
      render: (c) => c.vencido > 0
        ? <span className="t-neg">{money(c.vencido)}</span>
        : <span className="t-muted">—</span>,
    },
    { key: 'diasPromedio', header: 'Días prom.', align: 'right', render: (c) => <span className="t-muted">{c.diasPromedio}</span> },
    { key: 'limiteCredito', header: 'Límite', align: 'right', render: (c) => (
      <div className="credito">
        <span className="t-muted">{money(c.limiteCredito)}</span>
        <Progreso valor={c.saldo / Math.max(c.limiteCredito, 1)} tono={c.saldo / Math.max(c.limiteCredito, 1) > 0.8 ? 'danger' : 'ok'} />
      </div>
    ) },
    {
      key: 'estado', header: 'Estado', align: 'right',
      render: (c) => c.vencido > 0
        ? <Insignia tono="danger" punto>Vencido</Insignia>
        : c.saldo > 0 ? <Insignia tono="warn" punto>Al día</Insignia> : <Insignia tono="ok" punto>Sin deuda</Insignia>,
    },
  ];

  return (
    <>
      <Encabezado
        titulo="Cobranza"
        descripcion="Cartera por cliente y antigüedad de saldos · pagos totales o parciales con referencia de operación"
        acciones={<><Boton icono="download" onClick={() => exportarExcel('cuentas-por-cobrar', dataset.clientes.map((c) => ({ ...c })))}>Excel</Boton><Boton icono="report" onClick={exportarPdf}>PDF</Boton>{puede('cobranza.registrar') && <Boton variant="primary" icono="plus" onClick={() => void abrirPago()}>Registrar pago</Boton>}</>}
      />
      {aviso && <div className={`aviso aviso--${aviso.tono}`} role="status"><span className="aviso__icono">{aviso.tono === 'ok' ? '✓' : '!'}</span><div><p>{aviso.texto}</p></div></div>}
      <Dialogo abierto={pago !== null} titulo="Registrar pago" descripcion="Total o parcial. El saldo de la cuenta se actualiza al instante."
        onCerrar={() => setPago(null)}
        acciones={<><Boton onClick={() => setPago(null)}>Cancelar</Boton><Boton variant="primary" disabled={guardando || !cuenta || !(Number(pago?.monto) > 0) || Number(pago?.monto) > (cuenta?.saldo ?? 0) + 0.001} onClick={() => void registrar()}>{guardando ? 'Registrando…' : 'Registrar pago'}</Boton></>}>
        {pago && (cuentas?.length ? (
          <div className="form form--2col form--dialogo">
            <label className="field field--ancho"><span className="field__label">Cuenta por cobrar</span>
              <select className="field__input" value={pago.cxcId} onChange={(e) => { const c = cuentas.find((x) => x.id === e.target.value); setPago({ ...pago, cxcId: e.target.value, monto: c ? c.saldo.toFixed(2) : '' }); }}>
                {cuentas.map((c) => <option key={c.id} value={c.id}>{c.cliente} · saldo {money(c.saldo)} · vence {c.venceEn}</option>)}
              </select></label>
            <label className="field"><span className="field__label">Monto (S/)</span>
              <input className="field__input" type="number" min="0.01" step="0.01" max={cuenta?.saldo} value={pago.monto} onChange={(e) => setPago({ ...pago, monto: e.target.value })} />
              {cuenta && Number(pago.monto) > cuenta.saldo && <span className="field__aviso">Supera el saldo ({money(cuenta.saldo)})</span>}</label>
            <label className="field"><span className="field__label">Medio</span>
              <select className="field__input" value={pago.medio} onChange={(e) => setPago({ ...pago, medio: e.target.value })}>{MEDIOS.map((m) => <option key={m} value={m}>{m[0] + m.slice(1).toLowerCase()}</option>)}</select></label>
            <label className="field field--ancho"><span className="field__label">Referencia (n.° de operación Yape/Plin/transferencia)</span>
              <input className="field__input" maxLength={60} value={pago.referencia} onChange={(e) => setPago({ ...pago, referencia: e.target.value })} /></label>
          </div>
        ) : <p className="t-muted">No hay cuentas por cobrar pendientes.</p>)}
      </Dialogo>

      <div className="grid grid--auto">
        <Kpi label="Total por cobrar" valor={money(k.porCobrar)} nota={`${dataset.clientes.filter((c) => c.saldo > 0).length} clientes`} icono="wallet" />
        <Kpi label="Monto vencido" valor={money(k.vencido)} nota={pct(k.vencido / Math.max(k.porCobrar, 1)) + ' de la cartera'} icono="alert" />
        <Kpi label="Días promedio de cobro" valor={`${k.diasPromedioCobro ?? 0} d`} nota="emisión → pago, últimos 90 días" icono="clock" />
        <Kpi label="Límite de crédito usado" valor={limiteTotal > 0 ? pct(k.porCobrar / limiteTotal) : '—'} nota="sobre el total autorizado" icono="chart" />
      </div>

      <div className="grid grid--12">
        <Tarjeta className="col-5">
          <TarjetaTitulo titulo="Antigüedad de saldos" subtitulo="El reporte que evita perder la cartera" />
          <ul className="aging">
            {dataset.aging.map((a) => (
              <li key={a.rango}>
                <div className="aging__top">
                  <span>{a.rango}</span>
                  <b>{money(a.monto)}</b>
                </div>
                <Progreso valor={totalAging > 0 ? a.monto / totalAging : 0} tono={a.rango.includes('Más de 30') ? 'danger' : a.rango.includes('16') ? 'warn' : 'ink'} />
                <small>{num(a.documentos)} documentos · {totalAging > 0 ? pct(a.monto / totalAging) : '—'}</small>
              </li>
            ))}
          </ul>
        </Tarjeta>

        <Tarjeta className="col-7" padding="none">
          <div className="card__head card__head--padded">
            <div>
              <h3 className="card__title">Cartera por cliente</h3>
              <p className="card__sub">V-01 · deudas por cobrar con antigüedad</p>
            </div>
          </div>
          <Tabla columnas={columnas} filas={dataset.clientes.filter((c) => c.saldo > 0)} clave={(c) => c.id}
            vacio={<Vacio titulo="Sin clientes con deuda" icono="wallet" />} />
        </Tarjeta>
      </div>
    </>
  );
}
