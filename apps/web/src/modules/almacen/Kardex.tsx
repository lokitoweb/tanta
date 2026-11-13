import { Paginador, filtrarTexto, usePaginado } from '@/ui/Paginador';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/core/api';
import { exportarExcel, exportarPdf } from '@/core/exportar';
import { useApp } from '@/core/app-state';
import { money, money3, num, num2, num3 } from '@/core/format';
import { Boton, Encabezado, Insignia, Kpi, Tarjeta, TablaEsqueleto, Vacio, Buscador } from '@/ui/primitives';

interface Mov { fecha: string; tipo: string; documento: string; almacen?: string; lote?: string; vence?: string; cantidad: number; costoUnitario?: number; valor?: number; saldoCantidad: number; saldoValor?: number; cpp?: number }

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

  const cargar = () => {
    if (!codigo) return;
    setMovs(null);
    setError(null);
    api<Mov[]>(`/kardex/${encodeURIComponent(codigo)}`).then(setMovs).catch((e) => setError(e.message));
  };
  useEffect(cargar, [codigo, dataset.movimientos]);

  // Buscador de ítem (escribe nombre o código) y de asientos, con paginación de 50.
  const etiqueta = (i: { nombre: string; codigo: string }) => `${i.nombre} (${i.codigo})`;
  const [busca, setBusca] = useState('');
  const [filtroMov, setFiltroMov] = useState('');
  const recientes = useMemo(() => filtrarTexto([...(movs ?? [])].reverse(), filtroMov), [movs, filtroMov]);
  const pag = usePaginado(recientes, 50);
  const ultimo = movs?.at(-1); // el endpoint devuelve en orden cronológico: el último es el saldo vigente
  const u = (item?.unidad ?? '').toLowerCase() || 'unid';
  // Excel con la misma estructura que la tabla (y el Excel de CPP del cliente).
  const filasExcel = () => (movs ?? []).map((m) => ({
    fecha: m.fecha.slice(0, 16).replace('T', ' '), movimiento: TIPOS[m.tipo]?.label ?? m.tipo, documento: m.documento, almacen: m.almacen ?? '',
    [`entrada_${u}`]: m.cantidad > 0 ? m.cantidad : null, ...(valoriza ? { costo_unitario_entrada: m.cantidad > 0 ? m.costoUnitario ?? null : null } : {}),
    [`salida_${u}`]: m.cantidad < 0 ? -m.cantidad : null, [`stock_${u}`]: m.saldoCantidad,
    ...(valoriza ? { valor_del_stock: m.saldoValor ?? null, cpp: m.cpp ?? null } : {}),
  }));

  return (
    <>
      <Encabezado titulo="Kárdex valorizado" descripcion={`${item ? `${item.nombre} · ${item.codigo} · ` : ''}libro inmutable: ningún asiento se edita ni se borra`}
        acciones={<>
          <Boton icono="download" disabled={!movs?.length} onClick={() => exportarExcel(`kardex-${codigo}`, filasExcel())}>Excel</Boton>
          <Boton icono="report" onClick={exportarPdf}>PDF</Boton>
        </>} />

      <Tarjeta>
        <div className="kardex__buscar">
          <label className="filtros__campo"><span>Buscar insumo o producto</span>
            <input list="kardex-items" placeholder={item ? etiqueta(item) : 'Escribe el nombre o el código…'} value={busca}
              onChange={(e) => {
                setBusca(e.target.value);
                const hallado = items.find((i) => etiqueta(i) === e.target.value || i.codigo.toLowerCase() === e.target.value.trim().toLowerCase());
                if (hallado) { setCodigo(hallado.codigo); setBusca(''); }
              }} />
            <datalist id="kardex-items">{items.map((i) => <option key={i.codigo} value={etiqueta(i)}>{i.tipo}</option>)}</datalist>
          </label>
          {item && <div className="kardex__actual"><span>Viendo</span><b>{item.nombre}</b><Insignia>{item.tipo} · {item.codigo}</Insignia></div>}
        </div>
      </Tarjeta>

      <div className="grid grid--auto">
        <Kpi label="Saldo actual" valor={ultimo ? `${num2(ultimo.saldoCantidad)} ${item?.unidad ?? ''}` : '—'} nota="según el último asiento" icono="box" />
        {valoriza && <Kpi label="Valor del saldo" valor={ultimo?.saldoValor !== undefined ? money(ultimo.saldoValor) : '—'} nota="valorizado al CPP" icono="wallet" />}
        {valoriza && <Kpi label="CPP vigente" valor={ultimo?.cpp !== undefined ? money(ultimo.cpp) : '—'} nota={`por ${item?.unidad ?? 'unidad'}`} icono="chart" />}
        <Kpi label="Asientos" valor={num(movs?.length ?? 0)} nota="inmutables y auditados" icono="ledger" />
      </div>

      <Tarjeta padding="none">
        {error ? <Vacio titulo="No se pudo cargar" detalle={error} icono="ledger" onReintentar={cargar} />
          : movs === null ? <TablaEsqueleto columnas={6} />
            : movs.length === 0 ? <Vacio titulo="Sin movimientos" detalle="Este ítem aún no tiene asientos en el kárdex." icono="ledger" />
              : (
                <>
                <div className="tabla__barra"><Buscador valor={filtroMov} onChange={setFiltroMov} placeholder="Buscar por documento, OP, venta o motivo…" /><span className="t-muted">{recientes.length} asientos</span></div>
                <div className="table-wrap">
                  {/* Estructura del Excel del cliente (CPP): entrada con su costo, salida, stock, valor del stock y CPP vigente. */}
                  <table className="table table--kardex">
                    <thead><tr><th>Fecha</th><th>Movimiento</th>
                      <th className="t-right">Entrada ({u})</th>{valoriza && <th className="t-right">Costo unitario de entrada</th>}
                      <th className="t-right">Salida ({u})</th><th className="t-right">Stock ({u})</th>
                      {valoriza && <><th className="t-right">Valor del stock</th><th className="t-right">CPP (por {u})</th></>}</tr></thead>
                    <tbody>
                      {pag.visibles.map((m, i) => {
                        const t = TIPOS[m.tipo] ?? { label: m.tipo, tono: 'neutral' as const };
                        return (
                          <tr key={`${m.fecha}-${i}`}>
                            <td className="t-muted">{m.fecha.slice(0, 16).replace('T', ' ')}</td>
                            <td><Insignia tono={t.tono}>{t.label}</Insignia>
                              <div className="kardex__doc"><span className="mono">{m.documento}</span>{m.almacen ? ` · ${m.almacen}` : ''}{m.lote ? ` · lote ${m.lote}${m.vence ? `, vence ${m.vence}` : ''}` : ''}</div></td>
                            <td className="t-right t-pos">{m.cantidad > 0 ? num3(m.cantidad) : ''}</td>
                            {valoriza && <td className="t-right">{m.cantidad > 0 ? money3(m.costoUnitario ?? 0) : ''}</td>}
                            <td className="t-right t-neg">{m.cantidad < 0 ? num3(-m.cantidad) : ''}</td>
                            <td className="t-right"><strong>{num3(m.saldoCantidad)}</strong></td>
                            {valoriza && <><td className="t-right">{money(m.saldoValor ?? 0)}</td><td className="t-right"><strong>{money3(m.cpp ?? 0)}</strong></td></>}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <Paginador {...pag} />
                </>
              )}
      </Tarjeta>
    </>
  );
}
