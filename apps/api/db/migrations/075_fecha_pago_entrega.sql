-- Al entregar un pedido sin pago completo, el vendedor elige la fecha en que el cliente se compromete a pagar
-- (antes vencía sola a los días de crédito del cliente, o a 30 días). Plazos administrables en Parámetros.
INSERT INTO core.parametro (clave, valor, tipo, descripcion) VALUES
  ('dias_pago_entrega', '2', 'numero', 'Al entregar sin pago completo: días que se proponen para la fecha en que el cliente paga (el vendedor la puede cambiar)'),
  ('dias_pago_entrega_max', '7', 'numero', 'Al entregar sin pago completo: días máximos para la fecha de pago que elige el vendedor (un cliente a crédito puede llegar hasta sus días de crédito)')
ON CONFLICT (clave) DO NOTHING;

-- Una sola regla para la API, la web y la app.
CREATE OR REPLACE FUNCTION core.plazo_pago_max(p_cliente uuid) RETURNS int LANGUAGE sql STABLE AS $$
  SELECT greatest(
    coalesce((SELECT round(valor::numeric)::int FROM core.parametro WHERE clave = 'dias_pago_entrega_max'), 7),
    coalesce((SELECT CASE WHEN condicion_pago = 'CREDITO' THEN dias_credito ELSE 0 END FROM core.cliente WHERE id = p_cliente), 0),
    0)
$$;

CREATE OR REPLACE FUNCTION core.plazo_pago_propuesto(p_cliente uuid) RETURNS int LANGUAGE sql STABLE AS $$
  SELECT least(greatest(coalesce((SELECT round(valor::numeric)::int FROM core.parametro WHERE clave = 'dias_pago_entrega'), 2), 0),
               core.plazo_pago_max(p_cliente))
$$;
