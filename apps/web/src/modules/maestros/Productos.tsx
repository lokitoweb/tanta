import { useMemo, useState } from 'react';
import { useApp } from '@/core/app-state';
import { money, num, pct, semaforo } from '@/core/format';
import { Boton, Buscador, Encabezado, Insignia, Tarjeta, Vacio } from '@/ui/primitives';
import { Tabla, type Columna } from '@/ui/Tabla';
import type { Producto } from '@/core/types';

export function Productos() {
  const { dataset, puede } = useApp();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string>('todas');

  const filas = useMemo(
    () => dataset.productos.filter(
      (p) => p.nombre.toLowerCase().includes(q.toLowerCase()) && (cat === 'todas' || p.categoriaId === cat),
    ),
    [dataset.productos, q, cat],
  );

  const columnas: Array<Columna<Producto>> = [
    {
      key: 'nombre', header: 'Producto',
      render: (p) => (
        <div className="celda-doble">
          <strong>{p.nombre}</strong>
          <span>{p.codigo} · {p.unidad} · {dataset.categorias.find((c) => c.id === p.categoriaId)?.nombre}</span>
        </div>
      ),
    },
    { key: 'precioConIgv', header: 'Precio c/IGV', align: 'right', render: (p) => <strong>{money(p.precioConIgv)}</strong> },
    { key: 'precioNeto', header: 'Neto', align: 'right', render: (p) => <span className="t-muted">{money(p.precioNeto)}</span> },
    { key: 'costoUnitario', header: 'Costo', align: 'right', permiso: 'costos.ver', render: (p) => money(p.costoUnitario) },
    {
      key: 'margen', header: 'Margen', align: 'right', permiso: 'costos.ver',
      render: (p) => {
        const s = semaforo(p.margen, p.margenObjetivo);
        return <Insignia tono={s === 'ok' ? 'ok' : s === 'warn' ? 'warn' : 'danger'}>{pct(p.margen)}</Insignia>;
      },
    },
    { key: 'vendidos30d', header: 'Vendidos 30d', align: 'right', render: (p) => num(p.vendidos30d) },
    {
      key: 'estado', header: 'Estado', align: 'right',
      render: (p) => <Insignia tono={p.estado === 'ACTIVO' ? 'ok' : 'neutral'} punto>{p.estado === 'ACTIVO' ? 'Activo' : 'Inactivo'}</Insignia>,
    },
  ];

  return (
    <>
      <Encabezado
        titulo="Productos"
        descripcion={`${dataset.productos.length} productos · el precio incluye IGV y el margen se calcula sobre el precio neto`}
        acciones={<><Boton icono="download">Importar</Boton><Boton variant="primary" icono="plus">Nuevo producto</Boton></>}
      />

      <Tarjeta padding="none">
        <div className="toolbar">
          <Buscador valor={q} onChange={setQ} placeholder="Buscar producto…" />
          <div className="chips">
            <button className={`chipfilter ${cat === 'todas' ? 'is-active' : ''}`} onClick={() => setCat('todas')}>Todas</button>
            {dataset.categorias.map((c) => (
              <button key={c.id} className={`chipfilter ${cat === c.id ? 'is-active' : ''}`} onClick={() => setCat(c.id)}>{c.nombre}</button>
            ))}
          </div>
          {!puede('costos.ver') && <Insignia tono="neutral">Costo y margen ocultos para tu perfil</Insignia>}
        </div>

        <Tabla
          columnas={columnas}
          filas={filas}
          clave={(p) => p.id}
          onFila={() => undefined}
          vacio={<Vacio titulo="Sin productos" detalle="Ajusta la búsqueda o el filtro de categoría." icono="bread" />}
        />
      </Tarjeta>
    </>
  );
}
