import { useMemo, useState } from 'react';
import { useApp } from '@/core/app-state';
import { money, num, pct } from '@/core/format';
import { Boton, Encabezado, Insignia, Kpi, Buscador, Tarjeta, Vacio } from '@/ui/primitives';
import { Tabla, type Columna } from '@/ui/Tabla';
import type { Insumo } from '@/core/types';

export function Almacen() {
  const { dataset } = useApp();
  const [q, setQ] = useState('');

  const insumos = useMemo(
    () => dataset.insumos.filter((i) => i.nombre.toLowerCase().includes(q.toLowerCase())),
    [dataset.insumos, q],
  );

  const bajos = dataset.insumos.filter((i) => i.estado === 'BAJO_MINIMO');
  const valorTotal = dataset.insumos.reduce((s, i) => s + i.valorizado, 0);

  const columnas: Array<Columna<Insumo>> = [
    {
      key: 'nombre', header: 'Insumo',
      render: (i) => (
        <div className="celda-doble">
          <strong>{i.nombre}</strong>
          <span>{i.id} · {i.proveedor}</span>
        </div>
      ),
    },
    { key: 'stock', header: 'Stock', align: 'right', render: (i) => <strong>{num(i.stock)} {i.unidad}</strong> },
    { key: 'minimo', header: 'Mínimo', align: 'right', render: (i) => <span className="t-muted">{num(i.minimo)}</span> },
    { key: 'cpp', header: 'CPP', align: 'right', permiso: 'costos.ver', render: (i) => money(i.cpp) },
    { key: 'valorizado', header: 'Valorizado', align: 'right', permiso: 'costos.ver', render: (i) => money(i.valorizado) },
    {
      key: 'estado', header: 'Estado', align: 'right',
      render: (i) => i.estado === 'BAJO_MINIMO'
        ? <Insignia tono="danger" punto>Bajo mínimo</Insignia>
        : <Insignia tono="ok" punto>Disponible</Insignia>,
    },
  ];

  return (
    <>
      <Encabezado
        titulo="Almacén e inventario"
        descripcion="Stock de insumos y productos terminados, valorizado al costo promedio ponderado"
        acciones={<><Boton icono="download">Exportar</Boton><Boton variant="primary" icono="plus">Registrar movimiento</Boton></>}
      />

      <div className="grid grid--4">
        <Kpi label="Insumos activos" valor={num(dataset.insumos.length)} nota={`${bajos.length} bajo mínimo`} icono="sack" />
        <Kpi label="Valor del stock" valor={money(valorTotal)} nota="costo promedio ponderado" icono="wallet" />
        <Kpi label="Movimientos del día" valor={num(dataset.movimientos.length)} nota="kárdex inmutable" icono="ledger" />
        <Kpi label="Merma valorizada" valor={money(dataset.kpis.mermaValorizada)} nota={pct(dataset.kpis.mermaPct) + ' de la producción'} icono="alert" />
      </div>

      {bajos.length > 0 && (
        <div className="aviso aviso--danger">
          <IconoAlerta />
          <div>
            <strong>{bajos.length} insumos bajo el stock mínimo</strong>
            <p>{bajos.map((b) => b.nombre).join(' · ')}</p>
          </div>
          <Boton size="sm">Ver reposición</Boton>
        </div>
      )}

      <Tarjeta padding="none">
        <div className="card__head card__head--padded">
          <div>
            <h3 className="card__title">Insumos</h3>
            <p className="card__sub">El costo promedio ponderado se recalcula en cada compra</p>
          </div>
          <Buscador valor={q} onChange={setQ} placeholder="Buscar insumo…" />
        </div>
        <Tabla
          columnas={columnas}
          filas={insumos}
          clave={(i) => i.id}
          vacio={<Vacio titulo="Sin resultados" detalle="Prueba con otro nombre de insumo." icono="sack" />}
        />
      </Tarjeta>
    </>
  );
}

function IconoAlerta() {
  return <span className="aviso__icono">!</span>;
}
