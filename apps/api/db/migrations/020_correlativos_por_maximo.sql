-- 020 · Las secuencias de correlativos se alinean con el NÚMERO MÁS ALTO existente, no con
-- count(*): con huecos (datos importados, anulaciones) count quedaba por debajo y el siguiente
-- código podía repetirse (ej.: OP-2026-000012 cuando ya existían OP hasta la 000319).
SELECT setval('core.venta_correlativo_seq',
  greatest((SELECT coalesce(max(substring(codigo from '(\d+)$')::bigint), 0) FROM core.venta), (SELECT last_value FROM core.venta_correlativo_seq), 1));
SELECT setval('core.pedido_correlativo_seq',
  greatest((SELECT coalesce(max(substring(codigo from '(\d+)$')::bigint), 0) FROM core.pedido), (SELECT last_value FROM core.pedido_correlativo_seq), 1));
SELECT setval('core.op_correlativo_seq',
  greatest((SELECT coalesce(max(substring(codigo from '(\d+)$')::bigint), 0) FROM core.orden_produccion), (SELECT last_value FROM core.op_correlativo_seq), 1));
