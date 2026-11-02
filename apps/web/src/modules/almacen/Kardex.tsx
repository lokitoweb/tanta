import { exportarExcel, exportarPdf } from '@/core/exportar';
import { useApp } from '@/core/app-state';
import { money, num, num2 } from '@/core/format';
import { Boton, Encabezado, Insignia, Kpi, Tarjeta } from '@/ui/primitives';
import type { Movimiento } from '@/core/types';

const TIPOS: Record<string, { label: string; tono: 'ok' | 'danger' | 'warn' | 'info' | 'neutral' }> = {
  APERTURA: { label: 'Apertura', tono: 'neutral' },
  COMPRA: { label: 'Compra', tono: 'ok' },
  CONSUMO_OP: { label: 'Consumo OP', tono: 'info' },
  MERMA: { label: 'Merma', tono: 'danger' },
  AJUSTE: { label: 'Ajuste', tono: 'warn' },
};

export function Kardex() {
  const { dataset } = useApp();
  const movs: Movimiento[] = dataset.movimientos;
  const ultimo = movs[movs.length - 1];

  return (
    <>
      <Encabezado
        titulo="Kárdex valorizado"
        descripcion="Harina de trigo sin preparar · INS-001 · libro inmutable: ningún asiento se edita ni se borra"
        acciones={<><Boton icono="download" onClick={() => exportarExcel('kardex', movs.map((m) => ({ ...m })))}>Excel</Boton><Boton icono="report" onClick={exportarPdf}>PDF</Boton><Boton icono="filter">Filtros</Boton></>}
      />

      <div className="grid grid--4">
        <Kpi label="Saldo actual" valor={`${num2(ultimo.saldoCantidad)} kg`} nota="según último asiento" icono="box" />
        <Kpi label="Valor del saldo" valor={money(ultimo.saldoValor)} nota="valorizado" icono="wallet" />
        <Kpi label="CPP vigente" valor={money(ultimo.cpp)} nota="por kilogramo" icono="chart" />
        <Kpi label="Asientos" valor={num(movs.length)} nota="inmutables y auditados" icono="ledger" />
      </div>

      <Tarjeta padding="none">
        <div className="card__head card__head--padded">
          <div>
            <h3 className="card__title">Movimientos</h3>
            <p className="card__sub">Cada asiento guarda el saldo resultante: el kárdex se reconstruye sin recalcular</p>
          </div>
          <Insignia tono="info" punto>Saldo = Σ movimientos</Insignia>
        </div>

        <div className="table-wrap">
          <table className="table table--kardex">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Tipo</th>
                <th>Documento</th>
                <th className="t-right">Cantidad</th>
                <th className="t-right">Costo unit.</th>
                <th className="t-right">Valor</th>
                <th className="t-right">Saldo</th>
                <th className="t-right">Valor saldo</th>
              </tr>
            </thead>
            <tbody>
              {movs.map((m, i) => {
                const t = TIPOS[m.tipo] ?? { label: m.tipo, tono: 'neutral' as const };
                return (
                  <tr key={`${m.fecha}-${i}`}>
                    <td className="t-muted">{m.fecha}</td>
                    <td><Insignia tono={t.tono}>{t.label}</Insignia></td>
                    <td><span className="mono">{m.documento}</span></td>
                    <td className={`t-right ${m.cantidad < 0 ? 't-neg' : 't-pos'}`}>
                      {m.cantidad > 0 ? '+' : ''}{num2(m.cantidad)}
                    </td>
                    <td className="t-right">{money(m.costoUnitario)}</td>
                    <td className={`t-right ${m.valor < 0 ? 't-neg' : ''}`}>{money(m.valor)}</td>
                    <td className="t-right"><strong>{num2(m.saldoCantidad)}</strong></td>
                    <td className="t-right">{money(m.saldoValor)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="card__foot">
          <span className="t-muted">Los movimientos no se modifican. Una corrección se registra como asiento de reverso.</span>
          <Insignia tono="ok" punto>Integridad verificada</Insignia>
        </div>
      </Tarjeta>
    </>
  );
}
