import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { useCatalogos } from '@/core/catalogos';
import { exportarExcel, exportarPdf } from '@/core/exportar';
import { Dialogo } from '@/ui/Dialogo';
import { useApp } from '@/core/app-state';
import { money, num, pct } from '@/core/format';
import { Boton, Encabezado, Insignia, Kpi, Progreso, Tarjeta, TarjetaTitulo, Vacio } from '@/ui/primitives';
import { Tabla, type Columna } from '@/ui/Tabla';
import type { Cliente } from '@/core/types';

interface Cierre { fecha: string; total: number; porMedio: Array<{ medio: string; monto: number }>; lineas: Array<{ medio: string; vendedor: string; pagos: number; monto: number }> }
interface EstadoCuenta {
  cliente: { nombre: string; documento: string; condicion: string };
  saldo: number; vencido: number;
  documentos: Array<{ documento: string; fecha: string; vence: string; monto: number; pagado: number; saldo: number; estado: string; diasVencido: number }>;
  pagos: Array<{ recibo: string; fecha: string; medio: string; referencia: string | null; monto: number }>;
}
const hoy = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);

export function Cobranza() {
  const { dataset, puede, refrescarDatos } = useApp();
  const medios = useCatalogos().mediosPago.filter((m) => m.enCobranza);
  const k = dataset.kpis;
  const totalAging = dataset.aging.reduce((s, a) => s + a.monto, 0);
  const limiteTotal = dataset.clientes.reduce((s, c) => s + c.limiteCredito, 0);
  const deudores = dataset.clientes.filter((c) => c.saldo > 0);
  const [pago, setPago] = useState<{ clienteId: string; monto: string; medio: string; referencia: string } | null>(null);
  const [cierre, setCierre] = useState<Cierre | null>(null);
  const [fecha, setFecha] = useState(hoy());
  const [estado, setEstado] = useState<EstadoCuenta | null>(null);
  useEffect(() => { api<Cierre>(`/cobranza/cierre?fecha=${fecha}`).then(setCierre).catch(() => setCierre(null)); }, [fecha, dataset]);
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger'; texto: string } | null>(null);
  const [guardando, setGuardando] = useState(false);

  const abrirPago = (c = deudores[0]) => { setAviso(null); setPago({ clienteId: c?.id ?? '', monto: c ? c.saldo.toFixed(2) : '', medio: 'EFECTIVO', referencia: '' }); };
  const cuenta = deudores.find((c) => c.id === pago?.clienteId);
  const conReferencia = pago !== null && !!medios.find((m) => m.codigo === pago.medio)?.requiereOperacion;
  const registrar = async () => {
    if (!pago) return;
    setGuardando(true);
    try {
      // RN-34: un recibo se aplica a los documentos más antiguos primero.
      const r = await api<{ numero: string; aplicaciones: unknown[] }>('/cobranza/recibos', { method: 'POST', conIdempotencia: true, body: { clienteId: pago.clienteId, monto: Number(pago.monto), medio: pago.medio, referencia: pago.referencia.trim() } });
      setPago(null);
      await refrescarDatos();
      setAviso({ tono: 'ok', texto: `Recibo ${r.numero}: ${money(Number(pago.monto))} de ${cuenta?.nombre ?? 'el cliente'} aplicado a ${r.aplicaciones.length} documento(s).` });
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
      key: 'id', header: '', align: 'right',
      render: (c) => <Boton onClick={() => void api<EstadoCuenta>(`/estado-cuenta?clienteId=${c.id}`).then(setEstado).catch((e) => setAviso({ tono: 'danger', texto: e.message }))}>Estado de cuenta</Boton>,
    },
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
        acciones={<><Boton icono="download" onClick={() => exportarExcel('cuentas-por-cobrar', dataset.clientes.map((c) => ({ ...c })))}>Excel</Boton><Boton icono="report" onClick={exportarPdf}>PDF</Boton>{puede('cobranza.registrar') && <Boton variant="primary" icono="plus" onClick={() => abrirPago()}>Registrar pago</Boton>}</>}
      />
      {aviso && <div className={`aviso aviso--${aviso.tono}`} role="status"><span className="aviso__icono">{aviso.tono === 'ok' ? '✓' : '!'}</span><div><p>{aviso.texto}</p></div></div>}
      <Dialogo abierto={pago !== null} titulo="Registrar pago" descripcion="Total o parcial. Se aplica a los documentos más antiguos y genera un recibo."
        onCerrar={() => setPago(null)}
        acciones={<><Boton onClick={() => setPago(null)}>Cancelar</Boton><Boton variant="primary" disabled={guardando || !cuenta || !(Number(pago?.monto) > 0) || Number(pago?.monto) > (cuenta?.saldo ?? 0) + 0.001 || (conReferencia && (pago?.referencia.trim().length ?? 0) < 3)} onClick={() => void registrar()}>{guardando ? 'Registrando…' : 'Registrar pago'}</Boton></>}>
        {pago && (deudores.length ? (
          <div className="form form--2col form--dialogo">
            <label className="field field--ancho"><span className="field__label">Cliente</span>
              <select className="field__input" value={pago.clienteId} onChange={(e) => { const c = deudores.find((x) => x.id === e.target.value); setPago({ ...pago, clienteId: e.target.value, monto: c ? c.saldo.toFixed(2) : '' }); }}>
                {deudores.map((c) => <option key={c.id} value={c.id}>{c.nombre} · debe {money(c.saldo)}</option>)}
              </select></label>
            <label className="field"><span className="field__label">Monto (S/)</span>
              <input className="field__input" type="number" min="0.01" step="0.01" max={cuenta?.saldo} value={pago.monto} onChange={(e) => setPago({ ...pago, monto: e.target.value })} />
              {cuenta && Number(pago.monto) > cuenta.saldo && <span className="field__aviso">Supera el saldo ({money(cuenta.saldo)})</span>}</label>
            <label className="field"><span className="field__label">Medio</span>
              <select className="field__input" value={pago.medio} onChange={(e) => setPago({ ...pago, medio: e.target.value })}>{medios.map((m) => <option key={m.codigo} value={m.codigo}>{m.nombre}</option>)}</select></label>
            <label className="field field--ancho"><span className="field__label">N.° de operación {conReferencia ? '(obligatorio)' : '(opcional)'}</span>
              <input className="field__input" maxLength={60} value={pago.referencia} onChange={(e) => setPago({ ...pago, referencia: e.target.value })} /></label>
          </div>
        ) : <p className="t-muted">No hay cuentas por cobrar pendientes.</p>)}
      </Dialogo>
      <Dialogo abierto={estado !== null} titulo={`Estado de cuenta · ${estado?.cliente.nombre ?? ''}`}
        descripcion={estado ? `${estado.cliente.documento} · ${estado.cliente.condicion.toLowerCase()} · saldo ${money(estado.saldo)} · vencido ${money(estado.vencido)}` : ''}
        onCerrar={() => setEstado(null)} acciones={<Boton onClick={() => setEstado(null)}>Cerrar</Boton>}>
        {estado && (<>
          <table className="table table--compacta"><thead><tr><th>Documento</th><th>Vence</th><th className="t-right">Monto</th><th className="t-right">Saldo</th><th className="t-right">Días venc.</th></tr></thead>
            <tbody>{estado.documentos.map((d, i) => <tr key={i}><td>{d.documento}</td><td>{d.vence}</td><td className="t-right">{money(d.monto)}</td><td className="t-right">{money(d.saldo)}</td><td className="t-right">{d.diasVencido || '—'}</td></tr>)}</tbody></table>
          <h4>Pagos</h4>
          {estado.pagos.length ? <table className="table table--compacta"><thead><tr><th>Recibo</th><th>Fecha</th><th>Medio</th><th className="t-right">Monto</th></tr></thead>
            <tbody>{estado.pagos.map((p, i) => <tr key={i}><td>{p.recibo}</td><td>{p.fecha}</td><td>{p.medio.toLowerCase()}{p.referencia ? ` · ${p.referencia}` : ''}</td><td className="t-right">{money(p.monto)}</td></tr>)}</tbody></table>
            : <p className="t-muted">Sin pagos registrados.</p>}
        </>)}
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

        <Tarjeta className="col-12">
          <TarjetaTitulo titulo="Cierre del día" subtitulo={`COB-09 · cobrado ${money(cierre?.total ?? 0)} por forma de pago y vendedor`}
            accion={<input className="field__input" type="date" value={fecha} max={hoy()} onChange={(e) => setFecha(e.target.value)} />} />
          {cierre?.lineas.length ? (<>
            <p className="t-muted">{cierre.porMedio.map((m) => `${m.medio.toLowerCase()} ${money(m.monto)}`).join(' · ')}</p>
            <table className="table table--compacta"><thead><tr><th>Forma de pago</th><th>Vendedor</th><th className="t-right">Pagos</th><th className="t-right">Monto</th></tr></thead>
              <tbody>{cierre.lineas.map((l, i) => <tr key={i}><td>{l.medio.toLowerCase()}</td><td>{l.vendedor}</td><td className="t-right">{l.pagos}</td><td className="t-right">{money(l.monto)}</td></tr>)}</tbody></table>
          </>) : <p className="t-muted">Sin cobros en esta fecha.</p>}
        </Tarjeta>

        <Tarjeta className="col-7" padding="none">
          <div className="card__head card__head--padded">
            <div>
              <h3 className="card__title">Cartera por cliente</h3>
              <p className="card__sub">V-01 · deudas por cobrar con antigüedad</p>
            </div>
          </div>
          <Tabla columnas={columnas} filas={dataset.clientes.filter((c) => c.saldo > 0)} clave={(c) => c.id} buscar="Buscar cliente…"
            vacio={<Vacio titulo="Sin clientes con deuda" icono="wallet" />} />
        </Tarjeta>
      </div>
    </>
  );
}
