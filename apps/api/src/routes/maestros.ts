import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { q, tx, uno, num } from '../db.js';
import { autenticar, exigir, error } from '../seguridad.js';
import { auditar } from '../auditoria.js';
import { guardarImagen } from './sistema.js';
import { invalidar } from '../cache.js';

/**
 * Maestros administrables (PDF §3.3): categorías, productos, insumos, recetas,
 * clientes y costos indirectos. Toda modificación que afecta costos llama al
 * motor (core.recalcular_costos) en la misma transacción.
 */

const texto = (min: number, max: number) => z.string().trim().min(min).max(max);
const dinero = z.number().min(0).max(1_000_000);
const pct = z.number().min(0).max(0.95);
/** Código del negocio escrito a mano (opcional): "" = lo genera el sistema. */
export const codigoPropio = z.string().trim().toUpperCase()
  .regex(/^([A-Z0-9][A-Z0-9-]{0,19})?$/, 'El código lleva hasta 20 letras, números o guiones').default('');
const sku = z.string().trim().regex(/^([A-Za-z0-9-]{3,30})?$/, 'El SKU lleva de 3 a 30 letras, números o guiones').default('');

function invalido(reply: FastifyReply, e: z.ZodError) {
  const i = e.issues[0];
  return reply.code(422).send(error(422, 'DATOS_INVALIDOS', i ? `${i.path.join('.') || 'dato'}: ${i.message}` : 'Datos inválidos.'));
}

/** Imagen del producto: data URL nueva = se guarda y reemplaza; null = se quita; la URL actual o nada = sin cambio. */
export const ImagenProducto = z.string().max(1_500_000).nullable().optional();
export async function aplicarImagen(productoId: string, imagen: string | null | undefined, usuarioId: string): Promise<void> {
  if (imagen === undefined || (imagen !== null && !imagen.startsWith('data:'))) return;
  const nueva = imagen === null ? null : await guardarImagen(imagen, usuarioId);
  const previa = await uno<{ imagen_id: string | null }>('SELECT imagen_id FROM core.producto WHERE id = $1', [productoId]);
  await q('UPDATE core.producto SET imagen_id = $2 WHERE id = $1', [productoId, nueva]);
  if (previa?.imagen_id) await q('DELETE FROM core.archivo WHERE id = $1', [previa.imagen_id]);
}
/** Error de imagen (415/413) con su código; cualquier otro sigue su curso. */
export function falloImagen(reply: FastifyReply, e: unknown) {
  const x = e as { status?: number; codigo?: string; message: string };
  if (!x.status) throw e;
  return reply.code(x.status).send(error(x.status, x.codigo ?? 'IMAGEN_INVALIDA', x.message));
}

export async function rutasMaestros(app: FastifyInstance) {
  const actor = (req: { usuario?: { id: string; nombre: string; rol: string } }) =>
    ({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol });

  /* ------------------------------------------------------------ categorías */
  // El margen objetivo se administra en Rentabilidad/Parámetros, no al crear la categoría: si no llega, nace con el margen global y al editar se conserva.
  // Código propio (Excel «INTERFACES TANTA»): se escribe o, vacío, la base asigna CAT-01, CAT-02…
  const Categoria = z.object({ nombre: texto(2, 60), margenObjetivo: pct.optional(), orden: z.number().int().min(0).max(999).nullable().default(0), codigo: codigoPropio });
  const duplicado = (reply: FastifyReply, e: unknown, que: string) => {
    if ((e as { code?: string }).code !== '23505') throw e;
    return reply.code(409).send(error(409, 'DUPLICADO', `Ya existe ${que}.`));
  };

  app.post('/categorias', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'maestros.editar')) return;
    const p = Categoria.safeParse(req.body);
    if (!p.success) return invalido(reply, p.error);
    const id = p.data.nombre.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]+/g, '_').slice(0, 30);
    if (await uno('SELECT 1 FROM core.categoria WHERE id = $1', [id])) return reply.code(409).send(error(409, 'DUPLICADO', 'Ya existe esa categoría.'));
    let codigo: string;
    try {
      codigo = (await uno<{ codigo: string }>(`INSERT INTO core.categoria (id, nombre, margen_objetivo, orden, codigo)
        VALUES ($1, $2, coalesce($3::numeric, (SELECT valor::numeric FROM core.parametro WHERE clave = 'margen_objetivo_global'), 0.45), $4, NULLIF($5,'')) RETURNING codigo`,
        [id, p.data.nombre, p.data.margenObjetivo ?? null, p.data.orden ?? 0, p.data.codigo]))!.codigo;
    } catch (e) { return duplicado(reply, e, 'una categoría con ese código'); }
    invalidar('cat:');
    await auditar({ ...actor(req), accion: 'CATEGORIA_CREADA', entidad: 'categoria', entidadId: id, detalle: { ...p.data, codigo }, ip: req.ip });
    return reply.code(201).send({ id, ...p.data, codigo });
  });

  app.patch('/categorias/:id', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'maestros.editar')) return;
    const { id } = req.params as { id: string };
    const p = Categoria.safeParse(req.body);
    if (!p.success) return invalido(reply, p.error);
    let r: Array<{ codigo: string }>;
    try {
      r = await q<{ codigo: string }>(`UPDATE core.categoria SET nombre = $2, margen_objetivo = coalesce($3::numeric, margen_objetivo), orden = $4,
        codigo = coalesce(NULLIF($5,''), codigo) WHERE id = $1 RETURNING codigo`, [id, p.data.nombre, p.data.margenObjetivo ?? null, p.data.orden ?? 0, p.data.codigo]);
    } catch (e) { return duplicado(reply, e, 'una categoría con ese código'); }
    if (!r.length) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'La categoría no existe.'));
    invalidar('cat:');
    await auditar({ ...actor(req), accion: 'CATEGORIA_EDITADA', entidad: 'categoria', entidadId: id, detalle: p.data, ip: req.ip });
    return { id, ...p.data, codigo: r[0].codigo };
  });

  // Solo se elimina una categoría sin productos (activos o no): sus ventas y recetas dependen de ella.
  app.delete('/categorias/:id', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'maestros.editar')) return;
    const { id } = req.params as { id: string };
    const uso = await uno<{ n: string; nombres: string | null }>(`SELECT count(*) n,
      (SELECT string_agg(nombre, ', ') FROM (SELECT nombre FROM core.producto WHERE categoria_id = $1 ORDER BY nombre LIMIT 5) x) nombres
      FROM core.producto WHERE categoria_id = $1`, [id]);
    const total = Number(uso?.n ?? 0);
    if (total > 0) {
      return reply.code(409).send(error(409, 'CATEGORIA_EN_USO',
        `No se puede eliminar: tiene ${total} producto(s) (${uso?.nombres}${total > 5 ? '…' : ''}). Muévelos a otra categoría o elimínalos primero.`));
    }
    const r = await q<{ nombre: string }>('DELETE FROM core.categoria WHERE id = $1 RETURNING nombre', [id]);
    if (!r.length) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'La categoría no existe.'));
    invalidar('cat:');
    await auditar({ ...actor(req), accion: 'CATEGORIA_ELIMINADA', entidad: 'categoria', entidadId: id, detalle: { nombre: r[0].nombre }, ip: req.ip });
    return reply.code(204).send();
  });

  /* ------------------------------------------------------------- productos */
  const Presentacion = z.object({
    presentacion: z.string().trim().toUpperCase().min(2).max(20), sku,
    precioConIgv: z.number().positive().max(1_000_000), activo: z.boolean().default(true),
  });
  // Datos de producción de la hoja 'pan' (MAE-03): con ellos el motor calcula unidades, MO y CIF.
  const Producto = z.object({
    nombre: texto(2, 120), categoriaId: texto(1, 40), unidad: z.string().trim().toUpperCase().max(20),
    precioConIgv: z.number().min(0).max(100_000), estado: z.enum(['ACTIVO', 'INACTIVO']),
    pesoMasaG: z.number().positive().max(100_000).nullable().optional(),
    anticipacionHoras: z.number().int().min(0).max(720).nullable().optional(),
    perdidaCoccion: pct.nullable().optional(), horasHombreLote: z.number().min(0).max(100).nullable().optional(), horasHornoLote: z.number().min(0).max(100).nullable().optional(),
    imagenUrl: ImagenProducto,
    // Código propio del negocio (opcional): si no se escribe, el sistema lo genera (P001, P002…).
    codigo: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,20}$/, 'El código lleva de 2 a 20 letras, números o guiones').optional().or(z.literal('')),
    // Peso del pan al salir del horno (g): con el peso crudo el sistema calcula la pérdida por cocción.
    pesoFinalG: z.number().positive().max(100_000).nullable().optional(),
    // Panes que entran al horno en un lote (bandeja): reparte las horas de horno y de mano de obra.
    unidadesLote: z.number().int().positive().max(100_000).nullable().optional(),
    // Días que el pan se puede vender desde que sale del horno: fija el vencimiento de cada horneada.
    vidaUtilDias: z.number().int().min(0).max(3650).nullable().optional(),
    // MAE-06: insumo que produce este producto (sub-receta). "" o null = producto de venta normal.
    insumoId: z.union([z.literal(''), z.string().uuid()]).nullable().optional(),
    // SKU #1: código de barras de la presentación unitaria (la del precio del producto).
    sku: sku.optional(),
    // SKU #2…: otras presentaciones de venta (paquete x 6…) con su SKU y su precio. Ausente = no se tocan.
    presentaciones: z.array(Presentacion).max(20).optional(),
  });

  /** Valida y reemplaza las presentaciones del producto; el SKU no se repite en ningún producto ni presentación. */
  async function guardarPresentaciones(c: import('../db.js').Cliente, productoId: string, skuUnitario: string | undefined,
    lista: Array<z.infer<typeof Presentacion>> | undefined) {
    const codigos = (lista ?? []).map((x) => x.presentacion);
    if (new Set(codigos).size !== codigos.length) throw fallo(422, 'Una presentación aparece dos veces.');
    const skus = [...(skuUnitario ? [skuUnitario] : []), ...(lista ?? []).map((x) => x.sku).filter(Boolean)];
    if (new Set(skus.map((s) => s.toUpperCase())).size !== skus.length) throw fallo(422, 'Un SKU se repite en este producto.');
    if (skus.length) {
      const ajeno = (await c.query<{ sku: string; nombre: string }>(`SELECT x.sku, p.nombre FROM (
          SELECT sku, id producto_id FROM core.producto WHERE sku IS NOT NULL
          UNION ALL SELECT sku, producto_id FROM core.producto_presentacion WHERE sku IS NOT NULL) x
        JOIN core.producto p ON p.id = x.producto_id WHERE upper(x.sku) = ANY($1) AND x.producto_id <> $2 LIMIT 1`,
        [skus.map((s) => s.toUpperCase()), productoId])).rows[0];
      if (ajeno) throw fallo(409, `El SKU ${ajeno.sku} ya lo usa «${ajeno.nombre}».`);
    }
    if (skuUnitario !== undefined) await c.query('UPDATE core.producto SET sku = NULLIF($2,\'\') WHERE id = $1', [productoId, skuUnitario]);
    if (lista === undefined) return;
    if (codigos.length) {
      const ok = (await c.query<{ codigo: string; equivalencia: string }>('SELECT codigo, equivalencia FROM core.presentacion_venta WHERE codigo = ANY($1) AND activo', [codigos])).rows;
      const falta = codigos.find((k) => !ok.some((o) => o.codigo === k));
      if (falta) throw fallo(422, `La presentación ${falta} no existe o está inactiva (Maestros → Catálogos → Presentaciones de venta).`);
    }
    await c.query('DELETE FROM core.producto_presentacion WHERE producto_id = $1', [productoId]);
    for (const [i, x] of lista.entries()) {
      await c.query(`INSERT INTO core.producto_presentacion (producto_id, presentacion_codigo, sku, precio_con_igv, activo, orden)
        VALUES ($1,$2,NULLIF($3,''),$4,$5,$6)`, [productoId, x.presentacion, x.sku, x.precioConIgv.toFixed(4), x.activo, i + 1]);
    }
  }
  const fallo = (status: number, mensaje: string) => Object.assign(new Error(mensaje), { status });
  const responderFallo = (reply: FastifyReply, e: unknown, codigo: string) => {
    const x = e as { status?: number; code?: string; message: string };
    if (x.code === '23505') return reply.code(409).send(error(409, 'DUPLICADO', 'Ya existe un registro con ese código o SKU.'));
    if (!x.status) throw e;
    return reply.code(x.status).send(error(x.status, codigo, x.message));
  };

  // Anular (inactivar) o reactivar: el producto con ventas no se borra; inactivo no se vende ni sale en el catálogo.
  app.patch('/productos/:id/estado', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'maestros.editar')) return;
    const { id } = req.params as { id: string };
    const p = z.object({ estado: z.enum(['ACTIVO', 'INACTIVO']) }).safeParse(req.body);
    if (!p.success || !z.string().uuid().safeParse(id).success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Estado inválido.'));
    const r = await q<{ nombre: string }>('UPDATE core.producto SET estado = $2 WHERE id = $1 RETURNING nombre', [id, p.data.estado]);
    if (!r.length) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'El producto no existe.'));
    invalidar('cat:');
    await auditar({ ...actor(req), accion: p.data.estado === 'INACTIVO' ? 'PRODUCTO_ANULADO' : 'PRODUCTO_REACTIVADO', entidad: 'producto', entidadId: id, detalle: { nombre: r[0].nombre }, ip: req.ip });
    return { id, estado: p.data.estado };
  });

  // «Ajustar precio» (Excel): precio de la unidad y de cada presentación, con la ficha de costo a la vista.
  app.patch('/productos/:id/precios', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'maestros.editar')) return;
    const { id } = req.params as { id: string };
    const p = z.object({
      precioConIgv: z.number().positive().max(100_000),
      presentaciones: z.array(z.object({ presentacion: z.string().trim().toUpperCase().max(20), precioConIgv: z.number().positive().max(1_000_000) })).max(20).default([]),
    }).safeParse(req.body);
    if (!p.success || !z.string().uuid().safeParse(id).success) return invalido(reply, p.error ?? new z.ZodError([]));
    try {
      const antes = await tx(async (c) => {
        const prod = (await c.query<{ precio_con_igv: string; insumo_id: string | null }>('SELECT precio_con_igv, insumo_id FROM core.producto WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!prod) throw fallo(404, 'El producto no existe.');
        if (prod.insumo_id) throw fallo(422, 'Un producto intermedio (sub-receta) no se vende: no tiene precio.');
        await c.query('UPDATE core.producto SET precio_con_igv = $2 WHERE id = $1', [id, p.data.precioConIgv.toFixed(4)]);
        for (const x of p.data.presentaciones) {
          const r = await c.query('UPDATE core.producto_presentacion SET precio_con_igv = $3 WHERE producto_id = $1 AND presentacion_codigo = $2', [id, x.presentacion, x.precioConIgv.toFixed(4)]);
          if (!r.rowCount) throw fallo(422, `El producto no tiene la presentación ${x.presentacion}.`);
        }
        return num(prod.precio_con_igv);
      });
      invalidar('cat:');
      await auditar({ ...actor(req), accion: 'PRECIO_AJUSTADO', entidad: 'producto', entidadId: id, detalle: { antes, despues: p.data }, ip: req.ip });
      return { id, ...p.data };
    } catch (e) { return responderFallo(reply, e, 'PRECIO_INVALIDO'); }
  });

  app.patch('/productos/:id', { preHandler: autenticar, bodyLimit: 2_000_000 }, async (req, reply) => {
    if (!exigir(req, reply, 'maestros.editar')) return;
    const { id } = req.params as { id: string };
    const p = Producto.safeParse(req.body);
    if (!p.success) return invalido(reply, p.error);
    const antes = await uno<Record<string, string>>('SELECT nombre, precio_con_igv, estado FROM core.producto WHERE id = $1', [id]);
    // Unidad de venta del catálogo de unidades (Maestros → Catálogos).
    if (!(await uno('SELECT 1 FROM core.unidad_medida WHERE codigo = $1 AND activo', [p.data.unidad]))) return reply.code(422).send(error(422, 'UNIDAD_INVALIDA', `La unidad ${p.data.unidad} no existe o está inactiva.`));
    if (!antes) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'El producto no existe.'));
    if (!(await uno('SELECT 1 FROM core.categoria WHERE id = $1', [p.data.categoriaId]))) return reply.code(422).send(error(422, 'CATEGORIA_INEXISTENTE', 'La categoría no existe.'));
    const insumoId = p.data.insumoId === undefined ? undefined : (p.data.insumoId || null);
    if (insumoId) {
      // La unidad del intermedio debe ser la del stock del insumo: 1 unidad producida = 1 unidad de inventario.
      const ins = await uno<{ unidad_inventario: string; nombre: string }>('SELECT unidad_inventario, nombre FROM core.insumo WHERE id = $1', [insumoId]);
      if (!ins) return reply.code(422).send(error(422, 'INSUMO_INEXISTENTE', 'El insumo no existe.'));
      if (ins.unidad_inventario !== p.data.unidad) return reply.code(422).send(error(422, 'UNIDAD_DISTINTA', `El producto debe venderse en ${ins.unidad_inventario}, la unidad de stock de «${ins.nombre}».`));
      if (await uno('SELECT 1 FROM core.producto WHERE insumo_id = $1 AND id <> $2', [insumoId, id])) return reply.code(409).send(error(409, 'INSUMO_YA_PRODUCIDO', 'Otro producto ya produce ese insumo.'));
      if (await uno('SELECT 1 FROM core.receta_detalle d JOIN core.receta r ON r.id = d.receta_id WHERE r.producto_id = $1 AND d.insumo_id = $2', [id, insumoId])) return reply.code(422).send(error(422, 'CICLO', 'La receta de este producto usa ese mismo insumo.'));
    }
    if (p.data.pesoFinalG && p.data.pesoMasaG && p.data.pesoFinalG > p.data.pesoMasaG) {
      return reply.code(422).send(error(422, 'PESO_FINAL_MAYOR', 'pesoFinalG: el peso al salir del horno no puede ser mayor que el de la masa cruda.'));
    }
    const codigo = p.data.codigo || undefined;
    if (codigo && await uno('SELECT 1 FROM core.producto WHERE upper(codigo) = $1 AND id <> $2', [codigo, id])) {
      return reply.code(409).send(error(409, 'CODIGO_DUPLICADO', `El código ${codigo} ya lo usa otro producto.`));
    }
    // Pérdida por cocción = 1 − peso final ÷ peso crudo (se mide, no se adivina el %).
    const perdida = p.data.pesoFinalG && p.data.pesoMasaG ? 1 - p.data.pesoFinalG / p.data.pesoMasaG : p.data.perdidaCoccion ?? null;
    // Solo un intermedio (no se vende) puede quedar sin precio.
    const intermedio = insumoId !== undefined ? insumoId !== null : Boolean(await uno('SELECT 1 FROM core.producto WHERE id = $1 AND insumo_id IS NOT NULL', [id]));
    if (!intermedio && p.data.precioConIgv <= 0) return reply.code(422).send(error(422, 'PRECIO_INVALIDO', 'precioConIgv: el precio debe ser mayor que cero.'));
    // La imagen primero: si es inválida (415/413) no se guarda nada a medias.
    try { await aplicarImagen(id, p.data.imagenUrl, req.usuario!.id); } catch (e) { return falloImagen(reply, e); }
    try { await tx(async (c) => {
      await guardarPresentaciones(c, id, p.data.sku, p.data.presentaciones);
      await c.query(`UPDATE core.producto SET nombre=$2, categoria_id=$3, unidad=$4, precio_con_igv=$5, estado=$6,
          peso_masa_g = CASE WHEN $7::boolean THEN $8::numeric ELSE peso_masa_g END,
          perdida_coccion = coalesce($9::numeric, perdida_coccion),
          horas_hombre_lote = coalesce($10::numeric, horas_hombre_lote), horas_horno_lote = coalesce($11::numeric, horas_horno_lote),
          anticipacion_horas = coalesce($12::int, anticipacion_horas),
          insumo_id = CASE WHEN $13::boolean THEN $14::uuid ELSE insumo_id END,
          peso_final_g = CASE WHEN $15::boolean THEN $16::numeric ELSE peso_final_g END,
          unidades_lote = CASE WHEN $17::boolean THEN $18::int ELSE unidades_lote END,
          codigo = coalesce($19, codigo),
          vida_util_dias = CASE WHEN $20::boolean THEN $21::int ELSE vida_util_dias END
        WHERE id=$1`,
        [id, p.data.nombre, p.data.categoriaId, p.data.unidad, p.data.precioConIgv.toFixed(4), p.data.estado,
          p.data.pesoMasaG !== undefined, p.data.pesoMasaG ?? null, perdida, p.data.horasHombreLote ?? null, p.data.horasHornoLote ?? null, p.data.anticipacionHoras ?? null, insumoId !== undefined, insumoId ?? null,
          p.data.pesoFinalG !== undefined, p.data.pesoFinalG ?? null, p.data.unidadesLote !== undefined, p.data.unidadesLote ?? null, codigo ?? null, p.data.vidaUtilDias !== undefined, p.data.vidaUtilDias ?? null]);
      await c.query('SELECT core.recalcular_costos()');
    }); } catch (e) { return responderFallo(reply, e, 'PRODUCTO_INVALIDO'); }
    invalidar('cat:'); // el catálogo (web y app) ve el cambio al instante, no tras el TTL
    const { imagenUrl: _imagen, ...cambios } = p.data;
    await auditar({ ...actor(req), accion: 'PRODUCTO_EDITADO', entidad: 'producto', entidadId: id,
      detalle: { antes: { nombre: antes.nombre, precio: num(antes.precio_con_igv), estado: antes.estado }, despues: cambios }, ip: req.ip });
    return { id, ...cambios };
  });

  /* --------------------------------------------------------------- insumos */
  // Hoja 'insumos' (MAE-01): tipo, presentación de compra y equivalente en kg.
  const Insumo = z.object({
    nombre: texto(2, 120), unidad: z.string().trim().toUpperCase().max(20), minimo: dinero,
    // Unidad en la que se lleva el stock; por defecto, la unidad base.
    unidadInventario: z.string().trim().toUpperCase().max(20).optional(), proveedor: z.string().trim().max(120), activo: z.boolean().default(true),
    tipo: z.string().trim().toUpperCase().max(20).default('OTRO'),
    presentacion: z.string().trim().max(60).default(''),
    precioCompra: z.number().min(0).max(1_000_000).nullable().default(null),
    cantPresentacion: z.number().positive().max(1_000_000).nullable().default(null),
    // Densidad (kg por unidad base): obligatoria si la unidad de inventario es de otra familia (RN-03).
    equivKg: z.number().positive().max(1000).nullable().default(null),
    // Excel: código propio (HAR-01) o automático (INS-001), presentación del catálogo y si se controla su stock.
    codigo: codigoPropio,
    presentacionCodigo: z.string().trim().toUpperCase().max(20).nullable().default(null).transform((v) => v || null),
    // «Maneja stock = N»: insumos menores (p. ej. agua) que no se cuentan: sin alertas de mínimo ni bloqueo por falta de stock.
    manejaStock: z.boolean().default(true),
  });
  type DatosInsumo = z.infer<typeof Insumo>;
  /** Presentación de compra del catálogo: su nombre queda en el insumo y su equivalencia es el contenido por defecto. */
  const conPresentacion = async (d: DatosInsumo): Promise<DatosInsumo | { error: string }> => {
    // Con precio hace falta saber cuánto trae la presentación (la escrita o la del catálogo).
    const sinCantidad = { error: 'cantPresentacion: Indica la cantidad por presentación' };
    if (!d.presentacionCodigo) return d.precioCompra !== null && d.cantPresentacion === null ? sinCantidad : d;
    const pr = await uno<{ nombre: string; equivalencia: string }>('SELECT nombre, equivalencia FROM core.presentacion_compra WHERE codigo = $1 AND activo', [d.presentacionCodigo]);
    if (!pr) return { error: `La presentación ${d.presentacionCodigo} no existe o está inactiva.` };
    return { ...d, presentacion: pr.nombre, cantPresentacion: d.cantPresentacion ?? num(pr.equivalencia) };
  };
  const codigoInsumoLibre = async (codigo: string, id: string | null) =>
    !codigo || !(await uno('SELECT 1 FROM core.insumo WHERE upper(codigo) = $1 AND id IS DISTINCT FROM $2', [codigo, id]));
  // RN-01: costo por unidad base = precio ÷ cantidad por presentación. Solo fija el costo mientras
  // no haya compras: después manda el costo promedio ponderado del kárdex (RN-02).
  const costoReferencia = (d: { precioCompra: number | null; cantPresentacion: number | null }) =>
    d.precioCompra !== null && d.cantPresentacion ? d.precioCompra / d.cantPresentacion : null;
  // Insumos: Administración (maestros.editar) y Compras (insumos.gestionar), sección 7 del informe de compras.
  const editaInsumos = (req: FastifyRequest, reply: FastifyReply) => {
    if (req.usuario!.permisos.has('maestros.editar') || req.usuario!.permisos.has('insumos.gestionar')) return true;
    void reply.code(403).send(error(403, 'SIN_PERMISO', 'Falta el permiso insumos.gestionar.'));
    return false;
  };
  // RN-03 con el servicio único de conversión de la base: misma familia → factor por unidades; volumen o conteo
  // a masa → la densidad, que entonces es obligatoria. El costo de referencia pasa a unidad de inventario (F3).
  const unidades = async (d: { unidad: string; unidadInventario?: string; equivKg: number | null; tipo: string }):
    Promise<{ error: string } | { unidadInventario: string; densidad: number; factor: number }> => {
    const unidadInventario = d.unidadInventario ?? d.unidad;
    if (!(await uno('SELECT 1 FROM core.tipo_insumo WHERE codigo = $1 AND activo', [d.tipo]))) return { error: `El tipo de insumo ${d.tipo} no existe o está inactivo.` };
    const fam = await q<{ codigo: string; familia: string }>('SELECT codigo, familia FROM core.unidad_medida WHERE codigo = ANY($1) AND activo', [[d.unidad, unidadInventario]]);
    if (!fam.some((x) => x.codigo === d.unidad) || !fam.some((x) => x.codigo === unidadInventario)) return { error: 'Unidad inexistente o inactiva en el catálogo de unidades.' };
    const misma = fam.find((x) => x.codigo === d.unidad)?.familia === fam.find((x) => x.codigo === unidadInventario)?.familia;
    if (!misma && d.equivKg === null) return { error: `Para llevar el stock en ${unidadInventario} comprando en ${d.unidad} indica la densidad (${unidadInventario === 'KG' ? 'kg' : unidadInventario} por ${d.unidad}).` };
    const densidad = d.equivKg ?? 1;
    const factor = num((await uno<{ f: string | null }>('SELECT core.factor_unidades($1, $2, $3) f', [d.unidad, unidadInventario, densidad]))?.f ?? '0');
    if (!(factor > 0)) return { error: `No hay conversión de ${d.unidad} a ${unidadInventario}.` };
    return { unidadInventario, densidad, factor };
  };

  /** Alta de un insumo ya validado (formulario e importación comparten la misma escritura). */
  const insertarInsumo = (d: DatosInsumo, u: { densidad: number; unidadInventario: string; factor: number }) => uno<{ id: string; codigo: string }>(
    `INSERT INTO core.insumo (codigo, nombre, unidad, minimo, proveedor, cpp, stock, tipo, presentacion, precio_compra, cant_presentacion, equiv_kg, unidad_inventario,
                              maneja_stock, presentacion_codigo)
     VALUES (coalesce(NULLIF($13,''), 'INS-' || lpad((SELECT coalesce(max(substring(codigo from 5)::int), 0) + 1 FROM core.insumo WHERE codigo ~ '^INS-[0-9]+$')::text, 3, '0')),
             $1, $2, $3, $4, coalesce($9::numeric / $12::numeric, 0), 0, $5, $6, $7, $8, $10, $11, $14, $15) RETURNING id, codigo`,
    [d.nombre, d.unidad, d.minimo, d.proveedor, d.tipo, d.presentacion, d.precioCompra, d.cantPresentacion, costoReferencia(d),
      u.densidad, u.unidadInventario, u.factor, d.codigo, d.manejaStock, d.presentacionCodigo]);

  app.post('/insumos', { preHandler: autenticar }, async (req, reply) => {
    if (!editaInsumos(req, reply)) return;
    const p = Insumo.safeParse(req.body);
    if (!p.success) return invalido(reply, p.error);
    const d = await conPresentacion(p.data);
    if ('error' in d) return reply.code(422).send(error(422, 'PRESENTACION_INVALIDA', d.error));
    if (!(await codigoInsumoLibre(d.codigo, null))) return reply.code(409).send(error(409, 'CODIGO_DUPLICADO', `El código ${d.codigo} ya lo usa otro insumo.`));
    const u = await unidades(d);
    if ('error' in u) return reply.code(422).send(error(422, 'SIN_DENSIDAD', u.error));
    // El costo inicial entra con la primera compra (Almacén → Registrar movimiento), que fija el CPP.
    const f = await insertarInsumo(d, u);
    invalidar('cat:');
    await auditar({ ...actor(req), accion: 'INSUMO_CREADO', entidad: 'insumo', entidadId: f!.id, detalle: d, ip: req.ip });
    return reply.code(201).send({ ...d, ...f });
  });

  // Anular (inactivar) o reactivar el insumo; en una receta vigente no se inactiva.
  app.patch('/insumos/:id/estado', { preHandler: autenticar }, async (req, reply) => {
    if (!editaInsumos(req, reply)) return;
    const { id } = req.params as { id: string };
    const p = z.object({ activo: z.boolean() }).safeParse(req.body);
    if (!p.success || !z.string().uuid().safeParse(id).success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Estado inválido.'));
    if (!p.data.activo && await uno("SELECT 1 FROM core.receta_detalle d JOIN core.receta r ON r.id = d.receta_id WHERE d.insumo_id = $1 AND r.estado = 'VIGENTE'", [id])) {
      return reply.code(409).send(error(409, 'INSUMO_EN_USO', 'El insumo está en una receta vigente: quítalo de la receta antes de anularlo.'));
    }
    const r = await q<{ nombre: string }>('UPDATE core.insumo SET activo = $2, actualizado_en = now() WHERE id = $1 RETURNING nombre', [id, p.data.activo]);
    if (!r.length) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'El insumo no existe.'));
    invalidar('cat:');
    await auditar({ ...actor(req), accion: p.data.activo ? 'INSUMO_REACTIVADO' : 'INSUMO_ANULADO', entidad: 'insumo', entidadId: id, detalle: { nombre: r[0].nombre }, ip: req.ip });
    return { id, activo: p.data.activo };
  });

  /**
   * «Ajustar costos» (Excel): últimas 20 compras del insumo, el costo que usan las fórmulas y el de las compras.
   * Todos los costos van por unidad de inventario (kg, L, unidad) y sin IGV cuando la factura da crédito fiscal.
   */
  app.get('/insumos/:id/costos', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'costos.ver')) return;
    const { id } = req.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Insumo inválido.'));
    const ins = await uno<Record<string, string | null>>(`SELECT i.id, i.codigo, i.nombre, i.unidad_inventario, i.cpp, i.costo_formula, i.costo_formula_en::text costo_formula_en,
        u.nombre costo_formula_por FROM core.insumo i LEFT JOIN core.usuario u ON u.id = i.costo_formula_por WHERE i.id = $1`, [id]);
    if (!ins) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'El insumo no existe.'));
    const compras = await q<Record<string, string>>(`
      SELECT c.codigo, c.fecha_compra::text fecha, p.razon_social proveedor, c.estado, d.cantidad_presentacion, coalesce(i.presentacion, '') presentacion,
             d.cantidad_inventario, d.costo_unitario_inventario, d.precio_lote
      FROM core.compra_detalle d JOIN core.compra c ON c.id = d.compra_id JOIN core.proveedor p ON p.id = c.proveedor_id JOIN core.insumo i ON i.id = d.insumo_id
      WHERE d.insumo_id = $1 AND c.estado <> 'ANULADA' ORDER BY c.fecha_compra DESC, c.creado_en DESC LIMIT 20`, [id]);
    const lista = compras.map((f) => ({ codigo: f.codigo, fecha: f.fecha, proveedor: f.proveedor, estado: f.estado, cantidad: num(f.cantidad_presentacion),
      presentacion: f.presentacion, cantidadInventario: num(f.cantidad_inventario), costoUnitario: num(f.costo_unitario_inventario), subtotal: num(f.precio_lote) }));
    const metodo = (await uno<{ valor: string }>("SELECT upper(valor) valor FROM core.parametro WHERE clave = 'costo_insumo_formulas'"))?.valor ?? 'MANUAL';
    return {
      id: ins.id, codigo: ins.codigo, nombre: ins.nombre, unidad: ins.unidad_inventario, metodo,
      costoFormulas: num(ins.costo_formula ?? ins.cpp ?? '0'), costoKardex: num(ins.cpp ?? '0'), manual: ins.costo_formula !== null,
      actualizadoEn: ins.costo_formula_en, actualizadoPor: ins.costo_formula_por,
      // Excel: «P compra anterior» y «P compra actual» = las dos últimas compras.
      precioAnterior: lista[1]?.costoUnitario ?? null, precioActual: lista[0]?.costoUnitario ?? null, compras: lista,
    };
  });

  // «ACTUALIZAR»: fija a mano el costo con que las fórmulas calculan el precio (se sugiere manual). Recostea al instante.
  app.post('/insumos/:id/costo', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'costos.ver') || !editaInsumos(req, reply)) return;
    const { id } = req.params as { id: string };
    const p = z.object({ costo: z.number().min(0).max(1_000_000) }).safeParse(req.body);
    if (!p.success || !z.string().uuid().safeParse(id).success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Indica el costo (S/ por unidad de inventario).'));
    const r = await tx(async (c) => {
      const i = (await c.query<{ nombre: string; antes: string }>('SELECT nombre, coalesce(costo_formula, cpp) antes FROM core.insumo WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!i) return null;
      await c.query('UPDATE core.insumo SET costo_formula = $2, costo_formula_en = now(), costo_formula_por = $3 WHERE id = $1', [id, p.data.costo.toFixed(6), req.usuario!.id]);
      await c.query('INSERT INTO core.ajuste_costo_insumo (insumo_id, costo_antes, costo_nuevo, usuario_id) VALUES ($1,$2,$3,$4)', [id, i.antes, p.data.costo.toFixed(6), req.usuario!.id]);
      await c.query('SELECT core.recalcular_costos()');
      return { nombre: i.nombre, antes: num(i.antes) };
    });
    if (!r) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'El insumo no existe.'));
    invalidar('cat:');
    await auditar({ ...actor(req), accion: 'COSTO_INSUMO_AJUSTADO', entidad: 'insumo', entidadId: id, detalle: { insumo: r.nombre, antes: r.antes, despues: p.data.costo }, ip: req.ip });
    return { id, costoFormulas: p.data.costo, antes: r.antes };
  });

  /**
   * «Informe insumos para corregir costo» (Excel): solo los insumos cuyo costo de fórmulas difiere del de las
   * compras (kárdex) más que el umbral de Parámetros. Costo sugerido = costo del kárdex (promedio o último, según Parámetros).
   */
  app.get('/insumos/variacion-costos', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'costos.ver')) return;
    const filas = await q<Record<string, string>>(`
      SELECT i.id, i.codigo, i.nombre, i.unidad_inventario, i.costo_formula actual, i.cpp sugerido, i.costo_formula_en::text actualizado_en,
             (SELECT max(c.fecha_compra)::text FROM core.compra_detalle d JOIN core.compra c ON c.id = d.compra_id WHERE d.insumo_id = i.id AND c.estado = 'VERIFICADA') ultima_compra
      FROM core.insumo i
      WHERE i.activo AND i.costo_formula IS NOT NULL AND i.cpp > 0
        AND abs(i.cpp - i.costo_formula) > greatest(i.costo_formula, 0.000001) * coalesce((SELECT valor::numeric FROM core.parametro WHERE clave = 'umbral_variacion_costo'), 0)
      ORDER BY abs(i.cpp - i.costo_formula) / greatest(i.costo_formula, 0.000001) DESC`);
    return filas.map((f) => {
      const actual = num(f.actual), sugerido = num(f.sugerido);
      return { id: f.id, codigo: f.codigo, nombre: f.nombre, unidad: f.unidad_inventario, costoActual: actual, costoSugerido: sugerido,
        variacion: actual > 0 ? (sugerido - actual) / actual : null, actualizadoEn: f.actualizado_en, ultimaCompra: f.ultima_compra };
    });
  });

  /**
   * MAE-02 / RN-40: carga masiva de insumos desde la plantilla (Lista_de_Insumos). Cada fila se valida
   * igual que el alta individual; las filas con error vuelven con su motivo y NO impiden cargar las
   * válidas. No se duplican insumos: un nombre que ya existe se informa y se salta.
   */
  app.post('/insumos/importar', { preHandler: autenticar, bodyLimit: 2_000_000 }, async (req, reply) => {
    if (!editaInsumos(req, reply)) return;
    const filas = z.object({ filas: z.array(z.record(z.string(), z.unknown())).min(1).max(1000) }).safeParse(req.body);
    if (!filas.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Envía entre 1 y 1000 filas.'));
    const creados: Array<{ fila: number; codigo: string; nombre: string }> = [];
    const errores: Array<{ fila: number; nombre: string; motivo: string }> = [];
    const vistos = new Set<string>();
    for (const [i, crudo] of filas.data.filas.entries()) {
      const fila = i + 2; // fila 1 = encabezados de la plantilla
      const nombre = String(crudo.nombre ?? '').trim();
      const p = Insumo.safeParse(crudo);
      if (!p.success) { const x = p.error.issues[0]; errores.push({ fila, nombre, motivo: `${x?.path.join('.') || 'dato'}: ${x?.message}` }); continue; }
      const clave = p.data.nombre.toLowerCase();
      if (vistos.has(clave) || await uno('SELECT 1 FROM core.insumo WHERE lower(nombre) = $1', [clave])) { errores.push({ fila, nombre, motivo: 'Ya existe un insumo con ese nombre.' }); continue; }
      const d = await conPresentacion(p.data);
      if ('error' in d) { errores.push({ fila, nombre, motivo: d.error }); continue; }
      if (!(await codigoInsumoLibre(d.codigo, null))) { errores.push({ fila, nombre, motivo: `El código ${d.codigo} ya lo usa otro insumo.` }); continue; }
      const u = await unidades(d);
      if ('error' in u) { errores.push({ fila, nombre, motivo: u.error }); continue; }
      const f = await insertarInsumo(d, u);
      vistos.add(clave);
      creados.push({ fila, codigo: f!.codigo, nombre: p.data.nombre });
    }
    if (creados.length) invalidar('cat:');
    await auditar({ ...actor(req), accion: 'INSUMOS_IMPORTADOS', entidad: 'insumo', detalle: { creados: creados.length, errores: errores.length }, ip: req.ip });
    return { creados, errores };
  });

  /**
   * AIN-09 / RN-40: inventario inicial valorizado de insumos y productos terminados. Cada ítem genera un
   * movimiento «Saldo inicial» (APERTURA) que fija stock y costo. Solo para ítems SIN movimientos: después
   * el stock se mueve con compras, producción, ventas y conteos (no se reescribe el kárdex).
   */
  app.post('/inventario/inicial', { preHandler: autenticar, bodyLimit: 1_000_000 }, async (req, reply) => {
    const p0 = req.usuario!.permisos;
    if (!p0.has('maestros.editar') && !p0.has('inventario.mover')) return reply.code(403).send(error(403, 'SIN_PERMISO', 'Falta el permiso inventario.mover.'));
    const Fila = z.object({
      tipo: z.enum(['INSUMO', 'PRODUCTO']), codigo: z.string().trim().min(1).max(40),
      cantidad: z.number().positive().max(10_000_000), costoUnitario: z.number().min(0).max(1_000_000),
      lote: z.string().trim().max(40).optional(), venceEn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    });
    const cuerpo = z.object({ filas: z.array(z.unknown()).min(1).max(1000) }).safeParse(req.body);
    if (!cuerpo.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Envía entre 1 y 1000 filas.'));
    const aplicados: Array<{ fila: number; codigo: string }> = [];
    const errores: Array<{ fila: number; codigo: string; motivo: string }> = [];
    for (const [i, crudo] of cuerpo.data.filas.entries()) {
      const fila = i + 2;
      const p = Fila.safeParse(crudo);
      const codigo = String((crudo as { codigo?: unknown })?.codigo ?? '');
      if (!p.success) { const x = p.error.issues[0]; errores.push({ fila, codigo, motivo: `${x?.path.join('.') || 'dato'}: ${x?.message}` }); continue; }
      const d = p.data;
      try {
        await tx(async (c) => {
          const esInsumo = d.tipo === 'INSUMO';
          const it = (await c.query<{ id: string }>(
            esInsumo ? 'SELECT id FROM core.insumo WHERE upper(codigo) = upper($1) FOR UPDATE' : 'SELECT id FROM core.producto WHERE upper(codigo) = upper($1) FOR UPDATE', [d.codigo])).rows[0];
          if (!it) throw Object.assign(new Error(`No existe el ${esInsumo ? 'insumo' : 'producto'} ${d.codigo}.`), { status: 422 });
          const conMov = (await c.query(`SELECT 1 FROM core.movimiento_inventario WHERE ${esInsumo ? 'insumo_id' : 'producto_id'} = $1 LIMIT 1`, [it.id])).rowCount;
          if (conMov) throw Object.assign(new Error('Ya tiene movimientos: el saldo inicial solo se carga una vez (usa un conteo para ajustar).'), { status: 409 });
          const valor = d.cantidad * d.costoUnitario;
          await c.query(`INSERT INTO core.movimiento_inventario
              (tipo,item_tipo,${esInsumo ? 'insumo_id' : 'producto_id'},documento,cantidad,costo_unitario,valor,saldo_cantidad,saldo_valor,cpp,registrado_por,lote,vence_en)
            VALUES ('APERTURA',$1,$2,'Saldo inicial',$3,$4,$5,$3,$5,$4,$6,$7,$8)`,
            [d.tipo, it.id, d.cantidad.toFixed(6), d.costoUnitario.toFixed(6), valor.toFixed(4), req.usuario!.id, d.lote ?? null, d.venceEn ?? null]);
          if (esInsumo) await c.query('UPDATE core.insumo SET stock = $2, cpp = $3, actualizado_en = now() WHERE id = $1', [it.id, d.cantidad.toFixed(6), d.costoUnitario.toFixed(6)]);
          else await c.query('UPDATE core.producto SET stock = $2 WHERE id = $1', [it.id, d.cantidad.toFixed(6)]);
        });
        aplicados.push({ fila, codigo: d.codigo });
      } catch (e) {
        const x = e as Error & { status?: number };
        if (!x.status) throw e;
        errores.push({ fila, codigo: d.codigo, motivo: x.message });
      }
    }
    if (aplicados.length) { await q('SELECT core.recalcular_costos()'); invalidar('cat:'); }
    await auditar({ ...actor(req), accion: 'INVENTARIO_INICIAL', entidad: 'inventario', detalle: { aplicados: aplicados.length, errores: errores.length }, ip: req.ip });
    return { aplicados, errores };
  });

  app.patch('/insumos/:id', { preHandler: autenticar }, async (req, reply) => {
    if (!editaInsumos(req, reply)) return;
    const { id } = req.params as { id: string };
    const p0 = Insumo.safeParse(req.body);
    if (!p0.success) return invalido(reply, p0.error);
    const d0 = await conPresentacion(p0.data);
    if ('error' in d0) return reply.code(422).send(error(422, 'PRESENTACION_INVALIDA', d0.error));
    if (!(await codigoInsumoLibre(d0.codigo, id))) return reply.code(409).send(error(409, 'CODIGO_DUPLICADO', `El código ${d0.codigo} ya lo usa otro insumo.`));
    const p = { data: d0 };
    const u = await unidades(p.data);
    if ('error' in u) return reply.code(422).send(error(422, 'SIN_DENSIDAD', u.error));
    // La unidad del stock no cambia con stock o movimientos: el kárdex quedaría en dos unidades.
    const actual = await uno<{ unidad: string; unidad_inventario: string; con_mov: boolean }>(`SELECT unidad, unidad_inventario,
      stock <> 0 OR EXISTS (SELECT 1 FROM core.movimiento_inventario m WHERE m.insumo_id = i.id) con_mov FROM core.insumo i WHERE id = $1`, [id]);
    if (actual?.con_mov && (actual.unidad !== p.data.unidad || actual.unidad_inventario !== u.unidadInventario)) {
      return reply.code(409).send(error(409, 'UNIDAD_CON_MOVIMIENTOS', 'El insumo ya tiene stock o movimientos: su unidad base y su unidad de inventario no se cambian. Crea un insumo nuevo.'));
    }
    if (!p.data.activo && await uno("SELECT 1 FROM core.receta_detalle d JOIN core.receta r ON r.id = d.receta_id WHERE d.insumo_id = $1 AND r.estado = 'VIGENTE'", [id])) {
      return reply.code(409).send(error(409, 'INSUMO_EN_USO', 'El insumo está en una receta vigente: quítalo de la receta antes de desactivarlo.'));
    }
    const r = await tx(async (c) => {
      const f = await c.query(`UPDATE core.insumo SET nombre=$2, unidad=$3, minimo=$4, proveedor=$5, activo=$6,
                         tipo=$7, presentacion=$8, precio_compra=$9, cant_presentacion=$10, equiv_kg=$11, unidad_inventario=$13,
                         cpp = CASE WHEN $12::numeric IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.movimiento_inventario m WHERE m.insumo_id = $1 AND m.tipo = 'COMPRA')
                                    THEN $12::numeric / $14::numeric ELSE cpp END,
                         estado = CASE WHEN $15 AND stock < $4 THEN 'BAJO_MINIMO' ELSE 'OK' END, actualizado_en = now(),
                         maneja_stock = $15, presentacion_codigo = $16, codigo = coalesce(NULLIF($17,''), codigo)
                       WHERE id=$1 RETURNING id`, [id, p.data.nombre, p.data.unidad, p.data.minimo, p.data.proveedor, p.data.activo,
                         p.data.tipo, p.data.presentacion, p.data.precioCompra, p.data.cantPresentacion, u.densidad, costoReferencia(p.data), u.unidadInventario, u.factor,
                         p.data.manejaStock, p.data.presentacionCodigo, p.data.codigo]);
      await c.query('SELECT core.recalcular_costos()');
      return f.rows;
    });
    if (!r.length) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'El insumo no existe.'));
    await auditar({ ...actor(req), accion: 'INSUMO_EDITADO', entidad: 'insumo', entidadId: id, detalle: p.data, ip: req.ip });
    return { id, ...p.data };
  });

  /* --------------------------------------------------------------- recetas */
  // Cambiar una receta crea una versión nueva: las ventas pasadas conservan su costo congelado.
  const Receta = z.object({
    rendimiento: z.number().positive().max(100_000),
    mermaEstandar: pct,
    // La cantidad se puede escribir en gr, kg, ml, L o unidades: se guarda convertida a la unidad base (MAE-07).
    lineas: z.array(z.object({ insumoId: z.string().uuid(), cantidad: z.number().positive().max(100_000), unidad: z.string().trim().toUpperCase().max(20).optional() })).min(1).max(40),
  });

  app.put('/recetas/:productoId', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'recetas.editar')) return;
    const { productoId } = req.params as { productoId: string };
    const p = Receta.safeParse(req.body);
    if (!p.success) return invalido(reply, p.error);
    const ids = p.data.lineas.map((l) => l.insumoId);
    if (new Set(ids).size !== ids.length) return reply.code(422).send(error(422, 'INSUMO_REPETIDO', 'Un insumo aparece dos veces.'));

    try {
      const r = await tx(async (c) => {
        const prod = (await c.query<{ nombre: string }>('SELECT nombre FROM core.producto WHERE id = $1 FOR UPDATE', [productoId])).rows[0];
        if (!prod) throw Object.assign(new Error('El producto no existe.'), { status: 404 });
        const ins = await c.query<{ id: string; nombre: string; unidad: string; cpp: string }>(
          'SELECT id, nombre, unidad, cpp FROM core.insumo WHERE id = ANY($1::uuid[]) AND activo', [ids]);
        if (ins.rowCount !== ids.length) throw Object.assign(new Error('Hay un insumo inexistente o inactivo.'), { status: 422 });
        const previa = (await c.query<{ version: number }>('SELECT version FROM core.receta WHERE producto_id = $1', [productoId])).rows[0];
        const version = (previa?.version ?? 0) + 1;
        await c.query(
          `INSERT INTO core.receta (id, producto_id, producto, version, estado, rendimiento, merma_estandar)
           VALUES ($1,$1,$2,$3,'VIGENTE',$4,$5)
           ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, estado = 'VIGENTE',
             rendimiento = EXCLUDED.rendimiento, merma_estandar = EXCLUDED.merma_estandar, producto = EXCLUDED.producto`,
          [productoId, prod.nombre, version, p.data.rendimiento, p.data.mermaEstandar]);
        await c.query('DELETE FROM core.receta_detalle WHERE receta_id = $1', [productoId]);
        const mapa = new Map(ins.rows.map((i) => [i.id, i]));
        let orden = 1;
        for (const l of p.data.lineas) {
          const i = mapa.get(l.insumoId)!;
          const unidad = l.unidad ?? i.unidad;
          // Servicio único de conversión (catálogo de unidades): g → kg, ml → L; otra familia no se acepta.
          const conv = (await c.query<{ base: string | null }>(`SELECT core.convertir_unidad($1, $2, $3) base
            WHERE EXISTS (SELECT 1 FROM core.unidad_medida WHERE codigo = $2 AND activo)`, [l.cantidad, unidad, i.unidad])).rows[0]?.base;
          if (conv === undefined || conv === null) {
            throw Object.assign(new Error(`${i.nombre} se mide en ${i.unidad}: no acepta ${unidad}.`), { status: 422 });
          }
          const cantidad = Number(conv);
          await c.query(`INSERT INTO core.receta_detalle (receta_id, insumo_id, insumo, unidad, cantidad, cpp, costo, orden, unidad_receta, cantidad_original)
                         VALUES ($1,$2,$3,$4,$5,$6,$5::numeric * $6::numeric,$7,$8,$9)`,
            [productoId, i.id, i.nombre, i.unidad, cantidad, i.cpp, orden++, unidad, l.cantidad]);
        }
        await c.query('UPDATE core.producto SET merma_pct = $2 WHERE id = $1', [productoId, p.data.mermaEstandar]);
        await c.query('SELECT core.recalcular_costos()');
        return (await c.query('SELECT costo_insumos, costo_con_merma, cif_unitario FROM core.receta WHERE id = $1', [productoId])).rows[0];
      });
      await auditar({ ...actor(req), accion: 'RECETA_VERSIONADA', entidad: 'receta', entidadId: productoId, detalle: p.data, ip: req.ip });
      return { productoId, costoInsumos: num(r.costo_insumos), costoConMerma: num(r.costo_con_merma), cifUnitario: num(r.cif_unitario) };
    } catch (e) {
      const err = e as Error & { status?: number };
      if (!err.status) throw e;
      return reply.code(err.status).send(error(err.status, 'RECETA_INVALIDA', err.message));
    }
  });

  /* -------------------------------------------------------------- clientes */
  const Cliente = z.object({
    nombre: texto(2, 160), docTipo: z.enum(['DNI', 'RUC', 'CE']), docNumero: z.string().trim().regex(/^[0-9A-Za-z]{0,15}$/, 'Solo letras y números'),
    telefono: z.string().trim().max(30).regex(/^[0-9+ ()-]*$/, 'Teléfono inválido'), email: z.union([z.literal(''), z.string().trim().email().max(160)]),
    direccion: z.string().trim().max(200), listaPrecio: z.enum(['MINORISTA', 'MAYORISTA', 'CORPORATIVO']),
    diasCredito: z.number().int().min(0).max(120), limiteCredito: dinero, estado: z.enum(['ACTIVO', 'INACTIVO']).default('ACTIVO'),
    // COB-03 / MAE-08: si no se indica, es al crédito quien tiene plazo o línea.
    condicionPago: z.enum(['CONTADO', 'CREDITO']).optional(), vendedorId: z.union([z.literal(''), z.string().uuid()]).default(''),
  }).refine((c) => c.docTipo !== 'DNI' || c.docNumero === '' || /^\d{8}$/.test(c.docNumero), { message: 'El DNI tiene 8 dígitos', path: ['docNumero'] })
    .refine((c) => c.docTipo !== 'RUC' || c.docNumero === '' || /^(10|15|17|20)\d{9}$/.test(c.docNumero), { message: 'El RUC tiene 11 dígitos y empieza en 10, 15, 17 o 20', path: ['docNumero'] });

  app.get('/clientes', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'clientes.gestionar')) return;
    const filas = await q<Record<string, string>>(`
      SELECT c.id, c.codigo, c.nombre, c.doc_tipo, coalesce(c.doc_numero,'') doc_numero, coalesce(c.telefono,'') telefono,
             c.email, c.direccion, c.lista_precio, c.dias_credito, c.limite_credito, c.estado, c.condicion_pago, coalesce(c.vendedor_id::text, '') vendedor_id,
             coalesce((SELECT sum(saldo) FROM core.cuenta_por_cobrar x WHERE x.cliente_id = c.id AND x.estado IN ('PENDIENTE','PARCIAL')), 0) saldo,
             EXISTS (SELECT 1 FROM core.usuario u WHERE u.cliente_id = c.id) usa_app
      FROM core.cliente c ORDER BY c.nombre`);
    return filas.map((f) => ({
      id: f.id, codigo: f.codigo, nombre: f.nombre, docTipo: f.doc_tipo, docNumero: f.doc_numero, telefono: f.telefono, email: f.email,
      direccion: f.direccion, listaPrecio: f.lista_precio, diasCredito: num(f.dias_credito), limiteCredito: num(f.limite_credito),
      estado: f.estado, condicionPago: f.condicion_pago, vendedorId: f.vendedor_id, saldo: num(f.saldo), usaApp: Boolean(f.usa_app),
    }));
  });

  app.post('/clientes', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'clientes.gestionar')) return;
    const p = Cliente.safeParse(req.body);
    if (!p.success) return invalido(reply, p.error);
    const d = p.data;
    const cond = d.condicionPago ?? (d.diasCredito > 0 || d.limiteCredito > 0 ? 'CREDITO' : 'CONTADO');
    const f = await uno<{ id: string; codigo: string }>(
      `INSERT INTO core.cliente (codigo, nombre, doc_tipo, doc_numero, telefono, email, direccion, lista_precio, dias_credito, limite_credito, estado, condicion_pago, vendedor_id)
       VALUES ('CLI-' || lpad((SELECT coalesce(max(substring(codigo from 5)::int), 0) + 1 FROM core.cliente WHERE codigo ~ '^CLI-[0-9]+$')::text, 4, '0'),
               $1,$2,NULLIF($3,''),NULLIF($4,''),$5,$6,$7,$8,$9,$10,$11,NULLIF($12,'')::uuid) RETURNING id, codigo`,
      [d.nombre, d.docTipo, d.docNumero, d.telefono, d.email, d.direccion, d.listaPrecio, d.diasCredito, d.limiteCredito, d.estado, cond, d.vendedorId]);
    await auditar({ ...actor(req), accion: 'CLIENTE_CREADO', entidad: 'cliente', entidadId: f!.id, detalle: { nombre: d.nombre, limiteCredito: d.limiteCredito }, ip: req.ip });
    return reply.code(201).send({ ...f, ...d });
  });

  app.patch('/clientes/:id', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'clientes.gestionar')) return;
    const { id } = req.params as { id: string };
    const p = Cliente.safeParse(req.body);
    if (!p.success) return invalido(reply, p.error);
    const d = p.data;
    const cond = d.condicionPago ?? (d.diasCredito > 0 || d.limiteCredito > 0 ? 'CREDITO' : 'CONTADO');
    const r = await q(`UPDATE core.cliente SET nombre=$2, doc_tipo=$3, doc_numero=NULLIF($4,''), telefono=NULLIF($5,''), email=$6, direccion=$7,
                         lista_precio=$8, dias_credito=$9, limite_credito=$10, estado=$11,
                         condicion_pago=$12, vendedor_id=NULLIF($13,'')::uuid WHERE id=$1 RETURNING id`,
      [id, d.nombre, d.docTipo, d.docNumero, d.telefono, d.email, d.direccion, d.listaPrecio, d.diasCredito, d.limiteCredito, d.estado, cond, d.vendedorId]);
    if (!r.length) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'El cliente no existe.'));
    await auditar({ ...actor(req), accion: 'CLIENTE_EDITADO', entidad: 'cliente', entidadId: id, detalle: { nombre: d.nombre, limiteCredito: d.limiteCredito, estado: d.estado }, ip: req.ip });
    return { id, ...d };
  });

  /* ---------------------------------------------------- costos indirectos */
  // MAE-11: categoría (CIF o gasto operativo, que no entra al costo del pan) y base de reparto (RN-13).
  // Excel: clasificación costo de producción / operativo / de ventas. Solo el de producción (CIF) entra al costo del pan;
  // la categoría que lee el motor se deriva de ella (la base lo garantiza con un CHECK).
  const Cif = z.object({
    concepto: texto(2, 80), tipo: z.enum(['FIJO', 'VARIABLE']), montoMensual: dinero, activo: z.boolean().default(true),
    categoria: z.enum(['CIF', 'GASTO']).optional(), clasificacion: z.enum(['PRODUCCION', 'OPERATIVO', 'VENTAS']).optional(),
    baseReparto: z.enum(['HORAS_HORNO', 'KG_MASA', 'UNIDADES']).default('UNIDADES'), codigo: codigoPropio,
  }).transform((d) => {
    const clasificacion = d.clasificacion ?? (d.categoria === 'GASTO' ? 'OPERATIVO' : 'PRODUCCION');
    return { ...d, clasificacion, categoria: clasificacion === 'PRODUCCION' ? 'CIF' as const : 'GASTO' as const };
  });

  // Tarifas del período abierto (W31): hora hombre, horno, kg de masa y por pan.
  const tarifasVigentes = async () => {
    const t = await uno<Record<string, string>>(`SELECT costo_hora_hombre, tarifa_hora_horno, tarifa_kg_masa, tarifa_unidad, horas_horno_mes, kg_masa_mes, unidades_mes
      FROM core.periodo_costos WHERE estado <> 'CERRADO' ORDER BY anio DESC, mes DESC LIMIT 1`);
    return t ? Object.fromEntries(Object.entries(t).map(([k, v]) => [k.replace(/_([a-z])/g, (_, l) => l.toUpperCase()), v === null ? null : num(v)])) : null;
  };

  const resumenCif = async () => {
    const [items, base, unidades] = await Promise.all([
      q<Record<string, string>>('SELECT id, codigo, concepto, tipo, monto_mensual, activo, categoria, clasificacion, base_reparto FROM core.costo_indirecto ORDER BY activo DESC, codigo'),
      uno<{ valor: string }>("SELECT valor FROM core.parametro WHERE clave = 'cif_base_prorrateo'"),
      uno<{ cif: string }>("SELECT coalesce(avg(cif_unitario),0) cif FROM core.receta WHERE estado = 'VIGENTE'"),
    ]);
    return {
      items: items.map((i) => ({ id: i.id, codigo: i.codigo, clasificacion: i.clasificacion, concepto: i.concepto, tipo: i.tipo, montoMensual: num(i.monto_mensual), activo: Boolean(i.activo), categoria: i.categoria, baseReparto: i.base_reparto })),
      tarifas: await tarifasVigentes(),
      baseProrrateo: base?.valor ?? 'UNIDADES',
      cifPromedioPorUnidad: num(unidades?.cif),
    };
  };

  app.get('/costos-indirectos', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'maestros.editar')) return;
    return resumenCif();
  });

  const conRecalculo = async (fn: (c: import('../db.js').Cliente) => Promise<void>) =>
    tx(async (c) => { await fn(c); await c.query('SELECT core.recalcular_costos()'); });

  app.post('/costos-indirectos', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'maestros.editar')) return;
    const p = Cif.safeParse(req.body);
    if (!p.success) return invalido(reply, p.error);
    try {
      await conRecalculo(async (c) => { await c.query(`INSERT INTO core.costo_indirecto (concepto, tipo, monto_mensual, activo, categoria, base_reparto, clasificacion, codigo) VALUES ($1,$2,$3,$4,$5,$6,$7,NULLIF($8,''))`, [p.data.concepto, p.data.tipo, p.data.montoMensual, p.data.activo, p.data.categoria, p.data.baseReparto, p.data.clasificacion, p.data.codigo]); });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return reply.code(409).send(error(409, 'DUPLICADO', 'Ya existe un concepto activo con ese nombre o ese código.'));
      throw e;
    }
    await auditar({ ...actor(req), accion: 'CIF_CREADO', entidad: 'costo_indirecto', detalle: p.data, ip: req.ip });
    return reply.code(201).send(await resumenCif());
  });

  app.patch('/costos-indirectos/:id', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'maestros.editar')) return;
    const { id } = req.params as { id: string };
    const p = Cif.safeParse(req.body);
    if (!p.success) return invalido(reply, p.error);
    let existe = false;
    try { await conRecalculo(async (c) => {
      existe = !!(await c.query(`UPDATE core.costo_indirecto SET concepto=$2, tipo=$3, monto_mensual=$4, activo=$5, categoria=$6, base_reparto=$7, clasificacion=$8,
          codigo = coalesce(NULLIF($9,''), codigo), actualizado_en=now() WHERE id=$1 RETURNING id`,
        [id, p.data.concepto, p.data.tipo, p.data.montoMensual, p.data.activo, p.data.categoria, p.data.baseReparto, p.data.clasificacion, p.data.codigo])).rowCount;
    }); } catch (e) { return duplicado(reply, e, 'un concepto con ese nombre o código'); }
    if (!existe) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'El concepto no existe.'));
    await auditar({ ...actor(req), accion: 'CIF_EDITADO', entidad: 'costo_indirecto', entidadId: id, detalle: p.data, ip: req.ip });
    return resumenCif();
  });

  app.post('/costos/recalcular', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'maestros.editar')) return;
    const n = await uno<{ n: number }>('SELECT core.recalcular_costos() AS n');
    await auditar({ ...actor(req), accion: 'COSTOS_RECALCULADOS', entidad: 'producto', detalle: { productos: n?.n }, ip: req.ip });
    return { productos: n?.n ?? 0 };
  });
}
