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

# ⚠️ AJOUTE LE 2026-08-06. La collecte a mis 136 s ce jour-la (budget : 90 s) et RIEN dans la
# sortie ne disait ou le temps etait passe — il a fallu re-mesurer a la main, section par
# section. Un budget qu'on impose sans l'instrumenter ne se diagnostique pas : il se constate.
# Chaque en-tete de section porte donc desormais le temps ecoule depuis le debut.
T_DEBUT=$(date +%s)
section() { printf '\n\n═════ %s ═════   [t+%ss]\n' "$1" "$(( $(date +%s) - T_DEBUT ))"; }
sub()     { printf '\n── %s ──\n' "$1"; }
have()    { command -v "$1" >/dev/null 2>&1; }

# ⚠️ AJOUTE LE 2026-08-07 (VPS-M18). L'instrumentation par SECTION ci-dessus a designe la
# section 3 comme premier poste, mais elle ne dit pas QUELLE commande : il a fallu re-mesurer
# a la main une seconde fois. `ms` chronometre un appel isole, pour deux appels a `date`.
#
# ⚠️ ET LA LECON QUI VA AVEC, PLUS IMPORTANTE QUE L'OUTIL : un chrono lance juste apres une
# autre execution du MEME script mesure le cache d'inodes du noyau, pas le script. Le
# 2026-08-06, « 136 s → 65 s » a ete porte au credit d'une exclusion de repertoires ; la
# mesure A FROID du lendemain, script inchange, donne 127 s. Le gain reel valait ~9 s, tout
# le reste etait du cache chaud. Un chiffre de duree ne vaut donc QUE pris a froid,
# c'est-a-dire au PREMIER passage de la journee — et une seconde execution ne prouve rien.
ms() { echo $(( ( $(date +%s%N) - $1 ) / 1000000 )); }

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

# ⚠️⚠️ AJOUTE LE 2026-08-06 — L'ANGLE MORT QUI A CACHE UN INCIDENT DE 24 HEURES.
#
# Le collecteur savait tout dire des CONTENEURS (`docker stats`, section 4) et RIEN des
# processus de l'HOTE. Or `dockerd` n'est pas un conteneur : quand il s'est mis a bruler
# 100 % d'un coeur en continu le 2026-08-05, aucune section ne pouvait le montrer. La charge
# moyenne de la section 9 le diluait sur 24 h, `docker stats` ne le voyait pas, et les 31
# conteneurs restaient « healthy » — donc tout paraissait normal pendant que la machine
# perdait la moitie de sa puissance.
#
# ⚠️ PIEGE A NE PAS REINTRODUIRE : `ps -eo pcpu` ne donne PAS le CPU instantane, mais la
# MOYENNE DEPUIS LE DEMARRAGE du processus. Un demon lance il y a un mois et emballe depuis
# une heure y apparait a 2 %. On mesure donc un DELTA sur une fenetre courte, seule facon de
# distinguer « il a beaucoup travaille autrefois » de « il travaille MAINTENANT ».
# ⚠️⚠️ CORRIGE LE 2026-08-08 (VPS-M19) — CETTE SECTION NE MONTRAIT PAS QUE L'HOTE.
# Elle s'intitule « processus de l'HOTE » depuis sa creation (VPS-M14), et elle parcourt
# /proc/[0-9]*/stat — c'est-a-dire TOUS les processus visibles dans l'espace de noms PID de
# l'hote, CONTENEURS COMPRIS. Le 2026-08-08 elle a affiche « node (pid 1681) 4,0 % » : ce
# n'est pas un processus de l'hote, c'est le `node dist/main.js` de `tracky-api`, dont le
# parent est un `containerd-shim-runc-v2` (verifie : /proc/1681/cgroup pointe
# `docker-d4a088f6….scope`).
#
# Pourquoi ca compte : cette section existe precisement parce que `docker stats` ne voit QUE
# les conteneurs et avait manque 24 h d'emballement de `dockerd`. Une section qui melange les
# deux populations sans le dire rend le complement illisible dans les deux sens — un conteneur
# emballe se lit « probleme hote », et le vrai signal (un demon hors conteneur) se noie.
# Le cgroup tranche pour un `cat` par processus AFFICHE (8 au plus), pas par processus scanne.
sub "Processus les plus gourmands, HOTE et CONTENEURS distingues (mesure instantanee sur 3 s)"
HZ=$(getconf CLK_TCK)
# ⚠️ UN SEUL `awk` pour ~900 fichiers, pas un par fichier : la version naive forkait 1800 fois
# pour mesurer... le CPU. Un capteur qui perturbe ce qu'il mesure ne mesure plus rien (VPS-M05).
# ⚠️ Et `$14`/`$15` sont FAUX en positionnel : le champ `comm` de /proc/<pid>/stat est entre
# parentheses et peut contenir des espaces. On coupe donc jusqu'a la derniere parenthese
# avant de compter les champs (meme piege que le n° 6 en tete de ce fichier).
snap() { awk '{ p=$1; sub(/^[0-9]+ \(.*\) /, ""); print p, $12+$13 }' /proc/[0-9]*/stat 2>/dev/null; }
AVANT=$(snap); U0=$(awk '{print $1}' /proc/uptime)
sleep 3
APRES=$(snap); U1=$(awk '{print $1}' /proc/uptime)
printf '%s\n%s\n' "$AVANT" "$APRES" | awk -v hz="$HZ" -v dt="$(awk -v a="$U0" -v b="$U1" 'BEGIN{print b-a}')" '
  { if (seen[$1]++) { d=$2-t[$1]; if (d>0) pct[$1]=100*(d/hz)/dt } else t[$1]=$2 }
  END { for (p in pct) if (pct[p]>=2) printf "%.1f\t%s\n", pct[p], p }' \
  | sort -rn | head -8 | while IFS=$'\t' read -r pc pid; do
      # Origine du processus : `/proc/<pid>/cgroup` contient `docker-<id>.scope` pour un
      # processus de conteneur, rien de tel pour un processus de l'hote. C'est la seule
      # source qui ne ment pas : ni le nom (`node`), ni le PPID (un shim est un processus
      # de l'hote), ni `ps` ne distinguent les deux.
      CG=$(cat /proc/$pid/cgroup 2>/dev/null)
      case "$CG" in
        *docker-*) ORIG="[conteneur $(echo "$CG" | sed -n 's/.*docker-\(............\).*/\1/p')]" ;;
        *)         ORIG="[HOTE]" ;;
      esac
      printf '  %6.1f %% d un coeur  %-18s %-24s (pid %s, RSS %s Mo)\n' "$pc" \
        "$(cat /proc/$pid/comm 2>/dev/null || echo '?')" "$ORIG" "$pid" \
        "$(awk '/^VmRSS/{printf "%d", $2/1024}' /proc/$pid/status 2>/dev/null || echo '?')"
    done
echo "  (vide = aucun processus au-dessus de 2 % : c'est le cas normal)"
# ⚠️ Guillemets SIMPLES obligatoires ici : en guillemets doubles, les accents graves autour de
# `docker stats` seraient une SUBSTITUTION DE COMMANDE — le collecteur lancerait docker stats
# pour afficher une phrase. Piege attrape a l'ecriture le 2026-08-08.
echo '  ⚠️ [conteneur ...] = ce n est PAS l hote : docker stats le voit deja, section 4.'
echo '     Seul un [HOTE] gourmand est un angle mort de l outillage Docker (VPS-M14/M19).'
# Un demon qui a consomme presque autant d'heures CPU que la machine a d'heures d'uptime a
# tourne en boucle. C'est le controle qui repere un emballement ANCIEN, celui que la fenetre
# de 3 s ci-dessus ne peut pas dater.
#
# ⚠️⚠️ CORRIGE LE 2026-08-07 (VPS-M17) — CE COMPTEUR NE SAIT PAS OUBLIER.
# La boucle de `dockerd` (VPS-016) a cesse d'elle-meme le 2026-08-06 vers 13 h 00 UTC. Le
# lendemain, la machine est saine — charge 0,35, `dockerd` a 1,2 % d'un coeur — et ce controle
# affichait quand meme « 66,5 % 🔴 EMBALLEMENT », parce que 34 heures de boucle restent
# inscrites dans `utime+stime` JUSQU'AU REDEMARRAGE DU DEMON. Sur la meme sortie, la mesure
# instantanee disait « aucun processus au-dessus de 2 % : c'est le cas normal ».
#
# Deux detecteurs, deux verdicts opposes, aucun arbitrage : c'est le lecteur qui tranchait —
# donc personne. Un 🔴 qui reste allume des semaines apres la fin de l'incident apprend a
# sauter la ligne, exactement comme le seuil de VPS-M10. Les deux mesures sont desormais sur
# la MEME ligne, et c'est « maintenant » qui decide du verdict.
sub "Demons systeme : emballement EN COURS (3 s) contre SEQUELLE (cumul / uptime)"
UPS=$(awk '{print $1}' /proc/uptime)
DT=$(awk -v a="$U0" -v b="$U1" 'BEGIN{print b-a}')
for n in dockerd containerd systemd-journald snapd; do
  p=$(pgrep -o "$n" 2>/dev/null) || continue
  [ -z "$p" ] && continue
  # On reutilise les DEUX instantanes deja pris ci-dessus : aucune mesure supplementaire.
  INST=$(printf '%s\n%s\n' "$AVANT" "$APRES" | awk -v pid="$p" -v hz="$HZ" -v dt="$DT" '
    $1==pid { if (vu++) printf "%.1f", 100*(($2-t)/hz)/dt; else t=$2 }')
  [ -z "$INST" ] && INST=0
  awk -v hz="$HZ" -v up="$UPS" -v n="$n" -v inst="$INST" '{
    s=($14+$15)/hz; r=100*s/up      # s et up sont tous deux en SECONDES
    if (inst+0 > 50)   v="🔴 EMBALLEMENT EN COURS — il tourne en boucle MAINTENANT"
    else if (r > 50)   v="🟠 SEQUELLE — calme maintenant ; le cumul garde la trace d une boucle PASSEE"
    else               v=""
    printf "  %-16s maintenant %5.1f %%  |  cumul %5.1f h CPU / %5.1f h uptime = %5.1f %%  %s\n",
      n, inst, s/3600, up/3600, r, v
  }' /proc/$p/stat 2>/dev/null
  # Retenir le PREMIER demon en emballement EN COURS : c'est lui qu'on ausculte plus bas.
  # On ne retient PAS sur le cumul (🟠) : une sequelle n'a rien a ausculter, la boucle est finie.
  if [ -z "${EMB_PID:-}" ] && [ "$(awk -v i="$INST" 'BEGIN{print (i+0>50)?1:0}')" = "1" ]; then
    EMB_PID="$p"; EMB_NOM="$n"
  fi
done
echo "  ⚠️ Le cumul ne DIMINUE JAMAIS — il ne s efface qu au redemarrage du demon. Un 🟠 peut"
echo "     donc rester allume des semaines apres la fin de l incident : c est 'maintenant' qui tranche."

# ⚠️ AJOUTE LE 2026-08-10 — « IL CONSOMME » ET « IL TOURNE EN ROND » NE SONT PAS LA MEME CHOSE.
# Le 2026-08-10 a 02 h 21, `dockerd` etait a 168 % d'un coeur. Un build en cours produit
# exactement la meme ligne — et il y en avait eu trois la veille au soir. La seule mesure qui
# tranche est celle qui a servi a etablir VPS-016 : le nombre d'appels `read()` par seconde,
# CONFRONTE aux octets reellement lus du disque.
#   · travail reel  → les deux montent ensemble ;
#   · boucle d'attente → des millions de `read()` par seconde et `read_bytes` STRICTEMENT figé.
# Mesure du 2026-08-10 : 2 332 107 read()/s, read_bytes identique a l'octet pres. Le 2026-08-06,
# la meme mesure donnait 1 320 000/s — c'etait deja elle qui avait nomme la panne.
#
# Cout : DEUX lectures de /proc/<pid>/io, et UNIQUEMENT quand le verdict ci-dessus est deja
# 🔴/🟠. Sur une machine saine, cette section ne s'execute pas du tout.
if [ "${EMB_PID:-}" ]; then
  sub "Signature de boucle — des read() sans octets, c'est une attente, pas du travail (VPS-016)"
  IO0=$(awk '/^syscr:/{c=$2} /^read_bytes:/{b=$2} END{print c" "b}' /proc/$EMB_PID/io 2>/dev/null)
  sleep 4
  IO1=$(awk '/^syscr:/{c=$2} /^read_bytes:/{b=$2} END{print c" "b}' /proc/$EMB_PID/io 2>/dev/null)
  echo "$IO0 $IO1" | awk -v n="$EMB_NOM" '{
    dc=($3-$1)/4; db=($4-$2)/4
    printf "  %-14s %.0f read()/s   %.0f octets/s lus du disque\n", n, dc, db
    if (dc > 100000 && db == 0)
      print  "  🔴 BOUCLE D ATTENTE CONFIRMEE : des centaines de milliers d appels par seconde qui"
      print  "     ne ramenent AUCUN octet. Ce n est pas un build, c est un descripteur qui tourne."
    else if (dc > 100000)
      print  "  🟠 beaucoup d appels MAIS le disque repond : c est probablement du travail reel"
      print  "     (build, export d image). Ne pas conclure a la boucle."
    else
      print  "  ✅ pas de rafale d appels : le CPU va ailleurs (calcul, compression) — pas une boucle."
  }'
  echo "     ⚠️ Le vidage des goroutines (kill -USR1) trancherait la CAUSE — c est une ECRITURE,"
  echo "        donc hors de cet audit. Il n est possible que PENDANT la boucle : voir VPS-016."
fi

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
#
# ⚠️ AJOUTE LE 2026-08-06, MEME RAISONNEMENT — les caches d'outillage de dev de /root sont
# exclus. Mesure du 2026-08-06 :
#     /root/.local  2,6 Go  120 867 fichiers      /root/.npm    994 Mo  26 718 fichiers
#     /root/.cache  778 Mo    3 805 fichiers      /root/.claude 133 Mo   3 244 fichiers
# Soit ~155 000 inodes parcourus CHAQUE NUIT pour un chiffre qui ne bouge pas et qui n'a
# jamais explique un disque plein. C'etait le premier poste de cout de la collecte.
# Leur taille reste connue (ligne ci-dessous) ; c'est le PARCOURS qui est supprime, pas
# l'information. Si /root grossit anormalement, la ligne `/root` le montrera quand meme :
# seuls les quatre caches nommes sont retires.
# ⚠️ AJOUTE LE 2026-08-07 (VPS-M18) — chaque chemin est chronometre SEPAREMENT. L'instrumentation
# par section avait designe la section 3 ; il a quand meme fallu une seconde passe manuelle pour
# savoir lequel des cinq chemins coutait. Un parcours par chemin ne coute rien de plus (c'est le
# meme travail, decoupe) et rend la reponse immediate.
#
# ⚠️ Ces durees ne se comparent QUE d'un premier passage a un autre premier passage : a chaud,
# les memes commandes rendent ~2,6 s au lieu de ~52 s. Voir la note de `ms()` en tete de fichier.
# ⚠️⚠️ CORRIGE LE 2026-08-10 (VPS-M23) — CE DELAI VALAIT LE BUDGET DE L'AUDIT ENTIER.
# Le delai etait de 90 s, c'est-a-dire EXACTEMENT le budget total impose a la collecte. Une
# seule commande avait donc le droit de consommer tout le temps de tout le passage — et le
# 2026-08-10, `du /opt` l'a fait : abandonne apres 90 s, apres 26,3 s la veille sur les MEMES
# 5,4 Go. On a perdu la mesure ET depasse le budget, du meme geste.
# Un delai de garde doit etre une FRACTION du budget qu'il protege, jamais son egal : sinon il
# ne protege rien, il autorise. Ramene a 40 s — soit ~45 % du budget pour le poste le plus
# lourd, ce qui laisse la place aux onze autres sections.
# ⚠️ Le message d'abandon reste explicite (VPS-M02) : une mesure absente ne doit jamais se lire
# comme une mesure nulle. Il dit desormais aussi ce qu'il faut en conclure.
for chemin in /var/log /opt /root /home /var/backups; do
  T0=$(date +%s%N)
  out=$(timeout 40 $LOW du -sh --exclude=/var/lib/docker --exclude=/root/.local --exclude=/root/.npm \
        --exclude=/root/.cache --exclude=/root/.claude "$chemin" 2>/dev/null)
  printf '  %-28s %8s ms\n' "${out:-(ABANDONNEE apres 40 s — machine chargee, PAS un dossier vide)	$chemin}" "$(ms "$T0")"
done
echo "  (+ ~4,5 Go d outillage de dev exclus du parcours : /root/.local, .npm, .cache, .claude —"
echo "     mesures le 2026-08-06, ~155 000 inodes. Voir VPS-017 : ils n'ont rien a faire ici.)"
# ⚠️ /opt est le PREMIER POSTE de la collecte, et il faut le dire ici plutot que de le
# re-mesurer chaque nuit : 437 345 inodes au 2026-08-07 (maalem 134 140, vizyo-tracky 77 641,
# vizyo-leads 68 681, vizyo-manager 68 235, vizyo-auth 42 464, vizyo-texto 25 370). Ce sont des
# depots de code complets, node_modules compris. ~71 000 d'entre eux appartiennent a DEUX piles
# supprimees le 2026-08-04 (/opt/vizyo-leads, /opt/foodsqan — cf. VPS-006) : on parcourt donc
# chaque nuit du code qui ne tourne plus (VPS-018).
#
# Le compte n'est PAS recalcule a chaque passage, volontairement : `find /opt | wc -l` refait
# exactement le parcours que `du` vient de faire, pour un chiffre qui ne bouge qu'a un deploiement.
# Ajouter du travail a la machine pour documenter le travail qu'on lui ajoute serait absurde.
sub "Detail /var/lib/docker (dossiers legers uniquement)"
# ⚠️ `rootfs` et `overlay2` sont VOLONTAIREMENT EXCLUS : les parcourir, c'est marcher sur
# ~12 Go de couches empilees, soit plusieurs minutes d'E/S soutenues pour un chiffre que
# `docker system df` (ci-dessus) donne deja gratuitement. L'audit ne doit pas etre la charge
# la plus lourde de la journee.
#
# ⚠️ PIEGE PAYE LE 2026-08-04 : `timeout N du -sh ...` qui expire ne produit RIEN, et une
# section vide se lit comme « rien a signaler » au lieu de « mesure non faite ». D'ou le
# message explicite ci-dessous.
# ⚠️ CORRIGE LE 2026-08-07 — `[ -d ] || continue` FAISAIT DISPARAITRE UNE LIGNE EN SILENCE.
# `/var/lib/docker/image` n'existe pas avec le pilote `overlayfs` (Docker ≥ 29 ; c'est
# `rootfs/` qui le remplace). La boucle sautait donc ce chemin sans un mot, et la sortie
# montrait 3 lignes la ou le script en annonce 4. C'est exactement le defaut que ce meme
# fichier combat ailleurs (VPS-M02, VPS-M08) : une absence qui se lit « rien a signaler ».
for d in volumes containers image rootfs buildkit; do
  if [ ! -d "/var/lib/docker/$d" ]; then
    echo "  (absent : /var/lib/docker/$d — normal avec le pilote $(docker info --format '{{.Driver}}' 2>/dev/null || echo '?'))"
    continue
  fi
  # `rootfs`/`overlay2` : ~12 Go de couches empilees, plusieurs MINUTES d'E/S. Jamais parcourus —
  # `docker system df` donne le chiffre gratuitement (cf. §1 de la procedure).
  case "$d" in rootfs|overlay2) echo "  (/var/lib/docker/$d volontairement NON parcouru — voir docker system df)"; continue ;; esac
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
# ⚠️ PIEGE PAYE LE 2026-08-05 — le garde `{{if .State.Health}}` NE SUFFISAIT PAS, et il
# echouait sur EXACTEMENT les conteneurs qu'il etait cense proteger.
#
# Le coupable est `{{.HostConfig.NanoCpus}}` : sa presence fait basculer `docker inspect` sur
# la representation en MAP de l'objet, ou l'option `missingkey=error` transforme une cle
# absente en ERREUR. Sur un conteneur sans sonde, `.State.Health` n'existe pas dans la map :
# le gabarit ENTIER rend une ligne VIDE (« map has no entry for key "Health" » part sur stderr,
# donc dans /dev/null). Resultat : 7 des 31 conteneurs manquaient a l'appel — dont
# `tracky-web` et `tracky-lp`, deux conteneurs de PRODUCTION, et personne ne pouvait le voir
# puisque la section listait 24 lignes sans jamais annoncer combien elle en attendait.
#
# Verifie champ par champ le 2026-08-05 : `{{.HostConfig.NanoCpus}}` seul rend « 0 » ;
# associe a `.State.Health` il casse tout. Sans lui, 31/31 conteneurs sont rendus.
# `NanoCpus` ne manque a personne : il vaut 0 partout (aucune limite CPU nulle part), et le
# compte est desormais affiche a part, en une ligne.
#
# ⚠️ AJOUTE LE 2026-08-08 — deux champs reclames depuis TROIS passages (angles morts n° 3 et
# n° 4 des rapports du 08-06 et du 08-07), et qui ne coutent RIEN : ils sont deja dans
# l'`inspect` qui tourne 31 fois de toute facon.
#   - `RestartPolicy` : tout le plan d'action « redemarrer pour le noyau » repose dessus, et il
#     etait verifie A LA MAIN, donc pas verifie.
#   - `com.docker.compose.project` : c'est ce champ qui a revele VPS-020 des sa premiere
#     execution — SEPT conteneurs de DEUX applications sans rapport partagent le projet
#     « deploy », parce que compose derive le nom du projet du nom du DOSSIER et que les deux
#     depots ont un dossier `deploy/`.
NB_PS=$(docker ps -q 2>/dev/null | wc -l); NB_RENDUS=0
PROJETS=""
for c in $(docker ps -q 2>/dev/null); do
  ligne=$(docker inspect --format '  {{.Name}} | redem={{.RestartCount}} | sante={{with .State.Health}}{{.Status}}{{else}}aucune sonde{{end}} | memlimit={{.HostConfig.Memory}} | redem_pol={{.HostConfig.RestartPolicy.Name}} | projet={{with index .Config.Labels "com.docker.compose.project"}}{{.}}{{else}}aucun{{end}}' "$c" 2>/dev/null)
  [ -n "$ligne" ] && { echo "$ligne"; NB_RENDUS=$((NB_RENDUS+1))
    PROJETS="$PROJETS$(echo "$ligne" | sed -n 's/.*projet=\(.*\)/\1/p')|$(echo "$ligne" | sed -n 's/^  \/\([^ ]*\) .*/\1/p')
"; }
done
# ⚠️ CE CONTROLE EST LE VRAI CORRECTIF. Le gabarit peut re-casser a la prochaine montee de
# version de Docker ; ce qui ne doit plus JAMAIS arriver, c'est qu'il casse en SILENCE.
if [ "$NB_RENDUS" -eq "$NB_PS" ]; then
  echo "  ✅ $NB_RENDUS / $NB_PS conteneurs decrits"
else
  echo "  🔴 $NB_RENDUS / $NB_PS conteneurs decrits — $((NB_PS-NB_RENDUS)) MANQUANTS a l appel."
  echo "     Le gabarit docker inspect a echoue en silence. Ne pas lire cette liste comme complete."
fi
printf '  limites CPU : %s conteneur(s) sur %s en ont une\n' \
  "$(for c in $(docker ps -q 2>/dev/null); do docker inspect --format '{{.HostConfig.NanoCpus}}' "$c" 2>/dev/null; done | grep -vc '^0$')" "$NB_PS"

# ── Le prerequis du redemarrage, verifie au lieu d'etre suppose ──
# Le plan d'action « redemarrer pour activer le noyau » repose entierement sur cette ligne :
# un conteneur qui n'est pas en `unless-stopped` (ou `always`) NE REVIENT PAS, et on ne
# l'apprend qu'apres. Elle etait tapee a la main a chaque passage — donc oubliable.
NB_OK=$(docker ps -q 2>/dev/null | xargs -r docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' 2>/dev/null | grep -cE '^(unless-stopped|always)$')
if [ "$NB_OK" = "$NB_PS" ]; then
  echo "  ✅ redemarrage machine : $NB_OK / $NB_PS conteneurs remonteront seuls (unless-stopped/always)"
else
  echo "  🔴 redemarrage machine : $NB_OK / $NB_PS seulement remonteront seuls — les autres resteront ETEINTS :"
  docker ps -q 2>/dev/null | xargs -r docker inspect --format '{{.Name}} {{.HostConfig.RestartPolicy.Name}}' 2>/dev/null \
    | grep -vE ' (unless-stopped|always)$' | sed 's/^/     /'
fi

# ── Collision de nom de projet compose (VPS-020) ──
# ⚠️ Compose derive le nom du projet du nom du DOSSIER quand ni `name:` ni COMPOSE_PROJECT_NAME
# n'est declare. Deux depots qui ont chacun un dossier `deploy/` produisent donc UN SEUL projet
# nomme « deploy », et docker melange leurs conteneurs. Consequence : `docker compose up -d`
# dans l'un affiche les conteneurs de l'autre comme « orphelins » et RECOMMANDE
# `--remove-orphans`, qui les supprime. La suggestion vient de compose lui-meme.
sub "Nom de projet compose : deux applications partagent-elles le meme ?"
echo "$PROJETS" | grep -v '^$' | sort | awk -F'|' '
  { n[$1]++; if (l[$1]=="") l[$1]=$2; else l[$1]=l[$1]", "$2 }
  END { for (p in n) printf "  %-22s %2d conteneur(s) : %s\n", p, n[p], l[p] }' | sort
echo "  → une ligne dont les conteneurs appartiennent a DEUX applications sans rapport est un"
echo "     defaut : voir VPS-020. Le nom vient du dossier, pas du contenu."

# ── Qui sert quel domaine ? (angle mort n° 2 des rapports du 08-06 au 08-08) ──
# ⚠️ POURQUOI CETTE TABLE EXISTE. VPS-021 — « foodsqan-traefik tient les ports 80/443 de TOUTE
# la production » — a ete trouve A LA MAIN, par trois commandes lancees en marge, apres cinq
# passages ou l'audit listait les conteneurs par NOM sans jamais dire ce qu'ils SERVENT. Un nom
# qui ment (`foodsqan-*` pour le proxy de tracky) n'est detectable que par cette table.
#
# ⚠️ PIEGE PAYE TROIS FOIS, DONT DEUX LE 2026-08-09 : toute extraction conditionnelle
# d'etiquettes rend du VIDE en silence quand le motif est faux — gabarit Go `hasPrefix` non
# supporte, puis regex jq dont les antislashs ont ete manges en transit. Les deux fois, la
# sortie disait « aucune etiquette de routage » sur une machine qui en a 19. C'est VPS-M08 a
# l'identique. D'ou les DEUX gardes ci-dessous, non negociables :
#   1. aucun antislash dans la regex jq — classes [.] uniquement, qui ne peuvent pas etre mangees ;
#   2. le nombre de conteneurs ETIQUETES est compte separement et affiche a cote du nombre de
#      lignes rendues. Un « 0 route / 19 etiquetes » est alors un DEFAUT VISIBLE, pas un silence.
sub "Qui sert quel domaine (etiquettes de routage Traefik)"
if have jq; then
  NB_ETIQ=$(docker ps -q 2>/dev/null | xargs -r docker inspect 2>/dev/null \
    | jq -r '[.[] | select([.Config.Labels // {} | keys[] | select(startswith("traefik."))] | length > 0)] | length')
  ROUTES=$(docker ps -q 2>/dev/null | xargs -r docker inspect 2>/dev/null | jq -r '.[]
    | . as $x
    | ($x.Config.Labels["com.docker.compose.project"] // "-") as $p
    | ($x.Config.Labels // {}) | to_entries[]
    | select(.key | test("^traefik[.]http[.]routers[.].*[.]rule$"))
    | .value | scan("`[^`]+`") | gsub("`"; "")
    | select(test("^[a-z0-9.-]+[.][a-z]{2,}$"))
    | "\(.)|\($x.Name[1:])|\($p)"' 2>/dev/null | sort -u)
  echo "$ROUTES" | grep -v '^$' | awk -F'|' '{printf "  %-40s %-26s %s\n",$1,$2,$3}'
  NB_ROUTES=$(echo "$ROUTES" | grep -c '^..*$')
  if [ "$NB_ETIQ" -gt 0 ] && [ "$NB_ROUTES" -eq 0 ]; then
    echo "  🔴 0 domaine rendu alors que $NB_ETIQ conteneurs portent des etiquettes traefik.* :"
    echo "     l'extraction a echoue EN SILENCE. Ne pas lire ceci comme « rien n'est publie »."
  else
    printf '  ✅ %s domaines routes, portes par %s conteneurs etiquetes\n' "$NB_ROUTES" "$NB_ETIQ"
  fi
  # ⚠️ Le proxy qui tient 80/443 est le point d'entree UNIQUE : s'il tombe, tout tombe. Il est
  # nomme ici parce que `docker-proxy` (section 6) est le meme processus pour tous les
  # conteneurs publiants et ne designe donc personne.
  echo "  ── qui tient les ports 80 et 443 de la machine ──"
  docker ps --format '  {{.Names}}  (projet {{.Label "com.docker.compose.project"}})  {{.Ports}}' 2>/dev/null \
    | grep -E ':80->|:443->' || echo "  🔴 PERSONNE ne publie 80/443 — la production est injoignable"

  # ── Certificats detenus mais ne servant plus personne (angle mort n° 4) ──
  # Le volume ACME survit aux piles qu'il a servies : Traefik continue de renouveler des
  # certificats pour des domaines dont plus aucun conteneur ne repond. Sans risque, mais c'est
  # la seule mesure qui dit ce que le volume contient VRAIMENT — et il n'est dans aucune
  # sauvegarde. On ne lit QUE les noms de domaine : aucune cle privee n'est touchee.
  ACME=/var/lib/docker/volumes/foodsqan-letsencrypt/_data/acme.json
  if [ -r "$ACME" ]; then
    NB_CERT=$(jq -r '.[].Certificates[]?.domain.main' "$ACME" 2>/dev/null | sort -u | wc -l)
    NB_ORPH=$(comm -23 <(jq -r '.[].Certificates[]?.domain.main' "$ACME" 2>/dev/null | sort -u) \
                       <(echo "$ROUTES" | cut -d'|' -f1 | sort -u) 2>/dev/null | wc -l)
    printf '  ── volume ACME (%s) : %s certificats, dont %s sans service vivant ──\n' \
      "$(basename "$(dirname "$(dirname "$ACME")")")" "$NB_CERT" "$NB_ORPH"
    comm -23 <(jq -r '.[].Certificates[]?.domain.main' "$ACME" 2>/dev/null | sort -u) \
             <(echo "$ROUTES" | cut -d'|' -f1 | sort -u) 2>/dev/null | sed 's/^/    (orphelin) /'
    printf '  acme.json modifie le : %s  (renouvellement = 30 j avant expiration)\n' \
      "$(date -r "$ACME" '+%Y-%m-%d %H:%M' 2>/dev/null)"
  fi
else
  echo "  (jq absent — table de routage non calculable)"
fi

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
# ⚠️⚠️ AJOUTE LE 2026-08-07 — ANGLE MORT N° 1 DU RAPPORT DU 2026-08-06, ET IL A PAYE LE JOUR MEME.
#
# Le cache de build affiche « 10,53 Go / 93 entrees » depuis TROIS passages, a la decimale pres.
# Le 08-05 ce chiffre a ete lu comme « le ramasse-miettes fonctionne, il s'arrete a sa borne » ;
# le 08-06 comme « le ramasse-miettes ne tourne plus, le cache est GELE au-dessus de son
# plafond ». Deux lectures contradictoires de la MEME valeur, et rien dans la sortie pour
# trancher — parce qu'une valeur ne dit jamais si le mecanisme cense la faire bouger a tourne.
#
# Ce qu'il fallait afficher n'est pas le cache : c'est la date du dernier BUILD. Le
# ramasse-miettes BuildKit se declenche AVEC les builds ; sans build, il n'a aucune raison de
# tourner et `cache.db` ne bouge pas. Mesure du 2026-08-07 : dernier build le 2026-08-05 a
# 01 h 50 min 20 s, `cache.db` modifie le 2026-08-05 a 01 h 50 min 20 s — LA MEME SECONDE.
# Le mecanisme n'est pas casse : il n'a rien eu a faire. Le constat du 08-06 etait FAUX.
#
# ⚠️ LIMITE CONNUE, ecrite le 2026-08-08 pour qu'on ne la redecouvre pas : `{{.CreatedAt}}`
# est la date de CREATION de l'image, pas celle de sa construction LOCALE. Pour une image
# TIREE d'un registre, c'est la date a laquelle son editeur l'a publiee. Un `docker pull`
# d'une image publiee ce matin ferait donc croire a un build local de ce matin. Ici la
# verification est faite : le « build » du 2026-08-07 07 h 04 est `tracky-lp:latest`, une
# image construite sur la machine. Si un jour la ligne designe `postgres:17-alpine` ou une
# autre image publique, c'est un PULL, pas un build — et l'ecart avec cache.db sera alors un
# faux positif.
sub "Fraicheur des MECANISMES, pas seulement des valeurs"
DERNIER_BUILD=$(docker images --format '{{.CreatedAt}}' 2>/dev/null | sort -r | head -1 | cut -c1-19)
DERNIERE_IMG=$(docker images --format '{{.CreatedAt}}|{{.Repository}}:{{.Tag}}' 2>/dev/null | sort -r | head -1 | cut -d'|' -f2)
printf '  image concernee                                : %s\n' "${DERNIERE_IMG:-inconnue}"
CACHE_DB=$(stat -c '%y' /var/lib/docker/buildkit/cache.db 2>/dev/null | cut -c1-19)
printf '  dernier build (declencheur du ramasse-miettes) : %s\n' "${DERNIER_BUILD:-inconnu}"
printf '  cache.db de BuildKit modifie le                : %s\n' "${CACHE_DB:-absent}"
if [ -n "$DERNIER_BUILD" ] && [ -n "$CACHE_DB" ]; then
  DB=$(date -d "$DERNIER_BUILD" +%s 2>/dev/null); DC=$(date -d "$CACHE_DB" +%s 2>/dev/null)
  ECART=$(( ${DC:-0} - ${DB:-0} )); [ "$ECART" -lt 0 ] && ECART=$(( -ECART ))
  AGE_H=$(( ( $(date +%s) - ${DB:-0} ) / 3600 ))
  if [ "$ECART" -le 600 ]; then
    echo "  ✅ les deux coincident (ecart ${ECART}s) : le ramasse-miettes a bien tourne au dernier build."
    echo "     Le cache est FIGE parce qu'aucun build n'a eu lieu depuis ${AGE_H} h — pas parce qu'il est casse."
  else
    echo "  🔴 ecart de ${ECART}s entre le dernier build et la derniere ecriture de cache.db :"
    echo "     un build a eu lieu SANS que le ramasse-miettes s'execute. La borne ne tient plus."
  fi
fi
echo "  ⚠️ Regle generale : une valeur identique a la decimale pres n'est ni 'stable' ni 'gelee'"
echo "     tant qu'on ne sait pas si son PRODUCTEUR a tourne. Comparer la valeur a la fraicheur"
echo "     du mecanisme, jamais la valeur a elle-meme."
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
  # ⚠️⚠️ CORRIGE LE 2026-08-08 (VPS-M20) — LA COLONNE « vivantes » N'EST PAS UN COMPTAGE.
  # `n_live_tup` est un ESTIME tenu par le collecteur de statistiques et recale a chaque
  # ANALYZE/VACUUM. Mesure du 2026-08-08 sur `wire_logs` : estime 711 011, comptage exact
  # 696 878 — 2 % d'ecart, soit 14 133 lignes. Trois rapports (08-05, 08-06, 08-07) ont bati
  # des tendances sur des deltas de cette colonne, dont un « +88 lignes en 24 h, elle a cesse
  # de croitre » qui etait du BRUIT DE RECALAGE. Une table en ajout seul y a meme PERDU
  # 9 398 lignes d'un passage a l'autre, ce qui est arithmetiquement impossible.
  # La colonne est donc renommee, et la date du dernier recalage est affichee a cote : sans
  # elle on ne mesure pas la table, on mesure la derniere fois que Postgres l'a regardee
  # (exactement la lecon de VPS-M11 sur le cache apt). Meme requete, aucun cout ajoute.
  docker exec "$pg" psql -U "$U" -d "$D" -c \
    "SELECT c.relname AS table, pg_size_pretty(pg_total_relation_size(c.oid)) total,
            s.n_live_tup \"vivantes~estime\", s.n_dead_tup \"mortes~estime\",
            coalesce(to_char(greatest(s.last_analyze, s.last_autoanalyze),'MM-DD HH24:MI'),'jamais') AS \"recale le\"
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     LEFT JOIN pg_stat_user_tables s ON s.relid=c.oid
     WHERE n.nspname='public' AND c.relkind='r'
     ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 8;" 2>/dev/null
  echo "     ⚠️ '~estime' = valeur approchee (n_live_tup), PAS un count(*). Un delta inferieur"
  echo "        a ~2 % d'un passage a l'autre est du bruit de recalage, pas une tendance."
  # ⚠️ AJOUTE LE 2026-08-10 — angle mort n° 4 du rapport du 2026-08-09, et il a coute CINQ PASSAGES.
  # Une taille ne dit pas si une table s'accumule ou se regule : 208 Mo stables peuvent etre une
  # fenetre glissante en regime permanent, ou une accumulation qui n'a pas encore fait de degats.
  # Seule la PLAGE DE DATES tranche, et elle tranche en une requete.
  # Elle a innocente `wire_logs` le 2026-08-08 (5 jours glissants), puis
  # `position_sampling_decisions` le 2026-08-10 (5 jours aussi — ce qui a REFUTE VPS-008, ouvert
  # depuis six passages sur l'hypothese « elle n'a aucune retention »). Et elle a designe la vraie
  # accumulation : `positions`, 63 jours contigus depuis le 2026-06-09.
  # ⚠️ La colonne de date n'a PAS le meme nom partout (`timestamp`, `createdAt`, `receivedAt`) :
  # on la DEDUIT du schema plutot que de la deviner. Une colonne devinee rend une erreur SQL
  # avalee par `2>/dev/null`, donc une section vide — exactement le defaut VPS-M02.
  #
  # ⚠️ RESERVE AUX BASES DE PLUS DE 100 Mo, et ce garde-fou n'est pas cosmetique : le bloc coute
  # 4 `docker exec` par base, mesures a 3,2 s sur la machine chargee du 2026-08-10. Applique aux
  # SIX moteurs Postgres, il aurait ajoute ~19 s a un passage deja a 300 s — un capteur qui coute
  # plus que ce qu'il rapporte (meme famille que VPS-M05). Les cinq autres bases pesent 8 a 16 Mo :
  # leur fenetre de retention ne decidera jamais de rien.
  TAILLE_MO=$(docker exec "$pg" psql -U "$U" -d "$D" -t -A -c \
    "SELECT pg_database_size('$D')/1048576;" 2>/dev/null)
  if [ "${TAILLE_MO:-0}" -lt 100 ]; then
    echo "     (fenetre de retention non mesuree : base de ${TAILLE_MO:-?} Mo, sous le seuil de 100 Mo)"
  else
    echo "     ── fenetre de retention des 3 plus grosses tables (accumulation ou regime permanent ?) ──"
    for t in $(docker exec "$pg" psql -U "$U" -d "$D" -t -A -c \
        "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relkind='r'
         ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 3;" 2>/dev/null); do
      COL=$(docker exec "$pg" psql -U "$U" -d "$D" -t -A -c \
        "SELECT column_name FROM information_schema.columns
         WHERE table_name='$t' AND data_type LIKE 'timestamp%'
         ORDER BY CASE column_name WHEN 'timestamp' THEN 1 WHEN 'recordedAt' THEN 2
                                   WHEN 'receivedAt' THEN 3 WHEN 'createdAt' THEN 4 ELSE 9 END
         LIMIT 1;" 2>/dev/null)
      if [ -z "$COL" ]; then
        printf '       %-30s (aucune colonne horodatee — fenetre indeterminable)\n' "$t"
      else
        docker exec "$pg" psql -U "$U" -d "$D" -t -A -c \
          "SELECT '       '||rpad('$t',30)||coalesce(min(\"$COL\")::date::text,'vide')||' -> '
                  ||coalesce(max(\"$COL\")::date::text,'vide')||'  = '
                  ||count(DISTINCT \"$COL\"::date)||' jours  (colonne $COL)'
           FROM \"$t\";" 2>/dev/null
      fi
    done
    echo "       ⚠️ Une fenetre COURTE et STABLE d'un passage a l'autre = retention active, rien a faire."
    echo "          Une date de debut qui NE BOUGE PAS pendant que la fin avance = accumulation sans borne."
  fi
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
# ⚠️⚠️ PIEGE PAYE LE 2026-08-09, ET IL PENCHAIT DU COTE RASSURANT (VPS-M21).
# Cette section ne lisait QUE /var/log/auth.log — le fichier COURANT. Or logrotate tourne
# chaque samedi a minuit : le dimanche matin, auth.log ne contient plus que quelques heures.
# Le 2026-08-09 la fenetre faisait 2 h 17 et la section affichait « 0 echec », « top IP :
# (vide) », « comptes vises : (vide) » — c'est-a-dire l'image exacte d'une machine que
# personne n'attaque. La verite etait dans auth.log.1, que rien n'ouvrait : 188 echecs sur la
# semaine, dont 3 la veille. Une section de securite qui devient AVEUGLE un jour sur sept, et
# qui le devient dans le sens qui RASSURE, est pire qu'absente : elle produit une preuve.
#
# On lit donc auth.log ET auth.log.1 (non compresse, ~1,4 Mo, ~0,05 s), et on BORNE a 7 jours
# glissants pour que la fenetre soit la MEME a chaque passage — sans quoi le chiffre monte et
# descend au rythme de logrotate, pas des attaques. Les .gz plus anciens restent hors champ :
# ils coutent un zcat pour de l'histoire ancienne.
DEPUIS=$(date -d '7 days ago' '+%Y-%m-%dT%H:%M' 2>/dev/null)
SRC=""
for L in /var/log/auth.log.1 /var/log/auth.log /var/log/secure; do
  [ -f "$L" ] && SRC="$SRC $L"
done
if [ -n "$SRC" ]; then
  # shellcheck disable=SC2086
  ECH=$(cat $SRC 2>/dev/null | awk -v d="$DEPUIS" '$1 >= d')
  printf '  fenetre analysee : %s → %s  (7 jours glissants ; fichiers lus :%s)\n' \
    "$DEPUIS" "$(date '+%Y-%m-%dT%H:%M')" "$(echo "$SRC" | sed 's|/var/log/||g')"
  NB_ECH=$(echo "$ECH" | grep -c "Failed password\|Invalid user")
  printf '  echecs sur 7 jours : %s  (soit ~%s/jour)\n' "$NB_ECH" "$((NB_ECH / 7))"
  printf '  dont sur le compte root : %s\n' "$(echo "$ECH" | grep -c "Failed password for root")"
  echo "  top IP en ECHEC :"
  echo "$ECH" | grep "Failed password\|Invalid user" \
    | grep -oE "([0-9]{1,3}\.){3}[0-9]{1,3}" | sort | uniq -c | sort -rn | head -5 | sed 's/^/    /'
  echo "  comptes vises :"
  echo "$ECH" | grep -oE "Invalid user [a-zA-Z0-9_-]+" | sort | uniq -c | sort -rn | head -5 | sed 's/^/    /'
  echo "  IP dont des connexions ont REUSSI (a reconnaitre : ce sont vos acces) :"
  echo "$ECH" | grep "Accepted" \
    | grep -oE "([0-9]{1,3}\.){3}[0-9]{1,3}" | sort | uniq -c | sort -rn | head -5 | sed 's/^/    /'
  # ⚠️ AJOUTE LE 2026-08-05. Le compte d'echecs porte sur TOUTE la fenetre : 176 echecs se lit
  # comme « on est attaque en ce moment » alors que le dernier datait de 22 heures. La DATE du
  # dernier echec est l'information qui manquait — c'est elle qui dit si l'attaque est en
  # cours ou terminee, et elle coute un `tail`.
  printf '  dernier echec : %s\n' \
    "$(echo "$ECH" | grep -E "Failed password|Invalid user" | tail -1 | cut -c1-25)"
  # Un total de 7 jours ne distingue pas « 188 etales » de « 188 hier soir ». La repartition
  # par jour, elle, le dit — et c'est elle qui doit declencher une lecture, pas le total.
  echo "  ── repartition par jour (une attaque EN COURS se voit ici, jamais dans un total) ──"
  echo "$ECH" | grep "Failed password\|Invalid user" | cut -c1-10 | sort | uniq -c | sed 's/^/    /'
fi
# ⚠️ `fail2ban-client status` (sans nom de prison) ne dit QUE « il y a 1 prison ». Il ne dit ni
# combien d'echecs la prison a VUS, ni combien d'IP elle a bannies. Or c'est exactement la
# difference entre une prison qui protege et une prison inerte — le defaut VPS-M06, ou le
# `journalmatch` visait une unite inexistante et la prison affichait fierement « Total
# failed: 0 » pendant que 175 echecs figuraient dans les journaux.
#
# ⚠️ ET SURTOUT, LIRE CE CHIFFRE AVEC SA CONTREPARTIE : « Total failed: 0 » n'est un defaut
# QUE s'il y a eu des echecs depuis le demarrage du service. Le 2026-08-05, la prison affichait
# 0 — et c'etait EXACT : zero echec SSH depuis le redemarrage de 21:32. D'ou l'affichage
# conjoint des deux dates, sans lequel on conclurait a tort dans un sens comme dans l'autre.
if have fail2ban-client; then
  fail2ban-client status 2>/dev/null | sed 's/^/  /'
  for prison in $(fail2ban-client status 2>/dev/null | sed -n 's/.*Jail list:[[:space:]]*//p' | tr ',' ' '); do
    printf '  prison %s : %s\n' "$prison" \
      "$(fail2ban-client status "$prison" 2>/dev/null | grep -E "Currently failed|Total failed|Currently banned|Total banned" | tr -s ' \t' ' ' | paste -sd' | ')"
  done
  printf '  fail2ban demarre le : %s  (les compteurs ci-dessus partent de la)\n' \
    "$(systemctl show fail2ban -p ActiveEnterTimestamp --value 2>/dev/null)"
else
  echo "  !! fail2ban NON installe — rien ne ralentit une attaque au dictionnaire"
fi
sub "Mises a jour"
# ⚠️ PIEGE PAYE LE 2026-08-05 : `apt list --upgradable` ne compte que ce que le CACHE local
# connait. Juste apres un redemarrage — ou avant le premier passage d'`apt-daily` — il peut
# annoncer 0 alors que 59 paquets attendent. Le passage du 2026-08-04 a enregistre « 0 paquet
# en retard » pour cette raison, et le lendemain il y en avait 59 : la machine n'avait rien
# installe entre-temps, c'est la MESURE qui avait menti.
# Un compte de paquets sans la date de son cache n'est donc pas un chiffre exploitable.
printf '  cache apt rafraichi le : %s\n' \
  "$(stat -c '%y' /var/lib/apt/periodic/update-success-stamp 2>/dev/null | cut -c1-19 \
     || stat -c '%y' /var/lib/apt/lists 2>/dev/null | cut -c1-19 || echo 'inconnu')"
apt list --upgradable 2>/dev/null | grep -c '/' | xargs echo "  paquets en retard :"
apt list --upgradable 2>/dev/null | grep -icE "security" | xargs echo "  dont estampilles securite :"
echo "     (un 0 ici n'est PAS une garantie : Ubuntu publie beaucoup de correctifs par"
echo "      'noble-updates', qui ne porte pas le mot 'security'. Ex. du 2026-08-05 :"
echo "      apparmor, coreutils et cloud-init attendaient, avec 'securite = 0'.)"
[ -f /var/run/reboot-required ] && { echo "  !! REDEMARRAGE REQUIS :"; cat /var/run/reboot-required.pkgs 2>/dev/null | sed 's/^/    /'; } || echo "  redemarrage requis : non"
# ⚠️ AJOUTE LE 2026-08-06 — angle mort n° 1, REPORTE TROIS FOIS (rapports du 08-04 et 08-05).
# Si le VPS mettait deux secondes a joindre Vizyo Auth ou la passerelle SMS, rien ici ne le
# montrerait : on mesure le CPU, la RAM, le disque et les conteneurs, jamais le RESEAU
# SORTANT. Or une dependance lente ne casse rien — elle ralentit tout, et se diagnostique
# comme « l'application rame » pendant des jours.
#
# `--max-time 4` et une seule requete par cible : le budget total est de ~1 s quand tout va
# bien. On mesure `time_connect` (etablissement TCP+TLS, c'est le RESEAU) separement de
# `time_total` (reponse complete, c'est le SERVICE) : confondre les deux fait accuser le
# reseau d'une lenteur applicative.
# ⚠️ AJOUTE LE 2026-08-08 — MEDIANE DE TROIS, angle mort n° 6 du rapport du 2026-08-07.
# Une mesure unique par cible ne permet pas de distinguer un incident d'un alea, et ca s'est
# paye : le 08-07, `auth.vizyoagency.com` est passe de 120 a 294 ms d'etablissement. Le rapport
# a eu la prudence de ne pas en faire un constat ; le 08-08 la meme cible mesure 21 ms, donc
# c'etait bien du bruit. Trois mesures et on garde la MEDIANE — pas la moyenne, qu'un seul
# aller-retour lent suffit a deplacer. Cout : ~2 s au total, mesure sur la machine.
sub "Latence des dependances sortantes (mediane de 3 — reseau, pas service)"
for cible in ${AUDIT_DEPS:-https://auth.vizyoagency.com https://api.github.com https://registry-1.docker.io/v2/}; do
  mesures=""
  for _ in 1 2 3; do
    m=$(timeout 8 curl -s -o /dev/null --max-time 4 \
          -w '%{http_code}|%{time_connect}|%{time_total}' "$cible" 2>/dev/null)
    [ -n "$m" ] && mesures="$mesures$m
"
  done
  N=$(printf '%s' "$mesures" | grep -c .)
  if [ "$N" -eq 0 ]; then
    printf '  %-42s INJOIGNABLE en 4 s (3 essais)\n' "$cible"
  else
    # Mediane sur le temps d'ETABLISSEMENT : c'est lui qui mesure le reseau, `time_total`
    # melangeant reseau et temps de reponse du service d'en face.
    printf '%s' "$mesures" | sort -t'|' -k2,2n | awk -F'|' -v c="$cible" -v n="$N" '
      NR==int((n+1)/2) {
        printf "  %-42s http=%s  connexion=%.0f ms  total=%.0f ms  (mediane de %d)%s\n",
          c, $1, $2*1000, $3*1000, n, ($2 > 0.5 ? "   ⚠️ etablissement > 500 ms" : "") }'
    [ "$N" -lt 3 ] && echo "     ⚠️ seulement $N mesure(s) sur 3 ont abouti : la cible a echoue au moins une fois."
  fi
done

sub "Certificats TLS des domaines publics"
# Depuis la machine elle-meme, une boucle vers son IP publique peut echouer sans que le
# certificat soit en cause : un « injoignable » ici se REVERIFIE depuis l'exterieur.
# ⚠️ La liste par defaut ne contenait QUE le site vitrine — l'application elle-meme
# (`app-tracky`) n'etait jamais verifiee. Un certificat expire sur l'application ne coupe pas
# la vitrine : on l'aurait appris par un client, pas par l'audit.
for d in ${AUDIT_DOMAINS:-tracky.vizyoagency.com app-tracky.vizyoagency.com}; do
  exp=$(echo | timeout 8 openssl s_client -servername "$d" -connect "$d:443" 2>/dev/null \
        | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  printf '  %-40s %s\n' "$d" "${exp:-injoignable depuis la machine (a reverifier de l exterieur)}"
done

# ⚠️ AJOUTE LE 2026-08-10 — angle mort n° 5 du rapport du 2026-08-09.
# Onze sections comptent des conteneurs `healthy`, des certificats, des sondes et des ports.
# AUCUNE ne demandait a la production de repondre. Or les deux se decorrelent facilement :
# `foodsqan-traefik` — l'unique porte 80/443 (VPS-021) — n'a AUCUNE sonde de sante, et sept
# conteneurs sur 31 non plus. Un proxy vivant devant une API morte se lit « 31/31 sains ».
# C'est la SEULE mesure de bout en bout de tout l'audit : elle traverse le DNS, le proxy, le
# certificat, le routage par etiquette et l'application. Un 200 ici vaut plus que dix compteurs.
# ⚠️ La route de sante est interrogee SEPAREMENT de la page : un frontal statique repond 200
# meme quand l'API derriere est tombee — c'est exactement le faux positif qu'on veut eviter.
# Cout mesure : ~0,5 s pour les quatre cibles.
sub "Bout-en-bout : la production REPOND-elle ? (traverse proxy + certificat + routage + appli)"
for cible in ${AUDIT_E2E:-https://app-tracky.vizyoagency.com/ https://app-tracky.vizyoagency.com/api/health https://tracky.vizyoagency.com/ https://app-verify.vizyoagency.com/}; do
  r=$(timeout 8 curl -s -o /dev/null --max-time 5 -w '%{http_code}|%{time_total}' "$cible" 2>/dev/null)
  if [ -z "$r" ]; then
    printf '  🔴 %-52s AUCUNE REPONSE en 5 s\n' "$cible"
  else
    printf '%s' "$r" | awk -F'|' -v c="$cible" '{
      etat = ($1 ~ /^[23]/) ? "✅" : "🔴"
      printf "  %s %-52s http=%s  %.0f ms\n", etat, c, $1, $2*1000 }'
  fi
done
echo "     (3xx attendu sur app-verify : il redirige vers sa page de connexion. Un 5xx, un 000"
echo "      ou une absence de reponse sont les seuls cas a traiter — voir le plan d action.)"

# ─────────────────────────────────────────────────────────────────────────────────────────────
section "7. PLANIFICATION"
# ─────────────────────────────────────────────────────────────────────────────────────────────
sub "crontab root"
crontab -l 2>/dev/null | grep -vE "^#|^$" | sed 's/^/  /' || echo "  (vide)"
sub "cron.d"
for f in /etc/cron.d/*; do [ -f "$f" ] && { echo "  $f :"; grep -vE "^#|^$" "$f" | sed 's/^/    /'; }; done
sub "Timers systemd"
# ⚠️ `head -12` CACHAIT DES TIMERS (corrige le 2026-08-06). La machine en a 13 ; le catalogue
# `ordonnancement` du manifeste — dont le seul role est de reveler les collisions d'horaires —
# ignorait donc `apport-autoreport.timer` depuis l'origine. Une liste tronquee a une longueur
# arbitraire est un mensonge par omission : on affiche tout, et on affiche le COMPTE.
printf '  (%s timers actifs)\n' "$(systemctl list-timers --no-legend --no-pager 2>/dev/null | grep -c .)"
systemctl list-timers --no-pager 2>/dev/null | sed 's/^/  /'
# ⚠️ AJOUTE LE 2026-08-06. Un timer parfaitement configure, actif, arme, dont la prochaine
# echeance s'affiche fierement — et qui echouera parce que le script qu'il pointe a perdu son
# bit d'execution. C'est exactement ce qui est arrive a `vizyo-verify-backup` le 2026-08-05
# (`scp -r` ne preserve les droits qu'avec `-p`). Rien dans `list-timers` ne le laisse voir :
# systemd ne verifie l'executabilite qu'AU MOMENT de lancer, donc l'erreur n'existe qu'apres
# coup. Ce controle la rend visible AVANT le prochain declenchement.
sub "Chaque timer pointe-t-il un script REELLEMENT executable ? (verifie avant l echeance)"
for t in $(systemctl list-timers --all --no-legend --no-pager 2>/dev/null | awk '{print $NF}' | grep '\.service$' | sort -u); do
  bin=$(systemctl show "$t" -p ExecStart --value 2>/dev/null | grep -oE 'path=[^ ;]+' | head -1 | cut -d= -f2)
  [ -z "$bin" ] && continue
  case "$bin" in /usr/bin/*|/usr/lib/*|/usr/sbin/*|/bin/*|/sbin/*) continue ;; esac  # binaires systeme
  # ⚠️ FAUX POSITIF CORRIGE A LA POSE (2026-08-06) : un `ExecStart` peut etre un nom NU
  # (`systemd-tmpfiles`), que systemd resout via le PATH. Teste comme un chemin, il ressort
  # « ABSENT » — une ligne rouge quotidienne sur une unite Ubuntu parfaitement saine. Un
  # controle neuf se relit ligne a ligne avant publication (VPS-M13) : c'est ce qui l'a vue.
  case "$bin" in
    /*) ;;
    *)  command -v "$bin" >/dev/null 2>&1 && continue
        printf '  🔴 %-34s %s introuvable dans le PATH\n' "$t" "$bin"; continue ;;
  esac
  if [ ! -e "$bin" ]; then
    printf '  🔴 %-34s %s ABSENT\n' "$t" "$bin"
  elif [ ! -x "$bin" ]; then
    printf '  🔴 %-34s %s NON EXECUTABLE (%s) → echouera en 203/EXEC\n' "$t" "$bin" "$(stat -c%A "$bin" 2>/dev/null)"
  else
    printf '  ✅ %-34s %s\n' "$t" "$bin"
  fi
done

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
  printf '  %-8s %8s %8s %8s %8s %10s %10s %s\n' jour user% sys% iowait% steal% pic_charge pic_ram% note
  for i in $(seq 7 -1 1); do
    f=/var/log/sysstat/sa$(date -d "-$i day" +%d 2>/dev/null)
    [ -f "$f" ] || continue
    d=$(date -d "-$i day" +%m-%d)
    # ⚠️ PIEGE PAYE LE 2026-08-05 : un jour ou la machine REDEMARRE, `sar` decoupe la journee
    # en segments et emet UNE ligne `Average:` PAR segment. Le `printf` cumulatif d'origine les
    # concatenait : la ligne du 08-04 affichait HUIT colonnes au lieu de quatre, totalement
    # illisible — et c'etait precisement le jour du redemarrage, donc le jour dont l'historique
    # comptait le plus. On ne garde donc que le DERNIER segment (l'etat courant de la machine),
    # et on SIGNALE le redecoupage au lieu de le masquer.
    nseg=$(sar -u -f "$f" 2>/dev/null | grep -c '^Average:')
    cpu=$(sar -u -f "$f" 2>/dev/null | awk '/^Average:/ {u=$3; s=$5; w=$6; t=$7} END {printf "%8.2f %8.2f %8.2f %8.2f", u,s,w,t}')
    if [ "${nseg:-1}" -gt 1 ]; then note="⚠️ REDEMARRAGE ce jour-la — $nseg segments, valeurs du DERNIER"; else note=""; fi
    chg=$(sar -q -f "$f" 2>/dev/null | awk '$1!="Average:" && $4 ~ /^[0-9.]+$/ {if ($4+0>m) m=$4+0} END {printf "%10.2f", m}')
    ram=$(sar -r -f "$f" 2>/dev/null | awk '$1!="Average:" && $5 ~ /^[0-9.]+$/ {if ($5+0>m) m=$5+0} END {printf "%10.1f", m}')
    printf '  %-8s %s %s %s %s\n' "$d" "$cpu" "$chg" "$ram" "$note"
  done
  sub "Ecriture disque moyenne par jour (revele les journees de build)"
  for i in $(seq 7 -1 1); do
    f=/var/log/sysstat/sa$(date -d "-$i day" +%d 2>/dev/null)
    [ -f "$f" ] || continue
    # Meme piege qu'au-dessus : un jour de redemarrage produisait DEUX lignes pour la meme
    # date (08-04 apparaissait deux fois le 2026-08-05), ce qui se lit comme une erreur de
    # collecte. On agrege sur le dernier segment, comme pour le CPU.
    sar -b -f "$f" 2>/dev/null | awk -v d="$(date -d "-$i day" +%m-%d)" \
      '/^Average:/ {tps=$2; wr=$6} END {if (tps!="") printf "  %s : %.0f tps, ecriture %.0f blocs/s\n", d, tps, wr}'
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
    # ⚠️ NE PAS PRENDRE CE CHIFFRE POUR DE L'ESPACE RECUPERABLE (constate le 2026-08-05).
    # `docker system df` annoncait « 24,39 Go (99 %) recuperables » alors que 25 des 26 images
    # etaient ACTIVES — les deux affirmations ne peuvent pas etre vraies ensemble. Docker
    # compte ici les couches partagees entre images, pas de l'espace liberable. Le porter dans
    # un plan d'action ferait promettre 24 Go que la commande ne rendrait jamais.
    "Images")        printf '  %-28s %s  (⚠️ CHIFFRE NON FIABLE : %s images sur %s sont ACTIVES —\n' \
                       "images" "$recl" \
                       "$(docker system df --format '{{.Type}}|{{.Active}}' 2>/dev/null | awk -F'|' '/^Images/{print $2}')" \
                       "$(docker system df --format '{{.Type}}|{{.TotalCount}}' 2>/dev/null | awk -F'|' '/^Images/{print $2}')"
                     printf '  %-28s   docker compte des couches partagees, pas de l espace liberable)\n' "" ;;
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
# ⚠️⚠️ LE DEFAUT LE PLUS GRAVE TROUVE LE 2026-08-05, ET IL ETAIT DANS CETTE SECTION MEME.
#
# Cette section demandait « chaque application a-t-elle une copie recente ? » en parcourant
# les DOSSIERS de /var/backups. Elle ne pouvait donc voir que les bases qui ont DEJA un
# dossier de sauvegarde. Une base dont la sauvegarde n'a jamais existe — ou dont le dossier a
# ete supprime — etait tout simplement ABSENTE de la liste, et une absence se lit comme
# « rien a signaler ».
#
# Ce que ca cachait : sur 7 moteurs de base en service, DEUX seulement etaient sauvegardes.
# `texto-postgres` (passerelle SMS) et `capcom6-mysql` n'apparaissaient nulle part, et
# `vizyo-manager` (abonnements Stripe, factures, clients) n'avait plus de copie depuis le
# 2026-04-15 sans qu'aucun timer n'existe encore pour en refaire une.
#
# Le correctif inverse le sens de la question : on part des BASES QUI TOURNENT, et on cherche
# une sauvegarde pour chacune. C'est la meme lecon que VPS-004 et VPS-M06 — verifier du cote
# de l'EFFET, pas du cote de la trace.
# ⚠️⚠️ AJOUTE LE 2026-08-06 — ET C'EST LE CONTROLE QUI MANQUAIT LE PLUS.
#
# Le 2026-08-05 a 03:30, `vizyo-verify-backup.service` a echoue (203/EXEC : le script avait
# perdu son bit d'execution lors d'un redeploiement par `scp -r`, qui ne preserve les droits
# qu'avec `-p`). La sauvegarde des pieces d'identite ne s'est plus faite. Et TROIS indicateurs
# sur quatre affichaient vert :
#   • `DERNIER-ETAT.json` disait « OK » — un run qui ECHOUE ne reecrit pas le fichier d'etat,
#     donc le dernier succes connu reste affiche et se lit comme l'etat courant ;
#   • la copie hors-site disait « a jour » — elle avait fidelement copie... rien de nouveau ;
#   • la section « age par dossier » disait « a jour » — 29 h, pour un seuil a 30 h.
# Seul `systemctl --failed` (section 7) disait la verite, et il ne le disait que par hasard :
# une unite `oneshot` en echec n'y reste visible que jusqu'au prochain `reset-failed`.
#
# La lecon est celle de VPS-004, VPS-M06 et VPS-M13, pour la quatrieme fois : on verifiait la
# TRACE (des fichiers, un JSON, un manifeste) et jamais l'EFFET (l'unite qui les produit
# a-t-elle reussi ?). On interroge donc desormais la SOURCE.
sub "L'unite qui PRODUIT chaque sauvegarde a-t-elle reussi ? (la trace peut mentir, pas elle)"
for u in $(systemctl list-unit-files --no-legend --no-pager '*backup*.service' 2>/dev/null | awk '{print $1}'); do
  etat=$(systemctl show "$u" -p ActiveState --value 2>/dev/null)
  res=$(systemctl show "$u" -p Result --value 2>/dev/null)
  code=$(systemctl show "$u" -p ExecMainStatus --value 2>/dev/null)
  fin=$(systemctl show "$u" -p ExecMainExitTimestamp --value 2>/dev/null)
  # ⚠️ Le bit d'execution est verifie SEPAREMENT : c'est la cause exacte du 203/EXEC, et elle
  # est invisible dans l'etat de l'unite tant qu'elle n'a pas essaye de demarrer.
  bin=$(systemctl show "$u" -p ExecStart --value 2>/dev/null | grep -oE 'path=[^ ;]+' | head -1 | cut -d= -f2)
  if [ -n "$bin" ] && [ ! -x "$bin" ]; then
    droits="🔴 $bin N'EST PAS EXECUTABLE ($(stat -c%A "$bin" 2>/dev/null || echo ABSENT)) → le prochain declenchement echouera en 203/EXEC"
  else
    droits=""
  fi
  case "$res" in
    success|"") verdict="✅ dernier resultat : succes" ;;
    *)          verdict="🔴 DERNIER RESULTAT : $res (code $code) — AUCUNE SAUVEGARDE PRODUITE" ;;
  esac
  printf '  %-34s %-14s %s\n' "$u" "$etat" "$verdict"
  printf '    derniere fin : %s\n' "${fin:-jamais executee}"
  [ -n "$droits" ] && printf '    %s\n' "$droits"
done
[ -n "$(systemctl list-unit-files --no-legend --no-pager '*backup*.service' 2>/dev/null)" ] || \
  echo "  (aucune unite *backup*.service declaree — les sauvegardes ne sont donc pas pilotees par systemd)"

sub "Couverture : chaque base EN SERVICE a-t-elle une sauvegarde ?"
MAINTENANT=$(date +%s)
for cont in $(docker ps --format '{{.Names}}' 2>/dev/null | grep -Ei "postgres|postgis|mysql|maria|mongo"); do
  # Rapprochement par prefixe : `tracky-postgres` → un dossier contenant « tracky ».
  cle=$(echo "$cont" | sed -E 's/-(postgres|postgis|mysql|mariadb|mongo).*$//')
  # ⚠️ PIEGE PAYE A L'ECRITURE MEME DE CE CONTROLE, le 2026-08-05 — il faut le laisser ecrit.
  # La premiere version s'arretait au PREMIER dossier correspondant (`break`). Pour
  # `tracky-postgres`, le premier dossier contenant « tracky » est `tracky-pre-deploy-20260427`
  # — un instantane de 99 jours — et non `vizyo-tracky`, sauvegarde 23 h plus tot. Le controle
  # annoncait donc « ABANDONNEE depuis 99 jours » sur la base la plus importante de la machine,
  # alors que sa sauvegarde etait fraiche. Un controle de sauvegarde qui crie au loup se fait
  # desactiver en trois jours, et c'est ainsi qu'on perd la vraie alerte.
  # On balaie donc TOUS les dossiers correspondants et on garde la copie LA PLUS RECENTE.
  trouve=""; agemax=""; recent=0
  for d in /var/backups/*/; do
    case "$(basename "$d")" in
      *"$cle"*)
        t=$(find "$d" -maxdepth 1 -type f \( -name '*.gz' -o -name '*.gpg' \) -printf '%T@\n' 2>/dev/null | sort -rn | head -1)
        trouve="${trouve}${trouve:+, }$(basename "$d")"
        [ -n "$t" ] && [ "${t%.*}" -gt "$recent" ] && recent=${t%.*}
        ;;
    esac
  done
  [ "$recent" -gt 0 ] && agemax=$(( (MAINTENANT - recent) / 86400 ))
  # Une base de DEVELOPPEMENT sans sauvegarde est un choix, pas un defaut : on le dit, plutot
  # que de produire une alerte quotidienne que tout le monde apprendra a ignorer.
  case "$cont" in *-dev-*) nature="(developpement — sans enjeu)" ;; *) nature="" ;; esac
  if [ -z "$trouve" ]; then
    verdict="🔴 AUCUNE SAUVEGARDE"
  elif [ -z "$agemax" ]; then
    verdict="🔴 dossier VIDE"
  elif [ "$agemax" -ge 7 ]; then
    verdict="🔴 ABANDONNEE — derniere copie il y a $agemax jours"
  elif [ "$agemax" -ge 2 ]; then
    verdict="🟠 en retard ($agemax j)"
  else
    verdict="✅ a jour ($agemax j)"
  fi
  printf '  %-26s %-42s %-28s %s\n' "$cont" "$verdict" "${trouve:-—}" "$nature"
  # ── Ce que COUTERAIT la sauvegarde manquante (angle mort n° 5 du rapport du 2026-08-08) ──
  # ⚠️ On repetait « texto et capcom6 n'ont aucune sauvegarde » depuis CINQ passages sans
  # jamais dire ce que la corriger couterait. Or c'est le seul chiffre qui tranche le debat :
  # une base de 8 Mo et une de 0,4 Mo ne se discutent pas, elles se sauvegardent. La question
  # « faut-il accepter la perte ? » n'etait restee ouverte que faute de cette ligne.
  # Cout : une requete de metadonnees, uniquement sur les bases EN DEFAUT et hors dev — 3 sur
  # 7 ici, ~0,6 s. On ne l'execute pas sur les bases saines : leur taille est deja section 5.
  case "$verdict$nature" in
    *AUCUNE*developpement*|*ABANDONNEE*developpement*) ;;
    *AUCUNE*|*ABANDONNEE*|*VIDE*)
      taille=""
      case "$cont" in
        *mysql*|*maria*)
          mp=$(docker inspect "$cont" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
               | sed -n 's/^MYSQL_ROOT_PASSWORD=//p;s/^MARIADB_ROOT_PASSWORD=//p' | head -1)
          # ⚠️ l'image mariadb:11 ne fournit PLUS le binaire `mysql` — c'est `mariadb`. Un
          # `|| true` masquerait l'echec : on essaie les deux et on le dit si aucun ne repond.
          for cli in mariadb mysql; do
            taille=$(docker exec "$cont" "$cli" -uroot -p"$mp" -N -B -e \
              "select concat(round(sum(data_length+index_length)/1024/1024,1),' Mo') from information_schema.tables where table_schema not in ('information_schema','performance_schema','mysql','sys')" 2>/dev/null)
            [ -n "$taille" ] && break
          done ;;
        *)
          pu=$(docker inspect "$cont" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
               | sed -n 's/^POSTGRES_USER=//p' | head -1)
          pd=$(docker inspect "$cont" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
               | sed -n 's/^POSTGRES_DB=//p' | head -1)
          taille=$(docker exec "$cont" psql -U "${pu:-postgres}" -d "${pd:-postgres}" -tAc \
            "select pg_size_pretty(pg_database_size(current_database()))" 2>/dev/null | tr -d ' ') ;;
      esac
      if [ -n "$taille" ]; then
        printf '    → la sauvegarder couterait %s par jour (avant compression)\n' "$taille"
      else
        printf '    → taille NON MESURABLE (client absent ou acces refuse) — ne pas lire « petite »\n'
      fi ;;
  esac
done
echo "  (une base absente de cette liste n'existe pas ; une base sans sauvegarde y figure BIEN)"

sub "Age de la derniere sauvegarde, par dossier de /var/backups"
for d in /var/backups/*/; do
  app=$(basename "$d")
  case "$app" in vizyo-*|tracky-*|maestroo-*|maalem-*|texto-*|capcom6-*) ;; *) continue ;; esac
  dernier=$(find "$d" -maxdepth 1 -type f \( -name '*.gz' -o -name '*.gpg' \) -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1)
  if [ -z "$dernier" ]; then
    printf '  %-22s AUCUNE SAUVEGARDE\n' "$app"
    continue
  fi
  ts=${dernier%% *}; fic=${dernier#* }
  age_h=$(( (MAINTENANT - ${ts%.*}) / 3600 ))
  nb=$(find "$d" -maxdepth 1 -type f \( -name '*.gz' -o -name '*.gpg' \) 2>/dev/null | wc -l)
  taille=$(du -sh "$d" 2>/dev/null | cut -f1)
  # ⚠️ Un dossier dont le NOM porte une date (`tracky-pre-deploy-20260427`) est un instantane
  # pris une fois avant un deploiement, pas une serie planifiee. Le declarer « PERIMEE » chaque
  # matin est un faux positif — et un faux positif quotidien finit par faire ignorer la ligne
  # VRAIE juste a cote. Meme raisonnement que pour les doublons de sauvegarde (section 3).
  case "$app" in
    *-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) verdict="instantane ponctuel (garde volontairement)" ;;
    *) if [ "$age_h" -gt 30 ]; then verdict="⚠️ PERIMEE (> 30 h)"; else verdict="a jour"; fi ;;
  esac
  printf '  %-26s %3s h  %-42s %2d copies, %s  %s\n' "$app" "$age_h" "$verdict" "$nb" "$taille" "$(basename "$fic")"
done

# ── L'archive est-elle LISIBLE ? (angle mort du rapport du 2026-08-04) ────────────────────
# On verifiait qu'une sauvegarde EXISTE et qu'elle PESE 130 Mo. Une archive tronquee — pipe
# coupe, disque plein en fin d'ecriture — passait ce controle sans broncher : le fichier est
# la, sa taille est plausible, et on ne decouvre le probleme qu'en restaurant.
#
# Cout MESURE le 2026-08-05 : 3,2 s pour 126 Mo, en priorite idle. C'est assez peu cher pour
# etre fait a chaque passage, et seulement sur la copie LA PLUS RECENTE — c'est elle qu'on
# restaurerait. Les archives .gpg ne sont pas testables sans la cle : elles ont deja leur
# propre relecture, declaree dans DERNIER-ETAT.json.
# ⚠️ AMELIORE LE 2026-08-06 — angle mort n° 2 du rapport du 2026-08-05, POUR ZERO SECONDE.
# `gzip -t` prouve que l'archive n'est pas tronquee ; il ne prouve PAS que le `pg_dump` est
# alle au bout. Un dump interrompu proprement (base coupee en cours de route) produit un
# gzip parfaitement valide et un contenu incomplet — c'est la panne la plus vicieuse, parce
# qu'elle ne se decouvre qu'a la restauration, sur une base a moitie remplie.
# `pg_dump` ecrit une derniere ligne « PostgreSQL database dump complete » : on la cherche.
# Le cout est NUL puisqu'on decompressait deja l'archive entiere pour la tester — on lit la
# fin du flux au lieu de le jeter.
sub "Integrite : la derniere archive se relit-elle, ET le dump va-t-il jusqu'au bout ?"
for d in /var/backups/*/; do
  der=$(find "$d" -maxdepth 1 -type f -name '*.gz' ! -name '*.gpg' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1)
  [ -z "$der" ] && continue
  fic=${der#* }
  # ⚠️ `rc=${PIPESTATUS[0]}` NE MARCHE PAS ici : `x=$(a | b)` est une commande SIMPLE, donc
  # PIPESTATUS decrit l'affectation, pas le tube interne — l'echec de gzip serait avale et
  # toute archive tronquee declaree saine. C'est `pipefail` (pose en tete de script) qui
  # remonte l'echec de gzip jusqu'au statut de l'affectation, lu par `$?`.
  # ⚠️ `tail -8` et non `tail -3` : les pg_dump recents ecrivent un `\unrestrict <jeton>` APRES
  # le commentaire « PostgreSQL database dump complete ». A 3 lignes, le marqueur sortait de la
  # fenetre et l'archive `vizyo-manager` etait declaree suspecte alors qu'elle est saine —
  # faux positif attrape en relisant la sortie du controle neuf ligne a ligne (VPS-M13).
  fin=$(timeout 120 $LOW gzip -dc "$fic" 2>/dev/null | tail -8); rc=$?
  if [ "$rc" -ne 0 ]; then
    printf '  🔴 %-26s %s ILLISIBLE OU TRONQUEE — cette sauvegarde ne restaurera pas\n' "$(basename "$d")" "$(basename "$fic")"
  elif echo "$fin" | grep -q "dump complete"; then
    printf '  ✅ %-26s %s se relit ET le dump est COMPLET\n' "$(basename "$d")" "$(basename "$fic")"
  else
    printf '  🟠 %-26s %s se relit, mais SANS le marqueur de fin de pg_dump —\n' "$(basename "$d")" "$(basename "$fic")"
    printf '     %-26s dump interrompu, ou archive qui n est pas un pg_dump. Derniere ligne : %s\n' "" "$(echo "$fin" | tail -1 | cut -c1-60)"
  fi
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
# Une copie hors-site qui a cesse de tourner est le pire angle mort : les
# fichiers sont toujours la sur le VPS, tout parait normal, et on decouvre au
# moment de restaurer qu'il n'existait qu'un seul exemplaire.
horsite=0
for f in /var/backups/*/DERNIERE-COPIE-LOCALE.json; do
  [ -f "$f" ] || continue
  horsite=1
  v() { grep -o "\"$1\": *\"[^\"]*\"" "$f" | head -1 | sed 's/.*: *"//; s/"$//'; }
  n() { grep -o "\"$1\": *[0-9]*" "$f" | head -1 | grep -o '[0-9]*$'; }
  age_h=$(( (MAINTENANT - $(date -d "$(v horodatage)" +%s 2>/dev/null || echo "$MAINTENANT")) / 3600 ))
  if [ "$age_h" -gt 48 ]; then verdict="⚠️ PERIMEE (> 48 h)"; else verdict="a jour"; fi
  printf '  %-22s %-14s %3s h  %s  (%s copies locales)\n' \
    "$(v application)" "$(v statut)" "$age_h" "$verdict" "$(n pairesLocales)"
  printf '    destination : %s\n' "$(v copieHorsSite)"
  # ⚠️⚠️ AJOUTE LE 2026-08-07 — CE VERDICT MENTAIT ENCORE CE MATIN, POUR LA DEUXIEME FOIS.
  # VPS-015 l'avait deja nomme le 2026-08-06 : « un copieur qui n'a rien a copier REUSSIT ».
  # La ligne a quand meme affiche « vizyo-verify OK 21 h a jour » alors que la sauvegarde
  # qu'elle copie date du 2026-08-04 et qu'aucune n'a ete produite depuis. On a documente le
  # piege sans desarmer l'indicateur qui le tend — la fraicheur d'une COPIE ne peut pas
  # depasser la fraicheur de ce qu'elle copie. Le verdict est desormais PLAFONNE par elle.
  src=$(dirname "$f")
  recent=$(find "$src" -type f ! -name '*.json' -printf '%T@\n' 2>/dev/null | sort -rn | head -1 | cut -d. -f1)
  if [ -n "$recent" ]; then
    age_src=$(( (MAINTENANT - recent) / 3600 ))
    if [ "$age_src" -gt "$age_h" ] && [ "$age_src" -gt 48 ]; then
      printf '    🔴 MAIS le fichier le plus recent de %s a %s h : la copie est fraiche, son CONTENU non.\n' "$src" "$age_src"
      printf '       Une copie reussie ne prouve QUE le copieur, jamais le producteur.\n'
    else
      printf '    contenu copie : %s h (la copie ne peut pas etre plus fraiche que sa source)\n' "$age_src"
    fi
  fi
done
if [ "$horsite" -eq 0 ]; then
  if have rclone && rclone listremotes 2>/dev/null | grep -q .; then
    rclone listremotes 2>/dev/null | sed 's/^/  remote configure : /'
  else
    echo "  AUCUNE — toutes les sauvegardes sont sur le disque qu'elles protegent."
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────────────────────
section "12. LEVIERS D'OPTIMISATION — etat de chacun, verdict automatique"
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
#
# ⚠️ PIEGE PAYE LE 2026-08-05 : le seuil d'alerte valait 10 Go — c'est-a-dire EXACTEMENT le
# plafond que le ramasse-miettes de BuildKit fait respecter (`keepStorage: 10GB`). Le cache
# stabilise a 10,53 Go declenchait donc une alerte QUOTIDIENNE sur un mecanisme qui
# fonctionnait parfaitement. Une alerte qui se declenche tous les jours sur un etat normal
# n'est plus une alerte : c'est du bruit, et elle finit par masquer la vraie.
# Le seuil est desormais le plafond du ramasse-miettes + 50 % de marge : on n'alerte que si
# le cache ECHAPPE a sa borne, ce qui est le seul evenement interessant.
GC_GO=$(docker buildx inspect default 2>/dev/null | grep -oE '[0-9]+GiB' | tr -d 'GiB' | sort -rn | head -1)
SEUIL_BC=$(awk -v g="${GC_GO:-10}" 'BEGIN{printf "%d", g*1.5}')
# ⚠️⚠️ CORRIGE LE 2026-08-10 (VPS-M25) — ON COMPARAIT DEUX GRANDEURS DIFFERENTES.
# `docker system df` annonce « Build Cache 13.82GB ». Le plafond du ramasse-miettes vaut 10 Go.
# On en concluait naturellement « il deborde de 38 % ». C'est faux, et `docker buildx du` le dit
# en trois lignes :
#     Shared: 3.392GB      Private: 10.42GB      Total: 13.82GB
# `Shared` = les couches que le cache PARTAGE avec des images vivantes. Le ramasse-miettes ne
# peut pas les liberer — elles appartiennent aussi a une image en service — et `keepStorage` ne
# les a jamais gouvernees. La seule grandeur qu'il regle est `Private` : 10,42 Go pour un
# plafond de 10 Go, soit 4 % au-dessus. Le mecanisme tient sa borne, exactement.
# Ces 3,39 Go sont d'ailleurs comptes DEUX FOIS dans la sortie de `docker system df` — une fois
# en « Images » (27,41 Go), une fois en « Build Cache » — ce qui explique pourquoi le disque n'a
# grossi que de 5 Go quand les deux postes affichaient +4,8 et +5,3 Go le meme jour.
# Le verdict porte desormais sur `Private`, et `Total` reste affiche pour que l'ecart se voie.
# ⚠️ UN SEUL appel a `docker buildx du`, dont on tire les deux lignes. La premiere version en
# lancait deux (1,69 s au lieu de 0,85 s) : c'est le defaut VPS-M05 n° 3 re-tendu — deux
# `docker exec` successifs pour une seule question. Sur une machine a 2 vCPU dont le demon
# Docker tourne en boucle, chaque appel au socket se paie.
BC_DU=$(docker buildx du 2>/dev/null)
BC_PRIV=$(printf '%s\n' "$BC_DU" | awk -F':' '/^Private:/{gsub(/[[:space:]]/,"",$2); print $2}')
BC_SHAR=$(printf '%s\n' "$BC_DU" | awk -F':' '/^Shared:/{gsub(/[[:space:]]/,"",$2); print $2}')
BC_PRIV_GO=$(printf '%s' "${BC_PRIV:-0}" | awk '{gsub(/GB/,""); gsub(/MB/,"e-3"); printf "%d", $0+0}')
if [ -n "$BC_PRIV" ]; then
  echo "     decomposition reelle : Private ${BC_PRIV} (gouverne par keepStorage) + Shared ${BC_SHAR} (partage avec des images VIVANTES, hors de portee du ramasse-miettes)"
  MESURE_BC="$BC_PRIV"; REF_BC="$BC_PRIV_GO"
else
  echo "     ⚠️ 'docker buildx du' n'a rien rendu : on retombe sur le TOTAL de docker system df,"
  echo "        qui inclut les couches partagees — le verdict ci-dessous est alors trop severe."
  MESURE_BC="$BC"; REF_BC="${BC_GO:-0}"
fi
if [ "${REF_BC:-0}" -ge "$SEUIL_BC" ]; then
  verdict "cache de build (Private)" "$MESURE_BC" "< ${SEUIL_BC} Go" ko "il ECHAPPE a son ramasse-miettes (plafond ${GC_GO:-?} Go) — docker buildx prune -af --filter until=168h"
else
  verdict "cache de build (Private)" "$MESURE_BC" "< ${SEUIL_BC} Go" ok "contenu par son ramasse-miettes (plafond ${GC_GO:-?} Go) ; total affiche par docker system df = $BC"
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
# ⚠️ CORRIGE LE 2026-08-05, meme erreur que pour dockerd : « residu d'un pic ancien, un
# redemarrage le rend » etait faux. Le swap est retombe a 0 au redemarrage du 2026-08-04 a
# 21:32, puis remonte a 835 Mo en cinq heures — le temps d'un build. Ce n'est pas un residu,
# c'est le prix des builds sur une machine a 7,8 Go. Ce qui compte n'est donc PAS le volume
# swappe mais la PRESSION memoire (PSI, section 2) : tant que `memory full` reste a 0, la
# machine ne s'arrete jamais faute de RAM, et le swap fait exactement son travail.
[ "${SWU:-0}" -le 200 ] && verdict "swap utilise" "${SWU} Mo" "< 200 Mo" ok "" \
  || verdict "swap utilise" "${SWU} Mo (uptime $(awk '{printf "%.1f", $1/3600}' /proc/uptime) h)" "< 200 Mo" ko "revient apres chaque build — juger a la pression PSI, pas au volume"

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
# ⚠️ CORRIGE LE 2026-08-05 — l'explication precedente etait FAUSSE. On disait « dockerd gonfle
# avec l'uptime, un redemarrage le remet a ~150 Mo ». Mesure apres le redemarrage du 2026-08-04 :
# 131 Mo a 21:32, puis 826 Mo cinq heures plus tard, sans aucun rapport avec l'uptime — un build
# de 3,5 Go a 01:44 suffit. Le « gain de 730 Mo » attribue au redemarrage a donc vecu 5 heures.
# Conclusion pratique : ne JAMAIS redemarrer la machine pour recuperer la memoire de dockerd.
# On redemarre pour le noyau ; le reste revient tout seul.
DUP=$(ps -o rss= -p "$(pgrep -o dockerd)" 2>/dev/null | awk '{printf "%d", $1/1024}')
UPH=$(awk '{printf "%.1f", $1/3600}' /proc/uptime)
[ "${DUP:-0}" -le 400 ] && verdict "memoire de dockerd" "${DUP} Mo (uptime ${UPH} h)" "< 400 Mo" ok "" \
  || verdict "memoire de dockerd" "${DUP} Mo (uptime ${UPH} h)" "< 400 Mo" ko "suit les BUILDS, pas l'uptime — un redemarrage ne regle rien de durable"

# ⚠️ AJOUTE LE 2026-08-10 (VPS-M24) — LE BUDGET ETAIT INSTRUMENTE, JAMAIS ARBITRE.
# VPS-M16 avait pose les `[t+Ns]` sur chaque en-tete de section : on savait donc OU le temps
# passait. Mais aucune ligne ne disait si le budget de 90 s etait tenu — il fallait lire la
# derniere section, en soustraire l'heure de depart, et connaitre la limite de tete.
# Resultat : le 2026-08-10, la collecte a mis 300 s (3,3× le budget) et la sortie ne le dit
# nulle part. Un budget dont le depassement ne produit aucune ligne n'est pas un budget, c'est
# une intention. Il porte desormais son verdict, et la charge ambiante avec lui — parce que
# VPS-M16 et VPS-M18 ont etabli qu'une duree n'est pas une propriete du script seul, mais du
# script × la machine × le moment : accuser le script sans citer la charge, c'est refaire
# l'erreur du 2026-08-06.
DUREE=$(( $(date +%s) - T_DEBUT ))
printf '\n\n═════ BUDGET DE LA COLLECTE ═════\n'
printf '  duree totale : %s s   (budget impose : %s s)\n' "$DUREE" "${BUDGET:-90}"
printf '  charge de la machine a la fin : %s\n' "$(cut -d' ' -f1-3 /proc/loadavg)"
awk -v d="$DUREE" -v b="${BUDGET:-90}" 'BEGIN{
  if (d <= b) print "  ✅ DANS LE BUDGET."
  else {
    printf "  🔴 DEPASSEMENT : %+d s, soit %.1f× le budget.\n", d-b, d/b
    print  "     Avant d accuser le script : relire la charge ci-dessus et les [t+Ns] des sections."
    print  "     Un script en priorite idle attend d autant plus que la machine est occupee"
    print  "     (VPS-M16). Le depassement est un SYMPTOME tant que la cause n est pas nommee."
  }
}'
printf '\n\nFIN DE COLLECTE — %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
