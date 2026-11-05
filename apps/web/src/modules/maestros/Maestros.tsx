import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { useCatalogos } from '@/core/catalogos';
import { useApp } from '@/core/app-state';
import { money, num, pct } from '@/core/format';
import { Crud, type Campo } from '@/ui/Crud';
import { Encabezado, Kpi, Tarjeta, Vacio } from '@/ui/primitives';
import { Importar } from '@/ui/Importar';
import type { ColRep } from '@/ui/TablaReporte';

type Reg = Record<string, unknown> & { id?: string };
type Opcion = { valor: string; texto: string };
/** Opciones de un select cargadas de la API; vacío mientras carga o si no hay permiso. */
function useOpciones(ruta: string, texto: (r: Reg) => string, valor: (r: Reg) => string = (r) => String(r.id)) {
  const [o, setO] = useState<Opcion[]>([]);
  useEffect(() => { api<Reg[]>(ruta).then((l) => setO(l.map((r) => ({ valor: valor(r), texto: texto(r) })))).catch(() => setO([])); }, [ruta]);
  return o;
}
const guardar = (metodo: 'POST' | 'PATCH', ruta: string) => (d: Reg) => api(ruta, { method: metodo, body: d });

/* ---------------------------------------------------------------- Clientes */
export function Clientes() {
  const vendedores = useOpciones('/vendedores', (r) => String(r.nombre));
  return (
    <Crud titulo="Clientes" nombreExport="clientes" descripcion="Datos, crédito y lista de precios. El límite de crédito se valida en cada venta al crédito."
      cargar={() => api<Reg[]>('/clientes')}
      nuevo={{ nombre: '', docTipo: 'DNI', docNumero: '', telefono: '', email: '', direccion: '', listaPrecio: 'MINORISTA', condicionPago: 'CONTADO', diasCredito: 0, limiteCredito: 0, estado: 'ACTIVO', vendedorId: '' }}
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
        { key: 'vendedorId', label: 'Vendedor asignado', tipo: 'select', opciones: [{ valor: '', texto: 'Sin asignar' }, ...vendedores] },
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
    <Crud titulo="Categorías" nombreExport="categorias" deps={dataset.categorias} descripcion="Agrupan los productos en el catálogo, las ventas y los reportes. Una categoría con productos no se puede eliminar."
      // Orden de presentación (campo «Orden en listas») y, a igual orden, alfabético.
      cargar={async () => [...dataset.categorias]
        .sort((a, b) => (Number((a as unknown as Reg).orden ?? 0) - Number((b as unknown as Reg).orden ?? 0)) || a.nombre.localeCompare(b.nombre, 'es'))
        .map((c) => ({ ...c } as unknown as Reg))}
      nuevo={{ nombre: '', orden: 0 }}
      crear={async (d) => { await api('/categorias', { method: 'POST', body: d }); await refrescarDatos(); }}
      editar={async (id, d) => { await api(`/categorias/${id}`, { method: 'PATCH', body: d }); await refrescarDatos(); }}
      eliminar={async (id) => { await api(`/categorias/${id}`, { method: 'DELETE' }); await refrescarDatos(); }}
      columnas={[{ key: 'nombre', label: 'Categoría' }]}
      campos={[
        { key: 'nombre', label: 'Nombre', requerido: true, max: 60 },
        { key: 'orden', label: 'Orden en listas', tipo: 'numero', ayuda: '0 = primero. A igual orden, alfabético' },
      ]} />
  );
}

/* ---------------------------------------------------------------- Productos */
export function Productos() {
  const { dataset, puede, refrescarDatos } = useApp();
  const cats = dataset.categorias.map((c) => ({ valor: c.id, texto: c.nombre }));
  // Unidad de venta: unidades de conteo o masa del catálogo.
  const unidadesVenta = useCatalogos().unidades.filter((u) => u.familia !== 'VOLUMEN').map((u) => ({ valor: u.codigo, texto: u.descripcion }));
  const verCosto = puede('costos.ver');
  const igv = dataset.negocio.igv;
  const n = (v: unknown) => (v === '' || v === null || v === undefined ? NaN : Number(v));
  const neto = (form: Reg) => n(form.precioConIgv) / (1 + igv);

  const columnas: ColRep[] = [
    { key: 'codigo', label: 'Código' }, { key: 'nombre', label: 'Producto' }, { key: 'categoria', label: 'Categoría' },
    { key: 'precioConIgv', label: 'Precio (con IGV)', tipo: 'dinero' }, { key: 'stock', label: 'Stock', tipo: 'num' },
    ...(verCosto ? [{ key: 'costoUnitario', label: 'Costo', tipo: 'dinero' }, { key: 'margen', label: 'Margen', tipo: 'pct' }] as ColRep[] : []),
    { key: 'estado', label: 'Estado' },
  ];
  return (
    <Crud titulo="Productos" nombreExport="productos" deps={dataset.productos}
      descripcion={verCosto ? 'Datos de cada pan. Cómo se forma su costo y el precio sugerido están en Gerencia → Análisis de precios.' : 'Catálogo de productos y precios.'}
      cargar={async () => dataset.productos.map((p) => ({ ...p, categoria: dataset.categorias.find((c) => c.id === (p as unknown as Reg).categoriaId)?.nombre } as unknown as Reg))}
      nuevo={{ codigo: '', nombre: '', categoriaId: cats[0]?.valor ?? '', unidad: 'UNIDAD', precioConIgv: 0, estado: 'ACTIVO' }}
      // Alta en dos pasos: se crea (código, nombre, categoría, precio) y se guardan los datos de producción con la misma validación de la edición.
      crear={puede('maestros.editar') ? async (d) => {
        const r = await api<{ id: string }>('/productos', { method: 'POST', body: { ...d, mermaPct: 0.03 } });
        await api(`/productos/${r.id}`, { method: 'PATCH', body: { ...d, codigo: undefined } });
        await refrescarDatos();
      } : undefined}
      editar={puede('maestros.editar') ? async (id, d) => { await api(`/productos/${id}`, { method: 'PATCH', body: d }); await refrescarDatos(); } : undefined}
      columnas={columnas}
      campos={[
        { key: 'imagenUrl', label: 'Imagen del catálogo', tipo: 'imagen', ayuda: 'PNG, JPEG o WebP. La ven los clientes en la web y la app.' },
        { key: 'codigo', label: 'Código', max: 20, placeholder: 'Automático (P001…)', ayuda: 'Escríbelo o déjalo vacío para que el sistema lo genere' },
        { key: 'nombre', label: 'Nombre', requerido: true, max: 120 },
        { key: 'categoriaId', label: 'Categoría', tipo: 'select', opciones: cats },
        { key: 'unidad', label: 'Unidad de venta (presentación)', tipo: 'select', opciones: unidadesVenta, ayuda: 'Se administran en Maestros → Catálogos → Unidades' },
        { key: 'precioConIgv', label: 'Precio de venta con IGV (S/)', tipo: 'numero', requerido: true },
        { key: 'c-neto', label: 'Precio neto sin IGV (S/)', tipo: 'calculado', calcular: (form) => (Number.isFinite(neto(form)) ? money(neto(form)) : '—'), ayuda: `Precio con IGV ÷ ${(1 + igv).toFixed(2)}` },
        { key: 'pesoMasaG', label: 'Peso de masa cruda por unidad (g)', tipo: 'numero', ayuda: 'El bollito pesado antes de entrar al horno' },
        { key: 'pesoFinalG', label: 'Peso final por unidad (g)', tipo: 'numero', ayuda: 'El pan pesado al salir del horno' },
        { key: 'c-perdida', label: 'Pérdida por cocción', tipo: 'calculado', ayuda: 'Lo calcula el sistema: 1 − peso final ÷ peso crudo',
          calcular: (form) => { const c = n(form.pesoMasaG), fin = n(form.pesoFinalG); return c > 0 && fin > 0 ? (fin > c ? 'El peso final no puede superar al crudo' : pct(1 - fin / c)) : '—'; } },
        { key: 'unidadesLote', label: 'Unidades por lote (bandeja al horno)', tipo: 'numero', ayuda: 'Cuántos panes entran al horno a la vez' },
        { key: 'horasHornoLote', label: 'Tiempo de horneado por lote (horas)', tipo: 'numero', ayuda: 'Ej.: 0.5 = media hora. Con él se calculan el gas del horno y la mano de obra' },
        { key: 'vidaUtilDias', label: 'Días de vida útil', tipo: 'numero', ayuda: 'Días que se puede vender desde que sale del horno. Cada horneada guarda su fecha de producción y de vencimiento' },
        { key: 'estado', label: 'Estado', tipo: 'select', opciones: [{ valor: 'ACTIVO', texto: 'Activo' }, { valor: 'INACTIVO', texto: 'Inactivo' }] },
        { key: 'anticipacionHoras', label: 'Anticipación mínima del pedido (horas)', tipo: 'numero', ayuda: 'Ej.: 24 para pan por encargo' },
        { key: 'insumoId', label: 'Produce el insumo (sub-receta)', tipo: 'select',
          opciones: [{ valor: '', texto: 'No: es un producto de venta' }, ...dataset.insumos.map((i) => ({ valor: i.id, texto: `${i.nombre} (${i.unidadInventario ?? i.unidad})` }))],
          ayuda: 'Solo masa madre o rellenos: entra al almacén de insumos y no se vende' },
      ]} />
  );
}

/**
 * Análisis de costo y precio (fuera del registro, como pidió el dueño): cómo se forma el costo de un pan
 * con su receta, la mano de obra y los costos indirectos del mes, cuánto deja hoy y qué precio haría falta
 * para un margen o markup objetivo (COS-10 / RN-16 / RN-17). El costo cambia solo cuando cambian las compras.
 */
export function AnalisisPrecio({ productos, recetas, igv }: {
  productos: Array<{ id: string; nombre: string; costoUnitario: number; precioConIgv: number }>; recetas: Array<Record<string, unknown>>; igv: number;
}) {
  const [id, setId] = useState(productos[0]?.id ?? '');
  const [modo, setModo] = useState<'margen' | 'markup'>('margen');
  const [valor, setValor] = useState(40);
  const p = productos.find((x) => x.id === id);
  if (!p) return null;
  const r = recetas.find((x) => x.productoId === id);
  const v = (k: string) => Number(r?.[k] ?? 0);
  const costo = r ? v('costoConMerma') + v('moUnit') + v('cifUnit') : p.costoUnitario;
  const netoActual = p.precioConIgv / (1 + igv);
  const utilidad = netoActual - costo;
  const f = valor / 100;
  const netoSugerido = modo === 'margen' ? (f < 1 ? costo / (1 - f) : 0) : costo * (1 + f);
  const filas: Array<[string, string, string]> = r ? [
    ['Masa total del lote', `${v('masaLoteKg').toFixed(3)} kg`, 'Suma de los insumos de la receta'],
    ['Unidades por lote (teóricas → esperadas)', `${v('unidadesTeoricas').toFixed(1)} → ${v('unidadesEsperadas').toFixed(1)}`, 'Masa ÷ peso crudo; luego se descuenta la merma de proceso'],
    ['Costo de insumos del lote', money(v('costoLote')), 'Cantidad de la receta × costo promedio de cada insumo'],
    ['Insumos por unidad (con merma)', money(v('costoConMerma')), 'Costo de insumos × (1 + % merma)'],
    ['Mano de obra por unidad', money(v('moUnit')), 'Tiempo de horneado × costo de la hora ÷ unidades por lote'],
    ['Costos indirectos por unidad', money(v('cifUnit')), 'Gas, luz, alquiler… repartidos por hora de horno, kg de masa y unidad'],
  ] : [];
  return (
    <Tarjeta>
      <div className="form form--2col">
        <label className="field"><span className="field__label">Producto</span>
          <select className="field__input" value={id} onChange={(e) => setId(e.target.value)}>{productos.map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}</select></label>
        <label className="field"><span className="field__label">Precio sugerido según</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <select className="field__input" style={{ maxWidth: 120 }} value={modo} onChange={(e) => setModo(e.target.value as 'margen' | 'markup')}><option value="margen">Margen</option><option value="markup">Markup</option></select>
            <input className="field__input" type="number" min={0} max={modo === 'margen' ? 95 : 1000} step="0.5" value={valor} aria-label={modo === 'margen' ? 'Margen objetivo (%)' : 'Markup (%)'} onChange={(e) => setValor(Number(e.target.value))} />
          </div></label>
      </div>
      {r ? (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="table">
            <thead><tr><th>Concepto</th><th className="t-right">Valor</th><th>Cómo se calcula</th></tr></thead>
            <tbody>
              {filas.map(([c, val, como]) => <tr key={c}><td>{c}</td><td className="t-right">{val}</td><td className="t-muted">{como}</td></tr>)}
              <tr><td><b>Costo total por unidad</b></td><td className="t-right"><b>{money(costo)}</b></td><td className="t-muted">Insumos + mano de obra + costos indirectos</td></tr>
            </tbody>
          </table>
        </div>
      ) : <p className="t-muted" style={{ marginTop: 12 }}>Este producto aún no tiene receta: regístrala en Maestros → Recetas para ver su costo.</p>}
      <div className="grid grid--auto" style={{ marginTop: 12 }}>
        <Kpi label="Precio actual sin IGV" valor={money(netoActual)} nota={'con IGV ' + money(p.precioConIgv)} icono="wallet" />
        <Kpi label="Utilidad y margen hoy" valor={money(utilidad)} nota={`margen ${netoActual > 0 ? pct(utilidad / netoActual) : '—'} · markup ${costo > 0 ? pct(utilidad / costo) : '—'}`} icono="chart" />
        <Kpi label="Precio sugerido con IGV" valor={money(netoSugerido * (1 + igv))} nota={'sin IGV ' + money(netoSugerido)} icono="spark" />
      </div>
    </Tarjeta>
  );
}

/* ------------------------------------------------------------------ Insumos */
export function Insumos() {
  const { dataset, puede, refrescarDatos } = useApp();
  const cat = useCatalogos();
  const op = (l: Array<{ codigo: string; nombre?: string; descripcion?: string }>) => l.map((x) => ({ valor: x.codigo, texto: x.nombre ?? `${x.descripcion} (${x.codigo.toLowerCase()})` }));
  // Insumos: Administración y Compras (informe de compra de insumos, sección 7).
  const editaInsumos = puede('maestros.editar') || puede('insumos.gestionar');
  const proveedores = useOpciones('/proveedores', (r) => String(r.razonSocial), (r) => String(r.razonSocial));
  return (
    <Crud titulo="Insumos" nombreExport="insumos" deps={dataset.insumos}
      descripcion="Costo por unidad base = precio ÷ cantidad por presentación hasta la primera compra; desde ahí manda el costo promedio ponderado del kárdex."
      cargar={async () => dataset.insumos.map((i) => ({ ...i, activo: (i as unknown as Reg).activo ?? true } as unknown as Reg))}
      nuevo={{ nombre: '', unidad: 'KG', unidadInventario: 'KG', minimo: 0, proveedor: '', activo: true, tipo: 'OTRO', presentacion: '', precioCompra: '', cantPresentacion: '', equivKg: '' }}
      crear={editaInsumos ? async (d) => { await api('/insumos', { method: 'POST', body: d }); await refrescarDatos(); } : undefined}
      acciones={editaInsumos && (
        <Importar titulo="Importar insumos" descripcion="Carga la Lista de Insumos desde la plantilla. Las filas con error se muestran con su motivo y no frenan a las válidas; no se duplican nombres."
          plantilla={{ nombre: 'Harina preparada', tipo: 'HARINA', unidad: 'KG', unidadInventario: 'KG', minimo: 25, proveedor: '', presentacion: 'Saco 50 kg', precioCompra: 120, cantPresentacion: 50, equivKg: '' }}
          numericas={['minimo', 'precioCompra', 'cantPresentacion', 'equivKg']}
          enviar={async (filas) => { const r = await api<{ creados: unknown[]; errores: Array<{ fila: number; nombre: string; motivo: string }> }>('/insumos/importar', { method: 'POST', body: { filas } }); return { ok: r.creados.length, errores: r.errores }; }}
          onListo={() => void refrescarDatos()} />
      )}
      editar={editaInsumos ? async (id, d) => { await api(`/insumos/${id}`, { method: 'PATCH', body: d }); await refrescarDatos(); } : undefined}
      columnas={[
        { key: 'codigo', label: 'Código' }, { key: 'nombre', label: 'Insumo' }, { key: 'tipo', label: 'Tipo' }, { key: 'unidad', label: 'Unidad' },
        { key: 'unidadInventario', label: 'Stock en' }, { key: 'stock', label: 'Stock', tipo: 'num' }, { key: 'minimo', label: 'Mínimo', tipo: 'num' },
        ...(puede('costos.ver') ? [{ key: 'cpp', label: 'CPP', tipo: 'dinero' } as ColRep] : []),
        { key: 'proveedor', label: 'Proveedor' },
      ]}
      campos={[
        { key: 'nombre', label: 'Nombre', requerido: true, ancho: true, max: 120 },
        { key: 'tipo', label: 'Tipo', tipo: 'select', opciones: cat.tiposInsumo.map((t) => ({ valor: t.codigo, texto: t.esHarina ? `${t.nombre} (suma 100 % panadero)` : t.nombre })), ayuda: 'Se administran en Maestros → Catálogos' },
        { key: 'unidad', label: 'Unidad base', tipo: 'select', opciones: op(cat.unidades), ayuda: 'En la receta se puede escribir en gr o ml: se convierte sola' },
        { key: 'unidadInventario', label: 'Unidad de inventario (en la que se lleva el stock)', tipo: 'select', opciones: op(cat.unidades), ayuda: 'Aceite: se compra en L y se lleva en kg. No se cambia si el insumo ya tiene stock.' },
        { key: 'presentacion', label: 'Presentación de compra', max: 60, ayuda: 'Ej.: botella de 900 ml, saco de 50 kg' },
        { key: 'precioCompra', label: 'Precio de compra (S/ sin IGV)', tipo: 'numero' },
        { key: 'cantPresentacion', label: 'Contenido de la presentación (en unidad base)', tipo: 'numero', ayuda: 'Botella de 900 ml con unidad base L: 0.9' },
        { key: 'equivKg', label: 'Densidad: kg por 1 unidad base', tipo: 'numero', ayuda: 'Obligatoria si la unidad base es L o unidad y el stock va en kg. Aceite: 0.917 · huevo: 0.05' },
        { key: 'minimo', label: 'Stock mínimo (en la unidad de inventario)', tipo: 'numero', ayuda: 'Por debajo se avisa a Almacén y Gerencia (RN-25)' },
        { key: 'proveedor', label: 'Proveedor habitual', ancho: true, tipo: 'select', opciones: [{ valor: '', texto: 'Sin proveedor' }, ...proveedores], ayuda: 'Se elige del maestro de proveedores' },
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
      nuevo={{ ruc: '', razonSocial: '', contacto: '', telefono: '', email: '', direccion: '', vendedor: '', banco: '', cci: '', estado: 'ACTIVO' }}
      crear={guardar('POST', '/proveedores')} editar={(id, d) => api(`/proveedores/${id}`, { method: 'PATCH', body: d })}
      columnas={[
        { key: 'ruc', label: 'RUC' }, { key: 'razonSocial', label: 'Razón social' }, { key: 'contacto', label: 'Contacto' },
        { key: 'telefono', label: 'Teléfono' }, { key: 'insumos', label: 'Insumos que abastece' }, { key: 'compras', label: 'Compras', tipo: 'num' },
        { key: 'estado', label: 'Estado' },
      ]}
      campos={[
        { key: 'razonSocial', label: 'Razón social', requerido: true, ancho: true },
        { key: 'ruc', label: 'RUC', max: 11, requerido: true, ayuda: 'Obligatorio y único: 11 dígitos; empieza en 10, 15, 17 o 20' },
        { key: 'contacto', label: 'Contacto', max: 120 },
        { key: 'telefono', label: 'Teléfono', tipo: 'tel', max: 30 }, { key: 'email', label: 'Correo', tipo: 'email' },
        { key: 'direccion', label: 'Dirección', ancho: true, max: 200 },
        { key: 'vendedor', label: 'Vendedor que nos atiende', max: 100 },
        { key: 'banco', label: 'Banco', max: 60, ayuda: 'Para pagos por transferencia' },
        { key: 'cci', label: 'CCI', max: 20, ayuda: 'Código de cuenta interbancaria: 20 dígitos' },
        { key: 'estado', label: 'Estado', tipo: 'select', opciones: [{ valor: 'ACTIVO', texto: 'Activo' }, { valor: 'INACTIVO', texto: 'Inactivo' }] },
      ]} />
  );
}

/* --------------------------------------------------------------- Almacenes */
// MAE-10 / W12: almacén de insumos y de productos terminados, con responsable. El principal recibe los movimientos.
export function Almacenes() {
  const responsables = useOpciones('/almacenes/responsables', (r) => String(r.nombre));
  return (
    <Crud titulo="Almacenes" nombreExport="almacenes" descripcion="Cada movimiento de inventario queda en el almacén principal de su tipo. Solo hay un principal por tipo."
      cargar={() => api<Reg[]>('/almacenes')}
      nuevo={{ nombre: '', tipo: 'INSUMOS', responsableId: '', ubicacion: '', principal: false, estado: 'ACTIVO' }}
      crear={guardar('POST', '/almacenes')} editar={(id, d) => api(`/almacenes/${id}`, { method: 'PATCH', body: d })}
      columnas={[
        { key: 'nombre', label: 'Almacén' }, { key: 'tipo', label: 'Tipo' }, { key: 'responsable', label: 'Responsable' },
        { key: 'ubicacion', label: 'Ubicación' }, { key: 'movimientos', label: 'Movimientos', tipo: 'num' }, { key: 'estado', label: 'Estado' },
      ]}
      campos={[
        { key: 'nombre', label: 'Nombre', requerido: true, ancho: true, max: 80 },
        { key: 'tipo', label: 'Tipo', tipo: 'select', opciones: [{ valor: 'INSUMOS', texto: 'Insumos' }, { valor: 'PRODUCTOS', texto: 'Productos terminados' }] },
        { key: 'responsableId', label: 'Responsable', tipo: 'select', opciones: [{ valor: '', texto: 'Sin responsable' }, ...responsables] },
        { key: 'ubicacion', label: 'Ubicación', ancho: true, max: 160 },
        { key: 'principal', label: 'Principal de su tipo (recibe los movimientos)', tipo: 'bool' },
        { key: 'estado', label: 'Estado', tipo: 'select', opciones: [{ valor: 'ACTIVO', texto: 'Activo' }, { valor: 'INACTIVO', texto: 'Inactivo' }] },
      ]} />
  );
}

/* ------------------------------------------------- Gerencia: análisis de precios */
export function AnalisisPrecios() {
  const { dataset } = useApp();
  const productos = dataset.productos.filter((p) => !p.insumoId && p.estado === 'ACTIVO');
  return (
    <>
      <Encabezado titulo="Análisis de precios" descripcion="Cómo se forma el costo de cada pan y qué precio conviene. Se actualiza solo cuando cambian los precios de compra o los costos indirectos." />
      {productos.length ? <AnalisisPrecio igv={dataset.negocio.igv} productos={productos} recetas={dataset.recetas as unknown as Array<Record<string, unknown>>} />
        : <Vacio titulo="Sin productos activos" detalle="Registra productos en Maestros → Productos." />}
    </>
  );
}
