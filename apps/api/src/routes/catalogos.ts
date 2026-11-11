import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { q, uno, num } from '../db.js';
import { autenticar, exigir, error } from '../seguridad.js';
import { auditar } from '../auditoria.js';
import { actor, fallo, responder } from './almacen.js';

/**
 * Catálogos administrables: tipos de documento de compra, medios de pago, tipos de insumo, unidades,
 * presentaciones de compra y de venta, y bancos.
 * Las reglas salen de los atributos de cada fila (crédito fiscal, n.° de operación, caja chica, harina, familia),
 * no del código del valor: el Administrador puede agregar o desactivar valores sin cambiar el sistema.
 */

const codigo = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{1,19}$/, 'Código en mayúsculas, sin espacios (2 a 20 letras, números, - o _)');
// Los catálogos de antes empiezan con letra (lo exige su CHECK); los nuevos aceptan códigos numéricos (1001, 2001…).
const conLetra = z.string().regex(/^[A-Z]/, 'En este catálogo el código empieza con una letra');
const nombre = z.string().trim().min(2).max(60);
const base = { nombre, activo: z.boolean().default(true), orden: z.number().int().min(0).max(999).default(0) };

const ESQUEMAS = {
  'tipos-documento': {
    tabla: 'core.tipo_documento_compra',
    campos: z.object({ ...base, creditoFiscal: z.boolean().default(false) }),
    columnas: { nombre: 'nombre', activo: 'activo', orden: 'orden', creditoFiscal: 'credito_fiscal' },
    enUso: 'SELECT 1 FROM core.compra WHERE doc_tipo = $1 LIMIT 1',
  },
  'medios-pago': {
    tabla: 'core.medio_pago',
    campos: z.object({ ...base, requiereOperacion: z.boolean().default(false), enVentas: z.boolean().default(false), enCobranza: z.boolean().default(false),
      enCompras: z.boolean().default(false), cajaChica: z.boolean().default(false), esCredito: z.boolean().default(false),
      // Caja grande: cuenta a la que llega lo cobrado con este medio (efectivo → caja fuerte, Yape → su cuenta…).
      cuentaCaja: z.string().trim().toUpperCase().max(20).nullable().default(null).transform((v) => v || null) })
      .refine((d) => !d.esCredito || !(d.enCobranza || d.enCompras || d.cajaChica || d.requiereOperacion),
        { message: 'El crédito no cobra, no paga a proveedores, no sale de caja ni lleva n.° de operación.' })
      .refine((d) => !d.cajaChica || !d.requiereOperacion, { message: 'La caja chica es efectivo: no lleva n.° de operación.' })
      .refine((d) => d.esCredito || !d.enCobranza || d.cuentaCaja, { message: 'Indica a qué cuenta de caja grande llega lo cobrado con este medio.' }),
    columnas: { nombre: 'nombre', activo: 'activo', orden: 'orden', requiereOperacion: 'requiere_operacion', enVentas: 'en_ventas', enCobranza: 'en_cobranza',
      enCompras: 'en_compras', cajaChica: 'caja_chica', esCredito: 'es_credito', cuentaCaja: 'cuenta_caja' },
    enUso: `SELECT 1 FROM core.venta WHERE forma_pago = $1 UNION ALL SELECT 1 FROM core.cobranza WHERE medio = $1 UNION ALL SELECT 1 FROM core.pago_compra WHERE medio_pago = $1 LIMIT 1`,
  },
  'tipos-insumo': {
    tabla: 'core.tipo_insumo',
    campos: z.object({ ...base, esHarina: z.boolean().default(false), esEmpaque: z.boolean().default(false), sumaPeso: z.boolean().default(true) }),
    columnas: { nombre: 'nombre', activo: 'activo', orden: 'orden', esHarina: 'es_harina', esEmpaque: 'es_empaque', sumaPeso: 'suma_peso' },
    enUso: 'SELECT 1 FROM core.insumo WHERE tipo = $1 LIMIT 1',
  },
  unidades: {
    tabla: 'core.unidad_medida',
    campos: z.object({ descripcion: nombre, familia: z.enum(['MASA', 'VOLUMEN', 'CONTEO']), factorAPatron: z.number().positive().max(1_000_000),
      activo: z.boolean().default(true), orden: z.number().int().min(0).max(999).default(0) }),
    columnas: { descripcion: 'descripcion', familia: 'familia', factorAPatron: 'factor_a_patron', activo: 'activo', orden: 'orden' },
    enUso: `SELECT 1 FROM core.insumo WHERE unidad = $1 OR unidad_inventario = $1 UNION ALL SELECT 1 FROM core.receta_detalle WHERE unidad_receta = $1 LIMIT 1`,
  },
  // Excel «PRESENTACION COMPRA»: saco x 50 kg, botella 900 ml… equivalencia = contenido en unidad base del insumo.
  'presentaciones-compra': {
    tabla: 'core.presentacion_compra',
    campos: z.object({ ...base, equivalencia: z.number().positive().max(1_000_000) }),
    columnas: { nombre: 'nombre', activo: 'activo', orden: 'orden', equivalencia: 'equivalencia' },
    enUso: 'SELECT 1 FROM core.insumo WHERE presentacion_codigo = $1 LIMIT 1',
  },
  // Excel «PRESENTACION VENTA»: unidades del producto y el empaque que se descarga solo al vender (1 bolsa por paquete).
  'presentaciones-venta': {
    tabla: 'core.presentacion_venta',
    campos: z.object({ ...base, equivalencia: z.number().positive().max(10_000),
      insumoId: z.union([z.literal(''), z.string().uuid()]).nullable().default(null).transform((v) => v || null),
      cantidadInsumo: z.number().positive().max(10_000).nullable().default(null) })
      .refine((d) => (d.insumoId === null) === (d.cantidadInsumo === null), { message: 'Indica el insumo a descontar y su cantidad, o deja ambos vacíos.' }),
    columnas: { nombre: 'nombre', activo: 'activo', orden: 'orden', equivalencia: 'equivalencia', insumoId: 'insumo_id', cantidadInsumo: 'cantidad_insumo' },
    enUso: 'SELECT 1 FROM core.producto_presentacion WHERE presentacion_codigo = $1 UNION ALL SELECT 1 FROM core.venta_detalle WHERE presentacion_codigo = $1 LIMIT 1',
  },
  'tipos-gasto': {
    tabla: 'core.tipo_gasto',
    campos: z.object(base),
    columnas: { nombre: 'nombre', activo: 'activo', orden: 'orden' },
    enUso: 'SELECT 1 FROM core.pago_costo WHERE tipo_gasto = $1 LIMIT 1',
  },
  // Lo que el cliente elige al cerrar su pedido; cada tipo emite con su serie (Parámetros → Series).
  'comprobantes-venta': {
    tabla: 'core.tipo_comprobante_venta',
    campos: z.object({ ...base, requiereRuc: z.boolean().default(false) }),
    columnas: { nombre: 'nombre', activo: 'activo', orden: 'orden', requiereRuc: 'requiere_ruc' },
    enUso: 'SELECT 1 FROM core.pedido WHERE comprobante_tipo = $1 UNION ALL SELECT 1 FROM core.venta WHERE comprobante_tipo = $1 LIMIT 1',
  },
  // Caja grande: dónde está el dinero (efectivo en caja fuerte, cuentas bancarias, billeteras).
  'cuentas-caja': {
    tabla: 'core.cuenta_caja',
    campos: z.object({ ...base, tipo: z.enum(['EFECTIVO', 'BANCO', 'BILLETERA']),
      banco: z.string().trim().toUpperCase().max(20).nullable().default(null).transform((v) => v || null), numero: z.string().trim().max(40).default('') }),
    columnas: { nombre: 'nombre', activo: 'activo', orden: 'orden', tipo: 'tipo', banco: 'banco', numero: 'numero' },
    enUso: 'SELECT 1 FROM core.movimiento_caja WHERE cuenta = $1 UNION ALL SELECT 1 FROM core.medio_pago WHERE cuenta_caja = $1 LIMIT 1',
  },
  bancos: {
    tabla: 'core.banco',
    campos: z.object(base),
    columnas: { nombre: 'nombre', activo: 'activo', orden: 'orden' },
    enUso: 'SELECT 1 FROM core.proveedor_cuenta WHERE banco = $1 LIMIT 1',
  },
} as const;
const NUEVOS = new Set(['presentaciones-compra', 'presentaciones-venta', 'bancos']);
const NUMERICOS = new Set(['factor_a_patron', 'equivalencia', 'cantidad_insumo']);
type Catalogo = keyof typeof ESQUEMAS;

const camel = (s: string) => s.replace(/_([a-z])/g, (_, l: string) => l.toUpperCase());

/** Todas las listas, solo activas o todas (para administrarlas). */
export async function leerCatalogos(todos = false) {
  const filtro = todos ? '' : 'WHERE activo';
  const leer = async (tabla: string) => (await q<Record<string, unknown>>(`SELECT * FROM ${tabla} ${filtro} ORDER BY orden, codigo`))
    .map((f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [camel(k), NUMERICOS.has(k) && v !== null ? num(v as string) : v])));
  return {
    tiposDocumento: await leer('core.tipo_documento_compra'), mediosPago: await leer('core.medio_pago'),
    tiposInsumo: await leer('core.tipo_insumo'), unidades: await leer('core.unidad_medida'),
    presentacionesCompra: await leer('core.presentacion_compra'), presentacionesVenta: await leer('core.presentacion_venta'), tiposGasto: await leer('core.tipo_gasto'), bancos: await leer('core.banco'),
    comprobantesVenta: await leer('core.tipo_comprobante_venta'), cuentasCaja: await leer('core.cuenta_caja'),
  };
}

/* ------------------------------------------------------------ validación de operaciones */
export interface MedioPago { codigo: string; nombre: string; requiere_operacion: boolean; caja_chica: boolean; es_credito: boolean; cuenta_caja: string | null }
export type UsoMedio = 'ventas' | 'cobranza' | 'compras';

/** El medio debe existir, estar activo y estar habilitado para el proceso. */
export async function medioPago(c: PoolClient | null, cod: string, uso: UsoMedio): Promise<MedioPago> {
  const sql = `SELECT codigo, nombre, requiere_operacion, caja_chica, es_credito, cuenta_caja FROM core.medio_pago WHERE codigo = $1 AND activo AND en_${uso}`;
  const m = c ? (await c.query<MedioPago>(sql, [cod])).rows[0] : await uno<MedioPago>(sql, [cod]);
  if (!m) throw fallo(422, `El medio de pago ${cod} no existe o no está habilitado para ${uso}.`);
  return m;
}

/** n.° de operación obligatorio para los medios que lo exigen (Yape, Plin, tarjeta, transferencia…). */
export function exigirOperacion(m: MedioPago, referencia: string) {
  if (m.requiere_operacion && referencia.trim().length < 3) throw fallo(422, `Indica el número de operación del pago con ${m.nombre.toLowerCase()}.`);
}

export async function tipoDocumento(c: PoolClient, cod: string) {
  const t = (await c.query<{ nombre: string; credito_fiscal: boolean }>('SELECT nombre, credito_fiscal FROM core.tipo_documento_compra WHERE codigo = $1 AND activo', [cod])).rows[0];
  if (!t) throw fallo(422, `El tipo de documento ${cod} no existe o está inactivo.`);
  return t;
}

export async function rutasCatalogos(app: FastifyInstance) {
  // Listas activas para los formularios (cualquier usuario con sesión).
  app.get('/catalogos', { preHandler: autenticar }, async () => leerCatalogos());

  // Administración: todas las filas, también las inactivas.
  app.get('/catalogos/administrar', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'maestros.editar')) return;
    return leerCatalogos(true);
  });

  const guardar = (crear: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!exigir(req, reply, 'maestros.editar')) return;
    const { catalogo, codigo: cod } = req.params as { catalogo: string; codigo?: string };
    const def = ESQUEMAS[catalogo as Catalogo];
    if (!def) return reply.code(404).send(error(404, 'CATALOGO_NO_EXISTE', 'Ese catálogo no existe.'));
    const p = def.campos.safeParse(req.body);
    const crudo = crear ? (req.body as { codigo?: unknown } | null)?.codigo : cod;
    const c = (NUEVOS.has(catalogo) ? codigo : codigo.pipe(conLetra)).safeParse(typeof crudo === 'string' ? crudo.trim().toUpperCase() : crudo);
    if (!p.success || !c.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', (p.success ? c.error?.issues[0]?.message : p.error.issues[0]?.message) ?? 'Datos inválidos.'));
    const d = p.data as Record<string, unknown>;
    const cols = Object.entries(def.columnas) as Array<[string, string]>;
    return responder(reply, 'CATALOGO_INVALIDO', async () => {
      if (catalogo === 'medios-pago' && d.cuentaCaja && !(await uno('SELECT 1 FROM core.cuenta_caja WHERE codigo = $1 AND activo', [d.cuentaCaja]))) {
        throw fallo(422, 'La cuenta de caja grande no existe o está inactiva.');
      }
      if (catalogo === 'cuentas-caja' && d.banco && !(await uno('SELECT 1 FROM core.banco WHERE codigo = $1', [d.banco]))) throw fallo(422, 'El banco no existe.');
      if (catalogo === 'presentaciones-venta' && d.insumoId && !(await uno('SELECT 1 FROM core.insumo WHERE id = $1 AND activo', [d.insumoId]))) {
        throw fallo(422, 'El insumo a descontar no existe o está inactivo.');
      }
      // Un nombre por catálogo: dos «gramo» o dos «Paquete x 6» confunden en cada combo.
      const colNombre = catalogo === 'unidades' ? 'descripcion' : 'nombre';
      if (await uno(`SELECT 1 FROM ${def.tabla} WHERE lower(${colNombre}) = lower($1) AND codigo <> $2`, [d[colNombre], c.data])) {
        throw fallo(409, `Ya existe «${String(d[colNombre])}» en este catálogo con otro código.`);
      }
      if (!crear && catalogo === 'unidades') {
        // Familia y factor no cambian si la unidad ya se usa: el stock y las recetas quedarían en otra escala.
        const actual = await uno<{ familia: string; factor: string }>('SELECT familia, factor_a_patron factor FROM core.unidad_medida WHERE codigo = $1', [c.data]);
        if (actual && (actual.familia !== d.familia || Math.abs(num(actual.factor) - (d.factorAPatron as number)) > 1e-9)
          && await uno(def.enUso, [c.data])) throw fallo(409, 'La unidad ya se usa en insumos o recetas: su familia y su factor no se cambian.');
      }
      const r = crear
        ? await q(`INSERT INTO ${def.tabla} (codigo, ${cols.map(([, col]) => col).join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
            ON CONFLICT (codigo) DO NOTHING RETURNING codigo`, [c.data, ...cols.map(([k]) => d[k])])
        : await q(`UPDATE ${def.tabla} SET ${cols.map(([, col], i) => `${col} = $${i + 2}`).join(', ')} WHERE codigo = $1 RETURNING codigo`, [c.data, ...cols.map(([k]) => d[k])]);
      if (!r.length) throw fallo(crear ? 409 : 404, crear ? `Ya existe ${c.data} en este catálogo.` : 'El valor no existe.');
      await auditar({ ...actor(req), accion: crear ? 'CATALOGO_AGREGADO' : 'CATALOGO_EDITADO', entidad: catalogo, entidadId: c.data, detalle: d });
      return reply.code(crear ? 201 : 200).send({ codigo: c.data, ...d });
    });
  };
  // No se borran valores (están en documentos): se desactivan.
  app.post('/catalogos/:catalogo', { preHandler: autenticar }, guardar(true));
  app.patch('/catalogos/:catalogo/:codigo', { preHandler: autenticar }, guardar(false));
}
