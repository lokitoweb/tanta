-- ============================================================================
-- Tanta · EXPLAIN de las consultas más costosas de GET /datos
-- Uso:  docker exec -i tanta-pg psql -U tanta -d tanta -f - < tests/explain-consultas.sql
--
-- Las cinco primeras son, según el log de PostgreSQL durante el escalón de 60
-- usuarios (tests/evidencia/pg-log-e60-vu.log), las que más tiempo acumulan.
-- Se miden con el sistema en reposo para separar el coste del PLAN del coste
-- del ENTORNO (la VM de Docker tiene 2 vCPU compartidas con otros 6 contenedores).
-- ============================================================================

\echo '=== Q1 · top 8 productos (34.8 % del tiempo de /datos) ==='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT vd.producto_id AS id, vd.producto AS nombre, p.categoria_id AS categoria,
       sum(vd.precio_neto) AS ventas, sum(vd.utilidad) AS utilidad,
       sum(vd.cantidad)    AS unidades,
       CASE WHEN sum(vd.precio_neto) > 0 THEN sum(vd.utilidad) / sum(vd.precio_neto) ELSE 0 END AS margen,
       (SELECT c.margen_objetivo FROM core.categoria c WHERE c.id = p.categoria_id) AS margen_objetivo
FROM core.venta_detalle vd
JOIN core.venta v ON v.id = vd.venta_id AND v.estado = 'CONFIRMADA'
                  AND v.creado_en >= now() - interval '30 days'
JOIN core.producto p ON p.id = vd.producto_id
GROUP BY vd.producto_id, vd.producto, p.categoria_id
ORDER BY ventas DESC
LIMIT 8;

\echo ''
\echo '=== Q2 · ventas por categoría (23.7 %). OJO: agrega TODO el histórico ==='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT c.id, c.nombre, c.margen_objetivo,
       coalesce(sum(vd.precio_neto),0)              AS ventas,
       coalesce(sum(vd.costo_unitario * vd.cantidad),0) AS costo,
       coalesce(sum(vd.utilidad),0)                 AS utilidad
FROM core.categoria c
LEFT JOIN core.producto p ON p.categoria_id = c.id
LEFT JOIN core.venta_detalle vd ON vd.producto_id = p.id
LEFT JOIN core.venta v ON v.id = vd.venta_id AND v.estado = 'CONFIRMADA'
                      AND v.creado_en >= now() - interval '30 days'
GROUP BY c.id, c.nombre, c.margen_objetivo, c.orden
ORDER BY c.orden;

\echo ''
\echo '=== Q3 · serie de 30 días sobre report.v_venta_dia (13.5 %) ==='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
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
ORDER BY f.fecha;

\echo ''
\echo '=== Q4 · KPIs del panel, 4 subconsultas sobre las mismas tablas (12.7 %) ==='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
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
         coalesce(sum(CASE WHEN vence_en < current_date THEN saldo ELSE 0 END),0) AS vencido
  FROM core.cuenta_por_cobrar WHERE estado IN ('PENDIENTE','PARCIAL')
), merma AS (
  SELECT coalesce(sum(abs(valor)),0) AS valor
  FROM core.movimiento_inventario WHERE tipo = 'MERMA' AND creado_en >= now() - interval '30 days'
)
SELECT v.ventas, v.costo, v.tickets,
       v.ventas - v.costo AS utilidad,
       CASE WHEN v.ventas > 0 THEN (v.ventas - v.costo) / v.ventas ELSE 0 END AS margen,
       CASE WHEN prev.ventas > 0 THEN (v.ventas - prev.ventas) / prev.ventas ELSE 0 END AS variacion_ventas,
       cxc.por_cobrar, cxc.vencido, merma.valor AS merma_valor,
       v.ventas / GREATEST(v.tickets,1) AS ticket_promedio
FROM v, prev, cxc, merma;

\echo ''
\echo '=== Q5 · kárdex completo de un insumo (crece con el histórico de movimientos) ==='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT m.id, m.creado_en::text AS fecha, m.tipo, m.documento, m.cantidad, m.costo_unitario,
       m.valor, m.saldo_cantidad, m.saldo_valor, m.cpp
FROM core.movimiento_inventario m
JOIN core.insumo i ON i.id = m.insumo_id
WHERE i.codigo = 'INS-001' ORDER BY m.id;

\echo ''
\echo '=== Q6 · generación del código de venta: count(*) de TODA la tabla por venta ==='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT 'VTA-' || to_char(now(),'YYYY') || '-' || lpad((count(*)+1)::text,6,'0') AS n FROM core.venta;

\echo ''
\echo '=== Q7 · bloqueo de fila del producto en POST /ventas (esperó hasta 428 ms) ==='
EXPLAIN (COSTS OFF)
SELECT id, nombre, precio_con_igv, costo_unitario, stock
FROM core.producto WHERE id = '099f5b27-e35c-402f-865f-20471e5e813d'::uuid FOR UPDATE;

\echo ''
\echo '=== Contexto: tamaño de las tablas implicadas ==='
SELECT relname,
       to_char(n_live_tup, 'FM999G999') AS filas,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total
FROM pg_stat_user_tables s
JOIN pg_class c ON c.oid = s.relid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'core' AND s.relname IN ('venta','venta_detalle','movimiento_inventario','cuenta_por_cobrar','producto','insumo','categoria')
ORDER BY pg_total_relation_size(c.oid) DESC;
