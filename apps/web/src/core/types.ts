export type RolId = 'GERENTE' | 'ADMINISTRADOR' | 'PRODUCCION' | 'ALMACEN' | 'VENDEDOR' | 'CLIENTE' | 'SOPORTE';

export interface Permiso { id: string; grupo: string; descripcion: string }
export interface Rol {
  id: string; nombre: string; corto: string; descripcion: string;
  perfil: 'web' | 'tablet' | 'app'; icono: string; inicio?: string; permisos: string[];
}
export interface NavItem { id: string; etiqueta: string; ruta: string; icono: string; permiso?: string }
export interface NavGrupo { titulo: string; items: NavItem[] }

export interface Producto {
  id: string; codigo: string; nombre: string; categoriaId: string; unidad: string;
  precioConIgv: number; precioNeto: number; costoUnitario: number;
  margen: number; margenObjetivo: number; vendidos30d: number; stock: number;
  mermaPct: number; estado: string; imagenUrl?: string | null;
  /** Sub-receta: insumo que produce (masa madre). No se vende. */
  insumoId?: string | null;
  /** SKU de la unidad y presentaciones de venta adicionales (paquete x 6) con su precio. */
  sku?: string; presentaciones?: PresentacionProducto[];
  /** SKU #1: presentación de venta y su equivalencia en unidades (precioConIgv es por unidad). */
  presentacionCodigo?: string; presentacionNombre?: string; presentacionEquivalencia?: number;
  pesoMasaG?: number | null; pesoFinalG?: number | null; unidadesLote?: number | null; horasHornoLote?: number; vidaUtilDias?: number | null;
}
export interface PresentacionProducto { presentacion: string; nombre: string; equivalencia: number; sku: string; precioConIgv: number; activo: boolean }
export interface Insumo {
  id: string; codigo?: string; nombre: string; unidad: string; cpp: number; stock: number;
  minimo: number; proveedor: string; estado: string; valorizado: number;
  /** Compra de insumos: presentación, contenido en unidad base, unidad de inventario y factor (F2). */
  presentacion?: string; contenido?: number | null; unidadInventario?: string; factor?: number;
  activo?: boolean; tipo?: string; manejaStock?: boolean; presentacionCodigo?: string; costoFormulas?: number; costoManual?: boolean;
  precioCompra?: number | null; cantPresentacion?: number | null; equivKg?: number;
}
export interface Categoria {
  id: string; codigo?: string; nombre: string; orden?: number; ventas: number; costo: number; utilidad: number;
  margen: number; margenObjetivo: number; participacion: number;
}
export interface Dia { fecha: string; ventasNetas: number; costo: number; utilidad: number; margen: number; tickets: number }
export interface Op {
  codigo: string; producto: string; cantidad: number; estado: string;
  entrega: string; responsable: string; avance: number; mermaEsperada: number;
}
export interface Pedido {
  codigo: string; cliente: string; estado: string; total: number;
  fechaEntrega: string; vendedor: string;
}
export interface Cliente {
  id: string; nombre: string; docTipo: string; saldo: number; vencido: number;
  diasPromedio: number; limiteCredito: number; listaPrecio: string;
}
export interface Movimiento {
  item?: string;
  fecha: string; tipo: string; documento: string; cantidad: number;
  costo: number | null; costoUnitario: number; valor: number;
  saldoCantidad: number; saldoValor: number; cpp: number;
}

export interface RecetaLinea {
  insumoId: string; insumo: string; unidad: string; cantidad: number;
  cpp?: number; costo?: number;   // ausentes si el rol no puede ver costos
}
export interface Receta {
  id: string; productoId: string; producto: string; version: number; estado: string;
  rendimiento: number; mermaEstandar: number; lineas: RecetaLinea[];
  // Campos de costo: el API no los envía a los roles sin permiso `costos.ver`.
  costoInsumos?: number; costoConMerma?: number; cifUnit?: number; costoUnitario?: number; margen?: number;
}
export interface Usuario {
  id: string; nombre: string; usuario: string; rol: string; rolId?: string; estado: string; ultimoAcceso: string;
}
export interface Kpis {
  ventasNetas: number; costoVentas: number; utilidadBruta: number; margen: number;
  margenObjetivo: number; tickets: number; ticketPromedio: number;
  variacionVentas: number; variacionMargen: number;
  porCobrar: number; vencido: number; diasPromedioCobro?: number; mermaValorizada: number; mermaPct: number;
}
export interface Dataset {
  generadoEn: string;
  periodo: { desde: string; hasta: string; etiqueta: string; estado: 'PROVISIONAL' | 'DEFINITIVO' };
  negocio: {
    nombre: string; ruc: string; direccion: string; telefono: string; whatsapp?: string;
    email?: string; claim?: string; representante: string; igv: number; moneda: string; margenObjetivoGlobal: number;
  };
  kpis: Kpis;
  dias: Dia[];
  categorias: Categoria[];
  productos: Producto[];
  topProductos: Array<{ id: string; nombre: string; categoria: string; ventas: number; utilidad: number; margen: number; margenObjetivo: number; unidades: number }>;
  insumos: Insumo[];
  recetas: Receta[];
  usuarios: Usuario[];
  ops: Op[];
  pedidos: Pedido[];
  clientes: Cliente[];
  movimientos: Movimiento[];
  aging: Array<{ rango: string; monto: number; documentos: number }>;
  /** Solo cuando el usuario es un cliente: sus pedidos y su saldo, nunca los de otros. */
  misPedidos?: Array<{ codigo: string; estado: string; total: number; fechaEntrega: string }>;
  miSaldo?: number;
}
