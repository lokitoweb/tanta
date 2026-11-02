import { exportarExcel, exportarPdf } from '@/core/exportar';
import { useApp } from '@/core/app-state';
import { money, num, pct } from '@/core/format';
import { Boton, Encabezado, Insignia, Kpi, Progreso, Tarjeta, TarjetaTitulo, Vacio } from '@/ui/primitives';
import { Tabla, type Columna } from '@/ui/Tabla';
import type { Cliente } from '@/core/types';

export function Cobranza() {
  const { dataset } = useApp();
  const k = dataset.kpis;
  const totalAging = dataset.aging.reduce((s, a) => s + a.monto, 0);

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
        acciones={<><Boton icono="download" onClick={() => exportarExcel('cuentas-por-cobrar', dataset.clientes.map((c) => ({ ...c })))}>Excel</Boton><Boton icono="report" onClick={exportarPdf}>PDF</Boton><Boton variant="primary" icono="plus">Registrar pago</Boton></>}
      />

      <div className="grid grid--4">
        <Kpi label="Total por cobrar" valor={money(k.porCobrar)} nota={`${dataset.clientes.filter((c) => c.saldo > 0).length} clientes`} icono="wallet" />
        <Kpi label="Monto vencido" valor={money(k.vencido)} nota={pct(k.vencido / Math.max(k.porCobrar, 1)) + ' de la cartera'} icono="alert" />
        <Kpi label="Días promedio de cobro" valor="18 d" nota="objetivo 15 d" icono="clock" />
        <Kpi label="Límite de crédito usado" valor={pct(k.porCobrar / dataset.clientes.reduce((s, c) => s + c.limiteCredito, 0))} nota="sobre el total autorizado" icono="chart" />
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
                <Progreso valor={a.monto / totalAging} tono={a.rango.includes('Más de 30') ? 'danger' : a.rango.includes('16') ? 'warn' : 'ink'} />
                <small>{num(a.documentos)} documentos · {pct(a.monto / totalAging)}</small>
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
          <Tabla columnas={columnas} filas={dataset.clientes} clave={(c) => c.id}
            vacio={<Vacio titulo="Sin clientes con deuda" icono="wallet" />} />
        </Tarjeta>
      </div>
    </>
  );
}
