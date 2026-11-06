import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { useCatalogos } from '@/core/catalogos';
import { exportarExcel, exportarPdf } from '@/core/exportar';
import { Dialogo } from '@/ui/Dialogo';
import { Icon } from '@/ui/icons';
import { useApp } from '@/core/app-state';
import { money, num, pct } from '@/core/format';
import { Boton, Encabezado, Insignia, Kpi, PilaEsqueleto, Progreso, Tarjeta, TarjetaTitulo, Vacio } from '@/ui/primitives';
import { Tabla, type Columna } from '@/ui/Tabla';
import type { Cliente } from '@/core/types';
import { DialogoEstadoCuenta, type EstadoCuenta } from './EstadoCuenta';

interface Linea { monto: string; medio: string; referencia: string }
interface Cierre { fecha: string; total: number; porMedio: Array<{ medio: string; monto: number }>; lineas: Array<{ medio: string; vendedor: string; pagos: number; monto: number }> }
const hoy = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);

export function Cobranza() {
  const { dataset, puede, refrescarDatos } = useApp();
  const medios = useCatalogos().mediosPago.filter((m) => m.enCobranza);
  const k = dataset.kpis;
  const totalAging = dataset.aging.reduce((s, a) => s + a.monto, 0);
  const limiteTotal = dataset.clientes.reduce((s, c) => s + c.limiteCredito, 0);
  const deudores = dataset.clientes.filter((c) => c.saldo > 0);
  // Un pago puede llegar en varias formas (p. ej. efectivo + Yape): una línea por forma, un solo recibo.
  const [pago, setPago] = useState<{ clienteId: string; lineas: Linea[] } | null>(null);
  const [cierre, setCierre] = useState<Cierre | null>(null);
  const [fecha, setFecha] = useState(hoy());
  const [estado, setEstado] = useState<EstadoCuenta | null>(null);
  const [cierreError, setCierreError] = useState<string | null>(null);
  const cargarCierre = () => { setCierre(null); setCierreError(null); api<Cierre>(`/cobranza/cierre?fecha=${fecha}`).then(setCierre).catch((e) => setCierreError(e.message)); };
  useEffect(cargarCierre, [fecha, dataset]);
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger'; texto: string } | null>(null);
  const [guardando, setGuardando] = useState(false);

  const lineaNueva = (monto: number, medio = medios[0]?.codigo ?? ''): Linea => ({ monto: monto > 0 ? monto.toFixed(2) : '', medio, referencia: '' });
  const abrirPago = (c = deudores[0]) => { setAviso(null); setPago({ clienteId: c?.id ?? '', lineas: [lineaNueva(c?.saldo ?? 0)] }); };
  const cuenta = deudores.find((c) => c.id === pago?.clienteId);
  const pideOperacion = (medio: string) => !!medios.find((m) => m.codigo === medio)?.requiereOperacion;
  const nombreMedio = (medio: string) => medios.find((m) => m.codigo === medio)?.nombre ?? medio;
  const suma = (pago?.lineas ?? []).reduce((s, l) => s + (Number(l.monto) || 0), 0);
  const queda = (cuenta?.saldo ?? 0) - suma;
  const problema = !pago || !cuenta ? 'Elige el cliente.'
    : pago.lineas.some((l) => !(Number(l.monto) > 0)) ? 'Indica el monto de cada forma de pago.'
    : suma > cuenta.saldo + 0.001 ? `Supera el saldo (${money(cuenta.saldo)}).`
    : pago.lineas.find((l) => pideOperacion(l.medio) && l.referencia.trim().length < 3) ? `Falta el N.° de operación de ${nombreMedio(pago.lineas.find((l) => pideOperacion(l.medio) && l.referencia.trim().length < 3)!.medio)}.`
    : null;
  const cambiarLinea = (i: number, cambio: Partial<Linea>) => pago && setPago({ ...pago, lineas: pago.lineas.map((l, j) => (j === i ? { ...l, ...cambio } : l)) });
  const agregarLinea = () => {
    if (!pago) return;
    const otro = medios.find((m) => !pago.lineas.some((l) => l.medio === m.codigo))?.codigo;
    setPago({ ...pago, lineas: [...pago.lineas, lineaNueva(Math.max(queda, 0), otro)] });
  };
  const registrar = async () => {
    if (!pago) return;
    setGuardando(true);
    try {
      // RN-34: un recibo se aplica a los documentos más antiguos primero.
      const pagos = pago.lineas.map((l) => ({ monto: Number(Number(l.monto).toFixed(2)), medio: l.medio, referencia: l.referencia.trim() }));
      const r = await api<{ numero: string; aplicaciones: unknown[] }>('/cobranza/recibos', { method: 'POST', conIdempotencia: true, body: { clienteId: pago.clienteId, pagos } });
      setPago(null);
      await refrescarDatos();
      setAviso({ tono: 'ok', texto: `Recibo ${r.numero}: ${money(suma)} de ${cuenta?.nombre ?? 'el cliente'}${pagos.length > 1 ? ` (${pagos.map((p) => `${nombreMedio(p.medio).toLowerCase()} ${money(p.monto)}`).join(' + ')})` : ''} aplicado a ${r.aplicaciones.length} documento(s).${queda > 0.009 ? ` Queda ${money(queda)} por cobrar.` : ' Cuenta saldada.'}` });
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
    {
      key: 'id', header: '', align: 'right',
      render: (c) => <Boton onClick={() => void api<EstadoCuenta>(`/estado-cuenta?clienteId=${c.id}`).then(setEstado).catch((e) => setAviso({ tono: 'danger', texto: e.message }))}>Estado de cuenta</Boton>,
    },
  ];

  return (
    <>
      <Encabezado
        titulo="Cobranza"
        descripcion="Cartera por cliente y antigüedad de saldos · pagos totales o parciales con referencia de operación"
        acciones={<><Boton icono="download" onClick={() => exportarExcel('cuentas-por-cobrar', dataset.clientes.map((c) => ({ ...c })))}>Excel</Boton><Boton icono="report" onClick={exportarPdf}>PDF</Boton>{puede('cobranza.registrar') && <Boton variant="primary" icono="plus" onClick={() => abrirPago()}>Registrar pago</Boton>}</>}
      />
      {aviso && <div className={`aviso aviso--${aviso.tono}`} role="status"><span className="aviso__icono">{aviso.tono === 'ok' ? '✓' : '!'}</span><div><p>{aviso.texto}</p></div></div>}
      <Dialogo abierto={pago !== null} titulo="Registrar pago" descripcion="Total o parcial. Se aplica a los documentos más antiguos y genera un recibo."
        onCerrar={() => setPago(null)}
        acciones={<><Boton onClick={() => setPago(null)}>Cancelar</Boton><Boton variant="primary" disabled={guardando || problema !== null} onClick={() => void registrar()}>{guardando ? 'Registrando…' : `Cobrar ${money(suma)}`}</Boton></>}>
        {pago && (deudores.length ? (
          <div className="form form--2col form--dialogo">
            <label className="field field--ancho"><span className="field__label">Cliente</span>
              <select className="field__input" value={pago.clienteId} onChange={(e) => { const c = deudores.find((x) => x.id === e.target.value); setPago({ clienteId: e.target.value, lineas: [lineaNueva(c?.saldo ?? 0)] }); }}>
                {deudores.map((c) => <option key={c.id} value={c.id}>{c.nombre} · debe {money(c.saldo)}</option>)}
              </select></label>
            {pago.lineas.map((l, i) => (
              <div key={i} className="pago-linea field--ancho">
                <label className="field"><span className="field__label">{pago.lineas.length > 1 ? `Forma de pago ${i + 1}` : 'Forma de pago'}</span>
                  <select className="field__input" value={l.medio} onChange={(e) => cambiarLinea(i, { medio: e.target.value })}>{medios.map((m) => <option key={m.codigo} value={m.codigo}>{m.nombre}</option>)}</select></label>
                <label className="field"><span className="field__label">Monto (S/)</span>
                  <input className="field__input" type="number" min="0.01" step="0.01" value={l.monto} onChange={(e) => cambiarLinea(i, { monto: e.target.value })} /></label>
                <label className="field"><span className="field__label">N.° de operación {pideOperacion(l.medio) ? '(obligatorio)' : '(opcional)'}</span>
                  <input className="field__input" maxLength={60} value={l.referencia} onChange={(e) => cambiarLinea(i, { referencia: e.target.value })} /></label>
                {pago.lineas.length > 1 && <button type="button" className="pago-linea__quitar" aria-label="Quitar forma de pago" onClick={() => setPago({ ...pago, lineas: pago.lineas.filter((_, j) => j !== i) })}><Icon name="close" size={16} /></button>}
              </div>
            ))}
            {pago.lineas.length < 5 && <div className="field--ancho"><Boton icono="plus" onClick={agregarLinea}>Agregar otra forma de pago</Boton></div>}
            <div className="pago-resumen field--ancho">
              <span>Cobras <b>{money(suma)}</b></span>
              <span className={queda > 0.009 ? 't-warn' : 't-ok'}>{queda > 0.009 ? <>Queda por cobrar <b>{money(queda)}</b></> : 'Cuenta saldada'}</span>
            </div>
            {problema && <span className="field__aviso field--ancho">{problema}</span>}
          </div>
        ) : <p className="t-muted">No hay cuentas por cobrar pendientes.</p>)}
      </Dialogo>

      <DialogoEstadoCuenta estado={estado} onCerrar={() => setEstado(null)} />

      <div className="grid grid--auto">
        <Kpi label="Total por cobrar" valor={money(k.porCobrar)} nota={`${dataset.clientes.filter((c) => c.saldo > 0).length} clientes`} icono="wallet" />
        <Kpi label="Monto vencido" valor={money(k.vencido)} nota={pct(k.vencido / Math.max(k.porCobrar, 1)) + ' de la cartera'} icono="alert" />
        <Kpi label="Días promedio de cobro" valor={`${k.diasPromedioCobro ?? 0} d`} nota="emisión → pago, últimos 90 días" icono="clock" />
        <Kpi label="Límite de crédito usado" valor={limiteTotal > 0 ? pct(k.porCobrar / limiteTotal) : '—'} nota="sobre el total autorizado" icono="chart" />
      </div>

      <div className="grid grid--12">
        <Tarjeta className="col-8" padding="none">
          <div className="card__head card__head--padded">
            <div>
              <h3 className="card__title">Cartera por cliente</h3>
              <p className="card__sub">V-01 · deudas por cobrar con antigüedad</p>
            </div>
          </div>
          <Tabla columnas={columnas} filas={dataset.clientes.filter((c) => c.saldo > 0)} clave={(c) => c.id} buscar="Buscar cliente…"
            vacio={<Vacio titulo="Sin clientes con deuda" icono="wallet" />} />
        </Tarjeta>

        <Tarjeta className="col-4">
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

        <Tarjeta className="col-12">
          <TarjetaTitulo titulo="Cierre del día" subtitulo={`COB-09 · cobrado ${money(cierre?.total ?? 0)} por forma de pago y vendedor`}
            accion={<input className="field__input" type="date" value={fecha} max={hoy()} onChange={(e) => setFecha(e.target.value)} />} />
          {cierreError ? <Vacio titulo="No se pudo cargar" detalle={cierreError} onReintentar={cargarCierre} />
            : cierre === null ? <PilaEsqueleto lineas={3} />
            : cierre.lineas.length ? (<>
            <p className="t-muted">{cierre.porMedio.map((m) => `${m.medio.toLowerCase()} ${money(m.monto)}`).join(' · ')}</p>
            <table className="table table--compacta"><thead><tr><th>Forma de pago</th><th>Vendedor</th><th className="t-right">Pagos</th><th className="t-right">Monto</th></tr></thead>
              <tbody>{cierre.lineas.map((l, i) => <tr key={i}><td>{l.medio.toLowerCase()}</td><td>{l.vendedor}</td><td className="t-right">{l.pagos}</td><td className="t-right">{money(l.monto)}</td></tr>)}</tbody></table>
          </>) : <p className="t-muted">Sin cobros en esta fecha.</p>}
        </Tarjeta>

      </div>
    </>
  );
}
