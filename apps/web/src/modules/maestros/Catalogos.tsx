import { useState } from 'react';
import { api } from '@/core/api';
import { invalidarCatalogos, useCatalogos } from '@/core/catalogos';
import { useApp } from '@/core/app-state';
import { Crud, type Campo } from '@/ui/Crud';
import type { ColRep } from '@/ui/TablaReporte';

type Reg = Record<string, unknown> & { id?: string };
const PESTANAS = [
  ['medios-pago', 'Medios de pago', 'mediosPago'], ['tipos-documento', 'Documentos de compra', 'tiposDocumento'],
  ['tipos-insumo', 'Tipos de insumo', 'tiposInsumo'], ['unidades', 'Unidades', 'unidades'],
  ['presentaciones-compra', 'Presentaciones de compra', 'presentacionesCompra'], ['presentaciones-venta', 'Presentaciones de venta', 'presentacionesVenta'],
  ['tipos-gasto', 'Tipos de gasto', 'tiposGasto'], ['comprobantes-venta', 'Comprobantes de venta', 'comprobantesVenta'], ['cuentas-caja', 'Cuentas de caja', 'cuentasCaja'], ['bancos', 'Bancos', 'bancos'],
] as const;
type Ruta = typeof PESTANAS[number][0];

const si = (k: string, label: string, ayuda?: string): Campo => ({ key: k, label, tipo: 'bool', ...(ayuda ? { ayuda } : {}) });
const comunes: Campo[] = [{ key: 'orden', label: 'Orden en las listas', tipo: 'numero' }, si('activo', 'Activo', 'Inactivo: no se ofrece en formularios; los registros pasados lo conservan')];

const DEF: Record<Ruta, { descripcion: string; nuevo: Reg; columnas: ColRep[]; campos: Campo[] }> = {
  'medios-pago': {
    descripcion: 'Dónde se usa cada medio y sus reglas: n.° de operación obligatorio, pago desde caja chica, venta al crédito, y a qué cuenta de caja grande llega lo cobrado.',
    nuevo: { codigo: '', nombre: '', requiereOperacion: false, enVentas: true, enCobranza: true, enCompras: false, cajaChica: false, esCredito: false, cuentaCaja: '', orden: 10, activo: true },
    columnas: [{ key: 'codigo', label: 'Código' }, { key: 'nombre', label: 'Nombre' }, { key: 'requiereOperacion', label: 'N.° operación' }, { key: 'enVentas', label: 'Ventas' },
      { key: 'enCobranza', label: 'Cobranza' }, { key: 'enCompras', label: 'Compras' }, { key: 'cajaChica', label: 'Caja chica' }, { key: 'cuentaCaja', label: 'Llega a' }, { key: 'activo', label: 'Activo' }],
    campos: [{ key: 'nombre', label: 'Nombre', requerido: true, ancho: true, max: 60 }, si('requiereOperacion', 'Exige número de operación'),
      si('enVentas', 'Se usa en ventas y pedidos'), si('enCobranza', 'Se usa al cobrar a clientes'), si('enCompras', 'Se usa al pagar a proveedores'),
      si('cajaChica', 'Se puede pagar desde caja chica', 'Solo efectivo: no puede exigir n.° de operación'),
      si('esCredito', 'Es venta al crédito', 'Genera cuenta por cobrar; no cobra ni paga'), ...comunes],
  },
  'tipos-documento': {
    descripcion: 'Documentos con que se registran las compras. Con crédito fiscal, el costo del insumo se calcula sin IGV.',
    nuevo: { codigo: '', nombre: '', creditoFiscal: false, orden: 10, activo: true },
    columnas: [{ key: 'codigo', label: 'Código' }, { key: 'nombre', label: 'Nombre' }, { key: 'creditoFiscal', label: 'Crédito fiscal' }, { key: 'activo', label: 'Activo' }],
    campos: [{ key: 'nombre', label: 'Nombre', requerido: true, ancho: true, max: 60 }, si('creditoFiscal', 'Da crédito fiscal (el IGV no es costo)', 'Factura: sí · boleta: no'), ...comunes],
  },
  'tipos-insumo': {
    descripcion: 'Clasificación de los insumos. Los marcados como harina suman el 100 % del porcentaje panadero.',
    nuevo: { codigo: '', nombre: '', esHarina: false, esEmpaque: false, sumaPeso: true, orden: 10, activo: true },
    columnas: [{ key: 'codigo', label: 'Código' }, { key: 'nombre', label: 'Nombre' }, { key: 'esHarina', label: 'Es harina' }, { key: 'esEmpaque', label: 'Es empaque' }, { key: 'sumaPeso', label: 'Suma al peso' }, { key: 'activo', label: 'Activo' }],
    campos: [{ key: 'nombre', label: 'Nombre', requerido: true, ancho: true, max: 60 }, si('esHarina', 'Cuenta como harina en el % panadero'), si('esEmpaque', 'Material de empaque', 'Despacho puede usarlo (bolsas, etiquetas…)'),
      si('sumaPeso', 'Suma al peso de la masa', 'Desmárcalo en bolsas y empaques: no cuentan en el peso (kg) de la receta'), ...comunes],
  },
  unidades: {
    descripcion: 'Única tabla de conversión: dentro de una familia, factor respecto a la unidad patrón (kg, L, unidad). Una unidad en uso no cambia de familia ni de factor.',
    nuevo: { codigo: '', descripcion: '', familia: 'MASA', factorAPatron: 1, orden: 10, activo: true },
    columnas: [{ key: 'codigo', label: 'Código' }, { key: 'descripcion', label: 'Unidad' }, { key: 'familia', label: 'Familia' }, { key: 'factorAPatron', label: 'Factor', tipo: 'num' }, { key: 'activo', label: 'Activo' }],
    campos: [{ key: 'descripcion', label: 'Nombre', requerido: true, ancho: true, max: 60 },
      { key: 'familia', label: 'Familia', tipo: 'select', opciones: [{ valor: 'MASA', texto: 'Masa (patrón kg)' }, { valor: 'VOLUMEN', texto: 'Volumen (patrón L)' }, { valor: 'CONTEO', texto: 'Conteo (patrón unidad)' }] },
      { key: 'factorAPatron', label: 'Equivale a cuántas unidades patrón', tipo: 'numero', ayuda: 'g = 0.001 kg · ml = 0.001 L · lb = 0.453592 kg' }, ...comunes],
  },
  'presentaciones-compra': {
    descripcion: 'Cómo se compra cada insumo: saco x 50 kg, botella 900 ml, celda x 30 unid. La equivalencia es cuánto trae en la unidad base del insumo y llena sola su ficha.',
    nuevo: { codigo: '', nombre: '', equivalencia: 1, orden: 10, activo: true },
    columnas: [{ key: 'codigo', label: 'Código' }, { key: 'nombre', label: 'Nombre' }, { key: 'equivalencia', label: 'Equivalencia', tipo: 'num' }, { key: 'activo', label: 'Activo' }],
    campos: [{ key: 'nombre', label: 'Nombre', requerido: true, ancho: true, max: 60, placeholder: 'Saco x 50 kg' },
      { key: 'equivalencia', label: 'Equivalencia (cuánto trae en unidad base)', tipo: 'numero', requerido: true, ayuda: 'Saco x 50 kg = 50 · botella 900 ml con base L = 0.9' }, ...comunes],
  },
  'presentaciones-venta': {
    descripcion: 'Cómo se vende cada pan: unidad, paquete x 6… La equivalencia son los panes que lleva; el empaque (bolsa) se descuenta solo del almacén al vender.',
    nuevo: { codigo: '', nombre: '', equivalencia: 1, insumoId: '', cantidadInsumo: '', orden: 10, activo: true },
    columnas: [{ key: 'codigo', label: 'Código' }, { key: 'nombre', label: 'Nombre' }, { key: 'equivalencia', label: 'Equivalencia', tipo: 'num' }, { key: 'insumo', label: 'Descuenta' }, { key: 'activo', label: 'Activo' }],
    campos: [],
  },
  'tipos-gasto': {
    descripcion: 'Clasificación de los gastos de caja chica: ventas, distribución, operativo…',
    nuevo: { codigo: '', nombre: '', orden: 10, activo: true },
    columnas: [{ key: 'codigo', label: 'Código' }, { key: 'nombre', label: 'Nombre' }, { key: 'activo', label: 'Activo' }],
    campos: [{ key: 'nombre', label: 'Nombre', requerido: true, ancho: true, max: 60 }, ...comunes],
  },
  'comprobantes-venta': {
    descripcion: 'Lo que el cliente elige al cerrar su pedido (boleta, factura, nota de pedido). Cada tipo necesita su serie activa en Parámetros → Series.',
    nuevo: { codigo: '', nombre: '', requiereRuc: false, orden: 10, activo: true },
    columnas: [{ key: 'codigo', label: 'Código' }, { key: 'nombre', label: 'Nombre' }, { key: 'requiereRuc', label: 'Exige RUC' }, { key: 'activo', label: 'Activo' }],
    campos: [{ key: 'nombre', label: 'Nombre', requerido: true, ancho: true, max: 60 }, si('requiereRuc', 'Exige cliente con RUC', 'Factura: sí · boleta y nota de pedido: no'), ...comunes],
  },
  'cuentas-caja': {
    descripcion: 'Dónde está el dinero de la caja grande: efectivo en caja fuerte, cuentas bancarias y billeteras (Yape, Plin). Cada medio de pago indica a cuál llega lo cobrado.',
    nuevo: { codigo: '', nombre: '', tipo: 'BANCO', banco: '', numero: '', orden: 10, activo: true },
    columnas: [{ key: 'codigo', label: 'Código' }, { key: 'nombre', label: 'Nombre' }, { key: 'tipo', label: 'Tipo' }, { key: 'numero', label: 'N.° de cuenta' }, { key: 'activo', label: 'Activo' }],
    campos: [],
  },
  bancos: {
    descripcion: 'Bancos para las cuentas de los proveedores.',
    nuevo: { codigo: '', nombre: '', orden: 10, activo: true },
    columnas: [{ key: 'codigo', label: 'Código' }, { key: 'nombre', label: 'Nombre' }, { key: 'activo', label: 'Activo' }],
    campos: [{ key: 'nombre', label: 'Nombre', requerido: true, ancho: true, max: 60 }, ...comunes],
  },
};

/** Maestros → Catálogos: listas que antes estaban fijas en el código. Solo el Administrador las mantiene. */
export function Catalogos() {
  const [pestana, setPestana] = useState<Ruta>('medios-pago');
  const { dataset } = useApp();
  const cat = useCatalogos();
  const cuentas = [{ valor: '', texto: 'Ninguna (no cobra)' }, ...cat.cuentasCaja.map((k) => ({ valor: k.codigo, texto: k.nombre }))];
  const insumos = dataset.insumos.filter((i) => i.activo !== false);
  // Presentación de venta: el empaque se elige de los insumos (bolsa 5 x 10").
  // Campos con opciones que salen de otros catálogos (cuentas de caja, bancos, insumos).
  const dinamicos: Partial<Record<Ruta, Campo[]>> = {
    'medios-pago': [...DEF['medios-pago'].campos.slice(0, -2),
      { key: 'cuentaCaja', label: 'Lo cobrado llega a la cuenta', tipo: 'select', opciones: cuentas, ayuda: 'Caja grande: efectivo → caja fuerte, Yape → su cuenta. Se administran en «Cuentas de caja»' },
      ...DEF['medios-pago'].campos.slice(-2)],
    'cuentas-caja': [{ key: 'nombre', label: 'Nombre', requerido: true, ancho: true, max: 60, placeholder: 'BCP soles · Yape del negocio' },
      { key: 'tipo', label: 'Tipo', tipo: 'select', opciones: [{ valor: 'EFECTIVO', texto: 'Efectivo (caja fuerte)' }, { valor: 'BANCO', texto: 'Cuenta bancaria' }, { valor: 'BILLETERA', texto: 'Billetera (Yape, Plin)' }] },
      { key: 'banco', label: 'Banco', tipo: 'select', opciones: [{ valor: '', texto: '—' }, ...cat.bancos.map((b) => ({ valor: b.codigo, texto: b.nombre }))] },
      { key: 'numero', label: 'N.° de cuenta o celular', max: 40 }, ...comunes],
  };
  const def = dinamicos[pestana] ? { ...DEF[pestana], campos: dinamicos[pestana]! } : pestana !== 'presentaciones-venta' ? DEF[pestana] : { ...DEF[pestana], campos: [
    { key: 'nombre', label: 'Nombre', requerido: true, ancho: true, max: 60, placeholder: 'Paquete x 6 unid' },
    { key: 'equivalencia', label: 'Equivalencia (panes que lleva)', tipo: 'numero', requerido: true, ayuda: 'Al vender 1 paquete x 6 el stock baja 6 panes' },
    { key: 'insumoId', label: 'Producto adicional a descontar', tipo: 'select', opciones: [{ valor: '', texto: 'Ninguno' }, ...insumos.map((i) => ({ valor: i.id, texto: `${i.nombre} (${(i.unidadInventario ?? i.unidad).toLowerCase()})` }))],
      ayuda: 'Empaque que sale solo del almacén al vender (bolsa)' },
    { key: 'cantidadInsumo', label: 'Cantidad a descontar por presentación', tipo: 'numero', ayuda: 'Ej.: 1 bolsa por paquete' }, ...comunes] as Campo[] };
  const clave = PESTANAS.find((p) => p[0] === pestana)![2];
  const guardar = async (cuerpo: Reg, codigo?: string) => {
    await api(codigo ? `/catalogos/${pestana}/${codigo}` : `/catalogos/${pestana}`, { method: codigo ? 'PATCH' : 'POST', body: cuerpo });
    invalidarCatalogos();
  };
  return (
    <>
      <div className="toolbar"><div className="chips">
        {PESTANAS.map(([r, t]) => <button key={r} className={`chipfilter ${pestana === r ? 'is-active' : ''}`} onClick={() => setPestana(r)}>{t}</button>)}
      </div></div>
      <Crud key={pestana} titulo={PESTANAS.find((p) => p[0] === pestana)![1]} nombreExport={`catalogo-${pestana}`} descripcion={def.descripcion}
        cargar={async () => ((await api<Record<string, Reg[]>>('/catalogos/administrar'))[clave] ?? []).map((r) => ({ ...r, id: String(r.codigo),
          insumo: r.insumoId ? `${r.cantidadInsumo} × ${insumos.find((i) => i.id === r.insumoId)?.nombre ?? 'insumo'}` : '', insumoId: r.insumoId ?? '', cantidadInsumo: r.cantidadInsumo ?? '', ...(pestana === 'medios-pago' || pestana === 'cuentas-caja' ? { cuentaCaja: r.cuentaCaja ?? '', banco: r.banco ?? '', numero: r.numero ?? '' } : {}) }))}
        nuevo={def.nuevo}
        crear={(d) => guardar(d)} editar={(id, d) => { const { codigo: _c, id: _i, insumo: _x, ...resto } = d; return guardar(resto, id); }}
        columnas={def.columnas}
        campos={[{ key: 'codigo', label: 'Código (mayúsculas, no se cambia después)', requerido: true, max: 20, soloAlCrear: true }, ...def.campos]} />
    </>
  );
}
