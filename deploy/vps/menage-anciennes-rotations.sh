#!/bin/bash
# ═══ Ménage des anciennes rotations de journaux de conteneur (V29 bis, décidé le 2026-09-20) ═════
#
# POURQUOI : jusqu'au 20/09/2026, une stanza logrotate hôte (`/etc/logrotate.d/docker-containers`,
# rotate 14, copytruncate) doublait le rotateur json-file de Docker (VPS-041). Elle a été retirée
# (V29) ; ses rotations (`*-json.log.4` … `.log.14`, 316 fichiers, 434 Mo le 20/09) ne seront plus
# jamais effacées par personne : Docker ne gère que les index < max-file (3 par défaut, 14 pour
# tracky-postgres). Et la copie de secours des journaux de l'ancien tracky-postgres
# (`/root/journaux-tracky-postgres-avant-v29-2026-09-20/`, 75 Mo, mémoire TRK-035) n'a de sens que
# 14 jours.
#
# QUOI : supprimer (1) tout `*-json.log.<N>` de /var/lib/docker/containers plus vieux que 14 jours
# (mtime) — c'est exactement la rétention que la stanza promettait —, (2) le dossier de secours
# une fois ses fichiers plus vieux que 14 jours. JAMAIS un journal COURANT (`*-json.log` sans index :
# dockerd le tient ouvert), JAMAIS un fichier de moins de 14 jours.
#
# USAGE :  menage-anciennes-rotations.sh            → SIMULATION (liste et totaux, rien n'est supprimé)
#          menage-anciennes-rotations.sh --executer → supprime, et dit ce qu'il a supprimé
#          menage-anciennes-rotations.sh --age 21   → autre âge minimal (jours)
set -uo pipefail
EXECUTER=0; AGE=14
while [ $# -gt 0 ]; do case "$1" in --executer) EXECUTER=1 ;; --age) AGE="$2"; shift ;; *) echo "usage: $0 [--executer] [--age N]" >&2; exit 2 ;; esac; shift; done
SECOURS=/root/journaux-tracky-postgres-avant-v29-2026-09-20
mode=SIMULATION; [ "$EXECUTER" = 1 ] && mode=EXECUTION
echo "== $(date -u '+%F %T') UTC — $mode — âge minimal $AGE jours"
echo "   disque avant : $(df -h / | awk 'NR==2{print $3" / "$2" ("$5")"}')"

echo "── 1. rotations *-json.log.<N> de plus de $AGE jours (jamais le journal courant) ──"
liste=$(find /var/lib/docker/containers -maxdepth 2 -type f -name '*-json.log.[0-9]*' -mtime +"$AGE" -printf '%s\t%TY-%Tm-%Td\t%p\n' 2>/dev/null | sort -k2)
n=$(printf '%s\n' "$liste" | grep -c . || true)
mo=$(printf '%s\n' "$liste" | awk -F'\t' '{s+=$1} END {printf "%.1f", s/1048576}')
echo "   $n fichier(s), $mo Mo"
printf '%s\n' "$liste" | awk -F'\t' '{d=$3; sub(/\/[^\/]*$/,"",d); sub(/.*\//,"",d); c[substr(d,1,12)]+=$1; k[substr(d,1,12)]++} END {for (i in c) printf "     %s  %3d fichiers  %7.1f Mo\n", i, k[i], c[i]/1048576}' | sort -k4 -rn | head -20
echo "   (journaux courants NON touchés : $(find /var/lib/docker/containers -maxdepth 2 -type f -name '*-json.log' | wc -l) fichiers)"
if [ "$EXECUTER" = 1 ] && [ "$n" -gt 0 ]; then
  printf '%s\n' "$liste" | cut -f3 | xargs -r rm -f --
  echo "   ✅ supprimés : $n fichier(s), $mo Mo"
fi

echo "── 2. copie de secours $SECOURS ──"
if [ -d "$SECOURS" ]; then
  recents=$(find "$SECOURS" -type f -mtime -"$AGE" | wc -l)
  echo "   $(ls "$SECOURS" | wc -l) fichiers, $(du -sh "$SECOURS" | cut -f1) ; plus récents que $AGE jours : $recents"
  if [ "$recents" -gt 0 ]; then
    echo "   ⏳ conservée : $recents fichier(s) ont moins de $AGE jours"
  elif [ "$EXECUTER" = 1 ]; then
    rm -rf -- "$SECOURS" && echo "   ✅ dossier supprimé"
  else
    echo "   → serait supprimé"
  fi
else
  echo "   (déjà absente)"
fi
echo "   disque après : $(df -h / | awk 'NR==2{print $3" / "$2" ("$5")"}')"
[ "$EXECUTER" = 1 ] || echo "== SIMULATION : rien n'a été supprimé. Relancer avec --executer pour le faire."
