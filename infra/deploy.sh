#!/usr/bin/env bash
# Despliegue de Tanta en el servidor (se ejecuta DENTRO del servidor, como el usuario tanta).
#
#   infra/deploy.sh                # trae origin/production (lo que pasó las pruebas en GitHub) y despliega
#   infra/deploy.sh --if-changed   # solo si production cambió (modo cron, cada 2 minutos)
#   infra/deploy.sh --ref <sha>    # despliega ese commit (volver a una versión anterior)
#
# Pasos: respaldo de la base → código nuevo → compila imágenes (si falla, nada cambió) → reinicia →
# espera /api/v1/health. Si no queda sano, vuelve solo al commit anterior.
# Una migración ya aplicada no se deshace sola: para eso está el respaldo (respaldos-despliegue/).
#
# Variables opcionales: SALUD_URL (por defecto http://127.0.0.1:8090/api/v1/health),
# DEPLOY_BACKUP_DIR (por defecto ../respaldos-despliegue), DEPLOY_BACKUP_KEEP (15).
set -Eeuo pipefail

# Todo va dentro de main(): bash lee la función completa antes de ejecutarla, así el git reset
# que reemplaza este mismo archivo a mitad del despliegue no lo corrompe.
main() {
  APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$APP_DIR"
  log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }

  REF=""; IF_CHANGED=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ref) REF="${2:-}"; shift 2 ;;
      --if-changed) IF_CHANGED=1; shift ;;
      -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
      *) echo "Opción desconocida: $1" >&2; exit 2 ;;
    esac
  done

  [[ -f .env.production ]] || { echo "Falta .env.production en $APP_DIR" >&2; exit 1; }
  DC=(docker compose --env-file .env.production -f infra/compose/docker-compose.prod.yml)
  SALUD="${SALUD_URL:-http://127.0.0.1:8090/api/v1/health}"
  RESP="${DEPLOY_BACKUP_DIR:-$APP_DIR/../respaldos-despliegue}"

  # Un solo despliegue a la vez (el cron y una corrida a mano pueden coincidir).
  exec 9>"$APP_DIR/../.deploy.lock"
  flock -n 9 || { [[ $IF_CHANGED -eq 1 ]] || log "Ya hay un despliegue en curso."; exit 0; }

  if [[ -z "$REF" ]]; then
    RAMA=production
    git ls-remote --exit-code --heads origin production >/dev/null 2>&1 || RAMA=main
    git fetch -q origin "$RAMA"
    REF="$(git rev-parse "origin/$RAMA")"
  else
    git fetch -q origin
    REF="$(git rev-parse "$REF^{commit}")"
  fi
  ANTERIOR="$(git rev-parse HEAD)"
  if [[ "$REF" == "$ANTERIOR" ]]; then
    [[ $IF_CHANGED -eq 1 ]] || log "Ya está en ${REF::7}: nada que desplegar."
    exit 0
  fi
  # Un commit que ya falló no se reintenta cada 2 minutos: espera al siguiente (o a una corrida a mano).
  FALLIDO="$APP_DIR/../.deploy-fallido"
  if [[ $IF_CHANGED -eq 1 && "$(cat "$FALLIDO" 2>/dev/null)" == "$REF" ]]; then exit 0; fi
  log "Desplegando ${ANTERIOR::7} → ${REF::7}"

  sano() {
    for _ in $(seq 1 45); do
      curl -fsS -m 3 "$SALUD" 2>/dev/null | grep -q '"baseDatos":"ok"' && return 0
      sleep 2
    done
    return 1
  }
  levantar() { "${DC[@]}" build -q api caddy && "${DC[@]}" up -d --remove-orphans; }

  # 1. Respaldo de la base (si falla, no se despliega).
  mkdir -p "$RESP" && chmod 700 "$RESP"
  ARCH="$RESP/antes_de_${REF::7}_$(date +%Y%m%d_%H%M%S).dump"
  "${DC[@]}" exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$ARCH"
  chmod 600 "$ARCH"
  [[ -s "$ARCH" ]] || { rm -f "$ARCH"; log "✗ El respaldo salió vacío: no se despliega."; exit 1; }
  ls -1t "$RESP"/*.dump 2>/dev/null | tail -n +"$(( ${DEPLOY_BACKUP_KEEP:-15} + 1 ))" | xargs -r rm -f
  log "Respaldo: $ARCH"

  # 2. Código nuevo, imágenes y reinicio. El API aplica las migraciones al arrancar.
  git reset -q --hard "$REF"
  if levantar && sano; then
    rm -f "$FALLIDO"
    docker image prune -f >/dev/null 2>&1 || true
    log "✓ Desplegado ${REF::7}: $(git log -1 --format=%s | cut -c1-100)"
    exit 0
  fi

  # 3. Algo falló: vuelve al commit anterior.
  log "✗ ${REF::7} no quedó sano. Volviendo a ${ANTERIOR::7}…"
  "${DC[@]}" logs --tail 30 api 2>&1 | sed 's/^/    /' || true
  echo "$REF" > "$FALLIDO"
  git reset -q --hard "$ANTERIOR"
  if levantar && sano; then
    log "Restaurado ${ANTERIOR::7}. Revisa el error antes de volver a subir."
  else
    log "✗✗ Tampoco quedó sano ${ANTERIOR::7}. Revisar a mano. Respaldo de la base: $ARCH"
  fi
  exit 1
}

main "$@"
