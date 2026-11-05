import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { q, tx, uno, num } from '../db.js';
import { autenticar, exigir, error } from '../seguridad.js';
import { auditar } from '../auditoria.js';
import { invalidar } from '../cache.js';
import { emitirEvento } from './sistema.js';
import { avisar } from './notificaciones.js';
import { actor, fallo, responder } from './almacen.js';
import { anularPagosDeCompra } from './pagos.js';
import { tipoDocumento } from './catalogos.js';

/**
 * Compra de insumos (Informe de Análisis v1.1).
 * REGISTRADA → (Almacén) VERIFICADA | OBSERVADA → (Administración) EN_CORRECCION → (Compras) REGISTRADA; ANULADA.
 * El stock solo ingresa al verificar (RN-06). Las cantidades se registran en presentaciones y se convierten con el
 * servicio único de la base (core.factor_inventario): F1 base = cantidad × contenido; F2 inventario = base × factor;
 * F3 costo por unidad de inventario = precio ÷ (contenido × factor). Se guardan convertidas (RN-04).
 */

const hoyLima = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
const ESTADOS_EDITABLES = ['REGISTRADA', 'EN_CORRECCION'];

const Linea = z.object({
  insumoId: z.string().uuid(),
  cantidad: z.number().positive().max(1_000_000),          // en presentaciones de compra (6 botellas)
  precioUnitario: z.number().positive().max(1_000_000),    // por presentación (S/ 8.50 por botella)
  lote: z.string().trim().toUpperCase().max(40).default(''),
  venceEn: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).default(''),
});
const Compra = z.object({
  proveedorId: z.string().uuid(),
  docTipo: z.string().trim().toUpperCase().max(20),
  // La nota de pedido puede no tener serie: entonces va vacía y el documento es solo el número.
  serie: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{0,4}$/, 'La serie tiene hasta 4 letras o números').default(''),
  nro: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,10}$/, 'El número tiene de 1 a 10 letras o números'),
  fechaCompra: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  vencePago: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).default(''),
  // Excel: condición contado o crédito; al crédito la fecha de vencimiento del pago es obligatoria.
  condicion: z.enum(['CONTADO', 'CREDITO']).default('CONTADO'),
  // «A veces los detalles de la compra están sin IGV»: false = los precios no incluyen IGV y el total lo suma aparte.
  preciosConIgv: z.boolean().default(true),
  items: z.array(Linea).min(1).max(100).refine((l) => new Set(l.map((i) => i.insumoId)).size === l.length, 'Un insumo aparece dos veces'),
}).refine((d) => d.fechaCompra <= hoyLima(), { message: 'La fecha de compra no puede ser futura.', path: ['fechaCompra'] })
  .refine((d) => !d.vencePago || d.vencePago >= d.fechaCompra, { message: 'El vencimiento del pago no puede ser anterior a la compra.', path: ['vencePago'] })
  .refine((d) => d.condicion === 'CONTADO' || !!d.vencePago, { message: 'Una compra al crédito necesita la fecha de vencimiento del pago.', path: ['vencePago'] })
  .refine((d) => d.items.every((i) => !i.venceEn || i.venceEn >= hoyLima()), { message: 'Un lote ya está vencido: no se recibe.', path: ['items'] });
type DatosCompra = z.infer<typeof Compra>;

/** Valida proveedor y documento, y escribe cabecera y detalle convertido. Devuelve el total. */
async function escribirCompra(c: PoolClient, d: DatosCompra, compraId: string | null, usuarioId: string, codigo: string, clave: string | null) {
  const prov = (await c.query<{ estado: string }>('SELECT estado FROM core.proveedor WHERE id = $1', [d.proveedorId])).rows[0];
  if (!prov) throw fallo(404, 'El proveedor no existe.');
  if (prov.estado !== 'ACTIVO') throw fallo(409, 'El proveedor está inactivo.');
  // RN-05: proveedor + documento + serie + número, sin espacios ni mayúsculas, entre las no anuladas.
  if ((await c.query(`SELECT 1 FROM core.compra WHERE proveedor_id = $1 AND doc_tipo = $2 AND upper(trim(serie)) = $3 AND upper(trim(nro)) = $4
      AND estado <> 'ANULADA' AND id IS DISTINCT FROM $5`, [d.proveedorId, d.docTipo, d.serie, d.nro, compraId])).rowCount) {
    throw fallo(409, `El documento ${d.docTipo} ${numeroDoc(d.serie, d.nro)} de este proveedor ya está registrado.`);
  }
  // Catálogo: si el documento da crédito fiscal (factura), el precio trae IGV recuperable y el costo del insumo va sin él.
  const doc = await tipoDocumento(c, d.docTipo);
  const tasa = num((await c.query<{ valor: string }>("SELECT valor FROM core.parametro WHERE clave = 'igv'")).rows[0]?.valor ?? '0.18');
  // Precios sin IGV solo tienen sentido con crédito fiscal (factura): en una boleta el precio es el que se paga.
  const conIgv = !doc.credito_fiscal || d.preciosConIgv;
  const sinIgv = doc.credito_fiscal && conIgv ? 1 / (1 + tasa) : 1;
  const lineas = [];
  for (const [n, it] of d.items.entries()) {
    const ins = (await c.query<{ nombre: string; activo: boolean; contenido: string; factor: string | null; cpp: string }>(
      'SELECT nombre, activo, coalesce(cant_presentacion, 1) contenido, core.factor_inventario(id) factor, cpp FROM core.insumo WHERE id = $1', [it.insumoId])).rows[0];
    if (!ins) throw fallo(404, 'Un insumo de la compra no existe.');
    if (!ins.activo) throw fallo(409, `${ins.nombre} está inactivo.`);
    if (ins.factor === null) throw fallo(422, `${ins.nombre} no tiene factor de inventario: define su densidad en la ficha.`);
    const contenido = num(ins.contenido), factor = num(ins.factor);
    const base = it.cantidad * contenido, inventario = base * factor;           // F1, F2
    const costo = it.precioUnitario * sinIgv / (contenido * factor);            // F3 (sin IGV con crédito fiscal)
    lineas.push({ item: n + 1, ...it, contenido, factor, base, inventario, costo, precioLote: Math.round(it.cantidad * it.precioUnitario * 100) / 100, cpp: num(ins.cpp) });
  }
  const suma = Math.round(lineas.reduce((s, l) => s + l.precioLote, 0) * 100) / 100;
  // Con crédito fiscal se separa la base y el IGV del total (punto 4 del informe). Sin IGV en el detalle, la suma ES la base.
  const total = conIgv ? suma : Math.round(suma * (1 + tasa) * 100) / 100;
  const base = doc.credito_fiscal ? (conIgv ? Math.round(total / (1 + tasa) * 100) / 100 : suma) : null;
  const params = [d.proveedorId, d.docTipo, d.serie, d.nro, numeroDoc(d.serie, d.nro), d.fechaCompra, d.condicion === 'CREDITO' ? d.vencePago : '', total.toFixed(2),
    base?.toFixed(2) ?? null, base === null ? null : (total - base).toFixed(2), usuarioId, d.condicion, conIgv];
  let id = compraId;
  if (id) {
    await c.query(`UPDATE core.compra SET proveedor_id = $2, doc_tipo = $3, serie = $4, nro = $5, doc_numero = $6, fecha_compra = $7,
        vence_pago = NULLIF($8,'')::date, total = $9, base = $10, igv = $11, modificado_por = $12, modificado_en = now(), estado = 'REGISTRADA',
        condicion = $13, precios_con_igv = $14
      WHERE id = $1`, [id, ...params]);
    await c.query('DELETE FROM core.compra_detalle WHERE compra_id = $1', [id]);
  } else {
    id = (await c.query<{ id: string }>(`INSERT INTO core.compra (codigo, proveedor_id, doc_tipo, serie, nro, doc_numero, fecha_compra, vence_pago, total, base, igv,
        registrado_por, condicion, precios_con_igv, idempotency_key, estado) VALUES ($1,$2,$3,$4,$5,$6,$7,NULLIF($8,'')::date,$9,$10,$11,$12,$13,$14,$15,'REGISTRADA') RETURNING id`,
      [codigo, ...params, clave])).rows[0].id;
  }
  for (const l of lineas) {
    await c.query(`INSERT INTO core.compra_detalle (compra_id, insumo_id, item, cantidad_presentacion, precio_unitario, precio_lote, contenido, factor,
        cantidad_base, cantidad_inventario, costo_unitario_inventario, cantidad, precio, cpp_anterior, cpp_nuevo, lote, vence_en, sin_igv)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$10,$11,$12,$12,NULLIF($13,''),NULLIF($14,'')::date,$15)`,
      [id, l.insumoId, l.item, l.cantidad.toFixed(4), l.precioUnitario.toFixed(4), l.precioLote.toFixed(2), l.contenido.toFixed(6), l.factor.toFixed(6),
        l.base.toFixed(6), l.inventario.toFixed(6), l.costo.toFixed(6), l.cpp.toFixed(6), l.lote, l.venceEn, doc.credito_fiscal && conIgv]);
  }
  return total;
}

/** N.° del documento: SERIE-NÚMERO, o solo el número si no tiene serie (nota de pedido). */
const numeroDoc = (serie: string, nro: string) => (serie ? `${serie}-${nro}` : nro);

async function detalleCompra(where: string, params: unknown[], valoriza: boolean) {
  const filas = await q<Record<string, unknown>>(`
    SELECT c.id, c.codigo, c.estado, c.estado_pago, c.doc_tipo, c.serie, c.nro, c.fecha_compra::text fecha, c.vence_pago::text vence_pago, c.total, c.base, c.igv,
           c.observacion, c.motivo_anulacion, c.creado_en::text creado_en, c.anulado_en::text anulado_en, c.proveedor_id, p.razon_social proveedor,
           c.condicion, c.precios_con_igv, coalesce(p.ruc, '') ruc, p.direccion,
           ur.nombre registrado_por, uv.nombre verificado_por, ua.nombre anulado_por,
           json_agg(json_build_object('item', d.item, 'insumoId', d.insumo_id, 'insumo', i.nombre, 'presentacion', i.presentacion, 'unidadBase', i.unidad,
             'unidadInventario', i.unidad_inventario, 'cantidad', d.cantidad_presentacion, 'precioUnitario', d.precio_unitario, 'precioLote', d.precio_lote,
             'contenido', d.contenido, 'factor', d.factor, 'cantidadBase', d.cantidad_base, 'cantidadInventario', d.cantidad_inventario,
             'costoInventario', d.costo_unitario_inventario, 'cantidadVerificada', d.cantidad_verificada, 'observacion', d.observacion_almacen,
             'lote', d.lote, 'venceEn', d.vence_en, 'sinIgv', d.sin_igv) ORDER BY d.item) items
    FROM core.compra c JOIN core.proveedor p ON p.id = c.proveedor_id JOIN core.compra_detalle d ON d.compra_id = c.id JOIN core.insumo i ON i.id = d.insumo_id
    LEFT JOIN core.usuario ur ON ur.id = c.registrado_por LEFT JOIN core.usuario uv ON uv.id = c.verificado_por LEFT JOIN core.usuario ua ON ua.id = c.anulado_por
    WHERE ${where} GROUP BY c.id, p.razon_social, p.ruc, p.direccion, ur.nombre, uv.nombre, ua.nombre ORDER BY c.creado_en DESC LIMIT 300`, params);
  const n = (x: unknown) => (x === null || x === undefined ? null : num(x as string));
  return filas.map((f) => ({
    id: f.id, codigo: f.codigo, estado: f.estado, estadoPago: f.estado_pago, docTipo: f.doc_tipo, serie: f.serie, nro: f.nro,
    documento: `${String(f.doc_tipo).replace('_', ' ')} ${numeroDoc(String(f.serie), String(f.nro))}`, fecha: f.fecha,
    condicion: f.condicion, preciosConIgv: Boolean(f.precios_con_igv), ruc: f.ruc, direccion: f.direccion, vencePago: f.vence_pago, proveedorId: f.proveedor_id, proveedor: f.proveedor,
    total: num(f.total as string), base: n(f.base), igv: n(f.igv), observacion: f.observacion, motivoAnulacion: f.motivo_anulacion,
    registradoPor: f.registrado_por, verificadoPor: f.verificado_por, anuladoPor: f.anulado_por, creadoEn: f.creado_en, anuladoEn: f.anulado_en,
    items: (f.items as Array<Record<string, unknown>>).map((i) => ({
      item: i.item, insumoId: i.insumoId, insumo: i.insumo, presentacion: i.presentacion, unidadBase: i.unidadBase, unidadInventario: i.unidadInventario,
      cantidad: n(i.cantidad), contenido: n(i.contenido), factor: n(i.factor), cantidadBase: n(i.cantidadBase), cantidadInventario: n(i.cantidadInventario),
      cantidadVerificada: n(i.cantidadVerificada), observacion: i.observacion, lote: i.lote, venceEn: i.venceEn, sinIgv: Boolean(i.sinIgv),
      ...(valoriza ? { precioUnitario: n(i.precioUnitario), precioLote: n(i.precioLote), costoInventario: n(i.costoInventario) } : {}),
    })),
  }));
}

export async function rutasCompras(app: FastifyInstance) {
  // UNIDAD_MEDIDA para los formularios de insumos y compras.
  app.get('/unidades', { preHandler: autenticar }, async () =>
    q('SELECT codigo, descripcion, familia, factor_a_patron::float factor FROM core.unidad_medida ORDER BY familia, factor_a_patron DESC'));

  // Excel «P. ANTERIOR» con icono sube/baja: último precio por presentación de cada insumo (compras no anuladas).
  app.get('/compras/precios-anteriores', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'compras.registrar')) return;
    const p = z.object({ excluir: z.string().max(20).optional() }).safeParse(req.query);
    const filas = await q<{ insumo_id: string; precio_unitario: string; fecha: string; proveedor: string; sin_igv: boolean }>(`
      SELECT DISTINCT ON (d.insumo_id) d.insumo_id, d.precio_unitario, c.fecha_compra::text fecha, p.razon_social proveedor, NOT c.precios_con_igv sin_igv
      FROM core.compra_detalle d JOIN core.compra c ON c.id = d.compra_id JOIN core.proveedor p ON p.id = c.proveedor_id
      WHERE c.estado <> 'ANULADA' AND c.codigo IS DISTINCT FROM $1
      ORDER BY d.insumo_id, c.fecha_compra DESC, c.creado_en DESC`, [p.success ? p.data.excluir ?? null : null]);
    return Object.fromEntries(filas.map((f) => [f.insumo_id, { precio: num(f.precio_unitario), fecha: f.fecha, proveedor: f.proveedor, sinIgv: f.sin_igv }]));
  });

  app.get('/compras', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'compras.ver')) return;
    const p = z.object({ estado: z.enum(['REGISTRADA', 'VERIFICADA', 'OBSERVADA', 'EN_CORRECCION', 'ANULADA']).optional() }).safeParse(req.query);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Estado inválido.'));
    // Almacén cuenta cantidades: no necesita precios (sección 7 del informe).
    const valoriza = ['compras.registrar', 'compras.autorizar', 'costos.ver'].some((x) => req.usuario!.permisos.has(x));
    return detalleCompra('($1::text IS NULL OR c.estado = $1)', [p.data.estado ?? null], valoriza);
  });

  app.post('/compras', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'compras.registrar')) return;
    const p = Compra.safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues[0]?.message ?? 'Compra inválida.'));
    const clave = (req.headers['idempotency-key'] as string | undefined) ?? null;
    if (clave) {
      const previa = await uno<{ codigo: string }>('SELECT codigo FROM core.compra WHERE idempotency_key = $1', [clave]);
      if (previa) return reply.code(201).send((await detalleCompra('c.codigo = $1', [previa.codigo], true))[0]);
    }
    return responder(reply, 'COMPRA_INVALIDA', async () => {
      const codigo = await tx(async (c) => {
        const cod = `COM-${String(num((await c.query<{ n: string }>(`SELECT coalesce(max(substring(codigo from 5)::int), 0) + 1 n FROM core.compra WHERE codigo ~ '^COM-[0-9]+$'`)).rows[0].n)).padStart(6, '0')}`;
        await escribirCompra(c, p.data, null, req.usuario!.id, cod, clave);
        return cod;
      });
      const r = (await detalleCompra('c.codigo = $1', [codigo], true))[0];
      await auditar({ ...actor(req), accion: 'COMPRA_REGISTRADA', entidad: 'compra', entidadId: codigo, detalle: { documento: r.documento, total: r.total } });
      avisar([{ permiso: 'compras.verificar' }], { tipo: 'compra', titulo: `Compra ${codigo} por verificar`, cuerpo: `${r.proveedor} · ${r.documento} · ${r.items.length} insumo(s)`, ruta: '/almacen/compras' });
      return reply.code(201).send(r);
    });
  });

  // RN-08: solo REGISTRADA o EN_CORRECCION se edita; al guardar vuelve a verificación de Almacén.
  app.put('/compras/:codigo', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'compras.registrar')) return;
    const { codigo } = req.params as { codigo: string };
    const p = Compra.safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues[0]?.message ?? 'Compra inválida.'));
    return responder(reply, 'COMPRA_INVALIDA', async () => {
      const antes = await tx(async (c) => {
        const k = (await c.query<{ id: string; estado: string }>('SELECT id, estado FROM core.compra WHERE codigo = $1 FOR UPDATE', [codigo])).rows[0];
        if (!k) throw fallo(404, 'La compra no existe.');
        if (!ESTADOS_EDITABLES.includes(k.estado)) throw fallo(409, `Una compra ${k.estado.replace('_', ' ').toLowerCase()} no se edita${k.estado === 'OBSERVADA' ? ': Administración debe autorizar la corrección' : ''}.`);
        await escribirCompra(c, p.data, k.id, req.usuario!.id, codigo, null);
        return k.estado;
      });
      const r = (await detalleCompra('c.codigo = $1', [codigo], true))[0];
      await auditar({ ...actor(req), accion: 'COMPRA_CORREGIDA', entidad: 'compra', entidadId: codigo, detalle: { estadoAnterior: antes, total: r.total } });
      avisar([{ permiso: 'compras.verificar' }], { tipo: 'compra', titulo: `Compra ${codigo} por verificar`, cuerpo: `${antes === 'EN_CORRECCION' ? 'Corregida: verifícala de nuevo' : 'Actualizada'} · ${r.documento}`, ruta: '/almacen/compras' });
      return r;
    });
  });

  // Paso 3 y 4: Almacén cuenta. Todo igual → VERIFICADA e ingresa el stock; alguna diferencia → OBSERVADA, sin stock.
  const Verificacion = z.object({
    lineas: z.array(z.object({ item: z.number().int().positive(), cantidadVerificada: z.number().min(0).max(1_000_000), observacion: z.string().trim().max(200).default('') })).min(1),
  });
  app.post('/compras/:codigo/verificar', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'compras.verificar')) return;
    const { codigo } = req.params as { codigo: string };
    const p = Verificacion.safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Indica la cantidad contada de cada línea.'));
    return responder(reply, 'VERIFICACION_INVALIDA', async () => {
      const r = await tx(async (c) => {
        const k = (await c.query<{ id: string; estado: string; documento: string }>(`SELECT c.id, c.estado, c.codigo || ' · ' || c.doc_tipo || ' ' || concat_ws('-', NULLIF(c.serie, ''), c.nro) || ' · ' || p.razon_social documento
          FROM core.compra c JOIN core.proveedor p ON p.id = c.proveedor_id WHERE c.codigo = $1 FOR UPDATE OF c`, [codigo])).rows[0];
        if (!k) throw fallo(404, 'La compra no existe.');
        if (k.estado !== 'REGISTRADA') throw fallo(409, `La compra está ${k.estado.replace('_', ' ').toLowerCase()}: solo se verifica una registrada.`);
        const det = (await c.query<{ item: number; insumo_id: string; insumo: string; cantidad_presentacion: string; contenido: string; factor: string;
          cantidad_inventario: string; costo_unitario_inventario: string; lote: string | null; vence_en: string | null }>(
          `SELECT d.item, d.insumo_id, i.nombre insumo, d.cantidad_presentacion, d.contenido, d.factor, d.cantidad_inventario, d.costo_unitario_inventario, d.lote, d.vence_en::text
           FROM core.compra_detalle d JOIN core.insumo i ON i.id = d.insumo_id WHERE d.compra_id = $1 ORDER BY d.insumo_id`, [k.id])).rows;
        const conteo = new Map(p.data.lineas.map((l) => [l.item, l]));
        if (det.some((d) => !conteo.has(d.item)) || conteo.size !== det.length) throw fallo(422, 'Cuenta todas las líneas de la compra.');
        const diferencias = det.filter((d) => Math.abs(conteo.get(d.item)!.cantidadVerificada - num(d.cantidad_presentacion)) > 1e-6);
        for (const d of diferencias) if (conteo.get(d.item)!.observacion.length < 3) throw fallo(422, `Indica el motivo de la diferencia en ${d.insumo}.`);
        for (const d of det) {
          await c.query('UPDATE core.compra_detalle SET cantidad_verificada = $3, observacion_almacen = NULLIF($4,\'\') WHERE compra_id = $1 AND item = $2',
            [k.id, d.item, conteo.get(d.item)!.cantidadVerificada.toFixed(4), conteo.get(d.item)!.observacion]);
        }
        if (diferencias.length) {
          const resumen = diferencias.map((d) => `${d.insumo}: ${num(d.cantidad_presentacion)} en el documento, ${conteo.get(d.item)!.cantidadVerificada} contadas (${conteo.get(d.item)!.observacion})`).join('; ');
          await c.query(`UPDATE core.compra SET estado = 'OBSERVADA', observacion = $2, verificado_por = $3, verificado_en = now() WHERE id = $1`, [k.id, resumen.slice(0, 1000), req.usuario!.id]);
          return { estado: 'OBSERVADA' as const, resumen };
        }
        // RN-06: ingreso al inventario en unidad de inventario, al costo F3; RN-13: costo promedio ponderado.
        const metodoCosto = (await c.query<{ v: string }>("SELECT upper(coalesce((SELECT valor FROM core.parametro WHERE clave = 'metodo_costo_insumo'), 'PROMEDIO')) v")).rows[0].v;
        // Excel: el costo de las fórmulas de precio se actualiza a mano («Ajustar costos») si el parámetro es MANUAL.
        const formulasManual = (await c.query<{ v: string }>("SELECT upper(coalesce((SELECT valor FROM core.parametro WHERE clave = 'costo_insumo_formulas'), 'MANUAL')) v")).rows[0].v === 'MANUAL';
        for (const d of det) {
          const ins = (await c.query<{ stock: string; cpp: string }>('SELECT stock, cpp FROM core.insumo WHERE id = $1 FOR UPDATE', [d.insumo_id])).rows[0];
          const cant = num(d.cantidad_inventario), costo = num(d.costo_unitario_inventario);
          const saldo = Math.max(num(ins.stock), 0), cpp = num(ins.cpp);
          // RN-14 (administrable en Parámetros → metodo_costo_insumo): promedio ponderado o último costo de compra.
          const nuevoCpp = metodoCosto === 'ULTIMO' ? costo : (saldo * cpp + cant * costo) / (saldo + cant);
          const nuevoStock = num(ins.stock) + cant;
          const mov = (await c.query<{ id: string }>(`INSERT INTO core.movimiento_inventario
              (tipo,item_tipo,insumo_id,documento,cantidad,costo_unitario,valor,saldo_cantidad,saldo_valor,cpp,registrado_por,lote,vence_en)
            VALUES ('COMPRA','INSUMO',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
            [d.insumo_id, k.documento.slice(0, 200), cant.toFixed(6), costo.toFixed(6), (cant * costo).toFixed(4), nuevoStock.toFixed(6),
              (nuevoStock * nuevoCpp).toFixed(4), nuevoCpp.toFixed(6), req.usuario!.id, d.lote, d.vence_en])).rows[0].id;
          // MANUAL: la primera compra que mueve un costo ya conocido lo congela para las fórmulas (el kárdex sí cambia).
          // AUTOMATICO: las fórmulas siguen al kárdex.
          await c.query(`UPDATE core.insumo SET stock = $1, cpp = $2, actualizado_en = now(),
              costo_formula = CASE WHEN NOT $4 THEN NULL WHEN costo_formula IS NULL AND $5::numeric > 0 THEN $5::numeric ELSE costo_formula END
            WHERE id = $3`, [nuevoStock.toFixed(6), nuevoCpp.toFixed(6), d.insumo_id, formulasManual, cpp.toFixed(6)]);
          await c.query('UPDATE core.compra_detalle SET movimiento_id = $3, cpp_anterior = $4, cpp_nuevo = $5 WHERE compra_id = $1 AND item = $2',
            [k.id, d.item, mov, cpp.toFixed(6), nuevoCpp.toFixed(6)]);
        }
        // El aviso de la deuda sale ahora (sección 8): la ronda periódica no lo repite hoy.
        await c.query(`UPDATE core.compra SET estado = 'VERIFICADA', observacion = NULL, verificado_por = $2, verificado_en = now(), alerta_pago_en = (now() AT TIME ZONE 'America/Lima')::date WHERE id = $1`, [k.id, req.usuario!.id]);
        await c.query('SELECT core.recalcular_costos()');
        return { estado: 'VERIFICADA' as const, resumen: '' };
      });
      if (r.estado === 'VERIFICADA') {
        invalidar('cat:');
        const k = await uno<{ total: string; proveedor: string; vence: string | null }>(`SELECT c.total, p.razon_social proveedor, c.vence_pago::text vence
          FROM core.compra c JOIN core.proveedor p ON p.id = c.proveedor_id WHERE c.codigo = $1`, [codigo]);
        if (k) avisar([{ permiso: 'compras.pagar' }], { tipo: 'compra', titulo: `Deuda ${codigo} por pagar`, ruta: '/compras/deudas',
          cuerpo: `Almacén verificó la compra: S/ ${num(k.total).toFixed(2)} a ${k.proveedor}${k.vence ? ` · vence ${k.vence}` : ''}` });
      }
      await auditar({ ...actor(req), accion: r.estado === 'VERIFICADA' ? 'COMPRA_VERIFICADA' : 'COMPRA_OBSERVADA', entidad: 'compra', entidadId: codigo, detalle: { observacion: r.resumen || undefined } });
      void emitirEvento(r.estado === 'VERIFICADA' ? 'compra.verificada' : 'compra.observada', { codigo });
      if (r.estado === 'OBSERVADA') {
        avisar([{ permiso: 'compras.autorizar' }], { tipo: 'compra', titulo: `Compra ${codigo} observada`, cuerpo: `Almacén encontró diferencias: ${r.resumen}`, ruta: '/almacen/compras' });
      }
      return { codigo, estado: r.estado, observacion: r.resumen || null };
    });
  });

  // RN-07: solo Administración autoriza corregir una compra observada.
  app.post('/compras/:codigo/autorizar-correccion', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'compras.autorizar')) return;
    const { codigo } = req.params as { codigo: string };
    const r = await uno<{ id: string }>(`UPDATE core.compra SET estado = 'EN_CORRECCION', modificado_por = $2, modificado_en = now()
      WHERE codigo = $1 AND estado = 'OBSERVADA' RETURNING id`, [codigo, req.usuario!.id]);
    if (!r) return reply.code(409).send(error(409, 'COMPRA_NO_OBSERVADA', 'Solo se autoriza la corrección de una compra observada.'));
    await auditar({ ...actor(req), accion: 'COMPRA_CORRECCION_AUTORIZADA', entidad: 'compra', entidadId: codigo, detalle: {} });
    avisar([{ permiso: 'compras.registrar' }], { tipo: 'compra', titulo: `Corrige la compra ${codigo}`, cuerpo: 'Administración autorizó la corrección: ajusta cantidades o precios y vuelve a enviarla a verificación.', ruta: '/almacen/compras' });
    return { codigo, estado: 'EN_CORRECCION' };
  });

  // RN-09: solo Administración anula, con motivo. Si ya ingresó stock, REVERSA_COMPRA del lote de esa compra.
  app.post('/compras/:codigo/anular', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'compras.anular')) return;
    const { codigo } = req.params as { codigo: string };
    const p = z.object({ motivo: z.string().trim().min(5).max(300) }).safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Indica el motivo de la anulación (mínimo 5 caracteres).'));
    return responder(reply, 'ANULACION_INVALIDA', async () => {
      let pagosAnulados = 0;
      const revertidas = await tx(async (c) => {
        const k = (await c.query<{ id: string; estado: string }>('SELECT id, estado FROM core.compra WHERE codigo = $1 FOR UPDATE', [codigo])).rows[0];
        if (!k) throw fallo(404, 'La compra no existe.');
        if (k.estado === 'ANULADA') throw fallo(409, 'La compra ya está anulada.');
        let n = 0;
        if (k.estado === 'VERIFICADA') {
          const det = (await c.query<{ item: number; insumo_id: string; insumo: string; unidad: string; cantidad_inventario: string; costo_unitario_inventario: string;
            cpp_anterior: string; movimiento_id: string | null }>(`SELECT d.item, d.insumo_id, i.nombre insumo, i.unidad_inventario unidad, d.cantidad_inventario,
              d.costo_unitario_inventario, d.cpp_anterior, d.movimiento_id FROM core.compra_detalle d JOIN core.insumo i ON i.id = d.insumo_id
            WHERE d.compra_id = $1 ORDER BY d.insumo_id`, [k.id])).rows;
          for (const d of det) {
            const cant = num(d.cantidad_inventario), costo = num(d.costo_unitario_inventario);
            const ins = (await c.query<{ stock: string; cpp: string }>('SELECT stock, cpp FROM core.insumo WHERE id = $1 FOR UPDATE', [d.insumo_id])).rows[0];
            // Punto 7 por confirmar: si ya se usó lo comprado, se bloquea (nunca stock negativo).
            const lote = d.movimiento_id
              ? (await c.query<{ id: string; saldo: string }>('SELECT id, saldo FROM core.lote_insumo WHERE movimiento_id = $1 FOR UPDATE', [d.movimiento_id])).rows[0]
              : undefined;
            const disponible = Math.min(lote ? num(lote.saldo) : num(ins.stock), num(ins.stock));
            if (disponible + 1e-6 < cant) {
              throw fallo(409, `No se puede anular: de ${d.insumo} ya se usaron ${(cant - disponible).toFixed(4)} ${d.unidad.toLowerCase()} de los ${cant.toFixed(4)} comprados. Registra un ajuste en su lugar.`);
            }
            // Compras anteriores a la verificación no tienen su lote enlazado: salen por FEFO como cualquier salida.
            if (lote) await c.query('UPDATE core.lote_insumo SET saldo = saldo - $2 WHERE id = $1', [lote.id, cant.toFixed(6)]);
            else await c.query('SELECT core.consumir_lotes($1, $2)', [d.insumo_id, cant.toFixed(6)]);
            const stock = num(ins.stock) - cant;
            // El costo promedio vuelve al que habría sin esta compra; sin stock, al de antes de la compra.
            let cpp = stock > 1e-6 ? (num(ins.stock) * num(ins.cpp) - cant * costo) / stock : num(d.cpp_anterior);
            if (!(cpp >= 0)) cpp = num(d.cpp_anterior);
            await c.query(`INSERT INTO core.movimiento_inventario
                (tipo,item_tipo,insumo_id,documento,cantidad,costo_unitario,valor,saldo_cantidad,saldo_valor,cpp,registrado_por,motivo_tipo)
              VALUES ('REVERSA_COMPRA','INSUMO',$1,$2,$3,$4,$5,$6,$7,$8,$9,'AJUSTE')`,
              [d.insumo_id, `Anulación ${codigo}: ${p.data.motivo}`.slice(0, 200), (-cant).toFixed(6), costo.toFixed(6), (-cant * costo).toFixed(4),
                stock.toFixed(6), (stock * cpp).toFixed(4), cpp.toFixed(6), req.usuario!.id]);
            await c.query('UPDATE core.insumo SET stock = $1, cpp = $2, actualizado_en = now() WHERE id = $3', [stock.toFixed(6), cpp.toFixed(6), d.insumo_id]);
            n++;
          }
          await c.query('SELECT core.recalcular_costos()');
        }
        await c.query(`UPDATE core.compra SET estado = 'ANULADA', anulado_por = $2, anulado_en = now(), motivo_anulacion = $3 WHERE id = $1`, [k.id, req.usuario!.id, p.data.motivo]);
        pagosAnulados = await anularPagosDeCompra(c, k.id, req.usuario!.id, p.data.motivo);
        return n;
      });
      if (revertidas) invalidar('cat:');
      await auditar({ ...actor(req), accion: 'COMPRA_ANULADA', entidad: 'compra', entidadId: codigo, detalle: { motivo: p.data.motivo, lineasRevertidas: revertidas, pagosAnulados } });
      return { codigo, estado: 'ANULADA', lineasRevertidas: revertidas, pagosAnulados };
    });
  });
}
