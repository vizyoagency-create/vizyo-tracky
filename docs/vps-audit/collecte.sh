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
timeout 90 $LOW du -sh --exclude=/var/lib/docker /var/log /opt /root /home /usr /var/backups 2>/dev/null | sort -rh
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
sub "Doublons de sauvegarde (2 fichiers le meme jour = anomalie)"
find /var/backups/vizyo-tracky -name "*.sql.gz" -printf "%f\n" 2>/dev/null \
  | sed -E 's/.*_([0-9]{8})-.*/\1/' | sort | uniq -c | awk '$1>1 {printf "  %s : %d fichiers\n", $2, $1}' | head

# ─────────────────────────────────────────────────────────────────────────────────────────────
section "4. DOCKER"
# ─────────────────────────────────────────────────────────────────────────────────────────────
have docker || { echo "docker absent"; }
docker system df 2>/dev/null
sub "Conteneurs par etat"
docker ps -a --format '{{.State}}' 2>/dev/null | sort | uniq -c
sub "Conteneurs ARRETES (candidats au nettoyage)"
docker ps -a --filter "status=exited" --filter "status=dead" \
  --format '  {{.Names}}\t{{.Status}}\t{{.Image}}' 2>/dev/null
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

printf '\n\nFIN DE COLLECTE — %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
