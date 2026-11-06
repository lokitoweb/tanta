import { useApp } from '@/core/app-state';
import { fechaLarga, money } from '@/core/format';
import { Dialogo } from '@/ui/Dialogo';
import { Boton, Insignia } from '@/ui/primitives';

export interface EstadoCuenta {
  cliente: { nombre: string; documento: string; condicion: string; limiteCredito: number; diasCredito: number };
  saldo: number; vencido: number;
  documentos: Array<{ documento: string; fecha: string; vence: string; monto: number; pagado: number; saldo: number; estado: string; diasVencido: number }>;
  pagos: Array<{ recibo: string; fecha: string; medio: string; referencia: string | null; monto: number }>;
}

/** 2026-11-05 → 05/11/2026 (las fechas llegan como texto de Postgres, sin hora: no pasan por Date para no correr el día). */
const dma = (iso: string) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—');
const suma = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);

/** Imprime solo el estado de cuenta (el resto de la pantalla se oculta con html.imprime-dialogo). */
function imprimir() {
  const html = document.documentElement;
  html.classList.add('imprime-dialogo');
  window.addEventListener('afterprint', () => html.classList.remove('imprime-dialogo'), { once: true });
  window.print();
}

export function DialogoEstadoCuenta({ estado, onCerrar }: { estado: EstadoCuenta | null; onCerrar: () => void }) {
  const { dataset } = useApp();
  const n = dataset.negocio;
  if (!estado) return null;
  const { cliente: c, documentos: docs, pagos } = estado;
  const pendientes = docs.filter((d) => d.saldo > 0);
  const porVencer = estado.saldo - estado.vencido;
  const disponible = c.limiteCredito - estado.saldo;

  return (
    <Dialogo abierto titulo="Estado de cuenta" descripcion={`${c.nombre} · ${c.documento}`} onCerrar={onCerrar}
      acciones={<><Boton icono="report" onClick={imprimir}>Imprimir / PDF</Boton><Boton variant="primary" onClick={onCerrar}>Cerrar</Boton></>}>
      <div className="edc">
        <header className="edc__membrete">
          <div>
            <strong className="edc__empresa">{n.nombre}</strong>
            <span>RUC {n.ruc}{n.direccion ? ` · ${n.direccion}` : ''}</span>
            {(n.telefono || n.email) && <span>{[n.telefono, n.email].filter(Boolean).join(' · ')}</span>}
          </div>
          <div className="edc__doc">
            <span className="edc__etiqueta">Estado de cuenta</span>
            <span>Emitido el {fechaLarga(new Date().toISOString())}</span>
          </div>
        </header>

        <section className="edc__cliente">
          <div><span className="edc__etiqueta">Cliente</span><strong>{c.nombre}</strong><span>{c.documento}</span></div>
          <div><span className="edc__etiqueta">Condición</span><strong>{c.condicion === 'CREDITO' ? `Crédito a ${c.diasCredito} días` : 'Contado'}</strong>
            <span>Límite {money(c.limiteCredito)}</span></div>
        </section>

        <section className="edc__resumen">
          <div className="edc__cifra edc__cifra--total"><span>Saldo total</span><b>{money(estado.saldo)}</b><small>{pendientes.length} documento(s) pendiente(s)</small></div>
          <div className="edc__cifra edc__cifra--danger"><span>Vencido</span><b>{money(estado.vencido)}</b><small>{pendientes.filter((d) => d.diasVencido > 0).length} documento(s)</small></div>
          <div className="edc__cifra"><span>Por vencer</span><b>{money(porVencer)}</b><small>{pendientes.filter((d) => d.diasVencido === 0).length} documento(s)</small></div>
          <div className={`edc__cifra${disponible < 0 ? ' edc__cifra--danger' : ''}`}><span>Crédito disponible</span><b>{money(disponible)}</b>
            <small>{disponible < 0 ? 'excede el límite' : `de ${money(c.limiteCredito)}`}</small></div>
        </section>

        <h4 className="edc__seccion">Documentos</h4>
        {docs.length ? (
          <div className="table-wrap"><table className="table table--compacta edc__tabla">
            <thead><tr><th>Documento</th><th>Emisión</th><th>Vence</th><th className="t-right">Importe</th><th className="t-right">Pagado</th><th className="t-right">Saldo</th><th className="t-right">Situación</th></tr></thead>
            <tbody>{docs.map((d, i) => (
              <tr key={i}>
                <td className="t-mono">{d.documento}</td><td>{dma(d.fecha)}</td><td>{dma(d.vence)}</td>
                <td className="t-right">{money(d.monto)}</td>
                <td className="t-right t-muted">{d.pagado > 0 ? money(d.pagado) : '—'}</td>
                <td className="t-right"><strong>{money(d.saldo)}</strong></td>
                <td className="t-right">{d.saldo <= 0 ? <Insignia tono="ok" punto>Pagado</Insignia>
                  : d.diasVencido > 0 ? <Insignia tono="danger" punto>Vencido {d.diasVencido} d</Insignia>
                  : <Insignia tono="warn" punto>Por vencer</Insignia>}</td>
              </tr>
            ))}</tbody>
            <tfoot><tr><td colSpan={3}>Total</td><td className="t-right">{money(suma(docs, (d) => d.monto))}</td>
              <td className="t-right">{money(suma(docs, (d) => d.pagado))}</td><td className="t-right">{money(estado.saldo)}</td><td /></tr></tfoot>
          </table></div>
        ) : <p className="edc__vacio">Sin documentos.</p>}

        <h4 className="edc__seccion">Pagos recibidos</h4>
        {pagos.length ? (
          <div className="table-wrap"><table className="table table--compacta edc__tabla">
            <thead><tr><th>Recibo</th><th>Fecha</th><th>Medio</th><th>N.° de operación</th><th className="t-right">Monto</th></tr></thead>
            <tbody>{pagos.map((p, i) => (
              <tr key={i}><td className="t-mono">{p.recibo}</td><td>{dma(p.fecha)}</td><td className="edc__medio">{p.medio.toLowerCase()}</td>
                <td className="t-muted">{p.referencia || '—'}</td><td className="t-right">{money(p.monto)}</td></tr>
            ))}</tbody>
            <tfoot><tr><td colSpan={4}>Total pagado</td><td className="t-right">{money(suma(pagos, (p) => p.monto))}</td></tr></tfoot>
          </table></div>
        ) : <p className="edc__vacio">Aún no hay pagos registrados.</p>}

        <p className="edc__nota">Montos en soles, IGV incluido. Los pagos se aplican a los documentos más antiguos primero.
          {estado.vencido > 0 && ` Le agradeceremos regularizar el saldo vencido de ${money(estado.vencido)}.`}</p>
      </div>
    </Dialogo>
  );
}
