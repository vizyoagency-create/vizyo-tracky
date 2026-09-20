#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════════════════
# TESTS DE `deploy.sh` — la garde, les deux fois où elle doit lire, et le journal
# ═══════════════════════════════════════════════════════════════════════════════════════════
#
#     bash deploy/vps/deploy.test.sh          # ou : pnpm verif:deploiement
#
# Le script est SOURCÉ (il ne lance `main` que quand il est exécuté), et tout ce qui touche
# la machine est remplacé par un double : `docker`, `git`, `sleep`, l'horloge. Chaque cas
# fixe l'heure et l'état de l'automatisation, puis lit ce que le script décide.
#
# TRK-077 (2026-09-09) : la garde était lue UNE fois, au départ, puis `git pull` et une
# construction de plusieurs minutes précédaient la recréation du conteneur — la seule chose
# qui tue un passage. Un déploiement lancé à HH:43 franchissait la garde à juste titre et
# tuait le passage de HH:45. Ces tests fixent la chronologie qui a manqué.
#
# Incident du 2026-09-17 : une migration ratée au démarrage du conteneur neuf a tenu l'API à
# terre 56 min (P3009 en boucle), et le script avait dit « terminé » sans regarder. Les cas
# « la migration avant la recréation », « l'attente de santé et le repli automatique » et « la
# fenêtre du matin » fixent ce qui a manqué ce jour-là.
#
# 2026-09-20 (audit VPS, VPS-044 et VPS-046) : le repère de repli était posé sur `latest` — qui
# n'est pas toujours ce qui tourne — et la démo ne suivait que sur option, donc jamais. Les cas
# « les repères pointent ce qui TOURNE » et « la démo suit la production » fixent les deux.
set -u
cd "$(dirname "$0")"

# ── le harnais ──────────────────────────────────────────────────────────────────────────────
ECHECS=0; TOTAL=0
ok()    { TOTAL=$((TOTAL + 1)); echo "  ✓ $1"; }
ko()    { TOTAL=$((TOTAL + 1)); ECHECS=$((ECHECS + 1)); echo "  ✗ $1"; [ -n "${2:-}" ] && echo "      $2"; }
attend() { # attend <libellé> <attendu> <obtenu>
  if [ "$2" = "$3" ]; then ok "$1"; else ko "$1" "attendu « $2 », obtenu « $3 »"; fi
}
contient() { # contient <libellé> <aiguille> <botte>
  if [[ "$3" == *"$2"* ]]; then ok "$1"; else ko "$1" "« $2 » absent de : $3"; fi
}
absent() { # absent <libellé> <aiguille> <botte>
  if [[ "$3" != *"$2"* ]]; then ok "$1"; else ko "$1" "« $2 » présent dans : $3"; fi
}

# ── charger le script sans l'exécuter ───────────────────────────────────────────────────────
DEPLOY_SH_SOURCE=1
# shellcheck source=deploy.sh
. ./deploy.sh
set +e   # le script arme `set -e` ; ici on veut lire les codes de retour, pas mourir dessus

# ── les doubles — définis APRÈS le chargement, sinon le script les redéfinirait ─────────────
#
# La garde lit psql dans un `$(...)` — un sous-shell — et les cas jouent `garde` ou `main`
# eux-mêmes dans un sous-shell pour lire leur code de sortie : tout ce qui doit survivre
# passe donc par des FICHIERS (la trace des appels, le compteur de réponses psql).
declare -a REPONSES_PSQL=()   # une réponse par appel, dans l'ordre
COMPTEUR_PSQL="$(mktemp)"
TRACE="$(mktemp)"
FAUSSE_MINUTE=30
FAUSSE_SECONDE=0
FAUSSE_EPOCH=1000
ETIQUETTES_EXISTANTES=""      # ce que `docker images` rend pour les repères de repli
FAUSSE_HEURE_PARIS=1200       # HHMM à Paris — 12:00 : hors de la fenêtre du matin
CODE_MIGRATION=0              # ce que rend `prisma migrate deploy` dans le conteneur éphémère
declare -a REPONSES_SANTE=()  # une réponse `docker inspect` par lecture : « status health restarts »
COMPTEUR_SANTE="$(mktemp)"
declare -a REPONSES_SANTE_LP=()
COMPTEUR_SANTE_LP="$(mktemp)"
declare -a REPONSES_SANTE_DEMO=()
COMPTEUR_SANTE_DEMO="$(mktemp)"
# L'image de chaque conteneur EN SERVICE (V32 b) — vide = pas de conteneur ; et l'ID de :latest.
IMG_API="sha256:cc1fec4a6ebb0000000000000000000000000000000000000000000000000000"
IMG_WEB="sha256:c8d99972e2eb0000000000000000000000000000000000000000000000000000"
IMG_LP="sha256:744ac977a0390000000000000000000000000000000000000000000000000000"
IMAGE_EN_SERVICE_API="$IMG_API"; IMAGE_EN_SERVICE_WEB="$IMG_WEB"; IMAGE_EN_SERVICE_LP="$IMG_LP"
LATEST_ID_API="$IMG_API"; LATEST_ID_WEB="$IMG_WEB"; LATEST_ID_LP="$IMG_LP"
CODE_UP_DEMO=0

noter() { echo "$1" >> "$TRACE"; }
trace() { paste -sd'|' "$TRACE"; }

docker() {
  case "$*" in
    "exec tracky-postgres psql"*)
      local n; n="$(cat "$COMPTEUR_PSQL" 2>/dev/null || echo 0)"
      local r="${REPONSES_PSQL[$n]:-}"
      echo $((n + 1)) > "$COMPTEUR_PSQL"
      noter "psql"
      [ -n "$r" ] && echo "$r"
      ;;
    "compose --env-file .env.prod -f docker-compose.prod.yml build")   noter "build" ;;
    "compose --env-file .env.prod -f docker-compose.prod.yml up -d")   noter "up" ;;
    "compose --env-file .env.prod -f docker-compose.lp.yml build")     noter "build-lp" ;;
    "compose --env-file .env.prod -f docker-compose.lp.yml up -d")     noter "up-lp" ;;
    "compose --env-file .env.prod -f docker-compose.prod.yml run --rm --no-deps --entrypoint sh api -c pnpm prisma migrate deploy")
      noter "migrate"
      if [ "$CODE_MIGRATION" -ne 0 ]; then
        echo "Error: P3009"
        echo "The \`20260917090000_rdv_lot_a\` migration started at 2026-09-17 04:56:35 UTC failed"
        return "$CODE_MIGRATION"
      fi
      echo "1 migration found in prisma/migrations"; echo "Applying migration \`20260917090000_rdv_lot_a\`"
      ;;
    "compose --env-file .env.prod -f docker-compose.prod.yml run --rm --no-deps --entrypoint sh api -c pnpm prisma migrate resolve --rolled-back "*)
      local tout="$*"; noter "resolve ${tout##* }" ;;
    "inspect -f {{.State.Status}} {{.State.Health.Status}} {{.RestartCount}} tracky-api")
      local n; n="$(cat "$COMPTEUR_SANTE" 2>/dev/null || echo 0)"
      local r="${REPONSES_SANTE[$n]:-running healthy 0}"
      echo $((n + 1)) > "$COMPTEUR_SANTE"
      echo "$r"
      ;;
    "inspect -f {{.State.Status}} {{.State.Health.Status}} {{.RestartCount}} tracky-lp")
      local n; n="$(cat "$COMPTEUR_SANTE_LP" 2>/dev/null || echo 0)"
      local r="${REPONSES_SANTE_LP[$n]:-running healthy 0}"
      echo $((n + 1)) > "$COMPTEUR_SANTE_LP"
      echo "$r"
      ;;
    "compose --env-file .env.demo -f docker-compose.demo.yml up -d")   noter "up-demo"; return "$CODE_UP_DEMO" ;;
    "inspect -f {{.State.Status}} {{.State.Health.Status}} {{.RestartCount}} tracky-demo-api")
      local n; n="$(cat "$COMPTEUR_SANTE_DEMO" 2>/dev/null || echo 0)"
      local r="${REPONSES_SANTE_DEMO[$n]:-running healthy 0}"
      echo $((n + 1)) > "$COMPTEUR_SANTE_DEMO"
      echo "$r"
      ;;
    "inspect --format {{.Id}} tracky-api") echo "d144f11ee90f4169978e5e8b2ad133722c5ddbaf44a863ab302aac2cc2eace17" ;;
    "inspect --format {{.Id}} tracky-web") echo "66dc3d93049a0000000000000000000000000000000000000000000000000000" ;;
    "inspect --format {{.Id}} tracky-lp") echo "77ec3d93049a0000000000000000000000000000000000000000000000000000" ;;
    # V32 b : l'image du conteneur en service — vide + code 1 = pas de conteneur
    "inspect --format {{.Image}} tracky-api") [ -n "$IMAGE_EN_SERVICE_API" ] && echo "$IMAGE_EN_SERVICE_API" || return 1 ;;
    "inspect --format {{.Image}} tracky-web") [ -n "$IMAGE_EN_SERVICE_WEB" ] && echo "$IMAGE_EN_SERVICE_WEB" || return 1 ;;
    "inspect --format {{.Image}} tracky-lp")  [ -n "$IMAGE_EN_SERVICE_LP" ]  && echo "$IMAGE_EN_SERVICE_LP"  || return 1 ;;
    "image inspect --format {{.Id}} tracky-api:latest") echo "$LATEST_ID_API" ;;
    "image inspect --format {{.Id}} tracky-web:latest") echo "$LATEST_ID_WEB" ;;
    "image inspect --format {{.Id}} tracky-lp:latest")  echo "$LATEST_ID_LP" ;;
    "image inspect "*) return 0 ;;
    "images "*"--format {{.Tag}}") echo "$ETIQUETTES_EXISTANTES" | tr ' ' '\n' | sed '/^$/d' ;;
    "images "*) echo "   tracky-api:avant-x  (2 days ago)" ;;
    "tag "*) noter "tag $2 $3" ;;
    "rmi "*) noter "rmi $2" ;;
    "ps "*) echo "  tracky-api — Up 1 second" ;;
    *) noter "docker? $*" ;;
  esac
}
git() {
  case "$*" in
    *"rev-parse --short HEAD") echo "a8f9575e" ;;
    *"log --oneline -1") echo "a8f9575e un commit" ;;
    "-C "*) shift 2; noter "git $*" ;;
    *) noter "git $*" ;;
  esac
}
sleep() { noter "sleep $1"; FAUSSE_EPOCH=$((FAUSSE_EPOCH + ${1%.*})); }
minute_utc()   { echo "$FAUSSE_MINUTE"; }
seconde_utc()  { echo "$FAUSSE_SECONDE"; }
epoch_s()      { echo "$FAUSSE_EPOCH"; }
horodatage_etiquette() { echo "20260913-1130"; }
maintenant_iso() { echo "2026-09-13T11:30:53Z"; }
heure_paris_hhmm() { echo "$FAUSSE_HEURE_PARIS"; }
journal_conteneur() { noter "logs"; echo "Error: P3009 (journal du conteneur, doublé)"; }

reinitialiser() {
  REPONSES_PSQL=(); echo 0 > "$COMPTEUR_PSQL"; : > "$TRACE"
  REPONSES_SANTE=(); echo 0 > "$COMPTEUR_SANTE"
  REPONSES_SANTE_LP=(); echo 0 > "$COMPTEUR_SANTE_LP"
  REPONSES_SANTE_DEMO=(); echo 0 > "$COMPTEUR_SANTE_DEMO"
  FAUSSE_MINUTE=30; FAUSSE_SECONDE=0; FAUSSE_EPOCH=1000; ETIQUETTES_EXISTANTES=""
  FAUSSE_HEURE_PARIS=1200; CODE_MIGRATION=0; ETIQUETTE_POSEE=""
  FORCE=0; ATTENDRE=0; AVEC_DEMO=1; MARKETING_SEUL=0; BRANCHE=main; REPLI=""; DEMO_ETAT="non"
  IMAGE_EN_SERVICE_API="$IMG_API"; IMAGE_EN_SERVICE_WEB="$IMG_WEB"; IMAGE_EN_SERVICE_LP="$IMG_LP"
  LATEST_ID_API="$IMG_API"; LATEST_ID_WEB="$IMG_WEB"; LATEST_ID_LP="$IMG_LP"; CODE_UP_DEMO=0
  IMAGES="$IMAGES_COMPLETES"
  JOURNAL="$(mktemp)"; RACINE="$(mktemp -d)"; mkdir -p "$RACINE/deploy/vps"
  # la démo existe sur la machine de test (compose + .env) — un cas les retire pour lire « absente »
  : > "$RACINE/deploy/vps/docker-compose.demo.yml"; : > "$RACINE/deploy/vps/.env.demo"
}
# Les repères attendus : posés sur l'IMAGE EN SERVICE (V32 b), pas sur latest.
REPERE_API="tag $IMG_API tracky-api:avant-20260913-1130-a8f9575e"
REPERE_WEB="tag $IMG_WEB tracky-web:avant-20260913-1130-a8f9575e"
REPERE_LP="tag $IMG_LP tracky-lp:avant-20260913-1130-a8f9575e"

echo "deploy.sh — la garde"

reinitialiser
sortie="$( (garde depart) 2>&1 )"; code=$?
attend "sans passage, hors fenêtre : la garde laisse passer (code 0)" 0 "$code"
attend "…une seule lecture, aucun sommeil" "psql" "$(trace)"

reinitialiser; REPONSES_PSQL=("11:45:00|scheduled|3")
sortie="$( (garde depart) 2>&1 )"; code=$?
attend "passage en cours, sans option : REFUS (code 1)" 1 "$code"
contient "…le message dit REFUSÉ" "REFUSÉ" "$sortie"
contient "…et propose les deux issues" "--attendre" "$sortie"

reinitialiser; REPONSES_PSQL=("11:45:00|scheduled|3"); FORCE=1
sortie="$( (garde recreation) 2>&1 )"; code=$?
attend "passage en cours + --force : on passe (code 0)" 0 "$code"
contient "…en le disant" "--force" "$sortie"

reinitialiser; REPONSES_PSQL=("11:45:00|scheduled|3" "11:45:00|scheduled|3" ""); ATTENDRE=1
sortie="$( (garde recreation) 2>&1 )"; code=$?
attend "passage en cours + --attendre : on patiente puis on passe (code 0)" 0 "$code"
attend "…un tour de boucle = 30 s de sommeil, jusqu'à ce que psql ne rende plus rien" "psql|sleep 30|psql|sleep 30|psql" "$(trace)"

reinitialiser; ATTENDRE=1
# Borne réelle : 65 min. Ici 3 min (six tours), sinon le test dure une minute sous Git Bash.
ATTENTE_MAX_S=180
for i in $(seq 1 10); do REPONSES_PSQL+=("11:45:00|scheduled|3"); done
sortie="$( (garde recreation) 2>&1 )"; code=$?
attend "⚠️ --attendre est BORNÉ : au-delà de la borne, refus (code 1)" 1 "$code"
contient "…et le dit, en minutes, depuis la variable" "3 min" "$sortie"
attend "…après exactement six sommeils de 30 s" "psql|sleep 30|psql|sleep 30|psql|sleep 30|psql|sleep 30|psql|sleep 30|psql|sleep 30|psql" "$(trace)"
ATTENTE_MAX_S=$((65 * 60))

echo "deploy.sh — la fenêtre d'amorçage du passage (HH:42 → HH:46)"

reinitialiser; FAUSSE_MINUTE=43
sortie="$( (garde recreation) 2>&1 )"; code=$?
attend "⚠️ HH:43, aucun passage ENCORE : refus quand même (code 1) — il va partir" 1 "$code"
contient "…le message explique le tic de :45" ":45" "$sortie"

reinitialiser; FAUSSE_MINUTE=41
code=$( (garde recreation) >/dev/null 2>&1; echo $? )
attend "HH:41 : encore hors fenêtre, on passe" 0 "$code"

reinitialiser; FAUSSE_MINUTE=46
code=$( (garde recreation) >/dev/null 2>&1; echo $? )
attend "HH:46 sans passage : on passe (l'automatisation ne tourne pas)" 0 "$code"

reinitialiser; FAUSSE_MINUTE=43; FAUSSE_SECONDE=20; ATTENDRE=1
# après le sommeil, on est à :46 et psql ne rend rien
minute_utc() { if grep -q sleep "$TRACE"; then echo 46; else echo 43; fi; }
sortie="$( (garde recreation) 2>&1 )"; code=$?
attend "HH:43:20 + --attendre : on dort jusqu'à :46 puis on relit (code 0)" 0 "$code"
attend "…le sommeil est calculé à la seconde : (46 − 43) × 60 − 20 = 160 s" "psql|sleep 160|psql" "$(trace)"
minute_utc() { echo "$FAUSSE_MINUTE"; }

reinitialiser; FAUSSE_MINUTE=44; FORCE=1
code=$( (garde recreation) >/dev/null 2>&1; echo $? )
attend "HH:44 + --force : on passe, en le disant" 0 "$code"

echo "deploy.sh — les repères de repli"

reinitialiser
sortie="$( (etiqueter_repli) 2>&1 )"
contient "l'IMAGE EN SERVICE de l'API reçoit une étiquette avant-<date>-<sha> (V32 b : pas latest)" "$REPERE_API" "$(trace)"
contient "…celle du web aussi, la MÊME" "$REPERE_WEB" "$(trace)"
contient "…et celle du site marketing aussi" "$REPERE_LP" "$(trace)"
absent "…jamais « tag tracky-api:latest » : latest n'est plus la source du repère" "tag tracky-api:latest" "$(trace)"
absent "…et rien n'est élagué quand il n'y a rien" "rmi" "$(trace)"
absent "…latest = image en service : aucun avertissement" "≠" "$sortie"
contient "…et le script dit comment revenir en arrière" "--repli avant-20260913-1130-a8f9575e" "$sortie"

echo "deploy.sh — les repères pointent ce qui TOURNE (VPS-044, 2026-09-20)"

reinitialiser; LATEST_ID_API="sha256:82d57a7d4cb70000000000000000000000000000000000000000000000000000"
sortie="$( (etiqueter_repli) 2>&1 )"
contient "🔴 latest ≠ image en service (image PRÉ-CONSTRUITE, cas du 15/09) : le repère pointe l'image du CONTENEUR" "$REPERE_API" "$(trace)"
absent "…et surtout pas la pré-construite" "tag sha256:82d57a7d4cb7" "$(trace)"
absent "…ni latest" "tag tracky-api:latest" "$(trace)"
contient "…et le script le DIT, avec les deux identifiants" "82d57a7d4cb7" "$sortie"
contient "…en nommant la règle" "V32 b" "$sortie"

reinitialiser; IMAGE_EN_SERVICE_API=""
sortie="$( (etiqueter_repli) 2>&1 )"
contient "pas de conteneur tracky-api (premier déploiement, pile arrêtée) : latest est le seul repère possible" "tag tracky-api:latest tracky-api:avant-20260913-1130-a8f9575e" "$(trace)"
contient "…et le script dit pourquoi" "pas de conteneur tracky-api en service" "$sortie"
contient "…les autres images gardent la règle" "$REPERE_WEB" "$(trace)"

reinitialiser; IMAGE_EN_SERVICE_LP=""
# ni conteneur tracky-lp, ni image tracky-lp:latest : on enveloppe le double pour ce seul appel
eval "$(declare -f docker | sed '1s/^docker/docker_double/')"
docker() { case "$*" in "image inspect tracky-lp:latest") return 1 ;; *) docker_double "$@" ;; esac; }
sortie="$( (etiqueter_repli) 2>&1 )"
absent "ni conteneur ni latest pour tracky-lp : aucun repère lp posé (rien à étiqueter)" "tracky-lp:avant-" "$(trace)"
contient "…et le script le dit" "ni conteneur tracky-lp ni image tracky-lp:latest" "$sortie"
contient "…les deux autres sont posés" "$REPERE_API" "$(trace)"
eval "$(declare -f docker_double | sed '1s/^docker_double/docker/')"; unset -f docker_double

reinitialiser; ETIQUETTES_EXISTANTES="avant-20260910-0027-3f7b9d2d avant-20260911-1000-aaaa1111 latest avant-20260908-0800-bbbb2222 avant-20260912-2200-cccc3333"
sortie="$( (etiqueter_repli) 2>&1 )"
contient "⚠️ trois repères gardés par image, le nouveau compris : le plus ancien part" "rmi tracky-api:avant-20260908-0800-bbbb2222" "$(trace)"
contient "…et le suivant aussi (quatre anciens + un nouveau, on n'en garde que trois)" "rmi tracky-api:avant-20260910-0027-3f7b9d2d" "$(trace)"
absent "…les deux plus récents restent" "rmi tracky-api:avant-20260911" "$(trace)"
absent "…jamais latest" "rmi tracky-api:latest" "$(trace)"
contient "…le web suit la même règle" "rmi tracky-web:avant-20260908-0800-bbbb2222" "$(trace)"
contient "…le site marketing suit la même règle" "rmi tracky-lp:avant-20260908-0800-bbbb2222" "$(trace)"

echo "deploy.sh — le déroulé complet"

reinitialiser
sortie="$( (main) 2>&1 )"; code=$?
attend "un déploiement ordinaire rend 0" 0 "$code"
attend "⚠️ l'ORDRE : garde, repères, pull, builds prod/marketing, MIGRATION, GARDE À NOUVEAU, up prod/marketing, PUIS la démo" \
  "psql|$REPERE_API|$REPERE_WEB|$REPERE_LP|git checkout -q main|git pull --ff-only origin main|build|build-lp|migrate|psql|up|up-lp|up-demo" "$(trace)"
contient "…et le script ne dit « terminé » qu'avec l'API et le marketing sains" "API et site marketing sains" "$sortie"
contient "…et il dit que la démo est à jour" "démo à jour et saine" "$sortie"
ligne="$(tail -n 1 "$JOURNAL")"
contient "le journal dit que la démo a suivi" '"demo":"saine"' "$ligne"
contient "le journal porte l'identifiant du conteneur API créé" '"apiContainerId":"d144f11ee90f4169978e5e8b2ad133722c5ddbaf44a863ab302aac2cc2eace17"' "$ligne"
contient "…et l'identifiant du conteneur marketing créé" '"lpContainerId":"77ec3d93049a0000000000000000000000000000000000000000000000000000"' "$ligne"
contient "…le sha déployé" '"sha":"a8f9575e"' "$ligne"
contient "…et que rien n'a été forcé" '"force":false' "$ligne"
contient "…et que l'API était saine" '"sante":"healthy"' "$ligne"
if command -v node >/dev/null 2>&1; then
  if node -e "JSON.parse(process.argv[1])" "$ligne" 2>/dev/null; then ok "…et c'est du JSON valide"; else ko "…et c'est du JSON valide" "$ligne"; fi
fi

reinitialiser
sortie="$( (main --marketing-seul) 2>&1 )"; code=$?
attend "--marketing-seul rend 0" 0 "$code"
attend "…ne touche qu'à l'image et à la pile marketing, sans garde API ni migration ni démo" \
  "$REPERE_LP|git checkout -q main|git pull --ff-only origin main|build-lp|up-lp" "$(trace)"
absent "…ne recrée pas l'API/Web" "|up|" "$(trace)"
absent "…ne joue aucune migration" "migrate" "$(trace)"
absent "…ne touche pas à la démo (l'API n'a pas changé)" "up-demo" "$(trace)"
contient "…le message confirme que l'application n'a pas été recréée" "API et Web applicatif non recréés" "$sortie"
contient "…le journal identifie le périmètre marketing" '"perimetre":"marketing"' "$(tail -n 1 "$JOURNAL")"
contient "…et dit que la démo n'a pas été touchée" '"demo":"non"' "$(tail -n 1 "$JOURNAL")"

reinitialiser; REPONSES_PSQL=("" "11:45:00|scheduled|1")
sortie="$( (main) 2>&1 )"; code=$?
attend "⚠️ TRK-077 : passage parti PENDANT la construction → la seconde lecture refuse (code 1)" 1 "$code"
absent "…et l'API n'a PAS été recréée" "|up" "$(trace)"
contient "…mais l'image est construite : la relance sera courte" "build" "$(trace)"
if [ -s "$JOURNAL" ]; then ko "…rien au journal : rien n'a été déployé"; else ok "…rien au journal : rien n'a été déployé"; fi

echo "deploy.sh — la migration AVANT la recréation (incident du 17/09)"

reinitialiser; CODE_MIGRATION=1
sortie="$( (main) 2>&1 )"; code=$?
attend "🔴 migration en échec dans le conteneur éphémère → code 3, sans toucher à l'API" 3 "$code"
absent "…l'API en place n'a PAS été recréée" "|up" "$(trace)"
contient "…la migration est aussitôt marquée annulée (sinon P3009 au prochain redémarrage)" "migrate|resolve 20260917090000_rdv_lot_a" "$(trace)"
contient "…et le message dit que rien n'a été touché" "n'a PAS été touchée" "$sortie"
contient "…et renvoie vers le test des migrations" "verif:migrations" "$sortie"
if [ -s "$JOURNAL" ]; then ko "…rien au journal : rien n'a été déployé"; else ok "…rien au journal : rien n'a été déployé"; fi

reinitialiser; REPLI="avant-20260913-1130-a8f9575e"
sortie="$( (main) 2>&1 )"
absent "un --repli ne joue AUCUNE migration (les images étiquetées ont la leur)" "migrate" "$(trace)"

echo "deploy.sh — l'attente de santé et le repli automatique (incident du 17/09)"

reinitialiser; REPONSES_SANTE=("running starting 0" "running starting 0" "running healthy 0")
sortie="$( (main) 2>&1 )"; code=$?
attend "l'API met deux sondes à devenir saine : on attend, code 0" 0 "$code"
contient "…un pas de 5 s entre deux lectures" "up|up-lp|sleep 5|sleep 5" "$(trace)"
contient "…et on le dit" "tracky-api est sain" "$sortie"

reinitialiser; REPONSES_SANTE=("running starting 0" "restarting starting 1")
sortie="$( (main) 2>&1 )"; code=$?
attend "🔴 l'API REDÉMARRE après la recréation → repli automatique, code 4" 4 "$code"
contient "…le journal du conteneur est montré (la cause se lit tout de suite)" "logs" "$(trace)"
contient "…le repère posé au départ redevient latest pour les trois images, puis les deux piles repartent" \
  "up|up-lp|sleep 5|logs|tag tracky-api:avant-20260913-1130-a8f9575e tracky-api:latest|tag tracky-web:avant-20260913-1130-a8f9575e tracky-web:latest|tag tracky-lp:avant-20260913-1130-a8f9575e tracky-lp:latest|up|up-lp" "$(trace)"
absent "…et la démo n'est PAS touchée quand la production n'est pas saine" "up-demo" "$(trace)"
contient "…le message dit ANNULÉ et que l'image d'avant est de retour" "DÉPLOIEMENT ANNULÉ" "$sortie"
contient "…le journal dit repli-auto" '"sante":"repli-auto"' "$(tail -n 1 "$JOURNAL")"

reinitialiser; REPONSES_SANTE=("running starting 0" "running starting 0" "running starting 0" "running starting 0")
SANTE_MAX_S=12
sortie="$( (main) 2>&1 )"; code=$?
attend "🔴 toujours « starting » au bout du délai → repli automatique, code 4" 4 "$code"
contient "…la raison nomme le délai" "toujours « starting » après 12 s" "$sortie"
SANTE_MAX_S=150

reinitialiser; REPONSES_SANTE=("running unhealthy 0")
code=$( (main) >/dev/null 2>&1; echo $? )
attend "🔴 sonde en échec (unhealthy) → repli automatique, code 4" 4 "$code"

reinitialiser; REPONSES_SANTE_LP=("running unhealthy 0")
sortie="$( (main) 2>&1 )"; code=$?
attend "🔴 site marketing unhealthy → repli automatique des trois images, code 4" 4 "$code"
contient "…la cause nomme tracky-lp" "tracky-lp N'EST PAS SAIN" "$sortie"
contient "…le repli remet aussi l'image marketing" "tag tracky-lp:avant-20260913-1130-a8f9575e tracky-lp:latest" "$(trace)"

reinitialiser; REPONSES_SANTE_LP=("running unhealthy 0")
sortie="$( (main --marketing-seul) 2>&1 )"; code=$?
attend "🔴 marketing seul unhealthy → repli automatique du seul marketing, code 4" 4 "$code"
contient "…le repère marketing est restauré puis sa pile recréée" "logs|tag tracky-lp:avant-20260913-1130-a8f9575e tracky-lp:latest|up-lp" "$(trace)"
absent "…le repli marketing ne touche jamais aux images API/Web" "tag tracky-api:" "$(trace)"

reinitialiser; REPLI="avant-20260913-1130-a8f9575e"; REPONSES_SANTE=("exited starting 0")
sortie="$( (main) 2>&1 )"; code=$?
attend "🔴 un --repli qui ne donne pas une API saine → code 5, rien d'automatique au-delà" 5 "$code"
absent "…pas de repli du repli" "tag tracky-api:avant-20260913-1130-a8f9575e tracky-api:latest|tag tracky-web:avant-20260913-1130-a8f9575e tracky-web:latest|tag tracky-lp:avant-20260913-1130-a8f9575e tracky-lp:latest|up|up-lp|" "$(trace | sed 's/^.*|up-lp|/|up-lp|/')"
contient "…le journal le dit" '"sante":"malade-apres-repli"' "$(tail -n 1 "$JOURNAL")"

echo "deploy.sh — la fenêtre du matin (Europe/Paris, 05:30 → 09:00)"

reinitialiser; FAUSSE_HEURE_PARIS=0700
sortie="$( (main) 2>&1 )"; code=$?
attend "🔴 07:00 à Paris : REFUS (code 1) — les reprises du coupe-circuit dépendent de l'API" 1 "$code"
contient "…le message nomme la fenêtre et l'incident" "fenêtre du matin" "$sortie"
attend "…et rien n'a été fait : ni repère, ni pull, ni build" "" "$(trace)"

reinitialiser; FAUSSE_HEURE_PARIS=0530
code=$( (main) >/dev/null 2>&1; echo $? )
attend "05:30 : la fenêtre commence (inclus) → refus" 1 "$code"

reinitialiser; FAUSSE_HEURE_PARIS=0900
code=$( (main) >/dev/null 2>&1; echo $? )
attend "09:00 : la fenêtre est finie (exclu) → on déploie" 0 "$code"

reinitialiser; FAUSSE_HEURE_PARIS=0529
code=$( (main) >/dev/null 2>&1; echo $? )
attend "05:29 : avant la fenêtre → on déploie" 0 "$code"

reinitialiser; FAUSSE_HEURE_PARIS=0700; FORCE=1
sortie="$( (main) 2>&1 )"; code=$?
attend "07:00 + --force : on déploie, en le disant" 0 "$code"
contient "…le message dit --force et la fenêtre" "fenêtre du matin" "$sortie"

reinitialiser; FAUSSE_HEURE_PARIS=0700; REPLI="avant-20260913-1130-a8f9575e"
code=$( (main) >/dev/null 2>&1; echo $? )
attend "07:00 + --repli : JAMAIS retenu — un repli rétablit le service (code 0)" 0 "$code"

echo "deploy.sh — la démo suit la production (VPS-046, 2026-09-20)"

reinitialiser
sortie="$( (main) 2>&1 )"; code=$?
contient "PAR DÉFAUT la démo suit, après la prod et le marketing — et après leur santé" "|up|up-lp|up-demo" "$(trace)"
contient "…le script attend la santé de l'API de démo" "tracky-demo-api est sain" "$sortie"

reinitialiser
sortie="$( (main --sans-demo) 2>&1 )"; code=$?
attend "--sans-demo : rend 0" 0 "$code"
absent "…et ne touche pas à la démo" "up-demo" "$(trace)"
contient "…mais le dit : elle reste sur l'ancien code ET l'ancien schéma" "ancien schéma" "$sortie"
contient "…et le journal le porte" '"demo":"non"' "$(tail -n 1 "$JOURNAL")"

reinitialiser; REPONSES_SANTE_DEMO=("running starting 0" "restarting starting 1")
sortie="$( (main) 2>&1 )"; code=$?
attend "🔴 la démo redémarre en boucle après recréation (migration en échec) : la PRODUCTION n'est PAS mise en cause, code 0" 0 "$code"
absent "…aucun repli de la production" "tag tracky-api:avant-20260913-1130-a8f9575e tracky-api:latest" "$(trace)"
contient "…le message dit que la démo n'est pas saine et que la production n'est pas concernée" "la production n'est pas concernée" "$sortie"
contient "…le journal dit demo malade, production saine" '"sante":"healthy","demo":"malade"' "$(tail -n 1 "$JOURNAL")"

reinitialiser; CODE_UP_DEMO=1
sortie="$( (main) 2>&1 )"; code=$?
attend "🔴 le up -d de la démo échoue : code 0 quand même" 0 "$code"
contient "…journal : demo malade" '"demo":"malade"' "$(tail -n 1 "$JOURNAL")"

reinitialiser; rm -f "$RACINE/deploy/vps/.env.demo"
sortie="$( (main) 2>&1 )"; code=$?
attend "pas de .env.demo sur la machine : code 0" 0 "$code"
absent "…aucun up -d de démo tenté" "up-demo" "$(trace)"
contient "…journal : demo absente" '"demo":"absente"' "$(tail -n 1 "$JOURNAL")"

reinitialiser; REPLI="avant-20260913-1130-a8f9575e"
sortie="$( (main) 2>&1 )"; code=$?
attend "--repli : rend 0" 0 "$code"
absent "…sans pull" "git pull" "$(trace)"
absent "…sans build" "build" "$(trace)"
contient "…l'étiquette redevient latest, API, web et marketing" "tag tracky-api:avant-20260913-1130-a8f9575e tracky-api:latest|tag tracky-web:avant-20260913-1130-a8f9575e tracky-web:latest|tag tracky-lp:avant-20260913-1130-a8f9575e tracky-lp:latest" "$(trace)"
contient "…puis la garde, puis les deux piles, puis la démo (mêmes images : elle suit le repli aussi)" "psql|up|up-lp|up-demo" "$(trace)"
contient "…et le journal dit que c'est un repli" '"repli":"avant-20260913-1130-a8f9575e"' "$(tail -n 1 "$JOURNAL")"

reinitialiser
code=$( (lire_options --marketing-seul --avec-demo) >/dev/null 2>&1; echo $? )
attend "--marketing-seul et --avec-demo ne sont plus refusés : le marketing seul force simplement la démo à « non »" 0 "$code"
reinitialiser; lire_options --marketing-seul --avec-demo
attend "…AVEC_DEMO retombe à 0" "0" "$AVEC_DEMO"
reinitialiser; lire_options --sans-demo
attend "--sans-demo met AVEC_DEMO à 0" "0" "$AVEC_DEMO"
reinitialiser; lire_options
attend "sans option, la démo suit (AVEC_DEMO=1 par défaut)" "1" "$AVEC_DEMO"

reinitialiser
lire_options --marketing-seul
attend "--marketing-seul réduit le périmètre de repli à tracky-lp" "1 tracky-lp" "$MARKETING_SEUL $IMAGES"

reinitialiser
code=$( (lire_options --nimporte) >/dev/null 2>&1; echo $? )
attend "une option inconnue vaut un code 2" 2 "$code"

reinitialiser
lire_options --force --attendre --avec-demo --branche recette --repli avant-x
attend "les options se lisent" "1 1 1 0 recette avant-x" "$FORCE $ATTENDRE $AVEC_DEMO $MARKETING_SEUL $BRANCHE $REPLI"

rm -f "$COMPTEUR_PSQL" "$COMPTEUR_SANTE" "$COMPTEUR_SANTE_LP" "$COMPTEUR_SANTE_DEMO" "$TRACE"
echo
if [ "$ECHECS" -eq 0 ]; then
  echo "deploy.sh : $TOTAL contrôles, tous verts."
else
  echo "deploy.sh : $ECHECS contrôle(s) en échec sur $TOTAL."
  exit 1
fi
