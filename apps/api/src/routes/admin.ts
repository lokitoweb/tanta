import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { q, tx, uno, num } from '../db.js';
import { autenticar, exigir, error, hashClave, claveCorta } from '../seguridad.js';
import { auditar, verificarCadena, ultimoEvento } from '../auditoria.js';
import { invalidar } from '../cache.js';

/**
 * Administración del sistema.
 * Todo lo que el cliente puede cambiar sin tocar código: parámetros de negocio,
 * usuarios, precios y cierre de períodos de costo.
 */
/**
 * Jerarquía por core.rol.orden (0 = Superadmin, 1 = Gerente, 2 = Administrador…): solo se crea, asigna,
 * bloquea o restablece la clave de un rol de MENOR privilegio que el propio. El Superadmin gestiona todo.
 * Evita que un Administrador se fabrique un Gerente o tome la cuenta de uno.
 */
async function protegeJerarquia(req: FastifyRequest, reply: FastifyReply, objetivo: { rol?: string; usuarioId?: string }) {
  if (req.usuario!.rol === 'SUPERADMIN') return true;
  const fila = await uno<{ ok: boolean }>(
    `SELECT coalesce((SELECT orden FROM core.rol WHERE id = coalesce($2, (SELECT rol_id FROM core.usuario_rol WHERE usuario_id::text = $3))), 2147483647)
           > (SELECT orden FROM core.rol WHERE id = $1) AS ok`,
    [req.usuario!.rol, objetivo.rol ?? null, objetivo.usuarioId ?? null]);
  if (fila?.ok) return true;
  reply.code(403).send(error(403, 'SIN_PERMISO', 'Solo puedes gestionar cuentas de un rol de menor nivel que el tuyo.'));
  return false;
}

export async function rutasAdmin(app: FastifyInstance) {
  /* ------------------------------------------------------- parámetros */
  const TIPOS = new Set(['texto', 'numero', 'porcentaje', 'booleano']);

  app.get('/parametros', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'parametros.gestionar')) return;
    const filas = await q<{ clave: string; valor: string; tipo: string; descripcion: string }>(
      'SELECT clave, valor, tipo, descripcion FROM core.parametro ORDER BY clave',
    );
    return reply.send(filas);
  });

  const Cambio = z.object({ valor: z.string().min(1).max(120) });

  app.patch('/parametros/:clave', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'parametros.gestionar')) return;
    const { clave } = req.params as { clave: string };
    const parseo = Cambio.safeParse(req.body);
    if (!parseo.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Valor inválido.'));

    const actual = await uno<{ valor: string; tipo: string }>(
      'SELECT valor, tipo FROM core.parametro WHERE clave = $1', [clave],
    );
    if (!actual) return reply.code(404).send(error(404, 'PARAMETRO_NO_EXISTE', 'El parámetro no existe.'));

    const nuevo = parseo.data.valor.trim();
    // Validación por tipo: un IGV de "abc" no puede llegar a la base.
    if (actual.tipo === 'porcentaje' || actual.tipo === 'numero') {
      const n = Number(nuevo.replace(',', '.'));
      if (!Number.isFinite(n)) {
        return reply.code(422).send(error(422, 'VALOR_NO_NUMERICO', 'Este parámetro debe ser numérico.'));
      }
      // Ningún parámetro numérico es negativo (un sueldo de -1500 daría mano de obra negativa) y los días se usan como enteros en SQL.
      if (n < 0) return reply.code(422).send(error(422, 'VALOR_INVALIDO', 'El valor no puede ser negativo.'));
      if (/(^|_)dias(_|$)/.test(clave) && !Number.isInteger(n)) return reply.code(422).send(error(422, 'VALOR_INVALIDO', 'Usa un número entero de días.'));
      if (actual.tipo === 'porcentaje' && (n < 0 || n > 1)) {
        return reply.code(422).send(error(422, 'PORCENTAJE_FUERA_DE_RANGO', 'El porcentaje debe estar entre 0 y 1 (0.18 = 18 %).'));
      }
    }
    if (clave === 'hora_corte_mismo_dia' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(nuevo)) {
      return reply.code(422).send(error(422, 'VALOR_INVALIDO', 'Usa el formato HH:MM de 24 horas, por ejemplo 03:00.'));
    }
    const RANGOS: Record<string, [number, number]> = { clave_longitud_minima: [5, 64], cliente_max_direcciones: [1, 20] };
    if (RANGOS[clave] && !(Number.isInteger(Number(nuevo)) && Number(nuevo) >= RANGOS[clave][0] && Number(nuevo) <= RANGOS[clave][1])) {
      return reply.code(422).send(error(422, 'VALOR_INVALIDO', `Usa un número entero de ${RANGOS[clave][0]} a ${RANGOS[clave][1]}.`));
    }
    if (clave === 'cif_base_prorrateo' && !['UNIDADES', 'COSTO_INSUMOS'].includes(nuevo.toUpperCase())) {
      return reply.code(422).send(error(422, 'VALOR_INVALIDO', 'Usa UNIDADES o COSTO_INSUMOS.'));
    }
    // Parámetros de fórmula con valores cerrados: un error de tipeo no puede cambiar el costeo.
    const OPCIONES: Record<string, string[]> = {
      formula_merma: ['MULTIPLICAR', 'DIVIDIR'], metodo_costo_insumo: ['PROMEDIO', 'ULTIMO'], costo_insumo_formulas: ['MANUAL', 'AUTOMATICO'],
    };
    if (OPCIONES[clave] && !OPCIONES[clave].includes(nuevo.toUpperCase())) {
      return reply.code(422).send(error(422, 'VALOR_INVALIDO', `Usa ${OPCIONES[clave].join(' o ')}.`));
    }
    if (actual.tipo === 'booleano' && !['true', 'false'].includes(nuevo.toLowerCase())) {
      return reply.code(422).send(error(422, 'BOOLEANO_INVALIDO', 'Usa true o false.'));
    }

    const cerrado = clave === 'cif_base_prorrateo' || Boolean(OPCIONES[clave]);
    // Parámetros que entran en la ficha de costo: se recostea en la misma transacción y el catálogo lo ve al instante.
    const recostea = ['cif_base_prorrateo', 'formula_merma', 'sueldo_base', 'factor_beneficios', 'horas_mes', 'costo_insumo_formulas', 'horas_horno_dia', 'dias_trabajados_mes'].includes(clave);
    await tx(async (c) => {
      await c.query('UPDATE core.parametro SET valor = $1 WHERE clave = $2', [cerrado ? nuevo.toUpperCase() : nuevo, clave]);
      // Pasar a AUTOMATICO: las fórmulas vuelven a seguir al kárdex (se descartan los costos fijados a mano).
      if (clave === 'costo_insumo_formulas' && nuevo.toUpperCase() === 'AUTOMATICO') await c.query('UPDATE core.insumo SET costo_formula = NULL WHERE costo_formula IS NOT NULL');
      if (recostea) await c.query('SELECT core.recalcular_costos()');
      await c.query(
        'INSERT INTO audit.parametro_historial (clave, valor_antes, valor_nuevo, usuario_id) VALUES ($1,$2,$3,$4)',
        [clave, actual.valor, nuevo, req.usuario!.id],
      );
    });
    await auditar({
      actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol,
      accion: 'PARAMETRO_CAMBIADO', entidad: 'parametro', entidadId: clave,
      detalle: { antes: actual.valor, despues: nuevo }, ip: req.ip,
    });
    invalidar('cat:');
    return reply.send({ clave, valor: cerrado ? nuevo.toUpperCase() : nuevo, tipo: actual.tipo });
  });

  /* ---------------------------------------------------------- usuarios */
  const NuevoUsuario = z.object({
    nombre: z.string().min(3).max(120),
    usuario: z.string().min(3).max(40).regex(/^[a-z0-9._-]+$/, 'Solo minúsculas, números, punto, guion y guion bajo.'),
    clave: z.string().min(1, 'Escribe la contraseña inicial.').max(128),
    rol: z.string().min(1),
    // Un usuario con rol Cliente se vincula a su ficha: así solo ve y pide lo suyo.
    clienteId: z.string().uuid().optional(),
  });

  app.post('/usuarios', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'usuarios.gestionar')) return;
    const parseo = NuevoUsuario.safeParse(req.body);
    if (!parseo.success) {
      return reply.code(422).send(error(422, 'DATOS_INVALIDOS', parseo.error.issues[0]?.message ?? 'Datos inválidos.'));
    }
    const d = parseo.data;
    const corta = await claveCorta(d.clave);
    if (corta) return reply.code(422).send(error(422, 'CLAVE_CORTA', corta));

    if (!(await protegeJerarquia(req, reply, { rol: d.rol }))) return;
    if (d.rol === 'CLIENTE' && !d.clienteId) return reply.code(422).send(error(422, 'SIN_CLIENTE', 'Elige la ficha de cliente de este usuario.'));
    const rolExiste = await uno('SELECT 1 FROM core.rol WHERE id = $1', [d.rol]);
    if (!rolExiste) return reply.code(422).send(error(422, 'ROL_INEXISTENTE', 'El rol indicado no existe.'));

    const existe = await uno('SELECT 1 FROM core.usuario WHERE lower(usuario) = lower($1)', [d.usuario]);
    if (existe) return reply.code(409).send(error(409, 'USUARIO_DUPLICADO', 'Ese nombre de usuario ya está en uso.'));

    const creado = await tx(async (c) => {
      const r = await c.query<{ id: string }>(
        'INSERT INTO core.usuario (nombre, usuario, clave_hash, cliente_id) VALUES ($1,$2,$3,$4) RETURNING id',
        [d.nombre, d.usuario.toLowerCase(), hashClave(d.clave), d.rol === 'CLIENTE' ? d.clienteId ?? null : null],
      );
      await c.query('INSERT INTO core.usuario_rol (usuario_id, rol_id) VALUES ($1,$2)', [r.rows[0].id, d.rol]);
      return r.rows[0].id;
    });

    await auditar({
      actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol,
      accion: 'USUARIO_CREADO', entidad: 'usuario', entidadId: creado,
      detalle: { usuario: d.usuario, rol: d.rol }, ip: req.ip,
    });
    return reply.code(201).send({ id: creado, usuario: d.usuario, rol: d.rol });
  });

  const Estado = z.object({ estado: z.enum(['ACTIVO', 'BLOQUEADO']) });

  app.patch('/usuarios/:id/estado', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'usuarios.gestionar')) return;
    const { id } = req.params as { id: string };
    const parseo = Estado.safeParse(req.body);
    if (!parseo.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Estado inválido.'));

    if (!(await protegeJerarquia(req, reply, { usuarioId: id }))) return;
    if (id === req.usuario!.id && parseo.data.estado === 'BLOQUEADO') {
      return reply.code(409).send(error(409, 'NO_PUEDES_BLOQUEARTE', 'No puedes bloquear tu propia cuenta.'));
    }
    const fila = await uno<{ nombre: string }>('SELECT nombre FROM core.usuario WHERE id = $1', [id]);
    if (!fila) return reply.code(404).send(error(404, 'USUARIO_NO_EXISTE', 'El usuario no existe.'));

    await q('UPDATE core.usuario SET estado = $1 WHERE id = $2', [parseo.data.estado, id]);
    // Al bloquear, se revocan las sesiones activas de inmediato.
    if (parseo.data.estado === 'BLOQUEADO') {
      await q('UPDATE core.refresh_token SET revocado_en = now() WHERE usuario_id = $1 AND revocado_en IS NULL', [id]);
    }
    await auditar({
      actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol,
      accion: `USUARIO_${parseo.data.estado}`, entidad: 'usuario', entidadId: id,
      detalle: { nombre: fila.nombre }, ip: req.ip,
    });
    return reply.send({ id, estado: parseo.data.estado });
  });

  // Roles que puede asignar quien gestiona usuarios (el Superadmin solo lo asigna otro Superadmin).
  app.get('/roles-asignables', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'usuarios.gestionar')) return;
    return q('SELECT id, nombre FROM core.rol WHERE $1 OR orden > (SELECT orden FROM core.rol WHERE id = $2) ORDER BY orden', [req.usuario!.rol === 'SUPERADMIN', req.usuario!.rol]);
  });

  const CambioRol = z.object({ rol: z.string().min(1).max(40), clienteId: z.string().uuid().optional() });
  app.patch('/usuarios/:id/rol', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'usuarios.gestionar')) return;
    const { id } = req.params as { id: string };
    const p = CambioRol.safeParse(req.body);
    if (!p.success) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Rol inválido.'));
    if (id === req.usuario!.id) return reply.code(409).send(error(409, 'NO_PUEDES_CAMBIARTE', 'No puedes cambiar tu propio rol.'));
    if (!(await protegeJerarquia(req, reply, { usuarioId: id })) || !(await protegeJerarquia(req, reply, { rol: p.data.rol }))) return;
    if (!(await uno('SELECT 1 FROM core.rol WHERE id = $1', [p.data.rol]))) return reply.code(422).send(error(422, 'ROL_INEXISTENTE', 'El rol no existe.'));
    if (p.data.rol === 'CLIENTE' && !p.data.clienteId) return reply.code(422).send(error(422, 'SIN_CLIENTE', 'Elige la ficha de cliente de este usuario.'));
    const antes = await uno<{ rol_id: string }>('SELECT rol_id FROM core.usuario_rol WHERE usuario_id = $1', [id]);
    if (!antes) return reply.code(404).send(error(404, 'USUARIO_NO_EXISTE', 'El usuario no existe.'));
    await tx(async (c) => {
      await c.query('UPDATE core.usuario_rol SET rol_id = $2 WHERE usuario_id = $1', [id, p.data.rol]);
      await c.query('UPDATE core.usuario SET cliente_id = $2 WHERE id = $1', [id, p.data.rol === 'CLIENTE' ? p.data.clienteId : null]);
      // Sesiones abiertas con el rol anterior quedan sin efecto (el token se revalida contra la base).
      await c.query('UPDATE core.refresh_token SET revocado_en = now() WHERE usuario_id = $1 AND revocado_en IS NULL', [id]);
    });
    invalidar(`sesion:${id}`);
    await auditar({ actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol, accion: 'USUARIO_ROL_CAMBIADO', entidad: 'usuario', entidadId: id, detalle: { antes: antes.rol_id, despues: p.data.rol }, ip: req.ip });
    return { id, rol: p.data.rol };
  });

  const NuevaClave = z.object({ clave: z.string().max(128) });

  app.patch('/usuarios/:id/clave', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'usuarios.gestionar')) return;
    const { id } = req.params as { id: string };
    const parseo = NuevaClave.safeParse(req.body);
    const corta = parseo.success ? await claveCorta(parseo.data.clave) : 'La contraseña es demasiado larga.';
    if (!parseo.success || corta) return reply.code(422).send(error(422, 'CLAVE_CORTA', corta!));
    if (!(await protegeJerarquia(req, reply, { usuarioId: id }))) return;

    await q('UPDATE core.usuario SET clave_hash = $1 WHERE id = $2', [hashClave(parseo.data.clave), id]);
    await q('UPDATE core.refresh_token SET revocado_en = now() WHERE usuario_id = $1 AND revocado_en IS NULL', [id]);
    await auditar({
      actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol,
      accion: 'CLAVE_RESTABLECIDA', entidad: 'usuario', entidadId: id, ip: req.ip,
    });
    return reply.send({ id, ok: true });
  });

  /* ------------------------------------------------------- precios */
  const Precio = z.object({ precioConIgv: z.number().positive().max(100000) });

  app.patch('/productos/:id/precio', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'maestros.editar')) return;
    const { id } = req.params as { id: string };
    const parseo = Precio.safeParse(req.body);
    if (!parseo.success) return reply.code(422).send(error(422, 'PRECIO_INVALIDO', 'El precio debe ser mayor que cero.'));

    const antes = await uno<{ nombre: string; precio_con_igv: string }>(
      'SELECT nombre, precio_con_igv FROM core.producto WHERE id = $1', [id],
    );
    if (!antes) return reply.code(404).send(error(404, 'PRODUCTO_NO_EXISTE', 'El producto no existe.'));

    await q('UPDATE core.producto SET precio_con_igv = $1 WHERE id = $2', [parseo.data.precioConIgv.toFixed(4), id]);
    await auditar({
      actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol,
      accion: 'PRECIO_CAMBIADO', entidad: 'producto', entidadId: id,
      detalle: { producto: antes.nombre, antes: num(antes.precio_con_igv), despues: parseo.data.precioConIgv },
      ip: req.ip,
    });
    return reply.send({ id, precioConIgv: parseo.data.precioConIgv });
  });

  /* ------------------------------------------------------- períodos */
  app.get('/periodos', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'periodos.cerrar')) return; // ventas netas por mes: no para cualquier sesión
    const filas = await q<Record<string, string>>(`
      SELECT p.id, p.anio, p.mes, p.estado, p.cif_total, p.cif_estimado, p.tarifa_hora_horno, p.tarifa_kg_masa, p.tarifa_unidad, p.cerrado_en::text AS cerrado_en,
             (SELECT count(*) FROM core.venta v
               WHERE v.creado_en >= make_date(p.anio, p.mes, 1) AND v.creado_en < make_date(p.anio, p.mes, 1) + interval '1 month') AS ventas,
             (SELECT coalesce(sum(v.ventas_netas),0) FROM core.venta v
               WHERE v.estado = 'CONFIRMADA'
                 AND v.creado_en >= make_date(p.anio, p.mes, 1) AND v.creado_en < make_date(p.anio, p.mes, 1) + interval '1 month') AS netas
      FROM core.periodo_costos p
      ORDER BY p.anio DESC, p.mes DESC`);
    return reply.send(filas.map((f) => ({
      id: f.id, anio: num(f.anio), mes: num(f.mes), estado: f.estado,
      cifTotal: num(f.cif_total), cifEstimado: f.cif_estimado === null ? null : num(f.cif_estimado), cerradoEn: f.cerrado_en, ventas: num(f.ventas), netas: num(f.netas),
      tarifas: { horaHorno: num(f.tarifa_hora_horno), kgMasa: num(f.tarifa_kg_masa), unidad: num(f.tarifa_unidad) },
    })));
  });

  /**
   * Cerrar un período congela el margen: a partir de aquí los reportes son DEFINITIVOS.
   * Es irreversible sin una reapertura explícita y auditada.
   */
  app.post('/periodos/:id/cerrar', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'periodos.cerrar')) return;
    const { id } = req.params as { id: string };

    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(404).send(error(404, 'PERIODO_NO_EXISTE', 'El período no existe.'));
    try {
      // RN-38 / COS-09: tarifas reales del mes (CIF registrado ÷ actividad producida), estimado vs real y estado CERRADO.
      const p = await uno<Record<string, string>>('SELECT * FROM core.cerrar_periodo($1, $2)', [id, req.usuario!.id]);
      const netas = num(p!.ventas_netas), costo = num(p!.costo_ventas);
      const res = {
        id, anio: num(p!.anio), mes: num(p!.mes), estado: 'CERRADO', ventasNetas: netas, costo, margen: netas > 0 ? (netas - costo) / netas : 0,
        cifReal: num(p!.cif_total), cifEstimado: num(p!.cif_estimado),
        tarifas: { horaHorno: num(p!.tarifa_hora_horno), kgMasa: num(p!.tarifa_kg_masa), unidad: num(p!.tarifa_unidad) },
        actividad: { horasHorno: num(p!.horas_horno_mes), kgMasa: num(p!.kg_masa_mes), unidades: num(p!.unidades_mes) },
      };
      await auditar({
        actorId: req.usuario!.id, actor: req.usuario!.nombre, rol: req.usuario!.rol,
        accion: 'PERIODO_CERRADO', entidad: 'periodo_costos', entidadId: id,
        detalle: { anio: res.anio, mes: res.mes, margen: res.margen, cifReal: res.cifReal, cifEstimado: res.cifEstimado, tarifas: res.tarifas }, ip: req.ip,
      });
      return reply.send(res);
    } catch (e) {
      const m = (e as Error).message;
      if (m === 'PERIODO_NO_EXISTE') return reply.code(404).send(error(404, m, 'El período no existe.'));
      if (m === 'PERIODO_YA_CERRADO') return reply.code(409).send(error(409, m, 'El período ya está cerrado.'));
      if (m === 'PERIODO_ANTERIOR_ABIERTO') return reply.code(409).send(error(409, m, 'Primero cierra los meses anteriores.'));
      throw e;
    }
  });

  /* ------------------------------------------------------ auditoría */
  // Bitácora con filtros y páginas de 50. Solo lectura: la tabla es append-only por trigger.
  app.get('/auditoria', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'auditoria.ver')) return;
    const f = z.object({
      texto: z.string().max(60).optional(), accion: z.string().max(60).optional(),
      desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      antesDe: z.coerce.number().int().positive().optional(),
    }).safeParse(req.query);
    if (!f.success) return reply.code(422).send(error(422, 'FILTRO_INVALIDO', 'Filtro inválido.'));
    const { texto, accion, desde, hasta, antesDe } = f.data;
    const filas = await q<Record<string, string>>(
      `SELECT id, actor, rol, accion, entidad, entidad_id, detalle::text AS detalle, ocurrido_en::text AS creado_en
       FROM audit.evento
       WHERE ($1::text IS NULL OR actor ILIKE '%' || $1 || '%' OR entidad_id ILIKE '%' || $1 || '%')
         AND ($2::text IS NULL OR accion = $2)
         AND ($3::date IS NULL OR ocurrido_en >= $3::date)
         AND ($4::date IS NULL OR ocurrido_en < $4::date + 1)
         AND ($5::bigint IS NULL OR id < $5)
       ORDER BY id DESC LIMIT 50`,
      [texto || null, accion || null, desde ?? null, hasta ?? null, antesDe ?? null],
    );
    return reply.send(filas.map((f) => ({
      id: num(f.id), actor: f.actor, rol: f.rol, accion: f.accion,
      entidad: f.entidad, entidadId: f.entidad_id,
      detalle: JSON.parse(f.detalle), creadoEn: f.creado_en,
    })));
  });

  /** Verifica la cadena de auditoría: si alguien tocó un evento, se detecta aquí. */
  app.get('/auditoria/verificar', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'auditoria.ver')) return;
    const r = await verificarCadena();
    const ultimo = await ultimoEvento();
    return reply.code(r.ok ? 200 : 409).send({ ...r, ultimo });
  });
}
