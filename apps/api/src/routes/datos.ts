import type { FastifyInstance } from 'fastify';
import { q, uno, num } from '../db.js';
import { autenticar, exigir } from '../seguridad.js';
import { recordar } from '../cache.js';

/**
 * GET /datos — el panel completo del rol, agregado en PostgreSQL.
 * Si el rol no tiene `costos.ver`, la respuesta **no incluye** costo ni margen:
 * el filtrado ocurre en el servidor, nunca en el navegador (D-12).
 *
 * El catálogo (productos, insumos, recetas, categorías) se cachea 15 s porque cambia
 * poco y es la parte más cara: sin esto, 60 usuarios concurrentes saturaban el pool.
 */
export async function rutasDatos(app: FastifyInstance) {
  app.get('/datos', { preHandler: autenticar }, async (req, reply) => {
    const u = req.usuario!;
    const verCosto = u.permisos.has('costos.ver');
    const CATALOGO_MS = 15_000;
    // Agregados iguales para todos (ventas 30 días, tendencia, top, CxC…): una sola consulta
    // por ventana de 3 s aunque entren 60 usuarios a la vez. La proyección por rol se hace
    // después sobre objetos nuevos. Toda escritura llama invalidar('agg:').
    const agg = <T>(k: string, f: () => Promise<T>) => recordar('agg:' + k, 3_000, f);

    const [
      _sinUso, periodo, kpis, dias, categorias, productos, top, insumos,
      ops, pedidos, clientes, movimientos, aging, recetas, usuarios,
    ] = await Promise.all([
      Promise.resolve(null),
      agg('0', () => uno<{ anio: number; mes: number; estado: string }>(
        `SELECT anio, mes, estado FROM core.periodo_costos ORDER BY anio DESC, mes DESC LIMIT 1`,
      )),

      agg('1', () => uno<Record<string, string>>(`
        WITH v AS (
          SELECT sum(ventas_netas) AS ventas, sum(costo_ventas) AS costo, count(*) AS tickets
          FROM core.venta
          WHERE estado = 'CONFIRMADA' AND creado_en >= now() - interval '30 days'
        ), prev AS (
          SELECT sum(ventas_netas) AS ventas, sum(utilidad) AS util
          FROM core.venta
          WHERE estado = 'CONFIRMADA'
            AND creado_en >= now() - interval '60 days'
            AND creado_en <  now() - interval '30 days'
        ), cxc AS (
          SELECT coalesce(sum(saldo),0) AS por_cobrar,
                 coalesce(sum(CASE WHEN vence_en < current_date THEN saldo ELSE 0 END),0) AS vencido,
                 -- Días promedio de cobro real (emisión → pago) de los últimos 90 días.
                 coalesce((SELECT avg(cb.creado_en::date - x.creado_en::date) FROM core.cobranza cb JOIN core.cuenta_por_cobrar x ON x.id = cb.cxc_id
                           WHERE cb.creado_en >= now() - interval '90 days'), 0) AS dias_cobro
          FROM core.cuenta_por_cobrar WHERE estado IN ('PENDIENTE','PARCIAL')
        ), merma AS (
          SELECT coalesce(sum(abs(valor)),0) AS valor
          FROM core.movimiento_inventario WHERE tipo = 'MERMA' AND creado_en >= now() - interval '30 days'
        )
        SELECT v.ventas, v.costo, v.tickets,
               v.ventas - v.costo AS utilidad,
               CASE WHEN v.ventas > 0 THEN (v.ventas - v.costo) / v.ventas ELSE 0 END AS margen,
               CASE WHEN prev.ventas > 0 THEN (v.ventas - prev.ventas) / prev.ventas ELSE 0 END AS variacion_ventas,
               cxc.por_cobrar, cxc.vencido, cxc.dias_cobro, merma.valor AS merma_valor,
               v.ventas / GREATEST(v.tickets,1) AS ticket_promedio
        FROM v, prev, cxc, merma`)),

      agg('2', () => q<Record<string, string>>(`
        WITH fechas AS (
          SELECT generate_series(
            (current_date - interval '29 days')::date, current_date, interval '1 day'
          )::date AS fecha
        )
        SELECT f.fecha::text AS fecha,
               coalesce(vd.ventas_netas, 0) AS ventas_netas,
               coalesce(vd.costo, 0)       AS costo,
               coalesce(vd.utilidad, 0)    AS utilidad,
               coalesce(vd.tickets, 0)     AS tickets
        FROM fechas f
        LEFT JOIN report.v_venta_dia vd ON vd.fecha = f.fecha
        ORDER BY f.fecha`)),

      recordar('cat:categorias', CATALOGO_MS, () => q<Record<string, string>>(`
        SELECT c.id, c.codigo, c.nombre, c.margen_objetivo, c.orden,
               coalesce(x.ventas,0)   AS ventas,
               coalesce(x.costo,0)    AS costo,
               coalesce(x.utilidad,0) AS utilidad
        FROM core.categoria c
        LEFT JOIN LATERAL (
          -- LATERAL explícito: antes el planner eliminaba el LEFT JOIN de venta
          -- (sus columnas no se usaban) y con él se perdía el filtro de 30 días,
          -- así que la categoría sumaba el histórico completo.
          SELECT sum(vd.precio_neto * vd.cantidad)                AS ventas,
                 sum(vd.costo_unitario * vd.cantidad) AS costo,
                 sum(vd.utilidad)                   AS utilidad
          FROM core.venta_detalle vd
          JOIN core.venta v     ON v.id = vd.venta_id
          JOIN core.producto p  ON p.id = vd.producto_id
          WHERE p.categoria_id = c.id
            AND v.estado = 'CONFIRMADA'
            AND v.creado_en >= now() - interval '30 days'
        ) x ON true
        ORDER BY c.orden, c.nombre`)),

      recordar('cat:productos', CATALOGO_MS, () => q<Record<string, string>>(`
        SELECT p.id, p.codigo, p.nombre, p.categoria_id, p.unidad,
               p.precio_con_igv, p.costo_unitario, p.merma_pct, p.vendidos_30d, p.stock, p.estado,
               p.peso_masa_g, p.perdida_coccion, p.horas_hombre_lote, p.horas_horno_lote, p.reservado, p.anticipacion_horas, p.imagen_id, p.insumo_id, p.peso_final_g, p.unidades_lote, p.vida_util_dias, p.sku, p.presentacion_codigo,
               (SELECT json_build_object('nombre', v.nombre, 'equivalencia', v.equivalencia) FROM core.presentacion_venta v WHERE v.codigo = p.presentacion_codigo) sku1,
               coalesce((SELECT json_agg(json_build_object('presentacion', pp.presentacion_codigo, 'nombre', v.nombre, 'equivalencia', v.equivalencia,
                 'sku', coalesce(pp.sku, ''), 'precioConIgv', pp.precio_con_igv, 'activo', pp.activo) ORDER BY pp.orden)
                 FROM core.producto_presentacion pp JOIN core.presentacion_venta v ON v.codigo = pp.presentacion_codigo WHERE pp.producto_id = p.id), '[]') presentaciones,
               p.precio_con_igv / (1 + (SELECT valor::numeric FROM core.parametro WHERE clave = 'igv')) AS precio_neto,
               CASE WHEN p.precio_con_igv > 0
                    THEN (p.precio_con_igv / (1 + (SELECT valor::numeric FROM core.parametro WHERE clave = 'igv')) - p.costo_unitario) / (p.precio_con_igv / (1 + (SELECT valor::numeric FROM core.parametro WHERE clave = 'igv')))
                    ELSE NULL END AS margen,
               (SELECT c.margen_objetivo FROM core.categoria c WHERE c.id = p.categoria_id) AS margen_objetivo
        FROM core.producto p
        ORDER BY p.nombre`)),

      agg('3', () => q<Record<string, string>>(`
        SELECT vd.producto_id AS id, vd.producto AS nombre, p.categoria_id AS categoria,
               sum(vd.precio_neto * vd.cantidad) AS ventas, sum(vd.utilidad) AS utilidad,
               sum(vd.cantidad)    AS unidades,
               CASE WHEN sum(vd.precio_neto * vd.cantidad) > 0 THEN sum(vd.utilidad) / sum(vd.precio_neto * vd.cantidad) ELSE 0 END AS margen,
               (SELECT c.margen_objetivo FROM core.categoria c WHERE c.id = p.categoria_id) AS margen_objetivo
        FROM core.venta_detalle vd
        JOIN core.venta v ON v.id = vd.venta_id AND v.estado = 'CONFIRMADA'
                          AND v.creado_en >= now() - interval '30 days'
        JOIN core.producto p ON p.id = vd.producto_id
        GROUP BY vd.producto_id, vd.producto, p.categoria_id
        ORDER BY ventas DESC
        LIMIT 8`)),

      recordar('cat:insumos', CATALOGO_MS, () => q<Record<string, string>>(`
        SELECT id, codigo, nombre, unidad, cpp, stock, minimo, proveedor, estado,
               tipo, presentacion, precio_compra, cant_presentacion, equiv_kg, activo, unidad_inventario, core.factor_inventario(id) factor,
               maneja_stock, presentacion_codigo, costo_formula,
               (cpp * stock) AS valorizado
        FROM core.insumo ORDER BY estado DESC, nombre`)),

      agg('4', () => q<Record<string, string>>(`
        SELECT codigo, producto, cantidad, estado, entrega::text AS entrega, responsable, avance, merma_esperada
        FROM core.orden_produccion ORDER BY (estado = 'TERMINADA'), entrega, codigo`)),

      agg('5', () => q<Record<string, string>>(`
        SELECT codigo, cliente, estado, total, fecha_entrega::text AS fecha_entrega, vendedor
        FROM core.pedido ORDER BY creado_en DESC LIMIT 40`)),

      agg('6', () => q<Record<string, string>>(`
        SELECT c.id, c.nombre, c.doc_tipo, c.lista_precio, c.limite_credito,
               coalesce(sum(x.saldo),0) AS saldo,
               coalesce(sum(CASE WHEN x.vence_en < current_date THEN x.saldo ELSE 0 END),0) AS vencido,
               coalesce(avg(CASE WHEN x.saldo > 0 THEN current_date - x.vence_en END),0) AS dias_promedio
        FROM core.cliente c
        LEFT JOIN core.cuenta_por_cobrar x ON x.cliente_id = c.id AND x.estado IN ('PENDIENTE','PARCIAL')
        GROUP BY c.id, c.nombre, c.doc_tipo, c.lista_precio, c.limite_credito
        ORDER BY saldo DESC`)),

      agg('7', () => q<Record<string, string>>(`
        -- Movimientos recientes de TODO el inventario (antes estaba fijado en INS-001).
        SELECT m.creado_en::text AS fecha, m.tipo, m.documento, m.cantidad, coalesce(i.nombre, p.nombre) AS item,
               m.costo_unitario, m.valor, m.saldo_cantidad, m.saldo_valor, m.cpp
        FROM core.movimiento_inventario m
        LEFT JOIN core.insumo i ON i.id = m.insumo_id
        LEFT JOIN core.producto p ON p.id = m.producto_id
        ORDER BY m.id DESC LIMIT 50`)),

      agg('8', () => q<Record<string, string>>(`
        SELECT CASE
                 WHEN current_date - vence_en <= 0  THEN 'Por vencer'
                 WHEN current_date - vence_en <= 7  THEN '1 a 7 días vencido'
                 WHEN current_date - vence_en <= 15 THEN '8 a 15 días vencido'
                 WHEN current_date - vence_en <= 30 THEN '16 a 30 días vencido'
                 ELSE 'Más de 30 días vencido'
               END AS rango,
               sum(saldo) AS monto, count(*) AS documentos,
               min(CASE WHEN current_date - vence_en <= 0 THEN 0 WHEN current_date - vence_en <= 7 THEN 1 WHEN current_date - vence_en <= 15 THEN 2
                        WHEN current_date - vence_en <= 30 THEN 3 ELSE 4 END) AS orden
        FROM core.cuenta_por_cobrar
        WHERE estado IN ('PENDIENTE','PARCIAL') AND saldo > 0
        GROUP BY 1 ORDER BY orden`)),

      recordar('cat:recetas', CATALOGO_MS, () => q<Record<string, string>>(`
        SELECT r.producto_id, r.producto, r.version, r.estado, r.rendimiento,
               r.merma_estandar, r.costo_insumos, r.costo_con_merma, r.cif_unitario, r.mo_unitario,
               r.masa_lote_kg, r.unidades_teoricas, r.unidades_esperadas, r.costo_lote,
               (r.costo_con_merma + r.mo_unitario + r.cif_unitario) AS costo_unitario,
               coalesce(json_agg(json_build_object(
                 'insumoId', d.insumo_id, 'insumo', d.insumo, 'unidad', d.unidad,
                 'cantidad', d.cantidad, 'cpp', d.cpp, 'costo', d.costo,
                 'unidadReceta', d.unidad_receta, 'cantidadOriginal', d.cantidad_original,
                 'pesoKg', d.peso_kg, 'pctPanadero', d.pct_panadero
               ) ORDER BY d.orden) FILTER (WHERE d.insumo_id IS NOT NULL), '[]') AS lineas
        FROM core.receta r
        LEFT JOIN core.receta_detalle d ON d.receta_id = r.id
        GROUP BY r.id -- clave primaria: incluye todas las columnas de la receta
        ORDER BY r.producto`)),

      u.permisos.has('usuarios.ver') || u.permisos.has('usuarios.gestionar')
        ? q<Record<string, string>>(`
            SELECT us.id, us.nombre, us.usuario, us.estado, us.ultimo_acceso::text AS ultimo_acceso,
                   (SELECT r.nombre FROM core.usuario_rol ur JOIN core.rol r ON r.id = ur.rol_id
                    WHERE ur.usuario_id = us.id ORDER BY r.orden LIMIT 1) AS rol,
                   (SELECT ur.rol_id FROM core.usuario_rol ur WHERE ur.usuario_id = us.id LIMIT 1) AS rol_id
            FROM core.usuario us WHERE us.eliminado_en IS NULL ORDER BY us.nombre`)
        : Promise.resolve([]),
    ]);

    const parametros = await agg('parametros', () => q<{ clave: string; valor: string }>('SELECT clave, valor FROM core.parametro'));
    const param = Object.fromEntries(parametros.map((x) => [x.clave, x.valor]));
    const igv = Number(param.igv ?? 0.18);
    const margenObjetivo = Number(param.margen_objetivo_global ?? 0.52);
    // Los datos del negocio viven en la base: cambiar el teléfono no es un despliegue.
    const negocio = await recordar('negocio', 60_000, () =>
      uno<Record<string, string>>(
        'SELECT nombre, ruc, direccion, telefono, whatsapp, email, representante, claim FROM core.negocio WHERE id = 1',
      ),
    );

    const k: Record<string, number> = {};
    for (const [clave, valor] of Object.entries(kpis ?? {})) k[clave] = num(valor);
    const margen = k.margen ?? 0;
    const ventas = k.ventas ?? 0;
    const costo = k.costo ?? 0;

    const etiquetaMes = new Date().toLocaleDateString('es-PE', { month: 'long', year: 'numeric' });

    const payload = {
      generadoEn: new Date().toISOString(),
      periodo: {
        desde: dias[0]?.fecha ?? '',
        hasta: dias[dias.length - 1]?.fecha ?? '',
        etiqueta: etiquetaMes.charAt(0).toUpperCase() + etiquetaMes.slice(1),
        estado: periodo?.estado === 'CERRADO' ? 'DEFINITIVO' : 'PROVISIONAL',
      },
      negocio: {
        nombre: negocio?.nombre ?? '',
        ruc: negocio?.ruc ?? '',
        direccion: negocio?.direccion ?? '',
        telefono: negocio?.telefono ?? '',
        whatsapp: negocio?.whatsapp ?? '',
        email: negocio?.email ?? '',
        representante: negocio?.representante ?? '',
        claim: negocio?.claim ?? '',
        igv,
        moneda: param.moneda ?? 'PEN',
        margenObjetivoGlobal: margenObjetivo,
      },
      kpis: {
        ventasNetas: ventas,
        costoVentas: costo,
        utilidadBruta: num(k.utilidad),
        margen,
        margenObjetivo,
        tickets: num(k.tickets),
        ticketPromedio: num(k.ticket_promedio),
        variacionVentas: num(k.variacion_ventas),
        variacionMargen: 0,
        porCobrar: num(k.por_cobrar),
        diasPromedioCobro: Math.round(num(k.dias_cobro)),
        vencido: num(k.vencido),
        mermaValorizada: num(k.merma_valor),
        mermaPct: ventas > 0 ? num(k.merma_valor) / ventas : 0,
      },
      dias: dias.map((d2) => ({
        fecha: d2.fecha,
        ventasNetas: num(d2.ventas_netas),
        costo: num(d2.costo),
        utilidad: num(d2.utilidad),
        margen: num(d2.ventas_netas) > 0 ? num(d2.utilidad) / num(d2.ventas_netas) : 0,
        tickets: num(d2.tickets),
      })),
      categorias: categorias.map((c) => {
        const v = num(c.ventas);
        const u2 = num(c.utilidad);
        return {
          id: c.id, codigo: c.codigo, nombre: c.nombre, orden: Number(c.orden ?? 0),
          ventas: v, costo: num(c.costo), utilidad: u2,
          margen: v > 0 ? u2 / v : 0,
          margenObjetivo: num(c.margen_objetivo),
          participacion: ventas > 0 ? v / ventas : 0,
        };
      }),
      productos: productos.map((pr) => {
        const base = {
          id: pr.id, codigo: pr.codigo, nombre: pr.nombre, categoriaId: pr.categoria_id,
          unidad: pr.unidad, precioConIgv: num(pr.precio_con_igv), precioNeto: num(pr.precio_neto),
          vendidos30d: num(pr.vendidos_30d), stock: num(pr.stock), estado: pr.estado,
          mermaPct: num(pr.merma_pct), margenObjetivo: num(pr.margen_objetivo),
          pesoMasaG: pr.peso_masa_g === null ? null : num(pr.peso_masa_g), perdidaCoccion: num(pr.perdida_coccion),
          horasHombreLote: num(pr.horas_hombre_lote), horasHornoLote: num(pr.horas_horno_lote),
          reservado: num(pr.reservado), disponible: num(pr.stock) - num(pr.reservado), anticipacionHoras: Number(pr.anticipacion_horas),
          imagenUrl: pr.imagen_id ? `/archivos/${pr.imagen_id}` : null,
          // Producto intermedio (sub-receta): produce un insumo; no se vende ni sale en el catálogo.
          insumoId: pr.insumo_id ?? null,
          pesoFinalG: pr.peso_final_g === null ? null : num(pr.peso_final_g),
          unidadesLote: pr.unidades_lote === null ? null : Number(pr.unidades_lote),
          vidaUtilDias: pr.vida_util_dias === null ? null : Number(pr.vida_util_dias),
          sku: pr.sku ?? '',
          // SKU #1: su presentación; el precio del producto es por unidad (SKU #1 = precio × equivalencia).
          presentacionCodigo: pr.presentacion_codigo,
          presentacionNombre: (pr.sku1 as unknown as { nombre: string }).nombre,
          presentacionEquivalencia: num((pr.sku1 as unknown as { equivalencia: string }).equivalencia),
          presentaciones: (pr.presentaciones as unknown as Array<Record<string, unknown>>).map((x) => ({ ...x, equivalencia: num(x.equivalencia as string), precioConIgv: num(x.precioConIgv as string) })),
        };
        if (!verCosto) return base;
        return { ...base, costoUnitario: num(pr.costo_unitario), margen: num(pr.margen) };
      }),
      topProductos: top.map((t) => {
        const base = {
          id: t.id, nombre: t.nombre, categoria: t.categoria,
          ventas: num(t.ventas), unidades: num(t.unidades),
          margenObjetivo: num(t.margen_objetivo),
        };
        if (!verCosto) return base;
        return { ...base, utilidad: num(t.utilidad), margen: num(t.margen) };
      }),
      insumos: insumos.map((i) => {
        const base = {
          id: i.id, codigo: i.codigo, nombre: i.nombre, unidad: i.unidad,
          stock: num(i.stock), minimo: num(i.minimo), proveedor: i.proveedor, estado: i.estado,
          tipo: i.tipo, presentacion: i.presentacion, equivKg: num(i.equiv_kg), activo: Boolean(i.activo),
          unidadInventario: i.unidad_inventario, factor: num(i.factor), contenido: i.cant_presentacion === null ? null : num(i.cant_presentacion),
          manejaStock: i.maneja_stock !== (false as unknown), presentacionCodigo: i.presentacion_codigo ?? '',
        };
        if (!verCosto && !u.permisos.has('inventario.mover')) return base;
        return { ...base, cpp: num(i.cpp), valorizado: num(i.valorizado),
          // Costo con que las fórmulas calculan el precio (manual si se ajustó, si no el del kárdex).
          costoFormulas: i.costo_formula === null ? num(i.cpp) : num(i.costo_formula), costoManual: i.costo_formula !== null,
          precioCompra: i.precio_compra === null ? null : num(i.precio_compra), cantPresentacion: i.cant_presentacion === null ? null : num(i.cant_presentacion) };
      }),
      ops: ops.map((o) => ({
        codigo: o.codigo, producto: o.producto, cantidad: num(o.cantidad), estado: o.estado,
        entrega: o.entrega, responsable: o.responsable, avance: num(o.avance), mermaEsperada: num(o.merma_esperada),
      })),
      pedidos: pedidos.map((pe) => ({
        codigo: pe.codigo, cliente: pe.cliente, estado: pe.estado, total: num(pe.total),
        fechaEntrega: pe.fecha_entrega, vendedor: pe.vendedor,
      })),
      clientes: clientes.map((cl) => ({
        id: cl.id, nombre: cl.nombre, docTipo: cl.doc_tipo, listaPrecio: cl.lista_precio,
        limiteCredito: num(cl.limite_credito), saldo: num(cl.saldo), vencido: num(cl.vencido),
        diasPromedio: Math.max(0, Math.round(num(cl.dias_promedio))),
      })),
      movimientos: movimientos.slice().reverse().map((m) => ({
        fecha: m.fecha.slice(0, 16).replace('T', ' '),
        tipo: m.tipo, documento: m.documento, cantidad: num(m.cantidad), item: m.item,
        costo: num(m.costo_unitario), costoUnitario: num(m.costo_unitario),
        valor: num(m.valor), saldoCantidad: num(m.saldo_cantidad),
        saldoValor: num(m.saldo_valor), cpp: num(m.cpp),
      })),
      aging: aging.map((a) => ({ rango: a.rango, monto: num(a.monto), documentos: num(a.documentos) })),
      recetas: recetas.map((r) => {
        const base = {
          id: r.producto_id, productoId: r.producto_id, producto: r.producto,
          version: num(r.version), estado: r.estado, rendimiento: num(r.rendimiento),
          mermaEstandar: num(r.merma_estandar),
          masaLoteKg: num(r.masa_lote_kg), unidadesTeoricas: num(r.unidades_teoricas), unidadesEsperadas: num(r.unidades_esperadas),
          lineas: typeof r.lineas === 'string' ? JSON.parse(r.lineas) : r.lineas,
        };
        if (!verCosto) {
          return { ...base, lineas: base.lineas.map((l: Record<string, unknown>) => ({ insumoId: l.insumoId, insumo: l.insumo, unidad: l.unidad, cantidad: Number(l.cantidad) })) };
        }
        const costoUnitario = num(r.costo_unitario);
        const neto = (precioDe(r.producto_id, productos) ) / (1 + igv);
        return {
          ...base,
          costoInsumos: num(r.costo_insumos), costoConMerma: num(r.costo_con_merma),
          cifUnit: num(r.cif_unitario), moUnit: num(r.mo_unitario), costoLote: num(r.costo_lote), costoUnitario,
          margen: neto > 0 ? (neto - costoUnitario) / neto : 0,
        };
      }),
      usuarios: usuarios.map((x) => ({
        id: x.id, nombre: x.nombre, usuario: x.usuario, rol: x.rol, rolId: x.rol_id,
        estado: x.estado, ultimoAcceso: x.ultimo_acceso ?? '',
      })),
      permisos: [...u.permisos],
    };

    /**
     * Proyección por permiso: lo que el rol no puede ver **no se serializa**.
     * Ocultarlo en el navegador no es seguridad: el JSON viaja igual.
     */
    const p = payload as unknown as Record<string, any>;

    if (!verCosto) {
      const k = p.kpis as Record<string, unknown>;
      delete k.costoVentas;
      delete k.utilidadBruta;
      delete k.margen;
      delete k.margenObjetivo;
      delete k.variacionMargen;
      p.dias = payload.dias.map((d) => ({ fecha: d.fecha, ventasNetas: d.ventasNetas, tickets: d.tickets }));
      p.categorias = payload.categorias.map((c) => ({
        id: c.id, nombre: c.nombre, ventas: c.ventas, participacion: c.participacion,
      }));
      p.topProductos = payload.topProductos.map((t) => ({
        id: t.id, nombre: t.nombre, categoria: t.categoria, ventas: t.ventas, unidades: t.unidades,
      }));
      p.productos = (p.productos as Record<string, unknown>[]).map(sinSoles);
      if (p.negocio) p.negocio = sinSoles(p.negocio as Record<string, unknown>);
      // PDF 3.3: el inventario y el kárdex valorizados son de Almacén; Producción solo ve cantidades.
      if (!u.permisos.has('inventario.mover')) {
        p.movimientos = (p.movimientos as Record<string, unknown>[]).map(sinSoles);
        p.insumos = (p.insumos as Record<string, unknown>[]).map(sinSoles);
      }
    }

    const puede = (perm: string) => u.permisos.has(perm);
    if (!puede('clientes.ver')) p.clientes = [];
    if (!puede('pedidos.ver')) p.pedidos = [];
    if (!puede('produccion.ver')) p.ops = [];
    if (!puede('recetas.ver')) p.recetas = [];
    if (!puede('inventario.ver')) {
      p.insumos = [];
      p.movimientos = [];
    }
    if (!puede('cobranza.ver')) {
      p.aging = [];
      const k = p.kpis as Record<string, unknown>;
      delete k.porCobrar;
      delete k.vencido;
    }
    if (!puede('usuarios.ver') && !puede('usuarios.gestionar')) p.usuarios = [];
    // Antigüedad de saldos = días vencidos desde el vencimiento (RN-35; mismo criterio que G-11 y V-01).
    // Ventas del negocio (totales, tendencia, ranking): solo para quien ve dashboard o reportes.
    if (!puede('dashboard.ver') && !puede('reportes.ver')) {
      const k = p.kpis as Record<string, unknown>;
      for (const c of ['ventasNetas', 'tickets', 'ticketPromedio', 'variacionVentas', 'mermaValorizada', 'mermaPct']) delete k[c];
      p.dias = [];
      p.categorias = [];
      p.topProductos = [];
    }

    // Si el usuario es un cliente, ve únicamente lo suyo: sus pedidos y su saldo.
    const vinculo = await uno<{ cliente_id: string | null }>(
      'SELECT cliente_id FROM core.usuario WHERE id = $1', [u.id],
    );
    if (vinculo?.cliente_id) {
      const mios = await q<Record<string, string>>(
        `SELECT codigo, estado, total, fecha_entrega::text AS fecha_entrega
         FROM core.pedido WHERE cliente_id = $1 ORDER BY creado_en DESC LIMIT 10`,
        [vinculo.cliente_id],
      );
      const deuda = await uno<{ saldo: string; n: string; pedidos: string }>(
        `SELECT coalesce(sum(saldo),0) AS saldo, count(*) AS n,
           (SELECT count(*) FROM core.pedido WHERE cliente_id = $1) AS pedidos
         FROM core.cuenta_por_cobrar WHERE cliente_id = $1 AND estado IN ('PENDIENTE','PARCIAL')`,
        [vinculo.cliente_id],
      );
      p.misPedidos = mios.map((m) => ({
        codigo: m.codigo, estado: m.estado, total: num(m.total), fechaEntrega: m.fecha_entrega,
      }));
      p.miSaldo = num(deuda?.saldo);
      p.misDeudas = Number(deuda?.n ?? 0);
      p.misPedidosTotal = Number(deuda?.pedidos ?? 0);
    }

    return reply.send(p);
  });
}

/** Quita todo campo en soles de costo o margen; las cantidades se conservan. */
function sinSoles(o: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(o).filter(([k]) => !/costo|cpp|valor|margen|utilidad/i.test(k)));
}

function precioDe(productoId: string, productos: Array<Record<string, string>>): number {
  const p = productos.find((x) => x.id === productoId);
  return p ? num(p.precio_con_igv) : 0;
}
