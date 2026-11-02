import { useMemo, useState } from 'react';
import { useApp } from '@/core/app-state';
import { money, num } from '@/core/format';
import { Boton, Buscador, Encabezado, Insignia, Tarjeta, Vacio } from '@/ui/primitives';
import { Tabla, type Columna } from '@/ui/Tabla';
import type { Insumo } from '@/core/types';

export function Insumos() {
  const { dataset } = useApp();
  const [q, setQ] = useState('');
  const filas = useMemo(
    () => dataset.insumos.filter((i) => i.nombre.toLowerCase().includes(q.toLowerCase())),
    [dataset.insumos, q],
  );

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
    { key: 'unidad', header: 'Unidad', render: (i) => <span className="t-muted">{i.unidad}</span> },
    { key: 'cpp', header: 'Costo promedio', align: 'right', permiso: 'costos.ver', render: (i) => <strong>{money(i.cpp)}</strong> },
    { key: 'stock', header: 'Stock', align: 'right', render: (i) => `${num(i.stock)}` },
    { key: 'minimo', header: 'Mínimo', align: 'right', render: (i) => <span className="t-muted">{num(i.minimo)}</span> },
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
        titulo="Insumos"
        descripcion="Materias primas y consumibles · el costo promedio pondera cada compra"
        acciones={<><Boton icono="download">Importar</Boton><Boton variant="primary" icono="plus">Nuevo insumo</Boton></>}
      />

      <Tarjeta padding="none">
        <div className="toolbar">
          <Buscador valor={q} onChange={setQ} placeholder="Buscar insumo…" />
        </div>
        <Tabla
          columnas={columnas}
          filas={filas}
          clave={(i) => i.id}
          vacio={<Vacio titulo="Sin insumos" detalle="Ajusta la búsqueda." icono="sack" />}
        />
      </Tarjeta>
    </>
  );
}
