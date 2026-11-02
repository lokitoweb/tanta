import { useState } from 'react';
import { api } from '@/core/api';
import { useApp } from '@/core/app-state';
import { money } from '@/core/format';
import { Crud, type Campo } from '@/ui/Crud';
import { Kpi } from '@/ui/primitives';
import type { ColRep } from '@/ui/TablaReporte';

type Reg = Record<string, unknown> & { id?: string };
const guardar = (metodo: 'POST' | 'PATCH', ruta: string) => (d: Reg) => api(ruta, { method: metodo, body: d });

/* ---------------------------------------------------------------- Clientes */
export function Clientes() {
  return (
    <Crud titulo="Clientes" nombreExport="clientes" descripcion="Datos, crédito y lista de precios. El límite de crédito se valida en cada venta al crédito."
      cargar={() => api<Reg[]>('/clientes')}
      nuevo={{ nombre: '', docTipo: 'DNI', docNumero: '', telefono: '', email: '', direccion: '', listaPrecio: 'MINORISTA', diasCredito: 0, limiteCredito: 0, estado: 'ACTIVO' }}
      crear={guardar('POST', '/clientes')} editar={(id, d) => api(`/clientes/${id}`, { method: 'PATCH', body: d })}
      columnas={[
        { key: 'codigo', label: 'Código' }, { key: 'nombre', label: 'Cliente' }, { key: 'docNumero', label: 'Documento' },
        { key: 'telefono', label: 'Teléfono' }, { key: 'listaPrecio', label: 'Lista' }, { key: 'limiteCredito', label: 'Límite', tipo: 'dinero' },
        { key: 'saldo', label: 'Saldo', tipo: 'dinero' }, { key: 'estado', label: 'Estado' },
      ]}
      campos={[
        { key: 'nombre', label: 'Nombre o razón social', requerido: true, ancho: true },
        { key: 'docTipo', label: 'Tipo de documento', tipo: 'select', opciones: [{ valor: 'DNI', texto: 'DNI' }, { valor: 'RUC', texto: 'RUC' }, { valor: 'CE', texto: 'Carné de extranjería' }] },
        { key: 'docNumero', label: 'Número', max: 15, ayuda: 'DNI 8 dígitos · RUC 11 dígitos' },
        { key: 'telefono', label: 'Teléfono', tipo: 'tel', max: 30 }, { key: 'email', label: 'Correo', tipo: 'email' },
        { key: 'direccion', label: 'Dirección de entrega', ancho: true, max: 200 },
        { key: 'listaPrecio', label: 'Lista de precios', tipo: 'select', opciones: ['MINORISTA', 'MAYORISTA', 'CORPORATIVO'].map((v) => ({ valor: v, texto: v[0] + v.slice(1).toLowerCase() })) },
        { key: 'diasCredito', label: 'Días de crédito', tipo: 'numero' }, { key: 'limiteCredito', label: 'Límite de crédito (S/)', tipo: 'numero' },
        { key: 'estado', label: 'Estado', tipo: 'select', opciones: [{ valor: 'ACTIVO', texto: 'Activo' }, { valor: 'INACTIVO', texto: 'Inactivo' }] },
      ]} />
  );
}

/* ------------------------------------------------------- Costos indirectos */
interface ResumenCif { items: Reg[]; baseProrrateo: string; cifPromedioPorUnidad: number }

export function CostosIndirectos() {
  const [r, setR] = useState<ResumenCif | null>(null);
  const cargar = async () => { const x = await api<ResumenCif>('/costos-indirectos'); setR(x); return x.items; };
  const total = (r?.items ?? []).filter((i) => i.activo).reduce((s, i) => s + Number(i.montoMensual), 0);
  const fijos = (r?.items ?? []).filter((i) => i.activo && i.tipo === 'FIJO').reduce((s, i) => s + Number(i.montoMensual), 0);
  return (
    <Crud titulo="Costos indirectos" nombreExport="costos-indirectos"
      descripcion="Alquiler, energía, gas, planilla indirecta… Al guardar, el costo de cada producto se recalcula al instante."
      cargar={cargar} nuevo={{ concepto: '', tipo: 'FIJO', montoMensual: 0, activo: true }}
      crear={guardar('POST', '/costos-indirectos')} editar={(id, d) => api(`/costos-indirectos/${id}`, { method: 'PATCH', body: d })}
      extra={r && (
        <div className="grid grid--4">
          <Kpi label="CIF mensual" valor={money(total)} nota="conceptos activos" icono="wallet" />
          <Kpi label="Costos fijos" valor={money(fijos)} nota={`variables ${money(total - fijos)}`} icono="ledger" />
          <Kpi label="CIF por unidad" valor={money(r.cifPromedioPorUnidad)} nota="promedio de productos" icono="bread" />
          <Kpi label="Base de prorrateo" valor={r.baseProrrateo === 'UNIDADES' ? 'Unidades' : 'Costo de insumos'} nota="se cambia en Parámetros" icono="settings" />
        </div>
      )}
      columnas={[{ key: 'concepto', label: 'Concepto' }, { key: 'tipo', label: 'Tipo' }, { key: 'montoMensual', label: 'Monto mensual', tipo: 'dinero' }, { key: 'activo', label: 'Activo' }]}
      campos={[
        { key: 'concepto', label: 'Concepto', requerido: true, ancho: true, max: 80 },
        { key: 'tipo', label: 'Tipo', tipo: 'select', opciones: [{ valor: 'FIJO', texto: 'Fijo' }, { valor: 'VARIABLE', texto: 'Variable' }] },
        { key: 'montoMensual', label: 'Monto mensual (S/)', tipo: 'numero', requerido: true },
        { key: 'activo', label: 'Activo (se incluye en el costo)', tipo: 'bool' },
      ]} />
  );
}

/* --------------------------------------------------------------- Categorías */
export function Categorias() {
  const { dataset, refrescarDatos } = useApp();
  return (
    <Crud titulo="Categorías" nombreExport="categorias" deps={dataset.categorias} descripcion="Agrupan productos y fijan el margen objetivo del semáforo (verde, ámbar, rojo)."
      cargar={async () => dataset.categorias.map((c) => ({ ...c } as unknown as Reg))}
      nuevo={{ nombre: '', margenObjetivo: 0.5, orden: 0 }}
      crear={async (d) => { await api('/categorias', { method: 'POST', body: d }); await refrescarDatos(); }}
      editar={async (id, d) => { await api(`/categorias/${id}`, { method: 'PATCH', body: d }); await refrescarDatos(); }}
      columnas={[{ key: 'nombre', label: 'Categoría' }, { key: 'margenObjetivo', label: 'Margen objetivo', tipo: 'pct' }, { key: 'margen', label: 'Margen real (30 d)', tipo: 'pct' }, { key: 'ventas', label: 'Ventas (30 d)', tipo: 'dinero' }]}
      campos={[
        { key: 'nombre', label: 'Nombre', requerido: true, max: 60 },
        { key: 'margenObjetivo', label: 'Margen objetivo (%)', tipo: 'pct', requerido: true },
        { key: 'orden', label: 'Orden en listas', tipo: 'numero' },
      ]} />
  );
}

/* ---------------------------------------------------------------- Productos */
export function Productos() {
  const { dataset, puede, refrescarDatos } = useApp();
  const cats = dataset.categorias.map((c) => ({ valor: c.id, texto: c.nombre }));
  const columnas: ColRep[] = [
    { key: 'codigo', label: 'Código' }, { key: 'nombre', label: 'Producto' }, { key: 'categoria', label: 'Categoría' },
    { key: 'precioConIgv', label: 'Precio (con IGV)', tipo: 'dinero' }, { key: 'stock', label: 'Stock', tipo: 'num' },
    ...(puede('costos.ver') ? [{ key: 'costoUnitario', label: 'Costo', tipo: 'dinero' }, { key: 'margen', label: 'Margen', tipo: 'pct' }] as ColRep[] : []),
    { key: 'estado', label: 'Estado' },
  ];
  return (
    <Crud titulo="Productos" nombreExport="productos" deps={dataset.productos}
      descripcion={puede('costos.ver') ? 'El costo sale de la receta (insumos × CPP + merma + CIF). Para cambiarlo, edita la receta o los costos indirectos.' : 'Catálogo de productos y precios.'}
      cargar={async () => dataset.productos.map((p) => ({ ...p, categoria: dataset.categorias.find((c) => c.id === (p as unknown as Reg).categoriaId)?.nombre } as unknown as Reg))}
      nuevo={{ nombre: '', categoriaId: cats[0]?.valor ?? '', unidad: 'UNIDAD', precioConIgv: 0, estado: 'ACTIVO' }}
      crear={puede('maestros.editar') ? async (d) => { await api('/productos', { method: 'POST', body: { ...d, mermaPct: 0.03 } }); await refrescarDatos(); } : undefined}
      editar={puede('maestros.editar') ? async (id, d) => { await api(`/productos/${id}`, { method: 'PATCH', body: d }); await refrescarDatos(); } : undefined}
      columnas={columnas}
      campos={[
        { key: 'nombre', label: 'Nombre', requerido: true, ancho: true, max: 120 },
        { key: 'categoriaId', label: 'Categoría', tipo: 'select', opciones: cats },
        { key: 'unidad', label: 'Unidad de venta', tipo: 'select', opciones: ['UNIDAD', 'KG', 'DOCENA', 'PORCION', 'VASO', 'TORTA'].map((u) => ({ valor: u, texto: u })) },
        { key: 'precioConIgv', label: 'Precio con IGV (S/)', tipo: 'numero', requerido: true },
        { key: 'estado', label: 'Estado', tipo: 'select', opciones: [{ valor: 'ACTIVO', texto: 'Activo' }, { valor: 'INACTIVO', texto: 'Inactivo' }] },
      ]} />
  );
}

/* ------------------------------------------------------------------ Insumos */
export function Insumos() {
  const { dataset, puede, refrescarDatos } = useApp();
  return (
    <Crud titulo="Insumos" nombreExport="insumos" deps={dataset.insumos}
      descripcion="El costo (CPP) no se edita a mano: lo fija cada compra registrada en Almacén."
      cargar={async () => dataset.insumos.map((i) => ({ ...i, activo: (i as unknown as Reg).activo ?? true } as unknown as Reg))}
      nuevo={{ nombre: '', unidad: 'KG', minimo: 0, proveedor: '', activo: true }}
      crear={puede('maestros.editar') ? async (d) => { await api('/insumos', { method: 'POST', body: d }); await refrescarDatos(); } : undefined}
      editar={puede('maestros.editar') ? async (id, d) => { await api(`/insumos/${id}`, { method: 'PATCH', body: d }); await refrescarDatos(); } : undefined}
      columnas={[
        { key: 'codigo', label: 'Código' }, { key: 'nombre', label: 'Insumo' }, { key: 'unidad', label: 'Unidad' },
        { key: 'stock', label: 'Stock', tipo: 'num' }, { key: 'minimo', label: 'Mínimo', tipo: 'num' },
        ...(puede('costos.ver') ? [{ key: 'cpp', label: 'CPP', tipo: 'dinero' } as ColRep] : []),
        { key: 'proveedor', label: 'Proveedor' },
      ]}
      campos={[
        { key: 'nombre', label: 'Nombre', requerido: true, ancho: true, max: 120 },
        { key: 'unidad', label: 'Unidad de medida', tipo: 'select', opciones: ['KG', 'G', 'L', 'ML', 'UNIDAD', 'BALON', 'PAQUETE'].map((u) => ({ valor: u, texto: u })) },
        { key: 'minimo', label: 'Stock mínimo', tipo: 'numero' },
        { key: 'proveedor', label: 'Proveedor', ancho: true, max: 120 },
        { key: 'activo', label: 'Activo', tipo: 'bool' },
      ]} />
  );
}

