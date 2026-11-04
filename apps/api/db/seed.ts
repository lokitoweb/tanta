import { pool } from '../src/db.js';
import { hashClave } from '../src/seguridad.js';

/**
 * Semilla reproducible del sistema.
 * Genera una panadería operando: catálogo, recetas, kárdex con CPP, 30 días de ventas,
 * pedidos, órdenes de producción y cartera. Todos los importes son coherentes entre sí
 * porque se calculan, no se escriben a mano.
 */

const d = (n: number, dec = 6) => n.toFixed(dec);
const r2 = (n: number) => Math.round(n * 100) / 100;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const IGV = 0.18;
const CLAVE_DEMO = 'tanta';

/** Generador determinista: la misma semilla produce siempre los mismos datos. */
let semilla = 20261101;
function azar(): number {
  semilla = (semilla * 1664525 + 1013904223) % 4294967296;
  return semilla / 4294967296;
}
const entre = (a: number, b: number) => a + Math.floor(azar() * (b - a + 1));
const elegir = <T,>(xs: T[]): T => xs[Math.floor(azar() * xs.length)];

const PERMISOS: Array<[string, string, string]> = [
  ['panel.ver', 'Panel', 'Ver el panel de inicio'],
  ['dashboard.ver', 'Gerencia', 'Ver dashboard de costos y márgenes'],
  ['costos.ver', 'Gerencia', 'Ver costo unitario, margen y markup'],
  ['maestros.ver', 'Maestros', 'Consultar productos, insumos y recetas'],
  ['maestros.editar', 'Maestros', 'Crear y editar maestros'],
  ['recetas.ver', 'Maestros', 'Consultar recetas sin columnas de costo'],
  ['recetas.editar', 'Maestros', 'Crear versiones de receta'],
  ['inventario.ver', 'Almacén', 'Consultar stock y kárdex'],
  ['inventario.mover', 'Almacén', 'Registrar bajas, ajustes y recepciones'],
  ['produccion.ver', 'Producción', 'Ver el tablero de órdenes'],
  ['produccion.ejecutar', 'Producción', 'Iniciar, cerrar y reportar merma'],
  ['pedidos.ver', 'Ventas', 'Ver pedidos'],
  ['pedidos.gestionar', 'Ventas', 'Cambiar estado y despachar pedidos'],
  ['ventas.registrar', 'Ventas', 'Registrar venta a terceros'],
  ['cobranza.ver', 'Cobranza', 'Ver cartera y deudas'],
  ['cobranza.registrar', 'Cobranza', 'Registrar pagos totales o parciales'],
  ['clientes.ver', 'Ventas', 'Ver ficha de clientes'],
  ['reportes.ver', 'Gerencia', 'Ver y exportar reportes'],
  ['usuarios.gestionar', 'Seguridad', 'Alta, baja y bloqueo de usuarios'],
  ['usuarios.ver', 'Seguridad', 'Consultar usuarios y sus roles (solo lectura)'],
  ['alertas.stock', 'Almacén', 'Recibir la alerta de insumos bajo el stock mínimo'],
  ['alertas.ventas', 'Ventas', 'Recibir el aviso de cada venta registrada'],
  ['catalogo.ver', 'Cliente', 'Ver catálogo y precios de venta'],
  ['parametros.gestionar', 'Seguridad', 'Cambiar parámetros de negocio'],
  ['periodos.cerrar', 'Gerencia', 'Calcular y cerrar el período de costos'],
  ['config.gestionar', 'Seguridad', 'Configurar marca, app móvil, integraciones y legal'],
  ['roles.gestionar', 'Seguridad', 'Editar los permisos de cada rol'],
  ['clientes.gestionar', 'Ventas', 'Crear y editar clientes, crédito y lista de precios'],
  ['auditoria.ver', 'Seguridad', 'Consultar la bitácora de auditoría'],
  ['pedidos.crear', 'Cliente', 'Registrar pedidos propios desde la app o la web'],
  ['produccion.planificar', 'Producción', 'Generar órdenes de producción'],
  ['ventas.anular', 'Ventas', 'Anular ventas: devuelve el stock y cancela la deuda'],
  ['requisiciones.atender', 'Almacén', 'Entregar a Producción los insumos de una requisición'],
  ['descuentos.aprobar', 'Ventas', 'Aprobar descuentos mayores al máximo permitido'],
  ['proveedores.gestionar', 'Almacén', 'Registrar y editar proveedores'],
  ['compras.registrar', 'Almacén', 'Registrar compras de insumos con su documento'],
  ['conteo.aprobar', 'Almacén', 'Aprobar las diferencias del conteo físico'],
];

const ROLES: Array<[string, string, string, string, string, string, number, string[]]> = [
  ['SUPERADMIN', 'Superadministrador', 'Sistema', 'Configuración total del sistema', 'web', 'shield', 0,
    PERMISOS.map(([id]) => id)],
  ['GERENTE', 'Gerente', 'Gerencia', 'Costos, rentabilidad y márgenes', 'web', 'chart', 1,
    ['panel.ver', 'dashboard.ver', 'costos.ver', 'reportes.ver', 'maestros.ver', 'inventario.ver', 'pedidos.ver', 'cobranza.ver', 'periodos.cerrar', 'auditoria.ver', 'catalogo.ver', 'recetas.ver', 'produccion.ver', 'ventas.anular', 'descuentos.aprobar', 'conteo.aprobar', 'usuarios.ver', 'clientes.ver', 'alertas.stock', 'alertas.ventas']],
  ['ADMINISTRADOR', 'Administrador', 'Maestros', 'Productos, recetas, costos y usuarios', 'web', 'settings', 2,
    ['panel.ver', 'maestros.ver', 'maestros.editar', 'recetas.ver', 'recetas.editar', 'costos.ver', 'inventario.ver', 'usuarios.gestionar', 'reportes.ver', 'parametros.gestionar', 'clientes.gestionar', 'auditoria.ver', 'pedidos.ver', 'produccion.ver', 'cobranza.ver', 'dashboard.ver', 'catalogo.ver', 'ventas.anular', 'proveedores.gestionar', 'usuarios.ver', 'compras.registrar']],
  ['PRODUCCION', 'Producción', 'Producción', 'Órdenes de producción y merma', 'tablet', 'oven', 3,
    ['panel.ver', 'produccion.ver', 'produccion.ejecutar', 'produccion.planificar', 'recetas.ver', 'maestros.ver', 'inventario.ver', 'pedidos.ver', 'catalogo.ver']],
  ['ALMACEN', 'Almacén', 'Almacén', 'Stock, bajas y kárdex', 'app', 'box', 4,
    ['panel.ver', 'inventario.ver', 'inventario.mover', 'recetas.ver', 'catalogo.ver', 'produccion.ver', 'reportes.ver', 'requisiciones.atender', 'compras.registrar', 'maestros.ver', 'pedidos.ver', 'alertas.stock']],
  ['VENDEDOR', 'Vendedor', 'Ventas', 'Despacho, ventas a terceros y cobranza', 'app', 'truck', 5,
    ['panel.ver', 'pedidos.ver', 'pedidos.gestionar', 'pedidos.crear', 'ventas.registrar', 'cobranza.ver', 'cobranza.registrar', 'clientes.ver', 'clientes.gestionar', 'inventario.ver', 'catalogo.ver', 'reportes.ver']],
  ['CLIENTE', 'Cliente', 'Cliente', 'Catálogo, pedidos y saldo', 'app', 'user', 6,
    ['panel.ver', 'catalogo.ver', 'pedidos.crear']],
  ['SOPORTE', 'Soporte técnico', 'Soporte', 'Break-glass: sin datos de negocio', 'web', 'shield', 7,
    ['panel.ver']],
];

const NAV: Array<[string, string, string, string, string, string, number, number]> = [
  ['n-panel', 'Operación', 'Panel', '/panel', 'home', 'panel.ver', 1, 1],
  ['n-produccion', 'Operación', 'Producción', '/produccion', 'oven', 'produccion.ver', 2, 1],
  ['n-almacen', 'Operación', 'Almacén', '/almacen', 'box', 'inventario.ver', 3, 1],
  ['n-kardex', 'Operación', 'Kárdex', '/almacen/kardex', 'ledger', 'inventario.ver', 4, 1],
  ['n-requisiciones', 'Operación', 'Requisiciones', '/almacen/requisiciones', 'clipboard', 'requisiciones.atender', 5, 1],
  ['n-compras', 'Operación', 'Compras', '/almacen/compras', 'sack', 'compras.registrar', 6, 1],
  ['n-conteos', 'Operación', 'Conteo físico', '/almacen/conteos', 'clipboard', 'inventario.ver', 7, 1],
  ['n-pedidos', 'Comercial', 'Pedidos', '/ventas/pedidos', 'clipboard', 'pedidos.ver', 1, 2],
  ['n-cobranza', 'Comercial', 'Cobranza', '/ventas/cobranza', 'wallet', 'cobranza.ver', 2, 2],
  ['n-catalogo', 'Comercial', 'Catálogo', '/catalogo', 'bread', 'catalogo.ver', 3, 2],
  ['n-aprobaciones', 'Comercial', 'Aprobaciones', '/ventas/aprobaciones', 'check', 'descuentos.aprobar', 4, 2],
  ['n-productos', 'Maestros', 'Productos', '/maestros/productos', 'bread', 'maestros.ver', 1, 3],
  ['n-insumos', 'Maestros', 'Insumos', '/maestros/insumos', 'sack', 'maestros.ver', 2, 3],
  ['n-recetas', 'Maestros', 'Recetas', '/maestros/recetas', 'recipe', 'recetas.ver', 3, 3],
  ['n-proveedores', 'Maestros', 'Proveedores', '/maestros/proveedores', 'truck', 'proveedores.gestionar', 4, 3],
  ['n-almacenes', 'Maestros', 'Almacenes', '/maestros/almacenes', 'box', 'maestros.editar', 5, 3],
  ['n-categorias', 'Maestros', 'Categorías', '/maestros/categorias', 'clipboard', 'maestros.editar', 3, 3],
  ['n-clientes', 'Maestros', 'Clientes', '/maestros/clientes', 'user', 'clientes.gestionar', 4, 3],
  ['n-cif', 'Maestros', 'Costos indirectos', '/maestros/cif', 'wallet', 'maestros.editar', 5, 3],
  ['n-usuarios', 'Maestros', 'Usuarios y roles', '/seguridad/usuarios', 'shield', 'usuarios.ver', 6, 3],
  ['n-parametros', 'Maestros', 'Parámetros', '/seguridad/parametros', 'settings', 'parametros.gestionar', 7, 3],
  ['n-roles', 'Sistema', 'Roles y permisos', '/sistema/roles', 'shield', 'roles.gestionar', 1, 9],
  ['n-config', 'Sistema', 'Configuración', '/sistema/configuracion', 'settings', 'config.gestionar', 2, 9],
  ['n-auditoria', 'Sistema', 'Auditoría', '/sistema/auditoria', 'ledger', 'auditoria.ver', 3, 9],
  ['n-dashboard', 'Gerencia', 'Costos y márgenes', '/gerencia/dashboard', 'chart', 'dashboard.ver', 1, 4],
  ['n-reportes', 'Reportes', 'Reportes', '/gerencia/reportes', 'report', 'reportes.ver', 1, 8],
  ['n-periodos', 'Gerencia', 'Períodos de costo', '/gerencia/periodos', 'report', 'periodos.cerrar', 3, 4],
];

const CATEGORIAS: Array<[string, string, number]> = [
  ['pan', 'Pan', 0.45],
  ['pasteleria', 'Pastelería', 0.6],
  ['tortas', 'Tortas', 0.55],
  ['bebidas', 'Bebidas', 0.5],
];

/** [categoria, nombre, unidad, precioConIgv, vendidos30d, peso de la receta] */
const PRODUCTOS: Array<[string, string, string, number, number]> = [
  ['pan', 'Pan francés', 'UNIDAD', 0.5, 1200],
  ['pan', 'Pan ciabatta', 'UNIDAD', 2.36, 260],
  ['pan', 'Pan de yema', 'UNIDAD', 0.6, 540],
  ['pan', 'Pan integral de molde', 'UNIDAD', 9.9, 48],
  ['pan', 'Bagguette artesanal', 'UNIDAD', 4.5, 96],
  ['pan', 'Pan de masa madre', 'UNIDAD', 12.0, 42],
  ['pasteleria', 'Empanada de carne', 'UNIDAD', 4.5, 210],
  ['pasteleria', 'Croissant de mantequilla', 'UNIDAD', 5.5, 140],
  ['pasteleria', 'Alfajor de manjar', 'UNIDAD', 3.5, 180],
  ['pasteleria', 'Pionono de lúcuma', 'PORCIÓN', 7.9, 64],
  ['tortas', 'Torta de chocolate', 'UNIDAD', 45.0, 14],
  ['tortas', 'Torta de tres leches', 'UNIDAD', 42.0, 11],
  ['tortas', 'Cheesecake de maracuyá', 'UNIDAD', 48.0, 9],
  ['bebidas', 'Café pasado', 'VASO', 5.0, 320],
  ['bebidas', 'Chocolate caliente', 'VASO', 7.0, 150],
  ['bebidas', 'Jugo de naranja', 'VASO', 6.5, 120],
];

const INSUMOS: Array<[string, string, string, number, number, number, string]> = [
  ['INS-001', 'Harina de trigo sin preparar', 'KG', 2.1, 100, 40, 'Molino del Sur'],
  ['INS-002', 'Harina integral', 'KG', 4.2, 42, 15, 'Molino del Sur'],
  ['INS-003', 'Azúcar rubia', 'KG', 3.2, 61, 20, 'Distribuidora Lima'],
  ['INS-004', 'Levadura fresca', 'KG', 12.5, 7.4, 3, 'Fermentos SAC'],
  ['INS-005', 'Mantequilla', 'KG', 28.9, 14.2, 5, 'Lácteos Andinos'],
  ['INS-006', 'Leche evaporada', 'L', 6.8, 22, 8, 'Gloria'],
  ['INS-007', 'Huevos', 'UNIDAD', 0.62, 180, 60, 'Granja Sur'],
  ['INS-008', 'Sal', 'KG', 1.1, 8.5, 2, 'Distribuidora Lima'],
  ['INS-009', 'Manjar blanco', 'KG', 14.5, 9.5, 4, 'Lácteos Andinos'],
  ['INS-010', 'Cacao en polvo', 'KG', 32.0, 4.2, 2, 'Cacao del Perú'],
  ['INS-011', 'Lúcuma pulpa', 'KG', 26.0, 3.1, 2, 'Frutas Andinas'],
  ['INS-012', 'Gas GLP', 'BALON', 68.0, 6, 2, 'Repsol'],
];

const PESOS: Record<string, Array<[string, number]>> = {
  'Pan francés': [['INS-001', 1], ['INS-004', 0.02], ['INS-008', 0.01]],
  'Pan ciabatta': [['INS-001', 1], ['INS-004', 0.03], ['INS-005', 0.04], ['INS-008', 0.005]],
  'Pan de yema': [['INS-001', 1], ['INS-007', 0.25], ['INS-003', 0.12], ['INS-005', 0.08]],
  'Pan integral de molde': [['INS-002', 1], ['INS-003', 0.08], ['INS-005', 0.1], ['INS-004', 0.02]],
  'Bagguette artesanal': [['INS-001', 1], ['INS-004', 0.02], ['INS-008', 0.008]],
  'Pan de masa madre': [['INS-001', 1], ['INS-004', 0.015], ['INS-008', 0.006]],
  'Empanada de carne': [['INS-001', 1], ['INS-005', 0.18], ['INS-007', 0.2], ['INS-008', 0.01]],
  'Croissant de mantequilla': [['INS-001', 1], ['INS-005', 0.45], ['INS-003', 0.1], ['INS-004', 0.02]],
  'Alfajor de manjar': [['INS-001', 1], ['INS-009', 0.5], ['INS-003', 0.2]],
  'Pionono de lúcuma': [['INS-001', 1], ['INS-011', 0.55], ['INS-007', 0.3], ['INS-003', 0.25]],
  'Torta de chocolate': [['INS-001', 1], ['INS-010', 0.35], ['INS-007', 0.6], ['INS-005', 0.4], ['INS-003', 0.45]],
  'Torta de tres leches': [['INS-001', 1], ['INS-006', 0.9], ['INS-007', 0.6], ['INS-003', 0.4]],
  'Cheesecake de maracuyá': [['INS-001', 1], ['INS-005', 0.5], ['INS-007', 0.5], ['INS-003', 0.35]],
  'Café pasado': [['INS-010', 0.02]],
  'Chocolate caliente': [['INS-010', 0.05], ['INS-006', 0.6]],
  'Jugo de naranja': [['INS-003', 0.15]],
};

const CLIENTES: Array<[string, string, string, string, number, number, string]> = [
  ['CLI-001', 'Bodega Doña Rosa', 'RUC', '20481234567', 15, 1500, 'MAYORISTA'],
  ['CLI-002', 'Cafetería El Molino', 'RUC', '20556677889', 8, 900, 'MAYORISTA'],
  ['CLI-003', 'Restaurante La Brasa', 'RUC', '20667788991', 30, 1200, 'MAYORISTA'],
  ['CLI-004', 'Minimarket San Juan', 'RUC', '20778899112', 5, 600, 'MAYORISTA'],
  ['CLI-005', 'Colegio Santa Ana', 'RUC', '20889911223', 30, 2000, 'MAYORISTA'],
  ['CLI-006', 'María Fernández', 'DNI', '45678912', 0, 200, 'MINORISTA'],
  ['CLI-007', 'Carlos Ríos', 'DNI', '41234567', 0, 150, 'MINORISTA'],
];

const USUARIOS: Array<[string, string, string]> = [
  ['Oscar Quilcate Rosell', 'osquilcate', 'GERENTE'],
  ['Lucía Bermúdez', 'lbermudez', 'ADMINISTRADOR'],
  ['Rosa Quispe', 'rquispe', 'PRODUCCION'],
  ['Julio Ramos', 'jramos', 'ALMACEN'],
  ['Carlos Medina', 'cmedina', 'VENDEDOR'],
  ['María Fernández', 'mfernandez', 'CLIENTE'],
  ['Soporte eSolutionsNet', 'soporte', 'SOPORTE'],
  ['Superadministrador', 'superadmin', 'SUPERADMIN'],
];

async function main() {
  const c = await pool.connect();
  try {
    console.log('Limpiando datos anteriores…');
    // audit.evento es append-only por trigger: para reiniciar el entorno de desarrollo
    // hay que desactivar temporalmente el trigger (solo el dueño puede hacerlo).
    await c.query('ALTER TABLE audit.evento DISABLE TRIGGER USER');
    await c.query(`TRUNCATE core.cobranza, core.cuenta_por_cobrar, core.venta_detalle, core.venta,
      core.pedido, core.orden_produccion, core.movimiento_inventario, core.receta_detalle, core.receta,
      core.producto, core.insumo, core.proveedor, core.compra, core.conteo, core.alerta_stock, core.cliente, core.categoria, core.usuario_rol, core.refresh_token,
      core.usuario, core.rol_permiso, core.navegacion, core.permiso, core.rol, core.parametro,
      audit.evento RESTART IDENTITY CASCADE`);
    await c.query("UPDATE audit.cadena_estado SET hash_actual = '' WHERE id = 1");
    await c.query('ALTER TABLE audit.evento ENABLE TRIGGER USER');
    await c.query('TRUNCATE core.periodo_costos, core.idempotencia, core.costo_indirecto CASCADE');

    await c.query('BEGIN');

    // ---------------------------------------------------------- permisos
    for (const [id, grupo, desc] of PERMISOS) {
      await c.query('INSERT INTO core.permiso (id, grupo, descripcion) VALUES ($1,$2,$3)', [id, grupo, desc]);
    }

    // ------------------------------------------------------------- roles
    for (const [id, nombre, corto, desc, perfil, icono, orden, permisos] of ROLES) {
      await c.query(
        `INSERT INTO core.rol (id,nombre,corto,descripcion,perfil,icono,orden) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, nombre, corto, desc, perfil, icono, orden],
      );
      for (const p of permisos) {
        await c.query('INSERT INTO core.rol_permiso (rol_id, permiso_id) VALUES ($1,$2)', [id, p]);
      }
    }

    // -------------------------------------------------------- navegación
    for (const [id, grupo, etiqueta, ruta, icono, permiso, orden, grupoOrden] of NAV) {
      await c.query(
        `INSERT INTO core.navegacion (id,grupo,etiqueta,ruta,icono,permiso_id,orden,grupo_orden)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, grupo, etiqueta, ruta, icono, permiso, orden, grupoOrden],
      );
    }

    // -------------------------------------------------------- parámetros
    for (const [clave, valor, tipo, desc] of [
      ['igv', String(IGV), 'porcentaje', 'IGV vigente en Perú'],
      ['moneda', 'PEN', 'texto', 'Moneda del sistema'],
      ['margen_objetivo_global', '0.52', 'porcentaje', 'Margen objetivo por defecto'],
      ['permitir_saldo_negativo', 'false', 'booleano', 'Política estricta de inventario'],
      ['cif_base_prorrateo', 'UNIDADES', 'texto', 'Base de prorrateo del CIF: UNIDADES o COSTO_INSUMOS'],
      ['descuento_maximo', '0.10', 'porcentaje', 'Descuento máximo que un vendedor puede aplicar en una venta'],
      ['sueldo_base', '1500', 'numero', 'Sueldo mensual de referencia del personal de producción (S/)'],
      ['factor_beneficios', '0', 'porcentaje', 'Beneficios y aportes sobre el sueldo (0.45 = 45 %)'],
      ['horas_mes', '192', 'numero', 'Horas trabajadas al mes por persona'],
      ['tolerancia_varianza', '0.03', 'porcentaje', 'Tolerancia del consumo real frente al teórico'],
      ['dias_alerta_vencimiento', '7', 'numero', 'Días antes del vencimiento de un lote de insumo para avisar a Almacén y Gerencia'],
    ]) {
      await c.query('INSERT INTO core.parametro (clave,valor,tipo,descripcion) VALUES ($1,$2,$3,$4)', [clave, valor, tipo, desc]);
    }

    // ---------------------------------------------------------- usuarios
    const hash = hashClave(CLAVE_DEMO);
    const idClientePorCodigo = new Map<string, string>();

    for (const [nombre, usuario, rol] of USUARIOS) {
      const r = await c.query(
        'INSERT INTO core.usuario (nombre, usuario, clave_hash) VALUES ($1,$2,$3) RETURNING id',
        [nombre, usuario, hash],
      );
      await c.query('INSERT INTO core.usuario_rol (usuario_id, rol_id) VALUES ($1,$2)', [r.rows[0].id, rol]);
    }
    void idClientePorCodigo;

    // -------------------------------------------------------- categorías
    for (const [id, nombre, objetivo] of CATEGORIAS) {
      await c.query('INSERT INTO core.categoria (id,nombre,margen_objetivo,orden) VALUES ($1,$2,$3,$4)',
        [id, nombre, d(objetivo), CATEGORIAS.findIndex((x) => x[0] === id)]);
    }

    // --------------------------------------------------------- almacenes
    // MAE-10: insumos y productos terminados; responsable, el usuario de Almacén.
    await c.query(`INSERT INTO core.almacen (nombre, tipo, principal, responsable_id)
      SELECT n, t, true, (SELECT id FROM core.usuario WHERE usuario = 'jramos') FROM (VALUES ('Almacén de insumos', 'INSUMOS'), ('Almacén de productos terminados', 'PRODUCTOS')) v(n, t)
      ON CONFLICT DO NOTHING`);

    // ----------------------------------------------------------- insumos
    const idInsumo = new Map<string, string>();
    for (const [codigo, nombre, unidad, cpp, stock, minimo, proveedor] of INSUMOS) {
      const r = await c.query(
        `INSERT INTO core.insumo (codigo,nombre,unidad,cpp,stock,minimo,proveedor,estado)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [codigo, nombre, unidad, d(cpp), d(stock), d(minimo), proveedor, stock <= minimo ? 'BAJO_MINIMO' : 'OK'],
      );
      idInsumo.set(codigo, r.rows[0].id);
    }
    // MAE-09: los proveedores salen de los insumos de ejemplo y quedan vinculados.
    await c.query(`INSERT INTO core.proveedor (razon_social) SELECT DISTINCT proveedor FROM core.insumo WHERE proveedor <> '' ON CONFLICT DO NOTHING`);
    await c.query('UPDATE core.insumo i SET proveedor_id = p.id FROM core.proveedor p WHERE lower(i.proveedor) = lower(p.razon_social)');

    // --------------------------------------------------------- productos
    const cppInsumo = new Map(INSUMOS.map(([cod, , , cpp]) => [cod, cpp]));
    const productosCreados: Array<{ id: string; nombre: string; precio: number; costo: number; vendidos: number; categoria: string }> = [];

    // Cada categoría tiene su propia estructura de costo: el pan es volumen con margen ajustado,
    // la pastelería tiene margen alto. Sin esta variación el dashboard miente por uniformidad.
    const RATIO_COSTO: Record<string, number> = { pan: 0.58, pasteleria: 0.43, tortas: 0.48, bebidas: 0.44 };

    // Gramos del insumo principal por unidad vendida. Son cantidades FÍSICAS: una ciabatta
    // lleva ~110 g de harina, no 500. Las recetas se derivan de aquí y el costo cae donde cae.
    const PESO_FISICO: Record<string, number> = {
      'Pan francés': 0.060, 'Pan ciabatta': 0.110, 'Pan de yema': 0.070,
      'Pan integral de molde': 0.480, 'Bagguette artesanal': 0.250, 'Pan de masa madre': 0.500,
      'Empanada de carne': 0.080, 'Croissant de mantequilla': 0.075,
      'Alfajor de manjar': 0.050, 'Pionono de lúcuma': 0.090,
      'Torta de chocolate': 1.100, 'Torta de tres leches': 1.200, 'Cheesecake de maracuyá': 1.100,
      'Café pasado': 0.018, 'Chocolate caliente': 0.020, 'Jugo de naranja': 0.250,
    };

    for (const [categoria, nombre, unidad, precio, vendidos] of PRODUCTOS) {
      const neto = precio / (1 + IGV);
      const merma = 0.03;
      const ratio = (RATIO_COSTO[categoria] ?? 0.5) + (azar() - 0.5) * 0.06;
      const pesos = PESOS[nombre] ?? [['INS-001', 1] as [string, number]];
      const base = PESO_FISICO[nombre] ?? 0.1;
      const lineas = pesos.map(([cod, w]) => ({
        cod,
        cantidad: r6(w * base),
        cpp: cppInsumo.get(cod) ?? 0,
      }));
      const costoInsumos = r6(lineas.reduce((s, l) => s + l.cantidad * l.cpp, 0));
      const costoConMerma = r6(costoInsumos / (1 - merma));
      // El CIF absorbe la diferencia hasta el costo objetivo; nunca resta.
      const cif = r6(Math.max(0, neto * ratio - costoConMerma));
      const costo = r6(costoConMerma + cif);

      const pr = await c.query(
        `INSERT INTO core.producto (codigo,nombre,categoria_id,unidad,precio_con_igv,costo_unitario,merma_pct,vendidos_30d,stock)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [`P${String(productosCreados.length + 1).padStart(3, '0')}`, nombre, categoria, unidad,
          d(precio, 4), d(costo), d(merma), vendidos, d(Math.round(vendidos * 0.06))],
      );
      const productoId = pr.rows[0].id as string;

      await c.query(
        `INSERT INTO core.receta (id,producto_id,producto,version,estado,rendimiento,merma_estandar,costo_insumos,costo_con_merma,cif_unitario)
         VALUES ($1,$1,$2,1,'VIGENTE',24,$3,$4,$5,$6)`,
        [productoId, nombre, d(merma), d(costoInsumos), d(costoConMerma), d(cif)],
      );

      let orden = 1;
      for (const l of lineas) {
        const ins = INSUMOS.find((i) => i[0] === l.cod)!;
        await c.query(
          `INSERT INTO core.receta_detalle (receta_id,insumo_id,insumo,unidad,cantidad,cpp,costo,orden)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          // La receta describe una tanda de 24 unidades (rendimiento): cantidades por tanda, no por unidad.
          [productoId, idInsumo.get(l.cod), ins[1], ins[2], d(l.cantidad * 24), d(l.cpp), d(l.cantidad * 24 * l.cpp), orden++],
        );
      }

      productosCreados.push({ id: productoId, nombre, precio, costo, vendidos, categoria });
    }

    // ---------------------------------------------------------- clientes
    const idsCliente: string[] = [];
    for (const [codigo, nombre, docTipo, docNumero, dias, limite, lista] of CLIENTES) {
      const r = await c.query(
        `INSERT INTO core.cliente (codigo,nombre,doc_tipo,doc_numero,lista_precio,dias_credito,limite_credito,condicion_pago)
         VALUES ($1,$2,$3,$4,$5,$6::int,$7::numeric, CASE WHEN $6::int > 0 OR $7::numeric > 0 THEN 'CREDITO' ELSE 'CONTADO' END) RETURNING id`,
        [codigo, nombre, docTipo, docNumero, lista, dias, d(limite, 4)],
      );
      idsCliente.push(r.rows[0].id);
    }

    // El usuario CLIENTE se liga a su ficha cuando ya existe (María Fernández · CLI-006).
    await c.query(
      `UPDATE core.usuario u SET cliente_id = c.id
       FROM core.cliente c
       WHERE c.codigo = 'CLI-006' AND u.usuario = 'mfernandez'`,
    );

    // ------------------------------------------------- kárdex de la harina
    const movimientos: Array<[string, string, number, number | null]> = [
      ['APERTURA', 'Acta 001', 400, 2.1],
      ['COMPRA', 'Factura F-001', 50, 2.36],
      ['CONSUMO_OP', 'OP-2026-000312', -60, null],
      ['COMPRA', 'Boleta B-014', 40, 2.42],
      ['CONSUMO_OP', 'OP-2026-000313', -100, null],
      ['COMPRA', 'Factura F-009', 150, 2.55],
      ['CONSUMO_OP', 'OP-2026-000316', -85, null],
      ['MERMA', 'OP-2026-000316', -4.5, null],
      ['CONSUMO_OP', 'OP-2026-000317', -62, null],
      ['COMPRA', 'Factura F-012', 80, 2.61],
      ['CONSUMO_OP', 'OP-2026-000312', -38, null],
    ];
    let saldoCant = 0;
    let saldoValor = 0;
    let cpp = 0;
    const harina = idInsumo.get('INS-001')!;
    for (const [tipo, documento, cantidad, costo] of movimientos) {
      if (costo !== null) {
        saldoValor += cantidad * costo;
        saldoCant += cantidad;
        cpp = saldoValor / saldoCant;
      } else {
        saldoValor += cantidad * cpp;
        saldoCant += cantidad;
      }
      const valor = costo !== null ? cantidad * costo : cantidad * cpp;
      await c.query(
        `INSERT INTO core.movimiento_inventario
           (tipo,item_tipo,insumo_id,documento,cantidad,costo_unitario,valor,saldo_cantidad,saldo_valor,cpp)
         VALUES ($1,'INSUMO',$2,$3,$4,$5,$6,$7,$8,$9)`,
        [tipo, harina, documento, d(cantidad), d(costo ?? cpp), d(r2(valor), 4), d(r6(saldoCant)), d(r2(saldoValor), 4), d(r6(cpp))],
      );
    }
    await c.query('UPDATE core.insumo SET stock = $1, cpp = $2 WHERE id = $3',
      [d(r6(saldoCant)), d(r6(cpp)), harina]);

    // ---------------------------------------------- 30 días de operación
    const hoy = new Date('2026-11-01T12:00:00Z');
    let nVenta = 0;
    let nPedido = 0;

    for (let diasAtras = 29; diasAtras >= 0; diasAtras--) {
      const fecha = new Date(hoy);
      fecha.setUTCDate(fecha.getUTCDate() - diasAtras);
      const dow = fecha.getUTCDay();
      const factor = dow === 0 || dow === 6 ? 1.25 : 1;
      const objetivoDia = 2400 * factor * (0.88 + azar() * 0.24);
      let acumulado = 0;

      while (acumulado < objetivoDia) {
        const lineas: Array<{ p: typeof productosCreados[number]; qty: number }> = [];
        const nLineas = entre(1, 3);
        for (let i = 0; i < nLineas; i++) {
          const p = elegir(productosCreados);
          const neto = p.precio / (1 + IGV);
          const objetivoLinea = 45 + azar() * 260;
          const qty = Math.max(1, Math.round(objetivoLinea / neto));
          lineas.push({ p, qty });
        }

        const ventasNetas = r2(lineas.reduce((s, l) => s + l.qty * (l.p.precio / (1 + IGV)), 0));
        const costoVentas = r2(lineas.reduce((s, l) => s + l.qty * l.p.costo, 0));
        const utilidad = r2(ventasNetas - costoVentas);
        const margen = r6(utilidad / ventasNetas);
        const credito = azar() < 0.35;
        const formaPago = credito ? 'CREDITO' : elegir(['EFECTIVO', 'YAPE', 'TRANSFERENCIA', 'PLIN']);
        const cliente = elegir(idsCliente);

        const vr = await c.query(
          `INSERT INTO core.venta (codigo,cliente_id,forma_pago,ventas_netas,costo_ventas,utilidad,margen,estado,vendedor,creado_en)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'CONFIRMADA','Carlos Medina',$8) RETURNING id`,
          [`VTA-2026-${String(++nVenta).padStart(6, '0')}`, cliente, formaPago,
            d(ventasNetas, 4), d(costoVentas, 4), d(utilidad, 4), d(margen), fecha.toISOString()],
        );
        const ventaId = vr.rows[0].id as string;

        for (const l of lineas) {
          const neto = r2(l.qty * (l.p.precio / (1 + IGV)));
          const costo = r2(l.qty * l.p.costo);
          await c.query(
            `INSERT INTO core.venta_detalle (venta_id,producto_id,producto,cantidad,precio_con_igv,precio_neto,costo_unitario,utilidad,margen)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            // precio_neto es por unidad (igual que la API de ventas); utilidad es el total de la línea.
            [ventaId, l.p.id, l.p.nombre, d(l.qty), d(l.p.precio, 4), d(neto / l.qty, 4), d(l.p.costo),
              d(r2(neto - costo), 4), d(r6((neto - costo) / neto))],
          );
        }

        if (credito) {
          const clienteDias = CLIENTES[idsCliente.indexOf(cliente)]?.[4] ?? 15;
          const vence = new Date(fecha);
          vence.setUTCDate(vence.getUTCDate() + clienteDias);
          await c.query(
            `INSERT INTO core.cuenta_por_cobrar (cliente_id,venta_id,monto,saldo,vence_en,estado,creado_en)
             VALUES ($1,$2,$3,$3,$4,'PENDIENTE',$5)`,
            [cliente, ventaId, d(ventasNetas, 4), vence.toISOString().slice(0, 10), fecha.toISOString()],
          );
        }

        acumulado += ventasNetas;
      }

      // pedidos del cliente por app
      if (diasAtras % 4 === 0) {
        const estado = elegir(['REGISTRADO', 'EN_PRODUCCION', 'LISTO', 'DESPACHADO', 'ENTREGADO']);
        const total = r2(180 + azar() * 600);
        await c.query(
          `INSERT INTO core.pedido (codigo,cliente_id,cliente,vendedor,estado,total,fecha_entrega,creado_en)
           VALUES ($1,$2,$3,'Carlos Medina',$4,$5,$6,$7)`,
          [`PED-2026-${String(++nPedido).padStart(6, '0')}`, elegir(idsCliente),
            CLIENTES[entre(0, CLIENTES.length - 1)][1], estado, d(total, 4),
            fecha.toISOString().slice(0, 10), fecha.toISOString()],
        );
      }
    }

    // ------------------------------------------------ órdenes de producción
    const ops: Array<[string, string, number, string, string, string, number]> = [
      ['OP-2026-000312', 'Pan ciabatta', 240, 'EN_PROCESO', '2026-11-01', 'Rosa Quispe', 0.62],
      ['OP-2026-000313', 'Pan francés', 1800, 'PENDIENTE', '2026-11-01', 'Rosa Quispe', 0.4],
      ['OP-2026-000314', 'Croissant de mantequilla', 320, 'PENDIENTE', '2026-11-01', 'Julio Ramos', 0.7],
      ['OP-2026-000315', 'Torta de chocolate', 18, 'EN_PROCESO', '2026-11-02', 'Milagros Vega', 0.85],
      ['OP-2026-000316', 'Pan de yema', 600, 'TERMINADA', '2026-10-31', 'Rosa Quispe', 1],
      ['OP-2026-000317', 'Empanada de carne', 400, 'TERMINADA', '2026-10-31', 'Julio Ramos', 1],
      ['OP-2026-000318', 'Bagguette artesanal', 150, 'TERMINADA', '2026-10-31', 'Milagros Vega', 1],
      ['OP-2026-000319', 'Cheesecake de maracuyá', 12, 'PENDIENTE', '2026-11-02', 'Milagros Vega', 0.15],
    ];
    for (const [codigo, producto, cantidad, estado, entrega, responsable, avance] of ops) {
      const p = productosCreados.find((x) => x.nombre === producto)!;
      await c.query(
        `INSERT INTO core.orden_produccion (codigo,producto_id,producto,receta_id,cantidad,estado,entrega,responsable,avance,terminada_en)
         VALUES ($1,$2,$3,$2,$4,$5,$6,$7,$8,$9)`,
        [codigo, p.id, producto, d(cantidad), estado, entrega, responsable, d(avance, 4),
          estado === 'TERMINADA' ? new Date('2026-10-31T14:00:00Z').toISOString() : null],
      );
    }

    // -------------------------------------------------- período de costos
    await c.query(
      `INSERT INTO core.periodo_costos (anio, mes, estado, cif_total) VALUES (2026, 10, 'CALCULADO', $1)`,
      [d(8420.5, 4)],
    );
    await c.query(
      `INSERT INTO core.periodo_costos (anio, mes, estado, cif_total) VALUES (2026, 11, 'ABIERTO', $1)`,
      [d(0, 4)],
    );

    // ------------------------------------------ costos indirectos (PDF §3.3)
    for (const [concepto, tipo, monto] of [
      ['Alquiler del local', 'FIJO', 3200], ['Energía eléctrica', 'VARIABLE', 1450], ['Gas GLP del horno', 'VARIABLE', 1380],
      ['Agua', 'VARIABLE', 240], ['Planilla indirecta', 'FIJO', 1650], ['Depreciación de equipos', 'FIJO', 500.5],
    ] as Array<[string, string, number]>) {
      await c.query('INSERT INTO core.costo_indirecto (concepto, tipo, monto_mensual) VALUES ($1,$2,$3)', [concepto, tipo, monto]);
    }
    // El costo de cada producto sale del motor (receta × CPP + merma + CIF), no de un número fijo.
    await c.query('SELECT core.recalcular_costos()');

    // Los correlativos siguen a los documentos cargados: sin esto, la primera venta real
    // de una base recién sembrada chocaba con VTA-…-000001 (409 DUPLICADO).
    // Por el número más alto (no por count): la semilla no numera de forma contigua.
    await c.query(`SELECT setval('core.venta_correlativo_seq', GREATEST((SELECT coalesce(max(substring(codigo from '(\\d+)$')::bigint), 0) FROM core.venta), 1)),
                          setval('core.pedido_correlativo_seq', GREATEST((SELECT coalesce(max(substring(codigo from '(\\d+)$')::bigint), 0) FROM core.pedido), 1)),
                          setval('core.op_correlativo_seq', GREATEST((SELECT coalesce(max(substring(codigo from '(\\d+)$')::bigint), 0) FROM core.orden_produccion), 1))`);
    // AIN-11: el stock de ejemplo entra como lote INICIAL (sin vencimiento) donde no vino por movimientos.
    await c.query('SELECT core.cuadrar_lotes()');
    await c.query('COMMIT');

    const resumen = await c.query(`
      SELECT (SELECT count(*) FROM core.producto)::int AS productos,
             (SELECT count(*) FROM core.insumo)::int   AS insumos,
             (SELECT count(*) FROM core.venta)::int    AS ventas,
             (SELECT count(*) FROM core.venta_detalle)::int AS lineas,
             (SELECT count(*) FROM core.pedido)::int   AS pedidos,
             (SELECT count(*) FROM core.cuenta_por_cobrar)::int AS cxc,
             (SELECT count(*) FROM core.movimiento_inventario)::int AS movimientos`);
    console.log('Semilla aplicada:', resumen.rows[0]);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('Error en la semilla:', e);
    process.exit(1);
  } finally {
    c.release();
    await pool.end();
  }
}

await main();
