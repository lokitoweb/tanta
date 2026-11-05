import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { useCatalogos } from '@/core/catalogos';
import { useApp } from '@/core/app-state';
import { money, num, pct } from '@/core/format';
import { exportarExcel } from '@/core/exportar';
import { Crud, type Campo } from '@/ui/Crud';
import { Dialogo } from '@/ui/Dialogo';
import { Boton, Encabezado, Insignia, Kpi, Tarjeta, Vacio } from '@/ui/primitives';
import { Importar } from '@/ui/Importar';
import type { ColRep } from '@/ui/TablaReporte';
import type { Producto } from '@/core/types';

type Reg = Record<string, unknown> & { id?: string };
type Opcion = { valor: string; texto: string };
/** Opciones de un select cargadas de la API; vacío mientras carga o si no hay permiso. */
function useOpciones(ruta: string, texto: (r: Reg) => string, valor: (r: Reg) => string = (r) => String(r.id)) {
  const [o, setO] = useState<Opcion[]>([]);
  useEffect(() => { api<Reg[]>(ruta).then((l) => setO(l.map((r) => ({ valor: valor(r), texto: texto(r) })))).catch(() => setO([])); }, [ruta]);
  return o;
}
const guardar = (metodo: 'POST' | 'PATCH', ruta: string) => (d: Reg) => api(ruta, { method: metodo, body: d });
const ESTADOS: Opcion[] = [{ valor: 'ACTIVO', texto: 'Activo' }, { valor: 'INACTIVO', texto: 'Inactivo' }];
/** Campo «Código» del Excel: se escribe o, vacío, lo genera el sistema. */
const campoCodigo = (ejemplo: string): Campo => ({ key: 'codigo', label: 'Código', max: 20, placeholder: `Automático (${ejemplo})`, ayuda: 'Escríbelo o déjalo vacío para que el sistema lo genere' });
const n = (v: unknown) => (v === '' || v === null || v === undefined ? NaN : Number(v));
const aviso = (tono: 'ok' | 'danger', texto: string) => <div className={`aviso aviso--${tono}`} role="status"><span className="aviso__icono">{tono === 'ok' ? '✓' : '!'}</span><div><p>{texto}</p></div></div>;

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
        { key: 'estado', label: 'Estado', tipo: 'select', opciones: ESTADOS },
      ]} />
  );
}

/* ------------------------------------------------------- Costos indirectos */
interface ResumenCif { items: Reg[]; baseProrrateo: string; cifPromedioPorUnidad: number; tarifas: Record<string, number | null> | null }

const BASES = [{ valor: 'HORAS_HORNO', texto: 'Horas de horno' }, { valor: 'KG_MASA', texto: 'Kg de masa' }, { valor: 'UNIDADES', texto: 'Unidades producidas' }];
const CLASIFICACIONES = [{ valor: 'PRODUCCION', texto: 'Costo de producción (entra al costo del pan)' }, { valor: 'OPERATIVO', texto: 'Costo operativo' }, { valor: 'VENTAS', texto: 'Costo de ventas' }];

export function CostosIndirectos() {
  const [r, setR] = useState<ResumenCif | null>(null);
  const cargar = async () => {
    const x = await api<ResumenCif>('/costos-indirectos'); setR(x);
    return x.items.map((i) => ({ ...i, clasificacionTxt: CLASIFICACIONES.find((c) => c.valor === i.clasificacion)?.texto.replace(/ \(.*\)/, '') ?? i.clasificacion,
      baseTxt: i.clasificacion === 'PRODUCCION' ? BASES.find((b) => b.valor === i.baseReparto)?.texto ?? i.baseReparto : '—' }));
  };
  const activos = (r?.items ?? []).filter((i) => i.activo);
  const total = activos.reduce((s, i) => s + Number(i.montoMensual), 0);
  const produccion = activos.filter((i) => i.clasificacion === 'PRODUCCION').reduce((s, i) => s + Number(i.montoMensual), 0);
  return (
    <Crud titulo="Costos indirectos" nombreExport="costos-indirectos"
      descripcion="Alquiler, luz, gas, planilla indirecta… Solo los costos de producción entran al costo del pan; al guardar, el costo de cada producto se recalcula."
      cargar={cargar} nuevo={{ codigo: '', concepto: '', tipo: 'FIJO', montoMensual: 0, activo: true, clasificacion: 'PRODUCCION', baseReparto: 'UNIDADES' }}
      crear={guardar('POST', '/costos-indirectos')} editar={(id, d) => api(`/costos-indirectos/${id}`, { method: 'PATCH', body: d })}
      extra={r && (
        <div className="grid grid--auto">
          <Kpi label="Total mensual" valor={money(total)} nota="conceptos activos" icono="wallet" />
          <Kpi label="Costos de producción" valor={money(produccion)} nota={`operativos y de ventas ${money(total - produccion)}`} icono="ledger" />
          <Kpi label="Tarifa por hora de horno" valor={r.tarifas?.tarifaHoraHorno ? money(r.tarifas.tarifaHoraHorno) : '—'} nota={`${num(r.tarifas?.horasHornoMes ?? 0)} h de horno en 30 días`} icono="oven" />
          <Kpi label="Tarifa por kg de masa" valor={r.tarifas?.tarifaKgMasa ? money(r.tarifas.tarifaKgMasa) : '—'} nota={`${num(r.tarifas?.kgMasaMes ?? 0)} kg de masa en 30 días`} icono="sack" />
          <Kpi label="Hora hombre" valor={r.tarifas?.costoHoraHombre ? money(r.tarifas.costoHoraHombre) : '—'} nota="sueldo × (1 + beneficios) ÷ horas (Parámetros)" icono="user" />
        </div>
      )}
      columnas={[{ key: 'codigo', label: 'Código' }, { key: 'concepto', label: 'Concepto' }, { key: 'tipo', label: 'Tipo' }, { key: 'montoMensual', label: 'Monto mensual', tipo: 'dinero' },
        { key: 'clasificacionTxt', label: 'Clasificación' }, { key: 'baseTxt', label: 'Base de reparto' }, { key: 'activo', label: 'Activo' }]}
      campos={[
        campoCodigo('CIF-01'),
        { key: 'concepto', label: 'Concepto', requerido: true, max: 80 },
        { key: 'tipo', label: 'Tipo', tipo: 'select', opciones: [{ valor: 'FIJO', texto: 'Fijo' }, { valor: 'VARIABLE', texto: 'Variable' }] },
        { key: 'montoMensual', label: 'Monto mensual con IGV (S/)', tipo: 'numero', requerido: true, ayuda: 'Fijo: lo que se paga cada mes · variable: el promedio del mes' },
        { key: 'clasificacion', label: 'Clasificación', tipo: 'select', opciones: CLASIFICACIONES },
        { key: 'baseReparto', label: 'Base de reparto (solo costos de producción)', tipo: 'select', opciones: BASES, ayuda: 'Cómo se reparte entre los panes: gas → horas de horno; harina, luz de amasadora → kg de masa' },
        { key: 'activo', label: 'Activo (se incluye en el costo)', tipo: 'bool' },
      ]} />
  );
}

/* --------------------------------------------------------------- Categorías */
export function Categorias() {
  const { dataset, refrescarDatos } = useApp();
  return (
    <Crud titulo="Categorías" nombreExport="categorias" deps={dataset.categorias} descripcion="Agrupan los productos en el catálogo, las ventas y los reportes. Una categoría con productos no se puede eliminar."
      // Orden de presentación (campo «Orden») y, a igual orden, alfabético.
      cargar={async () => [...dataset.categorias]
        .sort((a, b) => (Number(a.orden ?? 0) - Number(b.orden ?? 0)) || a.nombre.localeCompare(b.nombre, 'es'))
        .map((c) => ({ ...c } as unknown as Reg))}
      nuevo={{ codigo: '', nombre: '', orden: 0 }}
      crear={async (d) => { await api('/categorias', { method: 'POST', body: d }); await refrescarDatos(); }}
      editar={async (id, d) => { await api(`/categorias/${id}`, { method: 'PATCH', body: d }); await refrescarDatos(); }}
      eliminar={async (id) => { await api(`/categorias/${id}`, { method: 'DELETE' }); await refrescarDatos(); }}
      columnas={[{ key: 'codigo', label: 'Código' }, { key: 'nombre', label: 'Categoría' }, { key: 'orden', label: 'Orden', tipo: 'num' }]}
      campos={[
        campoCodigo('CAT-01'),
        { key: 'nombre', label: 'Nombre', requerido: true, max: 60 },
        { key: 'orden', label: 'Orden en listas', tipo: 'numero', ayuda: '0 = primero. A igual orden, alfabético' },
      ]} />
  );
}

/* ---------------------------------------------------------------- Productos */
export function Productos() {
  const { dataset, puede, refrescarDatos } = useApp();
  const cat = useCatalogos();
  const cats = dataset.categorias.map((c) => ({ valor: c.id, texto: c.nombre }));
  // Presentación unitaria (SKU #1): unidades de conteo o masa del catálogo.
  const unidadesVenta = cat.unidades.filter((u) => u.familia !== 'VOLUMEN').map((u) => ({ valor: u.codigo, texto: u.descripcion }));
  const presVenta = cat.presentacionesVenta.map((p) => ({ valor: p.codigo, texto: `${p.nombre} (${num(p.equivalencia)} unid)` }));
  const verCosto = puede('costos.ver');
  const edita = puede('maestros.editar');
  const igv = dataset.negocio.igv;
  const neto = (form: Reg) => n(form.precioConIgv) / (1 + igv);
  const [ajustar, setAjustar] = useState<Producto | null>(null);
  const [msg, setMsg] = useState<{ tono: 'ok' | 'danger'; texto: string } | null>(null);

  const columnas: ColRep[] = [
    { key: 'codigo', label: 'Código' }, { key: 'nombre', label: 'Nombre' }, { key: 'categoria', label: 'Categoría' },
    { key: 'precioConIgv', label: 'Precio unidad', tipo: 'dinero' }, { key: 'presentacionesTxt', label: 'Otras presentaciones' },
    ...(verCosto ? [{ key: 'costoUnitario', label: 'Costo', tipo: 'dinero' }, { key: 'margen', label: 'Margen', tipo: 'pct' }] as ColRep[] : []),
    { key: 'estado', label: 'Estado' },
  ];
  const cambiarEstado = async (f: Reg) => {
    const estado = f.estado === 'ACTIVO' ? 'INACTIVO' : 'ACTIVO';
    try {
      await api(`/productos/${f.id}/estado`, { method: 'PATCH', body: { estado } });
      await refrescarDatos();
      setMsg({ tono: 'ok', texto: `${String(f.nombre)} ${estado === 'INACTIVO' ? 'anulado: ya no se vende ni sale en el catálogo' : 'reactivado'}.` });
    } catch (e) { setMsg({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo cambiar el estado.' }); }
  };
  return (
    <>
      {msg && aviso(msg.tono, msg.texto)}
      <Crud titulo="Productos" nombreExport="productos" deps={dataset.productos}
        descripcion="Datos de cada pan, sus presentaciones de venta (SKU) y su precio. «Ajustar precio» muestra cómo se forma el costo antes de cambiarlo."
        cargar={async () => dataset.productos.map((p) => ({
          ...p, categoria: dataset.categorias.find((c) => c.id === p.categoriaId)?.nombre,
          presentacionesTxt: (p.presentaciones ?? []).map((x) => `${x.nombre} ${money(x.precioConIgv)}`).join(' · '),
          presentaciones: (p.presentaciones ?? []).map((x) => ({ presentacion: x.presentacion, sku: x.sku, precioConIgv: x.precioConIgv, activo: x.activo })),
        } as unknown as Reg))}
        nuevo={{ codigo: '', nombre: '', categoriaId: cats[0]?.valor ?? '', unidad: 'UNIDAD', precioConIgv: 0, estado: 'ACTIVO', sku: '', presentaciones: [] }}
        // Alta en dos pasos: se crea (código, nombre, categoría, precio) y se guardan los datos de producción con la misma validación de la edición.
        crear={edita ? async (d) => {
          const r = await api<{ id: string }>('/productos', { method: 'POST', body: { ...d, mermaPct: 0.03 } });
          await api(`/productos/${r.id}`, { method: 'PATCH', body: { ...d, codigo: undefined } });
          await refrescarDatos();
        } : undefined}
        editar={edita ? async (id, d) => { await api(`/productos/${id}`, { method: 'PATCH', body: d }); await refrescarDatos(); } : undefined}
        accionesFila={edita ? [
          { etiqueta: 'Ajustar precio', icono: 'tag', visible: (f) => verCosto && !f.insumoId, onClick: (f) => setAjustar(dataset.productos.find((p) => p.id === f.id) ?? null) },
          { etiqueta: (f) => (f.estado === 'ACTIVO' ? 'Anular' : 'Reactivar'), icono: (f) => (f.estado === 'ACTIVO' ? 'close' : 'sync'), peligro: (f) => f.estado === 'ACTIVO', onClick: (f) => void cambiarEstado(f) },
        ] : []}
        columnas={columnas}
        campos={[
          { key: 'imagenUrl', label: 'Imagen del catálogo', tipo: 'imagen', ayuda: 'PNG, JPEG o WebP. La ven los clientes en la web y la app.' },
          campoCodigo('P001'),
          { key: 'nombre', label: 'Nombre', requerido: true, max: 120 },
          { key: 'categoriaId', label: 'Categoría', tipo: 'select', opciones: cats },
          { key: 'estado', label: 'Estado', tipo: 'select', opciones: ESTADOS },
          { key: 's-prod', label: 'Producción', tipo: 'seccion', ayuda: 'Con estos datos el sistema calcula la pérdida por cocción, la mano de obra, los costos indirectos y el vencimiento.' },
          { key: 'pesoMasaG', label: 'Peso de masa por unidad (g)', tipo: 'numero', ayuda: 'El bollito pesado antes de entrar al horno' },
          { key: 'pesoFinalG', label: 'Peso final por unidad (g)', tipo: 'numero', ayuda: 'El pan pesado al salir del horno' },
          { key: 'c-perdida', label: 'Pérdida por cocción', tipo: 'calculado', ayuda: 'Lo calcula el sistema: 1 − peso final ÷ peso de masa',
            calcular: (form) => { const c = n(form.pesoMasaG), fin = n(form.pesoFinalG); return c > 0 && fin > 0 ? (fin > c ? 'El peso final no puede superar al de la masa' : pct(1 - fin / c)) : '—'; } },
          { key: 'unidadesLote', label: 'N.° de unidades por lote', tipo: 'numero', ayuda: 'Cuántos panes entran al horno a la vez' },
          { key: 'horasHornoLote', label: 'Tiempo de horneado por lote (horas)', tipo: 'numero', ayuda: 'Ej.: 0.8 = 48 minutos. Con él se calculan el gas del horno y la mano de obra' },
          { key: 'vidaUtilDias', label: 'Días de vida útil', tipo: 'numero', ayuda: 'Cada horneada guarda su fecha de producción y de vencimiento' },
          { key: 's-sku1', label: 'SKU #1 · presentación unitaria', tipo: 'seccion' },
          { key: 'sku', label: 'SKU (código de barras)', max: 30, placeholder: 'Opcional' },
          { key: 'unidad', label: 'Presentación unitaria', tipo: 'select', opciones: unidadesVenta, ayuda: 'Equivalencia 1: una unidad del producto' },
          { key: 'precioConIgv', label: 'Precio de venta con IGV (S/)', tipo: 'numero', requerido: true },
          { key: 'c-neto', label: 'Precio sin IGV (S/)', tipo: 'calculado', calcular: (form) => (Number.isFinite(neto(form)) ? money(neto(form)) : '—'), ayuda: `Precio con IGV ÷ ${(1 + igv).toFixed(2)}` },
          { key: 'presentaciones', label: 'SKU #2… · otras presentaciones de venta', tipo: 'filas', ancho: true, agregar: 'Agregar presentación',
            nuevaFila: { presentacion: presVenta.find((p) => p.valor !== 'UNID')?.valor ?? presVenta[0]?.valor ?? '', sku: '', precioConIgv: '', activo: true },
            columnasFila: [
              { key: 'presentacion', label: 'Presentación', tipo: 'select', opciones: presVenta },
              { key: 'sku', label: 'SKU', max: 30, placeholder: 'Opcional' },
              { key: 'precioConIgv', label: 'Precio con IGV (S/)', tipo: 'numero' },
              { key: 'activo', label: 'Activa', tipo: 'bool' },
            ],
            ayuda: 'Paquete x 6 a S/ 48, etc. Al venderla, el stock baja según su equivalencia y se descuenta su empaque. Se administran en Maestros → Catálogos.' },
          { key: 's-otros', label: 'Opcional', tipo: 'seccion' },
          { key: 'anticipacionHoras', label: 'Anticipación mínima del pedido (horas)', tipo: 'numero', ayuda: 'Ej.: 24 para pan por encargo' },
          { key: 'insumoId', label: 'Produce el insumo (sub-receta)', tipo: 'select',
            opciones: [{ valor: '', texto: 'No: es un producto de venta' }, ...dataset.insumos.map((i) => ({ valor: i.id, texto: `${i.nombre} (${i.unidadInventario ?? i.unidad})` }))],
            ayuda: 'Solo masa madre o rellenos: entra al almacén de insumos y no se vende' },
        ]} />
      {ajustar && <AjustarPrecio producto={ajustar} onCerrar={(ok) => { setAjustar(null); if (ok) { setMsg({ tono: 'ok', texto: `Precio de ${ajustar.nombre} actualizado.` }); void refrescarDatos(); } }} />}
    </>
  );
}

/**
 * Ficha de costo de un pan, en el orden de la hoja «AJUSTAR PRECIO» del Excel: de la masa a la utilidad.
 * Los valores vienen del motor de costos (se recalculan solos cuando cambian compras, recetas o costos indirectos).
 */
function FichaCosto({ producto, receta, igv }: { producto: Producto; receta: Record<string, unknown> | undefined; igv: number }) {
  const v = (k: string) => Number(receta?.[k] ?? 0);
  if (!receta) return <p className="t-muted">Este producto aún no tiene receta: regístrala en Maestros → Recetas para ver su costo.</p>;
  const costo = v('costoConMerma') + v('moUnit') + v('cifUnit');
  const netoActual = producto.precioConIgv / (1 + igv);
  const utilidad = netoActual - costo;
  const crudo = producto.pesoMasaG ?? 0, final = producto.pesoFinalG ?? 0;
  const lote = producto.unidadesLote ?? null;
  const filas: Array<[string, string, string?]> = [
    ['Peso de masa por unidad', crudo ? `${num(crudo)} g` : '—'],
    ['Merma de proceso', pct(v('mermaEstandar')), 'Recetas'],
    ['Pérdida por cocción', crudo && final ? pct(1 - final / crudo) : '—', '1 − peso final ÷ peso de masa'],
    ['Peso final por unidad', final ? `${num(final)} g` : '—'],
    ['Masa total del lote', `${v('masaLoteKg').toFixed(3)} kg`, 'Suma de los insumos de la receta'],
    ['Unidades según Tanta (por lote)', lote ? String(lote) : '—', 'Ficha del producto'],
    ['Unidades teóricas por lote', v('unidadesTeoricas').toFixed(2), 'Masa del lote ÷ peso de masa'],
    ['Unidades esperadas por lote', v('unidadesEsperadas').toFixed(2), 'Teóricas menos la merma de proceso'],
    ['Costo de insumos del lote', money(v('costoLote')), 'Cantidad de la receta × costo de cada insumo'],
    ['Costo de insumos por unidad', money(v('costoConMerma')), 'Con la merma de proceso'],
    ['Mano de obra por unidad', money(v('moUnit')), 'Tiempo de horneado × costo de la hora ÷ unidades del lote'],
    ['CIF por unidad', money(v('cifUnit')), 'Costos de producción repartidos'],
  ];
  return (
    <>
      {lote && v('unidadesTeoricas') > 0 && Math.abs(lote - v('unidadesTeoricas')) / lote > 0.05 && (
        <div className="aviso aviso--danger"><span className="aviso__icono">!</span><div><p>
          Con esta receta salen {v('unidadesTeoricas').toFixed(1)} panes de {num(crudo)} g, pero el lote es de {lote}. Revisa la receta o el peso: el costo por unidad se calcula con las unidades reales.
        </p></div></div>
      )}
      <div className="table-wrap"><table className="table table--compacta">
        <tbody>
          {filas.map(([c, val, como]) => <tr key={c}><td>{c}</td><td className="t-right">{val}</td><td className="t-muted">{como ?? ''}</td></tr>)}
          <tr><td><b>Costo total por unidad</b></td><td className="t-right"><b>{money(costo)}</b></td><td className="t-muted">Insumos + mano de obra + CIF</td></tr>
          <tr><td>Precio de venta con IGV</td><td className="t-right">{money(producto.precioConIgv)}</td><td className="t-muted">sin IGV {money(netoActual)}</td></tr>
          <tr><td><b>Utilidad por unidad</b></td><td className={`t-right ${utilidad < 0 ? 't-neg' : ''}`}><b>{money(utilidad)}</b></td>
            <td className="t-muted">margen {netoActual > 0 ? pct(utilidad / netoActual) : '—'} · markup {costo > 0 ? pct(utilidad / costo) : '—'}</td></tr>
          <tr><td>Tiempo de horneado por lote</td><td className="t-right">{producto.horasHornoLote ? `${num(producto.horasHornoLote)} h` : '—'}</td><td /></tr>
        </tbody>
      </table></div>
    </>
  );
}

/** «AJUSTAR PRECIO»: ficha de costo + precio de la unidad y de cada presentación, con el precio sugerido para un margen. */
function AjustarPrecio({ producto, onCerrar }: { producto: Producto; onCerrar: (ok: boolean) => void }) {
  const { dataset } = useApp();
  const igv = dataset.negocio.igv;
  const receta = dataset.recetas.find((r) => (r as unknown as Reg).productoId === producto.id) as unknown as Record<string, unknown> | undefined;
  const costo = receta ? Number(receta.costoConMerma ?? 0) + Number(receta.moUnit ?? 0) + Number(receta.cifUnit ?? 0) : producto.costoUnitario;
  const [margen, setMargen] = useState(40);
  const [precios, setPrecios] = useState<Record<string, string>>(() => Object.fromEntries([
    ['', String(producto.precioConIgv)], ...(producto.presentaciones ?? []).map((p) => [p.presentacion, String(p.precioConIgv)]),
  ]));
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  // Precio sugerido con IGV para el margen objetivo (sobre el precio sin IGV), por equivalencia.
  const sugerido = (equiv: number) => (margen < 100 ? (costo * equiv) / (1 - margen / 100) * (1 + igv) : 0);
  const lineas = [{ clave: '', nombre: `Unidad (${producto.unidad.toLowerCase()})`, equiv: 1 },
    ...(producto.presentaciones ?? []).map((p) => ({ clave: p.presentacion, nombre: p.nombre, equiv: p.equivalencia }))];
  const valido = lineas.every((l) => Number(precios[l.clave]) > 0);
  const guardar = async () => {
    setGuardando(true); setError(null);
    try {
      await api(`/productos/${producto.id}/precios`, { method: 'PATCH', body: { precioConIgv: Number(precios['']),
        presentaciones: lineas.filter((l) => l.clave).map((l) => ({ presentacion: l.clave, precioConIgv: Number(precios[l.clave]) })) } });
      onCerrar(true);
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo guardar.'); }
    finally { setGuardando(false); }
  };
  return (
    <Dialogo abierto titulo={`Ajustar precio · ${producto.codigo} ${producto.nombre}`} descripcion="Cómo se forma el costo de este pan y cuánto deja cada presentación. El cambio queda auditado."
      onCerrar={() => onCerrar(false)}
      acciones={<><Boton onClick={() => onCerrar(false)}>Cancelar</Boton><Boton variant="primary" disabled={!valido || guardando} onClick={() => void guardar()}>{guardando ? 'Guardando…' : 'Guardar precios'}</Boton></>}>
      <FichaCosto producto={producto} receta={receta} igv={igv} />
      <div className="form form--2col form--dialogo" style={{ marginTop: 12 }}>
        <label className="field"><span className="field__label">Margen objetivo para el precio sugerido (%)</span>
          <input className="field__input" type="number" min={0} max={95} step="0.5" value={margen} onChange={(e) => setMargen(Number(e.target.value))} /></label>
      </div>
      <div className="table-wrap"><table className="table table--compacta">
        <thead><tr><th>Presentación</th><th className="t-right">Equiv.</th><th className="t-right">Costo</th><th className="t-right">Sugerido</th><th>Precio con IGV</th><th className="t-right">Margen</th></tr></thead>
        <tbody>{lineas.map((l) => {
          const precio = Number(precios[l.clave]);
          const netoL = precio / (1 + igv), costoL = costo * l.equiv;
          return (
            <tr key={l.clave || 'unidad'}>
              <td>{l.nombre}</td><td className="t-right">{num(l.equiv)}</td><td className="t-right">{money(costoL)}</td>
              <td className="t-right"><button type="button" className="btn-link" title="Usar el sugerido" onClick={() => setPrecios({ ...precios, [l.clave]: sugerido(l.equiv).toFixed(2) })}>{money(sugerido(l.equiv))}</button></td>
              <td><input className="field__input" type="number" min="0" step="0.1" aria-label={`Precio de ${l.nombre}`} value={precios[l.clave]} onChange={(e) => setPrecios({ ...precios, [l.clave]: e.target.value })} /></td>
              <td className={`t-right ${netoL - costoL < 0 ? 't-neg' : ''}`}>{netoL > 0 ? pct((netoL - costoL) / netoL) : '—'}</td>
            </tr>);
        })}</tbody>
      </table></div>
      {error && <p className="form__error" role="alert">{error}</p>}
    </Dialogo>
  );
}

/* ------------------------------------------------------------------ Insumos */
interface CostosInsumo {
  id: string; codigo: string; nombre: string; unidad: string; metodo: string; costoFormulas: number; costoKardex: number; manual: boolean;
  actualizadoEn: string | null; actualizadoPor: string | null; precioAnterior: number | null; precioActual: number | null;
  compras: Array<{ codigo: string; fecha: string; proveedor: string; estado: string; cantidad: number; presentacion: string; cantidadInventario: number; costoUnitario: number; subtotal: number }>;
}
interface Variacion { id: string; codigo: string; nombre: string; unidad: string; costoActual: number; costoSugerido: number; variacion: number | null; ultimaCompra: string | null }

export function Insumos() {
  const { dataset, puede, refrescarDatos } = useApp();
  const cat = useCatalogos();
  const op = (l: Array<{ codigo: string; nombre?: string; descripcion?: string }>) => l.map((x) => ({ valor: x.codigo, texto: x.nombre ?? `${x.descripcion} (${x.codigo.toLowerCase()})` }));
  // Insumos: Administración y Compras (informe de compra de insumos, sección 7).
  const editaInsumos = puede('maestros.editar') || puede('insumos.gestionar');
  const verCosto = puede('costos.ver');
  const igv = dataset.negocio.igv;
  const proveedores = useOpciones('/proveedores', (r) => String(r.razonSocial), (r) => String(r.razonSocial));
  const [costos, setCostos] = useState<string | null>(null);
  const [informe, setInforme] = useState(false);
  const [msg, setMsg] = useState<{ tono: 'ok' | 'danger'; texto: string } | null>(null);
  const presCompra = cat.presentacionesCompra;
  // El precio se escribe con IGV (como viene en el comprobante); se guarda sin IGV.
  const aApi = (d: Reg) => {
    const { precioConIgv, ...resto } = d;
    return { ...resto, precioCompra: precioConIgv === '' || precioConIgv === null || precioConIgv === undefined ? null : Number(precioConIgv) / (1 + igv) };
  };
  const cambiarEstado = async (f: Reg) => {
    const activo = f.activo === false;
    try {
      await api(`/insumos/${f.id}/estado`, { method: 'PATCH', body: { activo } });
      await refrescarDatos();
      setMsg({ tono: 'ok', texto: `${String(f.nombre)} ${activo ? 'reactivado' : 'anulado: ya no se ofrece en compras ni recetas'}.` });
    } catch (e) { setMsg({ tono: 'danger', texto: e instanceof Error ? e.message : 'No se pudo cambiar el estado.' }); }
  };
  return (
    <>
      {msg && aviso(msg.tono, msg.texto)}
      <Crud titulo="Insumos" nombreExport="insumos" deps={dataset.insumos}
        descripcion="Cómo se compra cada insumo y cuánto cuesta. «Ajustar costos» muestra las últimas compras y actualiza el costo que usan las fórmulas de precio."
        cargar={async () => dataset.insumos.map((i) => ({
          ...i, activo: i.activo ?? true, estadoTxt: i.activo === false ? 'INACTIVO' : 'ACTIVO', manejaStock: i.manejaStock ?? true,
          precioConIgv: i.precioCompra === null || i.precioCompra === undefined ? '' : Math.round(i.precioCompra * (1 + igv) * 100) / 100,
        } as unknown as Reg))}
        nuevo={{ codigo: '', nombre: '', unidad: 'KG', unidadInventario: 'KG', minimo: 0, proveedor: '', activo: true, tipo: 'OTRO', presentacionCodigo: '', presentacion: '',
          precioConIgv: '', cantPresentacion: '', equivKg: '', manejaStock: true }}
        crear={editaInsumos ? async (d) => { await api('/insumos', { method: 'POST', body: aApi(d) }); await refrescarDatos(); } : undefined}
        acciones={<>
          {verCosto && <Boton icono="report" onClick={() => setInforme(true)}>Informe de variación</Boton>}
          {editaInsumos && (
            <Importar titulo="Importar insumos" descripcion="Carga la Lista de Insumos desde la plantilla. Las filas con error se muestran con su motivo y no frenan a las válidas; no se duplican nombres."
              plantilla={{ codigo: '', nombre: 'Harina preparada', tipo: 'HARINA', unidad: 'KG', unidadInventario: 'KG', minimo: 25, proveedor: '', presentacionCodigo: 'SACO50', precioCompra: 120, cantPresentacion: 50, equivKg: '' }}
              numericas={['minimo', 'precioCompra', 'cantPresentacion', 'equivKg']}
              enviar={async (filas) => { const r = await api<{ creados: unknown[]; errores: Array<{ fila: number; nombre: string; motivo: string }> }>('/insumos/importar', { method: 'POST', body: { filas } }); return { ok: r.creados.length, errores: r.errores }; }}
              onListo={() => void refrescarDatos()} />
          )}
        </>}
        editar={editaInsumos ? async (id, d) => { await api(`/insumos/${id}`, { method: 'PATCH', body: aApi(d) }); await refrescarDatos(); } : undefined}
        accionesFila={[
          ...(verCosto ? [{ etiqueta: 'Ajustar costos', icono: 'tag' as const, onClick: (f: Reg) => setCostos(String(f.id)) }] : []),
          ...(editaInsumos ? [{ etiqueta: (f: Reg) => (f.activo === false ? 'Reactivar' : 'Anular'), icono: (f: Reg) => (f.activo === false ? 'sync' as const : 'close' as const),
            peligro: (f: Reg) => f.activo !== false, onClick: (f: Reg) => void cambiarEstado(f) }] : []),
        ]}
        columnas={[
          { key: 'codigo', label: 'Código' }, { key: 'nombre', label: 'Insumo' }, { key: 'tipo', label: 'Tipo' }, { key: 'presentacion', label: 'Presentación' },
          { key: 'stock', label: 'Stock', tipo: 'num' }, { key: 'unidadInventario', label: 'En' }, { key: 'minimo', label: 'Mínimo', tipo: 'num' },
          ...(verCosto ? [{ key: 'costoFormulas', label: 'Costo (fórmulas)', tipo: 'dinero' } as ColRep, { key: 'cpp', label: 'Costo compras', tipo: 'dinero' } as ColRep] : []),
          { key: 'manejaStock', label: 'Maneja stock' }, { key: 'estadoTxt', label: 'Estado' },
        ]}
        campos={[
          campoCodigo('INS-001'),
          { key: 'nombre', label: 'Nombre', requerido: true, max: 120 },
          { key: 'tipo', label: 'Tipo', tipo: 'select', opciones: cat.tiposInsumo.map((t) => ({ valor: t.codigo, texto: t.esHarina ? `${t.nombre} (suma 100 % panadero)` : t.nombre })), ayuda: 'Se administran en Maestros → Catálogos' },
          { key: 'unidad', label: 'Unidad base', tipo: 'select', opciones: op(cat.unidades), ayuda: 'kg, L o unidad. En la receta se puede escribir en g o ml' },
          { key: 's-compra', label: 'Cómo se compra', tipo: 'seccion' },
          { key: 'presentacionCodigo', label: 'Presentación de compra', tipo: 'select',
            opciones: [{ valor: '', texto: 'Elige…' }, ...presCompra.map((p) => ({ valor: p.codigo, texto: p.nombre }))],
            alCambiar: (v) => { const p = presCompra.find((x) => x.codigo === v); return p ? { cantPresentacion: p.equivalencia, presentacion: p.nombre } : {}; },
            ayuda: 'Saco x 50 kg, botella 900 ml… (Maestros → Catálogos → Presentaciones de compra)' },
          { key: 'cantPresentacion', label: 'Cantidad por presentación (en unidad base)', tipo: 'numero', ayuda: 'Saco x 50 kg = 50 · botella 900 ml con base L = 0.9' },
          { key: 'equivKg', label: 'Conversión a kg (por 1 unidad base)', tipo: 'numero', ayuda: 'Para aceite, leche, huevos… que se compran en L o unidad y se pesan en kg. Aceite: 0.916 · huevo: 0.05' },
          { key: 'unidadInventario', label: 'Unidad en la que se lleva el stock', tipo: 'select', opciones: op(cat.unidades), ayuda: 'No se cambia si el insumo ya tiene stock' },
          { key: 'precioConIgv', label: 'Precio actual con IGV (S/)', tipo: 'numero', ayuda: 'Por presentación, como figura en el comprobante' },
          { key: 'c-sinigv', label: 'Precio actual sin IGV', tipo: 'calculado', calcular: (f) => (n(f.precioConIgv) > 0 ? money(n(f.precioConIgv) / (1 + igv)) : '—'), ayuda: `Con IGV ÷ ${(1 + igv).toFixed(2)}` },
          { key: 'c-costobase', label: 'Costo por unidad base', tipo: 'calculado',
            calcular: (f) => (n(f.precioConIgv) > 0 && n(f.cantPresentacion) > 0 ? `${money(n(f.precioConIgv) / (1 + igv) / n(f.cantPresentacion))} por ${String(f.unidad ?? '').toLowerCase()}` : '—'),
            ayuda: 'Precio sin IGV ÷ cantidad por presentación. Desde la primera compra manda el costo de las compras' },
          { key: 's-stock', label: 'Stock', tipo: 'seccion' },
          { key: 'minimo', label: 'Stock mínimo (en la unidad del stock)', tipo: 'numero', ayuda: 'Por debajo se avisa a Almacén y Gerencia' },
          { key: 'proveedor', label: 'Proveedor habitual', tipo: 'select', opciones: [{ valor: '', texto: 'Sin proveedor' }, ...proveedores] },
          { key: 'manejaStock', label: 'Maneja stock (se controla su existencia y avisa al llegar al mínimo)', tipo: 'bool' },
          { key: 'activo', label: 'Activo', tipo: 'bool' },
        ]} />
      {costos && <AjustarCostos insumoId={costos} onCerrar={(texto) => { setCostos(null); if (texto) { setMsg({ tono: 'ok', texto }); void refrescarDatos(); } }} />}
      {informe && <InformeVariacion onCerrar={(cambio) => { setInforme(false); if (cambio) void refrescarDatos(); }} />}
    </>
  );
}

/** «AJUSTAR COSTOS»: últimas 20 compras del insumo y actualización manual del costo para las fórmulas. */
function AjustarCostos({ insumoId, onCerrar }: { insumoId: string; onCerrar: (texto?: string) => void }) {
  const { puede } = useApp();
  const [d, setD] = useState<CostosInsumo | null>(null);
  const [nuevo, setNuevo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  useEffect(() => {
    api<CostosInsumo>(`/insumos/${insumoId}/costos`).then((x) => { setD(x); setNuevo(String(x.precioActual ?? x.costoKardex)); }).catch((e) => setError(e.message));
  }, [insumoId]);
  const puedeActualizar = puede('maestros.editar') || puede('insumos.gestionar');
  const actualizar = async () => {
    if (!d) return;
    setGuardando(true); setError(null);
    try {
      await api(`/insumos/${insumoId}/costo`, { method: 'POST', body: { costo: Number(nuevo) } });
      onCerrar(`Costo de ${d.nombre} actualizado a ${money(Number(nuevo))} por ${d.unidad.toLowerCase()}: los precios sugeridos ya lo usan.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo actualizar.'); }
    finally { setGuardando(false); }
  };
  const u = d?.unidad.toLowerCase() ?? '';
  const variacion = d && d.precioAnterior && d.precioActual ? (d.precioActual - d.precioAnterior) / d.precioAnterior : null;
  return (
    <Dialogo abierto titulo={d ? `Ajustar costos · ${d.codigo} ${d.nombre}` : 'Ajustar costos'}
      descripcion={d ? `Costos por ${u}, sin IGV cuando la factura da crédito fiscal. Las fórmulas de precio usan el costo ${d.metodo === 'MANUAL' ? 'que se actualiza aquí' : 'de las compras (automático)'}.` : ''}
      onCerrar={() => onCerrar()}
      acciones={<><Boton onClick={() => onCerrar()}>Cerrar</Boton>
        {puedeActualizar && <Boton variant="primary" disabled={!d || !(Number(nuevo) >= 0) || nuevo === '' || guardando} onClick={() => void actualizar()}>{guardando ? 'Actualizando…' : 'Actualizar'}</Boton>}</>}>
      {!d ? (error ? <p className="form__error">{error}</p> : <p className="t-muted">Cargando…</p>) : (<>
        <div className="grid grid--auto">
          <Kpi label="Costo actual (fórmulas)" valor={money(d.costoFormulas)} nota={d.manual ? `fijado ${d.actualizadoEn?.slice(0, 10) ?? ''} por ${d.actualizadoPor ?? ''}` : 'sigue a las compras'} icono="tag" />
          <Kpi label="P. compra anterior" valor={d.precioAnterior === null ? '—' : money(d.precioAnterior)} nota={`por ${u}`} icono="ledger" />
          <Kpi label="P. compra actual" valor={d.precioActual === null ? '—' : money(d.precioActual)} nota={variacion === null ? `por ${u}` : `${variacion > 0 ? '▲ sube' : variacion < 0 ? '▼ baja' : 'igual'} ${pct(Math.abs(variacion))}`} icono="chart" />
          <Kpi label="Costo promedio de compras" valor={money(d.costoKardex)} nota="kárdex" icono="sack" />
        </div>
        <h4 className="card__title" style={{ marginTop: 12 }}>Últimas {d.compras.length} compras</h4>
        {d.compras.length === 0 ? <p className="t-muted">Aún no hay compras de este insumo.</p> : (
          <div className="table-wrap"><table className="table table--compacta">
            <thead><tr><th>Fecha</th><th>Proveedor</th><th className="t-right">Cantidad compra</th><th className="t-right">Cantidad {u}</th><th className="t-right">P. compra por {u}</th><th className="t-right">Subtotal</th></tr></thead>
            <tbody>{d.compras.map((c) => (
              <tr key={c.codigo}><td>{c.fecha}</td><td>{c.proveedor}{c.estado !== 'VERIFICADA' && <> <Insignia tono="warn">{c.estado.toLowerCase().replace('_', ' ')}</Insignia></>}</td>
                <td className="t-right">{num(c.cantidad)} {c.presentacion.toLowerCase()}</td><td className="t-right">{num(c.cantidadInventario)}</td>
                <td className="t-right">{money(c.costoUnitario)}</td><td className="t-right">{money(c.subtotal)}</td></tr>
            ))}</tbody>
          </table></div>
        )}
        {puedeActualizar && (
          <label className="field" style={{ marginTop: 12 }}><span className="field__label">Nuevo costo para las fórmulas (S/ por {u})</span>
            <input className="field__input" type="number" min="0" step="0.0001" value={nuevo} onChange={(e) => setNuevo(e.target.value)} />
            <span className="field__ayuda">Recalcula al instante el costo de los panes que lo usan y su precio sugerido.</span></label>
        )}
        {error && <p className="form__error" role="alert">{error}</p>}
      </>)}
    </Dialogo>
  );
}

/** «INFORME INSUMOS PARA CORREGIR COSTO»: solo los que variaron; se exporta o imprime y se actualiza al sugerido. */
function InformeVariacion({ onCerrar }: { onCerrar: (cambio: boolean) => void }) {
  const { puede } = useApp();
  const [filas, setFilas] = useState<Variacion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cambio, setCambio] = useState(false);
  const cargar = () => api<Variacion[]>('/insumos/variacion-costos').then(setFilas).catch((e) => setError(e.message));
  useEffect(() => { void cargar(); }, []);
  const actualiza = puede('maestros.editar') || puede('insumos.gestionar');
  const aplicar = async (v: Variacion) => {
    try { await api(`/insumos/${v.id}/costo`, { method: 'POST', body: { costo: v.costoSugerido } }); setCambio(true); await cargar(); }
    catch (e) { setError(e instanceof Error ? e.message : 'No se pudo actualizar.'); }
  };
  const exportar = () => exportarExcel('variacion-costos-insumos', (filas ?? []).map((v) => ({ Código: v.codigo, Insumo: v.nombre, Unidad: v.unidad,
    'Costo actual': v.costoActual, 'Costo sugerido': v.costoSugerido, 'Variación %': v.variacion === null ? '' : Math.round(v.variacion * 10000) / 100, 'Última compra': v.ultimaCompra ?? '' })));
  return (
    <Dialogo abierto titulo="Informe de insumos para corregir costo" descripcion="Solo aparecen los insumos cuyo costo de compras cambió respecto al que usan las fórmulas (umbral en Parámetros)."
      onCerrar={() => onCerrar(cambio)}
      acciones={<><Boton icono="download" disabled={!filas?.length} onClick={exportar}>Excel</Boton><Boton icono="report" disabled={!filas?.length} onClick={() => window.print()}>Imprimir</Boton>
        <Boton onClick={() => onCerrar(cambio)}>Cerrar</Boton></>}>
      {error && <p className="form__error" role="alert">{error}</p>}
      {filas === null ? <p className="t-muted">Cargando…</p> : filas.length === 0 ? <Vacio titulo="Sin variaciones" detalle="Los costos de las fórmulas coinciden con los de las compras." /> : (
        <div className="table-wrap"><table className="table table--compacta">
          <thead><tr><th>Código</th><th>Insumo</th><th className="t-right">Costo actual</th><th className="t-right">Costo sugerido</th><th className="t-right">Variación</th>{actualiza && <th />}</tr></thead>
          <tbody>{filas.map((v) => (
            <tr key={v.id}><td>{v.codigo}</td><td>{v.nombre}<br /><small className="t-muted">por {v.unidad.toLowerCase()}{v.ultimaCompra ? ` · última compra ${v.ultimaCompra}` : ''}</small></td>
              <td className="t-right">{money(v.costoActual)}</td><td className="t-right">{money(v.costoSugerido)}</td>
              <td className={`t-right ${(v.variacion ?? 0) > 0 ? 't-neg' : ''}`}>{v.variacion === null ? '—' : `${v.variacion > 0 ? '▲' : '▼'} ${pct(Math.abs(v.variacion))}`}</td>
              {actualiza && <td className="t-right"><Boton size="sm" onClick={() => void aplicar(v)}>Actualizar</Boton></td>}</tr>
          ))}</tbody>
        </table></div>
      )}
    </Dialogo>
  );
}

/* ------------------------------------------------------------- Proveedores */
// MAE-09: RUC opcional pero único; un proveedor con compras no se elimina, se inactiva.
export function Proveedores() {
  const bancos = useCatalogos().bancos.map((b) => ({ valor: b.codigo, texto: b.nombre }));
  return (
    <Crud titulo="Proveedores" nombreExport="proveedores" descripcion="Datos de contacto y cuentas para pagarles. El RUC es opcional (las notas de pedido no lo traen). Un proveedor con compras solo se inactiva."
      cargar={async () => (await api<Reg[]>('/proveedores')).map((p) => ({ ...p,
        cuentasTxt: (p.cuentas as Array<{ bancoNombre: string; numero: string }>).map((c) => `${c.bancoNombre} ${c.numero}`).join(' · '),
        cuentas: (p.cuentas as Array<{ banco: string; numero: string }>).map((c) => ({ banco: c.banco, numero: c.numero })) }))}
      nuevo={{ codigo: '', ruc: '', razonSocial: '', contacto: '', telefono: '', email: '', direccion: '', estado: 'ACTIVO', cuentas: [] }}
      crear={guardar('POST', '/proveedores')} editar={(id, d) => api(`/proveedores/${id}`, { method: 'PATCH', body: d })}
      columnas={[
        { key: 'codigo', label: 'Código' }, { key: 'razonSocial', label: 'Razón social' }, { key: 'ruc', label: 'RUC' }, { key: 'contacto', label: 'Contacto' },
        { key: 'telefono', label: 'Celular' }, { key: 'cuentasTxt', label: 'Cuentas' }, { key: 'compras', label: 'Compras', tipo: 'num' }, { key: 'estado', label: 'Estado' },
      ]}
      campos={[
        campoCodigo('PRV-001'),
        { key: 'razonSocial', label: 'Razón social', requerido: true },
        { key: 'ruc', label: 'RUC (opcional)', max: 11, ayuda: '11 dígitos; empieza en 10, 15, 17 o 20' },
        { key: 'direccion', label: 'Dirección', max: 200 },
        { key: 'contacto', label: 'Contacto', max: 120 },
        { key: 'telefono', label: 'Celular del contacto', tipo: 'tel', max: 30 },
        { key: 'email', label: 'Correo del contacto', tipo: 'email' },
        { key: 'estado', label: 'Estado', tipo: 'select', opciones: ESTADOS },
        { key: 'cuentas', label: 'Datos de las cuentas', tipo: 'filas', ancho: true, agregar: 'Agregar cuenta', nuevaFila: { banco: bancos[0]?.valor ?? '', numero: '' },
          columnasFila: [{ key: 'banco', label: 'Banco', tipo: 'select', opciones: bancos }, { key: 'numero', label: 'N.° de cuenta o CCI', max: 40 }],
          ayuda: 'Puede tener una o más. Los bancos se administran en Maestros → Catálogos.' },
      ]} />
  );
}

/* --------------------------------------------------------------- Almacenes */
// MAE-10 / W12: almacén de insumos y de productos terminados, con responsable.
export function Almacenes() {
  const responsables = useOpciones('/almacenes/responsables', (r) => String(r.nombre));
  return (
    <Crud titulo="Almacenes" nombreExport="almacenes"
      descripcion="Dónde se guardan los insumos y los panes, y quién responde por cada uno. Las compras, la producción y las ventas se registran en el almacén por defecto de su tipo."
      cargar={() => api<Reg[]>('/almacenes')}
      nuevo={{ codigo: '', nombre: '', tipo: 'INSUMOS', responsableId: '', ubicacion: '', principal: false, estado: 'ACTIVO' }}
      crear={guardar('POST', '/almacenes')} editar={(id, d) => api(`/almacenes/${id}`, { method: 'PATCH', body: d })}
      columnas={[
        { key: 'codigo', label: 'Código' }, { key: 'nombre', label: 'Almacén' }, { key: 'tipo', label: 'Tipo' }, { key: 'responsable', label: 'Responsable' },
        { key: 'principal', label: 'Por defecto' }, { key: 'movimientos', label: 'Movimientos', tipo: 'num' }, { key: 'estado', label: 'Estado' },
      ]}
      campos={[
        campoCodigo('ALM-01'),
        { key: 'nombre', label: 'Nombre', requerido: true, max: 80 },
        { key: 'tipo', label: 'Tipo', tipo: 'select', opciones: [{ valor: 'INSUMOS', texto: 'Insumos' }, { valor: 'PRODUCTOS', texto: 'Productos terminados' }] },
        { key: 'responsableId', label: 'Responsable', tipo: 'select', opciones: [{ valor: '', texto: 'Sin responsable' }, ...responsables] },
        { key: 'ubicacion', label: 'Ubicación', ancho: true, max: 160 },
        { key: 'estado', label: 'Estado', tipo: 'select', opciones: ESTADOS },
        { key: 'principal', label: 'Almacén por defecto de su tipo', tipo: 'bool' },
        { key: 'c-principal', label: '¿Qué significa «por defecto»?', tipo: 'calculado', ancho: true,
          calcular: (f) => (f.tipo === 'PRODUCTOS'
            ? 'Aquí entran los panes al cerrar cada producción y de aquí salen al vender. Solo uno por tipo: marcar otro le quita el rol a este.'
            : 'Aquí entran los insumos al verificar cada compra y de aquí salen para producir. Solo uno por tipo: marcar otro le quita el rol a este.') },
      ]} />
  );
}

/* ------------------------------------------------- Gerencia: análisis de precios */
/**
 * Análisis de costo y precio (fuera del registro): cómo se forma el costo de un pan y qué precio haría
 * falta para un margen o markup objetivo (COS-10 / RN-16 / RN-17).
 */
export function AnalisisPrecio({ productos, recetas, igv }: {
  productos: Producto[]; recetas: Array<Record<string, unknown>>; igv: number;
}) {
  const [id, setId] = useState(productos[0]?.id ?? '');
  const [modo, setModo] = useState<'margen' | 'markup'>('margen');
  const [valor, setValor] = useState(40);
  const p = productos.find((x) => x.id === id);
  if (!p) return null;
  const r = recetas.find((x) => x.productoId === id);
  const v = (k: string) => Number(r?.[k] ?? 0);
  const costo = r ? v('costoConMerma') + v('moUnit') + v('cifUnit') : p.costoUnitario;
  const f = valor / 100;
  const netoSugerido = modo === 'margen' ? (f < 1 ? costo / (1 - f) : 0) : costo * (1 + f);
  return (
    <Tarjeta>
      <div className="form form--2col">
        <label className="field"><span className="field__label">Producto</span>
          <select className="field__input" value={id} onChange={(e) => setId(e.target.value)}>{productos.map((x) => <option key={x.id} value={x.id}>{x.codigo} · {x.nombre}</option>)}</select></label>
        <label className="field"><span className="field__label">Precio sugerido según</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <select className="field__input" style={{ maxWidth: 120 }} value={modo} onChange={(e) => setModo(e.target.value as 'margen' | 'markup')}><option value="margen">Margen</option><option value="markup">Markup</option></select>
            <input className="field__input" type="number" min={0} max={modo === 'margen' ? 95 : 1000} step="0.5" value={valor} aria-label={modo === 'margen' ? 'Margen objetivo (%)' : 'Markup (%)'} onChange={(e) => setValor(Number(e.target.value))} />
          </div></label>
      </div>
      <div style={{ marginTop: 12 }}><FichaCosto producto={p} receta={r} igv={igv} /></div>
      <div className="grid grid--auto" style={{ marginTop: 12 }}>
        <Kpi label="Precio sugerido con IGV" valor={money(netoSugerido * (1 + igv))} nota={'sin IGV ' + money(netoSugerido)} icono="spark" />
        {(p.presentaciones ?? []).map((x) => (
          <Kpi key={x.presentacion} label={`Sugerido · ${x.nombre}`} valor={money(netoSugerido * x.equivalencia * (1 + igv))} nota={`hoy ${money(x.precioConIgv)}`} icono="tag" />
        ))}
      </div>
    </Tarjeta>
  );
}

export function AnalisisPrecios() {
  const { dataset } = useApp();
  const productos = dataset.productos.filter((p) => !p.insumoId && p.estado === 'ACTIVO');
  return (
    <>
      <Encabezado titulo="Análisis de precios" descripcion="Cómo se forma el costo de cada pan y qué precio conviene. Se actualiza solo cuando cambian los costos de los insumos o los costos indirectos." />
      {productos.length ? <AnalisisPrecio igv={dataset.negocio.igv} productos={productos} recetas={dataset.recetas as unknown as Array<Record<string, unknown>>} />
        : <Vacio titulo="Sin productos activos" detalle="Registra productos en Maestros → Productos." />}
    </>
  );
}
