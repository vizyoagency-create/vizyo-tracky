#!/bin/bash
set -euo pipefail

BACKUP_DIR="/var/backups/vizyo-tracky"
RETENTION_DAYS=7
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
FILENAME="tracky_prod_${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

docker exec tracky-postgres pg_dump -U tracky tracky_prod | gzip > \
  "${BACKUP_DIR}/${FILENAME}"

# Rotation : supprimer les backups > 7 jours
find "$BACKUP_DIR" -name "tracky_prod_*.sql.gz" -mtime +${RETENTION_DAYS} -delete

echo "[$(date)] Backup OK: ${FILENAME} ($(du -h "${BACKUP_DIR}/${FILENAME}" | cut -f1))"
