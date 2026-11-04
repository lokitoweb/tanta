import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { q, tx, uno, num } from '../db.js';
import { autenticar, exigir, error } from '../seguridad.js';
import { auditar } from '../auditoria.js';

/**
 * Maestros administrables (PDF §3.3): categorías, productos, insumos, recetas,
 * clientes y costos indirectos. Toda modificación que afecta costos llama al
 * motor (core.recalcular_costos) en la misma transacción.
 */

const texto = (min: number, max: number) => z.string().trim().min(min).max(max);
const dinero = z.number().min(0).max(1_000_000);
const pct = z.number().min(0).max(0.95);

function invalido(reply: FastifyReply, e: z.ZodError) {
  const i = e.issues[0];
  return reply.code(422).send(error(422, 'DATOS_INVALIDOS', i ? `${i.path.join('.') || 'dato'}: ${i.message}` : 'Datos inválidos.'));
}

export async function rutasMaestros(app: FastifyInstance) {
  const actor = (req: { usuario?: { id: string; nombre: string; rol: string } }) =>
    ({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol });

  /* ------------------------------------------------------------ categorías */
  const Categoria = z.object({ nombre: texto(2, 60), margenObjetivo: pct, orden: z.number().int().min(0).max(999).default(0) });

  app.post('/categorias', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'maestros.editar')) return;
    const p = Categoria.safeParse(req.body);
    if (!p.success) return invalido(reply, p.error);
    const id = p.data.nombre.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]+/g, '_').slice(0, 30);
    if (await uno('SELECT 1 FROM core.categoria WHERE id = $1', [id])) return reply.code(409).send(error(409, 'DUPLICADO', 'Ya existe esa categoría.'));
    await q('INSERT INTO core.categoria (id, nombre, margen_objetivo, orden) VALUES ($1,$2,$3,$4)', [id, p.data.nombre, p.data.margenObjetivo, p.data.orden]);
    await auditar({ ...actor(req), accion: 'CATEGORIA_CREADA', entidad: 'categoria', entidadId: id, detalle: p.data, ip: req.ip });
    return reply.code(201).send({ id, ...p.data });
  });

  app.patch('/categorias/:id', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'maestros.editar')) return;
    const { id } = req.params as { id: string };
    const p = Categoria.safeParse(req.body);
    if (!p.success) return invalido(reply, p.error);
    const r = await q('UPDATE core.categoria SET nombre = $2, margen_objetivo = $3, orden = $4 WHERE id = $1 RETURNING id', [id, p.data.nombre, p.data.margenObjetivo, p.data.orden]);
    if (!r.length) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'La categoría no existe.'));
    await auditar({ ...actor(req), accion: 'CATEGORIA_EDITADA', entidad: 'categoria', entidadId: id, detalle: p.data, ip: req.ip });
    return { id, ...p.data };
  });

  /* ------------------------------------------------------------- productos */
  // Datos de producción de la hoja 'pan' (MAE-03): con ellos el motor calcula unidades, MO y CIF.
  const Producto = z.object({
    nombre: texto(2, 120), categoriaId: texto(1, 40), unidad: texto(1, 20),
    precioConIgv: z.number().positive().max(100_000), estado: z.enum(['ACTIVO', 'INACTIVO']),
    pesoMasaG: z.number().positive().max(100_000).nullable().optional(),
    anticipacionHoras: z.number().int().min(0).max(720).nullable().optional(),
    perdidaCoccion: pct.nullable().optional(), horasHombreLote: z.number().min(0).max(100).nullable().optional(), horasHornoLote: z.number().min(0).max(100).nullable().optional(),
  });

  app.patch('/productos/:id', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'maestros.editar')) return;
    const { id } = req.params as { id: string };
    const p = Producto.safeParse(req.body);
    if (!p.success) return invalido(reply, p.error);
    const antes = await uno<Record<string, string>>('SELECT nombre, precio_con_igv, estado FROM core.producto WHERE id = $1', [id]);
    if (!antes) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'El producto no existe.'));
    if (!(await uno('SELECT 1 FROM core.categoria WHERE id = $1', [p.data.categoriaId]))) return reply.code(422).send(error(422, 'CATEGORIA_INEXISTENTE', 'La categoría no existe.'));
    await tx(async (c) => {
      await c.query(`UPDATE core.producto SET nombre=$2, categoria_id=$3, unidad=$4, precio_con_igv=$5, estado=$6,
          peso_masa_g = CASE WHEN $7::boolean THEN $8::numeric ELSE peso_masa_g END,
          perdida_coccion = coalesce($9::numeric, perdida_coccion),
          horas_hombre_lote = coalesce($10::numeric, horas_hombre_lote), horas_horno_lote = coalesce($11::numeric, horas_horno_lote),
          anticipacion_horas = coalesce($12::int, anticipacion_horas)
        WHERE id=$1`,
        [id, p.data.nombre, p.data.categoriaId, p.data.unidad, p.data.precioConIgv.toFixed(4), p.data.estado,
          p.data.pesoMasaG !== undefined, p.data.pesoMasaG ?? null, p.data.perdidaCoccion ?? null, p.data.horasHombreLote ?? null, p.data.horasHornoLote ?? null, p.data.anticipacionHoras ?? null]);
      await c.query('SELECT core.recalcular_costos()');
    });
    await auditar({ ...actor(req), accion: 'PRODUCTO_EDITADO', entidad: 'producto', entidadId: id,
      detalle: { antes: { nombre: antes.nombre, precio: num(antes.precio_con_igv), estado: antes.estado }, despues: p.data }, ip: req.ip });
    return { id, ...p.data };
  });

  /* --------------------------------------------------------------- insumos */
  // Hoja 'insumos' (MAE-01): tipo, presentación de compra y equivalente en kg.
  const Insumo = z.object({
    nombre: texto(2, 120), unidad: z.enum(['KG', 'L', 'UNIDAD', 'BALON']), minimo: dinero,
    // Unidad en la que se lleva el stock; por defecto, la unidad base.
    unidadInventario: z.enum(['KG', 'GR', 'L', 'ML', 'UNIDAD', 'BALON']).optional(), proveedor: z.string().trim().max(120), activo: z.boolean().default(true),
    tipo: z.enum(['HARINA', 'GRASA', 'LACTEO', 'AZUCAR', 'LEVADURA', 'HUEVO', 'RELLENO', 'ADITIVO', 'LIQUIDO', 'OTRO']).default('OTRO'),
    presentacion: z.string().trim().max(60).default(''),
    precioCompra: z.number().min(0).max(1_000_000).nullable().default(null),
    cantPresentacion: z.number().positive().max(1_000_000).nullable().default(null),
    // Densidad (kg por unidad base): obligatoria si la unidad de inventario es de otra familia (RN-03).
    equivKg: z.number().positive().max(1000).nullable().default(null),
  }).refine((d) => d.precioCompra === null || d.cantPresentacion !== null, { message: 'Indica la cantidad por presentación', path: ['cantPresentacion'] });
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
  const unidades = async (d: { unidad: string; unidadInventario?: string; equivKg: number | null }):
    Promise<{ error: string } | { unidadInventario: string; densidad: number; factor: number }> => {
    const unidadInventario = d.unidadInventario ?? d.unidad;
    const fam = await q<{ codigo: string; familia: string }>('SELECT codigo, familia FROM core.unidad_medida WHERE codigo = ANY($1)', [[d.unidad, unidadInventario]]);
    const misma = fam.find((x) => x.codigo === d.unidad)?.familia === fam.find((x) => x.codigo === unidadInventario)?.familia;
    if (!misma && d.equivKg === null) return { error: `Para llevar el stock en ${unidadInventario} comprando en ${d.unidad} indica la densidad (${unidadInventario === 'KG' ? 'kg' : unidadInventario} por ${d.unidad}).` };
    const densidad = d.equivKg ?? 1;
    const factor = num((await uno<{ f: string | null }>('SELECT core.factor_unidades($1, $2, $3) f', [d.unidad, unidadInventario, densidad]))?.f ?? '0');
    if (!(factor > 0)) return { error: `No hay conversión de ${d.unidad} a ${unidadInventario}.` };
    return { unidadInventario, densidad, factor };
  };

  app.post('/insumos', { preHandler: autenticar }, async (req, reply) => {
    if (!editaInsumos(req, reply)) return;
    const p = Insumo.safeParse(req.body);
    if (!p.success) return invalido(reply, p.error);
    const u = await unidades(p.data);
    if ('error' in u) return reply.code(422).send(error(422, 'SIN_DENSIDAD', u.error));
    // El costo inicial entra con la primera compra (Almacén → Registrar movimiento), que fija el CPP.
    const f = await uno<{ id: string; codigo: string }>(
      `INSERT INTO core.insumo (codigo, nombre, unidad, minimo, proveedor, cpp, stock, tipo, presentacion, precio_compra, cant_presentacion, equiv_kg, unidad_inventario)
       VALUES ('INS-' || lpad((SELECT coalesce(max(substring(codigo from 5)::int), 0) + 1 FROM core.insumo WHERE codigo ~ '^INS-[0-9]+$')::text, 3, '0'),
               $1, $2, $3, $4, coalesce($9::numeric / $12::numeric, 0), 0, $5, $6, $7, $8, $10, $11) RETURNING id, codigo`,
      [p.data.nombre, p.data.unidad, p.data.minimo, p.data.proveedor, p.data.tipo, p.data.presentacion, p.data.precioCompra, p.data.cantPresentacion, costoReferencia(p.data),
        u.densidad, u.unidadInventario, u.factor]);
    await auditar({ ...actor(req), accion: 'INSUMO_CREADO', entidad: 'insumo', entidadId: f!.id, detalle: p.data, ip: req.ip });
    return reply.code(201).send({ ...f, ...p.data });
  });

  app.patch('/insumos/:id', { preHandler: autenticar }, async (req, reply) => {
    if (!editaInsumos(req, reply)) return;
    const { id } = req.params as { id: string };
    const p = Insumo.safeParse(req.body);
    if (!p.success) return invalido(reply, p.error);
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
                         estado = CASE WHEN stock < $4 THEN 'BAJO_MINIMO' ELSE 'OK' END, actualizado_en = now()
                       WHERE id=$1 RETURNING id`, [id, p.data.nombre, p.data.unidad, p.data.minimo, p.data.proveedor, p.data.activo,
                         p.data.tipo, p.data.presentacion, p.data.precioCompra, p.data.cantPresentacion, u.densidad, costoReferencia(p.data), u.unidadInventario, u.factor]);
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
    lineas: z.array(z.object({ insumoId: z.string().uuid(), cantidad: z.number().positive().max(100_000), unidad: z.enum(['GR', 'KG', 'ML', 'L', 'UNID', 'UNIDAD']).optional() })).min(1).max(40),
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
        const conv = new Map((await c.query<{ unidad_receta: string; unidad_base: string; factor: string }>('SELECT * FROM core.unidad_conversion')).rows
          .map((x) => [x.unidad_receta, x]));
        for (const l of p.data.lineas) {
          const i = mapa.get(l.insumoId)!;
          const unidad = l.unidad ?? i.unidad;
          const cv = conv.get(unidad);
          // Unidad compatible: gr/kg con insumos en KG, ml/L con L, unidades con UNIDAD.
          const base = cv?.unidad_base === 'UNID' ? 'UNIDAD' : cv?.unidad_base;
          if (unidad !== i.unidad && base !== (i.unidad === 'UNID' ? 'UNIDAD' : i.unidad)) {
            throw Object.assign(new Error(`${i.nombre} se mide en ${i.unidad}: no acepta ${unidad}.`), { status: 422 });
          }
          const cantidad = unidad === i.unidad ? l.cantidad : l.cantidad * Number(cv!.factor);
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
  const Cif = z.object({
    concepto: texto(2, 80), tipo: z.enum(['FIJO', 'VARIABLE']), montoMensual: dinero, activo: z.boolean().default(true),
    categoria: z.enum(['CIF', 'GASTO']).default('CIF'), baseReparto: z.enum(['HORAS_HORNO', 'KG_MASA', 'UNIDADES']).default('UNIDADES'),
  });

  // Tarifas del período abierto (W31): hora hombre, horno, kg de masa y por pan.
  const tarifasVigentes = async () => {
    const t = await uno<Record<string, string>>(`SELECT costo_hora_hombre, tarifa_hora_horno, tarifa_kg_masa, tarifa_unidad, horas_horno_mes, kg_masa_mes, unidades_mes
      FROM core.periodo_costos WHERE estado <> 'CERRADO' ORDER BY anio DESC, mes DESC LIMIT 1`);
    return t ? Object.fromEntries(Object.entries(t).map(([k, v]) => [k.replace(/_([a-z])/g, (_, l) => l.toUpperCase()), v === null ? null : num(v)])) : null;
  };

  const resumenCif = async () => {
    const [items, base, unidades] = await Promise.all([
      q<Record<string, string>>('SELECT id, concepto, tipo, monto_mensual, activo, categoria, base_reparto FROM core.costo_indirecto ORDER BY activo DESC, monto_mensual DESC'),
      uno<{ valor: string }>("SELECT valor FROM core.parametro WHERE clave = 'cif_base_prorrateo'"),
      uno<{ cif: string }>("SELECT coalesce(avg(cif_unitario),0) cif FROM core.receta WHERE estado = 'VIGENTE'"),
    ]);
    return {
      items: items.map((i) => ({ id: i.id, concepto: i.concepto, tipo: i.tipo, montoMensual: num(i.monto_mensual), activo: Boolean(i.activo), categoria: i.categoria, baseReparto: i.base_reparto })),
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
      await conRecalculo(async (c) => { await c.query('INSERT INTO core.costo_indirecto (concepto, tipo, monto_mensual, activo, categoria, base_reparto) VALUES ($1,$2,$3,$4,$5,$6)', [p.data.concepto, p.data.tipo, p.data.montoMensual, p.data.activo, p.data.categoria, p.data.baseReparto]); });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return reply.code(409).send(error(409, 'DUPLICADO', 'Ya existe un concepto activo con ese nombre.'));
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
    await conRecalculo(async (c) => {
      existe = !!(await c.query('UPDATE core.costo_indirecto SET concepto=$2, tipo=$3, monto_mensual=$4, activo=$5, categoria=$6, base_reparto=$7, actualizado_en=now() WHERE id=$1 RETURNING id',
        [id, p.data.concepto, p.data.tipo, p.data.montoMensual, p.data.activo, p.data.categoria, p.data.baseReparto])).rowCount;
    });
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
