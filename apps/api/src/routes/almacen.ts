import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, tx, uno, num } from '../db.js';
import { autenticar, exigir, error } from '../seguridad.js';
import { auditar } from '../auditoria.js';
import { invalidar } from '../cache.js';
import { emitirEvento, enviarPush } from './sistema.js';

/**
 * Almacén del INF-TEC-001 (M05): proveedores (MAE-09), compras con documento y costo promedio ponderado,
 * y conteo físico cuyas diferencias solo se ajustan con la aprobación del Gerente.
 */

const fallo = (status: number, mensaje: string) => Object.assign(new Error(mensaje), { status });
const actor = (req: { usuario?: { id: string; nombre: string; rol: string } | null; ip: string }) =>
  ({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, ip: req.ip });

/** Ejecuta fn y traduce los errores previstos (con status) a la respuesta de la API. */
async function responder<T>(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, codigo: string, fn: () => Promise<T>) {
  try { return await fn(); } catch (e) {
    const err = e as Error & { status?: number; code?: string };
    if (err.code === '23505') return reply.code(409).send(error(409, 'DUPLICADO', 'Ya existe un registro con esos datos.'));
    if (!err.status) throw e;
    return reply.code(err.status).send(error(err.status, codigo, err.message));
  }
}

export async function rutasAlmacen(app: FastifyInstance) {
  /* ------------------------------------------------------------ proveedores */
  const Proveedor = z.object({
    ruc: z.union([z.literal(''), z.string().trim().regex(/^(10|15|17|20)\d{9}$/, 'El RUC tiene 11 dígitos y empieza en 10, 15, 17 o 20')]).default(''),
    razonSocial: z.string().trim().min(2).max(160),
    contacto: z.string().trim().max(120).default(''),
    telefono: z.string().trim().max(30).regex(/^[0-9+ ()-]*$/, 'Teléfono inválido').default(''),
    email: z.union([z.literal(''), z.string().trim().email().max(160)]).default(''),
    estado: z.enum(['ACTIVO', 'INACTIVO']).default('ACTIVO'),
  });

  app.get('/proveedores', { preHandler: autenticar }, async (req, reply) => {
    if (!['proveedores.gestionar', 'compras.registrar', 'maestros.ver'].some((x) => req.usuario!.permisos.has(x)))
      return reply.code(403).send(error(403, 'SIN_PERMISO', 'Falta el permiso proveedores.gestionar.'));
    const filas = await q<Record<string, string>>(`
      SELECT p.id, coalesce(p.ruc, '') ruc, p.razon_social, p.contacto, p.telefono, p.email, p.estado,
             (SELECT string_agg(i.nombre, ', ' ORDER BY i.nombre) FROM core.insumo i WHERE i.proveedor_id = p.id) insumos,
             (SELECT count(*) FROM core.compra c WHERE c.proveedor_id = p.id) compras
      FROM core.proveedor p ORDER BY p.estado, p.razon_social`);
    return filas.map((f) => ({ id: f.id, ruc: f.ruc, razonSocial: f.razon_social, contacto: f.contacto, telefono: f.telefono, email: f.email,
      estado: f.estado, insumos: f.insumos ?? '', compras: num(f.compras) }));
  });

  app.post('/proveedores', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'proveedores.gestionar')) return;
    const p = Proveedor.safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues[0]?.message ?? 'Proveedor inválido.'));
    const d = p.data;
    return responder(reply, 'PROVEEDOR_INVALIDO', async () => {
      const r = await uno<{ id: string }>(`INSERT INTO core.proveedor (ruc, razon_social, contacto, telefono, email, estado)
        VALUES (NULLIF($1,''),$2,$3,$4,$5,$6) RETURNING id`, [d.ruc, d.razonSocial, d.contacto, d.telefono, d.email, d.estado]);
      await auditar({ ...actor(req), accion: 'PROVEEDOR_CREADO', entidad: 'proveedor', entidadId: r!.id, detalle: { ruc: d.ruc, razonSocial: d.razonSocial } });
      return reply.code(201).send({ id: r!.id, ...d });
    });
  });

  app.patch('/proveedores/:id', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'proveedores.gestionar')) return;
    const { id } = req.params as { id: string };
    const p = Proveedor.safeParse(req.body);
    if (!p.success || !z.string().uuid().safeParse(id).success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error?.issues[0]?.message ?? 'Proveedor inválido.'));
    const d = p.data;
    return responder(reply, 'PROVEEDOR_INVALIDO', async () => {
      const r = await q(`UPDATE core.proveedor SET ruc = NULLIF($2,''), razon_social = $3, contacto = $4, telefono = $5, email = $6, estado = $7
        WHERE id = $1 RETURNING id`, [id, d.ruc, d.razonSocial, d.contacto, d.telefono, d.email, d.estado]);
      if (!r.length) throw fallo(404, 'El proveedor no existe.');
      await auditar({ ...actor(req), accion: 'PROVEEDOR_EDITADO', entidad: 'proveedor', entidadId: id, detalle: { razonSocial: d.razonSocial, estado: d.estado } });
      return { id, ...d };
    });
  });

  // MAE-09: un proveedor con compras no se borra, solo se inactiva.
  app.delete('/proveedores/:id', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'proveedores.gestionar')) return;
    const { id } = req.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Proveedor inválido.'));
    if (await uno('SELECT 1 FROM core.compra WHERE proveedor_id = $1 LIMIT 1', [id]))
      return reply.code(409).send(error(409, 'TIENE_COMPRAS', 'El proveedor tiene compras: inactívalo en lugar de eliminarlo.'));
    await q('UPDATE core.insumo SET proveedor_id = NULL WHERE proveedor_id = $1', [id]);
    const r = await q('DELETE FROM core.proveedor WHERE id = $1 RETURNING id', [id]);
    if (!r.length) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'El proveedor no existe.'));
    await auditar({ ...actor(req), accion: 'PROVEEDOR_ELIMINADO', entidad: 'proveedor', entidadId: id, detalle: {} });
    return reply.code(204).send();
  });

  /* ---------------------------------------------------------------- compras */
  const Compra = z.object({
    proveedorId: z.string().uuid(),
    docTipo: z.enum(['FACTURA', 'BOLETA', 'GUIA']),
    docNumero: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,20}$/, 'Número de documento inválido'),
    items: z.array(z.object({ insumoId: z.string().uuid(), cantidad: z.number().positive().max(1_000_000), precio: z.number().positive().max(100_000) }))
      .min(1).max(100).refine((l) => new Set(l.map((i) => i.insumoId)).size === l.length, 'Un insumo aparece dos veces'),
  });

  app.get('/compras', { preHandler: autenticar }, async (req, reply) => {
    if (!req.usuario!.permisos.has('compras.registrar') && !req.usuario!.permisos.has('costos.ver'))
      return reply.code(403).send(error(403, 'SIN_PERMISO', 'Falta el permiso compras.registrar.'));
    const filas = await q<Record<string, unknown>>(`
      SELECT c.codigo, (c.creado_en AT TIME ZONE 'America/Lima')::text fecha, p.razon_social proveedor, c.doc_tipo, c.doc_numero, c.total, u.nombre registrado_por,
             json_agg(json_build_object('insumo', i.nombre, 'unidad', i.unidad, 'cantidad', d.cantidad, 'precio', d.precio, 'cppAnterior', d.cpp_anterior, 'cppNuevo', d.cpp_nuevo) ORDER BY i.nombre) items
      FROM core.compra c JOIN core.proveedor p ON p.id = c.proveedor_id JOIN core.compra_detalle d ON d.compra_id = c.id JOIN core.insumo i ON i.id = d.insumo_id
      LEFT JOIN core.usuario u ON u.id = c.registrado_por
      GROUP BY c.id, p.razon_social, u.nombre ORDER BY c.creado_en DESC LIMIT 200`);
    return filas.map((f) => ({ codigo: f.codigo, fecha: String(f.fecha).slice(0, 16), proveedor: f.proveedor, documento: `${f.doc_tipo} ${f.doc_numero}`, total: num(f.total as string),
      registradoPor: f.registrado_por, items: (f.items as Array<Record<string, string>>).map((i) => ({ ...i, cantidad: num(i.cantidad), precio: num(i.precio), cppAnterior: num(i.cppAnterior), cppNuevo: num(i.cppNuevo) })) }));
  });

  app.post('/compras', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'compras.registrar')) return;
    const p = Compra.safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues[0]?.message ?? 'Compra inválida.'));
    const d = p.data;
    const clave = req.headers['idempotency-key'] as string | undefined;
    if (clave) {
      const previa = await uno<{ codigo: string; total: string }>('SELECT codigo, total FROM core.compra WHERE idempotency_key = $1', [clave]);
      if (previa) return reply.code(201).send({ codigo: previa.codigo, total: num(previa.total), lineas: [] });
    }
    return responder(reply, 'COMPRA_INVALIDA', async () => {
      const r = await tx(async (c) => {
        const prov = (await c.query<{ razon_social: string; estado: string }>('SELECT razon_social, estado FROM core.proveedor WHERE id = $1', [d.proveedorId])).rows[0];
        if (!prov) throw fallo(404, 'El proveedor no existe.');
        if (prov.estado !== 'ACTIVO') throw fallo(409, 'El proveedor está inactivo.');
        if ((await c.query('SELECT 1 FROM core.compra WHERE proveedor_id = $1 AND doc_tipo = $2 AND doc_numero = $3', [d.proveedorId, d.docTipo, d.docNumero])).rowCount)
          throw fallo(409, `El documento ${d.docTipo} ${d.docNumero} de este proveedor ya fue registrado.`);
        const total = Number(d.items.reduce((s, i) => s + i.cantidad * i.precio, 0).toFixed(2));
        const codigo = `COM-${String(num((await c.query<{ n: string }>(`SELECT coalesce(max(substring(codigo from 5)::int), 0) + 1 n FROM core.compra WHERE codigo ~ '^COM-[0-9]+$'`)).rows[0].n)).padStart(5, '0')}`;
        const compra = (await c.query<{ id: string }>(`INSERT INTO core.compra (codigo, proveedor_id, doc_tipo, doc_numero, total, registrado_por, idempotency_key)
          VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [codigo, d.proveedorId, d.docTipo, d.docNumero, total.toFixed(2), req.usuario!.id, clave ?? null])).rows[0];
        const documento = `${d.docTipo} ${d.docNumero} · ${prov.razon_social}`.slice(0, 200);
        const lineas = [];
        // Orden fijo de bloqueo: dos compras simultáneas no se bloquean entre sí.
        for (const it of [...d.items].sort((a, b) => a.insumoId.localeCompare(b.insumoId))) {
          const ins = (await c.query<{ nombre: string; stock: string; cpp: string }>('SELECT nombre, stock, cpp FROM core.insumo WHERE id = $1 FOR UPDATE', [it.insumoId])).rows[0];
          if (!ins) throw fallo(404, 'Un insumo de la compra no existe.');
          const saldo = Math.max(num(ins.stock), 0), cpp = num(ins.cpp);
          // Costo promedio ponderado: (saldo·cpp + compra·precio) / (saldo + compra).
          const nuevoCpp = (saldo * cpp + it.cantidad * it.precio) / (saldo + it.cantidad);
          const nuevoSaldo = num(ins.stock) + it.cantidad;
          await c.query(`INSERT INTO core.movimiento_inventario
              (tipo,item_tipo,insumo_id,documento,cantidad,costo_unitario,valor,saldo_cantidad,saldo_valor,cpp,registrado_por)
            VALUES ('COMPRA','INSUMO',$1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [it.insumoId, documento, it.cantidad.toFixed(6), it.precio.toFixed(6), (it.cantidad * it.precio).toFixed(4), nuevoSaldo.toFixed(6),
              (nuevoSaldo * nuevoCpp).toFixed(4), nuevoCpp.toFixed(6), req.usuario!.id]);
          await c.query('UPDATE core.insumo SET stock = $1, cpp = $2, actualizado_en = now() WHERE id = $3', [nuevoSaldo.toFixed(6), nuevoCpp.toFixed(6), it.insumoId]);
          await c.query('INSERT INTO core.compra_detalle (compra_id, insumo_id, cantidad, precio, cpp_anterior, cpp_nuevo) VALUES ($1,$2,$3,$4,$5,$6)',
            [compra.id, it.insumoId, it.cantidad.toFixed(6), it.precio.toFixed(6), cpp.toFixed(6), nuevoCpp.toFixed(6)]);
          lineas.push({ insumo: ins.nombre, cantidad: it.cantidad, precio: it.precio, cppAnterior: Number(cpp.toFixed(4)), cppNuevo: Number(nuevoCpp.toFixed(4)), saldo: Number(nuevoSaldo.toFixed(3)) });
        }
        await c.query('SELECT core.recalcular_costos()');
        return { codigo, total, lineas };
      });
      invalidar('cat:');
      void emitirEvento('compra.registrada', r);
      await auditar({ ...actor(req), accion: 'COMPRA_REGISTRADA', entidad: 'compra', entidadId: r.codigo, detalle: { proveedorId: d.proveedorId, documento: `${d.docTipo} ${d.docNumero}`, total: r.total } });
      return reply.code(201).send(r);
    });
  });

  /* ------------------------------------------------------------ conteo físico */
  app.get('/conteos', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'inventario.ver')) return;
    const valoriza = req.usuario!.permisos.has('costos.ver') || req.usuario!.permisos.has('conteo.aprobar');
    const filas = await q<Record<string, unknown>>(`
      SELECT k.id, k.codigo, k.estado, k.observacion, k.motivo_rechazo, k.creado_en::text, u.nombre registrado_por, r.nombre resuelto_por,
             json_agg(json_build_object('insumo', i.nombre, 'unidad', i.unidad, 'sistema', d.stock_sistema, 'contado', d.contado, 'cpp', i.cpp) ORDER BY i.nombre) items
      FROM core.conteo k JOIN core.conteo_detalle d ON d.conteo_id = k.id JOIN core.insumo i ON i.id = d.insumo_id
      LEFT JOIN core.usuario u ON u.id = k.registrado_por LEFT JOIN core.usuario r ON r.id = k.resuelto_por
      GROUP BY k.id, u.nombre, r.nombre ORDER BY (k.estado = 'PENDIENTE') DESC, k.creado_en DESC LIMIT 100`);
    return filas.map((f) => ({
      id: f.id, codigo: f.codigo, estado: f.estado, observacion: f.observacion, motivoRechazo: f.motivo_rechazo, fecha: f.creado_en,
      registradoPor: f.registrado_por, resueltoPor: f.resuelto_por,
      items: (f.items as Array<Record<string, string>>).map((i) => {
        const diferencia = Number((num(i.contado) - num(i.sistema)).toFixed(6));
        return { insumo: i.insumo, unidad: i.unidad, sistema: num(i.sistema), contado: num(i.contado), diferencia, ...(valoriza ? { valor: Number((diferencia * num(i.cpp)).toFixed(2)) } : {}) };
      }),
    }));
  });

  const Conteo = z.object({
    observacion: z.string().trim().max(200).default(''),
    items: z.array(z.object({ insumoId: z.string().uuid(), contado: z.number().min(0).max(1_000_000) })).min(1).max(500)
      .refine((l) => new Set(l.map((i) => i.insumoId)).size === l.length, 'Un insumo aparece dos veces'),
  });

  // El Almacén registra lo contado; el stock del sistema se congela en ese momento para la comparación.
  app.post('/conteos', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'inventario.mover')) return;
    const p = Conteo.safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error.issues[0]?.message ?? 'Conteo inválido.'));
    return responder(reply, 'CONTEO_INVALIDO', async () => {
    const r = await tx(async (c) => {
      const codigo = `CNT-${String(num((await c.query<{ n: string }>(`SELECT coalesce(max(substring(codigo from 5)::int), 0) + 1 n FROM core.conteo WHERE codigo ~ '^CNT-[0-9]+$'`)).rows[0].n)).padStart(5, '0')}`;
      const k = (await c.query<{ id: string }>('INSERT INTO core.conteo (codigo, observacion, registrado_por) VALUES ($1,$2,$3) RETURNING id', [codigo, p.data.observacion, req.usuario!.id])).rows[0];
      let diferencias = 0;
      for (const it of p.data.items) {
        const ins = (await c.query<{ stock: string }>('SELECT stock FROM core.insumo WHERE id = $1', [it.insumoId])).rows[0];
        if (!ins) throw fallo(404, 'Un insumo del conteo no existe.');
        if (Math.abs(num(ins.stock) - it.contado) > 0.000001) diferencias++;
        await c.query('INSERT INTO core.conteo_detalle (conteo_id, insumo_id, stock_sistema, contado) VALUES ($1,$2,$3,$4)', [k.id, it.insumoId, ins.stock, it.contado.toFixed(6)]);
      }
      return { id: k.id, codigo, diferencias };
    });
    await auditar({ ...actor(req), accion: 'CONTEO_REGISTRADO', entidad: 'conteo', entidadId: r.codigo, detalle: { items: p.data.items.length, diferencias: r.diferencias } });
    void q<{ id: string }>(`SELECT DISTINCT ur.usuario_id id FROM core.usuario_rol ur JOIN core.rol_permiso rp ON rp.rol_id = ur.rol_id WHERE rp.permiso_id = 'conteo.aprobar'`)
      .then((us) => us.forEach((u) => void enviarPush(u.id, 'Conteo por aprobar', `${r.codigo}: ${r.diferencias} diferencia(s)`).catch(() => {}))).catch(() => {});
    return reply.code(201).send({ ...r, estado: 'PENDIENTE' });
    });
  });

  // Aprobar = ajustar cada insumo por la diferencia contada (contado − sistema al contar), sin pisar los movimientos posteriores.
  app.post('/conteos/:id/resolver', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'conteo.aprobar')) return;
    const { id } = req.params as { id: string };
    const p = z.object({ aprobar: z.boolean(), motivo: z.string().trim().max(200).default('') })
      .refine((d) => d.aprobar || d.motivo.length >= 3, { message: 'Indica el motivo del rechazo.' }).safeParse(req.body);
    if (!p.success || !z.string().uuid().safeParse(id).success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', p.error?.issues[0]?.message ?? 'Solicitud inválida.'));
    return responder(reply, 'CONTEO_INVALIDO', async () => {
      const r = await tx(async (c) => {
        const k = (await c.query<{ codigo: string; registrado_por: string }>(`UPDATE core.conteo SET estado = $2, resuelto_por = $3, resuelto_en = now(), motivo_rechazo = NULLIF($4,'')
          WHERE id = $1 AND estado = 'PENDIENTE' RETURNING codigo, registrado_por`, [id, p.data.aprobar ? 'APROBADO' : 'RECHAZADO', req.usuario!.id, p.data.motivo])).rows[0];
        if (!k) throw fallo(409, 'El conteo ya fue resuelto o no existe.');
        let ajustes = 0;
        if (p.data.aprobar) {
          const lineas = (await c.query<{ insumo_id: string; stock_sistema: string; contado: string }>(
            'SELECT insumo_id, stock_sistema, contado FROM core.conteo_detalle WHERE conteo_id = $1 ORDER BY insumo_id', [id])).rows;
          for (const l of lineas) {
            const delta = num(l.contado) - num(l.stock_sistema);
            if (Math.abs(delta) < 0.000001) continue;
            const ins = (await c.query<{ nombre: string; stock: string; cpp: string }>('SELECT nombre, stock, cpp FROM core.insumo WHERE id = $1 FOR UPDATE', [l.insumo_id])).rows[0];
            const nuevo = num(ins.stock) + delta, cpp = num(ins.cpp);
            if (nuevo < -0.000001) throw fallo(409, `${ins.nombre}: el ajuste dejaría stock negativo; vuelve a contar.`);
            await c.query(`INSERT INTO core.movimiento_inventario
                (tipo,item_tipo,insumo_id,documento,cantidad,costo_unitario,valor,saldo_cantidad,saldo_valor,cpp,registrado_por,motivo_tipo)
              VALUES ('AJUSTE','INSUMO',$1,$2,$3,$4,$5,$6,$7,$4,$8,'AJUSTE')`,
              [l.insumo_id, `Conteo ${k.codigo}`, delta.toFixed(6), cpp.toFixed(6), (delta * cpp).toFixed(4), nuevo.toFixed(6), (nuevo * cpp).toFixed(4), req.usuario!.id]);
            await c.query('UPDATE core.insumo SET stock = $1, actualizado_en = now() WHERE id = $2', [nuevo.toFixed(6), l.insumo_id]);
            ajustes++;
          }
        }
        return { codigo: k.codigo, registradoPor: k.registrado_por, ajustes };
      });
      invalidar('cat:');
      await auditar({ ...actor(req), accion: p.data.aprobar ? 'CONTEO_APROBADO' : 'CONTEO_RECHAZADO', entidad: 'conteo', entidadId: r.codigo, detalle: { ajustes: r.ajustes, motivo: p.data.motivo } });
      void enviarPush(r.registradoPor, 'Conteo', `${r.codigo} ${p.data.aprobar ? `aprobado: ${r.ajustes} ajuste(s)` : 'rechazado'}`).catch(() => {});
      return { codigo: r.codigo, estado: p.data.aprobar ? 'APROBADO' : 'RECHAZADO', ajustes: r.ajustes };
    });
  });
}
