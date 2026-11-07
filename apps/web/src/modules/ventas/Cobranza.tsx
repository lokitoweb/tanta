import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { exportarExcel, exportarPdf } from '@/core/exportar';
import { Dialogo } from '@/ui/Dialogo';
import { useApp } from '@/core/app-state';
import { money, num, pct } from '@/core/format';
import { Boton, Encabezado, Insignia, Kpi, PilaEsqueleto, Progreso, Tarjeta, TarjetaTitulo, Vacio } from '@/ui/primitives';
import { Tabla, type Columna } from '@/ui/Tabla';
import type { Cliente } from '@/core/types';
import { DialogoEstadoCuenta, type EstadoCuenta } from './EstadoCuenta';
import { LineasPago, useMediosCobro, type LineaPago } from './LineasPago';

interface Rendicion { id: string; estado: 'PENDIENTE' | 'RECIBIDA'; total: number; efectivoEsperado: number; efectivoEntregado: number; efectivoRecibido: number | null;
  nota: string | null; notaCaja: string | null; recibidoPor: string | null; diferencia: number; desactualizada: boolean }
interface CajaVendedor { vendedorId: string; vendedor: string; porMedio: Record<string, number>; pagos: number; total: number; efectivo: number; rendicion: Rendicion | null }
interface Cierre { fecha: string; total: number; porMedio: Array<{ medio: string; monto: number }>; lineas: Array<{ medio: string; vendedor: string; pagos: number; monto: number }>;
  vendedores: CajaVendedor[]; pendientes: Array<{ fecha: string; vendedor: string; total: number; estado: string }> }
interface Cxc { id: string; clienteId: string; documento: string; saldo: number; pagado: number; venceEn: string; diasVencido: number; vencida: boolean }
const hoy = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);

export function Cobranza() {
  const { dataset, puede, refrescarDatos, sesion } = useApp();
  const { nombre: nombreMedio, lineaNueva, revisar, aPagos } = useMediosCobro();
  const k = dataset.kpis;
  const totalAging = dataset.aging.reduce((s, a) => s + a.monto, 0);
  const limiteTotal = dataset.clientes.reduce((s, c) => s + c.limiteCredito, 0);
  const deudores = dataset.clientes.filter((c) => c.saldo > 0);
  // Un pago puede llegar en varias formas (p. ej. efectivo + Yape): una línea por forma, un solo recibo.
  // «marcadas»: compras que el cliente paga ahora; sin marcar se cobra de la más antigua a la más nueva.
  const [pago, setPago] = useState<{ clienteId: string; lineas: LineaPago[]; marcadas: string[] } | null>(null);
  const [cxc, setCxc] = useState<Cxc[]>([]);
  // Caja: el vendedor rinde su día; la persona encargada de caja recibe y anota lo que llegó.
  const [rendir, setRendir] = useState<{ efectivo: string; nota: string } | null>(null);
  const [recibir, setRecibir] = useState<{ v: CajaVendedor; efectivo: string; nota: string } | null>(null);
  const [cierre, setCierre] = useState<Cierre | null>(null);
  const [fecha, setFecha] = useState(hoy());
  const [estado, setEstado] = useState<EstadoCuenta | null>(null);
  const [cierreError, setCierreError] = useState<string | null>(null);
  const cargarCierre = () => { setCierre(null); setCierreError(null); api<Cierre>(`/cobranza/cierre?fecha=${fecha}`).then(setCierre).catch((e) => setCierreError(e.message)); };
  useEffect(cargarCierre, [fecha, dataset]);
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'danger'; texto: string } | null>(null);
  const [guardando, setGuardando] = useState(false);

  const abrirPago = (c = deudores[0]) => {
    setAviso(null); setCxc([]);
    setPago({ clienteId: c?.id ?? '', lineas: [lineaNueva(c?.saldo ?? 0)], marcadas: [] });
    api<Cxc[]>('/cxc').then(setCxc).catch((e) => setAviso({ tono: 'danger', texto: e.message }));
  };
  const cuenta = deudores.find((c) => c.id === pago?.clienteId);
  const compras = cxc.filter((x) => x.clienteId === pago?.clienteId);
  const sumaMarcadas = (ids: string[]) => compras.filter((x) => ids.includes(x.id)).reduce((s, x) => s + x.saldo, 0);
  const debe = pago?.marcadas.length ? sumaMarcadas(pago.marcadas) : cuenta?.saldo ?? 0;
  const otras = (cuenta?.saldo ?? 0) - debe;
  const marcar = (id: string) => {
    if (!pago) return;
    const marcadas = pago.marcadas.includes(id) ? pago.marcadas.filter((x) => x !== id) : [...pago.marcadas, id];
    setPago({ ...pago, marcadas, lineas: [lineaNueva(marcadas.length ? sumaMarcadas(marcadas) : cuenta?.saldo ?? 0)] });
  };
  const { suma, queda, problema: falta } = revisar(pago?.lineas ?? [], debe);
  const problema = !pago || !cuenta ? 'Elige el cliente.' : falta;
  const mio = cierre?.vendedores.find((v) => v.vendedorId === sesion.usuario.id);
  const accionCaja = async (fn: () => Promise<string>) => {
    setGuardando(true);
    try { const t = await fn(); setRendir(null); setRecibir(null); cargarCierre(); setAviso({ tono: 'ok', texto: t }); }
    catch (e) { setAviso({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo registrar.' }); }
    finally { setGuardando(false); }
  };
  const enviarRendicion = () => accionCaja(async () => {
    await api('/cobranza/rendiciones', { method: 'POST', body: { fecha, efectivoEntregado: Number(rendir!.efectivo), nota: rendir!.nota.trim() } });
    return 'Rendición enviada: caja la confirmará al recibir el dinero.';
  });
  const confirmarRecepcion = () => accionCaja(async () => {
    const r = await api<{ diferencia: number }>(`/cobranza/rendiciones/${recibir!.v.rendicion!.id}/recibir`, { method: 'POST', body: { efectivoRecibido: Number(recibir!.efectivo), nota: recibir!.nota.trim() } });
    return `Rendición de ${recibir!.v.vendedor} recibida${Math.abs(r.diferencia) > 0.009 ? ` · diferencia ${money(r.diferencia)}` : ' · cuadra'}.`;
  });
  const registrar = async () => {
    if (!pago) return;
    setGuardando(true);
    try {
      // RN-34: un recibo se aplica a los documentos más antiguos primero.
      const pagos = aPagos(pago.lineas);
      const r = await api<{ numero: string; aplicaciones: unknown[] }>('/cobranza/recibos', { method: 'POST', conIdempotencia: true, body: { clienteId: pago.clienteId, pagos, cxcIds: pago.marcadas.length ? pago.marcadas : undefined } });
      setPago(null);
      await refrescarDatos();
      setAviso({ tono: 'ok', texto: `Recibo ${r.numero}: ${money(suma)} de ${cuenta?.nombre ?? 'el cliente'}${pagos.length > 1 ? ` (${pagos.map((p) => `${nombreMedio(p.medio).toLowerCase()} ${money(p.monto)}`).join(' + ')})` : ''} aplicado a ${r.aplicaciones.length} documento(s).${queda + otras > 0.009 ? ` Queda ${money(queda + otras)} por cobrar.` : ' Cuenta saldada.'}` });
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
      render: (c) => <div className="fila-acciones">
        {puede('cobranza.registrar') && <Boton onClick={() => abrirPago(c)}>Cobrar</Boton>}
        <Boton onClick={() => void api<EstadoCuenta>(`/estado-cuenta?clienteId=${c.id}`).then(setEstado).catch((e) => setAviso({ tono: 'danger', texto: e.message }))}>Estado de cuenta</Boton>
      </div>,
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
      <Dialogo abierto={pago !== null} titulo="Registrar pago" descripcion="Total o parcial. Marca las compras que paga; sin marcar se aplica a las más antiguas. Genera un recibo."
        onCerrar={() => setPago(null)}
        acciones={<><Boton onClick={() => setPago(null)}>Cancelar</Boton><Boton variant="primary" disabled={guardando || problema !== null} onClick={() => void registrar()}>{guardando ? 'Registrando…' : `Cobrar ${money(suma)}`}</Boton></>}>
        {pago && (deudores.length ? (
          <div className="form form--2col form--dialogo">
            <label className="field field--ancho"><span className="field__label">Cliente</span>
              <select className="field__input" value={pago.clienteId} onChange={(e) => { const c = deudores.find((x) => x.id === e.target.value); setPago({ clienteId: e.target.value, lineas: [lineaNueva(c?.saldo ?? 0)], marcadas: [] }); }}>
                {deudores.map((c) => <option key={c.id} value={c.id}>{c.nombre} · debe {money(c.saldo)}</option>)}
              </select></label>
            {compras.length > 1 && (
              <fieldset className="cobro-compras field--ancho">
                <legend className="field__label">Compras por pagar</legend>
                {compras.map((x) => (
                  <label key={x.id} className="cobro-compra">
                    <input type="checkbox" checked={pago.marcadas.includes(x.id)} onChange={() => marcar(x.id)} />
                    <span className="celda-doble"><strong>{x.documento}</strong>
                      <span className={x.vencida ? 't-neg' : ''}>vence {x.venceEn.split('-').reverse().join('/')}{x.vencida ? ` · ${x.diasVencido} días vencida` : ''}{x.pagado > 0.009 ? ' · pago parcial' : ''}</span></span>
                    <b>{money(x.saldo)}</b>
                  </label>
                ))}
              </fieldset>
            )}
            <LineasPago lineas={pago.lineas} onChange={(lineas) => setPago({ ...pago, lineas })} debe={debe} otras={otras} />
            {!cuenta && <span className="field__aviso field--ancho">Elige el cliente.</span>}
          </div>
        ) : <p className="t-muted">No hay cuentas por cobrar pendientes.</p>)}
      </Dialogo>

      <DialogoEstadoCuenta estado={estado} onCerrar={() => setEstado(null)} />

      <Dialogo abierto={rendir !== null && !!mio} titulo={`Rendir mi día · ${fecha.split('-').reverse().join('/')}`}
        descripcion="Lo que cobraste según el sistema. Entrega el efectivo a la persona encargada de caja; ella confirma lo que recibe."
        onCerrar={() => setRendir(null)}
        acciones={<><Boton onClick={() => setRendir(null)}>Cancelar</Boton><Boton variant="primary" disabled={guardando || !(Number(rendir?.efectivo) >= 0) || rendir?.efectivo === ''} onClick={() => void enviarRendicion()}>{guardando ? 'Enviando…' : 'Enviar rendición'}</Boton></>}>
        {rendir && mio && (
          <div className="form form--2col form--dialogo">
            <table className="table table--compacta field--ancho"><tbody>
              {Object.entries(mio.porMedio).map(([m, x]) => <tr key={m}><td>{nombreMedio(m)}</td><td className="t-right">{money(x)}</td></tr>)}
              <tr><td><strong>Total cobrado</strong></td><td className="t-right"><strong>{money(mio.total)}</strong></td></tr>
            </tbody></table>
            <label className="field"><span className="field__label">Efectivo que entregas (S/)</span>
              <input className="field__input" type="number" min="0" step="0.01" value={rendir.efectivo} onChange={(e) => setRendir({ ...rendir, efectivo: e.target.value })} />
              <span className="field__ayuda">Esperado en efectivo: {money(mio.efectivo)}{Math.abs(Number(rendir.efectivo) - mio.efectivo) > 0.009 ? ` · ${Number(rendir.efectivo) < mio.efectivo ? 'faltan' : 'sobran'} ${money(Math.abs(Number(rendir.efectivo) - mio.efectivo))}` : ''}</span></label>
            <label className="field"><span className="field__label">Nota (opcional)</span>
              <input className="field__input" maxLength={300} value={rendir.nota} onChange={(e) => setRendir({ ...rendir, nota: e.target.value })} /></label>
          </div>
        )}
      </Dialogo>

      <Dialogo abierto={recibir !== null} titulo={`Recibir rendición · ${recibir?.v.vendedor ?? ''}`}
        descripcion={recibir ? `Cobró ${money(recibir.v.total)} (${Object.entries(recibir.v.porMedio).map(([m, x]) => `${nombreMedio(m).toLowerCase()} ${money(x)}`).join(' · ')}). Declara ${money(recibir.v.rendicion!.efectivoEntregado)} en efectivo.` : ''}
        onCerrar={() => setRecibir(null)}
        acciones={<><Boton onClick={() => setRecibir(null)}>Cancelar</Boton><Boton variant="primary" disabled={guardando || recibir?.efectivo === '' || !(Number(recibir?.efectivo) >= 0)} onClick={() => void confirmarRecepcion()}>{guardando ? 'Guardando…' : 'Confirmar recepción'}</Boton></>}>
        {recibir && (
          <div className="form form--2col form--dialogo">
            <label className="field"><span className="field__label">Efectivo recibido (S/)</span>
              <input className="field__input" type="number" min="0" step="0.01" value={recibir.efectivo} onChange={(e) => setRecibir({ ...recibir, efectivo: e.target.value })} />
              <span className="field__ayuda">Cobró en efectivo {money(recibir.v.efectivo)}{Math.abs(Number(recibir.efectivo) - recibir.v.efectivo) > 0.009 ? ` · diferencia ${money(Number(recibir.efectivo) - recibir.v.efectivo)}` : ' · cuadra'}</span></label>
            <label className="field"><span className="field__label">Nota de caja (opcional)</span>
              <input className="field__input" maxLength={300} value={recibir.nota} onChange={(e) => setRecibir({ ...recibir, nota: e.target.value })} /></label>
            {recibir.v.rendicion?.desactualizada && <span className="field__aviso field--ancho">Cobró después de rendir: lo cobrado hoy ya no coincide con su rendición.</span>}
          </div>
        )}
      </Dialogo>

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
          <TarjetaTitulo titulo="Cierre del día y caja" subtitulo={`COB-09 · cobrado ${money(cierre?.total ?? 0)} · cada vendedor rinde su día y caja lo recibe`}
            accion={<div className="fila-acciones">
              {mio && mio.total > 0 && mio.rendicion?.estado !== 'RECIBIDA' && puede('cobranza.registrar') &&
                <Boton variant="primary" icono="wallet" onClick={() => setRendir({ efectivo: (mio.rendicion?.efectivoEntregado ?? mio.efectivo).toFixed(2), nota: mio.rendicion?.nota ?? '' })}>{mio.rendicion ? 'Actualizar mi rendición' : 'Rendir mi día'}</Boton>}
              <input className="field__input" type="date" value={fecha} max={hoy()} onChange={(e) => setFecha(e.target.value)} />
            </div>} />
          {cierreError ? <Vacio titulo="No se pudo cargar" detalle={cierreError} onReintentar={cargarCierre} />
            : cierre === null ? <PilaEsqueleto lineas={3} />
            : cierre.vendedores.length ? (<>
            <p className="t-muted">{cierre.porMedio.map((m) => `${nombreMedio(m.medio).toLowerCase()} ${money(m.monto)}`).join(' · ')}</p>
            <div className="table-wrap"><table className="table table--compacta">
              <thead><tr><th>Vendedor</th><th>Cobrado por forma de pago</th><th className="t-right">Total</th><th className="t-right">Efectivo</th><th className="t-right">Entregó</th><th className="t-right">Diferencia</th><th className="t-right">Rendición</th><th /></tr></thead>
              <tbody>{cierre.vendedores.map((v) => {
                const r = v.rendicion;
                return (
                  <tr key={v.vendedorId}>
                    <td><strong>{v.vendedor}</strong><div className="t-muted">{v.pagos} cobro(s)</div></td>
                    <td className="t-muted">{Object.entries(v.porMedio).map(([m, x]) => `${nombreMedio(m).toLowerCase()} ${money(x)}`).join(' · ') || '—'}</td>
                    <td className="t-right"><strong>{money(v.total)}</strong></td>
                    <td className="t-right">{money(v.efectivo)}</td>
                    <td className="t-right">{r ? money(r.efectivoRecibido ?? r.efectivoEntregado) : '—'}</td>
                    <td className="t-right">{r ? <span className={Math.abs(r.diferencia) > 0.009 ? 't-neg' : 't-ok'}>{Math.abs(r.diferencia) > 0.009 ? money(r.diferencia) : 'Cuadra'}</span> : '—'}</td>
                    <td className="t-right">
                      {!r ? <Insignia tono="warn" punto>Sin rendir</Insignia>
                        : r.estado === 'RECIBIDA' ? <Insignia tono="ok" punto>Recibida{r.recibidoPor ? ` · ${r.recibidoPor}` : ''}</Insignia>
                        : <Insignia tono="info" punto>Por recibir</Insignia>}
                      {r?.desactualizada && <div className="t-warn">cobró después de rendir</div>}
                      {(r?.nota || r?.notaCaja) && <div className="t-muted">{[r?.nota, r?.notaCaja].filter(Boolean).join(' · ')}</div>}
                    </td>
                    <td className="t-right">{r?.estado === 'PENDIENTE' && puede('caja.rendiciones') &&
                      <Boton onClick={() => setRecibir({ v, efectivo: r.efectivoEntregado.toFixed(2), nota: '' })}>Recibir</Boton>}</td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          </>) : <p className="t-muted">Sin cobros en esta fecha.</p>}
          {cierre && cierre.pendientes.length > 0 && (
            <div className="caja-pendientes">
              <b>Días anteriores sin recibir en caja</b>
              <ul>{cierre.pendientes.map((x, i) => (
                <li key={i}><button type="button" className="enlace" onClick={() => setFecha(x.fecha)}>{x.fecha.split('-').reverse().join('/')}</button>
                  {' · '}{x.vendedor} · {money(x.total)} · {x.estado === 'PENDIENTE' ? 'rendida, por recibir' : 'sin rendir'}</li>
              ))}</ul>
            </div>
          )}
        </Tarjeta>

      </div>
    </>
  );
}
