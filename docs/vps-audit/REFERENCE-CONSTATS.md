# Référentiel des constats VPS

La **mémoire longue** de l'audit. Une fiche par constat, qui survit à la rotation des journaux
système (7 jours pour `sysstat`, ~2,5 jours pour `auth.log`) et au redémarrage des conteneurs.

Un constat n'est **jamais supprimé** : quand il est réglé, il passe en `APPLIQUE` avec la date
et le gain réellement obtenu. C'est ce qui permet, six mois plus tard, de répondre à *« on avait
déjà vu ça ? »* — et de reconnaître une rechute.

## Barème des statuts

| Statut | Signification |
|---|---|
| `A_TRAITER` | Défaut réel, correctif connu, rien n'est fait. |
| `CORRECTIF_PROPOSE` | Le correctif est écrit et vérifiable, il attend une décision ou une fenêtre. |
| `SURVEILLANCE` | Réel mais sans effet aujourd'hui. On mesure à chaque passage ; on agit si un seuil est franchi. |
| `APPLIQUE` | Corrigé **et vérifié**. La fiche reste, avec la preuve. |
| `ACCEPTE` | Connu, compris, volontairement non corrigé. La raison est écrite — sinon ça revient chaque mois. |

---

## VPS-001 — Le cache de build Docker n'est jamais purgé

- **Domaine** : disque · **Gravité** : 1 · **Statut** : `APPLIQUE` (2026-08-04, 17 h 40)
- **Vu** : 2026-08-04 · **Mesure à la découverte** : 33,59 Go, 250 entrées, **0 active**

> ### ✅ Corrigé le 2026-08-04 — la preuve
>
> `docker buildx prune -af` exécuté en 3 min 34.
>
> | | Avant | Après |
> |---|---:|---:|
> | Disque utilisé | 78 Go (**81 %**) | 46 Go (**48 %**) |
> | Espace libre | 19 Go | **51 Go** |
> | Cache de build | 35,13 Go / 263 entrées | **0** |
> | Conteneurs actifs | 31 | **31** |
>
> **32 Go rendus, aucune interruption** : 0 anomalie sur 31 conteneurs après la purge, images
> de production intactes, les trois domaines publics répondent en 200.
>
> ⚠️ **Le cache se reconstitue à chaque build.** Il était déjà remonté de 33,6 à 35,1 Go en une
> journée, à cause des deux déploiements du jour. Ce n'est donc pas une correction définitive :
> **surveiller à chaque passage**, et repurger quand il repasse au-dessus de ~15 Go. Le seuil
> se juge à l'espace libre, pas au cache seul.

**Quoi.** Un nettoyage automatique tourne pourtant chaque nuit à 00 h 40
(`/etc/cron.d/docker-image-prune`) : `docker image prune -af --filter "until=24h"`.
Mais `image prune` et le **cache de build** sont deux magasins distincts. Le ménage vise les
images ; les couches intermédiaires de `buildx` s'accumulent à côté, sans limite.

**Pourquoi c'était invisible.** Une tâche de nettoyage existe et réussit tous les jours. Rien
ne signale qu'elle range la moitié qui n'avait pas de problème. Le seul indice est dans
`docker system df` : `Build Cache · ACTIVE 0 · 33,59 Go`.

**Quoi faire.** `docker buildx prune -af`

**Gain** : 33,6 Go — de 79 % à ~44 % d'occupation à lui seul.
**Contrepartie** : le premier build de chaque projet repart de zéro (2 à 4× plus long).
**À ne pas faire** : ajouter ce prune au cron nocturne sans y réfléchir — on paierait la
reconstruction du cache à chaque déploiement. Un `--filter "until=168h"` hebdomadaire est le
bon compromis.

---

## VPS-002 — root accessible en SSH par mot de passe, sans ralentisseur

- **Domaine** : sécurité · **Gravité** : 1 · **Statut** : `A_TRAITER`
- **Vu** : 2026-08-04 · **Mesure** : 175 échecs / 2,5 j, dont **28 sur `root`** ; `fail2ban` absent

**Quoi.** `sshd` accepte `PermitRootLogin yes` **et** `PasswordAuthentication yes`, et `root`
est le seul compte à avoir un mot de passe défini. Le port 22 est ouvert à Internet
(légitimement). Il ne manque donc que le mot de passe pour entrer en root, et rien ne limite
le nombre d'essais.

**Pourquoi c'était invisible.** Le pare-feu est bien configuré, les clés SSH fonctionnent, et
on se connecte par clé au quotidien — l'authentification par mot de passe reste ouverte
*en plus*, sans jamais servir. Rien dans l'usage normal ne la rappelle.

**Quoi faire.** Dans cet ordre, sans l'inverser :
1. `ssh -o PasswordAuthentication=no root@72.62.26.240 "echo OK"` — **prouver** que la clé marche.
2. `PasswordAuthentication no` dans `/etc/ssh/sshd_config`, puis `sshd -t && systemctl reload sshd`.
3. `apt install -y fail2ban && systemctl enable --now fail2ban`.

**À ne pas faire** : couper les mots de passe avant l'étape 1. C'est le seul moyen de se
retrouver enfermé dehors. Et ne jamais recharger `sshd` sans `sshd -t` d'abord.

---

## VPS-003 — La sauvegarde tourne deux fois par jour

- **Domaine** : sauvegardes · **Gravité** : 3 · **Statut** : `A_TRAITER`
- **Vu** : 2026-08-04 (remonte au moins au 2026-07-05) · **Mesure** : 62 fichiers pour 31 jours

**Quoi.** Le même script `/opt/vizyo-tracky/deploy/vps/backup-db.sh` est déclenché par **deux**
planificateurs : la crontab de root (`0 3 * * *`) et le timer systemd `tracky-backup.timer`
(`OnCalendar=03:00:00`). Les deux réussissent, à deux minutes d'intervalle.

**Pourquoi c'était invisible.** Les deux marchent. Le journal `/var/log/tracky-backup.log` ne
reçoit que la sortie du **cron** (c'est lui qui redirige) ; l'exécution du timer va dans
`journald`. Chaque journal montre donc **une** sauvegarde par jour, parfaitement normale.
Le doublon n'apparaît qu'en listant le dossier de destination.

**Quoi faire.** `crontab -l | grep -v 'backup-db.sh' | crontab -` — garder le timer, qui
journalise proprement et survit mieux aux redémarrages.

**Gain** : ~3,4 Go, et un `pg_dump` concurrent en moins à 3 h du matin sur 2 vCPU.
**À ne pas faire** : supprimer les deux. Vérifier le lendemain avec
`journalctl -u tracky-backup.service --since yesterday`.

---

## VPS-004 — Le témoin de bonne santé des sauvegardes n'a jamais émis

- **Domaine** : sauvegardes · **Gravité** : 2 · **Statut** : `CORRECTIF_PROPOSE`
- **Vu** : 2026-08-04 · **Mesure** : `WARN: API_URL or INTERNAL_API_SECRET not set` à **chaque** exécution

**Quoi.** Le script sait signaler ses succès à l'API (`POST /api/internal/backup-health`), mais
`API_URL` et `INTERNAL_API_SECRET` ne sont pas définis dans son environnement. L'appel est
donc systématiquement sauté.

**Pourquoi c'est grave malgré la gravité 2.** La sauvegarde marche — le risque n'est pas la
perte de données *aujourd'hui*. Le risque est qu'elle s'arrête **demain** sans que rien ne le
dise : le fichier n'apparaîtrait plus, et personne ne surveille un dossier pour vérifier qu'il
grossit. C'est une garde écrite et branchée nulle part : elle rassure et ne protège pas.

**Quoi faire.** Ajouter dans `/etc/systemd/system/tracky-backup.service` :
```ini
Environment="API_URL=https://<domaine-api>"
Environment="INTERNAL_API_SECRET=<même valeur que côté API>"
```
puis `systemctl daemon-reload`.

**Preuve attendue** : la ligne `WARN` **disparaît** du journal du lendemain. Tant qu'elle est
là, le correctif n'a pas pris — ne pas se contenter de l'avoir écrit.

---

## VPS-005 — Aucune limite mémoire sur aucun conteneur

- **Domaine** : docker · **Gravité** : 2 · **Statut** : `SURVEILLANCE`
- **Vu** : 2026-08-04 · **Mesure** : 31/31 conteneurs à `memlimit=0`, `cpus=0` ; **0 OOM en 30 j**

**Quoi.** Aucun conteneur n'a de plafond. Si l'un s'emballe, l'`OOM killer` du noyau choisit sa
victime selon un score de mémoire, pas selon l'importance métier : une fuite dans un conteneur
de développement peut faire tomber `tracky-postgres`.

**Pourquoi c'est en surveillance et non à traiter.** La mémoire tourne à 25 % en moyenne, avec
un pic à 44 % sur 7 jours, et **aucun OOM en 30 jours**. Le risque est réel mais dormant.

**Seuil de réescalade** : passer en `A_TRAITER` si la mémoire moyenne dépasse 60 %, ou au
premier OOM observé.

**Quoi faire le moment venu.** `deploy.resources.limits.memory` service par service dans
`docker-compose.prod.yml`, en partant du double de la consommation observée (`tracky-api` :
221 Mo → 1 Go). Borner Redis en même temps (`maxmemory` + `allkeys-lru`), aujourd'hui à `0` +
`noeviction`.

---

## VPS-006 — 17 conteneurs arrêtés depuis 7 semaines

- **Domaine** : docker · **Gravité** : 3 · **Statut** : `A_TRAITER`
- **Vu** : 2026-08-04 · **Mesure** : 17 arrêtés / 48 ; ~5,7 Go d'images retenues

**Quoi.** Des piles entières (`foodsqan-*`, `maalem-*` anciens, `vizyo-leads-*`, `nebula`) sont
arrêtées depuis 7 semaines. Tant que le conteneur existe, son image ne peut pas être libérée —
c'est ce qui explique que `docker image prune -af` nocturne ne récupère rien.

**Quoi faire.** `docker container prune --filter "until=720h"`

**Gain** : ~5,7 Go.
**À vérifier avant** : que ces piles sont bien abandonnées et non en pause. `maalem-api` est
sorti en **137** (tué) — s'il doit revivre, le sortir de la liste.

---

## VPS-007 — `random_page_cost` réglé pour un disque mécanique

- **Domaine** : données · **Gravité** : 3 · **Statut** : `CORRECTIF_PROPOSE`
- **Vu** : 2026-08-04 · **Mesure** : `random_page_cost = 4` (défaut historique)

**Quoi.** La valeur `4` dit au planificateur qu'un accès aléatoire coûte 4× un accès
séquentiel — vrai sur un disque à plateaux, faux sur SSD/NVMe. Conséquence : le planificateur
**préfère des parcours de table complets là où un index serait plus rapide**.

**Pourquoi c'est invisible.** Aucune erreur, aucun ralentissement visible : la base fait
976 Mo et tient en cache à 98,87 %. L'effet ne se paierait qu'en grossissant.

**Quoi faire.** `ALTER SYSTEM SET random_page_cost = 1.1; SELECT pg_reload_conf();`
Réversible instantanément.

---

## VPS-008 — `position_sampling_decisions` pèse 55 % de `positions`

- **Domaine** : données · **Gravité** : 3 · **Statut** : `SURVEILLANCE`
- **Vu** : 2026-08-04 · **Mesure** : 208 Mo / 517 097 lignes (contre 376 Mo pour `positions`)

**Quoi.** Table de **diagnostic** : elle enregistre pourquoi chaque position a été gardée ou
jetée. Très utile pour régler l'échantillonnage, beaucoup moins une fois le réglage stabilisé.

**Quoi faire.** Question produit avant tout : *cette table a-t-elle encore un lecteur ?* Si non,
une rétention à 7 jours rendrait ~180 Mo et allégerait chaque `pg_dump`.

**Seuil de réescalade** : si elle dépasse le poids de `positions`, ou si la base franchit 3 Go.

---

## VPS-009 — Volumes Docker orphelins contenant des données

- **Domaine** : docker · **Gravité** : 4 · **Statut** : `ACCEPTE`
- **Vu** : 2026-08-04 · **Mesure** : 5 volumes, 204 Mo, dont `vizyo-tracky-postgres-data` (110 Mo)

**Quoi.** Cinq volumes ne sont montés par aucun conteneur. Le plus gros est une base Postgres
Tracky détachée, probablement l'ancêtre de `tracky-postgres-data` (1,1 Go) conservé lors d'une
migration. Deux autres sont des doublons nés d'un renommage de projet compose.

**Pourquoi on l'accepte.** 204 Mo sur 96 Go, contre des données non reconstituables. Le gain
ne justifie pas le risque, et c'est un arbitrage humain — pas une décision d'agent.

**À ne pas faire** : `docker volume prune`. La commande ne fait pas la différence entre un
cache jetable et une base de données.

**Réexaminer si** : le disque repasse au-dessus de 80 % après les nettoyages VPS-001 et VPS-006.

---

## VPS-010 — Noyau non redémarré, 59 paquets en retard

- **Domaine** : sécurité · **Gravité** : 2 · **Statut** : `A_TRAITER`
- **Vu** : 2026-08-04 · **Mesure** : tourne sur 6.8.0-**134**, 6.8.0-**136** installé

**Quoi.** `unattended-upgrades` fait son travail — les paquets s'installent. Mais le noyau ne
devient actif qu'au redémarrage, et la machine a 28 jours d'uptime. `libc6` et `linux-base`
attendent aussi.

**Quoi faire.** Planifier un redémarrage hors heures de suivi GPS. Il règle **trois** choses
d'un coup : le noyau, les 1,1 Go de mémoire résidente de `dockerd`, et le swap résiduel
(~936 Mo jamais repris).

**À vérifier après** : que les 31 conteneurs remontent — ils sont tous en
`restart: unless-stopped`, donc ça devrait être automatique, mais `docker ps` le confirme en
10 secondes.

---

## VPS-011 — Les healthchecks sont la première charge de fond, et personne ne les voit

- **Domaine** : docker · **Gravité** : 3 · **Statut** : `A_TRAITER`
- **Vu** : 2026-08-04 · **Mesure** : 88 invocations/min = **126 720/jour** ; 1 398 processus/min créés au total

**Quoi.** Les crons et les timers se déclarent quelque part — on peut les lister. Les
healthchecks Docker, non : ils sont une propriété du conteneur, et rien ne les agrège. Ils
constituent pourtant **la première source de création de processus de la machine**.

Le coût réel n'est pas « une commande » : chaque passage déclenche une chaîne `runc exec`
complète — `runc` → `[0:PARENT]` → `[1:CHILD]` → `[2:INIT]` → la commande — soit **~5
processus**. Et les 10 sondes de base de données ouvrent **en plus** un backend PostgreSQL à
chaque fois (visible en `[local] startup` dans la table des processus).

| Cadence | Conteneurs | Invocations/min |
|---|---:|---:|
| toutes les 10 s | 10 (7 Postgres, 1 MariaDB, 2 Redis) | 60 |
| toutes les 30 s | 14 (API et frontaux) | 28 |
| **total** | **24** | **88** |

**Pourquoi c'était invisible.** Aucune commande ne les liste ensemble. `docker ps` montre
`(healthy)`, pas la fréquence. Et le coût est diffus : ~11 % de CPU non-inactif cumulé, réparti
sur toutes les secondes de la journée — jamais un pic, donc jamais une alerte.

**Quoi faire.** Espacer les sondes des piles **de développement** et des bases, où 10 s
n'apporte rien : une base qui tombe est détectée en 30 s aussi bien qu'en 10 s.

```yaml
healthcheck:
  interval: 30s     # au lieu de 10s, sur les stacks -dev et les bases
```

**Gain** : passer les 10 sondes de 10 s à 30 s retire **40 invocations/min**, soit 57 600
exécutions par jour et ~200 000 créations de processus quotidiennes en moins.
**À ne pas faire** : toucher aux sondes de `tracky-api` et `tracky-postgres` en production —
c'est là que la détection rapide sert vraiment.

---

## Constats de méthode (sur l'audit lui-même)

### VPS-M04 — Le crontab Alpine des conteneurs est un faux positif

- **Vu** : 2026-08-04 · **Statut** : `ACCEPTE` (documenté pour ne pas le re-signaler)

Un balayage des conteneurs remonte un crontab dans **24 d'entre eux** :

```
*/15 * * * *  run-parts /etc/periodic/15min
0    2 * * *  run-parts /etc/periodic/daily
```

Ça ressemble exactement à ce qu'on cherche — des tâches planifiées cachées. **C'est inerte** :
toute image Alpine embarque ce fichier, mais `crond` n'est pas lancé dans ces conteneurs
(`ps | grep crond` = 0) et `/etc/periodic/*` est vide (0 script). Vérifié sur 6 conteneurs.

**Leçon générale** : un fichier de configuration n'est pas une preuve d'exécution. Avant de
signaler une tâche planifiée, vérifier que **quelque chose la lit**. Le collecteur affiche
désormais `crond_actif/scripts = 0/0` pour rendre cette vérification visible plutôt que
d'omettre le sujet.

### VPS-M05 — L'audit a dépassé son propre budget, et deux mesures étaient fausses

- **Vu** : 2026-08-04 · **Statut** : `APPLIQUE` (corrigé le jour même)

L'ajout de la section « charge de fond » a introduit trois défauts d'un coup :

1. **99 secondes de collecte** — au-dessus des 90 s que cette même procédure impose. La cause :
   une fenêtre de mesure de 20 s pour compter les créations de processus. Ramenée à 10 s
   (44 s au total). *Un audit qui viole sa propre règle pour mieux mesurer se trompe de priorité.*
2. **Le tableau « récupérable » était faux** : `docker system df` affiche « Local Volumes », un
   libellé **contenant un espace**, qui décale les colonnes d'un cran sur cette ligne. Le `$NF`
   en awk ramenait `(100%)` au lieu de la taille. Corrigé en passant par `--format`.
3. **Deux `docker exec` successifs par conteneur** pour une seule question : leurs sorties se
   mélangeaient sur des lignes différentes, et chaque appel coûtait une chaîne `runc` — l'audit
   ajoutait à la charge qu'il venait de dénoncer. Fusionnés en un seul appel.

**Leçon générale** : une sortie tabulée dont un libellé contient un espace n'est pas
analysable en positionnel. Quand un outil propose `--format`, l'utiliser.

### VPS-M01 — Compter les IP sur `from <IP>` mélange succès et échecs

- **Vu** : 2026-08-04 · **Statut** : `APPLIQUE` (corrigé dans `collecte.sh` le jour même)

La première passe a désigné `82.67.153.51` comme « principale IP attaquante » avec 931
occurrences. Vérification faite : **485 connexions acceptées, 0 échec** — c'est un accès
légitime. Le motif `from <IP>` capture toutes les lignes, y compris les succès.

**Ce que ça aurait coûté** : bannir une IP d'administration valide, sur la foi d'un rapport.

**Correctif appliqué** : filtrer les lignes d'échec **avant** de compter, et afficher à part
les IP dont des connexions ont réussi, pour qu'on les reconnaisse.

**Leçon générale** : un compteur d'incidents doit prouver qu'il compte des *incidents*. Ici,
il comptait des *lignes*.

### VPS-M03 — Les ancres du manifeste étaient toutes fausses

- **Vu** : 2026-08-04 · **Statut** : `APPLIQUE` (corrigé le jour même)

Les 12 fiches du manifeste portaient un champ `ancre` écrit à la main pour permettre au
tableau de bord de sauter au bon endroit du référentiel. **Les 12 étaient fausses** : elles
gardaient les accents (`purgé`) et un double tiret issu du `—` du titre, là où
`slugifyHeading` produit `purge` et un tiret simple.

**Ce que ça coûtait** : douze liens morts dans l'écran, sans la moindre erreur — un clic qui
ne fait rien ne se signale nulle part.

**Pourquoi c'était invisible.** Un champ de confort, écrit à la main, jamais confronté à sa
source. Ni `tsc`, ni les tests, ni le rendu markdown ne peuvent le voir : l'ancre est une
chaîne libre dans un fichier JSON.

**Correctif appliqué** : les ancres sont désormais **dérivées** du fichier source par le
même algorithme que le rendu, et la procédure (§6) impose de lancer cette vérification avant
publication.

**Leçon générale** : un identifiant recopié à la main dans deux fichiers finit toujours par
diverger. Le dériver de sa source, ou le vérifier automatiquement — mais ne pas l'écrire deux fois.

### VPS-M02 — Un `timeout` qui expire produit du silence, pas une alerte

- **Vu** : 2026-08-04 · **Statut** : `APPLIQUE`

`timeout 120 du -sh /var/lib/docker/rootfs` dépassait son délai sur 12 Go de couches. Résultat :
section **vide**, indiscernable de « rien à signaler ».

**Correctif appliqué** : délai porté à 300 s **et** message explicite
« mesure ABANDONNÉE après 300 s » quand il expire.

**Leçon générale** : dans un rapport, l'absence de mesure et la mesure nulle doivent se lire
différemment. C'est la même famille de défaut que VPS-004 (une garde qui ne dit rien quand
elle ne fonctionne pas).
