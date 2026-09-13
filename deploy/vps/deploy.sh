#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════════════════
# DÉPLOIEMENT DE LA PRODUCTION — LE SEUL CHEMIN (décision D1 du propriétaire, 2026-09-13)
# ═══════════════════════════════════════════════════════════════════════════════════════════
#
# Usage, depuis le VPS :
#     bash /opt/vizyo-tracky/deploy/vps/deploy.sh                # refuse si un passage tourne ou va partir
#     bash /opt/vizyo-tracky/deploy/vps/deploy.sh --attendre     # patiente (65 min au plus) au lieu de refuser
#     bash /opt/vizyo-tracky/deploy/vps/deploy.sh --force        # déploie quand même, et le dit
#     bash /opt/vizyo-tracky/deploy/vps/deploy.sh --avec-demo    # met aussi la démo à jour
#     bash /opt/vizyo-tracky/deploy/vps/deploy.sh --branche X    # une autre branche que main
#     bash /opt/vizyo-tracky/deploy/vps/deploy.sh --repli avant-20260913-1130-a8f9575e
#                                                                # revient aux images étiquetées, sans rebuild
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
# ── TRK-077 (2026-09-09) : LA GARDE LISAIT AU MAUVAIS MOMENT ──────────────────────────────
#
# Elle lisait UNE fois, au départ, puis `git pull` et une construction de plusieurs minutes
# précédaient la recréation du conteneur — la seule chose qui tue. Chronologie mesurée le
# 09/09 : garde franchie vers 17:43 À JUSTE TITRE, passage parti à 17:45:00.145, image
# construite à 17:46:09, passage tué à 17:46:43. La garde protégeait de tout sauf du cas le
# plus probable : le déploiement lancé juste avant l'heure ronde.
#
# Désormais la construction et la recréation sont deux étapes, et la garde est relue JUSTE
# AVANT la recréation. Et parce qu'une API qui redémarre à cheval sur le tic de :45 manque
# le tic sans laisser de trace — pire qu'un passage tué, qui lui est marqué « interrompu » —,
# la recréation est refusée de HH:42 à HH:46 : à :46, le passage s'est déclaré et la garde
# le voit.
#
# ── CE QUI REND LE SCRIPT INCONTOURNABLE ─────────────────────────────────────────────────
#
# On peut toujours taper `docker compose up` à la main. On ne peut plus le faire sans que ça
# se voie : chaque déploiement inscrit ici l'identifiant du conteneur qu'il a créé
# (journal ci-dessous, monté en lecture seule dans l'API), et l'API compare au démarrage son
# propre identifiant au dernier journalisé. Un conteneur que ce script n'a pas créé produit
# une ligne « déploiement hors script » au centre d'alerte.
#
# ⚠️ Le refus n'est pas un blocage : `--attendre` patiente, `--force` passe outre en le disant.
# Un correctif urgent vaut parfois un passage perdu — mais ce doit être un choix, pas une
# surprise.
set -euo pipefail

RACINE="${RACINE:-/opt/vizyo-tracky}"
# Hors de l'arbre git (y écrire ferait échouer le prochain `git pull`), monté `:ro` dans l'API.
JOURNAL="${JOURNAL_DEPLOIEMENTS:-/opt/tracky-deploiements/journal.jsonl}"
COMPOSE_PROD="docker-compose.prod.yml"
COMPOSE_DEMO="docker-compose.demo.yml"
IMAGES="tracky-api tracky-web"
FORCE=0
ATTENDRE=0
AVEC_DEMO=0
BRANCHE=main
REPLI=""

# Un passage dure 54 min au plus : au-delà de 65 min d'attente, quelque chose d'autre cloche.
ATTENTE_MAX_S=$((65 * 60))
# Minutes (incluse, exclue) pendant lesquelles on ne recrée PAS l'API : le passage va partir.
FENETRE_DEBUT=42
FENETRE_FIN=46
# Repères de repli conservés par image, le nouveau compris.
REPLIS_A_GARDER=3

dire() { echo "[$(date -u +%H:%M:%S) UTC] $*"; }

# ── l'horloge et les commandes, isolées pour les tests (deploy.test.sh les remplace) ───────
minute_utc()   { local m; m="$(date -u +%M)"; echo "${m#0}"; }
seconde_utc()  { local s; s="$(date -u +%S)"; echo "${s#0}"; }
epoch_s()      { date -u +%s; }
horodatage_etiquette() { date -u +%Y%m%d-%H%M; }
maintenant_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

lire_options() {
  local attend_valeur=""
  for arg in "$@"; do
    if [ -n "$attend_valeur" ]; then
      case "$attend_valeur" in
        branche) BRANCHE="$arg" ;;
        repli) REPLI="$arg" ;;
      esac
      attend_valeur=""
      continue
    fi
    case "$arg" in
      --force) FORCE=1 ;;
      --attendre) ATTENDRE=1 ;;
      --avec-demo) AVEC_DEMO=1 ;;
      --branche) attend_valeur=branche ;;
      --repli) attend_valeur=repli ;;
      *) echo "Option inconnue : $arg" >&2; return 2 ;;
    esac
  done
  if [ -n "$attend_valeur" ]; then echo "Option --$attend_valeur sans valeur" >&2; return 2; fi
  return 0
}

# ── UN PASSAGE D'AUTOMATISATION TOURNE-T-IL ? ────────────────────────────────────────────
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

dans_la_fenetre() {
  local m; m="$(minute_utc)"
  [ "$m" -ge "$FENETRE_DEBUT" ] && [ "$m" -lt "$FENETRE_FIN" ]
}

# ── LA GARDE — jouée au départ (économiser un pull et un build) ET juste avant la recréation ─
#
#   $1 = « depart » ou « recreation », pour les messages.
#   Rend 0 quand on peut continuer ; sort avec 1 quand il faut s'arrêter.
garde() {
  local moment="$1"
  local t0; t0="$(epoch_s)"
  while :; do
    # 1. un passage tourne
    local en_cours; en_cours="$(passage_en_cours)"
    if [ -n "$en_cours" ]; then
      local debut origine minutes
      debut="$(echo "$en_cours" | cut -d'|' -f1)"
      origine="$(echo "$en_cours" | cut -d'|' -f2)"
      minutes="$(echo "$en_cours" | cut -d'|' -f3)"
      if [ "$FORCE" -eq 1 ]; then
        dire "⚠️  Passage d'automatisation EN COURS (départ $debut UTC, $origine, $minutes min) — --force : on continue."
        dire "    Ce passage sera tué. Il apparaîtra « Interrompu » dans l'historique, et une alerte critique partira."
        return 0
      fi
      if [ "$ATTENDRE" -eq 1 ]; then
        if [ $(( $(epoch_s) - t0 )) -ge "$ATTENTE_MAX_S" ]; then
          dire "⛔ Attente de plus de $((ATTENTE_MAX_S / 60)) min : un passage ne dure jamais autant. Quelque chose d'autre cloche — on s'arrête sans déployer."
          exit 1
        fi
        dire "⏳ Passage d'automatisation en cours (départ $debut UTC, $minutes min) — on patiente 30 s."
        sleep 30
        continue
      fi
      dire "⛔ Déploiement REFUSÉ ($moment) : un passage d'automatisation tourne (départ $debut UTC, $origine, $minutes min)."
      dire "   Il dure jusqu'à 54 min. Relancer après sa fin, ou avec --attendre (patiente), ou --force (le tue en le disant)."
      dire "   État : docker exec tracky-postgres psql -U tracky -d tracky_prod -c \\"
      dire "            \"select \\\"startedAt\\\", status from trip_automation_runs order by \\\"startedAt\\\" desc limit 3\""
      exit 1
    fi
    # 2. le passage va partir (HH:42 → HH:46)
    if dans_la_fenetre; then
      local m s
      m="$(minute_utc)"; s="$(seconde_utc)"
      if [ "$FORCE" -eq 1 ]; then
        dire "⚠️  Il est HH:$(printf '%02d' "$m") — le passage de HH:45 va partir. --force : on continue quand même."
        return 0
      fi
      if [ "$ATTENDRE" -eq 1 ]; then
        local reste=$(( (FENETRE_FIN - m) * 60 - s ))
        dire "⏳ Il est HH:$(printf '%02d' "$m") — le passage de HH:45 va partir : on patiente jusqu'à HH:46 ($reste s), puis on relit la garde."
        sleep "$reste"
        continue
      fi
      dire "⛔ Déploiement REFUSÉ ($moment) : il est HH:$(printf '%02d' "$m") et le passage de HH:45 va partir."
      dire "   Recréer l'API maintenant la ferait redémarrer à cheval sur son tic de :45 — passage perdu SANS trace,"
      dire "   pire qu'un passage tué (qui, lui, est marqué « interrompu »). Relancer après HH:46, ou --attendre, ou --force."
      exit 1
    fi
    return 0
  done
}

# ── LES REPÈRES DE REPLI ─────────────────────────────────────────────────────────────────────
#
# Posés AVANT le pull : c'est le code qui tourne qu'on étiquette, sous le sha qui est le sien.
# Trois par image, le nouveau compris — l'élagage retire l'étiquette, jamais une image encore
# étiquetée `latest` ; les couches devenues orphelines partent avec l'élagage habituel du VPS.
etiqueter_repli() {
  local etiquette="avant-$(horodatage_etiquette)-$(git -C "$RACINE" rev-parse --short HEAD)"
  local image
  for image in $IMAGES; do
    if ! docker image inspect "$image:latest" >/dev/null 2>&1; then
      dire "   (pas d'image $image:latest à étiqueter — premier déploiement ?)"
      continue
    fi
    # Les étiquettes se trient par leur date : les plus anciennes d'abord.
    local anciennes; anciennes="$(docker images "$image" --format '{{.Tag}}' | grep '^avant-' | sort || true)"
    local a_retirer; a_retirer="$(echo "$anciennes" | sed '/^$/d' | head -n "-$((REPLIS_A_GARDER - 1))" || true)"
    local vieille
    for vieille in $a_retirer; do
      docker rmi "$image:$vieille" >/dev/null 2>&1 || true
      dire "   repère élagué : $image:$vieille"
    done
    docker tag "$image:latest" "$image:$etiquette"
    dire "   repère posé : $image:$etiquette"
  done
  dire "   Revenir en arrière : bash deploy/vps/deploy.sh --repli $etiquette"
}

# `--repli` : les images étiquetées redeviennent `latest`, puis on recrée — même garde.
reprendre_repli() {
  local image
  for image in $IMAGES; do
    if ! docker image inspect "$image:$REPLI" >/dev/null 2>&1; then
      dire "⛔ Repère introuvable : $image:$REPLI. Repères disponibles :"
      docker images "$image" --format '   {{.Repository}}:{{.Tag}}  ({{.CreatedSince}})' | grep 'avant-' || dire "   (aucun)"
      exit 2
    fi
  done
  for image in $IMAGES; do
    docker tag "$image:$REPLI" "$image:latest"
    dire "   $image:$REPLI → $image:latest"
  done
}

# ── LE JOURNAL — ce qui rend un contournement visible ────────────────────────────────────────
journaliser() {
  local sha="$1" duree="$2"
  local id_api id_web
  id_api="$(docker inspect --format '{{.Id}}' tracky-api 2>/dev/null || echo '')"
  id_web="$(docker inspect --format '{{.Id}}' tracky-web 2>/dev/null || echo '')"
  # Qui a déployé, et d'où : `SSH_CLIENT` n'existe pas hors SSH (console, test) — sans valeur
  # par défaut, `set -u` ferait échouer le journal après un déploiement réussi.
  local client="${SSH_CLIENT:-}"
  local par="${SUDO_USER:-${USER:-?}}@${client%% *}"
  local force=false attente=false repli=null
  [ "$FORCE" -eq 1 ] && force=true
  [ "$ATTENDRE" -eq 1 ] && attente=true
  [ -n "$REPLI" ] && repli="\"$REPLI\""
  mkdir -p "$(dirname "$JOURNAL")"
  printf '{"at":"%s","sha":"%s","branche":"%s","apiContainerId":"%s","webContainerId":"%s","force":%s,"attente":%s,"repli":%s,"par":"%s","dureeS":%s}\n' \
    "$(maintenant_iso)" "$sha" "$BRANCHE" "$id_api" "$id_web" "$force" "$attente" "$repli" "$par" "$duree" >> "$JOURNAL"
  dire "   journal : $JOURNAL"
}

main() {
  lire_options "$@" || exit $?
  local t0; t0="$(epoch_s)"

  # ── 1. la garde, une première fois : inutile de tirer et de construire pour rien ──
  garde depart

  local sha
  if [ -n "$REPLI" ]; then
    # ── 2'. un repli : pas de code, pas de build — les images étiquetées ──
    dire "repli vers $REPLI"
    reprendre_repli
    sha="$(git -C "$RACINE" rev-parse --short HEAD)"
  else
    # ── 2. les repères, PUIS le code ──
    dire "repères de repli :"
    etiqueter_repli
    cd "$RACINE"
    dire "git checkout $BRANCHE && git pull --ff-only origin $BRANCHE"
    git checkout -q "$BRANCHE"
    git pull --ff-only origin "$BRANCHE"
    dire "HEAD : $(git log --oneline -1)"
    sha="$(git rev-parse --short HEAD)"

    # ── 3. CONSTRUIRE — long, et sans effet sur ce qui tourne ──
    #
    # ⚠️ `--env-file .env.prod` est OBLIGATOIRE : compose lit `.env` par défaut pour
    # l'interpolation, et `env_file:` dans le service ne s'applique qu'au runtime du conteneur.
    # Sans le flag, le déploiement échoue sur « network <vide> declared as external ».
    cd "$RACINE/deploy/vps"
    dire "docker compose build (prod)"
    docker compose --env-file .env.prod -f "$COMPOSE_PROD" build
  fi

  # ── 4. LA GARDE, À NOUVEAU — c'est maintenant que ça tue (TRK-077) ──
  cd "$RACINE/deploy/vps"
  garde recreation

  # ── 5. RECRÉER — court : les images sont prêtes ──
  # Le dossier du journal AVANT le `up` : le compose le monte dans l'API, et un dossier absent
  # serait créé vide par Docker, appartenant à root, hors de tout contrôle.
  mkdir -p "$(dirname "$JOURNAL")"
  dire "docker compose up -d (prod)"
  docker compose --env-file .env.prod -f "$COMPOSE_PROD" up -d
  if [ "$AVEC_DEMO" -eq 1 ]; then
    dire "docker compose up -d (démo, mêmes images)"
    docker compose --env-file .env.demo -f "$COMPOSE_DEMO" up -d
  fi

  # ── 6. LE JOURNAL, puis ce qui tourne vraiment ──
  journaliser "$sha" "$(( $(epoch_s) - t0 ))"
  # ⚠️ Un `up -d` peut rendre la main en exit 0 SANS avoir recréé les conteneurs (mesuré le
  # 2026-09-07). L'âge affiché ici est la seule preuve : « Up 4 weeks » après un déploiement
  # veut dire que rien n'a été remplacé.
  dire "état des conteneurs :"
  docker ps --format '  {{.Names}} — {{.Status}}' | grep -E 'tracky-(api|web|demo-api|demo-web)' || true
  dire "Déploiement terminé. Vérifier l'artefact compilé, pas seulement docker ps."
}

# Exécuté : on déploie. Sourcé (deploy.test.sh) : on expose les fonctions, rien de plus.
if [ -z "${DEPLOY_SH_SOURCE:-}" ]; then
  main "$@"
fi
