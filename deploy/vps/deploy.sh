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
#     bash /opt/vizyo-tracky/deploy/vps/deploy.sh --marketing-seul # ne recrée que le site public
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
#
# ── INCIDENT DU 2026-09-17 : UNE MIGRATION RATÉE A COUPÉ L'API 56 MINUTES, LES VÉHICULES
#    N'ONT PAS DÉMARRÉ ──────────────────────────────────────────────────────────────────────
#
# À 04:56 UTC, le conteneur neuf a joué `prisma migrate deploy` AU DÉMARRAGE ; la migration a
# échoué (une instruction en double dans le fichier), Prisma l'a marquée « échouée », et l'API
# a refusé de démarrer en boucle (P3009) jusqu'au repli manuel à 05:52. Or c'est l'API, et elle
# seule, qui envoie les REPRISES du coupe-circuit à l'ouverture des plages horaires du matin :
# 28 véhicules sont restés coupés. Et ce script avait rendu la main sur « Déploiement terminé »
# avec l'API en `health: starting` — il ne regardait pas si elle devenait saine.
#
# Trois sécurités depuis :
#   1. LA MIGRATION AVANT LA RECRÉATION (`migrer_avant`) : jouée dans un conteneur éphémère de
#      l'image neuve pendant que l'API en place tourne. Si elle échoue, rien n'est recréé, et la
#      migration est aussitôt marquée « annulée » (`migrate resolve --rolled-back`) pour que
#      l'API en place puisse redémarrer si besoin. Au démarrage du conteneur neuf, la migration
#      est déjà appliquée : `migrate deploy` n'a plus rien à faire.
#   2. L'ATTENTE DE SANTÉ (`attendre_sante`) : après `up -d`, on attend `healthy` (150 s au
#      plus). Un redémarrage, un arrêt ou un délai dépassé = REPLI AUTOMATIQUE vers le repère
#      posé au départ, et sortie en erreur. Le script ne dit plus « terminé » sans l'avoir vu.
#   3. LA FENÊTRE DU MATIN (`fenetre_du_matin`) : pas de déploiement entre 05:30 et 09:00
#      (Europe/Paris), quand les reprises dépendent de l'API — sauf `--force`, et jamais pour
#      un `--repli`, qui lui rétablit le service.
set -euo pipefail

RACINE="${RACINE:-/opt/vizyo-tracky}"
# Hors de l'arbre git (y écrire ferait échouer le prochain `git pull`), monté `:ro` dans l'API.
JOURNAL="${JOURNAL_DEPLOIEMENTS:-/opt/tracky-deploiements/journal.jsonl}"
COMPOSE_PROD="docker-compose.prod.yml"
COMPOSE_LP="docker-compose.lp.yml"
COMPOSE_DEMO="docker-compose.demo.yml"
IMAGES_COMPLETES="tracky-api tracky-web tracky-lp"
IMAGES="$IMAGES_COMPLETES"
FORCE=0
ATTENDRE=0
AVEC_DEMO=0
MARKETING_SEUL=0
BRANCHE=main
REPLI=""

# Un passage dure 54 min au plus : au-delà de 65 min d'attente, quelque chose d'autre cloche.
ATTENTE_MAX_S=$((65 * 60))
# Minutes (incluse, exclue) pendant lesquelles on ne recrée PAS l'API : le passage va partir.
FENETRE_DEBUT=42
FENETRE_FIN=46
# Repères de repli conservés par image, le nouveau compris.
REPLIS_A_GARDER=3
# Santé après recréation : start-period 60 s + 3 sondes de 30 s (Dockerfile.api), avec marge.
SANTE_MAX_S=150
SANTE_PAS_S=5
# Fenêtre du matin (Europe/Paris, HHMM) : les reprises du coupe-circuit dépendent de l'API.
MATIN_DEBUT=0530
MATIN_FIN=0900
# Le repère posé par CE passage — c'est vers lui que le repli automatique revient.
ETIQUETTE_POSEE=""

dire() { echo "[$(date -u +%H:%M:%S) UTC] $*"; }

# ── l'horloge et les commandes, isolées pour les tests (deploy.test.sh les remplace) ───────
minute_utc()   { local m; m="$(date -u +%M)"; echo "${m#0}"; }
seconde_utc()  { local s; s="$(date -u +%S)"; echo "${s#0}"; }
epoch_s()      { date -u +%s; }
horodatage_etiquette() { date -u +%Y%m%d-%H%M; }
maintenant_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
heure_paris_hhmm() { TZ=Europe/Paris date +%H%M; }
journal_conteneur() { timeout 15 docker logs --tail 20 "$1" 2>&1 || true; }

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
      --marketing-seul) MARKETING_SEUL=1 ;;
      --branche) attend_valeur=branche ;;
      --repli) attend_valeur=repli ;;
      *) echo "Option inconnue : $arg" >&2; return 2 ;;
    esac
  done
  if [ -n "$attend_valeur" ]; then echo "Option --$attend_valeur sans valeur" >&2; return 2; fi
  if [ "$MARKETING_SEUL" -eq 1 ] && [ "$AVEC_DEMO" -eq 1 ]; then
    echo "Options incompatibles : --marketing-seul ne met pas à jour la démo." >&2
    return 2
  fi
  if [ "$MARKETING_SEUL" -eq 1 ]; then IMAGES="tracky-lp"; else IMAGES="$IMAGES_COMPLETES"; fi
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

# ── LA FENÊTRE DU MATIN — les reprises du coupe-circuit dépendent de l'API ─────────────────
#
# Le 17/09, une API morte de 06:56 à 07:52 (Paris) a laissé 28 véhicules coupés au moment où
# leurs conducteurs partaient. Un déploiement ne se lance pas à cette heure-là : s'il tourne
# mal, il n'y a personne pour rallumer. `--force` passe outre en le disant ; un `--repli`, qui
# RÉTABLIT le service, n'est jamais retenu.
fenetre_du_matin() {
  local h; h="$(heure_paris_hhmm)"; h="${h#0}"; h="${h#0}"
  local d="${MATIN_DEBUT#0}"; d="${d#0}"
  local f="${MATIN_FIN#0}"; f="${f#0}"
  [ "${h:-0}" -ge "${d:-0}" ] && [ "${h:-0}" -lt "${f:-0}" ]
}

garde_matin() {
  local moment="$1"
  [ -n "$REPLI" ] && return 0
  if fenetre_du_matin; then
    local h; h="$(heure_paris_hhmm)"
    if [ "$FORCE" -eq 1 ]; then
      dire "⚠️  Il est ${h:0:2}:${h:2:2} à Paris — fenêtre du matin (${MATIN_DEBUT:0:2}:${MATIN_DEBUT:2:2}–${MATIN_FIN:0:2}:${MATIN_FIN:2:2}) : les reprises du coupe-circuit dépendent de l'API. --force : on continue quand même."
      return 0
    fi
    dire "⛔ Déploiement REFUSÉ ($moment) : il est ${h:0:2}:${h:2:2} à Paris, dans la fenêtre du matin (${MATIN_DEBUT:0:2}:${MATIN_DEBUT:2:2}–${MATIN_FIN:0:2}:${MATIN_FIN:2:2})."
    dire "   Les reprises du coupe-circuit sont envoyées par l'API à l'ouverture des plages : une API qui tombe maintenant"
    dire "   laisse les véhicules coupés (incident du 17/09). Relancer après ${MATIN_FIN:0:2}:${MATIN_FIN:2:2}, ou --force en le sachant."
    exit 1
  fi
  return 0
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
  ETIQUETTE_POSEE="$etiquette"
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

# ── LA MIGRATION AVANT LA RECRÉATION ───────────────────────────────────────────────────────
#
# Jouée dans un conteneur éphémère de l'image NEUVE (celle que `build` vient de produire),
# pendant que l'API en place continue de servir. Elle échoue ? Rien n'est recréé — et la
# migration est aussitôt marquée « annulée » pour que l'API en place puisse redémarrer si
# besoin (une migration « échouée » non résolue bloque TOUT démarrage, P3009 : c'est ce qui
# a tenu l'API à terre 56 min le 17/09). Sur PostgreSQL, Prisma joue chaque migration dans
# une transaction : « annulée » est exact, rien n'est resté à moitié appliqué.
migrer_avant() {
  cd "$RACINE/deploy/vps"
  dire "prisma migrate deploy — image neuve, conteneur éphémère ; l'API en place n'est pas touchée"
  local sortie
  if sortie="$(docker compose --env-file .env.prod -f "$COMPOSE_PROD" run --rm --no-deps --entrypoint sh api -c "pnpm prisma migrate deploy" 2>&1)"; then
    echo "$sortie" | grep -E "migration|applied|No pending|Database schema is up to date" | tail -n 4 | sed 's/^/   /' || true
    return 0
  fi
  echo "$sortie" | tail -n 25 | sed 's/^/   /'
  local nom; nom="$(echo "$sortie" | grep -oE "The \`[^\`]+\` migration" | head -n 1 | sed 's/The `//; s/` migration//')"
  dire "⛔ MIGRATION EN ÉCHEC — l'API en place n'a PAS été touchée, rien n'est recréé."
  if [ -n "$nom" ]; then
    dire "   migration : $nom — on la marque « annulée » pour ne pas bloquer un redémarrage de l'API en place"
    if docker compose --env-file .env.prod -f "$COMPOSE_PROD" run --rm --no-deps --entrypoint sh api -c "pnpm prisma migrate resolve --rolled-back $nom" >/dev/null 2>&1; then
      dire "   marquée annulée. Corriger le fichier, rejouer les migrations sur une copie du schéma (pnpm verif:migrations), puis redéployer."
    else
      dire "   ⚠️ impossible de la marquer annulée : à faire à la main AVANT tout redémarrage de l'API :"
      dire "      docker compose --env-file .env.prod -f $COMPOSE_PROD run --rm --no-deps --entrypoint sh api -c \"pnpm prisma migrate resolve --rolled-back $nom\""
    fi
  fi
  exit 3
}

# ── L'ATTENTE DE SANTÉ — le script ne dit plus « terminé » sans l'avoir vu ──────────────────
#
#   Attend un conteneur doté d'une sonde. Rend 0 quand il est `healthy` ; 1 sinon
#   (redémarrage, arrêt ou délai dépassé), après les dernières lignes de son journal.
attendre_sante_conteneur() {
  local conteneur="$1" quoi="$2"
  local t0; t0="$(epoch_s)"
  dire "attente de santé de $conteneur ($quoi, ${SANTE_MAX_S} s au plus)…"
  while :; do
    local etat; etat="$(docker inspect -f '{{.State.Status}} {{.State.Health.Status}} {{.RestartCount}}' "$conteneur" 2>/dev/null || echo 'absent ? 0')"
    local statut sante redemarrages
    statut="$(echo "$etat" | cut -d' ' -f1)"; sante="$(echo "$etat" | cut -d' ' -f2)"; redemarrages="$(echo "$etat" | cut -d' ' -f3)"
    if [ "$sante" = "healthy" ] && [ "${redemarrages:-0}" -eq 0 ]; then
      dire "✅ $conteneur est sain ($(( $(epoch_s) - t0 )) s, 0 redémarrage)."
      return 0
    fi
    local raison=""
    if [ "${redemarrages:-0}" -gt 0 ]; then raison="redémarrée $redemarrages fois"
    elif [ "$statut" != "running" ]; then raison="état « $statut »"
    elif [ "$sante" = "unhealthy" ]; then raison="sonde en échec (unhealthy)"
    elif [ $(( $(epoch_s) - t0 )) -ge "$SANTE_MAX_S" ]; then raison="toujours « $sante » après ${SANTE_MAX_S} s"
    fi
    if [ -n "$raison" ]; then
      dire "⛔ $conteneur N'EST PAS SAIN : $raison. Dernières lignes du conteneur :"
      journal_conteneur "$conteneur" | sed 's/^/   /'
      return 1
    fi
    sleep "$SANTE_PAS_S"
  done
}

attendre_sante() {
  local quoi="$1"
  if [ "$MARKETING_SEUL" -eq 1 ]; then
    attendre_sante_conteneur tracky-lp "$quoi"
  else
    attendre_sante_conteneur tracky-api "$quoi" &&
      attendre_sante_conteneur tracky-lp "$quoi"
  fi
}

recreer_perimetre() {
  cd "$RACINE/deploy/vps"
  if [ "$MARKETING_SEUL" -eq 1 ]; then
    dire "docker compose up -d (site marketing uniquement)"
    docker compose --env-file .env.prod -f "$COMPOSE_LP" up -d
  else
    dire "docker compose up -d (prod)"
    docker compose --env-file .env.prod -f "$COMPOSE_PROD" up -d
    dire "docker compose up -d (site marketing)"
    docker compose --env-file .env.prod -f "$COMPOSE_LP" up -d
  fi
}

# Le repli automatique : le repère posé par ce passage redevient `latest`, on recrée, on attend.
repli_automatique() {
  if [ -z "$ETIQUETTE_POSEE" ]; then
    dire "⛔ Pas de repère posé par ce passage : pas de repli automatique possible. Repères disponibles :"
    docker images tracky-api --format '   {{.Repository}}:{{.Tag}}  ({{.CreatedSince}})' | grep 'avant-' || dire "   (aucun)"
    return 1
  fi
  local image
  for image in $IMAGES; do
    if ! docker image inspect "$image:$ETIQUETTE_POSEE" >/dev/null 2>&1; then
      dire "⛔ Repère $image:$ETIQUETTE_POSEE introuvable : pas de repli automatique possible."
      return 1
    fi
  done
  dire "↩️  REPLI AUTOMATIQUE vers $ETIQUETTE_POSEE"
  for image in $IMAGES; do
    docker tag "$image:$ETIQUETTE_POSEE" "$image:latest"
    dire "   $image:$ETIQUETTE_POSEE → $image:latest"
  done
  cd "$RACINE/deploy/vps"
  recreer_perimetre
  attendre_sante "après repli automatique"
}

# ── LE JOURNAL — ce qui rend un contournement visible ────────────────────────────────────────
journaliser() {
  local sha="$1" duree="$2" sante="${3:-healthy}"
  local id_api id_web id_lp
  id_api="$(docker inspect --format '{{.Id}}' tracky-api 2>/dev/null || echo '')"
  id_web="$(docker inspect --format '{{.Id}}' tracky-web 2>/dev/null || echo '')"
  id_lp="$(docker inspect --format '{{.Id}}' tracky-lp 2>/dev/null || echo '')"
  # Qui a déployé, et d'où : `SSH_CLIENT` n'existe pas hors SSH (console, test) — sans valeur
  # par défaut, `set -u` ferait échouer le journal après un déploiement réussi.
  local client="${SSH_CLIENT:-}"
  local par="${SUDO_USER:-${USER:-?}}@${client%% *}"
  local force=false attente=false repli=null perimetre=production
  [ "$FORCE" -eq 1 ] && force=true
  [ "$ATTENDRE" -eq 1 ] && attente=true
  [ -n "$REPLI" ] && repli="\"$REPLI\""
  [ "$MARKETING_SEUL" -eq 1 ] && perimetre=marketing
  mkdir -p "$(dirname "$JOURNAL")"
  printf '{"at":"%s","sha":"%s","branche":"%s","perimetre":"%s","apiContainerId":"%s","webContainerId":"%s","lpContainerId":"%s","force":%s,"attente":%s,"repli":%s,"par":"%s","dureeS":%s,"sante":"%s"}\n' \
    "$(maintenant_iso)" "$sha" "$BRANCHE" "$perimetre" "$id_api" "$id_web" "$id_lp" "$force" "$attente" "$repli" "$par" "$duree" "$sante" >> "$JOURNAL"
  dire "   journal : $JOURNAL"
}

main() {
  lire_options "$@" || exit $?
  local t0; t0="$(epoch_s)"

  # ── 0. la fenêtre du matin : pas de déploiement quand les reprises dépendent de l'API ──
  if [ "$MARKETING_SEUL" -eq 0 ]; then garde_matin depart; fi
  # ── 1. la garde, une première fois : inutile de tirer et de construire pour rien ──
  if [ "$MARKETING_SEUL" -eq 0 ]; then garde depart; fi

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
    if [ "$MARKETING_SEUL" -eq 1 ]; then
      dire "docker compose build (site marketing uniquement)"
      docker compose --env-file .env.prod -f "$COMPOSE_LP" build
    else
      dire "docker compose build (prod)"
      docker compose --env-file .env.prod -f "$COMPOSE_PROD" build
      dire "docker compose build (site marketing)"
      docker compose --env-file .env.prod -f "$COMPOSE_LP" build
    fi

    # ── 3 bis. LA MIGRATION, AVANT DE TOUCHER À L'API (incident du 17/09) ──
    if [ "$MARKETING_SEUL" -eq 0 ]; then migrer_avant; fi
  fi

  # ── 4. LA GARDE, À NOUVEAU — c'est maintenant que ça tue (TRK-077) ──
  cd "$RACINE/deploy/vps"
  if [ "$MARKETING_SEUL" -eq 0 ]; then
    garde_matin recreation
    garde recreation
  fi

  # ── 5. RECRÉER — court : les images sont prêtes ──
  # Le dossier du journal AVANT le `up` : le compose le monte dans l'API, et un dossier absent
  # serait créé vide par Docker, appartenant à root, hors de tout contrôle.
  mkdir -p "$(dirname "$JOURNAL")"
  recreer_perimetre
  if [ "$AVEC_DEMO" -eq 1 ]; then
    dire "docker compose up -d (démo, mêmes images)"
    docker compose --env-file .env.demo -f "$COMPOSE_DEMO" up -d
  fi

  # ── 6. LA SANTÉ — et le repli automatique si elle ne vient pas (incident du 17/09) ──
  local sante=healthy
  if ! attendre_sante "après recréation"; then
    if [ -n "$REPLI" ]; then
      journaliser "$sha" "$(( $(epoch_s) - t0 ))" "malade-apres-repli"
      dire "⛔ Le repli lui-même ne rend pas le périmètre sain. Rien d'automatique au-delà : regarder le journal du conteneur ci-dessus."
      exit 5
    fi
    if repli_automatique; then
      journaliser "$sha" "$(( $(epoch_s) - t0 ))" "repli-auto"
      dire "⛔ DÉPLOIEMENT ANNULÉ : l'API neuve n'était pas saine, l'image d'avant ($ETIQUETTE_POSEE) est de retour et saine."
      dire "   Le code déployé reste sur $BRANCHE : corriger, puis redéployer."
    else
      journaliser "$sha" "$(( $(epoch_s) - t0 ))" "malade-sans-repli"
      dire "⛔ DÉPLOIEMENT EN ÉCHEC et repli automatique impossible : intervenir à la main (--repli <repère>)."
    fi
    exit 4
  fi

  # ── 7. LE JOURNAL, puis ce qui tourne vraiment ──
  journaliser "$sha" "$(( $(epoch_s) - t0 ))" "$sante"
  # ⚠️ Un `up -d` peut rendre la main en exit 0 SANS avoir recréé les conteneurs (mesuré le
  # 2026-09-07). L'âge affiché ici est la seule preuve : « Up 4 weeks » après un déploiement
  # veut dire que rien n'a été remplacé.
  dire "état des conteneurs :"
  docker ps --format '  {{.Names}} — {{.Status}}' | grep -E 'tracky-(api|web|lp|demo-api|demo-web)' || true
  if [ "$MARKETING_SEUL" -eq 1 ]; then
    dire "Déploiement terminé : site marketing sain ; API et Web applicatif non recréés. Vérifier les URLs publiques, pas seulement docker ps."
  else
    dire "Déploiement terminé : API et site marketing sains. Vérifier les artefacts servis, pas seulement docker ps."
  fi
}

# Exécuté : on déploie. Sourcé (deploy.test.sh) : on expose les fonctions, rien de plus.
if [ -z "${DEPLOY_SH_SOURCE:-}" ]; then
  main "$@"
fi
