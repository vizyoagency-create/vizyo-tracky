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
# Code de sortie : 0 si rien à faire ou import réussi, 1 si l'import a échoué (y compris interrompu
# par sa borne), 124 si une borne a été dépassée AVANT l'import (lecture de la demande, arrêt de l'API).
#
# ── V34 (CLAUDE.md) : chaque commande docker est BORNÉE (2026-10-01) ─────────────────────────────
# Mesuré dans ce journal, du 07/09 au 27/09/2026 : import 254 à 370 s ; arrêt de l'API de démo 11 à
# 13 s d'ordinaire, 149 s le 20/09 (VM bridée par l'hébergeur). Sans borne, un appel bloqué laissait
# le service `oneshot` actif pour toujours (aucun `TimeoutStartSec`) — la démo arrêtée, et plus aucun
# rafraîchissement. Une borne ne presse rien : elle transforme « bloqué » en échec DIT.
set -euo pipefail

ICI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ICI"

JOURNAL="${JOURNAL:-/var/log/tracky-demo-refresh.log}"
COMPOSE=(docker compose --env-file .env.demo -f docker-compose.demo.yml)
BORNE_LECTURE_S="${BORNE_LECTURE_S:-20}"    # la lecture de la demande (psql), toutes les 15 min
BORNE_COMPOSE_S="${BORNE_COMPOSE_S:-300}"   # arrêt / redémarrage de l'API de démo, arrêt de l'importeur
BORNE_IMPORT_S="${BORNE_IMPORT_S:-3600}"    # l'importeur : ~10 fois le plus long passage mesuré

log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$JOURNAL"; }

if [[ ! -f .env.demo ]]; then
  log "ERREUR : .env.demo introuvable dans $ICI"
  exit 1
fi

# POSTGRES_* pour interroger la base de démo depuis l'hôte (psql dans le conteneur).
#
# ⚠️ SURTOUT PAS `source .env.demo`, ET C'EST UN ÉCHEC RÉEL, PAS UNE PRÉCAUTION. Le 2026-09-07 le
# premier import s'est arrêté sur « syntax error near unexpected token `newline' » : le fichier
# contient `RESEND_FROM=Tracky Démo <demo@vizyoagency.com>`, et bash lit `<…>` comme une
# REDIRECTION. Docker Compose, lui, parse ce fichier sans passer par un shell — la valeur y est
# parfaitement valide. Un fichier d'environnement n'est donc pas un script, et le lire comme tel
# casse sur la première adresse e-mail nommée, une accolade ou une apostrophe.
#
# On extrait les deux seules variables dont ce script a besoin, littéralement.
lire_env() { grep -m1 "^$1=" .env.demo | cut -d= -f2-; }
POSTGRES_USER="$(lire_env POSTGRES_USER)"
POSTGRES_DB="$(lire_env POSTGRES_DB)"
if [ -z "$POSTGRES_USER" ] || [ -z "$POSTGRES_DB" ]; then
  log "ERREUR : POSTGRES_USER ou POSTGRES_DB absent de .env.demo"
  exit 1
fi

if [[ "${1:-}" == "--si-demande" ]]; then
  # Une demande est « en attente » si elle est postérieure au dernier passage de l'importeur.
  # Mêmes libellés que apps/api/src/demo/journal-demo.ts : les trois doivent s'accorder.
  rc=0
  EN_ATTENTE="$(timeout "$BORNE_LECTURE_S" docker exec tracky-demo-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "
    SELECT count(*) FROM system_activity_logs
    WHERE category = 'DEMO' AND action = 'refresh_requested'
      AND \"createdAt\" > COALESCE(
        (SELECT max(\"createdAt\") FROM system_activity_logs WHERE category = 'DEMO' AND action = 'refresh_done'),
        '-infinity')" 2>/dev/null)" || rc=$?
  if [ "$rc" -eq 124 ]; then
    log "Lecture de la demande impossible : borne de ${BORNE_LECTURE_S} s dépassée (V34) — rien de fait, prochain tour dans 15 min"
    exit 124
  fi
  # Base de démo injoignable : comme avant, on ne sait pas — on ne fait rien.
  if [ "$rc" -ne 0 ]; then EN_ATTENTE=0; fi
  if [[ "${EN_ATTENTE:-0}" == "0" ]]; then
    exit 0
  fi
  log "Demande de rafraîchissement trouvée dans le journal de la démo — import à la demande"
else
  log "Passage planifié — import complet"
fi

# Quoi qu'il arrive ensuite, l'API repart — y compris si son ARRÊT échoue ou dépasse sa borne : le
# piège est donc posé AVANT l'arrêt (redémarrer une API qui tourne encore ne fait rien).
redemarrer() {
  if timeout "$BORNE_COMPOSE_S" "${COMPOSE[@]}" start api >>"$JOURNAL" 2>&1; then
    log "API de démo redémarrée"
  else
    log "AVERTISSEMENT : l'API de démo n'a pas redémarré — vérifier « timeout 20 docker ps »"
  fi
}
trap redemarrer EXIT

log "Arrêt de l'API de démo"
rc=0
timeout "$BORNE_COMPOSE_S" "${COMPOSE[@]}" stop api >>"$JOURNAL" 2>&1 || rc=$?
if [ "$rc" -eq 124 ]; then
  log "ARRÊT DE L'API DE DÉMO INTERROMPU : borne de ${BORNE_COMPOSE_S} s dépassée (V34) — pas d'import"
  exit 124
elif [ "$rc" -ne 0 ]; then
  log "ARRÊT DE L'API DE DÉMO EN ÉCHEC (code $rc) — pas d'import"
  exit "$rc"
fi

# La borne n'arrête que le client `compose run` : l'importeur, lui, continuerait sans nous, pendant
# que l'API de démo repart — et son rejeu écrirait dans des tables qu'une transaction est en train
# de vider. On l'arrête donc, AVANT le redémarrage : sa transaction est annulée, la base de démo
# reste dans son état précédent. Retrouvé par les étiquettes de Compose (projet `name:` du fichier,
# service `importer`), pas par un nom : `compose run` nomme ses conteneurs `…-importer-run-<id>`.
PROJET_DEMO="$(awk '/^name:/ {print $2; exit}' docker-compose.demo.yml)"
arreter_importeur() {
  local ids
  ids="$(timeout "$BORNE_LECTURE_S" docker ps -q --filter "label=com.docker.compose.project=$PROJET_DEMO" --filter "label=com.docker.compose.service=importer" 2>/dev/null || true)"
  if [ -z "$ids" ]; then log "   (plus aucun importeur en marche)"; return 0; fi
  # shellcheck disable=SC2086 # un identifiant de conteneur par mot
  if timeout "$BORNE_COMPOSE_S" docker rm -f $ids >>"$JOURNAL" 2>&1; then
    log "   importeur arrêté ($(echo $ids))"
  else
    log "   AVERTISSEMENT : l'importeur n'a pas pu être arrêté — vérifier « timeout 20 docker ps --filter label=com.docker.compose.service=importer »"
  fi
}

log "Import…"
rc=0
timeout "$BORNE_IMPORT_S" "${COMPOSE[@]}" run --rm importer >>"$JOURNAL" 2>&1 || rc=$?
if [ "$rc" -eq 0 ]; then
  log "Import réussi"
elif [ "$rc" -eq 124 ]; then
  log "IMPORT INTERROMPU : borne de ${BORNE_IMPORT_S} s dépassée (V34) — la base de démo reste dans son état précédent"
  arreter_importeur
  exit 1
else
  log "IMPORT EN ÉCHEC — la base de démo est restée dans son état précédent (voir ci-dessus, et la carte /admin/demo)"
  exit 1
fi
