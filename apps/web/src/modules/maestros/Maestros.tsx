import { useState } from 'react';
import { api } from '@/core/api';
import { useApp } from '@/core/app-state';
import { money, num } from '@/core/format';
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
      nuevo={{ nombre: '', docTipo: 'DNI', docNumero: '', telefono: '', email: '', direccion: '', listaPrecio: 'MINORISTA', condicionPago: 'CONTADO', diasCredito: 0, limiteCredito: 0, estado: 'ACTIVO' }}
      crear={guardar('POST', '/clientes')} editar={(id, d) => api(`/clientes/${id}`, { method: 'PATCH', body: d })}
      columnas={[
        { key: 'codigo', label: 'Código' }, { key: 'nombre', label: 'Cliente' }, { key: 'docNumero', label: 'Documento' },
        { key: 'telefono', label: 'Teléfono' }, { key: 'listaPrecio', label: 'Lista' }, { key: 'condicionPago', label: 'Condición' }, { key: 'limiteCredito', label: 'Límite', tipo: 'dinero' },
        { key: 'saldo', label: 'Saldo', tipo: 'dinero' }, { key: 'estado', label: 'Estado' },
      ]}
      campos={[
        { key: 'nombre', label: 'Nombre o razón social', requerido: true, ancho: true },
        { key: 'docTipo', label: 'Tipo de documento', tipo: 'select', opciones: [{ valor: 'DNI', texto: 'DNI' }, { valor: 'RUC', texto: 'RUC' }, { valor: 'CE', texto: 'Carné de extranjería' }] },
        { key: 'docNumero', label: 'Número', max: 15, ayuda: 'DNI 8 dígitos · RUC 11 dígitos' },
        { key: 'telefono', label: 'Teléfono', tipo: 'tel', max: 30 }, { key: 'email', label: 'Correo', tipo: 'email' },
        { key: 'direccion', label: 'Dirección de entrega', ancho: true, max: 200 },
        { key: 'listaPrecio', label: 'Lista de precios', tipo: 'select', opciones: ['MINORISTA', 'MAYORISTA', 'CORPORATIVO'].map((v) => ({ valor: v, texto: v[0] + v.slice(1).toLowerCase() })) },
        { key: 'condicionPago', label: 'Condición de pago', tipo: 'select', opciones: [{ valor: 'CONTADO', texto: 'Contado' }, { valor: 'CREDITO', texto: 'Crédito (puede comprar a plazo)' }] },
        { key: 'diasCredito', label: 'Días de crédito', tipo: 'numero' }, { key: 'limiteCredito', label: 'Límite de crédito (S/)', tipo: 'numero' },
        { key: 'estado', label: 'Estado', tipo: 'select', opciones: [{ valor: 'ACTIVO', texto: 'Activo' }, { valor: 'INACTIVO', texto: 'Inactivo' }] },
      ]} />
  );
}

/* ------------------------------------------------------- Costos indirectos */
interface ResumenCif { items: Reg[]; baseProrrateo: string; cifPromedioPorUnidad: number; tarifas: Record<string, number | null> | null }

const BASES = [{ valor: 'HORAS_HORNO', texto: 'Horas de horno' }, { valor: 'KG_MASA', texto: 'Kg de masa' }, { valor: 'UNIDADES', texto: 'Unidades producidas' }];

export function CostosIndirectos() {
  const [r, setR] = useState<ResumenCif | null>(null);
  const cargar = async () => {
    const x = await api<ResumenCif>('/costos-indirectos'); setR(x);
    return x.items.map((i) => ({ ...i, categoriaTxt: i.categoria === 'GASTO' ? 'Gasto operativo' : 'CIF', baseTxt: BASES.find((b) => b.valor === i.baseReparto)?.texto ?? i.baseReparto }));
  };
  const total = (r?.items ?? []).filter((i) => i.activo).reduce((s, i) => s + Number(i.montoMensual), 0);
  const fijos = (r?.items ?? []).filter((i) => i.activo && i.tipo === 'FIJO').reduce((s, i) => s + Number(i.montoMensual), 0);
  return (
    <Crud titulo="Costos indirectos" nombreExport="costos-indirectos"
      descripcion="Alquiler, energía, gas, planilla indirecta… Al guardar, el costo de cada producto se recalcula al instante."
      cargar={cargar} nuevo={{ concepto: '', tipo: 'FIJO', montoMensual: 0, activo: true, categoria: 'CIF', baseReparto: 'UNIDADES' }}
      crear={guardar('POST', '/costos-indirectos')} editar={(id, d) => api(`/costos-indirectos/${id}`, { method: 'PATCH', body: d })}
      extra={r && (
        <div className="grid grid--auto">
          <Kpi label="CIF mensual" valor={money(total)} nota="conceptos activos" icono="wallet" />
          <Kpi label="Costos fijos" valor={money(fijos)} nota={`variables ${money(total - fijos)}`} icono="ledger" />
          <Kpi label="Tarifa por hora de horno" valor={r.tarifas?.tarifaHoraHorno ? money(r.tarifas.tarifaHoraHorno) : '—'} nota={`${num(r.tarifas?.horasHornoMes ?? 0)} h de horno en 30 días`} icono="oven" />
          <Kpi label="Tarifa por kg de masa" valor={r.tarifas?.tarifaKgMasa ? money(r.tarifas.tarifaKgMasa) : '—'} nota={`${num(r.tarifas?.kgMasaMes ?? 0)} kg de masa en 30 días`} icono="sack" />
          <Kpi label="Hora hombre" valor={r.tarifas?.costoHoraHombre ? money(r.tarifas.costoHoraHombre) : '—'} nota="sueldo × (1 + beneficios) ÷ horas (Parámetros)" icono="user" />
        </div>
      )}
      columnas={[{ key: 'concepto', label: 'Concepto' }, { key: 'categoriaTxt', label: 'Categoría' }, { key: 'baseTxt', label: 'Base de reparto' }, { key: 'tipo', label: 'Tipo' }, { key: 'montoMensual', label: 'Monto mensual', tipo: 'dinero' }, { key: 'activo', label: 'Activo' }]}
      campos={[
        { key: 'concepto', label: 'Concepto', requerido: true, ancho: true, max: 80 },
        { key: 'tipo', label: 'Tipo', tipo: 'select', opciones: [{ valor: 'FIJO', texto: 'Fijo' }, { valor: 'VARIABLE', texto: 'Variable' }] },
        { key: 'montoMensual', label: 'Monto mensual (S/)', tipo: 'numero', requerido: true },
        { key: 'categoria', label: 'Categoría', tipo: 'select', opciones: [{ valor: 'CIF', texto: 'CIF (entra al costo del pan)' }, { valor: 'GASTO', texto: 'Gasto operativo (no entra)' }] },
        { key: 'baseReparto', label: 'Base de reparto', tipo: 'select', opciones: BASES },
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
      descripcion={puede('costos.ver') ? 'Costo = insumos por unidad esperada + mano de obra (horas hombre) + CIF (horas de horno, kg de masa y unidades).' : 'Catálogo de productos y precios.'}
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
        { key: 'pesoMasaG', label: 'Peso de masa cruda por unidad (g)', tipo: 'numero', ayuda: 'Con este dato las unidades por lote salen de la masa de la receta' },
        { key: 'perdidaCoccion', label: 'Pérdida por cocción (%)', tipo: 'pct' },
        { key: 'horasHombreLote', label: 'Horas hombre por lote', tipo: 'numero' },
        { key: 'horasHornoLote', label: 'Horas de horno por lote', tipo: 'numero' },
        { key: 'anticipacionHoras', label: 'Anticipación mínima del pedido (horas)', tipo: 'numero', ayuda: 'Ej.: 24 para tortas por encargo' },
      ]} />
  );
}

/* ------------------------------------------------------------------ Insumos */
export function Insumos() {
  const { dataset, puede, refrescarDatos } = useApp();
  return (
    <Crud titulo="Insumos" nombreExport="insumos" deps={dataset.insumos}
      descripcion="Costo por unidad base = precio ÷ cantidad por presentación hasta la primera compra; desde ahí manda el costo promedio ponderado del kárdex."
      cargar={async () => dataset.insumos.map((i) => ({ ...i, activo: (i as unknown as Reg).activo ?? true } as unknown as Reg))}
      nuevo={{ nombre: '', unidad: 'KG', minimo: 0, proveedor: '', activo: true, tipo: 'OTRO', presentacion: '', precioCompra: '', cantPresentacion: '', equivKg: 1 }}
      crear={puede('maestros.editar') ? async (d) => { await api('/insumos', { method: 'POST', body: d }); await refrescarDatos(); } : undefined}
      editar={puede('maestros.editar') ? async (id, d) => { await api(`/insumos/${id}`, { method: 'PATCH', body: d }); await refrescarDatos(); } : undefined}
      columnas={[
        { key: 'codigo', label: 'Código' }, { key: 'nombre', label: 'Insumo' }, { key: 'tipo', label: 'Tipo' }, { key: 'unidad', label: 'Unidad' },
        { key: 'stock', label: 'Stock', tipo: 'num' }, { key: 'minimo', label: 'Mínimo', tipo: 'num' },
        ...(puede('costos.ver') ? [{ key: 'cpp', label: 'CPP', tipo: 'dinero' } as ColRep] : []),
        { key: 'proveedor', label: 'Proveedor' },
      ]}
      campos={[
        { key: 'nombre', label: 'Nombre', requerido: true, ancho: true, max: 120 },
        { key: 'tipo', label: 'Tipo', tipo: 'select', opciones: [['HARINA', 'Harina (suma 100 % panadero)'], ['GRASA', 'Grasa'], ['LACTEO', 'Lácteo'], ['AZUCAR', 'Azúcar'], ['LEVADURA', 'Levadura'], ['HUEVO', 'Huevo'], ['RELLENO', 'Relleno'], ['ADITIVO', 'Aditivo'], ['LIQUIDO', 'Líquido'], ['OTRO', 'Otro']].map(([v, t]) => ({ valor: v, texto: t })) },
        { key: 'unidad', label: 'Unidad base', tipo: 'select', opciones: [['KG', 'Kilogramo (kg)'], ['L', 'Litro (L)'], ['UNIDAD', 'Unidad'], ['BALON', 'Balón']].map(([v, t]) => ({ valor: v, texto: t })), ayuda: 'En la receta se puede escribir en gr o ml: se convierte sola' },
        { key: 'presentacion', label: 'Presentación de compra', max: 60, ayuda: 'Ej.: saco de 50 kg' },
        { key: 'precioCompra', label: 'Precio de compra (S/ sin IGV)', tipo: 'numero' },
        { key: 'cantPresentacion', label: 'Cantidad por presentación (en unidad base)', tipo: 'numero' },
        { key: 'equivKg', label: 'Equivalente en kg de 1 unidad base', tipo: 'numero', ayuda: 'Aceite: 0.92 · agua: 1 · huevo: 0.05' },
        { key: 'minimo', label: 'Stock mínimo', tipo: 'numero' },
        { key: 'proveedor', label: 'Proveedor', ancho: true, max: 120 },
        { key: 'activo', label: 'Activo', tipo: 'bool' },
      ]} />
  );
}


/* ------------------------------------------------------------- Proveedores */
// MAE-09: RUC único; un proveedor con compras no se elimina, se inactiva.
export function Proveedores() {
  return (
    <Crud titulo="Proveedores" nombreExport="proveedores" descripcion="RUC, contacto e insumos que abastece. Un proveedor con compras solo se inactiva."
      cargar={() => api<Reg[]>('/proveedores')}
      nuevo={{ ruc: '', razonSocial: '', contacto: '', telefono: '', email: '', estado: 'ACTIVO' }}
      crear={guardar('POST', '/proveedores')} editar={(id, d) => api(`/proveedores/${id}`, { method: 'PATCH', body: d })}
      columnas={[
        { key: 'ruc', label: 'RUC' }, { key: 'razonSocial', label: 'Razón social' }, { key: 'contacto', label: 'Contacto' },
        { key: 'telefono', label: 'Teléfono' }, { key: 'insumos', label: 'Insumos que abastece' }, { key: 'compras', label: 'Compras', tipo: 'num' },
        { key: 'estado', label: 'Estado' },
      ]}
      campos={[
        { key: 'razonSocial', label: 'Razón social', requerido: true, ancho: true },
        { key: 'ruc', label: 'RUC', max: 11, ayuda: '11 dígitos; empieza en 10, 15, 17 o 20' },
        { key: 'contacto', label: 'Contacto', max: 120 },
        { key: 'telefono', label: 'Teléfono', tipo: 'tel', max: 30 }, { key: 'email', label: 'Correo', tipo: 'email' },
        { key: 'estado', label: 'Estado', tipo: 'select', opciones: [{ valor: 'ACTIVO', texto: 'Activo' }, { valor: 'INACTIVO', texto: 'Inactivo' }] },
      ]} />
  );
}
