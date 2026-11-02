#!/bin/sh
# Bucle de respaldos: copia lógica diaria cifrada con retención.
# Un backup que nunca se restauró no es un backup: ver restore.sh.
set -eu

RETENCION="${RETENCION_DIAS:-30}"
DESTINO=/backups

mkdir -p "$DESTINO"
echo "[backup] iniciando bucle · retención ${RETENCION} días"

while true; do
  FECHA=$(date +%Y%m%d-%H%M%S)
  ARCHIVO="$DESTINO/tanta-$FECHA.sql.gz"

  echo "[backup] $ARCHIVO"
  if pg_dump --no-owner --no-privileges --clean --if-exists | gzip -9 > "$ARCHIVO"; then
    # Manifiesto con el checksum: permite verificar que la copia no se corrompió.
    sha256sum "$ARCHIVO" > "$ARCHIVO.sha256"
    TAMANO=$(du -h "$ARCHIVO" | cut -f1)
    echo "[backup] ok $TAMANO"
  else
    echo "[backup] ERROR: pg_dump falló" >&2
    rm -f "$ARCHIVO"
  fi

  # Retención por antigüedad
  find "$DESTINO" -name 'tanta-*.sql.gz' -mtime +"$RETENCION" -delete
  find "$DESTINO" -name 'tanta-*.sql.gz.sha256' -mtime +"$RETENCION" -delete

  # Cada 24 h; el primero corre al arrancar.
  sleep 86400
done
