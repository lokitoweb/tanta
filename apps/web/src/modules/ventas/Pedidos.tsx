import { useMemo, useState } from 'react';
import { exportarExcel, exportarPdf } from '@/core/exportar';
import { useApp } from '@/core/app-state';
import { money, num } from '@/core/format';
import { Boton, Buscador, Encabezado, Insignia, Tarjeta, Vacio } from '@/ui/primitives';
import { Tabla, type Columna } from '@/ui/Tabla';
import type { Pedido } from '@/core/types';

const ESTADOS: Record<string, { label: string; tono: 'info' | 'warn' | 'ok' | 'danger' | 'neutral' }> = {
  REGISTRADO: { label: 'Registrado', tono: 'neutral' },
  EN_PRODUCCION: { label: 'En producción', tono: 'warn' },
  LISTO: { label: 'Listo', tono: 'info' },
  DESPACHADO: { label: 'Despachado', tono: 'info' },
  ENTREGADO: { label: 'Entregado', tono: 'ok' },
  CANCELADO: { label: 'Cancelado', tono: 'danger' },
};

export function Pedidos() {
  const { dataset } = useApp();
  const [q, setQ] = useState('');
  const [estado, setEstado] = useState('todos');

  const filas = useMemo(
    () => dataset.pedidos.filter(
      (p) => (estado === 'todos' || p.estado === estado) &&
        (p.cliente.toLowerCase().includes(q.toLowerCase()) || p.codigo.toLowerCase().includes(q.toLowerCase())),
    ),
    [dataset.pedidos, q, estado],
  );

  const porEstado = (e: string) => dataset.pedidos.filter((p) => p.estado === e).length;

  const columnas: Array<Columna<Pedido>> = [
    {
      key: 'codigo', header: 'Pedido',
      render: (p) => (
        <div className="celda-doble">
          <strong className="mono">{p.codigo}</strong>
          <span>{p.fechaEntrega}</span>
        </div>
      ),
    },
    { key: 'cliente', header: 'Cliente', render: (p) => p.cliente },
    { key: 'vendedor', header: 'Vendedor', render: (p) => <span className="t-muted">{p.vendedor}</span> },
    { key: 'total', header: 'Total', align: 'right', render: (p) => <strong>{money(p.total)}</strong> },
    {
      key: 'estado', header: 'Estado', align: 'right',
      render: (p) => {
        const e = ESTADOS[p.estado] ?? { label: p.estado, tono: 'neutral' as const };
        return <Insignia tono={e.tono} punto>{e.label}</Insignia>;
      },
    },
  ];

  return (
    <>
      <Encabezado
        titulo="Pedidos"
        descripcion="Del registro del cliente al despacho · cada cambio de estado queda auditado"
        acciones={<><Boton icono="download" onClick={() => exportarExcel('pedidos', filas.map((p) => ({ ...p })))}>Excel</Boton><Boton icono="report" onClick={exportarPdf}>PDF</Boton><Boton variant="primary" icono="plus">Registrar pedido</Boton></>}
      />

      <div className="grid grid--4">
        <Tarjeta className="mini-stat"><span>Por producir</span><b>{porEstado('EN_PRODUCCION') + porEstado('REGISTRADO')}</b></Tarjeta>
        <Tarjeta className="mini-stat"><span>Listos para despacho</span><b>{porEstado('LISTO')}</b></Tarjeta>
        <Tarjeta className="mini-stat"><span>Entregados</span><b>{porEstado('ENTREGADO')}</b></Tarjeta>
        <Tarjeta className="mini-stat"><span>Monto en cartera</span><b>{money(dataset.kpis.porCobrar)}</b></Tarjeta>
      </div>

      <Tarjeta padding="none">
        <div className="toolbar">
          <Buscador valor={q} onChange={setQ} placeholder="Buscar por cliente o código…" />
          <div className="chips">
            <button className={`chipfilter ${estado === 'todos' ? 'is-active' : ''}`} onClick={() => setEstado('todos')}>Todos</button>
            {Object.entries(ESTADOS).map(([k, v]) => (
              <button key={k} className={`chipfilter ${estado === k ? 'is-active' : ''}`} onClick={() => setEstado(k)}>
                {v.label} <b>{porEstado(k)}</b>
              </button>
            ))}
          </div>
        </div>
        <Tabla
          columnas={columnas}
          filas={filas}
          clave={(p) => p.codigo}
          onFila={() => undefined}
          vacio={<Vacio titulo="Sin pedidos" detalle={`No hay pedidos en estado "${ESTADOS[estado]?.label ?? estado}".`} icono="clipboard" />}
        />
        <div className="card__foot">
          <span className="t-muted">{num(filas.length)} pedidos · {money(filas.reduce((s, p) => s + p.total, 0))} en total</span>
        </div>
      </Tarjeta>
    </>
  );
}
