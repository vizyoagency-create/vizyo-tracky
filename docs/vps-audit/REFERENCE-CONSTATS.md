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
- **Vu** : 2026-08-13 · **Mesure du jour** : total `docker system df` **36,42 Go / 182 entrees** — mais la seule grandeur que `keepStorage` gouverne, `Private`, vaut **10,39 Go** contre 10,37 la veille : **+0,02 Go en 24 h sur un plafond de 10 Go**. Les 26,03 Go de `Shared` sont les couches des **huit images construites le 08-12**, partagees avec des images VIVANTES et hors de portee du ramasse-miettes par construction. ⚠️ **C'est le jour ou ce constat a montre sa limite** : le mecanisme a tenu sa borne a 0,2 % pres pendant que le disque perdait 23 Go — voir **VPS-025**. **NE PAS purger** : `buildx prune -af` ne rendrait que les 10,39 Go de `Private`, qui reviennent au prochain build. *(mesure du 2026-08-12, conservee : total `docker system df` 10,39 Go / 77 entrees* — `Private` **10,37 Go** (plafond 10 Go, 4 % au-dessus) + `Shared` **23 Mo** (contre 1,68 Go la veille). Le disque a rendu 2 points de plus (53 % -> 51 %) sans qu'aucune commande n'ait ete lancee, troisieme passage consecutif. Dernier build : `tracky-api:latest` le 2026-08-11 a 22 h 34 min 12, `cache.db` de BuildKit modifie 5 min plus tard — le mecanisme se declenche bien AVEC les builds. **NE PAS purger.** *(mesure du 2026-08-11, conservee : total `docker system df` 12,19 Go / 99 entrees* — en BAISSE de 1,63 Go sans qu'aucune commande n'ait ete lancee ; decomposition `docker buildx du` : **Private 10,51 Go** (la seule grandeur que `keepStorage` gouverne, plafond 10 Go — 5 % au-dessus) + **Shared 1,68 Go** (contre 3,39 la veille). Le ramasse-miettes travaille : c'est lui qui a rendu 2 points de disque (55 % → 53 %). **NE PAS purger.**)*
- **Mesure à la découverte (2026-08-04)** : 33,59 Go, 250 entrées, **0 active**

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
>
> ### ✅ Confirmé résolu le 2026-08-05 — la borne permanente tient
>
> Mesure du lendemain : **10,53 Go**, pour un plafond de ramasse-miettes déclaré à **10 Go**.
> Le cache s'est intégralement reconstitué en une nuit de build **et s'est arrêté tout seul**.
> C'est la démonstration que le mécanisme permanent (`daemon.json`, ramasse-miettes BuildKit)
> valait mieux qu'une tâche planifiée : il régule sans risque de doublon (défaut VPS-003).
>
> ⚠️ **Ne PAS purger ce cache aujourd'hui.** Il est contenu. Purger rendrait 10 Go pour
> quelques heures et coûterait un premier build 2 à 4× plus long, alors qu'il reste 47 Go
> libres. Le seuil d'alerte du collecteur, qui valait 10 Go — soit exactement la cible du
> ramasse-miettes — produisait une fausse alerte quotidienne ; corrigé (VPS-M10).
>
> ### ⚠️ 2026-08-06 — le même chiffre, et il veut dire l'inverse
>
> Mesure du jour : **10,53 Go / 93 entrées**. Hier : **10,53 Go / 93 entrées**. À la décimale
> près. Hier ce nombre a été lu comme la preuve que le ramasse-miettes fonctionne
> (« il s'est arrêté tout seul à sa borne »). Aujourd'hui il dit le contraire :
> `/var/lib/docker/buildkit/cache.db` **n'a plus été modifié depuis le 2026-08-05 à 01 h 50**,
> soit avant l'emballement de `dockerd` (VPS-016). Le ramasse-miettes **ne tourne plus**. Le
> cache est **gelé au-dessus de son plafond**, pas régulé en dessous.
>
> **La leçon** : *identique à la décimale près* n'est pas *stable*, c'est *figé*. Une valeur
> régulée oscille autour de sa cible ; une valeur qui ne bouge pas d'un octet en 24 h dit que
> le mécanisme censé la faire bouger est arrêté. Il a fallu un **troisième** point de mesure
> pour trancher — les deux premiers étaient compatibles avec les deux lectures.
>
> **Aucune action** : le cache se régulera seul dès que `dockerd` aura été redémarré (VPS-016).
> Le purger, c'est traiter le symptôme d'un symptôme.
>
> ### ❌ 2026-08-07 — ce diagnostic du 08-06 était FAUX. Le ramasse-miettes fonctionne.
>
> Troisième mesure identique : **10,53 Go / 93 entrées**. La veille, j'en avais conclu que le
> ramasse-miettes de BuildKit était arrêté, sur la foi d'un `cache.db` non modifié depuis le
> 2026-08-05 à 01 h 50. Il manquait **un cran** :
>
> ```
> dernier build (declencheur du ramasse-miettes) : 2026-08-05 01:50:20
> cache.db de BuildKit modifie le                : 2026-08-05 01:50:20
> ```
>
> **La même seconde.** Le ramasse-miettes BuildKit se déclenche **avec les builds** ; sans build,
> il n'a aucune raison de tourner et `cache.db` aucune raison d'être réécrit. L'écriture disque
> du 08-06 le confirme indépendamment : **24 blocs/s**, le chiffre le plus bas de la semaine —
> personne n'a rien construit depuis 48 h.
>
> **Les trois lectures successives du même 10,53 Go** :
>
> | Passage | Conclusion | Verdict |
> |---|---|---|
> | 2026-08-05 | « il s'est arrêté tout seul à sa borne » | vrai par accident |
> | 2026-08-06 | « le ramasse-miettes ne tourne plus, le cache est gelé » | **faux** |
> | 2026-08-07 | « le mécanisme n'a rien eu à faire » | établi par deux sources |
>
> **La règle, écrite pour ne plus la repayer** : pour lire une valeur qui ne bouge pas, il faut
> **trois** choses — la valeur, la fraîcheur de son producteur, et la fraîcheur de **ce qui
> déclenche** le producteur. Avec une seule, on invente ; avec deux, on se trompe dans l'autre
> sens. Le collecteur affiche désormais les trois d'un coup, avec verdict automatique.
>
> **Aucune action, et cette fois pour la bonne raison** : le cache est à sa borne, le mécanisme
> est sain, et il reste 48 Go libres.
>
> ### ✅ 2026-08-08 — le mécanisme AGIT : 2,9 Go rendus, disque 51 % → 48 %
>
> Il manquait le cas où le ramasse-miettes **fait quelque chose**. Le voici :
>
> | Mesure | 2026-08-07 | 2026-08-08 |
> |---|---:|---:|
> | Cache de build | 10,53 Go / 93 entrées | **7,60 Go / 87 entrées** |
> | Disque utilisé | 49 Go (51 %) | **46 Go (48 %)** |
> | Dernier build | 2026-08-05 01 h 50 | **2026-08-07 07 h 04 49 s** (`tracky-lp:latest`) |
> | `cache.db` de BuildKit | 2026-08-05 01 h 50 | **2026-08-07 07 h 04 49 s** |
>
> Un build a eu lieu, le ramasse-miettes s'est déclenché **avec lui**, à la même seconde, et il a
> ramené le cache **sous** sa borne — la politique `keepStorage: 8GB` sur ce qui n'a pas servi
> depuis 48 h. Un mécanisme cassé ne fait pas ça. **Le diagnostic du 08-06 est définitivement
> enterré, et cette fois par un événement plutôt que par un raisonnement.**
>
> **La règle posée le 08-07 a payé dès le lendemain** : valeur + fraîcheur du producteur +
> fraîcheur du déclencheur. Les quatre lectures successives du cache se lisent maintenant en
> série cohérente, ce qui est le vrai test d'une méthode.
>
> ⚠️ **Limite du détecteur, écrite avant qu'elle ne coûte** : « dernier build » vient de
> `docker images {{.CreatedAt}}`, la date de **création** de l'image. Pour une image *tirée* d'un
> registre, c'est la date de publication par son éditeur — un `docker pull` ferait donc croire à
> un build local. Le collecteur affiche désormais **le nom de l'image concernée** à côté de la
> date : si un jour la ligne désigne `postgres:17-alpine`, c'est un pull, et l'écart avec
> `cache.db` sera un faux positif.
>
> ### ⚠️ 2026-08-10 — 13,82 Go affichés, et ce n'est PAS la grandeur que le plafond gouverne
>
> | Mesure | 2026-08-09 | 2026-08-10 |
> |---|---:|---:|
> | Cache de build (total `docker system df`) | 8,56 Go / 82 entrées | **13,82 Go / 94 entrées** |
> | dont **`Private`** (gouverné par `keepStorage`) | — | **10,42 Go** |
> | dont **`Shared`** (partagé avec des images vivantes) | — | **3,39 Go** |
> | Disque utilisé | 47 Go (49 %) | **52 Go (55 %)** |
>
> Le total a bondi de 5,26 Go après **trois builds** la veille au soir (`maalem-dev-api` ~19 h,
> `deploy-api` et `deploy-web` à 21 h 26), déclenchés par la CI — les 9 connexions SSH
> supplémentaires de la clé `Y/gE+zS4…` en sont la trace, et `sysstat` le confirme
> indépendamment (**2 119 blocs/s en écriture le 08-09** contre 23 les jours calmes).
>
> **Lu naïvement, 13,82 Go contre un plafond de 10 Go dit « il déborde de 38 % ». C'est faux.**
> `docker buildx du` décompose : `Private` **10,42 Go** — la seule grandeur que `keepStorage`
> règle — soit **4 % au-dessus de sa borne**. Les 3,39 Go de `Shared` appartiennent aussi à des
> images en service ; le ramasse-miettes ne peut pas les libérer, et n'a jamais prétendu le faire.
>
> Ces 3,39 Go expliquent au passage une arithmétique qui semblait fausse : Images **+4,80 Go** et
> Build Cache **+5,26 Go** le même jour, pour un disque qui n'a grossi que de **5 Go**. Ce sont
> les mêmes octets, comptés dans les deux postes de `docker system df`.
>
> **Aucune action.** Le mécanisme tient sa borne, il reste 44 Go libres, et purger rendrait 10 Go
> qui reviendraient au prochain déploiement, au prix d'un premier build 2 à 4× plus long.
>
> ⚠️ **Le verdict du collecteur était vert — par accident.** La marge de 50 % posée par VPS-M10
> (seuil = 15 Go) absorbait exactement l'écart entre les deux grandeurs. Un quatrième build cette
> nuit-là et c'était une alerte rouge sur un mécanisme sain. Corrigé : voir **VPS-M25**.

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

- **Domaine** : sécurité · **Gravité** : 1 · **Statut** : `APPLIQUE` (2026-08-04, 18 h 20)
- **Vu** : 2026-08-04 · **Mesure à la découverte** : 175 échecs / 2,5 j, dont **28 sur `root`** ; `fail2ban` absent

> ### ✅ Corrigé le 2026-08-04 — la preuve
>
> | Vérification | Résultat |
> |---|---|
> | Méthodes annoncées par le serveur | **`publickey` seule** (le mot de passe n'est plus proposé) |
> | Connexion neuve par clé | ✅ réussie, avant *et* après |
> | `permitrootlogin` | `yes`, **inchangé** — l'accès par clé passe toujours |
> | Mot de passe root | **conservé** — la console de secours hPanel reste utilisable |
> | Les 4 clés autorisées | intactes, dont les 3 de déploiement GitHub Actions |
> | fail2ban | actif, prison `sshd` armée, bannissement **prouvé** sur une IP de test |
>
> Appliqué avec un **filet auto-réversible** : la modification s'annulait toute seule au bout
> de 7 minutes si une connexion neuve ne venait pas la confirmer. Elle a été confirmée.
>
> ### ⚠️ Trois pièges rencontrés à l'application — à connaître avant de refaire ça ailleurs
>
> **1. Le vrai `PasswordAuthentication yes` n'était pas dans `sshd_config`.**
> La ligne y est commentée. La valeur venait de `/etc/ssh/sshd_config.d/50-cloud-init.conf`,
> et un second fichier disait l'inverse (`60-cloudimg-settings.conf` : `no`). **sshd retient la
> PREMIÈRE valeur lue**, donc `50-` gagnait sur `60-`. Éditer `sshd_config` n'aurait **rien
> changé** — la config aurait eu l'air corrigée, la porte serait restée ouverte.
> → Correctif posé dans **`01-hardening.conf`** : `01` est lu avant `50`, donc il gagne. Et
> comme c'est un fichier distinct, une régénération de `50-cloud-init.conf` par cloud-init
> (au prochain redémarrage) ne le neutralisera pas.
>
> **2. Le service s'appelle `ssh`, pas `sshd`.** `systemctl reload sshd` échoue avec
> « Unit sshd.service not found », et `sshd -T` continue d'afficher la config *des fichiers* —
> pas celle du démon en cours. On croit donc avoir appliqué alors que rien n'a bougé.
>
> **3. La seule preuve qui vaut vient d'une connexion NEUVE.** `reload` ne coupe pas les
> sessions établies : la session courante fonctionne même si la configuration est cassée.

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

- **Domaine** : sauvegardes · **Gravité** : 3 · **Statut** : `APPLIQUE` (2026-08-04, 18 h 30)
- **Vu** : 2026-08-04 (remonte au moins au 2026-07-05) · **Mesure à la découverte** : 62 fichiers pour 31 jours

> ### ✅ Corrigé le 2026-08-04 — la preuve
>
> Ligne cron retirée (`crontab -l | grep -v 'backup-db.sh' | crontab -`), ancien crontab
> sauvegardé dans `/root/crontab.bak-20260804`. Le timer systemd est **conservé** : il est
> resté `enabled`, prochaine exécution le 2026-08-05 à 03:00 UTC.
>
> | | Avant | Après |
> |---|---:|---:|
> | Déclencheurs du même script | **2** (cron + timer) | **1** (timer) |
> | Sauvegardes par jour | 2 × ~130 Mo | 1 |
> | `pg_dump` concurrents à 3 h | oui | non |
>
> **Ce correctif en a résolu un second sans qu'on le prévoie** — voir VPS-004.
>
> ⚠️ **À vérifier demain matin** : `journalctl -u tracky-backup.service --since yesterday`
> doit montrer **une** exécution réussie. Si le timer ne prenait pas le relais, il n'y aurait
> plus **aucune** sauvegarde — c'est le seul vrai risque de ce correctif.

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

## VPS-004 — ~~Le témoin de bonne santé des sauvegardes n'a jamais émis~~ → **DIAGNOSTIC ERRONÉ**

- **Domaine** : sauvegardes · **Gravité** : — · **Statut** : `APPLIQUE` (annulé le 2026-08-04)
- **Vu** : 2026-08-04 · **Invalidé le jour même**

> ### ❌ Ce constat était FAUX. Il est conservé — un diagnostic erroné ne se supprime pas, il s'explique.
>
> **Ce que j'avais écrit** : le script sait signaler ses succès à l'API, mais `API_URL` et
> `INTERNAL_API_SECRET` ne sont pas définis, donc l'appel est systématiquement sauté — et si
> les sauvegardes s'arrêtaient, rien ne le dirait.
>
> **Ce qui était vrai** : `/etc/tracky-backup.env` contenait **déjà** les deux variables,
> correctement remplies, et le service systemd le charge via `EnvironmentFile`.
>
> | Source | Occurrences de `WARN: API_URL... not set` |
> |---|---:|
> | Exécutions par **timer** (journald) | **0** |
> | Exécutions par **cron** (`/var/log/tracky-backup.log`) | **99** |
>
> **La cause** : `cron` ne lit pas les `EnvironmentFile` de systemd. Le doublon cron tournait
> donc sans les variables et écrivait le `WARN` ; le timer, lui, faisait le travail depuis
> toujours. La table `backup_runs` de l'API le prouve — **7 jours de rapports `OK`** enregistrés.
>
> **Pourquoi je me suis trompé** : j'ai lu `/var/log/tracky-backup.log` et conclu sur
> l'ensemble du dispositif. Ce fichier ne reçoit que la sortie du **cron** (c'est lui qui
> redirige avec `>>`). La moitié de l'histoire était dans `journald`, et je ne l'ai pas
> ouverte. Voir **VPS-M07**.
>
> **Résolu par ricochet** : la suppression du doublon cron (VPS-003) a fait disparaître le
> `WARN`, puisqu'il n'y a plus que le timer.

---

## VPS-005 — Aucune limite mémoire sur aucun conteneur

- **Domaine** : docker · **Gravité** : 2 · **Statut** : `SURVEILLANCE` (Tracky partiellement traité le 2026-08-04)
- **Vu** : 2026-08-13 · **Mesure** : **30/33 sans limite memoire, 33/33 sans limite CPU** (un conteneur de plus, `dronely-devis`, arrive sans limite ni sonde) ; **0 OOM en 30 j**, memoire 32 %, PSI `full` = 0 sur les trois ressources — seuil de reescalade non atteint pour le **10e passage**. ⚠️ VPS-016 en est a sa 4e journee consecutive et n'a fait tomber AUCUN conteneur : c'est le processeur qui manque, pas la memoire. La limite **CPU**, absente sur 33/33, n'a toujours jamais ete posee. *(mesure du 2026-08-12, conservee : **29/32 sans limite mémoire, 32/32 sans limite CPU** (un conteneur de plus, `dronely-presentation`, arrive sans limite ni sonde) ; 0 OOM en 30 j, mémoire 36 %, PSI `full` = 0 — seuil de réescalade non atteint pour le 9e passage. ⚠️ VPS-016 en est a sa 3e occurrence et n'a fait tomber AUCUN conteneur : c'est le processeur qui manque, pas la memoire. La limite **CPU**, absente sur 32/32, n'a toujours jamais ete posee. *(mesure du 2026-08-11, conservee : 28/31 sans limite mémoire, 31/31 sans limite CPU* ; 0 OOM en 30 j — inchangé (mémoire 36 %, PSI `full` = 0 sur les trois ressources, seuil de réescalade non atteint pour le 8e passage). ⚠️ Ce passage en donne la meilleure illustration : `dockerd` a confisqué 1,7 cœur sur 2 pendant des heures (VPS-016) **sans qu'aucun conteneur ne tombe** — parce que c'est le processeur qui manquait, pas la mémoire. Une limite mémoire n'aurait rien changé ici ; c'est la limite **CPU**, absente sur 31/31, qui n'a jamais été posée.)*

> ### ⚠️ Précision apportée le 2026-08-05 — « Tracky traité » était trop généreux
>
> Les limites du 2026-08-04 ont été posées sur `tracky-api`, `tracky-postgres` et
> `tracky-redis`. Mais **`tracky-web` et `tracky-lp` n'en ont pas** — et si personne ne l'avait
> vu, c'est qu'ils étaient **absents de la table** que le collecteur produisait (défaut
> VPS-M08 : sept conteneurs disparaissaient en silence, ceux-là compris).
>
> L'enjeu est faible — ce sont deux frontaux statiques — mais la leçon ne l'est pas : **une
> vérification faite sur une liste incomplète produit une conclusion fausse sans jamais le
> dire.** La liste affiche désormais `31/31` à chaque passage.
>
> **Mesuré pour la première fois ce passage** : **aucun conteneur n'a de limite CPU** (0/31).

> ### ✅ Appliqué sur Tracky le 2026-08-04
>
> | Conteneur | Usage observé | Limite posée | Rapport |
> |---|---:|---:|---:|
> | `tracky-postgres` | 80 Mo | **1536 Mo** | ×19 |
> | `tracky-api` | 94 Mo | **1024 Mo** | ×11 |
> | `tracky-redis` | 1,1 Mo | **384 Mo** | ×350 |
>
> Les valeurs sont **volontairement généreuses**. Le but est de **confiner une fuite**, pas
> d'optimiser au plus juste : une limite serrée transforme un pic normal en redémarrage, et
> on aurait remplacé un risque théorique par une panne réelle.
>
> **Redis est borné en plus par l'intérieur** : `--maxmemory 256mb --maxmemory-policy
> allkeys-lru`. Sans ça, sa politique `noeviction` refusait les écritures au lieu d'oublier
> les vieilles clés — c'est le cache qui décidait quand tout le monde s'arrête.
>
> **Reste sans limite** : les 28 conteneurs des autres projets. Le vrai gain est déjà pris —
> la base et l'API de production ne peuvent plus être emportées par un voisin.

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

- **Domaine** : docker · **Gravité** : 3 · **Statut** : `APPLIQUE` (2026-08-04, 22 h 40)
- **Vu** : 2026-08-04 · **Mesure à la découverte** : 17 arrêtés / 48 ; ~5,7 Go d'images retenues

> ### ✅ Corrigé le 2026-08-04 — la preuve
>
> | | Avant | Après |
> |---|---:|---:|
> | Conteneurs (total / actifs) | 48 / 31 | **31 / 31** |
> | Images | 36 | **26** |
> | Disque | 54 Go (57 %) | 49 Go (51 %) |
> | **Volumes** | **28** | **28 — inchangé** |
>
> Les 17 étaient tous arrêtés depuis 52 à 55 jours. Codes de sortie relevés avant suppression :
> `maalem-api` et `vizyo-leads-api` en **137** (tués), `maalem-lp`, `foodsqan-api` et
> `foodsqan-website` en **255** (échec au démarrage), les autres en 0 (arrêt propre).
>
> ⚠️ **Aucun volume n'a été touché** — `docker container prune` n'y touche jamais. Vérifié
> nommément : `maalem-postgres-data` (65 Mo), `foodsqan-postgres-data` (71 Mo),
> `deploy_vizyo-leads-postgres-data` (64 Mo), `tracky-postgres-data` (1,1 Go) et
> `vizyo-tracky-postgres-data` (110 Mo) sont tous intacts.
>
> ### Le collecteur repère désormais TOUJOURS les conteneurs morts
>
> La section affichait autrefois une liste — donc **rien** quand il n'y avait rien, ce qui se
> lit comme « pas regardé ». Elle affiche maintenant un compte dans tous les cas, et surtout
> elle distingue deux choses que le comptage global confondait :
>
> - **l'encombrement** — arrêté depuis plus de 30 jours, c'est du ménage ;
> - **l'incident** — arrêté depuis moins de 48 h, c'est une panne, et c'est précisément la
>   ligne qu'une liste de 17 vieux conteneurs aurait noyée.
>
> Le **code de sortie** est interprété (`137` = tué, souvent la mémoire ; `255` = échec au
> démarrage ; `0` = arrêt volontaire) : c'est lui qui dit si un conteneur est mort ou a été
> arrêté.

**Quoi.** Des piles entières (`foodsqan-*`, `maalem-*` anciens, `vizyo-leads-*`, `nebula`) sont
arrêtées depuis 7 semaines. Tant que le conteneur existe, son image ne peut pas être libérée —
c'est ce qui explique que `docker image prune -af` nocturne ne récupère rien.

**Quoi faire.** `docker container prune --filter "until=720h"`

**Gain** : ~5,7 Go.
**À vérifier avant** : que ces piles sont bien abandonnées et non en pause. `maalem-api` est
sorti en **137** (tué) — s'il doit revivre, le sortir de la liste.

---

## VPS-007 — `random_page_cost` réglé pour un disque mécanique

- **Domaine** : données · **Gravité** : 4 · **Statut** : `A_TRAITER` — ⚠️ **ROUVERT le 2026-08-13 : il avait été fermé sur un dénominateur tronqué**
- **Vu** : 2026-08-13 · **Mesure du jour** : **5 bases sur 6 sont à `4`, dont TROIS de production** — `vizyo-verify-postgres` (pièces d'identité), `vizyo-manager-postgres` (Stripe, factures, clients) et `texto-postgres` (passerelle SMS). Seule `tracky-postgres` est à 1.1.
- **Mesure à la découverte (2026-08-04)** : `random_page_cost = 4`

> ### 🔄 2026-08-13 — ce constat était clos depuis neuf passages, sur une phrase fausse
>
> Le bloc « ✅ Corrigé le 2026-08-04 » ci-dessous se termine par :
> *« Reste à 4 sur `maalem-dev-postgres` et `maestroo-dev-postgres` : bases de **développement**,
> aucun enjeu de plan de requête. »*
>
> **Cette phrase a été écrite en lisant une liste qui ne contenait que trois des six bases.** Le
> levier 4 du collecteur portait un `head -3` qui ne gardait que les trois premiers conteneurs
> dans l'ordre — arbitraire — de `docker ps`. Corrigé ce jour (**VPS-M34**), il rend :
>
> | Base | `random_page_cost` | Nature |
> |---|---:|---|
> | `tracky-postgres` | **1.1** | production ✅ |
> | **`vizyo-verify-postgres`** | **4** | **production** — pièces d'identité |
> | **`vizyo-manager-postgres`** | **4** | **production** — Stripe, factures, clients |
> | **`texto-postgres`** | **4** | **production** — passerelle SMS |
> | `maestroo-dev-postgres` | 4 | développement |
> | `maalem-dev-postgres` | 4 | développement |
>
> **L'enjeu de performance reste nul, et il faut le dire aussi** : ces trois bases pèsent 8,3 à
> 8,7 Mo et tiennent en cache à **99,99 %**. Le planificateur ne peut pas se tromper de façon
> mesurable sur une table qui n'a aucune page à aller chercher. C'est exactement le raisonnement
> que cette fiche tenait déjà en 2026-08-04 (*« l'effet ne se paierait qu'en grossissant »*), et
> il vaut toujours.
>
> **L'enjeu de méthode, lui, n'est pas nul.** Un constat marqué `APPLIQUE` n'est plus relu ; celui-ci
> a porté pendant neuf passages une affirmation — *« il ne reste que des bases de développement »* —
> que personne ne pouvait contredire, parce que la mesure qui l'aurait contredite n'était pas
> affichée. C'est la famille VPS-M08 / VPS-M22 (*une liste qui n'annonce pas son dénominateur ne
> peut pas signaler qu'il en manque*), appliquée non plus à une mesure mais à une **conclusion
> archivée**.
>
> **Quoi faire** : `ALTER SYSTEM SET random_page_cost = 1.1; SELECT pg_reload_conf();` sur les
> **trois bases de production**. Réversible instantanément, aucune interruption.
> **À ne pas faire** : le passer aussi sur les deux bases de développement « tant qu'on y est ».
> Ce sont deux conteneurs à recréer pour zéro gain, et le point du jour est le *dénominateur*,
> pas le réglage.

> ### ✅ Corrigé le 2026-08-04 — `4` → `1.1` sur `tracky-postgres`
>
> `ALTER SYSTEM SET random_page_cost = 1.1;` puis `pg_reload_conf()`. Écrit dans
> `postgresql.auto.conf`, donc **persistant** — et le redémarrage de 23 h 32 l'a confirmé.
>
> Reste à 4 sur `maalem-dev-postgres` et `maestroo-dev-postgres` : bases de développement,
> aucun enjeu de plan de requête.

**Quoi.** La valeur `4` dit au planificateur qu'un accès aléatoire coûte 4× un accès
séquentiel — vrai sur un disque à plateaux, faux sur SSD/NVMe. Conséquence : le planificateur
**préfère des parcours de table complets là où un index serait plus rapide**.

**Pourquoi c'est invisible.** Aucune erreur, aucun ralentissement visible : la base fait
976 Mo et tient en cache à 98,87 %. L'effet ne se paierait qu'en grossissant.

**Quoi faire.** `ALTER SYSTEM SET random_page_cost = 1.1; SELECT pg_reload_conf();`
Réversible instantanément.

---

## VPS-008 — ~~`position_sampling_decisions` pèse 55 % de `positions`~~ → **RÉFUTÉ : elle a une rétention**

- **Domaine** : données · **Gravité** : 4 · **Statut** : `ACCEPTE` (réfuté le 2026-08-10)
- **Vu** : 2026-08-13 · **Mesure** : **206 Mo — a l'octet pres le meme qu'hier** — sur une fenetre glissante de **5 jours** (2026-08-09 → 2026-08-13). Le `min` n'a pas avance pendant que le `max` avancait : lu seul, ca ressemble a une purge qui n'a pas tourne. **La taille dit le contraire** — elle n'a pas bouge d'un Mo alors que l'estime de lignes monte de 29 % : la table reutilise les pages liberees. La fenetre oscille entre 4 et 5 jours selon l'heure de la purge relativement a celle de l'audit. *(mesure du 2026-08-12, conservee : 206 Mo sur une **fenêtre glissante de 4 jours** (2026-08-09 → 2026-08-12) — la fenêtre a glissé d'un jour exactement, comme `wire_logs`

> ### ❌ 2026-08-10 — ce constat reposait sur une hypothèse fausse, et une requête suffisait
>
> Le constat demandait depuis six passages : *« cette table a-t-elle encore un lecteur ? Si non,
> une rétention à 7 jours rendrait ~180 Mo. »* **La rétention existe déjà.**
>
> ```sql
> select min("receivedAt")::date, max("receivedAt")::date, count(distinct "receivedAt"::date)
>   from position_sampling_decisions;
>   2026-08-06 | 2026-08-10 | 5
> ```
>
> **Cinq journées.** Exactement comme `wire_logs`. Les 208 Mo sont le **régime permanent** d'une
> fenêtre glissante, pas une accumulation. Il n'y a pas 180 Mo à récupérer, il n'y a rien à
> arbitrer, et le seuil de réescalade (« si elle dépasse le poids de `positions` ») ne pouvait
> pas être atteint. **Supprimé, plutôt que laissé à surveiller pour toujours.**
>
> | Passage | Conclusion publiée | Ce qu'elle valait |
> |---|---|---|
> | 2026-08-05 | « elle double en une semaine » | tendance à 2 points, l'un un jour de redéploiement |
> | 2026-08-06 | « six fois moins » | corrigeait la précédente, même méthode |
> | 2026-08-07 | « elle a cessé de croître » | sous le bruit d'un facteur 150 (VPS-M20) |
> | 2026-08-08 | ~2 700 lignes/jour | ordre de grandeur sur un estimé |
> | **2026-08-10** | **fenêtre de 5 jours, régime permanent** | **établi par la plage de dates** |
>
> **La leçon, et c'est la deuxième fois en trois jours.** La même requête avait innocenté
> `wire_logs` le 2026-08-08, et le rapport de ce jour-là écrivait noir sur blanc : *« la même
> erreur guette `position_sampling_decisions`, qui affiche elle aussi 0 ligne morte. »*
> L'avertissement était juste, écrit, publié — et il a fallu **deux passages de plus** pour
> lancer la requête sur la table voisine. *Écrire qu'un piège est adjacent ne le désarme pas ;
> seule la mesure le désarme.* C'est **VPS-M22 à l'identique**, sur un autre objet : un garde qui
> n'est pas dans le code n'est pas un garde. Elle est désormais dans le collecteur.
>
> ### Ce que la même requête désigne à la place
>
> **`positions` : 63 jours contigus depuis le 2026-06-09, 1 426 101 lignes exactes, 386 Mo.**
> C'est la seule des trois grosses tables qui s'accumule — et c'est la plus grosse de la base.
> ⚠️ **63 jours ne prouvent pas l'absence de rétention**, seulement qu'aucune borne courte ne
> s'applique. Ça se tranche au passage suivant, gratuitement : si `min` reste au 2026-06-09
> pendant que `max` avance, il n'y a pas de rétention ; si `min` avance d'un jour par jour, son
> horizon est de ~63 jours. Voir **VPS-024**.

> ### Ce qui suit décrit l'état des connaissances au 2026-08-08 — conservé, mais démenti ci-dessus
>
> - **Mesure du 2026-08-08** : 208 Mo / **~600 522 lignes (estimé)** (08-07 : 597 828 · 08-06 : 597 740 · 08-05 : 586 880 · 08-04 : 517 097) — `positions` : 380 Mo

> ### ⚠️ 2026-08-06 — l'alarme de rythme d'hier ne tient pas au troisième point
>
> | Date | Lignes | Delta |
> |---|---:|---:|
> | 2026-08-04 | 517 097 | — |
> | 2026-08-05 | 586 880 | **+69 783** |
> | 2026-08-06 | 597 740 | **+10 860** |
>
> Le rapport du 2026-08-05 annonçait *« elle double son nombre de lignes en une semaine »* et
> *« elle grossit 6,5× plus vite que la table qu'elle documente »*. **Six fois moins ce jour-ci.**
> `positions` fait +18 694 sur la même journée : la table de diagnostic croît désormais **moins
> vite** que celle qu'elle documente.
>
> L'alarme reposait sur **deux points de mesure**, dont l'un couvrait la journée de
> redéploiement du 08-04. Une tendance à deux points est une droite : elle passe toujours
> parfaitement par les données. Le constat reste en `SURVEILLANCE`, sans l'urgence qu'on lui
> avait prêtée — et la question produit, elle, reste entière.

**Quoi.** Table de **diagnostic** : elle enregistre pourquoi chaque position a été gardée ou
jetée. Très utile pour régler l'échantillonnage, beaucoup moins une fois le réglage stabilisé.

**Quoi faire.** Question produit avant tout : *cette table a-t-elle encore un lecteur ?* Si non,
une rétention à 7 jours rendrait ~180 Mo et allégerait chaque `pg_dump`.

**Seuil de réescalade** : si elle dépasse le poids de `positions`, ou si la base franchit 3 Go.

---

## VPS-009 — Volumes Docker orphelins contenant des données

- **Domaine** : docker · **Gravité** : 4 · **Statut** : `ACCEPTE`
- **Vu** : 2026-08-13 · **Mesure** : **13 volumes, 421,5 Mo — stabilise pour le 9e passage**. ⚠️ **Le seuil de reexamen de ce constat est a 4 points** : il dit « reexaminer si le disque repasse au-dessus de 80 % apres les nettoyages », et le disque est passe a **76 %** en 24 h (VPS-025). La decision ne change pas pour autant — 421 Mo de bases non reconstituables contre 23 Go libres, ce n'est pas la que se joue le disque. *(mesure du 2026-08-12, conservee : **13 volumes, 421,5 Mo — stabilisé pour le 8e passage** (08-10 → 08-05 : 13 / 421 Mo · 08-04 : 5 / 204 Mo)

> ### 📈 Plus que doublé le 2026-08-05 — et c'est prévisible, pas inquiétant
>
> | | 2026-08-04 | 2026-08-05 |
> |---|---:|---:|
> | Volumes orphelins | 5 | **13** |
> | Taille | 204 Mo | **421 Mo** |
>
> **C'est une conséquence directe de VPS-006** : supprimer les 17 conteneurs morts a détaché
> leurs volumes le jour même. Les nouveaux venus sont les données des piles supprimées —
> `foodsqan-postgres-data` (71 Mo), `maalem-postgres-data` (65 Mo),
> `deploy_vizyo-leads-postgres-data` (64 Mo), `maalem-minio-data` (4,7 Mo).
>
> **La décision ne change pas** : 421 Mo sur 96 Go avec 47 Go libres, contre des bases de
> données non reconstituables. On garde. Mais il fallait l'écrire — un chiffre qui double sans
> explication écrite devient, trois passages plus tard, une dérive inexpliquée.
>
> **Leçon à retenir du correctif VPS-006** : un nettoyage déplace parfois le déchet au lieu de
> le supprimer. Prévoir où il atterrit fait partie du correctif.

**Quoi.** Treize volumes ne sont montés par aucun conteneur. Le plus gros est une base Postgres
Tracky détachée, probablement l'ancêtre de `tracky-postgres-data` (1,1 Go) conservé lors d'une
migration. Deux autres sont des doublons nés d'un renommage de projet compose.

**Pourquoi on l'accepte.** 204 Mo sur 96 Go, contre des données non reconstituables. Le gain
ne justifie pas le risque, et c'est un arbitrage humain — pas une décision d'agent.

**À ne pas faire** : `docker volume prune`. La commande ne fait pas la différence entre un
cache jetable et une base de données.

**Réexaminer si** : le disque repasse au-dessus de 80 % après les nettoyages VPS-001 et VPS-006.

---

## VPS-010 — Noyau non redémarré, 59 paquets en retard

- **Domaine** : sécurité · **Gravité** : 2 · **Statut** : `A_TRAITER` — **désaggravé le 2026-08-12 sur le volet paquets, toujours ouvert sur le noyau**
- **Vu** : 2026-08-13 · **Mesure du jour** : tourne sur 6.8.0-**136**, 6.8.0-**137** installe · compte de paquets **NON MESURABLE** (cache apt de **10 h**, seuil 6 h — VPS-M29 refuse de publier pour la 2e fois ; a titre indicatif : 59 en retard, 0 securite) · **4 services tournent sur une bibliotheque REMPLACEE** · **33/33 en `unless-stopped` — verifie par le collecteur**. *(mesure du 2026-08-12, conservee : tourne sur 6.8.0-**136**, 6.8.0-**137** installé · compte de paquets **NON MESURABLE** (cache apt de 27 h — c'est le correctif VPS-M29 qui refuse désormais de le publier ; à titre indicatif : 59 en retard, 0 sécurité) · **32/32 en `unless-stopped` — vérifié par le collecteur**.

> ### ✅ 2026-08-12 — les 11 correctifs de sécurité d'hier ont bien été INSTALLÉS
>
> Le rapport du 08-11 annonçait 11 correctifs en attente, mesurés sur un cache de trois minutes.
> Ce matin le collecteur affiche 59 paquets dont 0 sécurité, sur un cache de 27 h. **Ce n'est pas
> une contradiction, et l'historique `apt` le prouve** :
>
> ```
> Start-Date: 2026-08-11  06:19:35
> Commandline: /usr/bin/unattended-upgrade
> Upgrade: udev, systemd-timesyncd, libpam-systemd, libsystemd0, libnss-systemd, systemd,
>          libudev1, systemd-dev, systemd-resolved, libsystemd-shared, systemd-sysv
>          (255.4-1ubuntu8.16 → 255.4-1ubuntu8.17)
> End-Date: 2026-08-11  06:20:13
> ```
>
> **Onze paquets. Exactement les onze.** Le compte est mécaniquement retombé de 70 à 59.
> `cloud-init` reste explicitement retenu (`marked to be held back`).
>
> ⚠️ **Mais le collecteur a eu raison PAR ACCIDENT, et c'est le vrai sujet.** Le « 0 » de ce matin
> est juste, et il est **indistinguable** du « 0 » faux qui a couvert sept passages. Trois
> lectures du même collecteur en trois jours — **0, puis 11, puis 0**. Corrigé : **VPS-M29**.
>
> ⚠️ **ET UN PAQUET INSTALLÉ N'EST PAS UN SERVICE REDÉMARRÉ.** `libsystemd0` a été remplacé sous
> les pieds de tous les démons qui le chargeaient — `dockerd` compris — et ceux-ci tournent
> encore sur l'ancienne copie. La boucle de `dockerd` (VPS-016, 3e occurrence) a démarré
> **15 heures** après cette mise à jour : c'est trop long pour en faire une cause, et trop précis
> pour ne pas l'écrire. Le collecteur affiche désormais la date de la dernière installation à côté
> du compte, précisément pour que ce raisonnement soit possible sans enquête.
>
> ⚠️ **`fail2ban` a été redémarré par cette mise à jour** (2026-08-11 06 h 20 min 16) : ses
> compteurs partent de là. Les « 4 échecs, 0 bannissement » du 2026-08-12 ne décrivent PAS la
> semaine — c'est la famille VPS-M11 sur un troisième objet.

> ### 🔴 2026-08-11 — les « 0 paquet de sécurité » de sept passages étaient un artefact de cache
>
> | Mesure | 2026-08-10 | 2026-08-11 |
> |---|---|---|
> | Paquets en retard | 59 | **70** |
> | dont estampillés sécurité | **0** | **11** |
> | Fraîcheur du cache apt | 2026-08-09 00 h 50 (**25 h**) | 2026-08-11 02 h 23 min 44 (**3 min**) |
>
> **C'est la première lecture prise sur un cache frais.** `apt-daily.timer` s'est déclenché à
> 02 h 23 min 33, soit **une minute avant** que la section 6 ne mesure. Les sept passages
> précédents lisaient un cache vieux de 12 à 25 heures et annonçaient `0`. Le collecteur affichait
> honnêtement la date à côté (VPS-M11), et le rapport rappelait à chaque fois qu'*« un 0 ici n'est
> pas une garantie »*. Il ne l'était pas.
>
> ⚠️ **Ce n'est pas un correctif, c'est un coup de chance, et il ne se reproduira pas à volonté.**
> `apt-daily.timer` porte un délai aléatoire de plusieurs heures : il a tiré 02 h 23 aujourd'hui,
> il tirera autre chose demain. On ne peut pas le forcer — `apt update` est une écriture, interdite
> ici. **Ce qu'on peut faire, et qui n'est pas fait : refuser de publier le chiffre au-delà de ~6 h
> de cache**, au lieu de le publier assorti d'un avertissement que personne n'applique. C'est
> l'angle mort n° 1 du rapport du 08-11, et c'est la leçon de VPS-M24 (*instrumenter n'est pas
> arbitrer*) appliquée à VPS-M11 : **un chiffre affiché est un chiffre cru.**
>
> **Conséquence pratique** : le redémarrage passe du 9e au 5e rang du plan d'action. Pas parce que
> le risque a bondi — parce que la mesure était fausse jusqu'à ce matin. ⚠️ **2026-08-10 — ne pas fusionner ce redémarrage avec celui de VPS-016** : le redémarrage du **démon** règle la boucle et rien d'autre, celui de la **machine** règle le noyau et rien d'autre. Les faire ensemble « tant qu'on y est » est un choix légitime, mais c'en est un — et il double l'interruption si le premier suffit.
- **Mesure à la découverte (2026-08-04)** : tournait sur 6.8.0-**134**, 6.8.0-**136** installé

> ### 🔄 2026-08-07 — le constat rouvre, et c'est le fonctionnement normal
>
> ```
> !! REDEMARRAGE REQUIS :
>   linux-image-6.8.0-137-generic
>   linux-base
> ```
>
> `unattended-upgrades` a installé le noyau suivant. Ce constat **rouvrira à chaque nouveau
> noyau** : ce n'est pas une régression du correctif du 2026-08-04, c'est la nature du sujet.
> Un noyau installé n'est pas un noyau actif, et il n'existe pas de correctif définitif à ça —
> seulement une cadence de redémarrage à décider.
>
> **Ce qui a changé dans l'arbitrage depuis le 2026-08-04** : VPS-014 a démontré que la mémoire
> rendue par `dockerd` revient en cinq heures. Le redémarrage ne se justifie donc **plus que par
> le noyau** — ce qui reste suffisant, mais c'est désormais la seule raison à mettre en face des
> ~50 secondes d'interruption. Ne plus jamais compter la RAM dans la justification.
>
> **59 paquets en retard, dont 0 estampillé sécurité** — et un 0 ici ne garantit rien, Ubuntu
> publiant beaucoup de correctifs par `noble-updates`. Le cache apt date du 2026-08-06 à
> 01 h 23 (25 h) : le chiffre décrit l'état d'hier (VPS-M11).
>
> ⚠️ **La vérification qui compte le plus, avant d'appuyer** : que les 31 conteneurs sont en
> `restart: unless-stopped`. Elle est gratuite, elle n'est toujours pas dans le collecteur
> (angle mort n° 3, reporté deux fois), et sans elle certains ne reviennent pas — on ne
> l'apprend qu'après.

> ### ✅ Redémarrage effectué le 2026-08-04 — la preuve
>
> **Interruption réelle : ~50 secondes.** Fenêtre choisie à 23 h 32, avec **0 boîtier GPS
> connecté**.
>
> | | Avant | Après |
> |---|---:|---:|
> | Noyau actif | 6.8.0-134 | **6.8.0-136** |
> | Redémarrage requis | oui | **non** |
> | `dockerd` (RSS) | 861 Mo | **131 Mo** |
> | Swap utilisé | 1,0 Go | **0** |
> | RAM utilisée | 2,5 Gi | **1,9 Gi** |
> | Conteneurs | 31 | **31 — aucun manquant** |
> | En anomalie | 0 | **0** |
>
> **~730 Mo de RAM rendus par `dockerd` seul, plus 1 Go de swap libéré.**
>
> ### ⚠️ Vérifié le lendemain : ce gain mémoire a duré CINQ HEURES (voir VPS-014)
>
> `dockerd` était remonté à **880 Mo** et le swap à **835 Mo** après 5 h 20 de fonctionnement.
> L'explication « `dockerd` gonfle avec l'uptime » était **fausse** : il gonfle avec les
> **builds** (une image de 3,49 Go produite à 01 h 44 y a suffi).
>
> **Le redémarrage reste justifié — mais pour le noyau seul.** Les correctifs 6.8.0-136 sont
> actifs et le resteront ; la mémoire, non. Ne plus jamais compter la RAM de `dockerd` dans
> la justification d'une interruption de service.
>
> ### Ce qui a été vérifié AVANT d'appuyer
>
> - **Les 31 conteneurs ont une politique `unless-stopped`** — sans ça, certains ne seraient
>   pas revenus. C'est la vérification qui compte le plus.
> - Une sauvegarde du matin (127 Mo) en filet.
> - Un instantané nominatif des 31 conteneurs, pour comparer après.
> - Chaque réglage devant survivre listé et confirmé présent sur disque.
>
> ### Ce qui a survécu (vérifié après)
>
> Durcissement SSH (`passwordauthentication no`), fail2ban **avec l'IP d'administration
> toujours en liste blanche**, `vm.swappiness=10`, `vm.vfs_cache_pressure=50`, timer de
> sauvegarde, **0 service en échec**.
>
> ⚠️ Le point qui aurait pu casser : `cloud-init` peut régénérer `50-cloud-init.conf` au
> démarrage. Le durcissement tient parce qu'il vit dans **`01-hardening.conf`**, lu **avant**.
> C'est exactement ce que la fiche VPS-002 avait anticipé — et le redémarrage vient de le prouver.

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

- **Domaine** : docker · **Gravité** : 3 · **Statut** : `SURVEILLANCE` (partiellement appliqué le 2026-08-04)
- **Vu** : 2026-08-13 · **Mesure** : **65 invocations/min** (93 600/jour), inchangee depuis le 2026-08-04 — **10e passage**. Denominateur affiche par le collecteur : **24 sondes sur 33 conteneurs, 9 SANS AUCUNE SONDE** (8/32 hier — `dronely-devis` arrive sans sonde). Taux de creation de processus : **1 302/min**, contre 1 404 hier et 1 758 le 08-09 — la machine perd un coeur depuis 29 h : **une baisse pendant une panne ne mesure pas une amelioration**. *(mesure du 2026-08-12, conservee : **65 invocations/min** (93 600/jour), inchangée depuis le 2026-08-04 — **9e passage**. Le collecteur affiche desormais son denominateur de lui-meme : **24 sondes sur 32 conteneurs, 8 SANS AUCUNE SONDE** (7/31 hier — `dronely-presentation` arrive sans sonde). Taux de creation de processus : **1 404/min**, contre 1 494 hier — la baisse est du meme ordre que la variance, et la machine est en boucle : ne rien en conclure. *(mesure du 2026-08-11, conservee : 65 invocations/min, 8e passage.* Le taux de creation de processus est remonte a **1 494/min** (1 098 pendant la boucle du 08-10, 1 758 le 08-09) : la baisse d'hier etait bien un symptome, pas un gain. ⚠️ Le taux de création de processus, lui, est tombé à **1 098/min** (1 758 la veille) : ce n'est **pas** un gain, c'est le symptôme de VPS-016 — une machine dont un cœur est confisqué crée moins de processus parce qu'elle n'y arrive plus. Même chute qu'au 2026-08-06 (1 332 → 966). *Un compteur qui baisse pendant une panne ne mesure pas une amélioration.*)*
- **Mesure à la découverte (2026-08-04)** : 88 invocations/min = **126 720/jour**

> ### ✅ Appliqué le 2026-08-04 sur 5 sondes — et ce que ça a VRAIMENT donné
>
> | Pile | Sonde | Avant | Après |
> |---|---|---:|---:|
> | Tracky **prod** | `tracky-postgres`, `tracky-redis` | 10 s | **30 s** |
> | Maalem **dev** | `maalem-dev-postgres`, `maalem-dev-redis` | 10 s | **60 s** |
> | Maestroo **dev** | `maestroo-dev-postgres` | 10 s | **60 s** |
>
> **88 → 65 invocations/min (−26 %)**, soit 126 720 → 93 600 par jour.
>
> ### ⚠️ Le gain CPU n'est PAS démontrable, et il faut le dire
>
> Taux de création de processus **avant** : 1 527/min. **Après** : 1 512/min. Soit −1 %,
> très en-dessous de la variance naturelle (±100/min d'une mesure à l'autre).
>
> Autrement dit : **la réduction de 26 % des sondes est structurellement prouvée, mais son
> effet sur le processeur est trop petit pour être mesuré.** Le modèle prédisait ~115 forks/min
> économisés ; le bruit de fond en fait autant. Ce constat était donc réel mais **surestimé** —
> il coûtait moins cher que ce que sa taille apparente (126 720/jour) laissait croire.
>
> Le vrai bénéfice acquis est ailleurs, et il est certain : **40 320 connexions PostgreSQL en
> moins par jour**, chacune faisant forker un backend.
>
> ### Il reste 5 sondes à 10 s, dans 4 autres dépôts
>
> `vizyo-verify-postgres`, `vizyo-manager-postgres`, `texto-postgres`, `capcom6-mysql`,
> `vizyo-auth-db`. Chacune demande une modification de **son** dépôt puis une recréation de
> conteneur — dont `vizyo-auth-db`, dont dépend l'authentification de **toutes** les applications.
>
> **Recommandation : ne pas le faire pour le gain seul.** Le rendement mesuré ne justifie pas
> d'aller redéployer quatre projets de production. À faire au fil de l'eau, quand chacun sera
> touché pour une autre raison.

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

## VPS-012 — Trois clés GitHub Actions ont un accès root complet

- **Domaine** : sécurité · **Gravité** : 2 · **Statut** : `APPLIQUE` (2026-08-04, 22 h 15)
- **Vu** : 2026-08-04 · **Mesure à la découverte** : 3 des 4 clés de `/root/.ssh/authorized_keys`
- ✅ **2026-08-11 — 8e passage, toujours aucune clé inconnue.** Sur **1 288 connexions acceptées** en 7 jours glissants, **trois empreintes**, les trois déclarées : `cdd9XFoV…` (humaine, 1 258), `Y/gE+zS4…` (CI restreinte, **27** — 4 de plus qu'hier) et `ulkonmDi…` (révoquée, **toujours figée à 3**, toutes du 2026-08-04 à 20 h 37 depuis `127.0.0.1`). Sept jours après sa révocation, la clé retirée n'a jamais resservi.
- ✅ **2026-08-09 — le correctif est prouvé PAR LES JOURNAUX, et c'est nouveau.** Jusqu'ici il n'était vérifié que par la lecture d'`authorized_keys`, c'est-à-dire par le fichier qu'on venait soi-même d'écrire. La fenêtre de 7 jours restaurée par VPS-M21 permet enfin de le vérifier par l'**usage** : sur **991 connexions acceptées**, seules **deux empreintes** apparaissent, et ce sont les deux clés déclarées — `cdd9XFoV…` (`vizyo-vps-hostinger`, humaine, 974 connexions depuis 82.67.153.51) et `Y/gE+zS4…` (`github-actions-deploy-maalem`, 14 connexions depuis des adresses Azure : 20.x, 13.89.x, 52.x, 48.x, 4.149.x). Les 14 connexions de CI portent bien les options restrictives `no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-user-rc`. **Une troisième empreinte** (`ulkonmDi…`, 3 connexions) apparaît le **2026-08-04 à 20 h 37**, depuis `127.0.0.1` — soit **une minute avant** la modification d'`authorized_keys` à 20 h 38. C'étaient les essais de la passe de durcissement ; la clé retirée **n'a plus jamais servi**. Cinq jours, 991 connexions, zéro usage d'une clé révoquée.

> ### ✅ Corrigé le 2026-08-04 — la preuve
>
> | Clé | Dernier déploiement | Décision |
> |---|---|---|
> | `vizyo-vps-hostinger` | — | **inchangée** : c'est la clé humaine d'administration |
> | `github-actions-deploy-maalem` | **2026-08-03** (active) | **restreinte** |
> | `github-actions-deploy@foodsqan` | 2026-03-13 (5 mois) | **désactivée** (commentée) |
> | `github-deploy@foodsqan` | 2026-03-13 (5 mois) | **désactivée** (commentée) |
>
> Options posées sur la clé maalem :
> `no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-user-rc`
>
> ### Pourquoi PAS `command="..."`
>
> C'est la restriction la plus forte — et elle aurait **cassé les deux CI**. Les deux projets
> envoient des **scripts shell multi-lignes** (`appleboy/ssh-action` avec `script:` pour maalem,
> un heredoc `<< 'ENDSSH'` pour foodsqan), pas une commande fixe. Un `command=` les aurait tous
> remplacés par la commande déclarée.
>
> Les options retenues n'entravent **pas** l'exécution de commandes ; elles interdisent
> d'utiliser la clé comme **tunnel** vers les services internes. C'est le vrai gain : une clé
> volée ne donne plus accès à Postgres, Redis ou MinIO.
>
> ### Comment ça a été prouvé
>
> 1. **Avant d'appliquer** : une clé de test jetable, portant exactement les mêmes options, a
>    exécuté un script heredoc multi-lignes de bout en bout. ✅
> 2. **Après avoir appliqué** : le workflow `deploy-staging` de maalem a été déclenché sur le
>    **même commit** (`9630bbb`, donc sans changer ce qui tourne). Résultat :
>    `✅ Deploy complete` + health check `HTTP 200`. ✅
> 3. **Confirmation supplémentaire** : le déploiement automatique déclenché par le correctif
>    VPS-011 sur maalem est également passé. ✅
>
> ### ⚠️ Un incident pendant la manipulation, et sa leçon
>
> Le script de test a été **interrompu en plein milieu** (une commande `ssh -L` interactive qui
> ne rendait pas la main). Il a laissé derrière lui la clé de test **sans restriction** dans
> `authorized_keys`, et sa clé privée dans `/tmp`. Détecté et nettoyé immédiatement (`shred`),
> aucune connexion externe n'avait utilisé cette clé.
>
> **Leçon** : un script qui crée un accès temporaire doit le retirer dans un `trap EXIT`, pas
> à la dernière ligne. Une interruption ne doit jamais laisser une porte ouverte.
>
> **Restauration si besoin** : `cp /root/.ssh/authorized_keys.bak-20260804 /root/.ssh/authorized_keys`

**Quoi.** Sur les 4 clés autorisées, une seule est humaine (`vizyo-vps-hostinger`). Les trois
autres sont des clés de déploiement CI/CD :

| Clé | Projet |
|---|---|
| `github-actions-deploy@foodsqan` | FOODSQAN |
| `github-deploy@foodsqan` | FOODSQAN |
| `github-actions-deploy-maalem` | Maalem |

Elles se connectent en **`root`**, sans restriction de commande. Un secret GitHub qui fuite —
ou un workflow malveillant fusionné sur une branche autorisée — donne donc un accès root
complet à la machine qui héberge **toute** la production, Tracky compris.

**Pourquoi c'est en surveillance et non à traiter.** Aucune compromission n'est constatée, et
ces clés sont nécessaires aux déploiements existants. Le durcissement SSH du jour ne les
affecte pas (elles s'authentifient déjà par clé).

**Quoi faire, le jour où on s'en occupe.** Par ordre de coût croissant :
1. Restreindre chaque clé à une commande unique dans `authorized_keys`
   (`command="/opt/<projet>/deploy.sh",no-port-forwarding,no-pty ssh-ed25519 …`) — c'est le
   correctif à la fois le plus simple et le plus efficace.
2. Créer un utilisateur non-root par projet, avec un `sudo` limité au script de déploiement.
3. Vérifier que `foodsqan` a encore besoin de **deux** clés : la pile est arrêtée depuis
   7 semaines (cf. VPS-006).

**À ne pas faire** : les retirer sans prévenir. Un déploiement CI qui casse en silence se
découvre au pire moment.

---

## VPS-013 — Trois bases de production n'ont aucune sauvegarde exploitable

- **Domaine** : sauvegardes · **Gravité** : 1 · **Statut** : `A_TRAITER`
- **Vu** : 2026-08-13 · **Mesure** : 3 bases de production sur 7 moteurs en service ; `vizyo-manager` a **120 jours** (2 879 h) ; **cout total d'y remedier : 17,5 Mo/jour** (`texto` 8,7 Mo · `vizyo-manager` 8,4 Mo · `capcom6` 0,4 Mo) — **10e passage sans action**. *(mesure du 2026-08-12, conservee : 3 bases de production sur 7 moteurs en service ; `vizyo-manager` à **119 jours** ; **coût total d'y remédier : 17,5 Mo/jour** (`texto` 8,7 Mo · `vizyo-manager` 8,4 Mo · `capcom6` 0,4 Mo). *(mesure du 2026-08-11, conservee : `vizyo-manager` à 117 jours, coût total 17,4 Mo/jour* (`texto` 8,6 Mo · `vizyo-manager` 8,4 Mo · `capcom6` 0,4 Mo))*
- ✅ **2026-08-09 — la question « faut-il accepter la perte ? » est CLOSE, et elle ne l'était que faute d'un chiffre.** Quatre passages durant, le référentiel a répété « `texto` et `capcom6` n'ont aucune sauvegarde » sans jamais dire ce que la corriger coûterait. Mesuré : `texto-postgres` **8,5 Mo**, `vizyo-manager-postgres` **8,4 Mo**, `capcom6-mysql` **0,4 Mo** — **17,3 Mo au total**, moins de 3 Mo compressés par jour. Soit **1/2 300** de ce que `/var/backups/vizyo-tracky` occupe déjà (6,8 Go), et 0,006 % du disque libre. Il n'y avait pas d'arbitrage à rendre : il y avait une mesure à prendre. **Leçon de méthode** : un constat qui propose « corriger **ou** accepter » sans chiffrer le coût de la correction ne propose rien — il reporte. Le collecteur affiche désormais cette taille sous chaque ligne en défaut (hors développement).
- ⚠️ **2026-08-08 — VPS-020 multiplie ce constat** : `vizyo-manager-postgres` partage le projet compose `deploy` avec Maestroo. Un `--remove-orphans` lancé depuis l'autre dépôt supprimerait la base **et** elle n'a pas de sauvegarde depuis 114 jours. Les deux défauts sont individuellement de gravité 2 et 1 ; ensemble, ils font une perte définitive à une commande de distance.

**Quoi.** Sur les sept moteurs de base de données en service, deux seulement disposent d'une
sauvegarde à jour (`tracky-postgres`, `vizyo-verify-postgres`) et deux sont des bases de
développement sans enjeu. Restent trois bases de production sans filet :

| Base | Dernière copie | Ce qu'elle porte |
|---|---|---|
| `vizyo-manager-postgres` | **2026-04-15** (**112 j** au 2026-08-06) | abonnements Stripe, factures, clients |
| `texto-postgres` | **aucune, jamais** | passerelle SMS : messages, allowlist, locataires |
| `capcom6-mysql` | **aucune, jamais** | relais SMS |

Pour `vizyo-manager`, le dossier `/var/backups/vizyo-manager` existe et contient **25 copies** —
mais plus aucun timer ni cron ne les produit. La sauvegarde n'a pas échoué : elle a été
**débranchée**, et les fichiers restants donnent l'apparence contraire.

**Pourquoi c'était invisible.** La section d'audit intitulée « chaque application a-t-elle une
copie récente ? » posait la bonne question **au mauvais endroit** : elle énumérait les
*dossiers de `/var/backups`*. Une base dont la sauvegarde n'a jamais existé n'a pas de dossier,
donc elle était **absente de la liste** — et une absence se lit comme « rien à signaler ».
Le filtre aggravait le tout : il ne connaissait que les préfixes `vizyo-`, `tracky-`,
`maestroo-` et `maalem-`, donc `texto-*` et `capcom6-*` auraient été ignorés **même avec** un
dossier.

C'est la même famille que VPS-004 et VPS-M06 : une garde qui rassure parce qu'elle regarde du
côté de la trace au lieu du côté de l'effet.

**Quoi faire.** Dans cet ordre :

1. Mesurer le coût réel avant d'automatiser :
   `docker exec vizyo-manager-postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" | gzip | wc -c`
   (la base fait 8,3 Mo — le dump sera négligeable, et ce chiffre le prouve avant qu'on s'engage).
2. Dériver un `vizyo-manager-backup.service` de `tracky-backup.service`, qui fonctionne **et**
   rend compte à l'API — plutôt que d'écrire un script neuf.
3. Trancher le cas `capcom6-mysql` : sauvegarder, ou écrire noir sur blanc qu'on accepte sa
   perte. Une ligne rouge permanente sans décision finit par être ignorée.

**Gain** : ferme le seul risque de perte de données définitive de la machine.
**Contrepartie** : ~2 minutes de `pg_dump` de plus par nuit, sur des bases minuscules.

**À ne pas faire** :
- **Planifier à 03 h 00 ou 03 h 30** — ce sont les créneaux de `tracky-backup` et
  `vizyo-verify-backup`. Deux `pg_dump` simultanés sur 2 vCPU se gênent : c'est précisément
  pourquoi le créneau de Verify avait été décalé. **04 h 00 est libre.**
- **Remettre un cron.** VPS-003 est né exactement de là. Un timer systemd, un seul.

---

## VPS-014 — Le gain mémoire attribué au redémarrage a duré cinq heures

- **Domaine** : docker · **Gravité** : 4 · **Statut** : `ACCEPTE` (compris, documenté)
- **Vu** : 2026-08-05 · **Mesure** : `dockerd` 131 Mo → 880 Mo en 5 h 20

**Quoi.** Le rapport du 2026-08-04 attribuait au redémarrage « 730 Mo rendus par `dockerd` »
et « 1 Go de swap libéré », avec l'explication *« `dockerd` gonfle avec l'uptime »*.

| Mesure | 08-04 avant (28 j) | 08-04 après redémarrage | 08-05 (5 h) |
|---|---:|---:|---:|
| `dockerd` (RSS) | 861 Mo | 131 Mo | **604 → 880 Mo** |
| Swap utilisé | ~1 Go | 0 | **835 Mo** |

**L'uptime n'y est pour rien.** La variable explicative est le **build** : une image de 3,49 Go
(`deploy-api`, celle de `maestroo-dev-api`) a été produite à 01 h 44. C'est elle qui gonfle
`dockerd` et pousse les pages anonymes vers le swap.

**Pourquoi c'est en `ACCEPTE` et non en défaut.** Rien ne va mal : `memory full` (PSI) est à 0,
5,5 Go restent disponibles, aucun OOM en 30 jours. Le swap fait exactement son travail.

**Ce que ça change.**
1. **Ne plus jamais redémarrer pour récupérer la mémoire de `dockerd`.** Le gain dure quelques
   heures ; l'interruption, elle, est définitive. On redémarre pour le **noyau** — ça, c'était
   et ça reste justifié.
2. **Le volume swappé n'est pas l'indicateur.** La bonne mesure est la **pression PSI**.

**À ne pas faire** : présenter un gain mesuré à `t+0` comme acquis. Un gain se vérifie au
passage suivant — c'est la raison d'être des `chiffres` du manifeste.

> ### ⚠️ 2026-08-06 — la mesure du jour est CONFONDUE, ne pas la verser à cette fiche
>
> `dockerd` affiche 619 à 871 Mo de RSS ce passage. **Ne pas le lire comme « le prix des
> builds »** : le démon est en boucle depuis 24 h (VPS-016), et un processus emballé n'a pas le
> profil mémoire d'un processus au travail. La démonstration de cette fiche — la mémoire suit
> les builds, pas l'uptime — reste valable ; c'est la **mesure du 2026-08-06 qui n'y entre pas**.
> Elle sera reprise après le redémarrage du démon.
>
> Et la règle « un gain se vérifie au passage suivant » vaut **aussi pour les dégâts** : c'est
> exactement ce qui a manqué à VPS-M12.

---

## VPS-015 — La sauvegarde de Vizyo Verify n'a jamais tourné toute seule

- **Domaine** : sauvegardes · **Gravité** : **2** (était 1) · **Statut** : `A_TRAITER` — **volet SYMPTÔME fermé le 2026-08-12, volet CAUSE intact**
- **Vu** : 2026-08-13 · **Mesure du jour** : **une archive existe enfin** (2026-08-12 07 h 10 min 31, chiffrée, relue, 19 h) — **mais produite par un redéploiement, pas par le correctif du plan, et le timer n'a toujours JAMAIS réussi** (dernière exécution du timer : 2026-08-12 03 h 30 min 56, `203/EXEC`).

> ### ⚠️ 2026-08-13 — la sauvegarde a réussi, et presque rien de ce qu'on en conclurait n'est vrai
>
> Après huit jours d'échec, `journalctl` montre enfin :
>
> ```
> Aug 12 03:30:56  vizyo-verify-backup.service: status=203/EXEC        ← le timer, en échec
> Aug 12 07:10:24  Starting vizyo-verify-backup.service...             ← 3 h 40 plus tard
> Aug 12 07:10:31  OK — base 12K + 13 fichiers 5.3M, vérifiées (7s)
> ```
>
> **Ce n'est pas le `chmod +x` du plan d'action.** La preuve tient dans une date :
>
> ```
> -rwxrwxr-x 1 root root 10812 Aug 12 07:10 /opt/vizyo-verify/deploy/vps/backup.sh
> ```
>
> `chmod` **ne modifie pas la date de contenu** d'un fichier. Or celle-ci est passée du
> `Aug 5 01:40` d'origine au `Aug 12 07:10`, **à taille inchangée** (10 812 octets). Le fichier a
> donc été **recopié**. Et l'image `vizyo-verify-app:latest` est datée du **2026-08-12 07 h 11 min
> 30** : c'est un **redéploiement**, et le service a démarré 26 secondes après l'écriture.
>
> **Ce que ça change, et c'est l'inverse de ce que l'archive laisse croire :**
>
> | | Avant le 08-12 | Après |
> |---|---|---|
> | Une archive produite par le dispositif existe | non | **oui** ✅ |
> | Le **timer** a déjà réussi une fois | non | **non — toujours pas** |
> | La **cause** (`scp -r` sans `-p`) est traitée | non | **non** |
>
> Le bit d'exécution a été remis **par chance**, exactement comme il avait été retiré par
> mégarde le 5 août. **Le prochain déploiement peut le reperdre**, et le dispositif retombera
> dans le même silence — c'est précisément pourquoi le point 3 ci-dessous existe.
>
> ### Le test écrit d'avance, qui se tranche au passage suivant sans rien coûter
>
> Échéance suivante : **2026-08-13 à 03 h 30 min 53 UTC**, soit 1 h 05 après la collecte du jour.
>
> - Réussite à 03 h 30 → **le chemin automatique est prouvé pour la première fois**, et le volet
>   symptôme passe en `APPLIQUE`.
> - `203/EXEC` → le bit a déjà été reperdu, et on est revenu au jour 1.
>
> *(Méthode VPS-024 : un constat qui énonce son critère de réfutation se ferme au passage suivant ;
> un constat qui énonce un soupçon se surveille indéfiniment.)*
>
> ### Ce que la réussite a révélé au passage — VPS-026
>
> ```
> Aug 12 07:10:25  backup.sh: Unable to find image 'alpine:latest' locally
> Aug 12 07:10:26  backup.sh: latest: Pulling from library/alpine
> ```
>
> **Cinq des sept secondes de la sauvegarde sont un téléchargement depuis Docker Hub.** Voir
> VPS-026.

> ### Mesures des jours précédents, conservées
>
> - **2026-08-12** : `203/EXEC` depuis le 2026-08-05 03 h 30 · **0 exécution réussie dans tout `journald`** · archives à **176 h** (**8e jour**) · derniere tentative le 2026-08-12 a 03 h 30 min 56, meme code. *(mesure du 2026-08-11, conservee : archives à 149 h, 7e jour* · dernière tentative le 2026-08-10 à 03 h 31 min 47, même code. Le correctif (`chmod +x`, 2 secondes, risque nul) est en **tête du plan d'action depuis six passages** — voir la question ouverte du rapport du 2026-08-11 : ce n'est plus un sujet technique.)*

> ### 🔴 2026-08-09 — cinquième jour. Le constat n'évolue plus, seul son compteur avance
>
> Dernière tentative le **2026-08-08 à 03 h 30 min 56 s**, même `exit-code 203`. Archives
> toujours datées du **2026-08-04 à 21 h 02** : **101 heures**, contre 77 la veille. Prochaine
> échéance à 03 h 30 UTC, et elle échouera aussi — le collecteur le dit d'avance, en vérifiant
> le bit d'exécution **avant** l'échéance plutôt qu'en constatant l'échec après.
>
> Le correctif tient en une commande (`chmod +x`), il est en **tête du plan d'action depuis
> quatre passages**, et rien n'indique qu'il ait été lu. C'est désormais la question ouverte la
> plus ancienne du dispositif — et la seule dont la réponse ne soit pas technique.

> ### 🔴 2026-08-07 — troisième jour, rien n'a été fait, et l'indicateur menteur a été désarmé
>
> `vizyo-verify-backup.service` : toujours `failed`, toujours `exit-code 203`, dernière tentative
> le 2026-08-06 à 03 h 31 min 47 s. Les archives présentes datent du **2026-08-04 à 21 h 02** —
> ce sont toujours les essais manuels de la passe de durcissement. **Le timer n'a jamais produit
> un seul fichier.**
>
> **Ce que ce passage ajoute** : le rapport du 08-06 avait nommé le piège n° 2 de la table
> ci-dessous — *« un copieur qui n'a rien à copier réussit »* — **sans toucher à l'indicateur qui
> le tend**. Il affichait donc encore, ce matin, `vizyo-verify OK 21 h à jour`. Documenter un
> piège ne le désarme pas. La ligne est désormais **plafonnée par la fraîcheur de sa source** :
>
> ```
> vizyo-verify           OK              22 h
>   🔴 MAIS le fichier le plus recent de /var/backups/vizyo-verify a 53 h :
>      la copie est fraiche, son CONTENU non.
> ```
>
> **La règle** : la fraîcheur d'un dérivé ne peut pas dépasser celle de sa source. Tout
> indicateur qui peut être vert sans que rien ne se produise n'est pas un indicateur.

**Quoi.** `vizyo-verify-backup.service` est en échec permanent. `Main PID: 531478 (code=exited,
status=203/EXEC)`, **4 ms de processeur** : le script n'a jamais démarré.

La cause tient dans une ligne de `ls` :

```
-rw-rw-r-- 1 root root 10812 Aug  5 01:40 /opt/vizyo-verify/deploy/vps/backup.sh     ← pas de x
-rwxr-xr-x 1 root root  3029 Apr 27 06:23 /opt/vizyo-tracky/deploy/vps/backup-db.sh  ← celle qui marche
```

**Tout le dossier porte l'horodatage `Aug 5 01:40` et les droits `664`** : la signature d'un
`scp -r`, qui ne préserve les permissions **qu'avec `-p`**. Un redéploiement a recopié le dossier
et effacé le bit d'exécution.

Et le journal est formel : `executions reussies dans journald : 0`. Les deux archives présentes
datent du 2026-08-04 à 20 h 51 et 21 h 02 — ce sont des **essais manuels** de la passe de
durcissement. **Le timer n'a produit aucun fichier, jamais.**

**Pourquoi c'était invisible.** Quatrième récidive de la famille VPS-004 / VPS-M06 / VPS-M13 :
trois indicateurs sur quatre regardaient la **trace** au lieu de l'**effet**.

| Indicateur | Ce qu'il disait | Pourquoi il se trompait |
|---|---|---|
| `DERNIER-ETAT.json` | `OK 2026-08-04T21:02:24Z` | **Une exécution qui échoue ne réécrit pas le fichier d'état** : le dernier succès reste affiché et se lit comme l'état courant. |
| Copie hors-site | `OK, à jour, 21 h` | Elle a fidèlement copié… rien de nouveau. **Un copieur qui n'a rien à copier réussit.** |
| Âge du dossier | `a jour` | 29 h, pour un seuil à 30 h. Il s'en fallait d'**une heure**. |
| `systemctl --failed` | 🔴 | Le seul qui regardait la source — et par chance : une unité `oneshot` en échec disparaît d'ici au premier `reset-failed`. |

Le rapport du 2026-08-05 en avait tiré la conclusion exactement inverse : *« Vizyo Verify est le
seul dispositif complet de la machine »*. C'était vrai de sa conception, faux de son exécution.

**Quoi faire.** Dans cet ordre :

1. `chmod +x /opt/vizyo-verify/deploy/vps/backup.sh` — 2 secondes, risque nul.
2. `systemctl reset-failed vizyo-verify-backup.service && systemctl start vizyo-verify-backup.service`
   — **prouver le correctif maintenant**, pas espérer la nuit prochaine. Un correctif non
   prouvé est une hypothèse, et celui-ci porte sur des pièces d'identité.
3. Rendre la rechute impossible : `ExecStart=/bin/bash /opt/vizyo-verify/deploy/vps/backup.sh`,
   pour que le bit d'exécution cesse d'être une condition de survie de la sauvegarde. Le
   correctif de fond — `scp -p` ou `rsync -a` dans le déploiement — vit dans le dépôt Verify.

**Gain** : rend une sauvegarde de pièces d'identité qui n'a jamais existé.
**Contrepartie** : ~3 s de `pg_dump` + `tar` par nuit.

**À ne pas faire** : se contenter du `chmod`. Il répare aujourd'hui et ne dit rien du prochain
déploiement. C'est la différence entre fermer un incident et fermer sa cause.

---

## VPS-016 — `dockerd` tourne en boucle et brûle un cœur depuis 24 heures

- **Domaine** : docker · **Gravité** : 2 · **Statut** : `A_TRAITER` — **3e occurrence, TOUJOURS EN COURS au 2026-08-13 : 4e journée, la plus longue jamais mesurée**
- **Vu** : 2026-08-13 · **Mesure du jour** : `dockerd` à **100,3 %** d'un cœur, **1 292 236 `read()`/s pour 0,0000 octet ramené par appel**, charge machine **2,18**, PID **913 inchangé** (`ps` : 8 j 04 h 56 d'ancienneté, jamais redémarré depuis le 2026-08-04). Cumul **87,3 h / 196,8 h = 44,3 %**. **37 threads** (47 le 08-12, 27 le 08-10), les plus chauds en `futex_wait_queue`, dont **`tid=156485`, déjà identifié le 08-10 ET le 08-12**.

> ### 🔴 2026-08-13 — elle n'a pas cessé une seconde, et l'unique trait commun connu est RÉFUTÉ
>
> **L'arithmétique du CPU cumulé suffit à établir la continuité** : 87,3 − 67,0 = **20,3 heures de
> processeur consommées en 20,6 heures écoulées**. À ~99 % d'un cœur, c'est la continuité parfaite.
> Début daté entre 21 h 00 et 21 h 10 UTC le 2026-08-11 : **la boucle dure depuis 29 h 15 au moment
> de la collecte, et elle tourne encore.**
>
> | Occurrence | Début | Fin | Durée |
> |---|---|---|---|
> | 1 — 2026-08-05 | ~02 h 23 | 2026-08-06 ~13 h 00 | 34 h 40 |
> | 2 — 2026-08-10 | ~01 h 15 | 2026-08-10 ~14 h 45 | ~13 h 30 |
> | **3 — 2026-08-11** | **~21 h 05** | **toujours en cours** | **≥ 29 h 15** |
>
> ### ❌ « Les deux se sont terminées entre 13 h et 15 h UTC » — c'est fini
>
> Le rapport du 08-11 avait relevé le seul point commun jamais trouvé entre les occurrences, en
> écrivant : *« Avec deux points ce n'est pas une loi — mais c'est la première chose à regarder
> s'il y a une troisième fois. »* Elle a été regardée. `sar -u` du 2026-08-12 :
>
> | Heure UTC | %user | %system | %idle |
> |---|---:|---:|---:|
> | 12:50:07 | 20,07 | 28,40 | 35,31 |
> | **13:00:00** | 21,19 | 29,38 | 35,69 |
> | **14:30:19** | 21,00 | 29,15 | 36,43 |
> | **15:00:27** | 20,34 | 28,69 | 36,46 |
> | 15:50:07 | 21,13 | 29,47 | 37,16 |
>
> **Aucun creux : la boucle a traversé la fenêtre 13 h–15 h sans ralentir.** L'hypothèse est morte,
> et c'est un résultat — elle aurait été la première chose regardée à chaque prochaine occurrence.
> *Une piste fermée vaut une piste ouverte* (c'est la troisième fermée sur ce constat, après
> `texto-relay` et le temps volé par l'hyperviseur).
>
> ### 🔴 Le `kill -USR1` est perdu pour la TROISIÈME fois — et la fenêtre est encore ouverte
>
> Il figurait en **point 0, hors classement, marqué périssable** dans les plans du 08-10, du 08-12,
> et il y figure encore. `Debug Mode = false` : aucun `pprof` en lecture seule. La différence, cette
> fois, est que **la boucle dure depuis 29 heures au lieu de quelques-unes** — c'est la fenêtre la
> plus large qui se soit jamais présentée, et les deux précédentes se sont refermées seules.
>
> ### Ce que ça ne coûte PAS, et qu'il faut dire
>
> La production répond **plus vite qu'hier** : app-tracky 200 en **47 ms**, `/api/health` 200 en
> **38 ms**. Aucun conteneur n'est tombé, 0 OOM, PSI `full` = 0. C'est le **processeur** qui manque,
> pas la mémoire — VPS-005 en tire la conséquence.

> ### Mesures des jours précédents, conservées
>
> - **2026-08-12** : `dockerd` à **99,3 %** d'un cœur, **1 208 307 à 1 237 782 `read()`/s pour 0,0008 octet ramené par appel**, charge machine **1,72**, PID **913 inchangé** (jamais redémarré depuis le 2026-08-04). Cumul **67,0 h / 176,2 h = 38,0 %**. **47 threads** (27 le 08-10), les 5 plus chauds tous en `futex_wait_queue`, dont `837313` et `156485` **déjà identifiés à la 2e occurrence**.
- **Mesure de la 2e occurrence (2026-08-10)** : 168–178 % d'un cœur, 2 332 107 `read()`/s pour 0 octet lu du disque, charge 2,70 → 3,20
- **Mesure à la découverte (2026-08-06)** : 100,6 % d'un cœur, 1 320 000 `read()`/s, 24,5 h de CPU pour 29,0 h d'uptime

> ### 🔴 2026-08-12 — TROISIEME OCCURRENCE, et la fenêtre de bascule contient enfin un événement
>
> **Début daté entre 21 h 00 min 24 et 21 h 10 min 26 UTC le 2026-08-11**, par `sar` :
>
> | Tranche UTC (08-11) | %user | %system | %idle |
> |---|---:|---:|---:|
> | 20:50:13 | 4,79 | 3,38 | 85,92 |
> | **21:00:24** | **4,82** | **3,39** | **86,18** |
> | **21:10:26** | **20,21** | **27,84** | **40,97** |
> | 21:20 → 23:50 | ~21,8 | ~31,2 | ~38,9 (stable) |
>
> **Le journal de `dockerd` sur cette fenêtre contient exactement six lignes, toutes le même
> sujet** : le déploiement du conteneur **`dronely-presentation`** (créé à **21 h 08 min 47,868**,
> image `nginx:alpine`), avec deux `sbJoin` sur le réseau `foodsqan-public` à 21 h 07 min 05 et
> 21 h 08 min 49. C'est un **nouveau service** sur la machine — 32 conteneurs contre 31.
>
> **C'est la première fois en trois occurrences qu'un événement identifié tombe À L'INTÉRIEUR
> d'une fenêtre de bascule.**
>
> ### ❌ Et c'est aussi la première fois qu'on peut le RÉFUTER comme cause commune
>
> Le test de falsification a été posé avant de conclure, et il échoue :
>
> | Occurrence | Fenêtre | Journal de `dockerd` dans la fenêtre |
> |---|---|---|
> | 1 — 2026-08-05 | ~02 h 23 | un **client coupé net** (`error reading preface from client`) |
> | 2 — 2026-08-10 | 01 h 10 → 01 h 20 | **rien** — aucune ligne du 08-09 21 h 26 au 08-10 02 h 26 |
> | **3 — 2026-08-11** | **21 h 00 → 21 h 10** | **un déploiement de conteneur, 2 `sbJoin`** |
>
> L'occurrence 2 n'a produit **aucune** activité du démon dans sa fenêtre — établi le 2026-08-10.
> Un déploiement de conteneur ne peut donc pas être la cause commune des trois.
>
> **Ce que ça change, et c'est un progrès** : l'hypothèse « il existe un déclencheur unique »
> devient **« plusieurs chemins distincts mènent au même état »** — ce qui est exactement ce
> qu'on attend d'un défaut interne au démon plutôt que d'une réaction à un stimulus, et ce qui
> est cohérent avec l'emballement de l'**ordonnanceur Go** établi le 2026-08-10.
>
> ⚠️ **Limite à ne pas redécouvrir** : la liste des dates de création ne contient que les
> conteneurs qui **existent encore** (`tracky-api` et `tracky-web` ont été recréés le 08-11 à
> 22 h 36). L'absence de création dans les fenêtres 1 et 2 est établie par le **journal**, qui est
> conservé — pas par cette liste. Leçon VPS-018 : une absence constatée d'un côté ne prouve rien
> de l'autre.
>
> ### ✅ L'hypothèse `texto-relay` est RÉFUTÉE — la quatrième case est remplie
>
> Le passage du 2026-08-11 écrivait : *« il ne manque que « absents **avec** boucle » pour réfuter
> définitivement. »*
>
> | | 2026-08-10 (boucle) | 2026-08-11 (calme) | **2026-08-12 (boucle)** |
> |---|---|---|---|
> | Descripteurs de `dockerd` | 299 | 294 | **317** |
> | Maximum par conteneur | **`texto-relay` : 7** | 1 partout | **2** (`foodsqan-traefik`) |
>
> **Le démon boucle avec un descripteur par conteneur.** L'anomalie n'est ni nécessaire ni
> suffisante : **écartée**. Elle avait occupé deux passages. *Une piste fermée vaut une piste
> ouverte.*
>
> ### La continuité par les threads — le meilleur argument dont on dispose
>
> 47 threads (27 le 08-10), les cinq plus chauds tous bloqués en `futex_wait_queue`, et **deux des
> tid identifiés le 2026-08-10 (`837313`, `156485`) sont toujours parmi eux**. Même processus,
> jamais redémarré, mêmes threads, même signature, deux occurrences plus tard. Le runtime Go a
> créé **20 threads système de plus** — le symptôme classique de goroutines bloquées qui forcent
> l'ordonnanceur à fabriquer de nouveaux `M`.
>
> ### 🔴 Le `kill -USR1` : troisième occasion, et il n'existe TOUJOURS aucune alternative
>
> `docker info` confirme **`Debug Mode = false`** : il n'y a **aucun `pprof`** à interroger en
> lecture seule. Le signal est le seul chemin, il coûte deux secondes, il n'arrête pas le démon,
> et il a été perdu deux fois. La boucle tourne **maintenant**.
>
> ⚠️ **`live-restore` monte dans le plan d'action** (7e → 4e rang) : l'option **ne s'applique pas
> rétroactivement**, et le constat en est à **trois occurrences en huit jours**. La poser
> aujourd'hui décide que le prochain redémarrage du démon coûtera 0 s au lieu de 50 s.
>
> **Seuil de réescalade** : franchi (99,3 % > 50 %). Statut → **`A_TRAITER`**.

> ### ✅ 2026-08-11 — la boucle s'est arrêtée SEULE une deuxième fois, après ~13 h 30
>
> **Durée : du 2026-08-10 ~01 h 15 au 2026-08-10 ~14 h 45 UTC.** Deux sources indépendantes, et
> elles concordent :
>
> - `sar` place la bascule entre **14 h 30** (19,51 user / 26,66 système / 5,66 inactif) et
>   **15 h 00** (4,62 / 3,29 / **86,41**) ;
> - l'arithmétique du CPU cumulé y conduit seule : **57,7 − 38,7 = 19,0 h de processeur en 24,0 h
>   écoulées**, soit ~13 h 30 à la cadence de ~1,4 cœur mesurée la veille.
>
> | | 1re occurrence | 2e occurrence |
> |---|---|---|
> | Début | 2026-08-05 ~02 h 23 | 2026-08-10 ~01 h 15 |
> | Fin | 2026-08-06 **~13 h 00** | 2026-08-10 **~14 h 45** |
> | Durée | 34 h 40 | **~13 h 30** |
> | Redémarrage du démon | aucun | **aucun — PID 913 inchangé** |
>
> **Les deux se sont terminées entre 13 h 00 et 15 h 00 UTC.** C'est le premier trait commun jamais
> trouvé entre elles. Avec deux points ce n'est pas une loi — mais c'est la première chose à
> regarder s'il y a une troisième fois.
>
> ### ✅ Fait neuf n° 1 — les sept descripteurs de `texto-relay` ont disparu, sans redémarrage
>
> | | 2026-08-10 | 2026-08-11 |
> |---|---|---|
> | Descripteurs ouverts par `dockerd` | 299 | **294** |
> | Répartition par conteneur | 1 partout **sauf `texto-relay` : 7** | **1 partout** |
> | Journaux de `texto-relay` | `json.log` **vide, daté du 08-05** + `.log.1` + `.log.2` | **un seul `json.log`, 13 252 o, daté du 08-11 02:25** |
>
> Le suiveur de journal s'est débloqué, le fichier courant est réécrit normalement, et la boucle a
> cessé. Hier cette anomalie était *« la première piste concrète que ce constat ait jamais eue »* ;
> elle a disparu **en même temps que le symptôme**, sans qu'on touche à rien.
>
> ⚠️ **Ce que ça n'établit pas.** Les deux peuvent être deux conséquences d'un même déblocage
> plutôt que cause et effet. Et l'objection du 08-10 tient toujours : ces descripteurs étaient
> coincés depuis le 08-05 **sans** boucle, donc ils ne suffisent pas. Ce qui a changé, c'est qu'on
> tient trois cases sur quatre — présents avec boucle, présents sans boucle, absents sans boucle.
> Il ne manque que « absents **avec** boucle » pour réfuter définitivement.
>
> ### ❌ Fait neuf n° 2 — le temps volé par l'hyperviseur n'est PAS le déclencheur
>
> C'était l'hypothèse la plus séduisante du passage : *un ordonnanceur Go qui tourne en rond parce
> que l'hyperviseur ne lui rend pas ses vCPU.* Elle explique les `futex`, l'absence d'E/S, et
> l'auto-résolution. **Elle est réfutée sur la chronologie.**
>
> | Heure UTC (08-10) | %steal | État |
> |---|---:|---|
> | 01:10:17 | **3,14** | avant la bascule |
> | 01:20:05 | **4,25** | **début de la boucle** |
> | 01:30:07 | 2,82 | boucle |
> | 05:30:00 | **24,01** | boucle |
> | 06:30 → 14:30 | **48 à 53** | boucle |
> | 15:00:00 | **5,37** | fin de la boucle |
>
> `%steal` valait sa valeur ordinaire **à l'instant même de la bascule**. Il ne monte que quatre
> heures plus tard, et retombe avec la boucle.
>
> ⚠️ **Et le reste du tableau ne prouve rien non plus, dans l'autre sens** : `%steal` se mesure sur
> le temps où nos vCPU sont *prêts et non servis*. Une machine saturée en déclare mécaniquement
> plus qu'une machine oisive, à contention d'hôte identique. Les 48 % peuvent être un **effet** de
> la boucle autant qu'une aggravation venue du voisinage. Ce qui est établi, et c'est tout : **ce
> n'est pas le déclencheur.**
>
> ### 🔴 Le `kill -USR1` a été perdu une DEUXIÈME fois
>
> Il figurait en **point 0 du plan du 2026-08-10, hors classement par rendement, marqué
> périssable, avec sa date de péremption écrite**. La boucle a duré **douze heures de plus** après
> la publication du rapport. Il n'a pas été lancé.
>
> Ce n'est plus un défaut d'instrumentation ni de hiérarchisation : le rapport disait où c'était,
> ce que ça coûtait (deux secondes), ce que ça risquait (rien) et quand ça périmerait. **La cause
> ne sera pas connue, et il n'y aura pas de troisième occasion mieux instrumentée que celle-ci.**
> La question devient celle du §9c du rapport du 08-11 : *ce plan est-il lu ?*
>
> ### ⚠️ Le détecteur de séquelle ne dira plus rien de ces 48 heures
>
> `dockerd` affiche **38,8 %** de cumul, sous le seuil de 50 % de VPS-M17 : **48 h de boucle
> cumulées sur ce processus ne produisent plus aucune ligne**, parce que l'uptime a grandi plus
> vite que le compteur. C'est le comportement voulu — VPS-M17 existait pour éteindre une alerte
> permanente sur une machine saine — mais il faut savoir que la trace s'efface toute seule :
> **seul ce référentiel garde l'histoire.**
>
> **Seuil de réescalade inchangé** : `A_TRAITER` à la première mesure instantanée de `dockerd`
> au-dessus de 50 % d'un cœur, **et le `kill -USR1` ce jour-là, avant toute autre chose**.

> ### 🔴 2026-08-10 — LA BOUCLE EST REVENUE, 1,8× PIRE, ET L'AUDIT EST HORS DE CAUSE
>
> Le seuil de réescalade écrit le 2026-08-07 — *« repasser en `A_TRAITER` à la première mesure
> instantanée de `dockerd` au-dessus de 50 % d'un cœur »* — est franchi trois fois.
>
> | Mesure | 08-06 (1re fois) | **08-10 (2e fois)** |
> |---|---:|---:|
> | CPU instantané | 100,6 % | **168–178 %** |
> | Appels `read()` par seconde | 1 320 000 | **2 332 107** |
> | Octets lus du disque | 0 | **0** (`read_bytes` identique à l'octet près) |
> | Charge 1 min | 1,16 | **2,70 → 3,20** |
> | PID / démarrage du démon | 913 · Aug 4 21:32:43 | **913 · Aug 4 21:32:43 — inchangés** |
>
> **Le démon n'a jamais été redémarré depuis le 2026-08-04.** C'est le même processus qui a
> déjà bouclé 34 h 40.
>
> ### ✅ Ce que ce passage établit et que le premier n'avait pas
>
> **1. L'audit n'y est pour rien.** `sysstat` date la bascule entre **01 h 10 et 01 h 20 UTC**
> (3,03 % système et 89 % d'inactivité à 01:10:17 ; 35,18 % et 36 % à 01:20:05 ; 53 % à partir
> de 01:30). La collecte a démarré à **02 h 21 min 29**, plus d'une heure après, et la moyenne
> de charge à 15 minutes valait déjà 2,75 au premier octet écrit. C'est un recul net pour la
> question ouverte de VPS-M12 : sur deux emballements, **le premier suivait une commande de
> l'audit interrompue, le second n'a aucun rapport avec lui**.
>
> **2. La boucle a démarré en SILENCE.** Aucune ligne de journal de `dockerd` entre le
> 2026-08-09 à 21 h 26 min 12 et le 2026-08-10 à 02 h 26 min 21 — et cette dernière est celle du
> collecteur dont un `timeout` a coupé un client (voir l'angle mort n° 2 du rapport du 08-10).
> Le `connection reset by peer` qui précédait la bascule du 08-05 n'a donc **pas** de
> contrepartie ici : il n'est pas la cause commune.
>
> **3. Ce sont des `futex`, pas une socket morte.** Sur les 27 threads du démon, trois portent
> l'essentiel (`tid=3786170` 50,3 %, `tid=837313` 45,3 %, `tid=156485` 33,3 %). Échantillonnés
> dix fois : soit `running` (espace utilisateur), soit `futex_wait_queue` (syscall 202). C'est
> un emballement de l'**ordonnanceur Go**.
>
> **4. Une piste concrète, la première : `texto-relay` monopolise 7 descripteurs de journal.**
> Sur les 299 descripteurs de `dockerd`, tous les conteneurs en ont **1** — sauf celui-là, qui
> en a **sept** : 3 sur un `json.log` **vide et daté du 2026-08-05 00:00**, 2 sur `.log.1`, 2 sur
> `.log.2`. C'est la signature d'un **suiveur de journal resté accroché à une rotation**, et un
> `read()` sur un fichier en cache de pages n'incrémente pas `read_bytes` — donc c'est
> **compatible** avec les deux millions de lectures par seconde.
>
> ⚠️ **Ce n'est PAS une cause établie** : cet état date du 08-05 et la boucle du 08-10. Cinq
> jours de descripteurs coincés sans boucle prouvent qu'ils ne suffisent pas.
>
> **5. Le seul événement planifié de la fenêtre est `fstrim`** (01 h 17 min 17 → 01 h 17 min 49,
> 43,8 Gio libérés). ⚠️ **Coïncidence, pas cause** : `fstrim` est hebdomadaire **le lundi**, et
> le premier emballement était un **mercredi**. L'hypothèse est faible mais **falsifiable
> gratuitement** — prochain passage le **lundi 2026-08-17 à 01 h 38 UTC**.
>
> ### Ce que ça coûte, mesuré
>
> Collecte à **300 s au lieu de 88** ; charge de 0,09 à 2,70 ; taux de forks tombé de 1 758 à
> **1 098/min** à sondes constantes — la même chute qu'au 08-06 (1 332 → 966), et c'est un
> symptôme : une machine dont un cœur est confisqué crée moins de processus parce qu'elle n'y
> arrive plus. **Ce que ça ne coûte PAS** : la production répond — `/api/health` en **52 ms**
> pendant que la machine est à 140 % de charge.
>
> ### ⚠️ Le `kill -USR1` a été perdu une DEUXIÈME fois
>
> C'est la seule commande qui donnerait la cause, elle ne s'exécute que **pendant** la boucle, et
> elle est interdite par la règle de lecture seule (c'est un signal, donc une écriture). Elle
> figurait en étape 1 du plan du 2026-08-06 ; elle figure en **point 0** de celui du 2026-08-10,
> hors classement par rendement et marquée **périssable**. Si personne ne l'exécute pendant que
> la boucle dure, la cause sera perdue pour la deuxième fois — et il n'y aura pas de troisième
> occasion mieux instrumentée que celle-ci.
>
> ### ✅ Ce que le collecteur sait faire de plus depuis ce passage
>
> La signature qui distingue « il travaille » de « il tourne en rond » — des `read()` par seconde
> confrontés aux octets réellement lus — n'existait que dans les vérifications manuelles, deux
> passages de suite. Elle est désormais dans le script, **conditionnée au verdict 🔴** (coût nul
> sur une machine saine) et avec ses trois branches, dont *« beaucoup d'appels **mais** le disque
> répond → c'est du travail réel, ne pas conclure à la boucle »*. Sans elle, les trois builds de
> la veille au soir auraient été un diagnostic concurrent parfaitement plausible.

> ### 2026-08-08 — état intermédiaire, conservé
>
> `dockerd` à **0,7 %** en instantané, cumul retombé à **46,2 %** — sous le seuil des 50 %, donc le 🟠 « SÉQUELLE » s'est éteint **de lui-même**, par dilution des 34 h de boucle dans un uptime qui grandit. Deuxième passage consécutif sans rechute ; le 08-07 est la première journée *complète* au régime normal (4,48 % user / 3,46 % système, contre 20,27 / 28,60 le 08-05).

> ### ✅ 2026-08-07 — la boucle s'est arrêtée TOUTE SEULE, après 34 h 40
>
> | Mesure | 2026-08-06 | 2026-08-07 |
> |---|---:|---:|
> | CPU instantané de `dockerd` | **100,6 %** d'un cœur | **1,0 %** |
> | Appels `read()` par seconde | **1 320 000** | **66** |
> | Charge 1 min de la machine | 1,16 | **0,35** |
> | PID / date de démarrage du démon | 913 · Aug 4 21:32:43 | **913 · Aug 4 21:32:43 — inchangés** |
>
> **Le démon n'a pas été redémarré** : même PID, même date de démarrage. Aucune commande de
> remédiation n'a été exécutée. Il s'est décoincé sans intervention.
>
> **Deux sources indépendantes datent l'arrêt à la même heure.** `sar` du 08-06 montre une
> bascule nette entre 12 h 50 (30,06 % de temps système, 37 % d'inactivité) et 13 h 10
> (3,69 % / 81 %). Et l'arithmétique du CPU cumulé y conduit seule : 35,1 h aujourd'hui contre
> 24,5 h hier, soit **10,6 h de CPU pour 23,8 h écoulées** — une boucle à ~100 % d'un cœur qui
> s'arrête après 10 h 40 de journée, c'est-à-dire vers 13 h 00 UTC.
>
> **Durée totale : du 2026-08-05 à 02 h 23 au 2026-08-06 à ~13 h 00 UTC.**
>
> ### ❌ Ce qu'on ne saura jamais, et pourquoi
>
> `dockerd` n'a écrit **aucune ligne de journal** depuis le 2026-08-05 à 02 h 23 min 18 s — ni
> pendant la boucle, ni au moment où elle a cessé. Le vidage des goroutines (`kill -USR1`), seul
> moyen de connaître la cause, n'était possible que **pendant** la panne. Il figurait en étape 1
> du plan d'action du 2026-08-06 ; il n'a pas été fait, et l'état a disparu avec la boucle.
>
> **La leçon de méthode, et elle vaut au-delà de ce constat** : une action dont la valeur
> s'évapore en quelques heures ne se met pas dans une liste d'actions classée par rendement.
> Elle se signale comme **périssable**, avec sa date de péremption. Un plan d'action suppose
> implicitement que ses points valent autant demain qu'aujourd'hui ; celui-là ne valait plus rien
> le lendemain midi.
>
> ### Pourquoi `SURVEILLANCE` et non `APPLIQUE`
>
> Rien n'a été corrigé — la panne est partie comme elle est venue, et la cause est inconnue.
> Elle peut donc revenir. **Seuil de réescalade** : repasser en `A_TRAITER` à la première
> mesure instantanée de `dockerd` au-dessus de 50 % d'un cœur, et **faire le `kill -USR1`
> ce jour-là, avant toute autre chose**.
>
> ⚠️ **Ne pas lire le `🟠 SÉQUELLE` du collecteur comme une rechute.** Le CPU cumulé de
> `dockerd` porte les 34 h de boucle **jusqu'au redémarrage du démon** : le ratio restera
> au-dessus de 50 % pendant des semaines sur une machine parfaitement saine. C'est « maintenant »
> qui tranche — voir VPS-M17.

**Quoi.** Le démon Docker consomme sans interruption la moitié d'une machine à 2 vCPU depuis le
2026-08-05 vers 02 h 20 UTC.

| Mesure | Valeur | Source |
|---|---|---|
| CPU instantané | **100,6 %** d'un cœur | delta `/proc/913/stat` sur 5 s |
| CPU cumulé / uptime | **24,5 h / 29,0 h** = 84 % en moyenne | `utime+stime` ÷ `CLK_TCK` |
| Appels `read()` | **1 320 000 par seconde** | delta `syscr` de `/proc/913/io` sur 8 s |
| Octets lus du disque | **0** — `read_bytes` strictement identique | même mesure |

**Un million trois cent mille lectures par seconde qui ne ramènent aucun octet** : c'est la
signature d'une **boucle d'attente sur un descripteur de fichier**, pas d'un parcours de disque.

**La cause probable.** La dernière ligne écrite par `dockerd` dans son journal — la dernière
depuis 24 h — date du 2026-08-05 à 02 h 23 min 18 s :
`http2: server: error reading preface from client @: read unix /run/docker.sock->@: read:
connection reset by peer`. Un **client Docker a coupé brutalement sa connexion**, et `sysstat`
place la bascule vers 31 % de temps système entre 02 h 20 et 02 h 40 — la même fenêtre.

Deux candidats, tous deux issus de l'audit : la collecte du 2026-08-05 s'est achevée à 02 h 23,
et le `docker system df -v` interrompu au bout de dix minutes (VPS-M12) a suivi.
**Ce qui trancherait** : un vidage des goroutines. Non fait — c'est un signal, donc une écriture.

**Ce que ça coûte, mesuré.** Collecte à **136 s au lieu de 58** (script inchangé) ; charge de
fond de 0,38 à 1,16–1,34 ; taux de forks de 1 332 à 966/min à sondes constantes ; et le
**ramasse-miettes de BuildKit ne tourne plus** (`cache.db` figé au 08-05 01 h 50).

**Pourquoi c'était invisible.** L'audit savait tout dire des **conteneurs** (`docker stats`) et
rien des processus de l'**hôte**. `dockerd` n'est pas un conteneur. La moyenne journalière de
`sysstat` diluait le pic, les 31 conteneurs restaient `healthy`, et le démon répondait
normalement (`docker ps` en 258 ms). Corrigé : voir VPS-M14.

**Quoi faire.** L'ordre compte, et l'inverser coûte la seule chance de comprendre :

1. `kill -USR1 $(pgrep -o dockerd)` — écrit la pile des goroutines dans le journal **sans
   arrêter le démon**. À faire **avant** l'étape 2, qui efface l'état pour toujours.
2. `systemctl restart docker` — rend ~50 % du processeur.
3. `"live-restore": true` dans `daemon.json` — pour les redémarrages *suivants*.

**⚠️ Contrepartie de l'étape 2** : `live-restore` est à **`false`**, donc le redémarrage
**arrête et relance les 31 conteneurs** (~50 s, mesuré au 2026-08-04). Les **31/31** sont en
`restart: unless-stopped` — vérifié — donc ils remontent seuls. Fenêtre : ~23 h 30 locales,
0 boîtier GPS connecté.

**À ne pas faire** :
- **Redémarrer la machine.** Le noyau est à jour, `redémarrage requis` est à `non`, et VPS-014 a
  démontré que la mémoire rendue revient en cinq heures. Seul `dockerd` est en cause.
- **Purger le cache de build** pour ses 10,53 Go : il est gelé *parce que* le démon est bloqué.
  C'est un symptôme de symptôme, et il se réglera seul à l'étape 2.
- **Compter sur `live-restore` pour éviter l'étape 2** : l'option ne s'applique pas
  rétroactivement.

---

## VPS-017 — 4,5 Go d'outillage de développement dans `/root` d'un serveur de production

- **Domaine** : disque · **Gravité** : 3 · **Statut** : `A_TRAITER`
- **Vu** : 2026-08-11 · **Mesure** : 4,5 Go, **~155 000 fichiers** — chiffres du 2026-08-06, **volontairement non remesurés** : ces quatre caches sont exclus du parcours de l'audit (c'est le correctif VPS-M16), donc les remesurer reviendrait à repayer exactement ce qu'on a supprimé. `/root` hors caches pèse **27 Mo**, et cette ligne-là est mesurée chaque passage : si `/root` grossit ailleurs, elle le dira.

**Quoi.** Le compte `root` de la machine de production héberge un environnement de développement
complet :

| Dossier | Taille | Fichiers |
|---|---:|---:|
| `/root/.local` | 2,6 Go | **120 867** |
| `/root/.npm` | 994 Mo | 26 718 |
| `/root/.cache` | 778 Mo | 3 805 |
| `/root/.claude` | 133 Mo | 3 244 |

Le reste de `/root` pèse **26 Mo**.

**Deux coûts distincts, et le second est le plus intéressant.** Le premier est 4,5 Go de disque.
Le second est que **l'audit lui-même les parcourait chaque nuit** : c'était le premier poste de
coût de la collecte, ~70 s sur 136. Les exclure a ramené le passage à 65 s (VPS-M16).

**Pourquoi c'était invisible.** `du -sh /root` affichait « 3,2 Go » depuis le premier passage,
au milieu de `/opt` (5,4 Go) et `/var/backups` (6,9 Go) — un chiffre plausible sur un serveur,
qu'on lit sans le questionner. Il fallait descendre d'un niveau pour voir que c'est un cache npm.

**Quoi faire.** `rm -rf /root/.npm/_cacache /root/.cache` rendrait l'essentiel, mais **le vrai
sujet n'est pas les 4,5 Go** : c'est qu'un serveur qui héberge sept bases de production sert
aussi de poste de développement. La question à trancher est *pourquoi ces outils sont là*, et
si le travail qui les a déposés doit continuer à s'y faire.

**Gain** : 4,5 Go (≈ 5 % du disque), et une surface d'attaque réduite.
**Contrepartie** : le prochain usage de `npm` ou de ces outils sur la machine repartira d'un
cache vide.

**À ne pas faire** : `rm -rf /root/.local` à l'aveugle. Ce dossier contient aussi
`~/.local/bin` et `~/.local/share` — des binaires et des données d'application installés par
l'utilisateur, pas seulement du cache. Regarder avant, dossier par dossier.

---

## VPS-018 — Un dépôt de code supprimé est parcouru chaque nuit par l'audit

- **Domaine** : disque · **Gravité** : 4 · **Statut** : `A_TRAITER` — **PORTÉE RÉDUITE DE MOITIÉ le 2026-08-08**
- **Vu** : 2026-08-13 · **Mesure** : ⚠️ **NON COMPARABLE, et pire qu'hier — 11 / 18 sous-dossiers**, en 46 s (plafond global de 45 s atteint). Sept manquants, tous nommes par le collecteur : `maalem vizyo-auth vizyo-leads vizyo-manager vizyo-texto vizyo-tracky vizyo-verify`. Le total affiche (0,6 Go) ne vaut **rien** : la machine perd un coeur depuis 29 h (VPS-016). Nouveaute : `/opt/dg-epaviste-depannage` coute **7 130 ms** pour 253 Mo — il rejoint `vizyo-leads` au rang des dossiers chers en inodes. Le decoupage de VPS-M26 fait exactement ce pour quoi il a ete ecrit : **rendre ce qui a pu etre mesure et NOMMER ce qui manque**. *(mesure du 2026-08-12, conservee : ⚠️ **NON COMPARABLE ce passage — 14 / 18 sous-dossiers seulement** (plafond global de 45 s atteint, `/opt/maalem` abandonne apres 12 s la ou il coutait **975 ms** hier). Le total affiche, 2,8 Go, ne vaut RIEN face aux 6,0 Go de la veille : ce n'est pas le disque qui a change, c'est la machine amputee d'un coeur par VPS-016. Le decoupage de VPS-M26 fait exactement ce pour quoi il a ete ecrit — rendre ce qui a pu etre mesure et NOMMER ce qui manque (`maalem vizyo-texto vizyo-tracky vizyo-verify`). **Un sous-dossier de plus** : `/opt/dronely-presentation` (3 Mo, 40 ms). *(mesure du 2026-08-11, conservee : `/opt` = 6,0 Go, 17/17 sous-dossiers* (remesuré après deux passages sans chiffre) · **437 345 inodes** · `/opt/vizyo-leads` **823 Mo, et 6,4 s sur les 25 s du parcours — soit ~25 % du coût, pour du code qui ne tourne plus** · `/opt/foodsqan` **291 Mo — À NE PAS TOUCHER, voir ci-dessous**.)*

> ### ✅ 2026-08-11 — le coût par sous-dossier est enfin MESURÉ, et il confirme la thèse
>
> Ce constat affirmait depuis quatre passages que *« le coût n'est pas dans les octets mais dans
> les inodes »*, sur la foi d'un comptage d'inodes fait une fois. Le parcours par sous-dossier
> introduit par VPS-M26 le démontre directement :
>
> | Taille | Dossier | Coût du parcours |
> |---:|---|---:|
> | 1,6 G | `/opt/maalem` | **975 ms** |
> | 1,2 G | `/opt/vizyo-tracky` | 5 857 ms |
> | 1005 M | `/opt/vizyo-manager` | 4 688 ms |
> | **823 M** | **`/opt/vizyo-leads`** | **6 423 ms** |
> | 440 M | `/opt/vizyo-auth` | 3 663 ms |
> | 291 M | `/opt/foodsqan` | 412 ms |
> | **6,0 Go** | **total (17/17)** | **25 s** |
>
> **`/opt/maalem` pèse deux fois `/opt/vizyo-leads` et coûte six fois moins.** La corrélation avec
> les octets est nulle ; celle avec les inodes est nette.
>
> **Le gain de VPS-018 est donc plus grand qu'estimé** : la fiche disait « ~16 % du coût de la
> commande la plus chère » ; c'est **~25 %**, mesuré. `/opt/vizyo-leads` est à lui seul le poste le
> plus cher du parcours, sans conteneur ni projet compose depuis le 2026-08-04, et son dépôt
> distant existe (`git@github-leads:vizyoagency-create/vizyo-leads.git`).
>
> ⚠️ **Les 25 s ne sont PAS comparables aux 26,3 s du 08-09** : la mesure a été prise après un
> `du /opt` abandonné qui avait déjà tiédi le cache d'inodes. VPS-M18 interdit d'en tirer une
> conclusion de performance, et on n'en tire ici qu'une **répartition**, qui est robuste au cache
> (tous les sous-dossiers ont été lus dans les mêmes conditions).
>
> ⚠️ **`/opt` est passé de 5,4 à 6,0 Go** depuis le 2026-08-07. Rien d'alarmant sur 96 Go, mais
> c'est la première fois que ce chiffre bouge — il faudra deux points de plus pour dire si c'est
> une dérive ou un déploiement.

> ### 🔴 2026-08-08 — la moitié de ce constat était FAUSSE, et le correctif proposé était DANGEREUX
>
> Ce constat affirmait que `vizyo-leads` et `foodsqan` « n'ont plus aucun conteneur ». C'est vrai
> pour le premier. **C'est faux pour le second, et de la pire façon** :
>
> ```
> docker compose ls
> docker   running(1)   /opt/foodsqan/docker/docker-compose.prod.yml
> ```
>
> `/opt/foodsqan` porte la définition de **`foodsqan-traefik`**, l'unique conteneur qui tient les
> ports **80 et 443** de la machine — donc le reverse proxy de `app-tracky.vizyoagency.com` et de
> toute la production (**VPS-021**). Le point 8 du plan d'action du 2026-08-07,
> *« retirer `/opt/vizyo-leads` et `/opt/foodsqan` »*, aurait supprimé le fichier de définition du
> point d'entrée HTTPS de la machine entière.
>
> **Pourquoi je m'étais trompé.** J'ai déduit « pile morte » de « conteneurs supprimés le 08-04 »
> (VPS-006) sans jamais vérifier qu'il n'en restait aucun **rattaché à ce dossier**. La
> vérification tenait en une commande : `docker compose ls` affiche le chemin du fichier de
> configuration de chaque projet. Elle n'a été lancée qu'au cinquième passage, et seulement parce
> que le champ `com.docker.compose.project` venait d'être ajouté au collecteur pour une autre
> raison. **Le nom du dossier a été pris pour le périmètre du dossier.**
>
> **Ce qui reste vrai** : `/opt/vizyo-leads` — 823 Mo, 68 681 inodes, aucun conteneur, aucun
> projet compose. Son dépôt distant existe
> (`git@github-leads:vizyoagency-create/vizyo-leads.git`), donc le code n'est pas perdu si on le
> retire. **Le gain tombe de ~71 000 à ~68 700 inodes** — presque rien de changé au chiffre,
> beaucoup au risque.
>
> **Leçon générale, et elle a une famille** : une absence constatée d'un côté (`docker ps` ne
> montre plus de conteneur applicatif `foodsqan-*`) ne prouve rien de l'autre. C'est VPS-M02/M08
> déplacé d'un cran : ici ce n'est pas une ligne qui manquait à une liste, c'est **une liste
> entière qu'on n'a jamais demandée**.

**Quoi.** `/opt` est le premier poste de coût de la collecte : `du /opt` est la commande la plus
lente du script (~52 s à froid sur les cinq parcours de la section 3, contre ~2,6 s à chaud).
La cause n'est pas la taille — 5,4 Go — mais le **nombre d'inodes** : ce sont des dépôts de code
complets, `node_modules` compris.

| Dossier | Inodes |
|---|---:|
| `/opt/maalem` | 134 140 |
| `/opt/vizyo-tracky` | 77 641 |
| **`/opt/vizyo-leads`** | **68 681** |
| `/opt/vizyo-manager` | 68 235 |
| `/opt/vizyo-auth` | 42 464 |
| `/opt/vizyo-texto` | 25 370 |
| **`/opt/foodsqan`** | **2 410** |

**`vizyo-leads` et `foodsqan` n'ont plus aucun conteneur** : leurs piles ont été supprimées le
2026-08-04 (VPS-006), et leurs volumes figurent parmi les 13 orphelins de VPS-009. On parcourt
donc chaque nuit **71 091 inodes de code qui ne tourne plus**, soit **16 % du coût de la
commande la plus chère de l'audit**.

**Pourquoi c'était invisible.** `du -sh /opt` affiche « 5,4 Go » depuis le premier passage — un
chiffre modeste sur un serveur, qu'on lit sans le questionner. Le coût n'est pas dans les octets
mais dans les inodes, et **aucune des quatre collectes ne mesurait le temps par chemin** : il a
fallu VPS-M18 pour que la question se pose. Même famille que VPS-017, découvert exactement de la
même manière un passage plus tôt.

**Quoi faire.** Vérifier d'abord que ces dépôts ne sont pas la seule copie de quelque chose :

```bash
ls -la /opt/vizyo-leads/.git/config /opt/foodsqan/.git/config
```

**Gain** : ~71 000 inodes de moins parcourus chaque nuit, et une machine de production qui cesse
d'héberger le code de projets abandonnés.
**Contrepartie** : si le dépôt distant n'existe plus, le code est perdu — d'où la vérification
préalable, qui n'est pas une formalité.

**À ne pas faire — MIS À JOUR le 2026-08-08** : toucher à **`/opt/foodsqan`**. Ce dossier n'est
pas mort : il définit le reverse proxy de toute la production (VPS-021). C'est l'action que ce
constat recommandait et qu'il ne faut pas faire.

**À ne pas faire** : étendre le raisonnement à `/opt/vizyo-tracky` ou `/opt/maalem`. Ce sont les
dossiers de déploiement **actifs** : ils portent les `docker-compose.prod.yml`, les scripts de
sauvegarde et les fichiers d'environnement de la production.
`/opt/vizyo-tracky/deploy/vps/backup-db.sh` est la seule sauvegarde qui fonctionne sur cette machine.

**À ne pas faire non plus** : cesser de mesurer `/opt` pour tenir le budget de collecte. Un
serveur dont le second poste disque n'est plus surveillé est un serveur qu'on découvre plein.

---

## VPS-019 — `wire_logs` pèse 242 Mo — elle a bien une rétention

- **Domaine** : données · **Gravité** : 4 · **Statut** : `ACCEPTE` — **DIAGNOSTIC CORRIGÉ le 2026-08-08**
- **Vu** : 2026-08-13 · **Mesure** : **241 Mo — a l'octet pres le meme qu'hier — ~710 951 lignes (estime)** sur une fenetre glissante de **5 jours** (2026-08-09 → 2026-08-13), 24 % de `tracky_prod`. L'estime de lignes bondit de 34 % pendant que la **taille ne bouge pas d'un Mo** : c'est la signature d'une fenetre glissante qui reutilise ses pages liberees, pas d'une accumulation. *(mesure du 2026-08-12, conservee : **241 Mo, ~528 846 lignes (estimé)** sur une **fenêtre glissante de 4 jours** (2026-08-09 → 2026-08-12) — 24 % de `tracky_prod`.)*

> ### ❌ 2026-08-08 — « jamais purgée, sans rétention » était FAUX. Elle a une rétention.
>
> Une requête sur la plage de dates, disponible depuis le premier jour, suffit à renverser le
> constat :
>
> ```sql
> select min("createdAt")::date, max("createdAt")::date, count(distinct "createdAt"::date) from wire_logs;
>  2026-08-04 | 2026-08-08 | 5
> ```
>
> **La table ne contient que cinq journées.** À ~175 000 lignes/jour, les ~700 000 lignes
> observées sont exactement le **régime permanent** d'une fenêtre glissante de quatre jours — pas
> une accumulation. Les 242 Mo sont **stables et auto-régulés**.
>
> **Ce qui a mis sur la piste** : le nombre de lignes a **baissé** entre deux passages,
> 719 955 → 710 557. Une table en ajout seul ne perd pas 9 398 lignes. Ce chiffre impossible a
> révélé au passage un défaut de méthode bien plus large — **VPS-M20**, la colonne « vivantes »
> est un estimé.
>
> **Pourquoi je m'étais trompé.** J'ai lu « 0 ligne morte » comme *« rien n'a jamais été
> supprimé »*, alors que ça veut dire *« rien n'attend d'être récupéré **en ce moment** »*.
> `n_dead_tup` est remis à zéro par l'autovacuum — passé ici le 2026-08-07 à 20 h 20. C'est un
> **instantané d'un état transitoire, pris pour un historique**. La même erreur guette
> `position_sampling_decisions`, qui affiche elle aussi 0 ligne morte.
>
> **Ce qui reste vrai, et c'est tout ce qui reste** : ces 242 Mo entrent dans chaque `pg_dump`
> nocturne — un quart de la sauvegarde — pour de la donnée qui sera effacée sous quatre jours.
> C'est un fait à connaître, pas un risque à traiter. **Aucune action, aucun seuil de
> réescalade** : il n'y a rien qui dérive.

> ### Ce qui suit décrit l'état des connaissances au 2026-08-07 — conservé, mais démenti ci-dessus

**Quoi.** C'est la **deuxième table de la base de production**, entre `positions` (377 Mo) et
`position_sampling_decisions` (208 Mo). Elle représente **un quart de la base**, donc un quart de
chaque `pg_dump` nocturne, chaque nuit, depuis toujours.

**Zéro ligne morte sur 719 955** : rien n'y a jamais été supprimé ni mis à jour. C'est un journal
en écriture seule, sans rétention.

**Pourquoi c'était invisible.** Ce n'est **pas** un défaut d'instrumentation : le collecteur
affiche les 8 plus grosses tables, elle y figurait à chaque passage. C'est un **défaut de
lecture** — trois rapports ont commenté en détail `positions` et `position_sampling_decisions`
sans jamais mentionner celle qui est entre les deux. L'attention est allée à la table dont le
*nom* évoquait un problème (« décisions d'échantillonnage », de la donnée de diagnostic) plutôt
qu'à celle dont le *chiffre* le disait.

Et il est impossible de dater depuis quand elle pèse 242 Mo : **les sorties brutes de collecte ne
sont archivées nulle part**, seuls les rapports le sont. Une mesure affichée mais non commentée
est donc définitivement perdue — c'est l'angle mort n° 1 du rapport du 2026-08-07.

**Quoi faire.** Question produit avant toute chose, exactement comme pour VPS-008 : *`wire_logs`
a-t-elle un lecteur au-delà du débogage de trames ?* Si c'est le journal brut des trames Coban,
une rétention à 30 jours rendrait l'essentiel des 242 Mo et allégerait chaque sauvegarde.

**Seuil de réescalade** : si elle dépasse `positions`, ou si `tracky_prod` franchit 1,5 Go.

**À ne pas faire** : poser une rétention avant d'avoir la réponse. 242 Mo sur un disque à 51 %
ne justifient pas de supprimer une donnée qu'on n'a pas fini de comprendre — et un `DELETE` sur
720 000 lignes sans `VACUUM FULL` ne rend d'ailleurs rien au disque.

---

## VPS-020 — Deux applications sans rapport partagent le projet compose `deploy`

- **Domaine** : docker · **Gravité** : 2 · **Statut** : `CORRECTIF_PROPOSE`
- **Vu** : 2026-08-13 · **Mesure** : **7 conteneurs, 2 applications, 1 seul projet compose** — inchange, **7e passage** (`deploy` : 4 Maestroo dev + 3 Vizyo Manager prod). *(mesure du 2026-08-12, conservee : **7 conteneurs, 2 applications, 1 seul projet compose** — inchangé, 6e passage (`deploy` : 4 Maestroo dev + 3 Vizyo Manager prod)

**Quoi.** `docker compose ls` le dit sans détour :

```
NAME     STATUS         CONFIG FILES
deploy   running(7)     /opt/maestroo/deploy/docker-compose.dev.yml,/opt/vizyo-manager/deploy/docker-compose.prod.yml
```

| Projet `deploy` | Conteneurs |
|---|---|
| Maestroo (dev) | `maestroo-dev-api`, `maestroo-dev-lp`, `maestroo-dev-postgres`, `maestroo-dev-web` |
| **Vizyo Manager (prod)** | `vizyo-manager-api`, `vizyo-manager-dashboard`, **`vizyo-manager-postgres`** |

**La cause est mécanique.** Compose dérive le nom du projet du **nom du dossier** quand ni
`name:` ni `COMPOSE_PROJECT_NAME` n'est déclaré. `/opt/maestroo/deploy` et
`/opt/vizyo-manager/deploy` s'appellent tous deux `deploy`. Vérifié : aucun des deux dépôts ne
déclare de nom de projet.

**Ce que ça risque.** Un `docker compose up -d` ou `down` lancé dans l'un des deux dossiers voit
les conteneurs de l'autre comme des **orphelins**, l'annonce, et **recommande
`--remove-orphans`** — c'est Compose lui-même qui suggère la commande qui supprimerait les sept.
Le plus exposé est **`vizyo-manager-postgres`** : abonnements Stripe, factures et clients, dont
la dernière sauvegarde a **114 jours** (VPS-013). Les deux constats se multiplient : une perte
définitive à une commande de distance.

**Ce qui est établi** : le nom de projet partagé, les sept conteneurs, l'absence de `name:`, et
la fusion des deux fichiers par `docker compose ls`.
**Ce qui ne l'est pas** : que l'avertissement soit effectivement affiché au déploiement — le
vérifier demanderait de lancer `up`, donc d'écrire. **Aucun script de `/opt` ne contient
`--remove-orphans` aujourd'hui** (vérifié) : le piège est armé, pas déclenché.

**Pourquoi c'était invisible.** L'audit affichait les conteneurs par **nom**. Or les noms sont
corrects et distincts (`maestroo-dev-*`, `vizyo-manager-*`) : rien dans la liste ne pouvait
laisser deviner qu'ils appartiennent au même projet. Le seul indice public traînait en tête du
tableau des images depuis cinq passages — `deploy-api:latest` et `deploy-web:latest`, des noms
préfixés par le projet — et personne, moi compris, n'a demandé de quel projet il s'agissait.

**Quoi faire.** Une ligne par dépôt, au **prochain déploiement volontaire** de chacun :

```yaml
name: vizyo-manager   # première ligne de docker-compose.prod.yml
```

```yaml
name: maestroo-dev    # première ligne de docker-compose.dev.yml
```

**Contrepartie** : les conteneurs existants restent rattachés à `deploy`. Au premier `up`
suivant, Compose en crée de nouveaux sous le nouveau nom et les anciens deviennent orphelins —
ce n'est donc pas une modification à faire à la va-vite.

**L'ordre compte** : sauvegarder `vizyo-manager-postgres` **avant** de toucher au nom de projet.
Renommer d'abord, c'est manipuler la pile qui porte la base non sauvegardée.

**À ne pas faire** : `docker compose down --remove-orphans` dans l'un de ces deux dossiers tant
que les noms ne sont pas séparés. C'est exactement la commande que Compose propose.

---

## VPS-021 — La porte d'entrée HTTP/HTTPS de toute la production appartient à une pile déclarée morte

- **Domaine** : docker · **Gravité** : 2 · **Statut** : `CORRECTIF_PROPOSE`
- **Vu** : 2026-08-13 · **Mesure** : **1 seul conteneur tient les ports 80 et 443**, et il en sert desormais **25** (24 hier ; `dronely-devis` s'ajoute sur le meme domaine). Bout-en-bout du 2026-08-13 : app-tracky **200 en 47 ms**, `/api/health` **200 en 38 ms**, `tracky.vizyoagency.com` **200 en 45 ms**, app-verify **302 en 68 ms** — pendant que la machine perd un coeur depuis 29 h (VPS-016), et **plus vite qu'hier**. ⚠️ Il n'a toujours AUCUNE sonde de sante, et ils sont maintenant **9 sur 33** dans ce cas. *(mesure du 2026-08-12, conservee : **1 seul conteneur tient les ports 80 et 443** — et il en sert desormais **24** (23 hier : `dronely.vizyoagency.com` s'y ajoute). Bout-en-bout du 2026-08-12 : app-tracky **200 en 49 ms**, `/api/health` **200 en 86 ms**, pendant que la machine perd un coeur (VPS-016). ⚠️ Il n'a toujours AUCUNE sonde de sante, et ils sont maintenant **8 sur 32** dans ce cas., et il s'appelle `foodsqan-traefik` — inchangé, et confirmé par la table de routage à chaque passage (23 domaines, 19 conteneurs étiquetés). Le bout-en-bout du 2026-08-11 le retraverse : app-tracky **200 en 220 ms**, `/api/health` **200 en 214 ms**. ⚠️ **2026-08-10 — le bout-en-bout HTTP le prouve désormais autrement que par les étiquettes** : `app-tracky.vizyoagency.com` répond **200 en 133 ms** et `/api/health` **200 en 52 ms**, à travers ce conteneur, pendant que la machine tourne à 140 % de charge. Le jour où il tombera, ce sont ces quatre lignes qui le diront — et non pas `docker ps`, puisqu'il n'a **aucune sonde de santé**.

**Quoi.**

```
docker ps --format '{{.Names}}\t{{.Ports}}' | grep -E ':80->|:443->'
foodsqan-traefik   0.0.0.0:80->80/tcp, [::]:80->80/tcp, 0.0.0.0:443->443/tcp, [::]:443->443/tcp
```

> ✅ **2026-08-09 — ce constat n'a plus besoin d'être retrouvé à la main.** Il avait été découvert
> par trois commandes lancées en marge, après cinq passages où l'audit listait les conteneurs par
> nom sans jamais dire ce qu'ils servent. Le collecteur affiche désormais, à chaque passage, une
> table **domaine → conteneur → projet** (23 domaines, 19 conteneurs étiquetés) **et** la ligne
> qui nomme le tenant des ports 80/443 : `foodsqan-traefik (projet docker)`. Le jour où ce
> conteneur changera, disparaîtra ou cédera les ports, la sortie le dira d'elle-même — y compris
> le cas « **PERSONNE ne publie 80/443** », qui est écrit en clair. Voir aussi VPS-023 : la même
> table a révélé que 16 des 35 certificats du volume ACME ne servent plus aucun conteneur.

Le reverse proxy de **toute** la production s'appelle `foodsqan-traefik`. Les étiquettes le
confirment :

```
tracky-web  traefik.http.routers.tracky-web.rule = Host(`app-tracky.vizyoagency.com`)
            traefik.docker.network               = foodsqan-public
```

**Le réseau Docker sur lequel Tracky publie s'appelle `foodsqan-public`.**

| Fait | Source |
|---|---|
| Défini par `/opt/foodsqan/docker/docker-compose.prod.yml` | `docker compose ls` |
| Projet compose : **`docker`** (le nom du dossier) | étiquette `com.docker.compose.project` |
| Certificats TLS dans le volume `foodsqan-letsencrypt` | `docker inspect .Mounts` |
| La pile FOODSQAN a été déclarée abandonnée le 2026-08-04 | VPS-006 |
| **Le plan du 2026-08-07 proposait de supprimer `/opt/foodsqan`** | rapport du 08-07, point 8 |

**Le danger n'est pas dans la machine, il est dans le rapport.** Le point 8 du plan de la veille
aurait supprimé le fichier de définition du point d'entrée HTTPS de la machine entière. Les
conteneurs en cours n'en seraient pas morts — Docker garde leur configuration — mais **plus
personne n'aurait pu recréer le proxy**, ni retrouver ses paramètres ACME. Sur une machine dont
c'est l'unique entrée HTTPS, c'est une panne irréparable à retardement.

**Pourquoi c'était invisible.** Trois raisons qui se renforcent :
1. le conteneur s'appelle `foodsqan-*` et la pile FOODSQAN est morte — **le nom ment sur le
   rôle, et il ment dans le sens rassurant** ;
2. l'audit affichait les conteneurs par nom, jamais par projet ni par **ports publiés** : rien ne
   rattachait `foodsqan-traefik` à `app-tracky.vizyoagency.com` ;
3. la section 6 affiche `0.0.0.0:443 docker-proxy` depuis le premier passage — mais
   `docker-proxy` est le même processus pour tous les conteneurs publiants : la ligne ne nomme
   personne.

**Quoi faire.** Rien dans l'urgence : **ça fonctionne**. Ce qui doit changer, c'est que le rôle
soit lisible.

1. Poser un `NE-PAS-SUPPRIMER.txt` dans `/opt/foodsqan` (2 min, risque nul) — le prochain
   lecteur du plan d'action sera prévenu avant d'agir.
2. À terme, déplacer la définition vers `/opt/infra-proxy/`, avec un `name: infra-proxy`
   explicite. **Risque réel** : le réseau `foodsqan-public` est référencé par étiquette dans
   *chaque* pile qui publie ; le renommer sans toutes les mettre à jour coupe tout. À ne faire
   qu'en fenêtre, avec quelqu'un devant.

**À ne pas faire** : supprimer `/opt/foodsqan`, et toucher au volume `foodsqan-letsencrypt`, qui
porte les certificats de tous les domaines publics.

---

## VPS-022 — Trois jetons GitHub en clair dans `/opt`, lisibles par tous

- **Domaine** : sécurité · **Gravité** : 2 · **Statut** : `A_TRAITER`
- **Vu** : 2026-08-13 · **Mesure** : **3 fichiers**, dont deux en mode **644** — inchange, **6e passage sans action**. Le correctif (`chmod 600`) coûte 10 secondes et n'a aucun effet de bord.

**Quoi.** `/opt/foodsqan/.git/config` contient une URL de dépôt de la forme
`https://ghp_…@github.com/vizyoagency-create/foodsqan.git` — un **jeton d'accès personnel
GitHub en clair**, dans un fichier lisible par n'importe quel compte de la machine.

| Fichier | Mode | Date |
|---|---|---|
| `/opt/foodsqan/.git/config` | **644** | 2025-12-30 |
| `/opt/dg-epaviste-depannage/.git/config` | **644** | — |
| `/opt/foodsqan/.env.production` | à vérifier | — |

**Ce qui est établi** : ces jetons sont présents, en clair, sur une machine qui héberge sept
bases de production.
**Ce qui ne l'est pas** : qu'ils soient encore valides. Les vérifier voudrait dire les **envoyer
à GitHub**, ce qui est exactement ce qu'on ne fait pas avec un secret trouvé par hasard. Ils
doivent être traités comme compromis de toute façon — ils l'ont été à l'instant où ils sont
apparus dans une sortie de commande.

**Pourquoi c'était invisible.** L'audit regardait les clés **SSH** (VPS-012, les 4 clés
d'`authorized_keys`) parce que c'est là qu'on cherche un accès à une machine. Un jeton dans un
`.git/config` n'est pas un accès à *la machine* : c'est un accès **aux dépôts**, donc au code de
production et à ses secrets de CI. Personne ne l'avait cherché là.

**Quoi faire.** L'ordre est l'inverse de l'intuition :

1. `chmod 600` sur les trois fichiers — 10 secondes, aucun effet de bord.
2. **Ensuite** révoquer les jetons depuis GitHub (Settings → Developer settings → Personal
   access tokens) et remplacer les URL par du SSH, comme `/opt/vizyo-leads` le fait déjà
   (`git@github-leads:…`) — un alias SSH ne se recopie pas dans un fichier de configuration.

**À ne pas faire** : révoquer d'abord. Sans savoir ce qui s'en sert, on casse un déploiement à
l'aveugle. Et ne pas chercher les jetons avec un `grep -r` sur `/opt` sans exclure
`node_modules` : c'est 437 345 inodes, et la leçon de VPS-018 vaut aussi pour les recherches.

---

## VPS-023 — 16 certificats TLS sur 35 ne servent plus aucun conteneur

- **Domaine** : docker · **Gravité** : 4 · **Statut** : `ACCEPTE`
- **Vu** : 2026-08-13 · **Mesure** : **36 certificats**, **25 domaines** routes par un conteneur vivant, **16 orphelins — inchange**. ✅ **La prediction ecrite le 2026-08-11 s'est verifiee au jour pres** : cette fiche annoncait que les deux certificats Tracky, expirant le 11 septembre, seraient renouveles « vers le 12 aout » (30 j avant). `acme.json` a ete reecrit le **2026-08-12 a 21 h 33**, et les deux expirent desormais le **10 novembre 2026**. Le renouvellement automatique est prouve **par l'evenement**, pas par la lecture d'une configuration. *(mesure du 2026-08-12, conservee : **36 certificats** dans le volume ACME (+1 : `dronely.vizyoagency.com`, verifie **servi et valide** — emetteur Let's Encrypt, expire le 9 novembre), **24 domaines** routés par un conteneur vivant, **16 orphelins — inchangé**. `acme.json` modifie le **2026-08-11 a 20 h 10**, ce qui prouve que le mecanisme d'emission fonctionne : le nettoyage automatique n'a rien a faire tant qu'aucun certificat n'approche son renouvellement. *(mesure du 2026-08-11, conservee : 35 certificats, 23 domaines, 16 orphelins* (`acme.json` toujours modifié le 2026-08-04 à 09 h 05). Les deux certificats Tracky servis expirent le **11 septembre 2026** : le renouvellement (30 j avant) tombe donc vers le 12 août. Le nettoyage automatique n'a rien à faire tant qu'aucun certificat n'approche son renouvellement.)*

**Quoi.** Le volume `foodsqan-letsencrypt` (441 Ko, `acme.json` modifié le 2026-08-04 à 09 h 05)
détient les certificats de 35 domaines. La table de routage dérivée des étiquettes
`traefik.http.routers.*.rule` n'en compte que **23** portés par un conteneur en service.

| Famille | Domaines orphelins |
|---|---|
| FOODSQAN | `api.foodsqan.app`, `app.foodsqan.app` |
| Vizyo Leads (pile supprimée) | `leads.vizyoagency.com`, `api.leads.vizyoagency.com` |
| Maalem / Slahni **production** | `slahni.com`, `app.slahni.com`, `admin.slahni.com`, `dev.slahni.com`, `admin-dev.slahni.com`, `s3.slahni.com`, `s3-dev.slahni.com`, `app.maalem-now.com`, `admin.maalem-now.com`, `s3.maalem-now.com` |
| Divers | `dev-mockups.maestroo.app`, `nebula.72.62.26.240.nip.io` |

**Pourquoi c'est en `ACCEPTE` et non en `A_TRAITER`.** Rien ne casse : Traefik renouvelle des
certificats que personne n'utilise, pour un coût réseau négligeable, et il cessera de le faire de
lui-même dès qu'aucun routeur ne les réclame. Le nettoyage est **automatique** ; le forcer
coûterait plus cher que de l'attendre.

**Ce que la mesure établit au passage**, et qui vaut plus que le constat lui-même :

1. **La production Maalem/Slahni n'est pas sur cette machine.** Seuls les conteneurs `-dev-` y
   tournent. C'était supposé depuis l'amorçage ; c'est désormais établi par les données.
2. **Le volume ACME n'est dans aucune sauvegarde.** Sa perte n'est pas dramatique — Let's Encrypt
   réémettrait — mais 35 domaines d'un coup approchent les limites de débit (50 certificats par
   semaine et par domaine enregistré). À savoir **avant** d'en avoir besoin.

**Pourquoi c'était invisible.** L'audit affichait `0.0.0.0:443 docker-proxy` depuis le premier
passage, mais `docker-proxy` est le même processus pour tous les conteneurs publiants : la ligne
ne nomme personne. Et il listait les conteneurs par **nom**, jamais par **domaine servi**. Il a
fallu la table de routage (ajoutée le 2026-08-09) pour que les deux moitiés — ce que le volume
contient, ce que la machine sert — soient enfin comparables.

**À ne pas faire** : éditer `acme.json` à la main pour en retirer les entrées orphelines. Le
fichier est lu **et réécrit** par un Traefik en cours d'exécution ; une écriture concurrente peut
corrompre les certificats des 23 domaines vivants, dont ceux de la production Tracky. Et ne pas
supprimer le volume au motif qu'il porte un nom `foodsqan-*` : c'est VPS-021 à l'identique.

---

## VPS-024 — ~~`positions` accumule 63 jours~~ → **RÉFUTÉ : elle a une rétention de ~62 jours**

- **Domaine** : données · **Gravité** : 4 · **Statut** : `ACCEPTE` (fermé le 2026-08-11)
- **Vu** : 2026-08-13 · **Mesure** : **386 Mo — inchange a l'octet pres** — du **2026-06-13 au 2026-08-13**, soit **62 jours**. Le `min` n'a pas bouge ce passage pendant que le `max` avancait : l'horizon **oscille entre 61 et 63 jours** au lieu de converger, ce qui est le comportement attendu d'une purge dont l'heure ne coincide pas avec celle de l'audit. Rien ne derive : la taille est identique alors que l'estime de lignes monte de 8,7 %. *(mesure du 2026-08-12, conservee : 386 Mo, du **2026-06-13 au 2026-08-12** — **61 jours**. `min` a **de nouveau** avancé de deux jours pendant que `max` avançait d'un : **deuxieme confirmation consecutive**, la retention converge vers ~60 jours. `wire_logs` et `position_sampling_decisions` passent a **4 jours** (5 la veille), meme mecanisme.

> ### ✅ 2026-08-11 — fermé au passage suivant, par la mesure écrite d'avance
>
> Le rapport du 2026-08-10 posait le test avant d'avoir la réponse : *« si `min` reste au
> 2026-06-09 pendant que `max` avance → aucune rétention ; si `min` avance d'un jour par jour →
> une rétention existe, son horizon est de ~63 jours. C'est falsifiable demain, gratuitement. »*
>
> | Table | 2026-08-10 | 2026-08-11 | Lecture |
> |---|---|---|---|
> | **`positions`** | 2026-06-09 → 2026-08-10 (**63 j**) | **2026-06-11 → 2026-08-11 (62 j)** | **`min` a avancé** |
> | `wire_logs` | 2026-08-06 → 2026-08-10 (5 j) | 2026-08-07 → 2026-08-11 (5 j) | fenêtre glissante |
> | `position_sampling_decisions` | 2026-08-06 → 2026-08-10 (5 j) | 2026-08-07 → 2026-08-11 (5 j) | fenêtre glissante |
>
> **Une table sans borne ne perd pas ses deux plus vieilles journées.** L'horizon est de ~62 jours,
> les 386 Mo sont un régime permanent, et le seuil de réescalade est supprimé — il ne pouvait pas
> être atteint. **Aucune action, rien à récupérer.**
>
> ### Ce que la comparaison avec VPS-008 apprend, et c'est le vrai gain de cette fiche
>
> | | VPS-008 | VPS-024 |
> |---|---|---|
> | Objet | `position_sampling_decisions` | `positions` |
> | Ouvert le | 2026-08-05 | 2026-08-10 |
> | Fermé le | 2026-08-10 | **2026-08-11** |
> | Passages de surveillance | **6** | **1** |
> | Ce qui était écrit à l'ouverture | ce qu'on **soupçonnait** (« a-t-elle un lecteur ? ») | **quelle mesure trancherait** |
>
> La donnée était disponible dès le premier jour dans les deux cas, et la requête coûte zéro. La
> différence tient entièrement à ce qui a été écrit dans la fiche : *un constat qui énonce son
> critère de réfutation se ferme au passage suivant ; un constat qui énonce un soupçon se surveille
> indéfiniment.* C'est le corollaire pratique de la leçon de VPS-008 (« écrire qu'un piège est
> adjacent ne le désarme pas, seule la mesure le désarme »), et cette fois il a payé.
>
> ### Ce qui suit décrit l'état des connaissances au 2026-08-10 — conservé, mais démenti ci-dessus
>
> - **Mesure du 2026-08-10** : 386 Mo, 1 426 101 lignes (comptage exact), du 2026-06-09 au
>   2026-08-10 — 63 jours distincts et contigus

**Quoi.** La requête qui a réfuté VPS-008 a désigné, du même geste, la seule des trois grosses
tables de `tracky_prod` qui s'accumule vraiment :

| Table | Plage | Jours | Lecture |
|---|---|---:|---|
| `positions` | 2026-06-09 → 2026-08-10 | **63** | accumulation |
| `wire_logs` | 2026-08-06 → 2026-08-10 | 5 | fenêtre glissante |
| `position_sampling_decisions` | 2026-08-06 → 2026-08-10 | 5 | fenêtre glissante |

**Ce qui est établi** : 63 journées présentes, 1 426 101 lignes exactes, 386 Mo — soit **39 % de
`tracky_prod`** (992 Mo) et autant de chaque `pg_dump` nocturne.
**Ce qui ne l'est PAS, et c'est l'essentiel** : qu'aucune rétention n'existe. 63 jours peuvent
être *« aucune borne »* comme *« une borne à 60-70 jours »* — les deux produisent exactement la
même sortie aujourd'hui. **Une plage de dates mesurée une seule fois ne distingue pas les deux.**

**Comment on tranchera, gratuitement, au passage suivant** :

- si **`min` reste au 2026-06-09** pendant que `max` avance → aucune rétention, la table grossit
  sans borne, et le sujet devient réel ;
- si **`min` avance d'un jour par jour** → une rétention existe, son horizon est de ~63 jours, et
  ce constat se ferme comme VPS-008.

**Pourquoi c'était invisible.** Le collecteur affiche la taille des 8 plus grosses tables depuis
le premier jour, et `positions` y figurait toujours en tête. Une **taille** ne dit pas si une
table s'accumule ou se régule : 208 Mo stables peuvent être une fenêtre glissante en régime
permanent (c'était le cas — VPS-008) ou une accumulation qui n'a pas encore fait de dégâts. Six
passages ont commenté des tailles et des deltas de lignes ; **aucun n'a demandé les dates**.

**Seuil de réescalade** : passer en `A_TRAITER` si `min` est **inchangé** au passage suivant *et*
que `tracky_prod` franchit **1,5 Go**.

**À ne pas faire** : poser une rétention sur la foi de cette seule mesure. C'est exactement ce
que VPS-008 vient de coûter — six passages de surveillance sur une hypothèse qu'une requête
réfutait. Et un `DELETE` massif sans `VACUUM FULL` ne rend d'ailleurs rien au disque.

---

## VPS-025 — Le disque a pris 23 Go en 24 heures, et le mécanisme censé le borner a parfaitement tenu

- **Domaine** : disque · **Gravité** : 2 · **Statut** : `A_TRAITER`
- **Vu** : 2026-08-13 · **Mesure à la découverte** : 50 Go (52 %) → **73 Go (76 %)** en 24 h, **23 Go libres** ; inodes 14 % → **26 %**

**Quoi.**

| Mesure | 2026-08-12 | 2026-08-13 | Δ |
|---|---:|---:|---:|
| Disque utilisé | 50 Go (**52 %**) | **73 Go (76 %)** | **+23 Go** |
| Inodes | 1 742 356 (14 %) | **3 314 771 (26 %)** | +1 572 415 |
| Images (`docker system df`) | 25 / 25,16 Go | 27 / **50,13 Go** | +24,97 Go |
| Cache de build (total affiché) | 10,39 Go / 77 | **36,42 Go / 182** | +26,03 Go |
| — dont **`Private`** (gouverné par `keepStorage`) | 10,37 Go | **10,39 Go** | **+0,02 Go** |
| — dont `Shared` (partagé avec des images vivantes) | 0,02 Go | **26,03 Go** | +26,01 Go |

**La cause est datée et légitime** : **huit images construites le 2026-08-12 entre 07 h 08 et
17 h 01**, sur quatre projets (`tracky-api` 1,8 Go, `vizyo-verify-app` 1 Go, `maalem-dev-api`
2,33 Go, `deploy-api` 3,49 Go, plus quatre frontaux). `sysstat` le confirme sans passer par
Docker : **1 137 blocs/s écrits le 08-12** contre 23 les jours calmes.

**Et ces 23 Go ne sont pas récupérables.** Le ménage nocturne a tourné
(`Aug 13 00:40:01 CRON[3226328]: docker image prune -af --filter "until=24h"`) et il ne reste
**0 image pendante**. 26 des 27 images sont **actives**. Le prune est passé 1 h 40 avant la mesure
et les 23 Go sont restés : c'est un coût **net**.

**Pourquoi c'était invisible.** VPS-001 est en `APPLIQUE` depuis neuf passages, avec un mot d'ordre
répété à chaque rapport : *« NE PAS purger, le ramasse-miettes tient sa borne. »* **Il la tient** —
`Private` a bougé de **0,2 %** en 24 h sur un plafond de 10 Go. Un garde-fou qui fait exactement
son travail donne l'impression que le domaine est couvert ; il ne couvre que ce qu'il **gouverne**,
et ce qui a grossi n'a jamais été de son ressort. C'est VPS-M25 déplacé d'un cran : la mesure est
juste, le seuil est juste, le mécanisme est sain — et le domaine n'est pas couvert.

**Ce qu'on peut réellement récupérer, chiffré** :

| Poste | Gain | Durable ? |
|---|---:|---|
| Sauvegardes en double (24 journées, héritage VPS-003) | **2,8 Go** | ✅ |
| `/opt/vizyo-leads` (pile supprimée le 08-04, dépôt distant existant) | 0,8 Go | ✅ |
| Volumes orphelins | 0,4 Go | ⚠️ contiennent des bases — VPS-009 dit non |
| Journaux systemd | 0,1 Go | ❌ repoussent |
| Cache de build `Private` | 10,4 Go | ❌ revient au prochain build |

**Total durable : ~3,6 Go pour 23 Go libres.** Il n'existe pas de nettoyage qui règle ce constat,
et c'est l'information principale.

**Quoi faire.** La seule action dont le gain ne revient pas au prochain déploiement est un
arbitrage humain : **dix conteneurs de développement** (`maalem-dev-*` : 6, `maestroo-dev-*` : 4)
et leurs builds vivent sur la machine qui héberge sept bases de production. Leurs deux images
pèsent **5,8 Go** et leurs builds sont la première source de croissance du disque **et** de la
mémoire de `dockerd` (VPS-014).

**Seuil de réescalade** : `Gravité 1` si le disque franchit **85 %**, ou si l'espace libre passe
sous **10 Go** — soit une demi-journée de build au rythme observé.

**À ne pas faire** : lire « cache de build 36,42 Go » et lancer `docker buildx prune -af`. **26 des
36 Go sont `Shared` avec des images en service** ; le ramasse-miettes ne peut pas les libérer. La
commande rendrait les 10,39 Go de `Private`, qui reviendraient au prochain déploiement, au prix
d'un premier build 2 à 4× plus long. C'est le faux pas que VPS-M25 avait anticipé, et il se
présente aujourd'hui avec un chiffre trois fois plus impressionnant.

**⚠️ Aucun chiffre Docker n'est l'espace occupé** — à connaître avant d'en citer un :

| Source | Valeur | Ce qu'elle compte |
|---|---:|---|
| `docker system df` → Images | **50,13 Go** | blobs du *content store* **+** instantanés décompressés |
| Somme de `docker images` (27) | **16,80 Go** | chaque couche partagée recomptée par image |
| **`df`** | **73 Go** | **la seule mesure de l'espace réellement occupé** |

Un facteur **3** entre les deux nombres Docker, et **ce facteur a varié** (1,8× la veille).

---

## VPS-026 — La sauvegarde de Vizyo Verify télécharge une image depuis Docker Hub pour s'exécuter

- **Domaine** : sauvegardes · **Gravité** : 4 · **Statut** : `SURVEILLANCE`
- **Vu** : 2026-08-13 · **Mesure à la découverte** : 5 des 7 secondes de la sauvegarde du 2026-08-12 sont un `docker pull`

**Quoi.** Le journal de la première exécution réussie de `vizyo-verify-backup.service` :

```
Aug 12 07:10:25  backup.sh: Unable to find image 'alpine:latest' locally
Aug 12 07:10:26  backup.sh: latest: Pulling from library/alpine
Aug 12 07:10:27  backup.sh: Status: Downloaded newer image for alpine:latest
Aug 12 07:10:31  backup.sh: OK — base 12K + 13 fichiers 5.3M, vérifiées (7s)
```

Le seul dispositif de sauvegarde de **pièces d'identité** de la machine dépend donc, à 03 h 30, que
`registry-1.docker.io` réponde. Aujourd'hui il répond (401 en 249 ms, sonde de dépendances de la
section 6) — mais une panne, ou la limite de débit des tirages anonymes, suffirait à faire échouer
un chemin qui vient déjà d'échouer huit jours en silence (VPS-015).

**Ce qui est établi** : le tirage a eu lieu, il représente 5 des 7 secondes du travail, et
`alpine:latest` est aujourd'hui présent sur la machine.
**Ce qui ne l'est PAS** : pourquoi l'image était absente le 08-12.

> ### ⚠️ L'hypothèse évidente est FAUSSE, et la vérification a coûté une commande
>
> J'allais publier : *« le prune nocturne de 00 h 40 (`docker image prune -af --filter until=24h`)
> supprime `alpine` chaque nuit, donc chaque sauvegarde le retélécharge. »* Mécanisme plausible,
> conclusion nette, et elle aurait donné un constat de gravité 3 avec un correctif précis.
>
> **Vérification** : le prune a bien tourné cette nuit (`journalctl _COMM=cron`, 00 h 40 min 01), et
> `alpine:latest` **est présent** à 02 h 21. Il n'a pas été supprimé. L'hypothèse est réfutée.
>
> Le constat se limite donc à ce qui est établi : *le chemin de sauvegarde contient une dépendance
> réseau, aujourd'hui satisfaite par une copie locale.* C'est moins spectaculaire, et c'est vrai.

**Pourquoi c'était invisible.** Le tirage a **réussi**, donc rien ne s'en est plaint. Et la sonde
de dépendances mesure bien Docker Hub depuis le premier jour — mais rien ne reliait cette sonde à
un chemin de sauvegarde. Deux mesures justes, côte à côte, sans lien.

**Seuil de réescalade** : passer en `A_TRAITER` si `alpine:latest` est constaté **absent** à un
passage — la dépendance deviendrait alors active à chaque exécution — ou au premier échec de
sauvegarde imputé au réseau.

**Quoi faire, le jour où on s'en occupe.** Par ordre de coût croissant : épingler l'image par
empreinte et la pré-tirer hors de la fenêtre de sauvegarde ; ou vérifier si le `tar` + `gpg` a
réellement besoin d'un conteneur.

**À ne pas faire** : ajouter une exclusion au prune nocturne « au cas où ». On ne sait pas encore
que c'est lui, et le constat ci-dessus explique pourquoi cette certitude-là était fausse.

---

## Constats de méthode (sur l'audit lui-même)

### VPS-M33 — Le collecteur jetait ses propres messages d'erreur, et c'est ainsi que VPS-M28 a survécu

- **Vu** : 2026-08-13 · **Statut** : `APPLIQUE` (corrigé dans `collecte.sh` le jour même)

Angle mort n° 1 du rapport du 2026-08-12, et **il avait déjà coûté VPS-M28**. Le détecteur de
boucle de `dockerd` — *le* bloc écrit pour trancher le constat le plus lourd du dispositif —
était un programme `awk` invalide. Il n'a jamais rendu une ligne. `awk` refusait de compiler,
écrivait son erreur sur `stderr`, et `stderr` partait dans le néant : la collecte se lance
`ssh … > /tmp/collecte.txt`, sans que rien ne soit fait du canal 2.

**Le défaut n'a été vu que parce que ce matin-là `stderr` avait été redirigé vers un fichier
séparé, par habitude.** Une collecte lancée normalement l'aurait avalé une fois de plus.

**Un bloc qui échoue ne rend pas une erreur : il rend du VIDE.** Et un vide se lit exactement
comme « rien à signaler ». C'est la famille VPS-M02 / VPS-M08 / VPS-M21 — *un défaut qui rassure
n'a aucun plaignant* — appliquée non plus à une mesure, mais **au collecteur lui-même**.

**Correctif appliqué.** `stderr` est capturé dans un tampon à chemin **fixe** et **publié** en fin
de collecte, dans `stdout`, c'est-à-dire dans le rapport. Aucun `rm` — le garde-fou de lecture
seule est respecté, le fichier est tronqué à chaque passage et `systemd-tmpfiles-clean` s'en
charge. Le bloc est placé **avant** `FIN DE COLLECTE` à dessein : si le script meurt en route, le
marqueur de fin manque et la procédure impose déjà de relancer.

**Quatre branches essayées sur la machine** :

| Cas | Attendu | Rendu |
|---|---|---|
| collecte saine | ✅ | ✅ aucun message |
| le **vrai** `awk` de VPS-M28 | 🔴 | 🔴 2 lignes, `syntax error` |
| gabarit Go `hasPrefix` **+** regex `jq` à antislash mangé (les 2 autres familles de VPS-M22) | 🔴 | 🔴 4 lignes |
| tampon absent | ✅ sans plantage | ✅ |

### ⚠️ Le correctif lui-même était faux, et c'est le cas SAIN qui l'a révélé

Première version : `NB_ERR=$(grep -c . "$ERRBUF" || echo 0)`. **`grep -c` sort en statut 1 quand
il ne compte rien, tout en écrivant « 0 » sur `stdout`** : le `|| echo 0` ajoutait une *seconde*
ligne, et `[ "0\n0" -eq 0 ]` devenait `integer expression expected`. **Le cas sain — celui de tous
les jours — s'affichait en 🔴 avec un compte absurde.**

C'est l'exact inverse de VPS-M28 : là, un bloc conditionné à la panne n'était jamais traversé ;
ici, un bloc qui n'aurait *que* le cas sain à traiter se serait trahi dès le premier passage. Il a
été attrapé avant publication parce que les quatre branches ont été essayées — **discipline
VPS-M13** (*la sortie d'un nouveau contrôle se relit ligne à ligne avant d'être publiée*), et elle
a payé le jour même où elle servait.

**⚠️ Portée, écrite dans la sortie elle-même pour qu'on ne la surestime pas.** Ce compteur ne voit
que ce qui n'est **pas** déjà tu par un `2>/dev/null` local, et le script en pose une centaine —
volontairement, pour des erreurs *attendues*. **Un zéro ne dit donc pas « aucune erreur », il dit
« aucune erreur INATTENDUE ».** C'est exactement la classe à laquelle appartenait VPS-M28, et
c'est pourquoi le correctif vaut malgré sa portée partielle.

### VPS-M34 — Le levier PostgreSQL n'examinait que la moitié des bases, et pas les mêmes d'un jour à l'autre

- **Vu** : 2026-08-13 · **Statut** : `APPLIQUE` (corrigé dans `collecte.sh` le jour même)

Le levier 4 portait un `head -3` : il ne gardait que les **trois premiers** conteneurs dans
l'ordre — arbitraire — de `docker ps`. **Il y en a six.**

| Passage | Bases affichées |
|---|---|
| 2026-08-08 → 08-12 | `tracky` · `maestroo-dev` · `maalem-dev` |
| **2026-08-13** | **`vizyo-verify`** · `tracky` · `maestroo-dev` |

**La liste a changé de composition** après une recréation de conteneurs, et **rien n'a jamais
signalé qu'il en manquait trois, ni que ce n'étaient pas les mêmes.**

**Ce que ça a coûté, et ce n'est pas théorique.** VPS-007 a été clos en `APPLIQUE` le 2026-08-04
sur la phrase : *« Reste à 4 sur `maalem-dev-postgres` et `maestroo-dev-postgres` : bases de
**développement**, aucun enjeu de plan de requête. »* Le levier corrigé rend **cinq** bases à 4,
dont **trois de PRODUCTION** — `vizyo-verify-postgres` (pièces d'identité),
`vizyo-manager-postgres` (Stripe, factures, clients) et `texto-postgres`. La phrase a été écrite en
lisant une liste qui ne les a **jamais** contenues. **VPS-007 est rouvert.**

**Correctif appliqué.** `head -3` retiré, et surtout **le dénominateur affiché dans tous les cas** —
c'est lui le vrai correctif, pas la suppression du `head` (leçon VPS-M08). **Les deux branches
essayées sur la machine** : `✅ 6 / 6 bases PostgreSQL examinees` en nominal, et
`🔴 6 / 7 — 1 N ONT PAS REPONDU` en injectant une base muette. Coût : +3 `docker exec`.

**Leçon générale, et elle va plus loin que VPS-M08.** Un bloc jamais exécuté produit du **silence** ;
un bloc exécuté sur une **liste tronquée** produit une **conclusion** — et cette conclusion est
ensuite écrite dans le référentiel, marquée `APPLIQUE`, et plus personne n'y revient. *Une règle
écrite ne s'applique pas rétroactivement au code déjà là* : VPS-M22 exigeait depuis le 2026-08-09
que toute extraction annonce son dénominateur, et ce `head -3` lui était antérieur — il a même été
**édité la veille** (correctif SIGPIPE) sans que personne ne demande pourquoi il était là.

### VPS-M32 — Le verdict du ramasse-miettes était aveugle au signe de l'écart qu'il mesurait

- **Vu** : 2026-08-13 · **Statut** : `APPLIQUE` (corrigé dans `collecte.sh` le jour même)

Le bloc « Fraîcheur des MÉCANISMES » compare la date du dernier build à celle de `cache.db`. Il
prenait la **valeur absolue** de l'écart :

```bash
ECART=$(( DC - DB )); [ "$ECART" -lt 0 ] && ECART=$(( -ECART ))   # ← le défaut
```

…puis affirmait, au-delà de 600 s, *« un build a eu lieu **sans** que le ramasse-miettes
s'exécute »*. **Les deux sens disent pourtant des choses opposées** :

| Sens | Ce que ça signifie |
|---|---|
| `cache.db` **plus ancien** que le build | le mécanisme n'a pas tourné — c'est le défaut |
| `cache.db` **plus récent** que le build | le mécanisme a tourné **après** — c'est le contraire |

Le 2026-08-13 il a rendu **🔴 sur un écart de +3 894 s** — `cache.db` écrit **65 minutes APRÈS** le
dernier build — donc sur un ramasse-miettes qui venait précisément de travailler. Et la
décomposition du levier 1 le confirmait à l'octet près sur la même sortie : `Private` **10,37 →
10,39 Go en 24 h**, sur un plafond de 10 Go. **Le détecteur désignait le seul mécanisme sain de la
journée**, un jour où le disque perdait 23 Go (VPS-025) — c'est-à-dire qu'il aurait envoyé le
lecteur purger le cache au lieu de regarder les images.

**Correctif appliqué.** Le signe est conservé, trois branches distinctes, et la branche « plus
récent » **renvoie explicitement au levier 1** : *« si du volume reste malgré ça, la cause est
ailleurs — `keepStorage` ne gouverne que `Private` »*. **Les trois essayées sur la machine**, avec
des valeurs réelles : (a) 08-13, +3 894 s → ✅ ; (b) 08-08, même seconde → ✅ *coïncident* ;
(c) `cache.db` 2 h **avant** le build → 🔴, le vrai défaut, correctement redétecté. **Contre-épreuve**
indispensable et faite : l'ancienne logique rejouée sur (a) rend bien le 🔴 faux.

**Leçon générale.** *Une différence sans son signe n'est pas une mesure, c'est une distance.* C'est
le corollaire temporel de VPS-M27 (*une mesure de fin sans mesure de début est un niveau, pas un
delta*) : dans les deux cas on avait jeté l'information qui portait la **direction**, donc celle qui
désignait un responsable. Et c'est la famille VPS-M10 / M25 / M31 : **un garde-fou qui accuse le
mécanisme sain est plus dangereux qu'un garde-fou absent** — celui-ci a eu exactement une occasion
de parler, et il a désigné le mauvais coupable.

### VPS-M28 — Le détecteur écrit pour trancher VPS-016 n'avait jamais tourné, et il était faux deux fois

- **Vu** : 2026-08-12 · **Statut** : `APPLIQUE` (corrigé dans `collecte.sh` le jour même)

Le 2026-08-10, la deuxième boucle de `dockerd` a conduit à porter dans le collecteur la mesure qui
avait *nommé* la panne : des `read()` par seconde confrontés aux octets réellement lus du disque.
Elle a été **conditionnée au verdict 🔴** pour ne rien coûter sur une machine saine. Elle a donc eu
exactement **une** occasion de s'exécuter : le 2026-08-12, troisième occurrence. Voici sa sortie :

```
── Signature de boucle — des read() sans octets, c'est une attente, pas du travail (VPS-016) ──
     ⚠️ Le vidage des goroutines (kill -USR1) trancherait la CAUSE — c est une ECRITURE,
        donc hors de cet audit. Il n est possible que PENDANT la boucle : voir VPS-016.
```

**Le titre, l'avertissement, et rien entre les deux.** La cause :

```
awk: cmd. line:7:     else if (dc > 100000)
awk: cmd. line:7:     ^ syntax error
```

En `awk`, un `if` sans accolades ne prend **qu'une instruction**. Le bloc en enchaînait deux, puis
un `else` — que l'analyseur ne pouvait plus rattacher. `awk` refusait de compiler le programme
**entier**, écrivait son erreur sur `stderr` — que la collecte jette — et ne rendait rien.

> **Ce n'est visible que si l'on sépare `stderr`.** Ce matin-là il était redirigé vers un fichier
> distinct, par habitude ; c'est la seule raison pour laquelle l'erreur a été lue. Une collecte
> lancée normalement l'aurait avalée une fois de plus. **C'est l'angle mort n° 2 du rapport du
> 2026-08-12, et il en masque potentiellement d'autres.**

### ⚠️ Le second défaut, découvert en essayant le premier correctif

Réparé de sa syntaxe et rejoué sur la machine en panne, le bloc a rendu :

```
dockerd  1208307 read()/s   1022 octets/s lus du disque
🟠 beaucoup d appels MAIS le disque repond : c est probablement du travail reel
```

**Un million deux cent mille appels par seconde pour mille octets — 0,0008 octet par appel — et le
verdict innocente la panne.** Le test était `db == 0`, une **égalité stricte**, écrite d'après une
unique observation où `read_bytes` était identique à l'octet près. Il suffit qu'un journal de
conteneur s'écrive pendant la fenêtre pour que le détecteur déclare « travail réel » sur un démon
qui brûle un cœur depuis huit heures.

> **Réparer la syntaxe seule aurait transformé un SILENCE en FAUSSE RASSURANCE** — strictement
> pire (VPS-M21 : *un défaut qui rassure n'a aucun plaignant*). Un silence finit par se remarquer ;
> un 🟠 rassurant est lu, cru, et clôt la question.

**Correctif appliqué.** Accolades posées ; le seuil porte sur les **octets ramenés par appel** et
non sur le débit ; un garde distingue « aucun appel » de **« mesure NON FAITE »** (VPS-M02).
Ajouté : les trois threads les plus chauds avec leur `wchan` et le compte de threads — la mesure
qui a nommé la panne deux fois et qui vivait encore dans les vérifications manuelles. **Les trois
branches ont été essayées sur la machine**, dont les valeurs réelles du 08-12 et du 08-10 (🔴), un
démon sain (`containerd`, 24 read()/s → ✅) et un PID inexistant (garde déclenchée).

⚠️ **Ce que le bloc corrigé ne prouve toujours pas, et qui est désormais dans sa sortie** :
`read_bytes` ne compte que les octets venus **du disque**. Un build relisant des fichiers déjà en
cache de pages produirait la même signature. Les discriminants réels sont le **cumul CPU / uptime**
et le **`wchan`** — le bloc les nomme, au lieu de laisser croire qu'il conclut seul.

**Leçon générale, et c'est un TYPE de défaut, pas un accident d'écriture.** *Un code qui ne
s'exécute QUE pendant une panne n'est jamais traversé par les passages normaux, donc jamais
démenti.* Le garde `if [ "$EMB_PID" ]` avait été posé pour une bonne raison — ne rien coûter quand
tout va bien — et il a rendu ce bloc **inatteignable** les jours où on aurait pu constater qu'il ne
marchait pas. Le collecteur contient plusieurs autres blocs de cette famille (« 0 domaine rendu »,
« mesure ABANDONNEE », « PERSONNE ne publie 80/443 », « conteneurs qui ne remonteront pas »).
**Chacun est un garde-fou, et chacun n'existe que le jour où il sert.**

### VPS-M29 — Le compte de paquets de sécurité était publié quelle que soit la fraîcheur du cache

- **Vu** : 2026-08-12 · **Statut** : `APPLIQUE` (corrigé dans `collecte.sh` le jour même)

Angle mort n° 1 du rapport du 2026-08-11, et il aura coûté huit passages. Trois lectures du **même
collecteur** en trois jours :

| Passage | Âge du cache apt | Paquets | dont sécurité | Ce que ça valait |
|---|---:|---:|---:|---|
| 2026-08-04 → 08-10 | 12 à 25 h | 59 | **0** | artefact — il y en avait 11 |
| 2026-08-11 | **3 min** | 70 | **11** | mesure, par coup de chance |
| 2026-08-12 | **27 h** | 59 | **0** | **juste, mais par accident** (ils avaient été installés) |

VPS-M11 affichait honnêtement la date du cache à côté du chiffre depuis huit passages, et le
rapport rappelait à chaque fois qu'« un 0 ici n'est pas une garantie ». **Personne n'en a jamais
tiré la conséquence.** Aucune ligne ne séparait *« il n'y en a pas »* de *« on ne peut pas
savoir »*.

**Correctif appliqué.** Au-delà de **6 h de cache**, le chiffre est dégradé au rang d'indicatif et
le verdict devient `🟠 NON MESURABLE`, avec la phrase « NE PAS reporter ces deux nombres comme une
mesure ». Vérifié sur la machine (cache de 27 h → NON MESURABLE). **Un seul
`apt list --upgradable` au lieu de deux** (VPS-M05 n° 3, énième récidive : la commande déroule
tout le cache, et on la lançait deux fois pour deux comptages).

**Ajouté dans la foulée** : la date de la dernière installation `apt`, parce qu'**un paquet
installé n'est pas un service redémarré**. C'est ce qui explique l'écart 11 → 0 de ce matin, et
c'est aussi ce qui permet de voir que `libsystemd0` a été remplacé sous les pieds de `dockerd`.

**Leçon générale.** *Un chiffre affiché est un chiffre cru.* La contre-mesure à une mesure dont la
fenêtre dépend d'un producteur invisible n'est pas de mieux l'annoter — c'est de **refuser de la
publier**. C'est VPS-M24 (*instrumenter n'est pas arbitrer*) appliqué à VPS-M11, et il aura fallu
que le même collecteur publie 0, puis 11, puis 0 pour que ce soit fait.

### VPS-M30 — La section 4 lançait ~160 `docker inspect` séparés, sur la machine dont le démon Docker tourne en boucle

- **Vu** : 2026-08-12 · **Statut** : `APPLIQUE` (corrigé dans `collecte.sh` le jour même)

Répartition mesurée du 2026-08-12 : **section 4 = 78 s sur 236**, premier poste de la collecte —
**devant la section 5 (26 s)**, que l'angle mort n° 3 du rapport de la veille désignait comme « le
poste le plus rentable » sur la foi de ses 54 s.

> **La désignation était juste le jour où elle a été faite, et fausse le lendemain.** *Un
> classement de coûts se refait à chaque passage, il ne se recopie pas.* Même famille que
> VPS-M18 : une durée n'est pas une propriété du script, mais du script × la machine × le moment.

Le compte : 32 appels pour la table des conteneurs, 32 pour les limites CPU, **64** pour les sondes
de santé de la section 7, 32 pour le levier 3, plus **deux** sérialisations complètes du JSON des
32 conteneurs pour `jq`. Chacun ouvre une connexion au socket du démon — sur une machine dont ce
démon est justement en train de tourner en boucle.

**Correctif appliqué.** `docker inspect` accepte N identifiants et applique le gabarit à chacun :
**~160 appels → 5**. La table, les limites CPU, la politique de redémarrage, la carte des projets
et le levier 3 dérivent tous du **même texte** ; les deux requêtes `jq` partagent une seule
sérialisation. Résultats **identiques vérifiés champ par champ** sur la machine : 32/32 décrits,
0 limite CPU, 32/32 `unless-stopped`, 29/32 sans limite mémoire, même carte des projets,
65 invocations/min.

⚠️ **Le piège VPS-M08 n'est PAS re-tendu, et c'est délibéré** : `{{.HostConfig.NanoCpus}}` reste
dans un gabarit **séparé** de `.State.Health`. Sa présence fait basculer `docker inspect` sur la
représentation en map, où une clé absente devient une erreur qui vide la ligne entière — c'est ce
qui avait fait disparaître sept conteneurs en silence, dont deux de production. Le contrôle
« compte attendu vs compte obtenu » est **conservé tel quel** : c'est lui le vrai correctif, et il
vaut exactement autant en un appel qu'en trente-deux.

⚠️ **Aucun gain de vitesse n'est revendiqué** (VPS-M18 : la comparaison a été faite dans la foulée,
donc sur un cache chaud). Le gain démontré est **structurel** : 160 connexions au socket → 5.

### VPS-M31 — Le détecteur de doublons de sauvegarde a affirmé quelque chose de faux

- **Vu** : 2026-08-12 · **Statut** : `APPLIQUE` (corrigé dans `collecte.sh` le jour même)

Sortie du 2026-08-12 :

```
journees concernees : 24 — la plus recente : 20260811 (il y a 1 j)
✅ HISTORIQUE — plus aucun doublon depuis 1 jour(s). Ces fichiers partiront a la retention.
```

**Une seconde copie du 08-11 avait été écrite sept heures plus tôt**, à 22 h 20. La comparaison se
faisait en **jours calendaires** : tout ce qui date d'hier soir se lit « historique ».

Le garde avait été posé pour une bonne raison — éviter un faux positif quotidien sur les 25
journées en double héritées d'avant le correctif VPS-003 — et, ce faisant, **il masquait désormais
exactement l'événement qu'il existe pour voir**. C'est la famille VPS-M10 / VPS-M25 : *un garde-fou
qui cache un défaut est plus dangereux qu'un garde-fou absent.*

**Et le vrai critère n'est pas l'âge, c'est l'écart entre les deux copies.** VPS-003 était « deux
planificateurs à deux minutes d'intervalle ». Une sauvegarde de pré-déploiement lancée à la main en
pleine soirée est un doublon **légitime**, et le confondre avec une rechute ferait chercher un
second planificateur qui n'existe pas.

**Correctif appliqué.** Le verdict porte sur l'écart, et les heures sont affichées. **Vérifié dans
les deux sens sur la machine** :

| Journée | Copies | Écart | Verdict rendu |
|---|---|---:|---|
| 2026-08-11 | 03 h 03 + 22 h 20 | 1 156 min | 🟠 lancée à la main — **pas** VPS-003 |
| 2026-08-04 | 03 h 00 + 03 h 02 | **1 min** | 🔴 **DEUX PLANIFICATEURS** — correctement redétecté |
| 2026-08-03 | 03 h 00 + 03 h 00 | **0 min** | 🔴 **DEUX PLANIFICATEURS** — correctement redétecté |

Une contre-épreuve sur les vraies journées VPS-003 était indispensable : un détecteur qu'on assouplit
pour supprimer un faux positif doit prouver qu'il attrape encore les vrais.

**Leçon générale.** Quand un garde-fou produit un faux positif, la tentation est d'élargir sa
tolérance. C'est presque toujours la mauvaise réponse : ce qu'il faut, c'est trouver **la grandeur
qui sépare vraiment les deux cas** — ici l'écart horaire, pas l'ancienneté. Une tolérance élargie
finit toujours par avaler le vrai cas.

### VPS-M27 — Le budget mesurait la fin de la collecte sans jamais mesurer son début

- **Vu** : 2026-08-11 · **Statut** : `APPLIQUE` (corrigé dans `collecte.sh` le jour même)

Le bloc **BUDGET** posé la veille (VPS-M24) affichait la charge de la machine **à la fin** de la
collecte, avec la consigne : *« avant d'accuser le script, relire la charge ci-dessus »*.

**Sans la charge de départ, cette ligne n'a qu'une lecture disponible, et c'est la rassurante.**
Le 2026-08-10 elle a été lue ainsi — et ce jour-là c'était juste : la machine tournait déjà à 2,70
à cause de VPS-016, l'audit n'était pas le coupable. Le 2026-08-11, la même ligne, seule, aurait
produit la même conclusion :

```
charge de la machine a la fin : 4.20 2.13 1.01
```

**Or la machine était à 0,35 quand la collecte a démarré, et personne d'autre ne tournait.**
L'audit avait donc, à lui seul, porté la charge à **plus du double de la limite de 2** que cette
procédure impose — et sa propre sortie l'aurait imputé à la machine.

`sysstat` le confirme indépendamment, et la colonne qui tranche est `%nice` : seul l'audit tourne
en `nice -n 19` sur cette machine.

| Tranche | %user | **%nice** | %system | %idle |
|---|---:|---:|---:|---:|
| 02:20:18 (avant la collecte) | 4,28 | **0,00** | 3,17 | **87,27** |
| 02:30:07 (contient la collecte) | 7,33 | **1,00** | **14,09** | **63,05** |

**Correctif appliqué.** La charge 1 min est capturée au démarrage (`CHARGE_DEBUT`), et le bloc
final **arbitre** au lieu d'afficher : `🔴 C EST L AUDIT` (départ < 1,0 et arrivée > 2,0),
`🟠 CHARGE PARTAGEE` (déjà chargée), `🟠 l audit a ajoute X` (sous la limite), `✅` sinon. Les
quatre branches ont été testées, dont les valeurs réelles du 08-10 (2,70 → 3,20 →
`CHARGE PARTAGEE`, verdict correct) et du 08-11 (0,35 → 4,20 → `C EST L AUDIT`). Coût : deux `cut`.

**Leçon générale.** C'est **VPS-M21 sur un autre objet** : *un défaut qui rassure n'a aucun
plaignant.* Un audit qui surcharge la machine à laquelle il demande d'être peu chargée ne provoque
aucune plainte — la machine ne parle pas, et le rapport explique l'écart par la machine. Et le
corollaire, qui manquait à VPS-M24 : **une mesure de fin sans mesure de début n'est pas une
mesure, c'est une valeur.** Un delta a un responsable ; un niveau n'en a pas.

### VPS-M26 — Le délai de garde corrigé la veille garantissait désormais la perte de la mesure

- **Vu** : 2026-08-11 · **Statut** : `APPLIQUE` (corrigé dans `collecte.sh` le jour même)

VPS-M23 avait ramené le `timeout` de `du /opt` de 90 s à 40 s, sur un raisonnement juste : *un
délai de garde doit être une **fraction** du budget qu'il protège, jamais son égal.*

**Le raisonnement était bon et le nombre était faux.** Le coût réel de ce parcours **à froid**
dépasse 40 secondes **même sur une machine oisive** : le 2026-08-11, charge 0,35, `du /opt` a été
abandonné exactement comme la veille sur une machine à 140 %.

| Passage | Charge au moment du `du` | Délai | Résultat |
|---|---:|---:|---|
| 2026-08-09 | 0,09 | 90 s | 26,3 s — mesure rendue |
| 2026-08-10 | 2,70 | 90 s | **abandonné** (VPS-M23) |
| **2026-08-11** | **0,35** | **40 s** | **abandonné — et la machine était calme** |

Le garde-fou ne rattrapait donc plus un accident : **il supprimait la mesure tous les jours, tout
en consommant quand même ses 40 secondes.** Deux passages consécutifs sans mesure de `/opt`, qui
est le deuxième poste disque hors Docker.

**Et le message d'abandon affirmait une cause que personne n'avait mesurée** :

```
(ABANDONNEE apres 40 s — machine chargee, PAS un dossier vide)	/opt    40004 ms
```

*« Machine chargée »* était vrai le 08-10 et **faux le 08-11** — la charge valait 0,35. Un message
d'abandon doit **constater un fait**, jamais expliquer : l'explication écrite d'avance survit à la
situation qui l'a justifiée.

**Correctif appliqué.** `/opt` est parcouru **sous-dossier par sous-dossier** : un délai propre à
chaque enfant (12 s), un plafond global (45 s) qui interdit d'en entamer un de plus, et **ce qui a
été mesuré est conservé**. La sortie annonce son dénominateur — `17 / 17 sous-dossiers`, leçon
VPS-M08/M22 — et nomme les manquants. Le message dit `mesure NON FAITE, PAS un dossier vide`.
Vérifié sur la machine : 17/17, total **6,0 Go**.

⚠️ **Aucun gain de vitesse n'est revendiqué, et c'est délibéré.** L'essai tournait sur un cache
d'inodes tiédi par l'abandon qui l'avait précédé — **VPS-M18 interdit de conclure d'une seconde
exécution**. Le gain est ailleurs, et il est structurel : *une mesure partielle vaut infiniment
mieux qu'une absence*, et le coût **par sous-dossier** est exactement ce que VPS-018 réclamait
depuis quatre passages (voir sa fiche : `/opt/maalem` pèse deux fois `/opt/vizyo-leads` et coûte
six fois moins).

**Leçon générale.** Un délai de garde est calibré sur une observation ; le jour où l'observation
n'était pas représentative, il cesse de protéger et se met à **détruire** — silencieusement, parce
qu'un abandon ressemble à une décision. La contre-mesure n'est pas de mieux choisir le nombre :
c'est de **découper la mesure en morceaux dont l'un peut échouer sans emporter les autres**. Un
garde-fou qui ne peut produire que « tout » ou « rien » finira par produire « rien ».

### VPS-M23 — Un délai de garde égal au budget qu'il protège

- **Vu** : 2026-08-10 · **Statut** : `APPLIQUE` (corrigé dans `collecte.sh` le jour même)

La sortie du 2026-08-10 affiche :

```
(mesure ABANDONNEE apres 90 s)	/opt    90007 ms
```

`du /opt` portait `timeout 90` — c'est-à-dire **exactement le budget total** que cette procédure
impose à la collecte entière. Une seule commande avait donc le droit de consommer tout le temps
de tout le passage. Ce matin elle l'a fait : **abandonnée après 90 s, après 26,3 s la veille sur
les mêmes 5,4 Go.** On a perdu la mesure **et** dépassé le budget, du même geste.

**La cause immédiate est la charge** — la machine tournait à 140 % à cause de VPS-016, et un
script en priorité *idle* attend d'autant plus. Mais la charge explique le dépassement du `du`,
pas le fait que le collecteur l'ait **autorisé à tout prendre**.

**Correctif appliqué.** Délai ramené à **40 s**, soit ~45 % du budget pour le poste le plus
lourd — ce qui laisse la place aux onze autres sections. Le message d'abandon dit désormais ce
qu'il faut en conclure : `(ABANDONNEE apres 40 s — machine chargee, PAS un dossier vide)`.

**Leçon générale.** *Un délai de garde doit être une **fraction** du budget qu'il protège,
jamais son égal.* Deux nombres qui devraient être liés et qu'on écrit à la main finissent par
signifier la même chose — c'est la famille de VPS-M10 (un seuil d'alerte égal à la cible du
mécanisme qu'il surveille) vue sous l'angle du temps au lieu de l'espace. Un `timeout` qui vaut
le budget ne protège rien : il autorise.

### VPS-M24 — Le budget était instrumenté, jamais arbitré

- **Vu** : 2026-08-10 · **Statut** : `APPLIQUE` (corrigé dans `collecte.sh` le jour même)

VPS-M16 avait posé un `[t+Ns]` sur chaque en-tête de section : on savait donc **où** le temps
passait. Mais **aucune ligne ne disait si le budget de 90 s était tenu.** Il fallait lire la
dernière section, en soustraire l'heure de départ, et connaître la limite de mémoire.

Le 2026-08-10, la collecte a mis **300 secondes — 3,3× le budget — et la sortie ne le dit nulle
part.** Le dépassement le plus grave jamais mesuré est passé sans produire une seule ligne.

**Correctif appliqué.** Un bloc final **BUDGET DE LA COLLECTE** : durée, budget, **charge de la
machine à la fin**, et verdict chiffré (`🔴 DEPASSEMENT : +210 s, soit 3.3× le budget`). Il
rappelle explicitement de lire la charge **avant** d'accuser le script, parce que VPS-M16 et
VPS-M18 ont établi qu'une durée n'est pas une propriété du script mais du script × la machine ×
le moment. Coût : deux `date` et un `cat /proc/loadavg`.

**Leçon générale.** *Instrumenter n'est pas arbitrer.* Une mesure affichée sans son verdict laisse
le jugement au lecteur — c'est-à-dire à personne, exactement comme les deux détecteurs
contradictoires de VPS-M17. Toute limite écrite dans une procédure doit produire une ligne
lorsqu'elle est franchie, sans quoi elle n'est pas une limite mais une intention.

### VPS-M25 — On comparait le total du cache de build à un plafond qui n'en gouverne qu'une partie

- **Vu** : 2026-08-10 · **Statut** : `APPLIQUE` (corrigé dans `collecte.sh` le jour même)

Le levier « cache de build » confrontait le chiffre de `docker system df` — **13,82 Go** — au
plafond `keepStorage` de **10 Go**. La conclusion naturelle est « il déborde de 38 % ». Elle est
fausse, et `docker buildx du` le dit en trois lignes :

```
Shared:   3.392GB
Private:  10.42GB
Total:    13.82GB
```

`Shared` = les couches que le cache **partage avec des images vivantes**. Le ramasse-miettes ne
peut pas les libérer — elles appartiennent aussi à une image en service — et `keepStorage` ne les
a **jamais** gouvernées. La seule grandeur qu'il règle est `Private` : **10,42 Go pour un plafond
de 10 Go, soit 4 % au-dessus.** Le mécanisme tient sa borne, exactement.

**Ce que ça coûtait — et le plus instructif est que ça n'a rien coûté encore.** Le verdict
restait vert **par accident** : la marge de 50 % posée par VPS-M10 (seuil = plafond × 1,5 = 15 Go)
absorbait exactement l'écart. Un quatrième build cette nuit-là aurait produit une **alerte rouge
sur un mécanisme parfaitement sain**, avec en recommandation un `buildx prune` qui aurait coûté
un premier build 2 à 4× plus long pour rien.

**Ces 3,39 Go expliquent au passage une arithmétique qui semblait fausse** : Images +4,80 Go et
Build Cache +5,26 Go le même jour, pour un disque qui n'a grossi que de **5 Go**. Ce sont les
mêmes octets, comptés dans les deux postes de `docker system df`.

**Correctif appliqué.** Le verdict porte sur `Private`, la décomposition `Private + Shared` est
affichée pour que l'écart avec `docker system df` se voie, et `docker buildx du` n'est appelé
**qu'une fois** au lieu de deux (0,85 s au lieu de 1,69 s) — la première version re-tendait le
défaut n° 3 de VPS-M05, deux appels au socket Docker pour une seule question.

**Leçon générale.** *Avant de comparer une mesure à un seuil, vérifier qu'ils portent sur le même
objet.* C'est la famille de VPS-M11 / VPS-M20 / VPS-M21 — une valeur dont le sens dépend d'un
producteur invisible — déplacée d'un cran : ici la valeur est exacte et le seuil est exact, mais
**ils ne parlent pas de la même chose**. Et le défaut a survécu six passages parce qu'une marge
posée pour une autre raison le masquait : un garde-fou qui cache un défaut est plus dangereux
qu'un garde-fou absent.

### VPS-M21 — La section sécurité devient aveugle un jour sur sept, et du côté rassurant

- **Vu** : 2026-08-09 · **Statut** : `APPLIQUE` (corrigé dans `collecte.sh` le jour même)

La collecte du 2026-08-09 à 02 h 22 a affiché ceci :

```
── Tentatives d'intrusion ──
  fenetre du journal : 2026-08-09T00:05 → 2026-08-09T02:22
  echecs dans /var/log/auth.log : 0
  dont sur le compte root : 0
  top IP en ECHEC :
  comptes vises :
  dernier echec : aucun dans la fenetre
```

Trois listes vides et deux zéros — c'est-à-dire l'image exacte d'une machine que personne
n'attaque. **La vérité était de 184 échecs sur 7 jours, soit ~26 par jour.**

**La cause est mécanique.** La section ne lisait que `/var/log/auth.log`, le fichier *courant*.
`logrotate` tourne chaque samedi à minuit ; un dimanche à 02 h 22, ce fichier contient **2 h 17**
d'histoire. Le reste dormait dans `auth.log.1`, que rien n'ouvrait :

```
/var/log/auth.log     0 echecs   fenetre 2026-08-09T00:05 -> 2026-08-09T02:25
/var/log/auth.log.1 188 echecs   fenetre 2026-08-02T00:01 -> 2026-08-08T23:59
```

**Pourquoi c'était invisible pendant cinq passages.** Le collecteur **affichait honnêtement sa
fenêtre** depuis le premier jour. Mais elle faisait alors 3 à 6 jours : elle *ressemblait* à une
mesure hebdomadaire, donc personne ne l'a lue comme une limite. Ce n'est qu'au jour de la
rotation qu'elle s'effondre — et ce jour-là, le chiffre produit est **rassurant**.

> **La leçon, et c'est la plus générale du référentiel** : un défaut qui alarme à tort se corrige
> en une journée, parce que quelqu'un vient s'en plaindre. Un défaut qui **rassure** à tort n'a
> aucun plaignant. Il faut donc le chercher, et le seul endroit où le chercher, c'est dans les
> mesures dont la fenêtre dépend d'un producteur invisible.

C'est **VPS-M11 et VPS-M20 pour la troisième fois** : VPS-M11, le compte de paquets dépendait de
la fraîcheur du cache apt ; VPS-M20, `n_live_tup` dépendait du dernier `ANALYZE` ; VPS-M21, le
compte d'échecs dépend de `logrotate`. *Une mesure dérivée d'une source qui tourne doit porter la
durée de sa fenêtre, et cette fenêtre doit être la même à chaque passage.*

**Correctif appliqué.** Lecture de `auth.log` **et** `auth.log.1`, bornée à **7 jours
glissants** — donc une fenêtre identique quel que soit le jour de rotation. S'y ajoutent le taux
par jour et la **répartition quotidienne**, parce qu'un total de 7 jours ne distingue pas « 184
étalés » de « 184 hier soir ». Les `.gz` restent hors champ : un `zcat` pour de l'histoire
ancienne. **Coût mesuré : 0,05 s.**

**Ce que la fenêtre corrigée a révélé, et qui est rassurant pour de bon** : les comptes visés
n'existent pas (`admin`, `test`, `centos`, `rebecca`), l'authentification par mot de passe est
coupée, et `fail2ban` compte **12 échecs depuis son démarrage** — ce qui est **exact** (9 le
08-05 + 3 le 08-08). La prison voit bien ce qu'elle prétend voir : **VPS-M06 ne s'est pas
reproduit**, et cette fois c'est vérifié par recoupement des journaux, pas par lecture de
configuration.

**À ne pas faire** : élargir la fenêtre aux `.gz` « tant qu'à faire ». Trois fichiers compressés
pour de l'histoire au-delà de 7 jours coûtent un `zcat` à chaque passage, sur une machine à
2 vCPU, pour une information que le référentiel conserve déjà.

### VPS-M22 — Trois extractions d'étiquettes de suite ont rendu du vide, en silence

- **Vu** : 2026-08-09 · **Statut** : `APPLIQUE` (gardes posées dans `collecte.sh` le jour même)

En construisant la table de routage, mon extraction des étiquettes Traefik a rendu **du vide deux
fois en une heure**, sur une machine où **19 conteneurs sur 31** portent des étiquettes
`traefik.*` :

1. gabarit Go avec `hasPrefix` / `hasSuffix` — fonctions **non supportées** par `docker inspect`,
   qui rend une chaîne vide sans rien écrire sur stderr ;
2. regex `jq` dont les antislashs ont été **mangés en transit** (`\\.` arrivé en `\.`), d'où
   `jq: Invalid escape` — noyé dans un `2>/dev/null`.

Les deux fois, la sortie disait « **0 conteneur porte une règle de routage** ». Et les deux fois,
le rapport de la veille **avertissait explicitement de ce piège** — c'est l'angle mort n° 2 du
2026-08-08, qui se terminait par « tout gabarit conditionnel doit annoncer combien de lignes il
attend ». L'avertissement était écrit, lu, et insuffisant.

**Ce qui a rattrapé le coup** : une ligne de comptage indépendante (`combien de conteneurs ont au
moins une étiquette traefik.*` → **19**) placée à côté de l'extraction. C'est la seule raison pour
laquelle le vide a été reconnu comme un défaut plutôt que comme un résultat.

**Gardes posées dans le collecteur**, non négociables :

1. **Aucun antislash dans la regex `jq`** — classes `[.]` uniquement, qu'aucun transport ne peut
   manger. C'est moins lisible et c'est le prix.
2. Le nombre de conteneurs **étiquetés** est compté séparément et affiché à côté du nombre de
   lignes rendues. Un `🔴 0 domaine rendu alors que 19 conteneurs portent des etiquettes` est
   désormais un **défaut visible**, avec la phrase « ne pas lire ceci comme *rien n'est publié* ».

**Leçon.** C'est **VPS-M08 à l'identique** — sept conteneurs disparaissaient d'une table en
silence — et la récidive prouve que l'écrire dans un rapport ne suffit pas : *un garde qui n'est
pas dans le code n'est pas un garde.* La contre-mesure n'est pas « faire attention », c'est
d'exiger de toute extraction conditionnelle qu'elle **annonce son dénominateur**.

### VPS-M19 — La section « processus de l'HÔTE » montrait des processus de CONTENEUR

- **Vu** : 2026-08-08 · **Statut** : `APPLIQUE` (corrigé dans `collecte.sh` le jour même)

La sortie du 2026-08-08 affiche, sous un titre qui dit « HÔTE » :

```
     4.0 % d un coeur  node               (pid 1681, RSS 120 Mo)
```

Vérification : `/proc/1681/cgroup` pointe `docker-d4a088f6….scope` et son parent est un
`containerd-shim-runc-v2`. **C'est le `node dist/main.js` de `tracky-api`** — un conteneur.

La section parcourt `/proc/[0-9]*/stat`, donc *tous* les processus visibles dans l'espace de
noms PID de l'hôte, **conteneurs compris**. Or elle existe **précisément** parce que
`docker stats` ne voit que les conteneurs et avait manqué 24 heures d'emballement de `dockerd`
(VPS-M14). Une section qui mélange les deux populations sans le dire casse le complément **dans
les deux sens** : un conteneur emballé se lit « problème hôte », et le vrai signal — un démon
**hors** conteneur — se noie dans le bruit normal des applications.

**Correctif appliqué.** Chaque ligne porte `[HOTE]` ou `[conteneur <id>]`, lu dans
`/proc/<pid>/cgroup` — la seule source qui ne mente pas : ni le nom (`node`), ni le PPID (un shim
*est* un processus de l'hôte), ni `ps` ne distinguent les deux. Coût : un `cat` par ligne
**affichée** (8 au plus), pas par processus scanné. Sortie vérifiée :
`4.0 % d un coeur  node  [conteneur d4a088f692f9]`.

**Leçon générale.** Un titre de section est une affirmation, et personne ne la vérifie jamais.
Celle-ci était fausse depuis la création de la section, sur une machine où 31 conteneurs pèsent
bien plus que les quelques démons de l'hôte — donc la population affichée était
**majoritairement** la mauvaise. Quand une section est créée pour combler un angle mort précis,
il faut vérifier qu'elle ne regarde **que** cet angle : sinon elle le comble en apparence.

### VPS-M20 — La colonne « vivantes » n'est pas un comptage, et trois rapports ont bâti des tendances dessus

- **Vu** : 2026-08-08 · **Statut** : `APPLIQUE` (corrigé dans `collecte.sh` le jour même)

`wire_logs` affichait **719 955** lignes le 2026-08-07 et **710 557** le 2026-08-08 :
**−9 398 lignes sur une table en ajout seul**, ce qui est arithmétiquement impossible.

La colonne vient de `s.n_live_tup` — un **estimé** tenu par le collecteur de statistiques de
PostgreSQL et recalé aux `ANALYZE`/`VACUUM`, pas un `count(*)`. Comptage exact demandé pour
trancher : **696 878** contre **711 011** estimés — **2 % d'écart, soit 14 133 lignes**.

**Ce que ça coûtait, et le prix est déjà payé.** Le rapport du 2026-08-07 conclut, sur un delta
de **+88 lignes**, que `position_sampling_decisions` *« a cessé de croître »* — un écart
**150 fois inférieur** au bruit de la mesure. Les trois « tendances » publiées sur cette table
(+69 783, +10 860, +88) sont des estimés comparés à des estimés, sans que rien ne le dise.
La mesure du 2026-08-08 (+2 694) donne le rythme réel : ~2 700 lignes/jour.

| Passage | Conclusion publiée | Ce qu'elle valait |
|---|---|---|
| 2026-08-05 | « elle double en une semaine » | tendance à 2 points, l'un un jour de redéploiement |
| 2026-08-06 | « six fois moins » | corrigeait la précédente, même méthode |
| 2026-08-07 | « elle a **cessé** de croître » | **sous le bruit d'un facteur 150** |
| 2026-08-08 | ~2 700 lignes/jour | ordre de grandeur, et rien de plus |

**Correctif appliqué.** La colonne s'appelle `vivantes~estime`, et la **date du dernier
recalage** (`greatest(last_analyze, last_autoanalyze)`) est affichée à côté — même requête, coût
nul. Elle est instructive immédiatement : `positions` est recalée au **08-04 22 h 03** (4 jours)
et `alerts` au **07-21** (18 jours). Une note de lecture accompagne le tableau : sous ~2 %, c'est
du bruit de recalage, pas une tendance.

**Leçon générale.** C'est **VPS-M11 à l'identique** (le compte de paquets sans la date de son
cache), sur un autre objet : *une mesure dérivée d'un cache doit porter l'âge de ce cache*. Sans
lui, on ne mesure pas la table — on mesure la dernière fois que PostgreSQL l'a regardée. Et le
corollaire, qui manquait : **une valeur estimée ne doit jamais être présentée sous un nom qui
promet un comptage.** C'est le nom de la colonne qui a fait écrire trois tendances fausses, pas
la valeur.



### VPS-M17 — Le détecteur d'emballement ne sait pas oublier, et criait au loup sur une machine saine

- **Vu** : 2026-08-07 · **Statut** : `APPLIQUE` (corrigé dans `collecte.sh` le jour même)

La sortie du 2026-08-07 affichait :

```
dockerd  35.1 h CPU pour 52.8 h d uptime = 66.5 % d un coeur en moyenne   🔴 EMBALLEMENT — il tourne en boucle
```

…sur une machine à **0,35 de charge**, dont `dockerd` consommait **1,0 % d'un cœur**. La boucle
(VPS-016) avait cessé la veille à 13 h 00. Mais les 34 heures de boucle restent inscrites dans
`utime+stime` **jusqu'au redémarrage du démon** : ce 🔴 se serait affiché **chaque matin pendant
des semaines**.

**Le pire n'est pas là.** Sur la **même sortie**, quinze lignes plus haut, la mesure instantanée
disait : `(vide = aucun processus hote au-dessus de 2 % : c'est le cas normal)`. Deux détecteurs,
deux verdicts opposés, **aucun arbitrage** — c'est donc le lecteur qui tranchait, c'est-à-dire
personne. Et un lecteur qui voit un 🔴 démenti par la ligne du dessus apprend à sauter les deux.

**Ce qui l'a rendu possible.** Le contrôle cumulé a été ajouté le 2026-08-06 pour attraper un
emballement *ancien* que la fenêtre de 3 secondes ne pouvait pas dater (VPS-M14). Il faisait
exactement son travail. Ce qui manquait, c'est que **son verdict soit conditionné à l'autre
mesure** : « il a beaucoup consommé dans sa vie » et « il consomme maintenant » sont deux faits
différents, et seul le second appelle une action.

**Correctif appliqué.** Les deux mesures sont sur la **même ligne**, et c'est « maintenant » qui
décide :

- instantané > 50 % → `🔴 EMBALLEMENT EN COURS — il tourne en boucle MAINTENANT` ;
- sinon cumul > 50 % → `🟠 SÉQUELLE — calme maintenant ; le cumul garde la trace d'une boucle PASSÉE` ;
- sinon rien.

L'instantané est **repris des deux échantillons déjà pris** par la section précédente : aucune
mesure supplémentaire, aucun fork de plus. Sortie vérifiée sur la machine :
`dockerd maintenant 1.0 % | cumul 35.1 h / 53.0 h = 66.2 % 🟠 SÉQUELLE`.

**Leçon générale.** Même famille que VPS-M10 (un seuil d'alerte égal à la cible du mécanisme
qu'il surveille) : une alerte qui reste allumée sur un état normal cesse d'être une alerte. Et un
corollaire propre à celle-ci : **un compteur cumulatif ne peut pas signaler la fin d'un
incident** — il ne décroît jamais. Tout indicateur bâti sur un cumul depuis le démarrage a besoin
d'un indicateur de fenêtre courte à côté, sans quoi il ne mesure pas un état mais une histoire.

### VPS-M18 — Le « 136 s → 65 s » d'hier mesurait le cache du noyau, pas le correctif

- **Vu** : 2026-08-07 · **Statut** : `APPLIQUE`

Le rapport du 2026-08-06 conclut : *« Budget tenu après correctifs : 65 s »*, en portant le gain
au crédit de l'exclusion des caches d'outillage de `/root` (~155 000 inodes, VPS-017).

**Ce 65 s a été mesuré immédiatement après une exécution de 136 s du même script** — donc avec le
cache d'inodes du noyau entièrement chaud. La mesure **à froid** du lendemain, script inchangé,
donne **127 s**.

| Passage | Cache | `dockerd` | `/root` exclu | Durée |
|---|---|---|---|---:|
| 2026-08-06 #1 | froid | en boucle | non | **136 s** |
| 2026-08-06 #2 | **chaud** | en boucle | oui | 65 s |
| 2026-08-07 | froid | calme | oui | **127 s** |

**Le gain réel de l'exclusion vaut donc ~9 s, pas 71.** Vérifié directement : les cinq parcours
de la section 3 coûtent **~52 s à froid** et **~2,6 s à chaud** — un facteur 20. `du /opt` seul
passe de ~50 s à 2,4 s.

**Ce que ça coûtait.** Un chiffre faux entré dans `chiffres`, c'est-à-dire dans la seule mémoire
longue des tendances (même dégât que VPS-M11). Et une conclusion publiée — « budget tenu » —
alors que le budget ne l'était pas.

**Comment il a été trouvé**, et il faut le dire : par accident. Je cherchais **quelle** commande
de la section 3 coûtait 52 s ; en la re-chronométrant après la collecte, j'ai obtenu 2,6 s. Ce
n'est pas la commande coupable que j'ai trouvée, c'est ma méthode de mesure qui était fausse —
et elle l'était aux deux passages précédents.

**Correctif appliqué.** La règle est écrite en tête de `collecte.sh`, à côté du chronomètre :
*un chiffre de durée ne vaut que pris à froid, c'est-à-dire au premier passage de la journée ;
une seconde exécution ne prouve rien.* Et chaque chemin de la section 3 est désormais chronométré
séparément, pour que la prochaine attribution ne demande pas une seconde passe.

**Leçon générale.** Même famille que VPS-011 (un gain structurel de 26 % dont l'effet CPU était
sous la variance) et VPS-M12 (déclarer un effet à `t+0`). **Un correctif de performance se mesure
dans les mêmes conditions que le problème, jamais dans la foulée de celui-ci.** Le simple fait
d'avoir exécuté le script une fois change ce que la deuxième exécution mesure.

### VPS-M14 — L'audit ne regardait aucun processus de l'hôte, et a manqué 24 h d'incident

- **Vu** : 2026-08-06 · **Statut** : `APPLIQUE` (corrigé dans `collecte.sh` le jour même)

Le collecteur savait tout dire des **conteneurs** — santé, redémarrages, limites, CPU, mémoire,
PID, sondes — et **rien** des processus de la machine. Or `dockerd` n'est pas un conteneur. Il a
brûlé un cœur entier pendant **deux passages d'audit consécutifs** sans qu'aucune section puisse
le montrer :

- `docker stats` ne voit que les conteneurs ;
- la section 9 moyenne sur 24 h, ce qui dilue un pic qui dure — le 08-05 sortait pourtant à
  28,60 % de temps système contre 5 les jours calmes, et personne n'a été conduit à y regarder ;
- les 31 conteneurs affichaient `healthy`, le démon répondait en 258 ms : rien ne clignotait.

**Correctif : deux sections neuves.**

1. **CPU instantané par processus hôte**, par delta de `/proc/*/stat` sur 3 s.
   ⚠️ **Et surtout pas `ps -eo pcpu`** : cette colonne donne la moyenne *depuis le démarrage du
   processus*, pas la consommation actuelle. Un démon lancé il y a un mois et emballé depuis une
   heure y apparaît à 2 %. Le piège est d'autant plus vicieux qu'ici la moyenne de vie *était*
   parlante (84 %) — mais seulement parce que la panne dure depuis presque toujours.
2. **Temps CPU cumulé ÷ uptime** pour les démons, qui attrape un emballement *ancien* que la
   fenêtre de 3 s ne peut pas dater. Sortie du jour :
   `dockerd 24,5 h CPU pour 29,0 h d'uptime = 84,3 % 🔴 EMBALLEMENT`.

**Deux pièges évités à l'écriture même**, et ils méritent d'être écrits :
- la première version lançait **un `awk` par fichier** de `/proc`, soit ~1 800 forks **pour
  mesurer la consommation de processeur**. Un capteur qui perturbe ce qu'il mesure ne mesure
  plus rien (même famille que VPS-M05). Fusionné en un seul `awk`.
- `$14`/`$15` en positionnel sur `/proc/<pid>/stat` est **faux** dès qu'un `comm` contient un
  espace — c'est le piège n° 6 listé en tête du collecteur, re-tendu. On coupe jusqu'à la
  dernière parenthèse avant de compter les champs.

**Leçon générale.** Un audit d'une machine conteneurisée finit par ne surveiller que les
conteneurs, parce que c'est là que vivent les applications. Mais **ce qui les fait tourner n'est
pas dans un conteneur** : ni `dockerd`, ni `containerd`, ni `sshd`, ni `journald`. La couche qui
porte tout est exactement celle que l'outillage Docker ne montre pas.

### VPS-M15 — Le contrôle de sauvegarde lisait la trace, jamais l'unité qui la produit

- **Vu** : 2026-08-06 · **Statut** : `APPLIQUE`

Quatrième récidive de la même famille, après VPS-004, VPS-M06 et VPS-M13. Le détail des quatre
indicateurs est dans la fiche VPS-015 ; le principe tient en une phrase : on vérifiait des
**fichiers, un JSON d'état et un manifeste de copie** — trois traces — et jamais la seule chose
qui ne peut pas mentir, à savoir **si l'unité qui les produit a réussi**.

Le cas est plus retors que les précédents parce que les trois traces étaient **cohérentes entre
elles**. Un état incohérent alerte ; trois indicateurs qui se confirment mutuellement rassurent.
Ils étaient cohérents parce qu'ils dérivent tous du même événement : le dernier succès. Un échec
n'écrit nulle part — il se contente de ne rien changer.

**Correctif appliqué.** Pour chaque `*backup*.service` : `ActiveState`, `Result`,
`ExecMainStatus` et l'horodatage de fin, lus **auprès de systemd**. La sortie du jour met les
deux lectures côte à côte, dans la même section — la couverture par fichiers dit
`vizyo-verify ✅ à jour (1 j)`, l'unité dit `🔴 exit-code 203 — AUCUNE SAUVEGARDE PRODUITE`.
Les laisser voisiner est délibéré : c'est ce qui rend la leçon visible au prochain lecteur.

**Ajouté dans la foulée** : chaque timer voit l'`ExecStart` qu'il pointe vérifié — existence
**et** bit d'exécution — *avant* son échéance, puisque systemd ne le contrôle qu'au moment de
lancer. ⚠️ **Faux positif attrapé à la pose** : `systemd-tmpfiles-clean` déclare un `ExecStart`
en nom **nu**, résolu par le `PATH`. Testé comme un chemin, il ressortait « ABSENT » — une ligne
rouge quotidienne sur une unité Ubuntu parfaitement saine. Résolu par `command -v`.

**Leçon générale.** Des indicateurs qui se confirment ne se valident pas les uns les autres
s'ils dérivent **de la même source**. Compter les traces n'est pas les corroborer.

### VPS-M16 — Un budget imposé sans instrumentation ne se diagnostique pas

- **Vu** : 2026-08-06 · **Statut** : `APPLIQUE`

La collecte a mis **136 secondes** — pour un budget de 90 s que cette procédure impose depuis
l'origine. Et rien dans la sortie ne disait **où** le temps était passé : il a fallu re-mesurer à
la main, section par section, en ajoutant de la charge à une machine déjà amputée d'un cœur.

**Correctif appliqué.** Chaque en-tête de section porte `[t+Ns]`. Le coupable est apparu
immédiatement : la section 3, à elle seule, pour un `du` marchant sur ~155 000 inodes
d'outillage de développement dans `/root` (VPS-017). Exclus — même raisonnement que `/usr` —
la collecte retombe à **65 s**.

**Un point d'honnêteté sur le dépassement.** Il n'était pas seulement dû au collecteur : la
machine tournait à un cœur et demi à cause de VPS-016, et un script en priorité *idle* attend
d'autant plus que la machine est chargée. **Le budget n'est donc pas une propriété du script
seul, mais du script × la charge ambiante.** C'est précisément pourquoi il fallait
l'instrumenter au lieu de le supposer : sans les `[t+Ns]`, les deux causes restaient
indiscernables, et on aurait « optimisé » un script qui n'était coupable qu'à moitié.

**Leçon générale.** Une limite qu'on impose sans mesurer sa consommation ne se constate qu'au
dépassement, et sans jamais dire pourquoi. Instrumenter coûte ici trois appels à `date`.

### VPS-M08 — Sept conteneurs sur 31 disparaissaient de la table, en silence

- **Vu** : 2026-08-05 · **Statut** : `APPLIQUE` (corrigé dans `collecte.sh` le jour même)

La section « conteneurs actifs : santé, redémarrages, limites » affichait **24 lignes pour 31
conteneurs**. Les sept manquants — dont **`tracky-web` et `tracky-lp`, deux conteneurs de
production** — étaient remplacés par des lignes vides.

**La cause, vérifiée champ par champ.** `{{.HostConfig.NanoCpus}}` fait basculer
`docker inspect` sur la représentation en **map** de l'objet, où l'option `missingkey=error`
transforme une clé absente en **erreur**. Sur un conteneur sans sonde de santé,
`.State.Health` n'existe pas dans cette map : le gabarit **entier** rend du vide, et le message
`map has no entry for key "Health"` part sur `stderr` — donc dans `/dev/null`.

Isolé, `{{.HostConfig.NanoCpus}}` rend `0` sans broncher ; isolé,
`{{if .State.Health}}…{{else}}aucun{{end}}` rend `aucun` sans broncher. **C'est leur
combinaison qui casse** — ce qui explique qu'un test unitaire de chaque champ n'aurait rien vu.

**Le comble** : le garde `{{if .State.Health}}` avait été ajouté au passage précédent
précisément pour traiter les conteneurs sans sonde. Il échouait **exactement sur eux**.

**Ce que ça coûtait.** Les limites mémoire de `tracky-web` et `tracky-lp` étaient invisibles.
VPS-005 déclare « Tracky traité » sur la foi d'une liste qui ne les contenait pas.

**Correctif appliqué.** `NanoCpus` retiré du gabarit (il vaut 0 partout ; le compte des limites
CPU est affiché à part), `{{with}}` au lieu de `{{if}}`, et surtout **un contrôle explicite
`31/31`** affiché à chaque passage.

**Leçon générale.** Le vrai correctif n'est pas le gabarit — il re-cassera à une prochaine
version de Docker. Le vrai correctif est le **compte attendu vs compte obtenu** : une liste qui
n'annonce pas combien d'éléments elle devrait contenir ne peut pas signaler qu'il en manque.
Même famille que VPS-M02.

### VPS-M09 — Un jour de redémarrage rendait l'historique illisible

- **Vu** : 2026-08-05 · **Statut** : `APPLIQUE`

Le 08-04 s'affichait dans le tableau des 7 jours avec **huit colonnes au lieu de quatre**, et
apparaissait **deux fois** dans le tableau des écritures disque.

**La cause.** Quand la machine redémarre, `sar` découpe la journée en segments et publie une
ligne `Average:` **par segment**. Le `printf` cumulatif les concaténait.

**Pourquoi ça compte.** La ligne rendue illisible était celle du **jour du redémarrage** —
c'est-à-dire précisément le jour dont l'historique importait le plus, et le seul dont on
voulait vérifier l'effet.

**Correctif appliqué.** On ne retient que le **dernier segment** (l'état courant de la machine)
et on **signale** le redécoupage en clair dans la ligne, au lieu de le masquer.

**Leçon générale.** Un outil qui agrège par période produit plusieurs agrégats dès qu'il y a
une discontinuité. Écrire `/^Average:/ {printf …}` suppose qu'il n'y en a qu'un — c'est une
hypothèse, et elle est fausse un jour sur cent. Même famille que VPS-M05 (analyse positionnelle
d'une sortie qu'on croit régulière).

### VPS-M10 — Un seuil d'alerte égal à la cible du mécanisme qu'il surveille

- **Vu** : 2026-08-05 · **Statut** : `APPLIQUE`

Le levier « cache de build » alertait au-delà de **10 Go**. Or c'est exactement le plafond que
le ramasse-miettes de BuildKit fait respecter (`keepStorage: 10GB`, posé le 2026-08-04). Un
cache stabilisé à 10,53 Go — c'est-à-dire un mécanisme qui **fonctionne parfaitement** —
déclenchait donc une alerte **tous les matins**.

**Ce que ça coûtait.** Une alerte quotidienne sur un état normal n'est plus une alerte : c'est
du bruit, et elle apprend au lecteur à sauter la ligne. Le jour où le cache échappe réellement
à sa borne, personne ne le verra.

**Correctif appliqué.** Le seuil est **dérivé du plafond réel du ramasse-miettes + 50 % de
marge**. On n'alerte plus que si le cache **échappe** à sa borne — le seul événement qui mérite
un regard.

**Leçon générale.** Quand un mécanisme régule une valeur, le seuil d'alerte doit être **déduit
du réglage de ce mécanisme**, jamais écrit en dur à côté. Deux nombres qui devraient être liés
et qu'on recopie à la main finissent toujours par diverger — même leçon que VPS-M03.

### VPS-M11 — Un compte de paquets sans la date de son cache

- **Vu** : 2026-08-05 · **Statut** : `APPLIQUE`

Le passage du 2026-08-04 a enregistré **« 0 paquet en retard »** dans la mémoire longue des
tendances. Le lendemain, sans que la machine ait rien installé, il y en avait **59**.

**La cause.** `apt list --upgradable` ne connaît que ce que le **cache local** a vu. Mesuré
juste après un redémarrage, avant le passage d'`apt-daily`, il annonce un chiffre qui ne
reflète pas l'état réel. Le motif de comptage était en outre approximatif (`grep -c upgradable`
prenait aussi l'en-tête).

**Ce que ça coûtait.** Un chiffre faux entré dans `chiffres`, c'est-à-dire dans la seule source
de tendance au-delà de 7 jours. Une régression future se serait comparée à une valeur inventée.

**Correctif appliqué.** La **date de rafraîchissement du cache apt** est affichée à côté du
compte, et le comptage passe par `grep -c '/'`.

**Leçon générale.** Une mesure dérivée d'un cache doit porter l'âge de ce cache. Sans lui, on
ne mesure pas l'état du système : on mesure la dernière fois qu'on l'a regardé.

### VPS-M12 — L'audit a lui-même dépassé la limite de charge qu'il impose

- **Vu** : 2026-08-05 · **Statut** : `APPLIQUE` (règle étendue aux vérifications manuelles)

En cherchant à vérifier le chiffre « 24,39 Go d'images récupérables », j'ai lancé
`docker system df -v` — qui parcourt toutes les couches. La commande a tourné plus de dix
minutes et fait monter la charge à **3,30 sur 2 cœurs**, au-dessus de la limite de 2 que cette
procédure impose. Interrompue ; aucune conséquence durable.

**Ce qui a manqué.** La procédure borne `collecte.sh` avec beaucoup de soin (`$LOW`, `timeout`,
exclusion de `rootfs`/`overlay2`). Elle ne disait rien des **vérifications manuelles** que
l'agent lance en marge — alors que ce sont elles qui explorent l'inhabituel, donc le coûteux.

**Correctif.** La règle vaut pour toute commande envoyée à la machine, pas seulement pour le
collecteur. `docker system df -v` est nommément à proscrire : c'est la variante « détaillée »
d'une commande qui, sans `-v`, est gratuite.

**Leçon générale.** Une règle qui ne s'applique qu'à l'outil et pas à celui qui le tient
n'est pas une règle. Et l'ironie est instructive : la commande coûteuse servait à vérifier un
chiffre qui, lui, s'est révélé faux de toute façon.

> ### 🔴 2026-08-06 — « aucune conséquence durable » était FAUX, et la conséquence dure encore
>
> Cette fiche concluait : *« Interrompue ; aucune conséquence durable. »* Vingt-quatre heures
> plus tard, `dockerd` brûle toujours 100 % d'un cœur (VPS-016), et sa dernière trace de
> journal est **une connexion cliente rompue le 2026-08-05 à 02 h 23 min 18 s** — la fenêtre
> exacte où cette commande a été interrompue, et où la collecte du jour s'est achevée.
>
> **Ce qui est établi** : le démon boucle sur un descripteur de fichier, et sa dernière trace
> est un client coupé net.
> **Ce qui ne l'est pas** : *laquelle* des deux commandes. Le vidage des goroutines
> (`kill -USR1`) trancherait ; il est interdit par la règle de lecture seule, et n'a pas été fait.
>
> **Ce que ça change dans la règle.** Elle ne dit plus seulement « ne pas dépasser le budget de
> charge ». Elle dit : **une commande envoyée à un démon ne doit pas être interrompue en cours
> de route** — le client meurt, le travail côté serveur, non. Un `timeout` qui expire sur un
> `docker …` fait exactement ça, et le collecteur en pose plusieurs à chaque passage. C'est la
> question ouverte du rapport du 2026-08-06.
>
> **Et la leçon de méthode, plus large** : j'ai déclaré « aucune conséquence » **le jour même**,
> sans revenir vérifier. C'est le défaut que VPS-014 avait pourtant nommé pour les *gains* — un
> effet se constate au passage suivant, pas à `t+0`. Il vaut identiquement pour les dégâts, et
> il aura fallu le payer deux fois pour l'écrire.
>
> ### 2026-08-07 — la conséquence a cessé, la question de la cause reste ouverte pour toujours
>
> La boucle de `dockerd` s'est arrêtée d'elle-même le 2026-08-06 vers 13 h 00 UTC, après 34 h 40
> (VPS-016). Elle n'aura donc pas dépassé deux jours — mais **la cause ne sera jamais connue** :
> le vidage des goroutines n'était possible que pendant la boucle, et il n'a pas été fait.
>
> **Ce que ce passage apporte quand même** : la collecte du 2026-08-07 a ouvert le même nombre
> de connexions au socket Docker, avec les mêmes `timeout`, et **n'a rien déclenché**. C'est un
> indice en faveur de « défaut propre à Docker 29.1.3 » et contre « l'audit est dangereux » —
> un indice, pas une preuve : un seul passage sain ne dit rien d'un événement qui ne s'est
> produit qu'une fois.
>
> **La règle du fichier ne change pas** : une commande envoyée à un démon ne doit pas être
> interrompue en cours de route. Elle est simplement moins étayée qu'on ne le croyait le 08-06.

### VPS-M13 — Le contrôle de sauvegarde a accusé à tort la base la plus importante

- **Vu** : 2026-08-05 · **Statut** : `APPLIQUE` (détecté avant publication)

Le nouveau contrôle « chaque base en service a-t-elle une sauvegarde ? » (VPS-013) a annoncé,
à sa première exécution, `tracky-postgres` **« ABANDONNEE — dernière copie il y a 99 jours »**.
C'était faux : sa sauvegarde datait de 23 heures.

**La cause.** Le rapprochement base → dossier s'arrêtait au **premier** dossier correspondant.
Pour la clé `tracky`, c'est `tracky-pre-deploy-20260427` — un instantané ponctuel — qui précède
`vizyo-tracky` dans l'ordre alphabétique.

**Ce que ça aurait coûté.** Un contrôle de sauvegarde qui crie au loup sur la base la plus
importante de la machine se fait désactiver en trois jours. On aurait perdu, avec lui, la seule
chose qui a permis de trouver VPS-013.

**Correctif appliqué.** On balaie **tous** les dossiers correspondants et on retient la copie
**la plus récente**. Les dossiers rapprochés sont affichés, pour que le rapprochement soit
vérifiable au lieu d'être cru.

**Leçon générale.** C'est VPS-M01 à l'identique, un passage plus tard et sur un autre sujet :
un compteur doit prouver qu'il compte ce qu'il prétend compter. Ici, le premier résultat d'une
recherche a été pris pour le bon. Corollaire pratique : **la sortie d'un nouveau contrôle se
relit ligne à ligne avant d'être publiée** — c'est ce qui a sauvé celui-là.

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

### VPS-M07 — J'ai lu un seul journal et conclu sur l'ensemble

- **Vu** : 2026-08-04 · **Statut** : `APPLIQUE`

VPS-004 annonçait qu'une garde de sécurité n'avait « jamais fonctionné ». Elle fonctionnait
depuis toujours. J'avais lu `/var/log/tracky-backup.log` — qui ne reçoit que la sortie du
**cron**, parce que c'est la ligne cron qui redirige avec `>>`. L'autre moitié du dispositif,
le timer systemd, écrit dans **journald**, et je ne l'ai pas ouverte.

**Ce que ça aurait coûté** : du temps perdu à « réparer » ce qui marchait, et surtout une
**fausse confiance inversée** — croire cassé un dispositif sain érode la confiance dans tout
le référentiel.

**Ce qui aurait dû alerter** : le constat VPS-003 disait déjà que **deux** planificateurs
existaient et que **chacun journalise ailleurs**. J'avais l'information, je ne l'ai pas
appliquée au constat suivant.

**Leçon générale** : quand un dispositif a plusieurs déclencheurs, il a plusieurs journaux.
Lire un seul et conclure sur l'ensemble, c'est mesurer une moitié et la présenter comme le
tout. Chercher la **preuve côté effet** (ici : la table `backup_runs` de l'API) plutôt que
côté trace — l'effet ne ment pas.

### VPS-M06 — fail2ban tournait, s'annonçait actif, et ne surveillait rien

- **Vu** : 2026-08-04 · **Statut** : `APPLIQUE` (corrigé à la pose)

L'installation de fail2ban a produit **trois** gardes inertes coup sur coup. Le service était
`active`, la prison `sshd` déclarée « enabled », et rien ne fonctionnait :

1. **`ignoreip` vide dans le démon.** `apt install` démarre le service *pendant* l'installation.
   Écrire `jail.local` ensuite puis lancer `systemctl enable --now` ne fait **rien** : le
   service tourne déjà, `--now` ne redémarre pas. Il fallait `restart`.
   → *L'IP d'administration n'était donc pas protégée du bannissement.*
2. **`journalmatch` visait `_SYSTEMD_UNIT=sshd.service`** — une unité qui **n'existe pas** sur
   Ubuntu 24.04 (elle s'appelle `ssh.service`). Preuve : `0` entrée sur `sshd.service`, **109**
   sur `ssh.service`. La prison lisait un flux vide et affichait fièrement « Total failed: 0 »
   alors que 175 échecs figuraient dans les journaux.
3. **Ma propre vérification était fausse** : je cherchais une chaîne `f2b` dans `iptables` et
   j'en comptais 4 — c'étaient des ponts Docker nommés `br-f2b719d1c13b`. Et fail2ban n'utilise
   pas iptables ici mais **nftables** (`banaction = nftables` dans `defaults-debian.conf`).

**Ce qui a permis de les trouver** : ne pas croire l'état annoncé. `systemctl is-active` dit
« active », `fail2ban-client status` dit « enabled » — aucun des deux ne prouve que ça marche.
La preuve est venue d'un **bannissement réel** d'une IP de test (`203.0.113.99`, plage
documentation), vérifié dans la table nftables, puis retiré.

**Leçon générale** : un garde-fou se prouve en le **déclenchant**, jamais en lisant son statut.
Même famille que VPS-004 et que le repli SMS mort de l'incident MSISDN.

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
