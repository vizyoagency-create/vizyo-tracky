#!/bin/bash
# ═══ docker-clients-orphelins — le garde-fou de VPS-016 (posé le 2026-09-20, règle V34) ════════════
#
# POURQUOI : sur cet hôte, un client `docker logs` / `stats` / `events` / `attach` lancé depuis une
# session (SSH, agent, script `bash -c`) qui se ferme avant lui NE REND JAMAIS LA MAIN et fait
# tourner `dockerd` à 100 % d'un cœur pendant des jours. Sept occurrences sur sept du 05/08 au
# 19/09 (docs/vps-audit/REFERENCE-CONSTATS.md, VPS-016). La 7ᵉ a coûté 80–90 % du CPU de la VM,
# retirés par l'hébergeur (VPS-045). La règle « timeout devant chaque docker » est écrite partout
# et a été oubliée sept fois : il fallait un MÉCANISME.
#
# QUOI : toutes les 5 min (timer systemd), tuer tout client docker qui remplit LES TROIS conditions :
#   1. sous-commande qui COULE sans fin : logs | stats | events | attach   (jamais exec, compose,
#      build, pull, system df… — un pg_dump de 64 min via docker exec est légitime) ;
#   2. SANS terminal (tty = ?) : un humain qui lit ses logs dans un terminal n'est pas touché ;
#   3. plus vieux que AGE_MAX secondes (600 = 10 min : aucun `docker logs --tail` légitime ne dure ça).
# Le PARENT d'abord si c'est un shell sans terminal qui porte encore du `docker` dans sa ligne de
# commande (`bash -c "echo … ; docker logs … ; docker logs …"`) : tuer le client seul ferait passer
# le shell au `docker logs` suivant (leçon du 2026-08-20, VPS-M51). SIGTERM, puis SIGKILL 5 s après.
#
# CE QUE ÇA NE FAIT PAS : aucun `systemctl restart docker`, aucun conteneur touché, aucun kill -9
# d'emblée. `timeout` tue le client ; la requête côté dockerd s'éteint seule (vérifié 4 fois).
#
# TRACE : journald (`journalctl -t docker-orphelins`) + /run/docker-orphelins/dernier (le
# collecteur d'audit lit les deux : un garde-fou doit prouver qu'il tourne, VPS-M06).
#
# USAGE : docker-clients-orphelins.sh [--simuler] [--age N]     (par défaut --age 600)
set -u
AGE_MAX=600; SIMULER=0
while [ $# -gt 0 ]; do
  case "$1" in
    --simuler) SIMULER=1 ;;
    --age) AGE_MAX="$2"; shift ;;
    *) echo "usage: $0 [--simuler] [--age N]" >&2; exit 2 ;;
  esac
  shift
done
ETAT_DIR=/run/docker-orphelins; mkdir -p "$ETAT_DIR"
MOTIF='^(/[^ ]*/)?docker (logs|stats|events|attach)( |$)'
now=$(date -u '+%Y-%m-%dT%H:%M:%SZ'); tues=0; vus=0

# Un seul ps pour tout le monde : pid, ppid, âge, tty, ligne de commande.
while read -r pid ppid age tty args; do
  [ -n "${args:-}" ] || continue
  [[ "$args" =~ $MOTIF ]] || continue
  vus=$((vus+1))
  [ "$tty" = "?" ] || continue                       # a un terminal : un humain regarde, on ne touche pas
  [ "$age" -ge "$AGE_MAX" ] || continue              # trop jeune : peut-être légitime, on repasse dans 5 min
  # Le parent : un shell sans terminal qui porte encore du docker dans sa ligne de commande ?
  pcomm=$(ps -o comm= -p "$ppid" 2>/dev/null); ptty=$(ps -o tty= -p "$ppid" 2>/dev/null); pargs=$(ps -o args= -p "$ppid" 2>/dev/null)
  cible_parent=""
  if [ "$ppid" -gt 1 ] && [[ "$pcomm" =~ ^(bash|sh|dash|zsh)$ ]] && [ "$ptty" = "?" ] && [[ "$pargs" == *docker* ]]; then
    cible_parent=$ppid
  fi
  msg="client docker orphelin : pid=$pid age=${age}s ppid=$ppid parent=[${pcomm:-mort}] cmd=[${args:0:160}]"
  if [ "$SIMULER" = 1 ]; then
    echo "SIMULATION — tuerait ${cible_parent:+le parent $cible_parent puis }le client $pid — $msg"
    continue
  fi
  # Le parent d'abord (s'il est une cible), puis le client ; SIGTERM, puis SIGKILL 5 s après.
  for p in $cible_parent $pid; do kill -TERM "$p" 2>/dev/null; done
  sleep 5
  for p in $cible_parent $pid; do kill -0 "$p" 2>/dev/null && kill -KILL "$p" 2>/dev/null; done
  tues=$((tues+1))
  logger -t docker-orphelins -p daemon.warning "TUÉ — $msg${cible_parent:+ (parent $cible_parent tué d abord)}"
  echo "TUÉ — $msg"
done < <(ps -eo pid=,ppid=,etimes=,tty=,args= 2>/dev/null)

printf 'dernier=%s clients_docker_streaming_vus=%s tues=%s age_max=%s\n' "$now" "$vus" "$tues" "$AGE_MAX" > "$ETAT_DIR/dernier"
[ "$tues" -gt 0 ] && logger -t docker-orphelins -p daemon.notice "passage $now : $tues client(s) tué(s) sur $vus vu(s)"
exit 0
