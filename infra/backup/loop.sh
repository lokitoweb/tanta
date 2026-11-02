#!/bin/sh
# Bucle de respaldos: copia lógica diaria con retención y verificación.
# Un backup que nunca se restauró no es un backup: ver restore.sh y docs/17 §Restauración.
set -eu

RETENCION="${RETENCION_DIAS:-30}"
DESTINO=/backups

mkdir -p "$DESTINO"
echo "[backup] iniciando bucle · retención ${RETENCION} días"

while true; do
  # Al arrancar el stack, Postgres puede estar aún en su arranque inicial: se espera de verdad.
  until pg_isready -q; do sleep 3; done

  FECHA=$(date +%Y%m%d-%H%M%S)
  ARCHIVO="$DESTINO/tanta-$FECHA.sql.gz"
  echo "[backup] $ARCHIVO"

  # pg_dump escribe directo a un archivo (sin tubería): un fallo de pg_dump
  # no queda oculto detrás del código de salida de gzip (antes salían respaldos vacíos "ok").
  if pg_dump --no-owner --no-privileges --clean --if-exists -Fp -f "$ARCHIVO.tmp.sql" \
     && [ -s "$ARCHIVO.tmp.sql" ] \
     && gzip -9 -c "$ARCHIVO.tmp.sql" > "$ARCHIVO.tmp" \
     && gzip -t "$ARCHIVO.tmp" \
     && [ "$(gzip -cd "$ARCHIVO.tmp" | head -c 200 | wc -c)" -gt 0 ]; then
    mv "$ARCHIVO.tmp" "$ARCHIVO"
    rm -f "$ARCHIVO.tmp.sql"
    sha256sum "$ARCHIVO" > "$ARCHIVO.sha256"
    echo "[backup] ok $(du -h "$ARCHIVO" | cut -f1)"
    ESPERA=86400
  else
    echo "[backup] ERROR: el respaldo falló; se reintenta en 5 minutos" >&2
    rm -f "$ARCHIVO.tmp" "$ARCHIVO.tmp.sql"
    ESPERA=300
  fi

  # Retención por antigüedad
  find "$DESTINO" -name 'tanta-*.sql.gz' -mtime +"$RETENCION" -delete
  find "$DESTINO" -name 'tanta-*.sql.gz.sha256' -mtime +"$RETENCION" -delete

  sleep "$ESPERA"
done
