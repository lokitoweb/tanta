import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, uno, num } from '../db.js';
import { autenticar, exigir, error, proyectarCostos, esCampoCosto, type UsuarioActual } from '../seguridad.js';

/**
 * Catálogo de reportes del PDF (Tabla 4) y dashboard gerencial, calculados en vivo
 * desde las ventas, el kárdex y el motor de costeo. Montos sin IGV.
 * Filtros comunes: desde, hasta (fechas), categoria, producto, cliente, vendedor.
 */

const Filtros = z.object({
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  categoria: z.string().max(40).optional(),
  producto: z.string().uuid().optional(),
  cliente: z.string().uuid().optional(),
  vendedor: z.string().max(120).optional(),
});
type F = z.infer<typeof Filtros> & { desde: string; hasta: string };

// Fechas por defecto en hora de Lima (UTC−5, sin horario de verano): tras las 19:00 ya no saltan a «mañana».
const haceDias = (n: number) => new Date(Date.now() - 5 * 3_600_000 - n * 86_400_000).toISOString().slice(0, 10);
const hoy = () => haceDias(0);

/** Líneas de venta filtradas: base de G-01…G-07. $1..$6 = desde, hasta, categoría, producto, cliente, vendedor. */
const LINEAS = `
  WITH l AS (
    SELECT v.id AS venta_id, v.codigo, v.creado_en, v.cliente_id, coalesce(c.nombre, 'Público general') AS cliente,
           coalesce(nullif(v.vendedor, ''), '—') AS vendedor, v.canal, d.producto_id, d.producto,
           p.categoria_id, cat.nombre AS categoria, cat.margen_objetivo,
           d.cantidad, d.precio_neto * d.cantidad AS neto, d.costo_unitario * d.cantidad AS costo
    FROM core.venta v
    JOIN core.venta_detalle d ON d.venta_id = v.id
    JOIN core.producto p ON p.id = d.producto_id
    JOIN core.categoria cat ON cat.id = p.categoria_id
    LEFT JOIN core.cliente c ON c.id = v.cliente_id
    WHERE v.estado = 'CONFIRMADA' AND v.creado_en >= $1::date AND v.creado_en < $2::date + 1
      AND ($3::text IS NULL OR p.categoria_id = $3) AND ($4::uuid IS NULL OR d.producto_id = $4)
      AND ($5::uuid IS NULL OR v.cliente_id = $5) AND ($6::text IS NULL OR v.vendedor = $6))`;

const params = (f: F) => [f.desde, f.hasta, f.categoria ?? null, f.producto ?? null, f.cliente ?? null, f.vendedor ?? null];

type Col = { key: string; label: string; tipo?: 'dinero' | 'pct' | 'num' | 'texto' | 'fecha' | 'semaforo' };
const columnasDe = (r: Reporte, u: UsuarioActual) =>
  r.costos && !u.permisos.has('costos.ver') ? r.columnas.filter((c) => !esCampoCosto(c.key)) : r.columnas;

interface Reporte { titulo: string; permiso: string; /** Sus columnas en soles son costos: sin costos.ver no se envían. */ costos?: true; columnas: Col[]; calcular: (f: F) => Promise<{ filas: Record<string, unknown>[]; resumen?: Record<string, unknown> }> }

const margenCols: Col[] = [
  { key: 'unidades', label: 'Unidades', tipo: 'num' }, { key: 'ventas', label: 'Ventas netas', tipo: 'dinero' },
  { key: 'costo', label: 'Costo', tipo: 'dinero' }, { key: 'utilidad', label: 'Utilidad', tipo: 'dinero' },
  { key: 'margen', label: 'Margen', tipo: 'pct' },
];

/** Agrupa líneas por una dimensión y calcula ventas, costo, utilidad y margen. */
async function agrupar(f: F, dim: string, extra = '') {
  const filas = await q<Record<string, string>>(`${LINEAS}
    SELECT ${dim} AS nombre, ${extra} sum(cantidad) unidades, sum(neto) ventas, sum(costo) costo,
           sum(neto) - sum(costo) utilidad, CASE WHEN sum(neto) > 0 THEN (sum(neto) - sum(costo)) / sum(neto) ELSE 0 END margen
    FROM l GROUP BY ${dim} ORDER BY utilidad DESC`, params(f));
  return filas.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) =>
    [k, ['nombre', 'canal', 'categoria', 'vendedor'].includes(k) ? v : num(v)])) as Record<string, string | number>);
}

/** RN-37: rojo bajo el objetivo; ámbar hasta 5 puntos sobre el objetivo; verde por encima. */
const semaforo = (margen: number, objetivo: number) => (margen < objetivo ? 'rojo' : margen <= objetivo + 0.05 ? 'ambar' : 'verde');

const REPORTES: Record<string, Reporte> = {
  'G-01': {
    titulo: 'Resumen ejecutivo del período', permiso: 'dashboard.ver',
    columnas: [{ key: 'indicador', label: 'Indicador' }, { key: 'actual', label: 'Período', tipo: 'dinero' }, { key: 'anterior', label: 'Período anterior', tipo: 'dinero' }, { key: 'variacion', label: 'Variación', tipo: 'pct' }],
    async calcular(f) {
      const dias = Math.max(1, Math.round((Date.parse(f.hasta) - Date.parse(f.desde)) / 86_400_000) + 1);
      const ant: F = { ...f, hasta: new Date(Date.parse(f.desde) - 86_400_000).toISOString().slice(0, 10), desde: new Date(Date.parse(f.desde) - dias * 86_400_000).toISOString().slice(0, 10) };
      const sql = `${LINEAS} SELECT coalesce(sum(neto),0) netas, coalesce(sum(costo),0) costo, count(DISTINCT venta_id) tickets FROM l`;
      const [a, b] = await Promise.all([uno<Record<string, string>>(sql, params(f)), uno<Record<string, string>>(sql, params(ant))]);
      const m = (x: Record<string, string> | null) => { const n = num(x?.netas), c = num(x?.costo); return { n, c, u: n - c, mg: n > 0 ? (n - c) / n : 0, t: num(x?.tickets) }; };
      const A = m(a), B = m(b);
      const v = (x: number, y: number) => (y ? (x - y) / Math.abs(y) : 0);
      return {
        filas: [
          { indicador: 'Ventas netas', actual: A.n, anterior: B.n, variacion: v(A.n, B.n) },
          { indicador: 'Costo de ventas', actual: A.c, anterior: B.c, variacion: v(A.c, B.c) },
          { indicador: 'Utilidad bruta', actual: A.u, anterior: B.u, variacion: v(A.u, B.u) },
          { indicador: 'Margen bruto %', tipo: 'pct', actual: A.mg, anterior: B.mg, variacion: A.mg - B.mg },
          { indicador: 'Tickets', tipo: 'num', actual: A.t, anterior: B.t, variacion: v(A.t, B.t) },
        ],
        resumen: { periodoAnterior: `${ant.desde} a ${ant.hasta}` },
      };
    },
  },
  'G-02': {
    titulo: 'Rentabilidad por producto', permiso: 'dashboard.ver',
    columnas: [{ key: 'nombre', label: 'Producto' }, { key: 'categoria', label: 'Categoría' }, ...margenCols, { key: 'objetivo', label: 'Objetivo', tipo: 'pct' }, { key: 'semaforo', label: 'Estado', tipo: 'semaforo' }],
    async calcular(f) {
      const filas = (await agrupar(f, 'producto', 'max(categoria) categoria, max(margen_objetivo) objetivo,'))
        .map((r): Record<string, string | number> => ({ ...r, semaforo: semaforo(r.margen as number, r.objetivo as number) }));
      return { filas, resumen: { masRentables: filas.slice(0, 10).map((r) => r.nombre), menosRentables: filas.slice(-10).reverse().map((r) => r.nombre) } };
    },
  },
  'G-03': {
    titulo: 'Rentabilidad por categoría', permiso: 'dashboard.ver',
    columnas: [{ key: 'nombre', label: 'Categoría' }, ...margenCols, { key: 'participacion', label: 'Aporte a ventas', tipo: 'pct' }, { key: 'objetivo', label: 'Objetivo', tipo: 'pct' }, { key: 'semaforo', label: 'Estado', tipo: 'semaforo' }],
    async calcular(f) {
      const filas = await agrupar(f, 'categoria', 'max(margen_objetivo) objetivo,');
      const total = filas.reduce((s, r) => s + (r.ventas as number), 0);
      return { filas: filas.map((r) => ({ ...r, participacion: total ? (r.ventas as number) / total : 0, semaforo: semaforo(r.margen as number, r.objetivo as number) })) };
    },
  },
  'G-04': {
    titulo: 'Rentabilidad por cliente', permiso: 'dashboard.ver',
    columnas: [{ key: 'nombre', label: 'Cliente' }, { key: 'tickets', label: 'Compras', tipo: 'num' }, ...margenCols, { key: 'alerta', label: 'Lectura' }],
    async calcular(f) {
      const filas = await agrupar(f, 'cliente', 'count(DISTINCT venta_id) tickets,');
      const promedio = filas.length ? filas.reduce((s, r) => s + (r.ventas as number), 0) / filas.length : 0;
      const mg = filas.length ? filas.reduce((s, r) => s + (r.margen as number), 0) / filas.length : 0;
      return { filas: filas.map((r) => ({ ...r, alerta: (r.ventas as number) > promedio && (r.margen as number) < mg ? 'Alto volumen, bajo margen' : '' })) };
    },
  },
  'G-05': {
    titulo: 'Rentabilidad por vendedor y canal', permiso: 'dashboard.ver',
    columnas: [{ key: 'nombre', label: 'Vendedor' }, { key: 'canal', label: 'Canal' }, { key: 'tickets', label: 'Ventas', tipo: 'num' }, ...margenCols.slice(1)],
    async calcular(f) {
      const filas = await q<Record<string, string>>(`${LINEAS}
        SELECT vendedor nombre, canal, count(DISTINCT venta_id) tickets, sum(neto) ventas, sum(costo) costo, sum(neto)-sum(costo) utilidad,
               CASE WHEN sum(neto) > 0 THEN (sum(neto)-sum(costo))/sum(neto) ELSE 0 END margen
        FROM l GROUP BY vendedor, canal ORDER BY ventas DESC`, params(f));
      return { filas: filas.map((r) => ({ nombre: r.nombre, canal: r.canal === 'APP' ? 'Pedido por app' : 'Venta a terceros', tickets: num(r.tickets), ventas: num(r.ventas), costo: num(r.costo), utilidad: num(r.utilidad), margen: num(r.margen) })) };
    },
  },
  'G-06': {
    titulo: 'Margen por venta (detalle)', permiso: 'dashboard.ver',
    columnas: [{ key: 'codigo', label: 'Venta' }, { key: 'fecha', label: 'Fecha', tipo: 'fecha' }, { key: 'cliente', label: 'Cliente' }, { key: 'vendedor', label: 'Vendedor' }, { key: 'ventas', label: 'Ingreso neto', tipo: 'dinero' }, { key: 'costo', label: 'Costo', tipo: 'dinero' }, { key: 'utilidad', label: 'Utilidad', tipo: 'dinero' }, { key: 'margen', label: 'Margen', tipo: 'pct' }],
    async calcular(f) {
      const filas = await q<Record<string, string>>(`${LINEAS}
        SELECT codigo, min(creado_en)::text fecha, max(cliente) cliente, max(vendedor) vendedor, sum(neto) ventas, sum(costo) costo,
               sum(neto)-sum(costo) utilidad, CASE WHEN sum(neto) > 0 THEN (sum(neto)-sum(costo))/sum(neto) ELSE 0 END margen
        FROM l GROUP BY codigo ORDER BY margen ASC, fecha DESC LIMIT 1000`, params(f));
      return { filas: filas.map((r) => ({ codigo: r.codigo, fecha: r.fecha, cliente: r.cliente, vendedor: r.vendedor, ventas: num(r.ventas), costo: num(r.costo), utilidad: num(r.utilidad), margen: num(r.margen) })),
        resumen: { ventasConMargenNegativo: filas.filter((r) => num(r.margen) < 0).length } };
    },
  },
  'G-07': {
    titulo: 'Estructura de costos', permiso: 'dashboard.ver',
    columnas: [{ key: 'concepto', label: 'Concepto' }, { key: 'tipo', label: 'Tipo' }, { key: 'monto', label: 'Monto', tipo: 'dinero' }, { key: 'sobreVentas', label: '% sobre ventas', tipo: 'pct' }],
    async calcular(f) {
      // REP-02: el costo CONGELADO de cada venta se reparte según la composición de su ficha
      // (insumos sin merma, merma, mano de obra y CIF): la suma de participaciones = costo de ventas.
      // Insumos sin merma = costo del lote ÷ unidades teóricas; merma = lo que cuesta producir de más.
      const r = await uno<Record<string, string>>(`${LINEAS}
        SELECT coalesce(sum(l.neto),0) netas, coalesce(sum(l.costo),0) costo,
               coalesce(sum(l.costo * coalesce(k.ins / t.tot, 1)),0) insumos,
               coalesce(sum(l.costo * coalesce((k.cm - k.ins) / t.tot, 0)),0) merma,
               coalesce(sum(l.costo * coalesce(k.mo / t.tot, 0)),0) mo,
               coalesce(sum(l.costo * coalesce(k.cif / t.tot, 0)),0) cif
        FROM l LEFT JOIN core.receta re ON re.producto_id = l.producto_id AND re.estado = 'VIGENTE'
        CROSS JOIN LATERAL (SELECT coalesce(CASE WHEN re.unidades_teoricas > 0 THEN re.costo_lote / re.unidades_teoricas ELSE re.costo_con_merma END, 0) ins,
                                   coalesce(re.costo_con_merma, 0) cm, coalesce(re.mo_unitario, 0) mo, coalesce(re.cif_unitario, 0) cif) k
        CROSS JOIN LATERAL (SELECT nullif(k.cm + k.mo + k.cif, 0) tot) t`, params(f));
      const netas = num(r?.netas), cif = num(r?.cif);
      const conceptos = await q<Record<string, string>>('SELECT concepto, tipo, monto_mensual FROM core.costo_indirecto WHERE activo ORDER BY monto_mensual DESC');
      const totalMes = conceptos.reduce((s, c) => s + num(c.monto_mensual), 0);
      const filas = [
        { concepto: 'Insumos directos', tipo: 'Variable', monto: num(r?.insumos) },
        { concepto: 'Merma', tipo: 'Variable', monto: num(r?.merma) },
        { concepto: 'Mano de obra', tipo: 'Variable', monto: num(r?.mo) },
        ...(totalMes ? conceptos.map((c) => ({ concepto: `CIF · ${c.concepto}`, tipo: c.tipo === 'FIJO' ? 'Fijo' : 'Variable', monto: cif * num(c.monto_mensual) / totalMes }))
          : [{ concepto: 'CIF', tipo: 'Variable', monto: cif }]),
      ].map((x) => ({ ...x, sobreVentas: netas ? x.monto / netas : 0 }));
      return { filas, resumen: { ventasNetas: netas, costoVentas: num(r?.costo) } };
    },
  },
  'G-08': {
    titulo: 'Variación del costo de insumos', permiso: 'dashboard.ver',
    columnas: [{ key: 'insumo', label: 'Insumo' }, { key: 'cppInicio', label: 'CPP inicial', tipo: 'dinero' }, { key: 'cppActual', label: 'CPP actual', tipo: 'dinero' }, { key: 'variacion', label: 'Variación', tipo: 'pct' }, { key: 'impactoMensual', label: 'Impacto en costo (mes)', tipo: 'dinero' }, { key: 'alerta', label: 'Alerta' }],
    async calcular(f) {
      const filas = await q<Record<string, string>>(`
        SELECT i.nombre insumo, i.cpp actual,
               coalesce((SELECT m.cpp FROM core.movimiento_inventario m WHERE m.insumo_id = i.id AND m.creado_en < $1::date AND m.cpp IS NOT NULL ORDER BY m.id DESC LIMIT 1),
                        (SELECT m.cpp FROM core.movimiento_inventario m WHERE m.insumo_id = i.id AND m.cpp IS NOT NULL ORDER BY m.id LIMIT 1), i.cpp) inicio,
               coalesce((SELECT sum(d.cantidad * core.factor_inventario(d.insumo_id) / r.rendimiento * coalesce(vd.u, 0)) FROM core.receta_detalle d JOIN core.receta r ON r.id = d.receta_id
                         LEFT JOIN (SELECT producto_id, sum(cantidad) u FROM core.venta_detalle x JOIN core.venta v ON v.id = x.venta_id
                                    WHERE v.creado_en >= now() - interval '30 days' GROUP BY producto_id) vd ON vd.producto_id = r.producto_id
                         WHERE d.insumo_id = i.id), 0) consumo_mes
        FROM core.insumo i WHERE i.activo ORDER BY i.nombre`, [f.desde]);
      return { filas: filas.map((r) => {
        const a = num(r.actual), b = num(r.inicio), v = b ? (a - b) / b : 0;
        return { insumo: r.insumo, cppInicio: b, cppActual: a, variacion: v, impactoMensual: (a - b) * num(r.consumo_mes), alerta: v >= 0.05 ? 'Alza relevante' : v <= -0.05 ? 'Baja' : '' };
      }).sort((x, y) => y.impactoMensual - x.impactoMensual) };
    },
  },
  'G-09': {
    titulo: 'Punto de equilibrio', permiso: 'dashboard.ver',
    columnas: [{ key: 'indicador', label: 'Indicador' }, { key: 'valor', label: 'Valor', tipo: 'dinero' }],
    async calcular(f) {
      const r = await uno<Record<string, string>>(`${LINEAS}
        SELECT coalesce(sum(l.neto),0) netas, coalesce(sum(l.cantidad * (re.costo_con_merma + re.mo_unitario)),0) variables
        FROM l LEFT JOIN core.receta re ON re.producto_id = l.producto_id AND re.estado = 'VIGENTE'`, params(f));
      const cif = await uno<Record<string, string>>(`SELECT coalesce(sum(monto_mensual) FILTER (WHERE tipo='FIJO'),0) fijos, coalesce(sum(monto_mensual) FILTER (WHERE tipo='VARIABLE'),0) varcif FROM core.costo_indirecto WHERE activo`);
      const dias = Math.max(1, Math.round((Date.parse(f.hasta) - Date.parse(f.desde)) / 86_400_000) + 1);
      const factor = dias / 30;
      const netas = num(r?.netas), variables = num(r?.variables) + num(cif?.varcif) * factor, fijos = num(cif?.fijos) * factor;
      const mc = netas ? (netas - variables) / netas : 0;
      const pe = mc > 0 ? fijos / mc : 0;
      return {
        filas: [
          { indicador: 'Ventas netas del período', valor: netas },
          { indicador: 'Costos variables (insumos, merma, mano de obra, CIF variable)', valor: variables },
          { indicador: 'Costos fijos del período', valor: fijos },
          { indicador: 'Margen de contribución %', valor: mc, tipo: 'pct' },
          { indicador: 'Punto de equilibrio (ventas mínimas)', valor: pe },
          { indicador: 'Margen de seguridad', valor: netas - pe },
        ],
        resumen: { margenContribucion: mc, puntoEquilibrio: pe, cubierto: netas >= pe },
      };
    },
  },
  'G-10': {
    titulo: 'Mermas y desperdicio', permiso: 'dashboard.ver',
    columnas: [{ key: 'item', label: 'Ítem' }, { key: 'origen', label: 'Origen' }, { key: 'motivo', label: 'Motivo' }, { key: 'cantidad', label: 'Cantidad', tipo: 'num' }, { key: 'valor', label: 'Valor', tipo: 'dinero' }],
    async calcular(f) {
      const filas = await q<Record<string, string>>(`
        SELECT coalesce(i.nombre, p.nombre) item, 'Almacén' origen, m.documento motivo, abs(m.cantidad) cantidad, abs(m.valor) valor
        FROM core.movimiento_inventario m LEFT JOIN core.insumo i ON i.id = m.insumo_id LEFT JOIN core.producto p ON p.id = m.producto_id
        WHERE m.tipo = 'MERMA' AND m.creado_en >= $1::date AND m.creado_en < $2::date + 1
        UNION ALL
        -- RN-24 / G-10: unidades de merma registradas al cerrar la OP × costo unitario real de la OP.
        SELECT o.producto, 'Producción', 'Merma de ' || o.codigo || coalesce(' · ' || nullif(o.motivo_merma_tipo, ''), ''),
               o.unidades_merma, o.unidades_merma * coalesce(o.costo_unitario_real, p.costo_unitario, 0)
        FROM core.orden_produccion o JOIN core.producto p ON p.id = o.producto_id
        WHERE o.estado = 'TERMINADA' AND o.unidades_merma > 0 AND o.terminada_en >= $1::date AND o.terminada_en < $2::date + 1
        ORDER BY valor DESC`, [f.desde, f.hasta]);
      const prod = await uno<{ v: string }>(`SELECT coalesce(sum(coalesce(o.cantidad_producida, o.cantidad) * p.costo_unitario), 0) v FROM core.orden_produccion o JOIN core.producto p ON p.id = o.producto_id
        WHERE o.estado = 'TERMINADA' AND o.terminada_en >= $1::date AND o.terminada_en < $2::date + 1`, [f.desde, f.hasta]);
      const total = filas.reduce((s, r) => s + num(r.valor), 0);
      return { filas: filas.map((r) => ({ item: r.item, origen: r.origen, motivo: r.motivo, cantidad: num(r.cantidad), valor: num(r.valor) })),
        resumen: { mermaValorizada: total, pctProduccion: num(prod?.v) ? total / num(prod?.v) : 0 } };
    },
  },
  'G-11': {
    titulo: 'Cuentas por cobrar', permiso: 'dashboard.ver',
    columnas: [{ key: 'tramo', label: 'Antigüedad' }, { key: 'documentos', label: 'Documentos', tipo: 'num' }, { key: 'saldo', label: 'Saldo', tipo: 'dinero' }, { key: 'participacion', label: '%', tipo: 'pct' }],
    async calcular() {
      const filas = await q<Record<string, string>>(`
        SELECT t.tramo, count(x.id) documentos, coalesce(sum(x.saldo),0) saldo, min(t.o) o FROM (VALUES ('Por vencer',0,-100000,0),('1–7 días vencido',1,1,7),('8–15 días vencido',2,8,15),('16–30 días vencido',3,16,30),('Más de 30 días vencido',4,31,100000)) t(tramo,o,a,b)
        LEFT JOIN core.cuenta_por_cobrar x ON x.estado IN ('PENDIENTE','PARCIAL') AND (current_date - x.vence_en) BETWEEN t.a AND t.b
        GROUP BY t.tramo ORDER BY o`);
      const extra = await uno<Record<string, string>>(`SELECT coalesce(sum(saldo) FILTER (WHERE vence_en < current_date),0) vencido,
        coalesce(sum(saldo * (current_date - creado_en::date)) / nullif(sum(saldo), 0), 0) dias -- G-11: Σ(saldo × días) ÷ Σ saldo
        FROM core.cuenta_por_cobrar WHERE estado IN ('PENDIENTE','PARCIAL')`);
      const total = filas.reduce((s, r) => s + num(r.saldo), 0);
      return { filas: filas.map((r) => ({ tramo: r.tramo, documentos: num(r.documentos), saldo: num(r.saldo), participacion: total ? num(r.saldo) / total : 0 })),
        resumen: { totalPorCobrar: total, vencido: num(extra?.vencido), diasPromedioCobro: Math.round(num(extra?.dias)) } };
    },
  },
  'G-12': {
    titulo: 'Inventario valorizado', permiso: 'dashboard.ver',
    columnas: [{ key: 'tipo', label: 'Tipo' }, { key: 'item', label: 'Ítem' }, { key: 'stock', label: 'Stock', tipo: 'num' }, { key: 'valor', label: 'Valor', tipo: 'dinero' }, { key: 'rotacion', label: 'Rotación (veces/mes)', tipo: 'num' }, { key: 'critico', label: 'Estado' }],
    async calcular() {
      const filas = await q<Record<string, string>>(`
        SELECT 'Insumo' tipo, i.nombre item, i.stock, i.stock * i.cpp valor,
               coalesce(mi.salidas / nullif((2 * i.stock - mi.neto) / 2, 0), 0) rotacion, -- G-12: salidas ÷ inventario promedio
               CASE WHEN i.stock < i.minimo THEN 'Crítico' ELSE '' END critico
        FROM core.insumo i
        CROSS JOIN LATERAL (SELECT coalesce(-sum(m.cantidad) FILTER (WHERE m.cantidad < 0), 0) salidas, coalesce(sum(m.cantidad), 0) neto
                            FROM core.movimiento_inventario m WHERE m.insumo_id = i.id AND m.creado_en >= now() - interval '30 days') mi
        WHERE i.activo
        UNION ALL
        SELECT 'Producto', p.nombre, p.stock, p.stock * p.costo_unitario,
               coalesce(mp.salidas / nullif((2 * p.stock - mp.neto) / 2, 0), 0),
               CASE WHEN p.stock <= 0 THEN 'Sin stock' ELSE '' END
        FROM core.producto p
        CROSS JOIN LATERAL (SELECT coalesce(-sum(m.cantidad) FILTER (WHERE m.cantidad < 0), 0) salidas, coalesce(sum(m.cantidad), 0) neto
                            FROM core.movimiento_inventario m WHERE m.producto_id = p.id AND m.creado_en >= now() - interval '30 days') mp
        WHERE p.estado = 'ACTIVO' ORDER BY 4 DESC`);
      const out = filas.map((r) => ({ tipo: r.tipo, item: r.item, stock: num(r.stock), valor: num(r.valor), rotacion: Math.round(num(r.rotacion) * 10) / 10, critico: r.critico }));
      return { filas: out, resumen: { valorTotal: out.reduce((s, r) => s + r.valor, 0), criticos: out.filter((r) => r.critico).length } };
    },
  },
  'G-13': {
    titulo: 'Producción vs. ventas', permiso: 'dashboard.ver',
    columnas: [{ key: 'producto', label: 'Producto' }, { key: 'planificado', label: 'Planificado', tipo: 'num' }, { key: 'producido', label: 'Producido real', tipo: 'num' }, { key: 'cumplimiento', label: 'Cumplimiento', tipo: 'pct' }, { key: 'vendido', label: 'Vendido', tipo: 'num' }],
    async calcular(f) {
      const filas = await q<Record<string, string>>(`
        SELECT p.nombre producto,
               coalesce((SELECT sum(o.cantidad) FROM core.orden_produccion o WHERE o.producto_id = p.id AND o.estado <> 'ANULADA' AND o.entrega BETWEEN $1::date AND $2::date),0) planificado,
               coalesce((SELECT sum(coalesce(o.cantidad_producida, o.cantidad)) FROM core.orden_produccion o WHERE o.producto_id = p.id AND o.estado = 'TERMINADA' AND o.entrega BETWEEN $1::date AND $2::date),0) producido,
               coalesce((SELECT sum(d.cantidad) FROM core.venta_detalle d JOIN core.venta v ON v.id = d.venta_id WHERE d.producto_id = p.id AND v.estado = 'CONFIRMADA' AND v.creado_en >= $1::date AND v.creado_en < $2::date + 1),0) vendido
        FROM core.producto p WHERE p.estado = 'ACTIVO' ORDER BY vendido DESC`, [f.desde, f.hasta]);
      const ped = await uno<Record<string, string>>(`SELECT count(*) FILTER (WHERE fecha_entrega <= current_date AND estado <> 'CANCELADO') vencidos,
        count(*) FILTER (WHERE fecha_entrega <= current_date AND estado = 'ENTREGADO' AND (entregado_en AT TIME ZONE 'America/Lima')::date <= fecha_entrega) entregados FROM core.pedido WHERE fecha_entrega BETWEEN $1::date AND $2::date`, [f.desde, f.hasta]);
      return { filas: filas.map((r) => ({ producto: r.producto, planificado: num(r.planificado), producido: num(r.producido), cumplimiento: num(r.planificado) ? num(r.producido) / num(r.planificado) : 0, vendido: num(r.vendido) })),
        resumen: { cumplimientoPedidos: num(ped?.vencidos) ? num(ped?.entregados) / num(ped?.vencidos) : 0 } };
    },
  },
  'V-01': {
    titulo: 'Deudas por cobrar', permiso: 'cobranza.ver',
    columnas: [{ key: 'cliente', label: 'Cliente' }, { key: 'porVencer', label: 'Por vencer', tipo: 'dinero' }, { key: 'd0_7', label: '1–7 días', tipo: 'dinero' }, { key: 'd8_15', label: '8–15 días', tipo: 'dinero' }, { key: 'd16_30', label: '16–30 días', tipo: 'dinero' }, { key: 'd30', label: '+30 días', tipo: 'dinero' }, { key: 'total', label: 'Saldo total', tipo: 'dinero' }],
    async calcular(f) {
      const filas = await q<Record<string, string>>(`
        SELECT c.nombre cliente,
          sum(x.saldo) FILTER (WHERE current_date - x.vence_en <= 0) por_vencer,
          sum(x.saldo) FILTER (WHERE current_date - x.vence_en BETWEEN 1 AND 7) d0_7,
          sum(x.saldo) FILTER (WHERE current_date - x.vence_en BETWEEN 8 AND 15) d8_15,
          sum(x.saldo) FILTER (WHERE current_date - x.vence_en BETWEEN 16 AND 30) d16_30,
          sum(x.saldo) FILTER (WHERE current_date - x.vence_en > 30) d30, sum(x.saldo) total
        FROM core.cuenta_por_cobrar x JOIN core.cliente c ON c.id = x.cliente_id
        WHERE x.estado IN ('PENDIENTE','PARCIAL') AND ($1::uuid IS NULL OR c.id = $1)
        GROUP BY c.nombre ORDER BY total DESC`, [f.cliente ?? null]);
      return { filas: filas.map((r) => ({ cliente: r.cliente, porVencer: num(r.por_vencer), d0_7: num(r.d0_7), d8_15: num(r.d8_15), d16_30: num(r.d16_30), d30: num(r.d30), total: num(r.total) })) };
    },
  },
  'V-03': {
    titulo: 'Ventas por pedidos', permiso: 'cobranza.ver',
    columnas: [{ key: 'pedido', label: 'Pedido' }, { key: 'cliente', label: 'Cliente' }, { key: 'fecha', label: 'Fecha' }, { key: 'estado', label: 'Estado' },
      { key: 'total', label: 'Total', tipo: 'dinero' }, { key: 'pagado', label: 'Pagado', tipo: 'dinero' }, { key: 'porCobrar', label: 'Por cobrar', tipo: 'dinero' }, { key: 'situacion', label: 'Situación' }],
    async calcular(f) {
      const filas = await q<Record<string, string>>(`
        SELECT p.codigo pedido, p.cliente, (p.creado_en AT TIME ZONE 'America/Lima')::date::text fecha, p.estado, p.total,
               coalesce(sum(x.monto - x.saldo), 0) pagado, coalesce(sum(x.saldo), 0) saldo, count(x.id) cuentas
        FROM core.pedido p LEFT JOIN core.venta v ON v.pedido_id = p.id AND v.estado = 'CONFIRMADA' LEFT JOIN core.cuenta_por_cobrar x ON x.venta_id = v.id
        WHERE (p.creado_en AT TIME ZONE 'America/Lima')::date BETWEEN $1::date AND $2::date
        GROUP BY p.id ORDER BY p.creado_en DESC`, [f.desde, f.hasta]);
      const situacion = (r: Record<string, string>) => ['CANCELADO', 'RECHAZADO'].includes(r.estado) ? 'Anulado'
        : num(r.cuentas) === 0 ? 'Por entregar' : num(r.saldo) > 0.009 ? 'Deuda por cobrar' : 'Pagado';
      const lista = filas.map((r) => ({ pedido: r.pedido, cliente: r.cliente, fecha: r.fecha, estado: r.estado, total: num(r.total), pagado: num(r.pagado), porCobrar: num(r.saldo), situacion: situacion(r) }));
      const suma = (s: string) => lista.filter((x) => x.situacion === s);
      return { filas: lista, resumen: {
        pedidos: lista.length, pagados: suma('Pagado').length, montoPagado: suma('Pagado').reduce((a, x) => a + x.total, 0),
        conDeuda: suma('Deuda por cobrar').length, deuda: lista.reduce((a, x) => a + x.porCobrar, 0),
      } };
    },
  },
  'V-02': {
    titulo: 'Pedidos por cliente', permiso: 'pedidos.ver',
    columnas: [{ key: 'cliente', label: 'Cliente' }, { key: 'pedidos', label: 'Pedidos', tipo: 'num' }, { key: 'monto', label: 'Monto', tipo: 'dinero' }, { key: 'pendientes', label: 'Pendientes', tipo: 'num' }, { key: 'entregados', label: 'Entregados', tipo: 'num' }, { key: 'cumplimiento', label: 'Cumplimiento', tipo: 'pct' }, { key: 'proximaEntrega', label: 'Próxima entrega', tipo: 'fecha' }],
    async calcular(f) {
      const filas = await q<Record<string, string>>(`
        SELECT cliente, count(*) pedidos, sum(total) monto,
               count(*) FILTER (WHERE estado NOT IN ('ENTREGADO','CANCELADO')) pendientes, count(*) FILTER (WHERE estado = 'ENTREGADO') entregados,
               min(fecha_entrega) FILTER (WHERE estado NOT IN ('ENTREGADO','CANCELADO') AND fecha_entrega >= current_date)::text proxima
        FROM core.pedido WHERE creado_en >= $1::date AND creado_en < $2::date + 1 AND ($3::uuid IS NULL OR cliente_id = $3)
        GROUP BY cliente ORDER BY monto DESC`, [f.desde, f.hasta, f.cliente ?? null]);
      return { filas: filas.map((r) => ({ cliente: r.cliente, pedidos: num(r.pedidos), monto: num(r.monto), pendientes: num(r.pendientes), entregados: num(r.entregados),
        cumplimiento: num(r.pedidos) ? num(r.entregados) / num(r.pedidos) : 0, proximaEntrega: r.proxima ?? '' })) };
    },
  },
  'A-01': {
    titulo: 'Kárdex valorizado', permiso: 'inventario.ver', costos: true,
    columnas: [{ key: 'fecha', label: 'Fecha', tipo: 'fecha' }, { key: 'item', label: 'Ítem' }, { key: 'tipo', label: 'Movimiento' }, { key: 'documento', label: 'Documento / motivo' }, { key: 'cantidad', label: 'Cantidad', tipo: 'num' }, { key: 'costo', label: 'Costo unit.', tipo: 'dinero' }, { key: 'valor', label: 'Valor', tipo: 'dinero' }, { key: 'saldo', label: 'Saldo', tipo: 'num' }, { key: 'saldoValor', label: 'Saldo valorizado', tipo: 'dinero' }],
    async calcular(f) {
      const filas = await q<Record<string, string>>(`
        SELECT m.creado_en::text fecha, coalesce(i.nombre, p.nombre) item, m.tipo, m.documento, m.cantidad, m.costo_unitario, m.valor, m.saldo_cantidad, m.saldo_valor
        FROM core.movimiento_inventario m LEFT JOIN core.insumo i ON i.id = m.insumo_id LEFT JOIN core.producto p ON p.id = m.producto_id
        WHERE m.creado_en >= $1::date AND m.creado_en < $2::date + 1 AND ($3::uuid IS NULL OR m.producto_id = $3)
        ORDER BY m.id DESC LIMIT 2000`, [f.desde, f.hasta, f.producto ?? null]);
      return { filas: filas.map((r) => ({ fecha: r.fecha, item: r.item, tipo: r.tipo, documento: r.documento, cantidad: num(r.cantidad), costo: num(r.costo_unitario), valor: num(r.valor), saldo: num(r.saldo_cantidad), saldoValor: num(r.saldo_valor) })) };
    },
  },
  'A-02': {
    titulo: 'Stock crítico y reposición', permiso: 'inventario.ver',
    columnas: [{ key: 'insumo', label: 'Insumo' }, { key: 'stock', label: 'Stock', tipo: 'num' }, { key: 'minimo', label: 'Mínimo', tipo: 'num' }, { key: 'consumoDiario', label: 'Consumo diario', tipo: 'num' }, { key: 'diasCobertura', label: 'Días de cobertura', tipo: 'num' }, { key: 'sugerido', label: 'Reposición sugerida', tipo: 'num' }, { key: 'proveedor', label: 'Proveedor' }],
    async calcular() {
      // Sugerido: cubrir 7 días de consumo por encima del mínimo.
      const filas = await q<Record<string, string>>(`
        SELECT i.nombre, i.unidad, i.stock, i.minimo, i.proveedor,
               coalesce((SELECT -sum(m.cantidad) FROM core.movimiento_inventario m WHERE m.insumo_id = i.id AND m.cantidad < 0 AND m.creado_en >= now() - interval '30 days'),0) / 30 diario
        FROM core.insumo i WHERE i.activo ORDER BY (i.stock - i.minimo) ASC`);
      return { filas: filas.map((r) => {
        const s = num(r.stock), mn = num(r.minimo), dia = num(r.diario);
        return { insumo: `${r.nombre} (${r.unidad})`, stock: s, minimo: mn, consumoDiario: Math.round(dia * 100) / 100, diasCobertura: dia > 0 ? Math.floor(s / dia) : 999,
          sugerido: Math.max(0, Math.ceil(mn + dia * 7 - s)), proveedor: r.proveedor };
      }).filter((r) => r.stock < r.minimo || r.diasCobertura < 7) };
    },
  },
  'P-01': {
    titulo: 'Plan de producción y consumo', permiso: 'produccion.ver',
    columnas: [{ key: 'insumo', label: 'Insumo' }, { key: 'unidad', label: 'Unidad' }, { key: 'ordenes', label: 'Órdenes', tipo: 'num' },
      { key: 'consumo', label: 'Consumo de las órdenes', tipo: 'num' }, { key: 'stock', label: 'Stock', tipo: 'num' }, { key: 'saldo', label: 'Saldo', tipo: 'num' }, { key: 'estado', label: 'Estado' }],
    // PRO-11: consumo consolidado de las órdenes pendientes y en proceso frente al stock total.
    async calcular() {
      const filas = await q<Record<string, string>>(`
        SELECT i.nombre insumo, i.unidad, count(DISTINCT o.id) ordenes, sum(d.cant_solicitada - d.cant_entregada) consumo, i.stock
        FROM core.orden_produccion o JOIN core.requisicion q ON q.op_id = o.id JOIN core.requisicion_detalle d ON d.requisicion_id = q.id
        JOIN core.insumo i ON i.id = d.insumo_id
        WHERE o.estado IN ('PENDIENTE','EN_PROCESO') AND q.estado IN ('PENDIENTE','PARCIAL')
        GROUP BY i.id ORDER BY i.nombre`);
      return { filas: filas.map((r) => {
        const saldo = num(r.stock) - num(r.consumo);
        return { insumo: r.insumo, unidad: r.unidad, ordenes: num(r.ordenes), consumo: num(r.consumo), stock: num(r.stock), saldo, estado: saldo < 0 ? 'FALTA' : 'OK' };
      }) };
    },
  },
  'P-02': {
    titulo: 'Control de varianza (teórico vs real)', permiso: 'produccion.ver', costos: true,
    columnas: [{ key: 'op', label: 'OP' }, { key: 'producto', label: 'Producto' }, { key: 'insumo', label: 'Insumo' },
      { key: 'teorico', label: 'Teórico', tipo: 'num' }, { key: 'real', label: 'Real', tipo: 'num' }, { key: 'variacion', label: 'Variación', tipo: 'num' },
      { key: 'variacionPct', label: 'Variación %', tipo: 'pct' }, { key: 'impacto', label: 'Impacto', tipo: 'dinero' }, { key: 'estado', label: 'Estado' }],
    // RN-24: variación = real − teórico; % = variación ÷ teórico; impacto = variación × costo. Fuera de la tolerancia: EXCESO o DEFECTO.
    async calcular(f) {
      const tol = num((await uno<{ v: string }>("SELECT valor v FROM core.parametro WHERE clave = 'tolerancia_varianza'"))?.v ?? '0.03');
      const filas = await q<Record<string, string>>(`
        SELECT o.codigo op, o.producto, d.insumo, d.cant_solicitada teorico, coalesce(d.cant_real_usada, d.cant_entregada) real,
               CASE WHEN d.cant_entregada > 0 THEN d.costo_entregado / d.cant_entregada ELSE i.cpp END costo,
               o.unidades_buenas, o.unidades_esperadas
        FROM core.orden_produccion o JOIN core.requisicion q ON q.op_id = o.id JOIN core.requisicion_detalle d ON d.requisicion_id = q.id
        JOIN core.insumo i ON i.id = d.insumo_id JOIN core.producto p ON p.id = o.producto_id
        WHERE o.estado = 'TERMINADA' AND o.terminada_en >= $1::date AND o.terminada_en < $2::date + 1
          AND ($3::uuid IS NULL OR o.producto_id = $3)
        ORDER BY o.terminada_en DESC, o.codigo, d.insumo LIMIT 2000`, [f.desde, f.hasta, f.producto ?? null]);
      const lineas = filas.map((r) => {
        const teorico = num(r.teorico), real = num(r.real), variacion = real - teorico, pctv = teorico > 0 ? variacion / teorico : 0;
        return { op: r.op, producto: r.producto, insumo: r.insumo, teorico, real, variacion, variacionPct: pctv,
          impacto: variacion * num(r.costo), estado: pctv > tol ? 'EXCESO' : pctv < -tol ? 'DEFECTO' : 'OK' };
      });
      return { filas: lineas, resumen: { tolerancia: tol, impactoTotal: lineas.reduce((s, l) => s + l.impacto, 0),
        fueraDeTolerancia: lineas.filter((l) => l.estado !== 'OK').length } };
    },
  },
  'M-01': {
    titulo: 'Ficha de costo por producto', permiso: 'costos.ver',
    columnas: [{ key: 'concepto', label: 'Concepto' }, { key: 'cantidad', label: 'Cantidad', tipo: 'num' }, { key: 'cpp', label: 'CPP', tipo: 'dinero' }, { key: 'costo', label: 'Costo por unidad', tipo: 'dinero' }],
    async calcular(f) {
      if (!f.producto) throw Object.assign(new Error('Elige un producto para ver su ficha de costo.'), { status: 422 });
      const r = await uno<Record<string, string>>(`SELECT p.nombre, p.precio_con_igv, p.costo_unitario, r.rendimiento, r.merma_estandar, r.costo_insumos, r.costo_con_merma, r.cif_unitario, r.version,
        r.mo_unitario, r.unidades_esperadas, r.masa_lote_kg, r.costo_lote,
        (SELECT valor FROM core.parametro WHERE clave='igv') igv FROM core.producto p JOIN core.receta r ON r.producto_id = p.id WHERE p.id = $1`, [f.producto]);
      if (!r) throw Object.assign(new Error('El producto no tiene receta.'), { status: 404 });
      const lineas = await q<Record<string, string>>('SELECT insumo, unidad, cantidad, cpp, pct_panadero FROM core.receta_detalle WHERE receta_id = $1 ORDER BY orden', [f.producto]);
      // Cantidades por unidad esperada (RN-07), no por rendimiento declarado.
      const rend = num(r.unidades_esperadas) || num(r.rendimiento), neto = num(r.precio_con_igv) / (1 + num(r.igv || '0.18')), costo = num(r.costo_unitario), utilidad = neto - costo;
      return {
        filas: [
          ...lineas.map((l) => ({ concepto: `${l.insumo} (${l.unidad})${l.pct_panadero !== null ? ` · ${(num(l.pct_panadero) * 100).toFixed(1)} % panadero` : ''}`, cantidad: num(l.cantidad) / rend, cpp: num(l.cpp), costo: num(l.cantidad) * num(l.cpp) / rend })),
          { concepto: `Costo de insumos (incluye merma ${(num(r.merma_estandar) * 100).toFixed(1)} %)`, cantidad: null, cpp: null, costo: num(r.costo_con_merma) },
          { concepto: 'Mano de obra directa', cantidad: null, cpp: null, costo: num(r.mo_unitario) },
          { concepto: 'Costos indirectos (CIF)', cantidad: null, cpp: null, costo: num(r.cif_unitario) },
          { concepto: 'Costo total unitario', cantidad: null, cpp: null, costo },
          { concepto: 'Precio de venta neto (sin IGV)', cantidad: null, cpp: null, costo: neto },
          { concepto: 'Utilidad bruta por unidad', cantidad: null, cpp: null, costo: utilidad },
        ],
        resumen: { producto: r.nombre, version: num(r.version), rendimiento: rend, masaLoteKg: num(r.masa_lote_kg), costoLote: num(r.costo_lote), margen: neto ? utilidad / neto : 0, markup: costo ? utilidad / costo : 0 },
      };
    },
  },
};

export async function rutasReportes(app: FastifyInstance) {
  const leerFiltros = (query: unknown) => {
    const p = Filtros.safeParse(query);
    if (!p.success) return null;
    return { ...p.data, desde: p.data.desde ?? haceDias(29), hasta: p.data.hasta ?? hoy() } as F;
  };

  /** Catálogo visible para el rol (el menú de reportes sale de aquí, no de un JSON fijo). */
  app.get('/reportes', { preHandler: autenticar }, async (req) =>
    Object.entries(REPORTES).filter(([, r]) => req.usuario!.permisos.has(r.permiso)).map(([codigo, r]) => ({ codigo, titulo: r.titulo, columnas: columnasDe(r, req.usuario!) })));

  app.get('/reportes/:codigo', { preHandler: autenticar }, async (req, reply) => {
    const { codigo } = req.params as { codigo: string };
    const r = REPORTES[codigo];
    if (!r) return reply.code(404).send(error(404, 'NO_ENCONTRADO', 'Reporte inexistente.'));
    if (!exigir(req, reply, r.permiso)) return;
    const f = leerFiltros(req.query);
    if (!f || f.desde > f.hasta) return reply.code(422).send(error(422, 'FILTRO_INVALIDO', 'Revisa las fechas y filtros.'));
    try {
      const out = await r.calcular(f);
      const visible = r.costos ? proyectarCostos(req.usuario!, out) : out;
      return { codigo, titulo: r.titulo, columnas: columnasDe(r, req.usuario!), filtros: f, generadoEn: new Date().toISOString(), ...visible };
    } catch (e) {
      const err = e as Error & { status?: number };
      if (!err.status) throw e;
      return reply.code(err.status).send(error(err.status, 'REPORTE', err.message));
    }
  });

  /** Opciones de los filtros (categorías, productos, clientes, vendedores). */
  app.get('/reportes-filtros', { preHandler: autenticar }, async (req) => {
    // La lista de clientes y vendedores es dato personal (Ley 29733): solo para personal interno, nunca para un cliente.
    const p = req.usuario!.permisos;
    const interno = ['reportes.ver', 'dashboard.ver', 'ventas.registrar', 'pedidos.gestionar', 'clientes.gestionar', 'usuarios.gestionar'].some((x) => p.has(x));
    const [categorias, productos, clientes, vendedores] = await Promise.all([
      q('SELECT id, nombre FROM core.categoria ORDER BY orden, nombre'),
      q("SELECT id, nombre FROM core.producto WHERE estado = 'ACTIVO' ORDER BY nombre"),
      interno ? q("SELECT id, nombre FROM core.cliente WHERE estado = 'ACTIVO' ORDER BY nombre") : [],
      interno ? q("SELECT DISTINCT vendedor AS nombre FROM core.venta WHERE vendedor <> '' ORDER BY 1") : [],
    ]);
    return { categorias, productos, clientes, vendedores: vendedores.map((v) => (v as { nombre: string }).nombre) };
  });

  /**
   * Dashboard gerencial en vivo (G-01 + G-02 + G-03 + G-09 + G-11 resumidos).
   * La web lo consulta cada 30 s; con la caché de 3 s el costo en la base es mínimo.
   */
  // Punto de equilibrio: gastos del mes ÷ ganancia por unidad de cada pan. Los costos de producción ya están en el costo del pan: no se cuentan dos veces.
  app.get('/analisis/punto-equilibrio', { preHandler: autenticar }, async (req, reply) => {
    if (!req.usuario!.permisos.has('costos.ver')) return reply.code(403).send(error(403, 'SIN_PERMISO', 'Falta el permiso costos.ver.'));
    const hoy = new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
    const anio = Number((req.query as { anio?: string }).anio) || Number(hoy.slice(0, 4));
    if (anio < 2000 || anio > 2100) return reply.code(422).send(error(422, 'DATOS_INVALIDOS', 'Año inválido.'));
    const igv = num((await uno<{ valor: string }>("SELECT valor FROM core.parametro WHERE clave = 'igv'"))?.valor ?? '0.18');
    const gastos = await q<Record<string, string>>(`SELECT g.periodo_mes mes, coalesce(t.nombre, k.clasificacion, 'Otros') tipo, sum(g.monto) monto
      FROM core.pago_costo g LEFT JOIN core.costo_indirecto k ON k.id = g.costo_indirecto_id LEFT JOIN core.tipo_gasto t ON t.codigo = g.tipo_gasto
      WHERE g.estado = 'VIGENTE' AND g.periodo_anio = $1 AND coalesce(k.clasificacion, '') <> 'PRODUCCION' GROUP BY 1, 2`, [anio]);
    const productos = await q<Record<string, string>>(`SELECT id, nombre, precio_con_igv, costo_unitario FROM core.producto WHERE estado = 'ACTIVO' AND insumo_id IS NULL ORDER BY nombre`);
    const ventas = await q<Record<string, string>>(`SELECT d.producto_id, extract(month FROM v.creado_en AT TIME ZONE 'America/Lima')::int mes, sum(d.cantidad) cantidad
      FROM core.venta_detalle d JOIN core.venta v ON v.id = d.venta_id
      WHERE v.estado = 'CONFIRMADA' AND extract(year FROM v.creado_en AT TIME ZONE 'America/Lima') = $1 GROUP BY 1, 2`, [anio]);
    const dias = await q<Record<string, string>>(`SELECT d.producto_id, (v.creado_en AT TIME ZONE 'America/Lima')::date::text dia, sum(d.cantidad) cantidad
      FROM core.venta_detalle d JOIN core.venta v ON v.id = d.venta_id
      WHERE v.estado = 'CONFIRMADA' AND (v.creado_en AT TIME ZONE 'America/Lima')::date > $1::date - 3 GROUP BY 1, 2`, [hoy]);
    const ultimoMes = anio === Number(hoy.slice(0, 4)) ? Number(hoy.slice(5, 7)) : 12;
    const meses = Array.from({ length: ultimoMes }, (_, i) => i + 1).map((mes) => {
      const delMes = gastos.filter((g) => num(g.mes) === mes);
      return { mes, gastos: Number(delMes.reduce((s, g) => s + num(g.monto), 0).toFixed(2)), porTipo: delMes.map((g) => ({ tipo: g.tipo, monto: num(g.monto) })) };
    });
    const ultimosDias = Array.from({ length: 3 }, (_, i) => new Date(Date.parse(hoy) - (2 - i) * 86_400_000).toISOString().slice(0, 10));
    return {
      anio, meses, dias: ultimosDias,
      productos: productos.map((p) => {
        const ganancia = Number((num(p.precio_con_igv) / (1 + igv) - num(p.costo_unitario)).toFixed(4));
        return {
          id: p.id, nombre: p.nombre, ganancia,
          meses: meses.map((m) => {
            const vendido = num(ventas.find((v) => v.producto_id === p.id && num(v.mes) === m.mes)?.cantidad);
            // Sin ganancia por unidad no hay cantidad que cubra los gastos.
            const equilibrio = ganancia > 0 ? Math.ceil(m.gastos / ganancia) : null;
            return { mes: m.mes, vendido, equilibrio, alcanzado: equilibrio !== null && equilibrio > 0 && vendido >= equilibrio };
          }),
          dias: ultimosDias.map((d) => num(dias.find((x) => x.producto_id === p.id && x.dia === d)?.cantidad)),
        };
      }),
    };
  });

  app.get('/dashboard', { preHandler: autenticar }, async (req, reply) => {
    if (!exigir(req, reply, 'dashboard.ver')) return;
    const f = leerFiltros(req.query);
    if (!f || f.desde > f.hasta) return reply.code(422).send(error(422, 'FILTRO_INVALIDO', 'Revisa las fechas.'));
    const [resumen, productos, categorias, equilibrio, cxc, serie] = await Promise.all([
      REPORTES['G-01'].calcular(f), REPORTES['G-02'].calcular(f), REPORTES['G-03'].calcular(f),
      REPORTES['G-09'].calcular(f), REPORTES['G-11'].calcular(f),
      q<Record<string, string>>(`${LINEAS}
        SELECT d::date::text fecha, coalesce(sum(l.neto),0) ventas, coalesce(sum(l.costo),0) costo, count(DISTINCT l.venta_id) tickets
        FROM generate_series($1::date, $2::date, interval '1 day') d LEFT JOIN l ON l.creado_en::date = d::date
        GROUP BY d ORDER BY d`, params(f)),
    ]);
    const prods = productos.filas as Array<Record<string, number | string>>;
    return {
      filtros: f, generadoEn: new Date().toISOString(),
      kpis: resumen.filas, puntoEquilibrio: equilibrio.resumen, cxc: { ...cxc.resumen, tramos: cxc.filas },
      serie: serie.map((s) => ({ fecha: s.fecha, ventas: num(s.ventas), utilidad: num(s.ventas) - num(s.costo), tickets: num(s.tickets) })),
      categorias: categorias.filas, top: prods.slice(0, 10), bottom: prods.slice(-10).reverse(),
      alertas: prods.filter((p) => p.semaforo === 'rojo').map((p) => ({ producto: p.nombre, margen: p.margen, objetivo: p.objetivo })),
    };
  });
}
