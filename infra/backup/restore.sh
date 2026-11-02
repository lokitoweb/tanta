#!/bin/sh
# Restauración de un respaldo y verificación de integridad.
#
#   ./restore.sh /backups/tanta-20261101-030000.sql.gz
#
# Se ejecuta en el contenedor backup (tiene /scripts y /backups):
#   docker compose -f infra/compose/docker-compose.prod.yml exec -T backup sh /scripts/restore.sh <archivo>
set -eu

ARCHIVO="${1:?Uso: restore.sh <archivo.sql.gz>}"
SUFIJO="${ARCHIVO}.sha256"

echo "[restore] verificando checksum"
if [ -f "$SUFIJO" ]; then
  sha256sum -c "$SUFIJO"
else
  echo "[restore] ADVERTENCIA: no hay manifiesto de checksum" >&2
fi

echo "[restore] restaurando en $PGDATABASE"
gunzip -c "$ARCHIVO" | psql --quiet --set ON_ERROR_STOP=1

echo "[restore] verificando invariantes"
psql --quiet --set ON_ERROR_STOP=1 <<'SQL'
SELECT 'productos' AS tabla, count(*) FROM core.producto
UNION ALL SELECT 'ventas', count(*) FROM core.venta
UNION ALL SELECT 'movimientos', count(*) FROM core.movimiento_inventario
UNION ALL SELECT 'eventos_audit', count(*) FROM audit.evento;

-- El stock del insumo debe coincidir con el último asiento del kárdex.
SELECT i.codigo, i.stock, m.saldo_cantidad AS ultimo_asiento,
       CASE WHEN abs(i.stock - m.saldo_cantidad) < 0.000001 THEN 'OK' ELSE 'DESCUADRE' END AS estado
FROM core.insumo i
LEFT JOIN LATERAL (
  SELECT saldo_cantidad FROM core.movimiento_inventario
  WHERE insumo_id = i.id ORDER BY id DESC LIMIT 1
) m ON true
ORDER BY i.codigo;
SQL

echo "[restore] listo"
