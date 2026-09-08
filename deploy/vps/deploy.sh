#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════════════════
# DÉPLOIEMENT DE LA PRODUCTION — ET LA GARDE QUI MANQUAIT
# ═══════════════════════════════════════════════════════════════════════════════════════════
#
# Usage, depuis le VPS :
#     bash /opt/vizyo-tracky/deploy/vps/deploy.sh            # refuse si un passage tourne
#     bash /opt/vizyo-tracky/deploy/vps/deploy.sh --force    # déploie quand même, et le dit
#     bash /opt/vizyo-tracky/deploy/vps/deploy.sh --avec-demo  # met aussi la démo à jour
#
# ── POURQUOI CE SCRIPT EXISTE ─────────────────────────────────────────────────────────────
#
# L'automatisation des trajets part à HH:45 et dure de 2 à 54 minutes selon la charge.
# Recréer le conteneur de l'API pendant ce temps TUE le passage : les trajets de l'heure ne
# sont ni recalculés, ni analysés, ni racontés, et la reprise attend le passage suivant.
#
# Mesuré en production le 2026-09-07 : QUATRE passages tués dans la même journée (14:45,
# 15:45, 17:45, 23:45 UTC), tous par des déploiements. À l'époque, rien n'en gardait trace —
# depuis « la ligne au départ » (2026-09-08), un passage en cours porte `status='running'`
# dans `trip_automation_runs`, donc il SE VOIT. Ce script le lit avant de toucher à quoi que
# ce soit : la garde ne repose plus sur la vigilance de celui qui déploie.
#
# ⚠️ Le refus n'est pas un blocage : `--force` passe outre, en le disant. Un correctif urgent
# vaut parfois un passage perdu — mais ce doit être un choix, pas une surprise.
set -euo pipefail

RACINE="${RACINE:-/opt/vizyo-tracky}"
COMPOSE_PROD="docker-compose.prod.yml"
COMPOSE_DEMO="docker-compose.demo.yml"
FORCE=0
AVEC_DEMO=0

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --avec-demo) AVEC_DEMO=1 ;;
    *) echo "Option inconnue : $arg" >&2; exit 2 ;;
  esac
done

dire() { echo "[$(date -u +%H:%M:%S) UTC] $*"; }

# ── 1. UN PASSAGE D'AUTOMATISATION TOURNE-T-IL ? ──────────────────────────────────────────
#
# La lecture est défensive de bout en bout : base injoignable, table absente, conteneur arrêté
# — on ne sait pas, donc on laisse passer. Une garde qui empêche de déployer parce qu'elle ne
# sait pas lire serait pire que pas de garde.
passage_en_cours() {
  docker exec tracky-postgres psql -U tracky -d tracky_prod -At -F '|' -c \
    "SELECT to_char(\"startedAt\", 'HH24:MI:SS'), origin,
            round(extract(epoch from (now() - \"startedAt\")) / 60)::int
     FROM trip_automation_runs WHERE status = 'running'
     ORDER BY \"startedAt\" DESC LIMIT 1" 2>/dev/null || true
}

EN_COURS="$(passage_en_cours)"
if [ -n "$EN_COURS" ]; then
  DEBUT="$(echo "$EN_COURS" | cut -d'|' -f1)"
  ORIGINE="$(echo "$EN_COURS" | cut -d'|' -f2)"
  MINUTES="$(echo "$EN_COURS" | cut -d'|' -f3)"
  if [ "$FORCE" -eq 1 ]; then
    dire "⚠️  Passage d'automatisation EN COURS (départ $DEBUT UTC, $ORIGINE, $MINUTES min) — --force : on déploie."
    dire "    Ce passage sera tué. Il apparaîtra « Interrompu » dans l'historique, et une alerte critique partira."
  else
    dire "⛔ Déploiement REFUSÉ : un passage d'automatisation tourne (départ $DEBUT UTC, $ORIGINE, $MINUTES min)."
    dire "   Il dure jusqu'à 54 min. Attendre sa fin, ou relancer avec --force en acceptant de le tuer."
    dire "   État : docker exec tracky-postgres psql -U tracky -d tracky_prod -c \\"
    dire "            \"select \\\"startedAt\\\", status from trip_automation_runs order by \\\"startedAt\\\" desc limit 3\""
    exit 1
  fi
fi

# ── 2. LE CODE ────────────────────────────────────────────────────────────────────────────
cd "$RACINE"
dire "git pull --ff-only origin main"
git pull --ff-only origin main
dire "HEAD : $(git log --oneline -1)"

# ── 3. LES CONTENEURS ─────────────────────────────────────────────────────────────────────
#
# ⚠️ `--env-file .env.prod` est OBLIGATOIRE : compose lit `.env` par défaut pour l'interpolation,
# et `env_file:` dans le service ne s'applique qu'au runtime du conteneur. Sans le flag, le
# déploiement échoue sur « network <vide> declared as external ». Cf. deploy/vps/README.md.
cd "$RACINE/deploy/vps"
dire "docker compose up -d --build (prod)"
docker compose --env-file .env.prod -f "$COMPOSE_PROD" up -d --build

if [ "$AVEC_DEMO" -eq 1 ]; then
  dire "docker compose up -d (démo, mêmes images)"
  docker compose --env-file .env.demo -f "$COMPOSE_DEMO" up -d
fi

# ── 4. CE QUI TOURNE VRAIMENT ─────────────────────────────────────────────────────────────
#
# ⚠️ Un `up -d --build` peut rendre la main en exit 0 SANS avoir recréé les conteneurs (mesuré
# le 2026-09-07). L'âge affiché ici est la seule preuve : « Up 4 weeks » après un déploiement
# veut dire que rien n'a été remplacé.
dire "état des conteneurs :"
docker ps --format '  {{.Names}} — {{.Status}}' | grep -E 'tracky-(api|web|demo-api|demo-web)' || true
dire "Déploiement terminé. Vérifier l'artefact compilé, pas seulement docker ps."
