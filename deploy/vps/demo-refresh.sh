#!/bin/bash
# ═══ demo-refresh.sh — rafraîchit la base de DÉMONSTRATION depuis la production ═════════════
#
# Usage (depuis n'importe où ; le script se place lui-même dans deploy/vps) :
#   demo-refresh.sh                → import complet (timer hebdomadaire, dimanche 04:00 UTC,
#                                    après la sauvegarde de 03:00 — cf. tracky-demo-refresh.timer)
#   demo-refresh.sh --si-demande   → n'importe QUE si l'écran d'administration a déposé une
#                                    demande (timer toutes les 15 min — tracky-demo-refresh-demande.timer)
#
# Ce que fait un passage :
#   1. arrête l'API de démo — le rejeu ne doit pas écrire des positions pendant qu'on vide
#      et recharge ses tables ;
#   2. lance l'importeur dans un conteneur ÉPHÉMÈRE (profil `refresh` du compose), le seul à
#      voir la production, par un rôle SELECT seulement ;
#   3. redémarre l'API — TOUJOURS, import réussi ou non : un import qui échoue laisse la base
#      dans son état précédent (une seule transaction), la démo reste servie.
#
# Le résultat est consigné dans la base de démo elle-même (system_activity_logs, catégorie
# DEMO) — c'est ce que la carte d'administration affiche — et dans /var/log/tracky-demo-refresh.log.
#
# Code de sortie : 0 si rien à faire ou import réussi, 1 si l'import a échoué.
set -euo pipefail

ICI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ICI"

JOURNAL="${JOURNAL:-/var/log/tracky-demo-refresh.log}"
COMPOSE=(docker compose --env-file .env.demo -f docker-compose.demo.yml)

log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$JOURNAL"; }

if [[ ! -f .env.demo ]]; then
  log "ERREUR : .env.demo introuvable dans $ICI"
  exit 1
fi

# POSTGRES_* pour interroger la base de démo depuis l'hôte (psql dans le conteneur).
set -a
# shellcheck disable=SC1091
source .env.demo
set +a

if [[ "${1:-}" == "--si-demande" ]]; then
  # Une demande est « en attente » si elle est postérieure au dernier passage de l'importeur.
  # Mêmes libellés que apps/api/src/demo/journal-demo.ts : les trois doivent s'accorder.
  EN_ATTENTE="$(docker exec tracky-demo-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "
    SELECT count(*) FROM system_activity_logs
    WHERE category = 'DEMO' AND action = 'refresh_requested'
      AND \"createdAt\" > COALESCE(
        (SELECT max(\"createdAt\") FROM system_activity_logs WHERE category = 'DEMO' AND action = 'refresh_done'),
        '-infinity')" 2>/dev/null || echo 0)"
  if [[ "${EN_ATTENTE:-0}" == "0" ]]; then
    exit 0
  fi
  log "Demande de rafraîchissement trouvée dans le journal de la démo — import à la demande"
else
  log "Passage planifié — import complet"
fi

log "Arrêt de l'API de démo"
"${COMPOSE[@]}" stop api >>"$JOURNAL" 2>&1

# Quoi qu'il arrive ensuite, l'API repart.
redemarrer() {
  "${COMPOSE[@]}" start api >>"$JOURNAL" 2>&1 || log "AVERTISSEMENT : l'API de démo n'a pas redémarré — vérifier « docker ps »"
  log "API de démo redémarrée"
}
trap redemarrer EXIT

log "Import…"
if "${COMPOSE[@]}" run --rm importer >>"$JOURNAL" 2>&1; then
  log "Import réussi"
else
  log "IMPORT EN ÉCHEC — la base de démo est restée dans son état précédent (voir ci-dessus, et la carte /admin/demo)"
  exit 1
fi
