#!/bin/bash
# V1.5 (Sprint I) — Backup auto Postgres avec retention 30j + healthcheck API.
#
# Usage : declenche par systemd timer (cf. deploy/vps/tracky-backup.timer) tous
# les jours a 03:00 UTC. Aussi executable a la main pour test.
#
# Variables d'environnement attendues (a definir dans /etc/tracky-backup.env) :
#   API_URL                = https://tracky-api.vizyoagency.com
#   INTERNAL_API_SECRET    = (meme valeur que cote API)
#   BACKUP_DIR             = /var/backups/vizyo-tracky (defaut)
#   RETENTION_DAYS         = 30 (defaut)
#   RCLONE_REMOTE          = (optionnel, ex: 'b2:tracky-backups')
#                            Si defini, upload via rclone vers ce remote.

set -euo pipefail

# Defaults
BACKUP_DIR="${BACKUP_DIR:-/var/backups/vizyo-tracky}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
API_URL="${API_URL:-}"
INTERNAL_API_SECRET="${INTERNAL_API_SECRET:-}"
RCLONE_REMOTE="${RCLONE_REMOTE:-}"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
FILENAME="tracky_prod_${TIMESTAMP}.sql.gz"
DESTINATION="local"
START_MS=$(date +%s%3N)

mkdir -p "$BACKUP_DIR"

post_health() {
  local status="$1"
  local size="$2"
  local duration_ms="$3"
  local destination="$4"
  local filename="$5"
  local error="${6:-}"

  if [ -z "$API_URL" ] || [ -z "$INTERNAL_API_SECRET" ]; then
    echo "[$(date)] WARN: API_URL or INTERNAL_API_SECRET not set, skipping healthcheck POST"
    return 0
  fi

  local payload
  payload=$(cat <<EOF
{
  "status": "$status",
  "sizeBytes": $size,
  "durationMs": $duration_ms,
  "destination": "$destination",
  "filename": "$filename",
  "errorMessage": $(if [ -n "$error" ]; then printf '"%s"' "${error//\"/\\\"}"; else printf 'null'; fi)
}
EOF
)
  curl -fsS -X POST \
    -H "Content-Type: application/json" \
    -H "X-Internal-Secret: $INTERNAL_API_SECRET" \
    -d "$payload" \
    "$API_URL/api/internal/backup-health" >/dev/null || \
    echo "[$(date)] WARN: healthcheck POST failed (API unreachable?)"
}

trap 'post_health "FAILED" 0 0 "$DESTINATION" "$FILENAME" "Backup script crashed"' ERR

# 1) pg_dump local
docker exec tracky-postgres pg_dump -U tracky tracky_prod | gzip > \
  "${BACKUP_DIR}/${FILENAME}"

SIZE=$(stat -c%s "${BACKUP_DIR}/${FILENAME}")

# 2) Upload offsite si RCLONE_REMOTE est defini
if [ -n "$RCLONE_REMOTE" ]; then
  if command -v rclone >/dev/null 2>&1; then
    rclone copy "${BACKUP_DIR}/${FILENAME}" "$RCLONE_REMOTE" --quiet
    DESTINATION="rclone:${RCLONE_REMOTE}"
    # Retention offsite : garder les 30 plus recents
    rclone delete --min-age "${RETENTION_DAYS}d" "$RCLONE_REMOTE" --quiet || true
  else
    echo "[$(date)] WARN: rclone not installed, skipping offsite upload"
  fi
fi

# 3) Rotation locale
find "$BACKUP_DIR" -name "tracky_prod_*.sql.gz" -mtime +${RETENTION_DAYS} -delete

# 4) Healthcheck API (succes)
END_MS=$(date +%s%3N)
DURATION=$((END_MS - START_MS))
post_health "OK" "$SIZE" "$DURATION" "$DESTINATION" "$FILENAME" ""

echo "[$(date)] Backup OK: ${FILENAME} ($(du -h "${BACKUP_DIR}/${FILENAME}" | cut -f1)) [${DESTINATION}, ${DURATION}ms]"
