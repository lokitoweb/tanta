import type { FastifyInstance, FastifyReply } from 'fastify';
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
  const Producto = z.object({
    nombre: texto(2, 120), categoriaId: texto(1, 40), unidad: texto(1, 20),
    precioConIgv: z.number().positive().max(100_000), estado: z.enum(['ACTIVO', 'INACTIVO']),
  });

  app.patch('/productos/:id', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'maestros.editar')) return;
    const { id } = req.params as { id: string };
    const p = Producto.safeParse(req.body);
    if (!p.success) return invalido(reply, p.error);
    const antes = await uno<Record<string, string>>('SELECT nombre, precio_con_igv, estado FROM core.producto WHERE id = $1', [id]);
    if (!antes) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'El producto no existe.'));
    if (!(await uno('SELECT 1 FROM core.categoria WHERE id = $1', [p.data.categoriaId]))) return reply.code(422).send(error(422, 'CATEGORIA_INEXISTENTE', 'La categoría no existe.'));
    await q('UPDATE core.producto SET nombre=$2, categoria_id=$3, unidad=$4, precio_con_igv=$5, estado=$6 WHERE id=$1',
      [id, p.data.nombre, p.data.categoriaId, p.data.unidad, p.data.precioConIgv.toFixed(4), p.data.estado]);
    await auditar({ ...actor(req), accion: 'PRODUCTO_EDITADO', entidad: 'producto', entidadId: id,
      detalle: { antes: { nombre: antes.nombre, precio: num(antes.precio_con_igv), estado: antes.estado }, despues: p.data }, ip: req.ip });
    return { id, ...p.data };
  });

  /* --------------------------------------------------------------- insumos */
  const Insumo = z.object({ nombre: texto(2, 120), unidad: texto(1, 20), minimo: dinero, proveedor: z.string().trim().max(120), activo: z.boolean().default(true) });

  app.post('/insumos', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'maestros.editar')) return;
    const p = Insumo.safeParse(req.body);
    if (!p.success) return invalido(reply, p.error);
    // El costo inicial entra con la primera compra (Almacén → Registrar movimiento), que fija el CPP.
    const f = await uno<{ id: string; codigo: string }>(
      `INSERT INTO core.insumo (codigo, nombre, unidad, minimo, proveedor, cpp, stock)
       VALUES ('INS-' || lpad((SELECT coalesce(max(substring(codigo from 5)::int), 0) + 1 FROM core.insumo WHERE codigo ~ '^INS-[0-9]+$')::text, 3, '0'),
               $1, $2, $3, $4, 0, 0) RETURNING id, codigo`,
      [p.data.nombre, p.data.unidad.toUpperCase(), p.data.minimo, p.data.proveedor]);
    await auditar({ ...actor(req), accion: 'INSUMO_CREADO', entidad: 'insumo', entidadId: f!.id, detalle: p.data, ip: req.ip });
    return reply.code(201).send({ ...f, ...p.data });
  });

  app.patch('/insumos/:id', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'maestros.editar')) return;
    const { id } = req.params as { id: string };
    const p = Insumo.safeParse(req.body);
    if (!p.success) return invalido(reply, p.error);
    if (!p.data.activo && await uno("SELECT 1 FROM core.receta_detalle d JOIN core.receta r ON r.id = d.receta_id WHERE d.insumo_id = $1 AND r.estado = 'VIGENTE'", [id])) {
      return reply.code(409).send(error(409, 'INSUMO_EN_USO', 'El insumo está en una receta vigente: quítalo de la receta antes de desactivarlo.'));
    }
    const r = await q(`UPDATE core.insumo SET nombre=$2, unidad=$3, minimo=$4, proveedor=$5, activo=$6,
                         estado = CASE WHEN stock < $4 THEN 'BAJO_MINIMO' ELSE 'OK' END, actualizado_en = now()
                       WHERE id=$1 RETURNING id`, [id, p.data.nombre, p.data.unidad.toUpperCase(), p.data.minimo, p.data.proveedor, p.data.activo]);
    if (!r.length) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'El insumo no existe.'));
    await auditar({ ...actor(req), accion: 'INSUMO_EDITADO', entidad: 'insumo', entidadId: id, detalle: p.data, ip: req.ip });
    return { id, ...p.data };
  });

  /* --------------------------------------------------------------- recetas */
  // Cambiar una receta crea una versión nueva: las ventas pasadas conservan su costo congelado.
  const Receta = z.object({
    rendimiento: z.number().positive().max(100_000),
    mermaEstandar: pct,
    lineas: z.array(z.object({ insumoId: z.string().uuid(), cantidad: z.number().positive().max(100_000) })).min(1).max(40),
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
          await c.query(`INSERT INTO core.receta_detalle (receta_id, insumo_id, insumo, unidad, cantidad, cpp, costo, orden)
                         VALUES ($1,$2,$3,$4,$5,$6,$5::numeric * $6::numeric,$7)`,
            [productoId, i.id, i.nombre, i.unidad, l.cantidad, i.cpp, orden++]);
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
  }).refine((c) => c.docTipo !== 'DNI' || c.docNumero === '' || /^\d{8}$/.test(c.docNumero), { message: 'El DNI tiene 8 dígitos', path: ['docNumero'] })
    .refine((c) => c.docTipo !== 'RUC' || c.docNumero === '' || /^(10|15|17|20)\d{9}$/.test(c.docNumero), { message: 'El RUC tiene 11 dígitos y empieza en 10, 15, 17 o 20', path: ['docNumero'] });

  app.get('/clientes', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'clientes.gestionar')) return;
    const filas = await q<Record<string, string>>(`
      SELECT c.id, c.codigo, c.nombre, c.doc_tipo, coalesce(c.doc_numero,'') doc_numero, coalesce(c.telefono,'') telefono,
             c.email, c.direccion, c.lista_precio, c.dias_credito, c.limite_credito, c.estado,
             coalesce((SELECT sum(saldo) FROM core.cuenta_por_cobrar x WHERE x.cliente_id = c.id AND x.estado IN ('PENDIENTE','PARCIAL')), 0) saldo,
             EXISTS (SELECT 1 FROM core.usuario u WHERE u.cliente_id = c.id) usa_app
      FROM core.cliente c ORDER BY c.nombre`);
    return filas.map((f) => ({
      id: f.id, codigo: f.codigo, nombre: f.nombre, docTipo: f.doc_tipo, docNumero: f.doc_numero, telefono: f.telefono, email: f.email,
      direccion: f.direccion, listaPrecio: f.lista_precio, diasCredito: num(f.dias_credito), limiteCredito: num(f.limite_credito),
      estado: f.estado, saldo: num(f.saldo), usaApp: Boolean(f.usa_app),
    }));
  });

  app.post('/clientes', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'clientes.gestionar')) return;
    const p = Cliente.safeParse(req.body);
    if (!p.success) return invalido(reply, p.error);
    const d = p.data;
    const f = await uno<{ id: string; codigo: string }>(
      `INSERT INTO core.cliente (codigo, nombre, doc_tipo, doc_numero, telefono, email, direccion, lista_precio, dias_credito, limite_credito, estado)
       VALUES ('CLI-' || lpad((SELECT coalesce(max(substring(codigo from 5)::int), 0) + 1 FROM core.cliente WHERE codigo ~ '^CLI-[0-9]+$')::text, 4, '0'),
               $1,$2,NULLIF($3,''),NULLIF($4,''),$5,$6,$7,$8,$9,$10) RETURNING id, codigo`,
      [d.nombre, d.docTipo, d.docNumero, d.telefono, d.email, d.direccion, d.listaPrecio, d.diasCredito, d.limiteCredito, d.estado]);
    await auditar({ ...actor(req), accion: 'CLIENTE_CREADO', entidad: 'cliente', entidadId: f!.id, detalle: { nombre: d.nombre, limiteCredito: d.limiteCredito }, ip: req.ip });
    return reply.code(201).send({ ...f, ...d });
  });

  app.patch('/clientes/:id', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'clientes.gestionar')) return;
    const { id } = req.params as { id: string };
    const p = Cliente.safeParse(req.body);
    if (!p.success) return invalido(reply, p.error);
    const d = p.data;
    const r = await q(`UPDATE core.cliente SET nombre=$2, doc_tipo=$3, doc_numero=NULLIF($4,''), telefono=NULLIF($5,''), email=$6, direccion=$7,
                         lista_precio=$8, dias_credito=$9, limite_credito=$10, estado=$11 WHERE id=$1 RETURNING id`,
      [id, d.nombre, d.docTipo, d.docNumero, d.telefono, d.email, d.direccion, d.listaPrecio, d.diasCredito, d.limiteCredito, d.estado]);
    if (!r.length) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'El cliente no existe.'));
    await auditar({ ...actor(req), accion: 'CLIENTE_EDITADO', entidad: 'cliente', entidadId: id, detalle: { nombre: d.nombre, limiteCredito: d.limiteCredito, estado: d.estado }, ip: req.ip });
    return { id, ...d };
  });

  /* ---------------------------------------------------- costos indirectos */
  const Cif = z.object({ concepto: texto(2, 80), tipo: z.enum(['FIJO', 'VARIABLE']), montoMensual: dinero, activo: z.boolean().default(true) });

  const resumenCif = async () => {
    const [items, base, unidades] = await Promise.all([
      q<Record<string, string>>('SELECT id, concepto, tipo, monto_mensual, activo FROM core.costo_indirecto ORDER BY activo DESC, monto_mensual DESC'),
      uno<{ valor: string }>("SELECT valor FROM core.parametro WHERE clave = 'cif_base_prorrateo'"),
      uno<{ cif: string }>("SELECT coalesce(avg(cif_unitario),0) cif FROM core.receta WHERE estado = 'VIGENTE'"),
    ]);
    return {
      items: items.map((i) => ({ id: i.id, concepto: i.concepto, tipo: i.tipo, montoMensual: num(i.monto_mensual), activo: Boolean(i.activo) })),
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
      await conRecalculo(async (c) => { await c.query('INSERT INTO core.costo_indirecto (concepto, tipo, monto_mensual, activo) VALUES ($1,$2,$3,$4)', [p.data.concepto, p.data.tipo, p.data.montoMensual, p.data.activo]); });
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
      existe = !!(await c.query('UPDATE core.costo_indirecto SET concepto=$2, tipo=$3, monto_mensual=$4, activo=$5, actualizado_en=now() WHERE id=$1 RETURNING id',
        [id, p.data.concepto, p.data.tipo, p.data.montoMensual, p.data.activo])).rowCount;
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
