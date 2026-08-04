#!/usr/bin/env bash
# =============================================================================================
# COLLECTEUR D'AUDIT VPS — instantané complet de la machine, en LECTURE SEULE.
#
# Usage :  ssh root@72.62.26.240 'bash -s' < docs/vps-audit/collecte.sh
#
# ── Ce que ce script ne fait JAMAIS ──────────────────────────────────────────────────────────
#   Aucun `rm`, `prune`, `kill`, `restart`, `apt install`, `systemctl`. Il lit, il compte, il
#   affiche. Les commandes de remédiation sont ECRITES DANS LE RAPPORT, jamais exécutées ici :
#   c'est ce qui permet de le lancer sans réfléchir, y compris depuis une tâche planifiée.
#
# ── Bornes de sûreté ─────────────────────────────────────────────────────────────────────────
#   Chaque parcours de disque est sous `timeout`. Un audit qui fait ramer la machine qu'il
#   mesure fausse sa propre mesure — et sur 2 vCPU, ça se voit tout de suite.
#
# ── Pièges déjà payés (ne pas « simplifier » ces lignes) ─────────────────────────────────────
#   1. `df -hT` seul noie la sortie sous des dizaines de montages overlay Docker → on filtre.
#   2. Docker ≥ 29 stocke dans `rootfs/overlayfs`, plus dans `overlay2` → les deux sont testés.
#   3. `docker inspect .State.Health` PLANTE sur un conteneur sans healthcheck → `{{if}}` obligatoire.
#   4. `find /` sans `-xdev` part dans les volumes Docker et dépasse toute limite de temps.
#   5. Les identifiants Postgres se LISENT dans l'env du conteneur ; les deviner donne un
#      silence vide qu'on prend à tort pour « base saine ».
#   6. `ps ... | awk '{print $N}'` décale les colonnes dès qu'une commande contient un espace
#      → séparateur explicite.
# =============================================================================================

set -uo pipefail   # pas de `-e` : une section qui échoue ne doit pas décapiter le rapport
export LC_ALL=C

section() { printf '\n\n═════ %s ═════\n' "$1"; }
sub()     { printf '\n── %s ──\n' "$1"; }
have()    { command -v "$1" >/dev/null 2>&1; }

# Priorite MINIMALE pour tout parcours de disque. `nice -n 19` cede le CPU a n'importe quoi
# d'autre, `ionice -c3` (classe « idle ») ne lit que lorsque plus personne n'attend le disque.
# Sur 2 vCPU deja charges, un audit qui se sert avant les services degrade ce qu'il surveille
# et fausse sa propre mesure.
LOW="nice -n 19 ionice -c3"

printf 'COLLECTE AUDIT VPS — %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
printf 'hote=%s  noyau=%s\n' "$(hostname)" "$(uname -r)"

# ─────────────────────────────────────────────────────────────────────────────────────────────
section "1. IDENTITE & CHARGE"
# ─────────────────────────────────────────────────────────────────────────────────────────────
grep PRETTY_NAME /etc/os-release
uptime
sub "CPU"
lscpu | grep -Ei "^model name|^cpu\(s\)|hypervisor|^core"
sub "Charge instantanee (rapportee au nombre de coeurs)"
awk -v c="$(nproc)" '{printf "  1min=%.2f  5min=%.2f  15min=%.2f  (sur %d coeurs → %.0f%% / %.0f%% / %.0f%%)\n",
  $1,$2,$3,c,100*$1/c,100*$2/c,100*$3/c}' /proc/loadavg

# ─────────────────────────────────────────────────────────────────────────────────────────────
section "2. MEMOIRE"
# ─────────────────────────────────────────────────────────────────────────────────────────────
free -h
sub "Indicateurs clefs"
# Committed_AS > MemTotal n'est PAS une alerte en soi : c'est ce que les processus ont
# RESERVE, pas ce qu'ils utilisent. Ne conclure qu'en croisant avec l'historique (section 9).
grep -E "MemTotal|MemAvailable|SwapTotal|SwapFree|Committed_AS|Slab|Dirty" /proc/meminfo
sysctl -n vm.swappiness 2>/dev/null | xargs echo "  vm.swappiness ="
sub "Pression (PSI) — 'full' > 0 signifie que TOUT s'est arrete faute de ressource"
for r in memory cpu io; do printf '  %-7s %s\n' "$r" "$(grep '^full' /proc/pressure/$r 2>/dev/null || echo n/a)"; done
sub "Swap par processus (> 1 Mo)"
for f in /proc/[0-9]*/status; do
  awk '/^Name:/{n=$2} /^VmSwap:/{if ($2+0>1024) printf "%d\t%s\n", $2, n}' "$f" 2>/dev/null
done | sort -rn | head -10 | awk -F'\t' '{printf "  %6d Mo  %s\n", $1/1024, $2}'
sub "Tues par manque de memoire (30 j)"
journalctl --since "30 days ago" 2>/dev/null | grep -icE "out of memory|oom-kill" | xargs echo "  occurrences OOM :"

# ─────────────────────────────────────────────────────────────────────────────────────────────
section "3. DISQUE"
# ─────────────────────────────────────────────────────────────────────────────────────────────
# `grep -v overlay` : sans ca, chaque conteneur ajoute une ligne identique et la vraie
# information (le taux de remplissage de /) se perd au milieu de trente doublons.
df -hT | grep -vE "tmpfs|udev|overlay"
sub "Inodes"
df -i | grep -vE "tmpfs|udev|overlay"
sub "Repartition hors Docker"
# ⚠️ `/usr` est VOLONTAIREMENT exclu : ~2,9 Go de binaires systeme qui ne bougent pas d'un
# audit a l'autre, pour un parcours couteux. Il n'a jamais ete la cause d'un disque plein.
# Son retrait a ramene la collecte de 96 s a ~60 s (budget : 90 s).
timeout 90 $LOW du -sh --exclude=/var/lib/docker /var/log /opt /root /home /var/backups 2>/dev/null | sort -rh
sub "Detail /var/lib/docker (dossiers legers uniquement)"
# ⚠️ `rootfs` et `overlay2` sont VOLONTAIREMENT EXCLUS : les parcourir, c'est marcher sur
# ~12 Go de couches empilees, soit plusieurs minutes d'E/S soutenues pour un chiffre que
# `docker system df` (ci-dessus) donne deja gratuitement. L'audit ne doit pas etre la charge
# la plus lourde de la journee.
#
# ⚠️ PIEGE PAYE LE 2026-08-04 : `timeout N du -sh ...` qui expire ne produit RIEN, et une
# section vide se lit comme « rien a signaler » au lieu de « mesure non faite ». D'ou le
# message explicite ci-dessous.
for d in volumes containers image buildkit; do
  [ -d "/var/lib/docker/$d" ] || continue
  out=$(timeout 60 $LOW du -sh "/var/lib/docker/$d" 2>/dev/null)
  if [ -n "$out" ]; then echo "  $out"
  else echo "  (mesure ABANDONNEE apres 60 s pour /var/lib/docker/$d — se fier a docker system df)"; fi
done
sub "Sauvegardes"
for b in /var/backups/vizyo-tracky /opt/backups; do
  [ -d "$b" ] && { timeout 30 $LOW du -sh "$b" 2>/dev/null; printf '  %s fichiers\n' "$(find "$b" -type f 2>/dev/null | wc -l)"; }
done
# Deux sauvegardes le MEME jour = deux planificateurs qui font le meme travail (cf. VPS-006).
# ⚠️ CE QUI COMPTE EST LA DATE DU DERNIER DOUBLON, PAS LEUR NOMBRE.
#
# Le doublon a ete corrige le 2026-08-04, mais les fichiers deja ecrits restent la jusqu'a
# expiration de la retention (30 j). Lister « 30 journees en doublon » ferait croire chaque
# matin que le correctif n'a pas pris — un faux positif quotidien, donc surement ignore au
# bout de trois jours. On compare donc la date la plus recente a AUJOURD'HUI.
sub "Doublons de sauvegarde — c'est la DATE du dernier qui compte"
DUPJ=$(find /var/backups/vizyo-tracky -name "*.sql.gz" -printf "%f\n" 2>/dev/null \
  | sed -E 's/.*_([0-9]{8})-.*/\1/' | sort | uniq -c | awk '$1>1 {print $2}' | sort)
if [ -z "$DUPJ" ]; then
  echo "  ✅ aucune journee en doublon"
else
  DERN=$(echo "$DUPJ" | tail -1)
  NBJ=$(echo "$DUPJ" | wc -l)
  AUJ=$(date +%Y%m%d)
  AGE=$(( ( $(date -d "$AUJ" +%s) - $(date -d "$DERN" +%s) ) / 86400 ))
  echo "  journees concernees : $NBJ — la plus recente : $DERN (il y a $AGE j)"
  if [ "$AGE" -ge 1 ]; then
    echo "  ✅ HISTORIQUE — plus aucun doublon depuis $AGE jour(s). Ces fichiers partiront a la retention."
  else
    echo "  🔴 DOUBLON ENCORE ACTIF aujourd'hui — deux planificateurs tournent toujours (cf. VPS-003)"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────────────────────
section "4. DOCKER"
# ─────────────────────────────────────────────────────────────────────────────────────────────
have docker || { echo "docker absent"; }
docker system df 2>/dev/null
sub "Conteneurs par etat"
docker ps -a --format '{{.State}}' 2>/dev/null | sort | uniq -c
sub "Conteneurs ARRETES — toujours affiche, meme a zero"
# ⚠️ CETTE SECTION DOIT PARLER MEME QUAND IL N'Y A RIEN. Une section vide se lit comme
# « pas regarde » ; un « 0 conteneur arrete » se lit comme « verifie, rien a signaler ».
#
# ⚠️ ET SURTOUT : ne pas confondre « encombrant » et « incident ». Un conteneur arrete depuis
# 50 jours est du menage. Un conteneur mort CETTE NUIT est une panne — et c'est exactement
# celui qu'un simple comptage noierait au milieu des autres. D'ou le tri par anciennete.
NB_ARRETES=$(docker ps -aq --filter "status=exited" --filter "status=dead" 2>/dev/null | wc -l)
echo "  total arretes : $NB_ARRETES"
if [ "$NB_ARRETES" -eq 0 ]; then
  echo "  ✅ aucun conteneur arrete"
else
  printf "  %-28s %-6s %-8s %s\n" "NOM" "SORTIE" "DEPUIS" "LECTURE"
  MAINTENANT=$(date +%s)
  for c in $(docker ps -aq --filter "status=exited" --filter "status=dead" 2>/dev/null); do
    docker inspect --format '{{.Name}}|{{.State.ExitCode}}|{{.State.FinishedAt}}' "$c" 2>/dev/null
  done | sed 's|^/||' | while IFS='|' read -r nom code fin; do
    fin_s=$(date -d "$fin" +%s 2>/dev/null || echo "$MAINTENANT")
    jours=$(( (MAINTENANT - fin_s) / 86400 ))
    # Le code de sortie porte l'information : 137 = tue (SIGKILL, souvent la memoire),
    # 255 = l'application a echoue au demarrage, 0 = arret propre et volontaire.
    case "$code" in
      0)   sens="arret propre" ;;
      137) sens="⚠️ TUE (SIGKILL — memoire ?)" ;;
      255) sens="⚠️ ERREUR au demarrage" ;;
      *)   sens="⚠️ code $code" ;;
    esac
    if [ "$jours" -le 2 ]; then urgence="🔴 RECENT — a investiguer"
    elif [ "$jours" -le 7 ]; then urgence="🟠 cette semaine"
    elif [ "$jours" -ge 30 ]; then urgence="menage (>30 j)"
    else urgence="" ; fi
    printf "  %-28s %-6s %-8s %s %s\n" "$nom" "$code" "${jours}j" "$sens" "$urgence"
  done
  echo
  echo "  → arretes depuis > 30 j (candidats au nettoyage) : $(docker ps -aq --filter 'status=exited' --filter 'until=720h' 2>/dev/null | wc -l)"
  echo "  → arretes depuis < 2 j  (PANNES probables)       : $(docker ps -aq --filter 'status=exited' --filter 'since=48h' 2>/dev/null | wc -l)"
fi
sub "Conteneurs actifs : sante, redemarrages, limites"
# `{{if .State.Health}}` : sans ce garde, un conteneur sans healthcheck fait echouer TOUTE
# la boucle (« map has no entry for key Health ») et on perd la liste entiere.
for c in $(docker ps -q 2>/dev/null); do
  docker inspect --format '  {{.Name}} | redem={{.RestartCount}} | sante={{if .State.Health}}{{.State.Health.Status}}{{else}}aucun{{end}} | memlimit={{.HostConfig.Memory}} | cpus={{.HostConfig.NanoCpus}}' "$c" 2>/dev/null
done
sub "Consommation live"
docker stats --no-stream --format '  {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}' 2>/dev/null | sort -t$'\t' -k3 -h -r | head -15
sub "Images (les plus lourdes)"
docker images --format '  {{.Size}}\t{{.Repository}}:{{.Tag}}\t{{.CreatedSince}}' 2>/dev/null | sort -rh | head -12
sub "Volumes orphelins (aucun conteneur ne les monte)"
# ⚠️ « orphelin » ne veut PAS dire « jetable » : un volume Postgres detache reste une base.
# Toujours afficher la TAILLE pour qu'un humain juge avant de supprimer.
for v in $(docker volume ls -qf dangling=true 2>/dev/null); do
  printf '  %s\t%s\n' "$(timeout 20 $LOW du -sh "/var/lib/docker/volumes/$v" 2>/dev/null | cut -f1)" "$v"
done
sub "Reseaux orphelins"
for n in $(docker network ls --format '{{.Name}}' 2>/dev/null | grep -vE "^(bridge|host|none)$"); do
  [ "$(docker network inspect "$n" --format '{{len .Containers}}' 2>/dev/null)" = "0" ] && echo "  $n"
done
sub "Rotation des journaux de conteneur"
cat /etc/docker/daemon.json 2>/dev/null || echo "  !! aucun daemon.json → journaux NON bornes"
find /var/lib/docker/containers -name "*-json.log" -printf "%s\n" 2>/dev/null \
  | awk '{t+=$1} END {printf "  total journaux : %.1f Mo\n", t/1048576}'

# ─────────────────────────────────────────────────────────────────────────────────────────────
section "5. DONNEES (PostgreSQL)"
# ─────────────────────────────────────────────────────────────────────────────────────────────
# Les identifiants se LISENT dans l'env du conteneur. Les deviner (`-U postgres`) renvoie une
# sortie VIDE que l'on prendrait pour « rien a signaler » — le pire des faux negatifs.
for pg in $(docker ps --format '{{.Names}}' 2>/dev/null | grep -E "postgres|postgis"); do
  U=$(docker exec "$pg" printenv POSTGRES_USER 2>/dev/null)
  D=$(docker exec "$pg" printenv POSTGRES_DB   2>/dev/null)
  [ -z "$U" ] && continue
  sub "$pg (base $D)"
  docker exec "$pg" psql -U "$U" -d "$D" -t -c \
    "SELECT '  taille = '||pg_size_pretty(pg_database_size('$D'));" 2>/dev/null
  docker exec "$pg" psql -U "$U" -d "$D" -t -c \
    "SELECT '  cache = '||round(100.0*sum(blks_hit)/nullif(sum(blks_hit)+sum(blks_read),0),2)||' %' FROM pg_stat_database;" 2>/dev/null
  docker exec "$pg" psql -U "$U" -d "$D" -t -c \
    "SELECT '  connexions = '||count(*)||' / '||current_setting('max_connections') FROM pg_stat_activity;" 2>/dev/null
  docker exec "$pg" psql -U "$U" -d "$D" -c \
    "SELECT c.relname AS table, pg_size_pretty(pg_total_relation_size(c.oid)) total,
            s.n_live_tup vivantes, s.n_dead_tup mortes
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     LEFT JOIN pg_stat_user_tables s ON s.relid=c.oid
     WHERE n.nspname='public' AND c.relkind='r'
     ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 8;" 2>/dev/null
  docker exec "$pg" psql -U "$U" -d "$D" -t -c \
    "SELECT '  reglage '||name||' = '||setting||coalesce(unit,'') FROM pg_settings
     WHERE name IN ('shared_buffers','work_mem','effective_cache_size','random_page_cost');" 2>/dev/null
done
sub "Redis"
for r in $(docker ps --format '{{.Names}}' 2>/dev/null | grep redis); do
  # maxmemory=0 + noeviction = rien ne borne Redis ; il grandira jusqu'a ce que la machine cede.
  printf '  %s : %s\n' "$r" "$(docker exec "$r" redis-cli INFO memory 2>/dev/null | grep -E "used_memory_human|maxmemory_human" | tr -d '\r' | paste -sd' ')"
  printf '    politique=%s  cles=%s\n' \
    "$(docker exec "$r" redis-cli CONFIG GET maxmemory-policy 2>/dev/null | tail -1 | tr -d '\r')" \
    "$(docker exec "$r" redis-cli DBSIZE 2>/dev/null | tr -d '\r')"
done

# ─────────────────────────────────────────────────────────────────────────────────────────────
section "6. SECURITE"
# ─────────────────────────────────────────────────────────────────────────────────────────────
sub "Ports en ecoute"
ss -tulpn 2>/dev/null | grep -E "LISTEN|UNCONN" | awk '{print "  "$1, $5, $7}' | sed 's/users:((//' | sort -u
sub "Pare-feu"
ufw status verbose 2>/dev/null | head -14 || echo "  ufw absent"
sub "SSH — durcissement"
# permitrootlogin=yes ET passwordauthentication=yes = root attaquable au dictionnaire.
sshd -T 2>/dev/null | grep -Ei "^port |permitrootlogin|passwordauthentication|pubkeyauthentication|maxauthtries|permitemptypasswords"
sub "Comptes protegés par mot de passe (donc utilisables en SSH si l'auth mot de passe est ouverte)"
awk -F: '$2 !~ /^[!*]/ {print "  "$1}' /etc/shadow 2>/dev/null
sub "Tentatives d'intrusion"
# ⚠️ PIEGE PAYE LE 2026-08-04 : compter les IP sur `from <IP>` melange les ECHECS et les
# connexions REUSSIES. La premiere passe avait ainsi designe l'IP d'administration legitime
# (485 connexions acceptees, 0 echec) comme « principale attaquante ». On filtre donc les
# lignes d'ECHEC d'abord, et on affiche les succes separement pour pouvoir les reconnaitre.
for L in /var/log/auth.log /var/log/secure; do
  [ -f "$L" ] || continue
  printf '  fenetre du journal : %s → %s\n' \
    "$(head -1 "$L" 2>/dev/null | cut -c1-16)" "$(tail -1 "$L" 2>/dev/null | cut -c1-16)"
  printf '  echecs dans %s : %s\n' "$L" "$(grep -c "Failed password\|Invalid user" "$L" 2>/dev/null)"
  printf '  dont sur le compte root : %s\n' "$(grep -c "Failed password for root" "$L" 2>/dev/null)"
  echo "  top IP en ECHEC :"
  grep "Failed password\|Invalid user" "$L" 2>/dev/null \
    | grep -oE "([0-9]{1,3}\.){3}[0-9]{1,3}" | sort | uniq -c | sort -rn | head -5 | sed 's/^/    /'
  echo "  comptes vises :"
  grep -oE "Invalid user [a-zA-Z0-9_-]+" "$L" 2>/dev/null | sort | uniq -c | sort -rn | head -5 | sed 's/^/    /'
  echo "  IP dont des connexions ont REUSSI (a reconnaitre : ce sont vos acces) :"
  grep "Accepted" "$L" 2>/dev/null \
    | grep -oE "([0-9]{1,3}\.){3}[0-9]{1,3}" | sort | uniq -c | sort -rn | head -5 | sed 's/^/    /'
done
have fail2ban-client && fail2ban-client status 2>/dev/null || echo "  !! fail2ban NON installe — rien ne ralentit une attaque au dictionnaire"
sub "Mises a jour"
apt list --upgradable 2>/dev/null | grep -c upgradable | xargs echo "  paquets en retard :"
apt list --upgradable 2>/dev/null | grep -icE "security" | xargs echo "  dont securite :"
[ -f /var/run/reboot-required ] && { echo "  !! REDEMARRAGE REQUIS :"; cat /var/run/reboot-required.pkgs 2>/dev/null | sed 's/^/    /'; } || echo "  redemarrage requis : non"
sub "Certificats TLS des domaines publics"
# Depuis la machine elle-meme, une boucle vers son IP publique peut echouer sans que le
# certificat soit en cause : un « injoignable » ici se REVERIFIE depuis l'exterieur.
for d in ${AUDIT_DOMAINS:-tracky.vizyoagency.com}; do
  exp=$(echo | timeout 8 openssl s_client -servername "$d" -connect "$d:443" 2>/dev/null \
        | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  printf '  %-40s %s\n' "$d" "${exp:-injoignable depuis la machine (a reverifier de l exterieur)}"
done

# ─────────────────────────────────────────────────────────────────────────────────────────────
section "7. PLANIFICATION"
# ─────────────────────────────────────────────────────────────────────────────────────────────
sub "crontab root"
crontab -l 2>/dev/null | grep -vE "^#|^$" | sed 's/^/  /' || echo "  (vide)"
sub "cron.d"
for f in /etc/cron.d/*; do [ -f "$f" ] && { echo "  $f :"; grep -vE "^#|^$" "$f" | sed 's/^/    /'; }; done
sub "Timers systemd"
systemctl list-timers --no-pager 2>/dev/null | head -12 | sed 's/^/  /'
# Un meme script lance par cron ET par un timer s'execute DEUX FOIS (cf. VPS-006).
sub "Doublons cron/timer (meme script des deux cotes)"
for s in $(crontab -l 2>/dev/null | grep -oE "/[^ ]+\.sh"); do
  grep -rl "$s" /etc/systemd/system/*.service 2>/dev/null | sed "s|^|  DOUBLON: $s aussi lance par |"
done
sub "Services en echec"
systemctl --failed --no-pager 2>/dev/null | head -8 | sed 's/^/  /'

# ── La charge de fond que PERSONNE ne planifie ────────────────────────────────────────────
# Les crons et les timers se declarent ; les healthchecks, non. Ils sont pourtant la premiere
# source de creation de processus de la machine : chaque passage lance une chaine `runc exec`
# complete (runc -> PARENT -> CHILD -> INIT -> la commande), soit ~5 processus, et ceux qui
# interrogent une base ouvrent EN PLUS un backend PostgreSQL.
sub "Healthchecks : la charge de fond non planifiee"
for c in $(docker ps --format '{{.Names}}' 2>/dev/null); do
  docker inspect --format '{{if .Config.Healthcheck}}{{.Config.Healthcheck.Interval}}|{{$.Name}}{{end}}' "$c" 2>/dev/null
done | grep . | sed 's|/||' | sort | awk -F'|' '{iv[$1]++} END {for (i in iv) printf "  %3d conteneurs toutes les %s\n", iv[i], i}'
docker ps --format '{{.Names}}' 2>/dev/null | while read c; do
  docker inspect --format '{{if .Config.Healthcheck}}{{.Config.Healthcheck.Interval}}{{end}}' "$c" 2>/dev/null
done | grep . | awk '
  /^10s$/ {n+=6} /^30s$/ {n+=2} /^1m0s$/ {n+=1} /^5s$/ {n+=12}
  END {printf "  → %d invocations/min, soit ~%d/jour (chacune ~5 processus via runc)\n", n, n*1440}'

sub "Creations de processus par minute (mesure de 10 s)"
# Le compteur `processes` de /proc/stat est cumulatif depuis le demarrage : la difference sur
# une fenetre donne le taux reel, healthchecks compris. A l'arret, c'est eux qui dominent.
#
# ⚠️ FENETRE DE 10 s, PAS PLUS : a 20 s, la collecte complete depassait 90 s — le budget que
# cette meme procedure impose. Un audit qui viole sa propre regle pour mieux mesurer se trompe
# de priorite (defaut VPS-M05, corrige le 2026-08-04).
p1=$(awk '/^processes/{print $2}' /proc/stat); sleep 10
p2=$(awk '/^processes/{print $2}' /proc/stat)
awk -v d="$((p2-p1))" 'BEGIN {printf "  %d processus en 10 s = %d/min = ~%.1f millions/jour\n", d, d*6, d*6*1440/1000000}'

sub "Crons INTERNES aux conteneurs (verifier que crond ne tourne pas)"
# ⚠️ PIEGE : toute image Alpine embarque un /etc/crontabs/root avec des `run-parts
# /etc/periodic/*`. Il ressemble a une tache planifiee cachee, mais `crond` n'est PAS lance
# dans ces conteneurs et /etc/periodic est vide : c'est inerte. Ne pas le signaler comme un
# constat sans avoir verifie ces deux points (cf. VPS-M04).
for c in $(docker ps --format '{{.Names}}' 2>/dev/null | head -6); do
  # Une seule invocation `docker exec` : deux appels separes coutaient deux chaines runc, et
  # leurs sorties se melangeaient sur des lignes differentes (illisible).
  out=$(docker exec "$c" sh -c 'printf "%s/%s" "$(ps ax 2>/dev/null | grep -c "[c]rond")" "$(find /etc/periodic -type f 2>/dev/null | wc -l)"' 2>/dev/null)
  printf '  %-24s crond_actif/scripts = %s\n' "$c" "${out:-indisponible}"
done
echo "  (0/0 attendu partout : le crontab Alpine existe mais rien ne le lit)"

# ─────────────────────────────────────────────────────────────────────────────────────────────
section "8. JOURNAUX"
# ─────────────────────────────────────────────────────────────────────────────────────────────
journalctl --disk-usage 2>/dev/null | sed 's/^/  /'
timeout 20 $LOW du -sh /var/log/* 2>/dev/null | sort -rh | head -8

# ─────────────────────────────────────────────────────────────────────────────────────────────
section "9. HISTORIQUE 7 JOURS (sysstat)"
# ─────────────────────────────────────────────────────────────────────────────────────────────
# C'est LA section qui distingue un incident d'une habitude. Sans elle, un pic de charge
# constate a l'instant T se raconte comme une derive alors que c'est peut-etre un build.
if have sar; then
  printf '  %-8s %8s %8s %8s %8s %10s %10s\n' jour user% sys% iowait% steal% pic_charge pic_ram%
  for i in $(seq 7 -1 1); do
    f=/var/log/sysstat/sa$(date -d "-$i day" +%d 2>/dev/null)
    [ -f "$f" ] || continue
    d=$(date -d "-$i day" +%m-%d)
    cpu=$(sar -u -f "$f" 2>/dev/null | awk '/^Average:/ {printf "%8.2f %8.2f %8.2f %8.2f", $3,$5,$6,$7}')
    chg=$(sar -q -f "$f" 2>/dev/null | awk '$1!="Average:" && $4 ~ /^[0-9.]+$/ {if ($4+0>m) m=$4+0} END {printf "%10.2f", m}')
    ram=$(sar -r -f "$f" 2>/dev/null | awk '$1!="Average:" && $5 ~ /^[0-9.]+$/ {if ($5+0>m) m=$5+0} END {printf "%10.1f", m}')
    printf '  %-8s %s %s %s\n' "$d" "$cpu" "$chg" "$ram"
  done
  sub "Ecriture disque moyenne par jour (revele les journees de build)"
  for i in $(seq 7 -1 1); do
    f=/var/log/sysstat/sa$(date -d "-$i day" +%d 2>/dev/null)
    [ -f "$f" ] || continue
    sar -b -f "$f" 2>/dev/null | awk -v d="$(date -d "-$i day" +%m-%d)" \
      '/^Average:/ {printf "  %s : %.0f tps, ecriture %.0f blocs/s\n", d, $2, $6}'
  done
else
  echo "  !! sysstat absent — AUCUN historique. Sans lui, impossible de distinguer un pic"
  echo "     ponctuel d'une derive de fond.  Installer :  apt install sysstat"
fi

# ─────────────────────────────────────────────────────────────────────────────────────────────
section "10. PREVISIONS — ce que chaque nettoyage rendrait"
# ─────────────────────────────────────────────────────────────────────────────────────────────
# Le rapport doit pouvoir dire « il reste N jours avant saturation » et « telle commande rend
# X Go ». La TENDANCE ne se lit pas ici (sysstat ne suit pas le remplissage du disque) : elle se
# calcule en comparant les `chiffres` des passages precedents dans app/wiki.json. Cette section
# fournit l'instantane ; le rapport fait la soustraction.
TOTAL_KB=$(df -k / | awk 'NR==2{print $2}')
USED_KB=$(df -k / | awk 'NR==2{print $3}')
FREE_KB=$(df -k / | awk 'NR==2{print $4}')
awk -v t="$TOTAL_KB" -v u="$USED_KB" -v f="$FREE_KB" 'BEGIN {
  printf "  disque : %.0f Go utilises / %.0f Go (%.0f%%), %.0f Go libres\n", u/1048576, t/1048576, 100*u/t, f/1048576 }'

echo "  ── recuperable, par poste ──"
# ⚠️ On passe par `--format` et NON par le tableau texte : « Local Volumes » contient un
# espace, donc les colonnes se decalent d'un cran sur cette ligne-la et un `$NF` en awk
# ramenait « (100%) » au lieu de la taille (defaut VPS-M05, corrige le 2026-08-04).
docker system df --format '{{.Type}}|{{.Reclaimable}}' 2>/dev/null | while IFS='|' read -r type recl; do
  case "$type" in
    "Build Cache")   printf '  %-28s %s\n' "cache de build" "$recl" ;;
    "Images")        printf '  %-28s %s\n' "images non utilisees" "$recl" ;;
    "Containers")    printf '  %-28s %s\n' "conteneurs arretes" "$recl" ;;
    "Local Volumes") printf '  %-28s %s  (⚠️ contient des BASES : ne pas purger a l aveugle)\n' "volumes non montes" "$recl" ;;
  esac
done

# Les sauvegardes en double sont recuperables SANS perte : il en reste une par jour.
DUP=$(find /var/backups/vizyo-tracky -name "*.sql.gz" -printf "%f\n" 2>/dev/null \
      | sed -E 's/.*_([0-9]{8})-.*/\1/' | sort | uniq -c | awk '$1>1 {n+=$1-1} END {print n+0}')
if [ "${DUP:-0}" -gt 0 ]; then
  MOY=$(find /var/backups/vizyo-tracky -name "*.sql.gz" -printf "%s\n" 2>/dev/null | awk '{t+=$1;n++} END {if(n) print int(t/n)}')
  awk -v d="$DUP" -v m="${MOY:-0}" 'BEGIN {printf "  %-28s %.1f Go  (%d fichiers en trop)\n", "sauvegardes en double", d*m/1073741824, d}'
fi
printf '  %-28s %s\n' "journaux systemd" "$(journalctl --disk-usage 2>/dev/null | grep -oE '[0-9.]+[MG]' | head -1)"

# ─────────────────────────────────────────────────────────────────────────────────────────────
section "11. SAUVEGARDES — chaque application a-t-elle une copie RECENTE ?"
# ─────────────────────────────────────────────────────────────────────────────────────────────
# Une sauvegarde qui a cesse de tourner ne previent personne : le fichier de la veille est
# toujours la, le disque n'a pas bouge, rien ne clignote. On ne le decouvre qu'au moment de
# restaurer — c'est-a-dire trop tard. D'ou une section qui repond a UNE question par
# application : « quel age a la derniere copie ? ».
#
# ⚠️ Seuil a 30 h et pas 24 h : un decalage de quelques minutes (RandomizedDelaySec) ne doit
# pas faire crier une sauvegarde parfaitement saine. Au-dela de 30 h, une nuit a bien ete
# manquee.
sub "Age de la derniere sauvegarde, par application"
MAINTENANT=$(date +%s)
for d in /var/backups/*/; do
  app=$(basename "$d")
  case "$app" in vizyo-*|tracky-*|maestroo-*|maalem-*) ;; *) continue ;; esac
  dernier=$(find "$d" -maxdepth 1 -type f \( -name '*.gz' -o -name '*.gpg' \) -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1)
  if [ -z "$dernier" ]; then
    printf '  %-22s AUCUNE SAUVEGARDE\n' "$app"
    continue
  fi
  ts=${dernier%% *}; fic=${dernier#* }
  age_h=$(( (MAINTENANT - ${ts%.*}) / 3600 ))
  nb=$(find "$d" -maxdepth 1 -type f \( -name '*.gz' -o -name '*.gpg' \) 2>/dev/null | wc -l)
  taille=$(du -sh "$d" 2>/dev/null | cut -f1)
  if [ "$age_h" -gt 30 ]; then verdict="⚠️ PERIMEE (> 30 h)"; else verdict="a jour"; fi
  printf '  %-22s %3s h  %-20s %2d copies, %s  %s\n' "$app" "$age_h" "$verdict" "$nb" "$taille" "$(basename "$fic")"
done

# Un `pg_dump` qui rend 0 peut avoir ecrit une archive tronquee (pipe coupe, disque plein en
# fin d'ecriture). Les scripts qui RELISENT leur archive apres coup le declarent ici : c'est la
# difference entre « la commande n'a pas proteste » et « la copie est lisible ».
sub "Etat declare par les scripts (ceux qui relisent leur archive)"
for f in /var/backups/*/DERNIER-ETAT.json; do
  [ -f "$f" ] || continue
  # Lecture sans jq : il n'est pas garanti present, et l'installer pour une section d'audit
  # serait ajouter une dependance a un script qui doit rester posable partout.
  val() { grep -o "\"$1\": *\"[^\"]*\"" "$f" | head -1 | sed 's/.*: *"//; s/"$//'; }
  printf '  %-22s %-8s %s  (%s)\n' \
    "$(val application)" "$(val statut)" "$(val horodatage)" "$(val detail)"
done
[ -n "$(ls /var/backups/*/DERNIER-ETAT.json 2>/dev/null)" ] || \
  echo "  (aucune : seul Vizyo Verify publie un etat relu pour l'instant)"

# Une sauvegarde de pieces d'identite en clair sur le disque annulerait les protections de
# l'application qui les a produites (URL signees 120 s, session, journalisation). On verifie
# donc que ce qui doit etre chiffre l'est — `file` reconnait l'en-tete GPG.
sub "Donnees sensibles : les archives sont-elles chiffrees ?"
if [ -d /var/backups/vizyo-verify ]; then
  clair=$(find /var/backups/vizyo-verify -maxdepth 1 -name '*.gz' ! -name '*.gpg' 2>/dev/null | wc -l)
  chiffre=$(find /var/backups/vizyo-verify -maxdepth 1 -name '*.gpg' 2>/dev/null | wc -l)
  printf '  vizyo-verify : %d chiffrees, %d EN CLAIR%s\n' "$chiffre" "$clair" \
    "$([ "$clair" -gt 0 ] && echo '  ⚠️ des pieces d identite lisibles par quiconque lit le disque')"
  printf '  droits du dossier : %s (700 attendu)\n' "$(stat -c%a /var/backups/vizyo-verify)"
fi

# Le point le plus expose, et il ne se corrige pas par du code : tout est sur le meme disque
# que les donnees. Un incident chez l'hebergeur emporte les deux ensemble.
sub "Copie hors-site"
if have rclone && rclone listremotes 2>/dev/null | grep -q .; then
  rclone listremotes 2>/dev/null | sed 's/^/  remote configure : /'
else
  echo "  AUCUNE — toutes les sauvegardes sont sur le disque qu'elles protegent."
fi

# ─────────────────────────────────────────────────────────────────────────────────────────────
section "11. LEVIERS D'OPTIMISATION — etat de chacun, verdict automatique"
# ─────────────────────────────────────────────────────────────────────────────────────────────
# Cette section repond a UNE question : « que reste-t-il a gagner, et est-ce que ca en vaut la
# peine ? » Chaque levier affiche sa valeur ACTUELLE, la valeur VISEE, et un verdict.
#
# ⚠️ Un levier « deja bon » doit s'afficher quand meme, en vert. Sinon on ne peut pas voir
# qu'un reglage a REGRESSE — et ils regressent : cloud-init reecrit des fichiers, un
# redeploiement recree un conteneur sans ses limites, un `ALTER SYSTEM` saute a la restauration.

verdict() { # $1=libelle $2=actuel $3=vise $4=ok|ko $5=commentaire
  case "$4" in
    ok) printf '  ✅ %-30s %-16s %s\n' "$1" "$2" "$5" ;;
    *)  printf '  ⚠️  %-30s %-16s → viser %s : %s\n' "$1" "$2" "$3" "$5" ;;
  esac
}

sub "Levier 1 — cache de build Docker (le poste qui REVIENT)"
BC=$(docker system df --format '{{.Type}}|{{.Size}}' 2>/dev/null | awk -F'|' '/Build Cache/{print $2}')
BC_GO=$(docker system df --format '{{.Type}}|{{.Size}}' 2>/dev/null | awk -F'|' '/Build Cache/{gsub(/GB|MB/,"",$2); if ($2 ~ /^[0-9.]+$/) print int($2)}')
# ⚠️ Ce n'est PAS un defaut a corriger une fois : il se reconstitue a CHAQUE build (mesure :
# +14 Go en 4 h pour 3 deploiements). Le seuil se juge donc a l'espace libre, pas au cache seul.
# Seuil a 10 Go et non 15 : mesure du 2026-08-04, le cache remonte de 0 a 14 Go en 4 h pour
# 3 deploiements. A 15 on alerterait quand le disque est deja le sujet ; a 10 on a le temps.
if [ "${BC_GO:-0}" -ge 10 ]; then
  verdict "cache de build" "$BC" "< 10 Go" ko "docker buildx prune -af --filter until=168h"
else
  verdict "cache de build" "$BC" "< 10 Go" ok "sous le seuil"
fi
# ⚠️ Chercher un CRON de purge serait chercher la mauvaise garde. La borne est posee dans
# `/etc/docker/daemon.json` (ramasse-miettes de BuildKit) : un mecanisme PERMANENT, donc sans
# risque de doublon — contrairement a une tache planifiee (defaut VPS-003).
GCR=$(docker buildx inspect default 2>/dev/null | grep -c "Reserved Space")
if [ "${GCR:-0}" -gt 0 ]; then
  echo "     borne permanente : ✅ ramasse-miettes actif — $(docker buildx inspect default 2>/dev/null | grep 'Reserved Space' | tr -s ' ' | paste -sd' / ')"
else
  echo "     borne permanente : ❌ AUCUNE — ni ramasse-miettes dans daemon.json, ni purge planifiee"
fi

sub "Levier 2 — reglages memoire du noyau"
SW=$(sysctl -n vm.swappiness 2>/dev/null)
# 60 = defaut « bureau » : il swappe par anticipation. Sur un serveur qui a de la RAM libre,
# 10 suffit — on ne swappe qu'en vraie tension, et les processus restent en memoire.
[ "${SW:-60}" -le 20 ] && verdict "vm.swappiness" "$SW" "10" ok "serveur" \
  || verdict "vm.swappiness" "$SW" "10" ko "60 = defaut bureau, swappe sans necessite"
SWU=$(free -m | awk 'NR==3{print $3}')
[ "${SWU:-0}" -le 200 ] && verdict "swap utilise" "${SWU} Mo" "< 200 Mo" ok "" \
  || verdict "swap utilise" "${SWU} Mo" "< 200 Mo" ko "residu d'un pic ancien ; un redemarrage le rend"

sub "Levier 3 — limites des conteneurs (confinement des pannes)"
SANS=0; TOT=0
for c in $(docker ps -q 2>/dev/null); do
  TOT=$((TOT+1))
  [ "$(docker inspect --format '{{.HostConfig.Memory}}' "$c" 2>/dev/null)" = "0" ] && SANS=$((SANS+1))
done
[ "$SANS" -eq 0 ] && verdict "conteneurs sans limite" "0 / $TOT" "0" ok "" \
  || verdict "conteneurs sans limite" "$SANS / $TOT" "0" ko "une fuite peut emporter un voisin (VPS-005)"

sub "Levier 4 — reglages PostgreSQL"
# ⚠️ UN SEUL `docker exec` par conteneur : chacun coute une chaine `runc` complete. La
# premiere version en faisait trois, et portait la collecte a 91 s — au-dessus du budget
# de 90 s que cette procedure impose (meme defaut que VPS-M05, deuxieme recidive).
for pg in $(docker ps --format '{{.Names}}' 2>/dev/null | grep -E "postgres|postgis" | head -3); do
  RPC=$(docker exec "$pg" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SHOW random_page_cost;"' 2>/dev/null | tr -d '
')
  [ -z "$RPC" ] && continue
  # 4 = valeur pour disque MECANIQUE. Sur SSD, le planificateur surestime le cout des acces
  # aleatoires et prefere des parcours de table la ou un index serait plus rapide.
  case "$RPC" in
    1.1|1|1.0|1.2) verdict "$pg random_page_cost" "$RPC" "1.1" ok "adapte au SSD" ;;
    *)             verdict "$pg random_page_cost" "$RPC" "1.1" ko "valeur pour disque a plateaux" ;;
  esac
done

sub "Levier 5 — Redis borne ?"
for r in $(docker ps --format '{{.Names}}' 2>/dev/null | grep redis); do
  MM=$(docker exec "$r" redis-cli CONFIG GET maxmemory 2>/dev/null | tail -1 | tr -d '\r')
  PO=$(docker exec "$r" redis-cli CONFIG GET maxmemory-policy 2>/dev/null | tail -1 | tr -d '\r')
  # maxmemory=0 + noeviction = « grandis sans limite, puis refuse les ecritures ». Sur une
  # machine partagee, c'est le conteneur qui decide quand tout le monde s'arrete.
  [ "$MM" = "0" ] && verdict "$r maxmemory" "aucune ($PO)" "256mb + allkeys-lru" ko "grandit sans borne" \
    || verdict "$r maxmemory" "$MM ($PO)" "borne" ok ""
done

sub "Levier 6 — journaux systeme"
JD=$(journalctl --disk-usage 2>/dev/null | grep -oE '[0-9.]+[MG]' | head -1)
verdict "journald" "${JD:-?}" "< 500M" ok "plafond SystemMaxUse=$(grep -oP '^SystemMaxUse=\K.*' /etc/systemd/journald.conf 2>/dev/null || echo 'non defini')"

sub "Levier 7 — noyau a jour ?"
KR=$(uname -r); KI=$(ls -1 /boot/vmlinuz-* 2>/dev/null | sed 's|.*vmlinuz-||' | sort -V | tail -1)
[ "$KR" = "$KI" ] && verdict "noyau actif" "$KR" "$KI" ok "a jour" \
  || verdict "noyau actif" "$KR" "$KI" ko "REDEMARRAGE requis — rend aussi la RAM de dockerd"
DUP=$(ps -o rss= -p "$(pgrep -o dockerd)" 2>/dev/null | awk '{printf "%d", $1/1024}')
[ "${DUP:-0}" -le 400 ] && verdict "memoire de dockerd" "${DUP} Mo" "< 400 Mo" ok "" \
  || verdict "memoire de dockerd" "${DUP} Mo" "< 400 Mo" ko "gonfle avec l'uptime ; un redemarrage le remet a ~150 Mo"

printf '\n\nFIN DE COLLECTE — %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
