#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════════════════
# TESTS DES SCRIPTS PLANIFIÉS — backup-db.sh et demo-refresh.sh, bornés (V34, 2026-10-01)
# ═══════════════════════════════════════════════════════════════════════════════════════════
#
#     bash deploy/vps/scripts-planifies.test.sh          # ou : pnpm verif:deploiement
#
# Ces deux scripts tournent par minuteur systemd, en service `oneshot` SANS `TimeoutStartSec` :
# une commande docker qui ne rend jamais la main y bloque le service pour toujours — et, avec lui,
# la sauvegarde suivante ou le rafraîchissement suivant (systemd ne relance pas ce qui tourne).
#
# Ils sont joués ici EN VRAI — processus séparé, vrai `timeout`, vrai `gzip`, vrais fichiers dans
# un bac à sable — avec un FAUX `docker` et un FAUX `curl` en tête du PATH : ils répondent,
# échouent ou se bloquent selon les variables FAUX_*, et notent chaque appel. Rien ne parle à
# Docker, ni au VPS. Les bornes sont ramenées à 1 s : un cas « bloqué » dure une seconde.
set -u
cd "$(dirname "$0")"

# ── le harnais ──────────────────────────────────────────────────────────────────────────────
ECHECS=0; TOTAL=0
ok()    { TOTAL=$((TOTAL + 1)); echo "  ✓ $1"; }
ko()    { TOTAL=$((TOTAL + 1)); ECHECS=$((ECHECS + 1)); echo "  ✗ $1"; [ -n "${2:-}" ] && echo "      $2"; }
attend()   { if [ "$2" = "$3" ]; then ok "$1"; else ko "$1" "attendu « $2 », obtenu « $3 »"; fi; }
contient() { if [[ "$3" == *"$2"* ]]; then ok "$1"; else ko "$1" "« $2 » absent de : $3"; fi; }
absent()   { if [[ "$3" != *"$2"* ]]; then ok "$1"; else ko "$1" "« $2 » présent dans : $3"; fi; }

BAC="$(mktemp -d)"
FAUX="$BAC/faux"; mkdir -p "$FAUX"
TRACE="$BAC/trace-docker"; CURL="$BAC/trace-curl"
trace() { paste -sd'|' "$TRACE" 2>/dev/null; }

# ── le faux docker : note l'appel, puis joue le rôle demandé ────────────────────────────────
cat > "$FAUX/docker" <<'FIN'
#!/bin/bash
echo "$*" >> "$TRACE_DOCKER"
case "$*" in
  "exec tracky-postgres pg_dump"*)
    case "${FAUX_DUMP:-ok}" in
      ok)     printf -- '-- PostgreSQL database dump\nCREATE TABLE t (id int);\n-- PostgreSQL database dump complete\n' ;;
      echec)  printf -- '-- PostgreSQL database dump\nCREATE TA'; exit 1 ;;
      bloque) printf -- '-- PostgreSQL database dump\nCREATE TA'; exec sleep 30 ;;
    esac ;;
  "exec tracky-demo-postgres psql"*)
    if [ "${FAUX_DEMANDE:-0}" = bloque ]; then exec sleep 30; fi
    echo "${FAUX_DEMANDE:-0}" ;;
  *" stop api")
    if [ "${FAUX_STOP:-ok}" = bloque ]; then exec sleep 30; fi
    [ "${FAUX_STOP:-ok}" = ok ] ;;
  *" start api")
    [ "${FAUX_START:-ok}" = ok ] ;;
  *" run --rm importer")
    case "${FAUX_IMPORT:-ok}" in
      ok)     echo "import : 37 véhicules" ;;
      echec)  echo "Error: column does not exist"; exit 1 ;;
      bloque) exec sleep 30 ;;
    esac ;;
  "ps -q --filter"*)
    if [ "${FAUX_ORPHELIN:-0}" = 1 ]; then echo "c0ffee1234ab"; fi ;;
  "rm -f "*) exit 0 ;;
  *) echo "faux docker : appel inattendu : $*" >&2; exit 99 ;;
esac
FIN
cat > "$FAUX/curl" <<'FIN'
#!/bin/bash
printf '%s\n' "$*" >> "$TRACE_CURL"
FIN
chmod +x "$FAUX/docker" "$FAUX/curl"
export TRACE_DOCKER="$TRACE" TRACE_CURL="$CURL"

# ════════════════════════════════════════════════════════════════════════════════════════════
echo "backup-db.sh — la sauvegarde ne reste jamais bloquée, et ne garde jamais une archive tronquée"

SAUV="$BAC/sauvegardes"
sauvegarder() {   # les FAUX_* et BORNE_* viennent de l'environnement de l'appelant
  : > "$TRACE"; : > "$CURL"; rm -rf "$SAUV"; mkdir -p "$SAUV"
  PATH="$FAUX:$PATH" BACKUP_DIR="$SAUV" API_URL="http://127.0.0.1:1" INTERNAL_API_SECRET="secret-de-test" \
    bash ./backup-db.sh > "$BAC/sortie" 2>&1
}
archives() { (cd "$SAUV" && ls -1 2>/dev/null | paste -sd' ' -); }

(export FAUX_DUMP=ok; sauvegarder); code=$?
attend "dump complet : code 0" 0 "$code"
a="$(archives)"
if [[ "$a" =~ ^tracky_prod_[0-9-]+\.sql\.gz$ ]]; then ok "…une seule archive, au nom final ($a)"; else ko "…une seule archive, au nom final" "$a"; fi
if gzip -dc "$SAUV"/tracky_prod_*.sql.gz 2>/dev/null | grep -q "dump complete"; then ok "…et elle contient le dump ENTIER"; else ko "…et elle contient le dump ENTIER"; fi
contient "…le POST de santé dit OK" '"status": "OK"' "$(cat "$CURL")"
contient "…et il est lui-même borné (curl --max-time)" "--max-time 30" "$(cat "$CURL")"

(export FAUX_DUMP=bloque BORNE_DUMP_S=1; sauvegarder); code=$?
attend "🔴 pg_dump bloqué : la borne l'interrompt, code 124" 124 "$code"
attend "…AUCUN fichier laissé : ni archive tronquée, ni partiel" "" "$(archives)"
contient "…le POST de santé dit FAILED" '"status": "FAILED"' "$(cat "$CURL")"
contient "…et pourquoi" "borne de 1 s dépassée" "$(cat "$CURL")"
contient "…la sortie du service le dit aussi (journalctl)" "ERREUR : pg_dump interrompu" "$(cat "$BAC/sortie")"

(export FAUX_DUMP=echec; sauvegarder); code=$?
attend "pg_dump en échec au milieu du dump : code 1" 1 "$code"
attend "…aucune archive tronquée gardée (avant : un .sql.gz valide d'un SQL coupé)" "" "$(archives)"
contient "…le POST de santé dit FAILED, avec le code" "pg_dump en échec (code 1)" "$(cat "$CURL")"

sauvegarder_avec_vieux_partiel() {
  : > "$TRACE"; : > "$CURL"; rm -rf "$SAUV"; mkdir -p "$SAUV"
  touch -d '2 days ago' "$SAUV/tracky_prod_20200101-000000.sql.gz.partiel"
  PATH="$FAUX:$PATH" BACKUP_DIR="$SAUV" API_URL="http://127.0.0.1:1" INTERNAL_API_SECRET="secret-de-test" \
    bash ./backup-db.sh > "$BAC/sortie" 2>&1
}
(export FAUX_DUMP=ok; sauvegarder_avec_vieux_partiel)
absent "un partiel de plus d'un jour (arrêt brutal) est ramassé par la rotation" ".partiel" "$(archives)"

# ════════════════════════════════════════════════════════════════════════════════════════════
echo "demo-refresh.sh — chaque appel docker est borné, et l'API de démo repart toujours"

DEMO="$BAC/demo"; mkdir -p "$DEMO"
cp ./demo-refresh.sh ./docker-compose.demo.yml "$DEMO/"
printf 'POSTGRES_USER=demo\nPOSTGRES_DB=tracky_demo\nRESEND_FROM=Tracky Démo <demo@vizyoagency.com>\n' > "$DEMO/.env.demo"
JDEMO="$BAC/journal-demo"
rafraichir() {   # $@ = arguments du script ; FAUX_* et BORNE_* depuis l'environnement
  : > "$TRACE"; : > "$JDEMO"
  PATH="$FAUX:$PATH" JOURNAL="$JDEMO" bash "$DEMO/demo-refresh.sh" "$@" > /dev/null 2>&1
}
journal() { cat "$JDEMO"; }

(export FAUX_DEMANDE=0; rafraichir --si-demande); code=$?
attend "--si-demande sans demande : rien à faire, code 0" 0 "$code"
absent "…l'API de démo n'est pas touchée" "stop api" "$(trace)"

(export FAUX_DEMANDE=bloque BORNE_LECTURE_S=1; rafraichir --si-demande); code=$?
attend "🔴 lecture de la demande bloquée : borne, code 124" 124 "$code"
contient "…et le journal le dit" "Lecture de la demande impossible : borne de 1 s" "$(journal)"
absent "…sans toucher à l'API de démo" "stop api" "$(trace)"

(export FAUX_DEMANDE=1; rafraichir --si-demande); code=$?
attend "--si-demande avec une demande : import, code 0" 0 "$code"
contient "…la demande est reconnue" "Demande de rafraîchissement trouvée" "$(journal)"

(rafraichir); code=$?
attend "passage planifié réussi : code 0" 0 "$code"
contient "…dans l'ordre : arrêt de l'API, import, redémarrage" "stop api|compose --env-file .env.demo -f docker-compose.demo.yml run --rm importer|compose --env-file .env.demo -f docker-compose.demo.yml start api" "$(trace)"
contient "…« Import réussi » au journal" "Import réussi" "$(journal)"
contient "…« API de démo redémarrée »" "API de démo redémarrée" "$(journal)"

(export FAUX_IMPORT=echec; rafraichir); code=$?
attend "import en échec : code 1" 1 "$code"
contient "…l'API repart quand même" "start api" "$(trace)"

(export FAUX_IMPORT=bloque BORNE_IMPORT_S=1 FAUX_ORPHELIN=1; rafraichir); code=$?
attend "🔴 import bloqué : la borne l'interrompt, code 1 (import en échec)" 1 "$code"
contient "…le journal dit « interrompu », pas seulement « en échec »" "IMPORT INTERROMPU : borne de 1 s" "$(journal)"
contient "…l'importeur ORPHELIN est arrêté AVANT que l'API de démo reparte" "rm -f c0ffee1234ab|compose --env-file .env.demo -f docker-compose.demo.yml start api" "$(trace)"
contient "…retrouvé par les étiquettes de Compose (projet de la démo, service importer)" "--filter label=com.docker.compose.project=tracky-demo --filter label=com.docker.compose.service=importer" "$(trace)"

(export FAUX_IMPORT=bloque BORNE_IMPORT_S=1 FAUX_ORPHELIN=0; rafraichir)
contient "import bloqué dont le conteneur est déjà parti : on le dit, sans rien forcer" "plus aucun importeur en marche" "$(journal)"
absent "…aucun rm -f" "rm -f" "$(trace)"

(export FAUX_STOP=bloque BORNE_COMPOSE_S=1; rafraichir); code=$?
attend "🔴 arrêt de l'API de démo bloqué : borne, code 124, pas d'import" 124 "$code"
absent "…aucun import lancé" "run --rm importer" "$(trace)"
contient "…mais l'API repart (le piège est posé AVANT l'arrêt)" "start api" "$(trace)"
contient "…et le journal le dit" "ARRÊT DE L'API DE DÉMO INTERROMPU" "$(journal)"

(export FAUX_START=echec; rafraichir)
contient "redémarrage en échec : l'avertissement est au journal" "AVERTISSEMENT : l'API de démo n'a pas redémarré" "$(journal)"
absent "…et le journal ne prétend plus « API de démo redémarrée »" "API de démo redémarrée" "$(journal)"

# ════════════════════════════════════════════════════════════════════════════════════════════
echo "Lecture du source et des documents : aucune commande docker sans borne"

re_docker='(^|[^-_[:alnum:]])docker (compose|inspect|image|images|tag|rmi|ps|exec|logs|run|stats|pull|build|rm|stop|start)'
re_compose='"\$\{COMPOSE\[@\]\}"'
re_borne='timeout[^|]*(docker|"\$\{COMPOSE\[@\]\}")'
re_suivi='docker.*logs.*( -f|--follow)'

lignes_non_bornees_script() {   # $1 = script
  local n=0 ligne fautes=""
  while IFS= read -r ligne; do
    n=$((n + 1))
    [[ "$ligne" =~ ^[[:space:]]*# ]] && continue          # commentaire
    [[ "$ligne" == *'log "'* || "$ligne" == *'echo "'* ]] && continue   # message
    [[ "$ligne" == COMPOSE=\(* ]] && continue             # définition du tableau, pas un appel
    if [[ "$ligne" =~ $re_docker || "$ligne" =~ $re_compose ]] && ! [[ "$ligne" =~ $re_borne ]]; then fautes+="$n "; fi
  done < "$1"
  echo "$fautes"
}
attend "backup-db.sh : chaque appel docker est derrière timeout (lignes fautives)" "" "$(lignes_non_bornees_script ./backup-db.sh)"
attend "demo-refresh.sh : chaque appel docker est derrière timeout (lignes fautives)" "" "$(lignes_non_bornees_script ./demo-refresh.sh)"

re_cloture='^[[:space:]]*(>[[:space:]]*)?```'        # ``` ouvre ou ferme un bloc (y compris dans une citation)
re_indente='^    '                                    # bloc de code indenté de 4
lignes_non_bornees_doc() {   # $1 = document Markdown : les blocs ``` et les blocs indentés de 4
  local n=0 ligne fautes="" dans_bloc=0
  while IFS= read -r ligne; do
    n=$((n + 1))
    if [[ "$ligne" =~ $re_cloture ]]; then dans_bloc=$((1 - dans_bloc)); continue; fi
    if [ "$dans_bloc" -eq 1 ] || [[ "$ligne" =~ $re_indente ]]; then
      if [[ "$ligne" =~ $re_docker ]] && ! [[ "$ligne" =~ $re_borne ]]; then fautes+="$n "; fi
      if [[ "$ligne" =~ $re_suivi ]]; then fautes+="$n(-f) "; fi
      if [[ "$ligne" == *"docker logs"* && "$ligne" != *"--tail"* ]]; then fautes+="$n(sans --tail) "; fi
    fi
  done < "$1"
  echo "$fautes"
}
attend "docs/DEPLOYMENT-VPS.md : commandes docker bornées (lignes fautives)" "" "$(lignes_non_bornees_doc ../../docs/DEPLOYMENT-VPS.md)"
attend "docs/VERIFIER-AVANT-DE-DEPLOYER.md : commandes docker bornées (lignes fautives)" "" "$(lignes_non_bornees_doc ../../docs/VERIFIER-AVANT-DE-DEPLOYER.md)"

rm -rf "$BAC"
echo
if [ "$ECHECS" -eq 0 ]; then
  echo "scripts planifiés : $TOTAL contrôles, tous verts."
else
  echo "scripts planifiés : $ECHECS contrôle(s) en échec sur $TOTAL."
  exit 1
fi
