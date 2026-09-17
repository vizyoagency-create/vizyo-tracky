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
    "compose --env-file .env.demo -f docker-compose.demo.yml up -d")   noter "up-demo" ;;
    "inspect --format {{.Id}} tracky-api") echo "d144f11ee90f4169978e5e8b2ad133722c5ddbaf44a863ab302aac2cc2eace17" ;;
    "inspect --format {{.Id}} tracky-web") echo "66dc3d93049a0000000000000000000000000000000000000000000000000000" ;;
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
  FAUSSE_MINUTE=30; FAUSSE_SECONDE=0; FAUSSE_EPOCH=1000; ETIQUETTES_EXISTANTES=""
  FAUSSE_HEURE_PARIS=1200; CODE_MIGRATION=0; ETIQUETTE_POSEE=""
  FORCE=0; ATTENDRE=0; AVEC_DEMO=0; BRANCHE=main; REPLI=""
  JOURNAL="$(mktemp)"; RACINE="$(mktemp -d)"; mkdir -p "$RACINE/deploy/vps"
}

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
contient "l'image de l'API reçoit une étiquette avant-<date>-<sha>" "tag tracky-api:latest tracky-api:avant-20260913-1130-a8f9575e" "$(trace)"
contient "…celle du web aussi, la MÊME" "tag tracky-web:latest tracky-web:avant-20260913-1130-a8f9575e" "$(trace)"
absent "…et rien n'est élagué quand il n'y a rien" "rmi" "$(trace)"
contient "…et le script dit comment revenir en arrière" "--repli avant-20260913-1130-a8f9575e" "$sortie"

reinitialiser; ETIQUETTES_EXISTANTES="avant-20260910-0027-3f7b9d2d avant-20260911-1000-aaaa1111 latest avant-20260908-0800-bbbb2222 avant-20260912-2200-cccc3333"
sortie="$( (etiqueter_repli) 2>&1 )"
contient "⚠️ trois repères gardés par image, le nouveau compris : le plus ancien part" "rmi tracky-api:avant-20260908-0800-bbbb2222" "$(trace)"
contient "…et le suivant aussi (quatre anciens + un nouveau, on n'en garde que trois)" "rmi tracky-api:avant-20260910-0027-3f7b9d2d" "$(trace)"
absent "…les deux plus récents restent" "rmi tracky-api:avant-20260911" "$(trace)"
absent "…jamais latest" "rmi tracky-api:latest" "$(trace)"
contient "…le web suit la même règle" "rmi tracky-web:avant-20260908-0800-bbbb2222" "$(trace)"

echo "deploy.sh — le déroulé complet"

reinitialiser
sortie="$( (main) 2>&1 )"; code=$?
attend "un déploiement ordinaire rend 0" 0 "$code"
attend "⚠️ l'ORDRE : garde, repères, pull, build, MIGRATION, GARDE À NOUVEAU, up — et rien d'autre" \
  "psql|tag tracky-api:latest tracky-api:avant-20260913-1130-a8f9575e|tag tracky-web:latest tracky-web:avant-20260913-1130-a8f9575e|git checkout -q main|git pull --ff-only origin main|build|migrate|psql|up" "$(trace)"
contient "…et le script ne dit « terminé » qu'avec une API SAINE" "Déploiement terminé : API saine" "$sortie"
ligne="$(tail -n 1 "$JOURNAL")"
contient "le journal porte l'identifiant du conteneur API créé" '"apiContainerId":"d144f11ee90f4169978e5e8b2ad133722c5ddbaf44a863ab302aac2cc2eace17"' "$ligne"
contient "…le sha déployé" '"sha":"a8f9575e"' "$ligne"
contient "…et que rien n'a été forcé" '"force":false' "$ligne"
contient "…et que l'API était saine" '"sante":"healthy"' "$ligne"
if command -v node >/dev/null 2>&1; then
  if node -e "JSON.parse(process.argv[1])" "$ligne" 2>/dev/null; then ok "…et c'est du JSON valide"; else ko "…et c'est du JSON valide" "$ligne"; fi
fi

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
contient "…un pas de 5 s entre deux lectures" "up|sleep 5|sleep 5" "$(trace)"
contient "…et on le dit" "est saine" "$sortie"

reinitialiser; REPONSES_SANTE=("running starting 0" "restarting starting 1")
sortie="$( (main) 2>&1 )"; code=$?
attend "🔴 l'API REDÉMARRE après la recréation → repli automatique, code 4" 4 "$code"
contient "…le journal du conteneur est montré (la cause se lit tout de suite)" "logs" "$(trace)"
contient "…le repère posé au départ redevient latest, API et web, puis up" \
  "up|sleep 5|logs|tag tracky-api:avant-20260913-1130-a8f9575e tracky-api:latest|tag tracky-web:avant-20260913-1130-a8f9575e tracky-web:latest|up" "$(trace)"
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

reinitialiser; REPLI="avant-20260913-1130-a8f9575e"; REPONSES_SANTE=("exited starting 0")
sortie="$( (main) 2>&1 )"; code=$?
attend "🔴 un --repli qui ne donne pas une API saine → code 5, rien d'automatique au-delà" 5 "$code"
absent "…pas de repli du repli" "tag tracky-api:avant-20260913-1130-a8f9575e tracky-api:latest|tag tracky-web:avant-20260913-1130-a8f9575e tracky-web:latest|up|" "$(trace | sed 's/^.*|up|/|up|/')"
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

reinitialiser; AVEC_DEMO=1
sortie="$( (main) 2>&1 )"
contient "--avec-demo : la démo suit, après la prod" "|up|up-demo" "$(trace)"

reinitialiser; REPLI="avant-20260913-1130-a8f9575e"
sortie="$( (main) 2>&1 )"; code=$?
attend "--repli : rend 0" 0 "$code"
absent "…sans pull" "git pull" "$(trace)"
absent "…sans build" "build" "$(trace)"
contient "…l'étiquette redevient latest, API et web" "tag tracky-api:avant-20260913-1130-a8f9575e tracky-api:latest|tag tracky-web:avant-20260913-1130-a8f9575e tracky-web:latest" "$(trace)"
contient "…puis la garde, puis up" "psql|up" "$(trace)"
contient "…et le journal dit que c'est un repli" '"repli":"avant-20260913-1130-a8f9575e"' "$(tail -n 1 "$JOURNAL")"

reinitialiser
code=$( (lire_options --nimporte) >/dev/null 2>&1; echo $? )
attend "une option inconnue vaut un code 2" 2 "$code"

reinitialiser
lire_options --force --attendre --avec-demo --branche recette --repli avant-x
attend "les options se lisent" "1 1 1 recette avant-x" "$FORCE $ATTENDRE $AVEC_DEMO $BRANCHE $REPLI"

rm -f "$COMPTEUR_PSQL" "$COMPTEUR_SANTE" "$TRACE"
echo
if [ "$ECHECS" -eq 0 ]; then
  echo "deploy.sh : $TOTAL contrôles, tous verts."
else
  echo "deploy.sh : $ECHECS contrôle(s) en échec sur $TOTAL."
  exit 1
fi
