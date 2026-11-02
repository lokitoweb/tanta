import { useEffect, useMemo, useState } from 'react';
import { api } from '@/core/api';
import { exportarExcel, exportarPdf } from '@/core/exportar';
import { useApp } from '@/core/app-state';
import { money, num, num2 } from '@/core/format';
import { Boton, Encabezado, Insignia, Kpi, Tarjeta, Vacio } from '@/ui/primitives';

interface Mov { fecha: string; tipo: string; documento: string; cantidad: number; costoUnitario?: number; valor?: number; saldoCantidad: number; saldoValor?: number; cpp?: number }

const TIPOS: Record<string, { label: string; tono: 'ok' | 'danger' | 'warn' | 'info' | 'neutral' }> = {
  APERTURA: { label: 'Apertura', tono: 'neutral' }, COMPRA: { label: 'Compra', tono: 'ok' }, CONSUMO_OP: { label: 'Consumo OP', tono: 'info' },
  INGRESO_PRODUCCION: { label: 'Ingreso producción', tono: 'ok' }, VENTA: { label: 'Venta', tono: 'info' },
  MERMA: { label: 'Merma', tono: 'danger' }, DEVOLUCION: { label: 'Devolución', tono: 'warn' }, AJUSTE: { label: 'Ajuste', tono: 'warn' },
};

/** Kárdex valorizado (A-01) de cualquier insumo o producto. Libro inmutable: ningún asiento se edita. */
export function Kardex() {
  const { dataset, puede } = useApp();
  const items = useMemo(() => [
    ...dataset.insumos.map((i) => ({ codigo: i.codigo ?? i.id, nombre: i.nombre, unidad: i.unidad, tipo: 'Insumo' })),
    ...dataset.productos.map((p) => ({ codigo: p.codigo, nombre: p.nombre, unidad: p.unidad.toLowerCase(), tipo: 'Producto' })),
  ], [dataset.insumos, dataset.productos]);
  const [codigo, setCodigo] = useState(items[0]?.codigo ?? '');
  const [movs, setMovs] = useState<Mov[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const item = items.find((i) => i.codigo === codigo);
  const valoriza = puede('costos.ver') || puede('inventario.mover');

  useEffect(() => {
    if (!codigo) return;
    setMovs(null);
    api<Mov[]>(`/kardex/${encodeURIComponent(codigo)}`).then((m) => { setMovs(m); setError(null); }).catch((e) => setError(e.message));
  }, [codigo, dataset.movimientos]);

  const ultimo = movs?.at(-1); // el endpoint devuelve en orden cronológico: el último es el saldo vigente

  return (
    <>
      <Encabezado titulo="Kárdex valorizado" descripcion={`${item ? `${item.nombre} · ${item.codigo} · ` : ''}libro inmutable: ningún asiento se edita ni se borra`}
        acciones={<>
          <Boton icono="download" disabled={!movs?.length} onClick={() => exportarExcel(`kardex-${codigo}`, (movs ?? []).map((m) => ({ ...m })))}>Excel</Boton>
          <Boton icono="report" onClick={exportarPdf}>PDF</Boton>
        </>} />

      <Tarjeta>
        <label className="filtros__campo filtros__campo--ancho"><span>Insumo o producto</span>
          <select value={codigo} onChange={(e) => setCodigo(e.target.value)}>
            <optgroup label="Insumos">{items.filter((i) => i.tipo === 'Insumo').map((i) => <option key={i.codigo} value={i.codigo}>{i.nombre} ({i.codigo})</option>)}</optgroup>
            <optgroup label="Productos">{items.filter((i) => i.tipo === 'Producto').map((i) => <option key={i.codigo} value={i.codigo}>{i.nombre} ({i.codigo})</option>)}</optgroup>
          </select>
        </label>
      </Tarjeta>

      <div className="grid grid--4">
        <Kpi label="Saldo actual" valor={ultimo ? `${num2(ultimo.saldoCantidad)} ${item?.unidad ?? ''}` : '—'} nota="según el último asiento" icono="box" />
        {valoriza && <Kpi label="Valor del saldo" valor={ultimo?.saldoValor !== undefined ? money(ultimo.saldoValor) : '—'} nota="valorizado al CPP" icono="wallet" />}
        {valoriza && <Kpi label="CPP vigente" valor={ultimo?.cpp !== undefined ? money(ultimo.cpp) : '—'} nota={`por ${item?.unidad ?? 'unidad'}`} icono="chart" />}
        <Kpi label="Asientos" valor={num(movs?.length ?? 0)} nota="inmutables y auditados" icono="ledger" />
      </div>

      <Tarjeta padding="none">
        {error ? <Vacio titulo="No se pudo cargar" detalle={error} icono="ledger" />
          : movs === null ? <div className="tabla-cargando">Cargando movimientos…</div>
            : movs.length === 0 ? <Vacio titulo="Sin movimientos" detalle="Este ítem aún no tiene asientos en el kárdex." icono="ledger" />
              : (
                <div className="table-wrap">
                  <table className="table table--kardex">
                    <thead><tr><th>Fecha</th><th>Movimiento</th><th>Documento / motivo</th><th className="t-right">Cantidad</th>
                      {valoriza && <><th className="t-right">Costo unit.</th><th className="t-right">Valor</th></>}
                      <th className="t-right">Saldo</th>{valoriza && <th className="t-right">Saldo valorizado</th>}</tr></thead>
                    <tbody>
                      {[...movs].reverse().map((m, i) => {
                        const t = TIPOS[m.tipo] ?? { label: m.tipo, tono: 'neutral' as const };
                        return (
                          <tr key={`${m.fecha}-${i}`}>
                            <td className="t-muted">{m.fecha.slice(0, 16).replace('T', ' ')}</td>
                            <td><Insignia tono={t.tono}>{t.label}</Insignia></td>
                            <td><span className="mono">{m.documento}</span></td>
                            <td className={`t-right ${m.cantidad < 0 ? 't-neg' : 't-pos'}`}>{m.cantidad > 0 ? '+' : ''}{num2(m.cantidad)}</td>
                            {valoriza && <><td className="t-right">{money(m.costoUnitario ?? 0)}</td><td className={`t-right ${(m.valor ?? 0) < 0 ? 't-neg' : ''}`}>{money(m.valor ?? 0)}</td></>}
                            <td className="t-right"><strong>{num2(m.saldoCantidad)}</strong></td>
                            {valoriza && <td className="t-right">{money(m.saldoValor ?? 0)}</td>}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
      </Tarjeta>
    </>
  );
}
