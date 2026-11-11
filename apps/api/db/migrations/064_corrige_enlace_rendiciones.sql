-- Corrige el enlace inicial de la 063 (ligó los cobros a su rendición solo por vendedor y fecha).
-- Una rendición recibida incluía los cobros que existían al rendir: los primeros del día hasta sumar su total.
-- Los registrados después nunca entraron a caja grande: se sueltan y quedan por rendir (rendición complementaria).
WITH orden AS (
  SELECT b.id, r.total,
         sum(b.monto) OVER (PARTITION BY b.rendicion_id ORDER BY b.creado_en, b.id) AS acumulado
  FROM core.cobranza b JOIN core.rendicion_cobranza r ON r.id = b.rendicion_id
  WHERE r.estado = 'RECIBIDA'
)
UPDATE core.cobranza b SET rendicion_id = NULL
FROM orden o
WHERE o.id = b.id AND o.acumulado > o.total + 0.005;
