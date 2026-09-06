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
- **Vu** : 2026-08-20 · **Mesure du soir (après le cron de 04 h 57)** : `Private` **5,057 Go**, total **6,863 Go / 60 entrees**. 🔴 **CE N'EST PAS LE RAMASSE-MIETTES** : le cron non filtré de VPS-029 a retiré 4,5 Go en 53 s, alors que `Private` était **déjà sous sa borne**. **La série de VPS-001 est rompue** — les huit premiers points décrivaient un mécanisme unique et auto-régulé ; à partir d'aujourd'hui deux acteurs agissent sur le même objet, et le second est hebdomadaire. *Ne plus écrire « `Private` revient à sa borne » sans dire lequel des deux l'y a ramené.*
- **Mesure du matin (avant le cron)** : `Private` **9,568 Go** + `Shared` **1,806 Go** (total `docker system df` **11,37 Go / 74 entrees, 0 ACTIVE**). ✅ **HUITIEME POINT, ET IL EST SOUS LA BORNE** — serie **10,39 → 11,31 → 10,33 → 12,54 → 10,70 → 11,19 → 10,65 → 9,57**. Le mecanisme est verifie : `cache.db` ecrit **10 s** apres le build de `tracky-web` (08-19 17 h 21 min 39). 🔴 **MAIS CE POINT N EST PLUS ATTRIBUABLE AU RAMASSE-MIETTES SEUL** : un `docker builder prune -f` **NON FILTRE** a ete execute le 08-19 a 11 h 02 min 41 par le canal de l hyperviseur (**VPS-029**). Les deux ont agi ; leur part respective n est **pas mesurable**. ⚠️ **La bande « 10,3 – 12,6 Go » derivee des sept premiers points est donc morte au huitieme**, et elle l est **avant** que le cron n ait jamais tourne. **NE PAS purger** : 44 Go libres. *(mesure du 2026-08-18, conservee ci-dessous.)*
- **Mesure du 2026-08-18, conservée** : `Private` **11,19 Go** + `Shared` **17,0 Go** (total `docker system df` **27,45 Go / 120 entrees, 17 ACTIVES**). ✅ **SIXIEME POINT, ET LA REGULATION TIENT** : la serie fait **10,39 -> 11,31 -> 10,33 -> 12,54 -> 10,70 -> 11,19**, soit une valeur qui revient toujours a sa borne apres excursion. Le ramasse-miettes tourne : `cache.db` a ete ecrit **368 s** apres le dernier build termine (`maalem-dev-api`, 08-17 a 23 h 16), mesure a 03 h 51. ⚠️ **La collecte archivee de 04 h 00 affiche un ecart de 17 186 s, et ce n'est PAS un mecanisme en retard** : `cache.db` porte **2026-08-18 04 h 02 min 54**, c'est-a-dire PENDANT la collecte — le build en cours l'a reecrit. Le detecteur compare au dernier build TERMINE et ne connait pas celui qui tourne ; c'est une limite a connaitre avant de lire un gros ecart comme une panne. ⚠️ **`Shared` bondit a 17,0 Go** (0,10 la veille) : c'est la contrepartie des **5 images construites en 24 h** (4,42 Go annonces) — des couches neuves encore referencees par des images vivantes, donc hors de portee du plafond, exactement ce que VPS-M25 a etabli. **NE PAS purger** : 31 Go libres, et un build tournait pendant la collecte. *(mesure du 2026-08-17, conservee ci-dessous.)*
- **Mesure du 2026-08-17, conservée** : `Private` **10,70 Go** + `Shared` **0,10 Go** (total `docker system df` 10,80 Go / **75 entrees**). ✅ **LE TEST ECRIT D'AVANCE HIER EST TRANCHE, ET DANS LE BON SENS.** Le rapport du 08-16 posait : *« au prochain passage suivant un build, `Private` doit repasser sous ~11,5 Go ; s'il reste ≥ 12 Go ou monte, `keepStorage: 10GB, all: true` ne gouverne pas ce qu'on croit. »* **Deux builds ont eu lieu** (`tracky-web` le 08-16 a 15 h 59 min 24, `tracky-api` a 16 h 00 min 48), `cache.db` a ete ecrit **293 s** apres, et `Private` vaut **10,70 Go**. La serie fait **10,39 → 11,31 → 10,33 → 12,54 → 10,70** : une valeur qui **revient a sa borne** apres chaque excursion, c'est-a-dire la signature d'une **regulation**, pas d'une derive. **Le choix de `Private` comme grandeur de tendance (08-14), affaibli par le 4e point, est RETABLI par le 5e.** ⚠️ Et il aura fallu **cinq** points pour voir sur cette grandeur ce que VPS-001 ecrivait deja le 2026-08-06 : *une valeur regulee oscille autour de sa cible ; une valeur qui ne bouge pas d'un octet dit que son mecanisme est arrete.* **NE PAS purger** : 47 Go libres. *(mesure du 2026-08-16, conservee ci-dessous.)*
- **Mesure du 2026-08-16, conservée** : `Private` **12,54 Go** + `Shared` **0,10 Go** (total `docker system df` 12,64 Go / 82 entrees). ⚠️ **`Private` est a sa valeur la PLUS HAUTE jamais mesuree — 25 % au-dessus du plafond de 10 Go** — deux heures apres un build dont le ramasse-miettes a demontrablement tourne (`cache.db` ecrit 402 s apres). La serie fait **10,39 → 11,31 → 10,33 → 12,54** : l'amplitude passe de 0,98 a **2,21 Go**, et le « `Private` est plate » du 08-15 est **affaibli par le 4e point**. Le verdict du collecteur reste vert parce que le seuil est le plafond **+ 50 %** (15 Go), marge posee par VPS-M10. **Test ecrit d'avance** : *au prochain passage suivant un build, `Private` doit repasser sous ~11,5 Go ; s'il reste ≥ 12 Go ou monte, `keepStorage: 10GB, all: true` ne gouverne pas ce qu'on croit, et le choix de `Private` comme grandeur de tendance (08-14) est a rouvrir.* **NE PAS purger** : 45 Go libres. *(mesure du 2026-08-15, conservee ci-dessous.)*
- **Mesure du 2026-08-15, conservée** : `Private` **10,33 Go** + `Shared` **21,39 Go** (total `docker system df` 31,72 Go / 139 entrees, **confirme deux fois dans la meme seconde**). ✅ **LE TROISIEME POINT TRANCHE : c'est une OSCILLATION, pas une derive.** `Shared` fait **26,03 → 2,26 → 21,39 Go** en trois passages pendant que `Private` fait **10,39 → 11,31 → 10,33** — amplitude **0,98 Go** pour un plafond de 10. Les 27 images et leur somme de **16,80 Go sont identiques a l'octet pres** pour le 2e jour consecutif, alors que TROIS images ont ete remplacees dans l'intervalle. Les inodes suivent le disque en phase (3,31 M → 2,23 M → 3,03 M). **La clef `cacheBuildPrivateGo`, ouverte le 08-14 sans renommer `cacheBuildGo`, donne sa reponse a son DEUXIEME point** — une clef renommee aurait efface la comparaison au moment ou elle servait. **NE PAS purger.** *(mesure du 2026-08-14, conservee : `Private` 11,31 Go, `Shared` 2,26 Go.)*
- **Mesure du 2026-08-14, conservee** : `Private` **11,31 Go** (plafond 10 Go, 13 % au-dessus) + `Shared` **2,26 Go**. ⚠️ **C'est le jour ou ce mecanisme a rendu 23,8 Go de `Shared` et fait mentir VPS-025** : le build du 08-13 a 17 h 18 a dereference les couches de l'image qu'il remplacait, `cache.db` a ete ecrit 341 s plus tard, et le disque est passe de 76 % a 59 %. **`Private` a valu 11,31 Go sur QUATRE lectures** prises entre 04 h 10 et 04 h 25 pendant qu'un build tournait, alors que le total de `docker system df` variait de **5,5 Go** (18,92 → 13,38 → 17,35 → 16,57) et que les entrees actives passaient de 0 a 33. **C'est `Private` la grandeur de tendance, pas le total.** **NE PAS purger.** *(mesure du 2026-08-13, conservee : total `docker system df` 36,42 Go / 182 entrees, `Private` 10,39 Go, `Shared` 26,03 Go.)*
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
- **Vu** : 2026-08-20 · **Mesure du jour** : **30/33 sans limite memoire, 33/33 sans limite CPU** — inchange ; **0 OOM en 30 j**, memoire **38 %**, swap **1 223 Mo**, **PSI `full` = 0,00 sur les TROIS ressources** (memoire, processeur, E/S). ✅ **Et c est un resultat, pas une routine** : la 4e occurrence de VPS-016 tourne depuis 1 h 08 au moment de la mesure, et **la memoire ne bronche pas** — ni PSI, ni OOM, ni `kcompactd0` en tete des processus, contrairement au 08-18. Le seuil de reescalade (60 % de moyenne, ou 1 OOM) n est **pas** atteint, **17e passage**. C est le **processeur** qui manque, pas la memoire — septieme fois que cette distinction tient. *(mesure du 2026-08-18, conservee ci-dessous.)*
- **Mesure du 2026-08-18, conservée** : **30/33 sans limite memoire, 33/33 sans limite CPU** — inchange ; **0 OOM en 30 j**, memoire **36 %**, swap **1 318 Mo**. ⚠️ **DEUX SIGNAUX NEUFS, et ils vont dans le meme sens** : la PSI memoire `full` cesse d'etre nulle (**avg10 = 0,74** a 03 h 51, 0,12 a 04 h 00 — elle valait **0,00** aux quatorze passages precedents), et `kcompactd0` — le compacteur de memoire du noyau — apparait **en tete des processus de l'HOTE a 11,8 % d'un coeur**, avec 30 min de CPU cumule. Le pic de RAM du 08-17 est de **50,7 %**, le plus haut de la semaine (22,9 a 35,9 les jours precedents). **Le seuil de reescalade n'est PAS atteint** (moyenne 36 % < 60 %, 0 OOM) et il ne faut pas le forcer — mais c'est la premiere fois que la memoire produit un signal, et il coincide avec le second regime de VPS-016. *(mesure du 2026-08-17, conservee ci-dessous.)*
- **Mesure du 2026-08-17, conservée** : **30/33 sans limite memoire, 33/33 sans limite CPU** — inchange ; **0 OOM en 30 j**, memoire **35 %**, PSI `full` = **0,00 sur le processeur ET sur la memoire**, swap **1 188 Mo** — seuil de reescalade non atteint pour le **14e passage**. ⚠️ VPS-016 en est a sa **8e journee (~125 h 20)** et vient de franchir **100,3 % d'un coeur en moyenne sur 24 h** sans faire tomber AUCUN conteneur : c'est le processeur qui manque, pas la memoire. *(mesure du 2026-08-16, conservee : 30/33 sans limite memoire, 33/33 sans limite CPU, 0 OOM, memoire 33 %, swap 1 268 Mo.)*

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
- **Vu : 2026-09-06** · **Mesure du jour** : **6 bases sur 7 sont à `4`**, seule `tracky-postgres`
  est à 1.1. ⚠️ **Le compte monte de 5/7 à 6/7 sans qu'aucun réglage n'ait changé** : c'est
  `vizyo-auth-db` — la base d'authentification de **toutes** les applications — qui entre dans la
  mesure pour la première fois, huit jours après avoir été rattrapée par VPS-M80. *Le numérateur a
  cessé d'être aveugle ; le parc, lui, est inchangé.*
  ✅ **Et le dénominateur est enfin honnête** : le levier affiche **`7 / 7 bases PostgreSQL
  examinées`** au lieu du `6 / 6` d'une machine qui en porte sept. Le garde de VPS-M34 tient — et
  ce passage montre qu'il ne suffisait pas : *un dénominateur calculé par le filtre défaillant est
  vert sur son propre angle mort* (VPS-M80).
  L'enjeu de performance reste nul (bases de 8 à 28 Mo, cache à 99,99 – 100 %) ; l'enjeu de méthode
  ne l'est pas.
- **Vu** : 2026-08-20 · **Mesure du jour** : **5 bases sur 6 sont a `4`, dont TROIS de production** (`vizyo-verify`, `vizyo-manager`, `texto`) — inchange, seule `tracky-postgres` est a 1.1. ✅ Le levier affiche **`6 / 6 bases examinees`** pour son **sixieme** passage complet, et le second par derivation (il ne parle plus a Docker). Le garde de denominateur de VPS-M34 tient. L enjeu de performance reste nul (bases de 8 a 17 Mo, cache a 99,99 %) ; l enjeu de methode ne l est pas. *(mesure du 2026-08-18, conservee ci-dessous.)*
- **Mesure du 2026-08-18, conservée** : **5 bases sur 6 sont a `4`, dont TROIS de production** — inchange. ✅ **Le levier affiche `6 / 6 bases examinees` pour son CINQUIEME passage complet, et pour la PREMIERE FOIS par derivation** (il ne parle plus a Docker du tout). ⚠️ **Ce correctif est celui qui a decapite la collecte ce matin** : l'accumulateur `RPC_CACHE` n'etait pas initialise sous `set -u` — voir **VPS-M43**. La valeur rendue est identique a l'ancienne methode, le mecanisme est bon, c'est son montage qui n'avait jamais ete essaye. *(mesure du 2026-08-17, conservee ci-dessous.)*
- **Mesure du 2026-08-17, conservée** : **5 bases sur 6 sont a `4`, dont TROIS de production** — `vizyo-verify-postgres`, `vizyo-manager-postgres` et `texto-postgres`. Seule `tracky-postgres` est a 1.1. Inchange ; le levier affiche `✅ 6 / 6 bases examinees` pour son **quatrieme** passage complet. 🆕 **A partir du prochain passage, ce levier ne parle plus a Docker du tout** : la valeur est capturee en section 5 et le levier en derive (VPS-M42, patron de VPS-M30). **Contre-epreuve faite sur la machine : 6/6 valeurs identiques a l'ancienne methode** — une optimisation qui ne prouve pas qu'elle rend la meme valeur n'est pas une optimisation. Le garde de denominateur de VPS-M34 est **conserve intact** : une base absente de la capture n'est toujours pas comptee comme vue. *(mesure du 2026-08-16, conservee ci-dessous.)*
- **Mesure du 2026-08-16, conservée** : **5 bases sur 6 sont a `4`, dont TROIS de production**. Seule `tracky-postgres` est a 1.1. Le levier corrige affiche `✅ 6 / 6 bases examinees` pour son **troisieme** passage complet — le correctif VPS-M34 tient. L'enjeu de performance reste nul (bases de 8 a 17 Mo, cache a 99,99 %) ; l'enjeu de methode ne l'est pas. *(mesure du 2026-08-15, conservee ci-dessous.)*
- **Mesure du 2026-08-15, conservée** : **5 bases sur 6 sont a `4`, dont TROIS de production** — `vizyo-verify-postgres`, `vizyo-manager-postgres` et `texto-postgres`. Seule `tracky-postgres` est a 1.1. Inchange ; le levier corrige affiche `✅ 6 / 6 bases examinees` pour son **deuxieme** passage complet — le correctif VPS-M34 tient. L'enjeu de performance reste nul (bases de 8 a 17 Mo, cache a 99,99 %) ; l'enjeu de methode ne l'est pas.
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
- **Vu** : 2026-08-20 · **Mesure du jour** : **198 Mo (=)** sur une fenetre glissante de **5 jours** (2026-08-16 → 2026-08-20). `min` **et** `max` ont avance d un jour chacun : regime permanent, rien a recuperer. *(mesure du 2026-08-18, conservee ci-dessous.)*
- **Mesure du 2026-08-18, conservée** : **204 Mo (+2)** sur une fenetre glissante de **4 jours** (2026-08-15 → 2026-08-18). `min` a avance de DEUX jours et `max` d'un : la fenetre se recale entre 4 et 5 jours selon l'heure de la purge relativement a celle de l'audit — et l'audit est passe 1 h 38 plus tard que d'habitude ce matin. Regime permanent, rien a recuperer. *(mesure du 2026-08-17, conservee ci-dessous.)*
- **Mesure du 2026-08-17, conservée** : **202 Mo (=)** sur une fenetre glissante de **5 jours** (2026-08-13 → 2026-08-17). `min` et `max` ont avance d'un jour chacun, pour le 3e passage consecutif : regime permanent, rien a recuperer, rien a surveiller. *(mesure du 2026-08-16, conservee : 202 Mo, fenetre 2026-08-12 → 08-16.)*
- **Mesure du 2026-08-15, conservée** : **202 Mo (−4)** sur une fenetre glissante de **5 jours** (2026-08-11 → 2026-08-15). Le `max` a avance d'un jour, le `min` n'a pas bouge : la fenetre s'etire d'un jour puis se recale, c'est le regime permanent. Rien a recuperer, rien a surveiller. *(mesure du 2026-08-14, conservee : 206 Mo, fenetre de 4 jours.)*

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
- **Vu** : 2026-08-20 · **Mesure du jour** : **13 volumes, 421,3 Mo — stabilise pour le 16e passage**. Le seuil de reexamen (« si le disque repasse au-dessus de 80 % ») est a **25 points** (55 %). La decision ne change pas : 421 Mo de bases non reconstituables contre 44 Go libres. *(mesure du 2026-08-18, conservee ci-dessous.)*
- **Mesure du 2026-08-18, conservée** : **13 volumes, 421,5 Mo — stabilise pour le 14e passage**, a l'octet pres. Le seuil de reexamen (« si le disque repasse au-dessus de 80 % ») est a **12 points** (68 %), contre 28 la veille — et ce recul de 16 points en 24 h est **exactement l'oscillation de VPS-025**, pas une degradation. La decision ne change pas. *(mesure du 2026-08-17, conservee ci-dessous.)*
- **Mesure du 2026-08-17, conservée** : **13 volumes, 421,5 Mo — stabilise pour le 13e passage**, a l'octet pres. Le seuil de reexamen (« si le disque repasse au-dessus de 80 % ») est a **28 points** (52 %), contre 26 la veille — la marge la plus large jamais mesuree. **Il ne faut PAS le lire comme une tendance** : il oscille avec le disque (VPS-025), et la journee du 08-16 a ete calme (271 blocs/s ecrits, le plus bas de la semaine). La decision ne change pas : 421 Mo de bases non reconstituables contre 47 Go libres. *(mesure du 2026-08-16, conservee ci-dessous.)*
- **Mesure du 2026-08-16, conservée** : **13 volumes, 421,5 Mo — stabilise pour le 12e passage**, a l'octet pres. Le seuil de reexamen etait a **26 points** (54 %), contre 8 la veille et 21 l'avant-veille — **et ce va-et-vient est exactement ce que l'oscillation de VPS-025 explique** : le disque oscille de ~23 Go au rythme des builds, donc ce seuil oscille avec lui. **Il ne faut donc PAS le lire comme une tendance.** La decision ne change pas : 421 Mo de bases non reconstituables contre 45 Go libres. *(mesure du 2026-08-15, conservee : 13 volumes, 421,5 Mo, disque a 72 %.)*
- **Mesure du 2026-08-15, conservée** : **13 volumes, 421,5 Mo — stabilise pour le 11e passage**. Le seuil de reexamen (« si le disque repasse au-dessus de 80 % ») est a **8 points**, contre 21 la veille et 4 l'avant-veille — **et ce va-et-vient est precisement ce que le troisieme point de VPS-001 explique** : le disque oscille de ~15 Go au rythme des builds, donc ce seuil oscille avec lui. **Il ne faut donc PAS le lire comme une tendance.** La decision ne change pas : 421 Mo de bases non reconstituables contre 27 Go libres. *(mesure du 2026-08-14, conservee : 13 volumes, 421,5 Mo, disque a 59 %.)*

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
- 🔴 **Vu : 2026-09-03 — LE VOLET « BIBLIOTHÈQUE REMPLACÉE » PASSE DE 4 À 6 SERVICES, ET LA CAUSE
  EST DATÉE.** `needrestart` nomme désormais : `dbus.service`, **`docker.service`**,
  `getty@tty1.service`, `serial-getty@ttyS0.service`, `systemd-logind.service`,
  `unattended-upgrades.service`. La cause est l'installation du **2026-09-02 à 06 h 15 min 49**
  (34 paquets, VPS-033), dont **neuf sont des bibliothèques partagées** — `libssh-4`, `zlib1g`,
  `libgcrypt20`, `libuuid1`, `libblkid1`, `libmount1`, `libtinfo6`, `libattr1`, `libbz2-1.0`.
  **Le correctif de sécurité est sur le disque et n'est pas dans le processus** — et cette fois
  ce n'est plus une phrase générale, c'est un lot nominatif et daté.
  Noyau actif **6.8.0-136**, installés **-137** et **-138** ; uptime **700,8 h** (29 j).
  ⚠️ **Ce que ça change à l'arbitrage du redémarrage, et ce que ça ne change pas** : ça lui donne
  une raison neuve et mesurée — six services, dont le démon qui porte 33 conteneurs. Ça ne change
  **rien** au reste : **VPS-014** a établi que la mémoire rendue par `dockerd` revient en cinq
  heures, et elle ne doit toujours pas entrer dans la justification.
- ✅ **Vu : 2026-08-26 — MESURE VALIDE, ET POUR LA PREMIÈRE FOIS DEUX POINTS COMPARABLES.**
  Cache apt de **2 h** (rafraîchi à 00 h 06 min 05) → **79 paquets en retard, dont 10 estampillés
  sécurité**. 2ᵉ source (`update-notifier`, 2 h elle aussi) : **78 dont 10** — *les deux sources
  s'accordent sur le compte de sécurité, ce qui n'était jamais arrivé.*

  | passage | cache | verdict | paquets | dont sécurité |
  |---|---|:--:|---:|---:|
  | 08-21 | 1 h | ✅ VALIDE | 85 | **17** |
  | 08-22 → 08-25 | 23 h | ❌ NON MESURABLE | — | — |
  | **08-26** | **2 h** | ✅ **VALIDE** | **79** | **10** |

  ✅ **Les 17 de 08-21 ont bien été installés**, le jour même à 06 h 35 : `bind9-*` (4), `curl` +
  `libcurl*` (3), `libheif*` (4), `vim*` (5), `wget` — **17 exactement**. Le canal fonctionne.

  **Les 10 en attente** : `openssl` + `libssl3t64` (**3.0.13-0ubuntu3.12 → 3.15, trois
  révisions**), `curl` + `libcurl3t64-gnutls` + `libcurl4t64` (10.12 → 10.13), `vim` + `vim-common`
  + `vim-runtime` + `vim-tiny` + `xxd` (7.19 → 7.20).

  🔑 **ET LE CANAL AUTOMATIQUE N'EST PAS EN PANNE — vérifié avant de l'écrire, parce que le
  contraire était à une phrase d'être publié en gravité 2 :**

  | Fait | Mesure |
  |---|---|
  | Listes `noble-security` rafraîchies | **08-25 à 20 h 48 et 22 h 01** |
  | Dernier passage de l'installateur | **08-25 à 06 h 47** — soit **avant** l'arrivée des paquets |
  | Ce qu'il a conclu ce jour-là | *« No packages found that can be upgraded »* — **correct à l'époque** |
  | Ce qu'il conclut maintenant (simulation) | *« Packages that will be upgraded: curl … openssl … xxd »* — **les 10** |
  | **Prochaine exécution réelle** | **08-26 à 06 h 46 min 36** |

  **L'audit mesure à 02 h 22, c'est-à-dire dans l'intervalle entre « les listes savent » et
  « l'installateur passe ».** Tout correctif publié dans la soirée sera compté « en attente » par
  l'audit et installé quatre heures plus tard. *C'est la famille de VPS-015 (l'audit rapporte les
  sauvegardes de la veille) et de VPS-026 (la phase d'`alpine`) : l'heure d'observation décide de
  la réponse.*

  > **Test écrit d'avance, avec sa précondition (VPS-M41).** *Au passage du **2026-08-27**,
  > `openssl` doit être en **3.0.13-0ubuntu3.15** et le compte de sécurité doit avoir chuté
  > d'environ 10. **Précondition** : que `apt-daily-upgrade.timer` se déclenche bien à 06 h 46 le
  > 08-26 **ET** que la mesure du 08-27 soit elle-même valide (cache < 6 h) — sinon le test ne dit
  > rien et il ne faut pas le lire. **Si les 10 sont toujours là au 08-27 sur un cache frais**, le
  > canal automatique échoue réellement sur des correctifs de sécurité : ce constat passe alors en
  > gravité 2 et le point remonte en tête du plan.*

  ⚠️ **Ce qui ne dépend pas de ce test** : **deux noyaux d'avance** (`6.8.0-137` **et** `-138`,
  actif `-136`) et **4 services sur bibliothèque remplacée**. Ceux-là ne partiront jamais sans
  redémarrage.
- **Vu** : 2026-08-20 · **Mesure du jour** : tourne sur 6.8.0-**136** · 🟠 **DEUX noyaux installes en avance desormais : 6.8.0-137 ET 6.8.0-138** · **4 services sur une bibliotheque REMPLACEE** · **33/33 en `unless-stopped`**. 🟠 **Compte de paquets NON MESURABLE, et les DEUX sources sont perimees cette fois** : cache `apt` a **23 h** (64 paquets, 0 securite), `update-notifier` a **20 h** (64 paquets, **1** securite). **6e refus de publier en 7 passages** (VPS-M29). ⚠️ **La seconde source, ajoutee le 08-18 precisement pour couvrir ce trou, est perimee elle aussi** — son timer tire a 21 h 44, soit la meme periode que la collecte, decalee. *Ajouter une source n aide que si sa CADENCE differe.* *(mesure du 2026-08-18, conservee ci-dessous.)*
- **Mesure du 2026-08-18, conservée** : tourne sur 6.8.0-**136**, 6.8.0-**137** installe · **4 services sur une bibliotheque REMPLACEE** · **33/33 en `unless-stopped`**.

> ### 🔴 2026-08-18 — LA SECONDE SOURCE EXISTE DEPUIS CE MATIN, ET ELLE CONTREDIT LA PREMIERE
>
> L'angle mort n° 6 du rapport du 08-17 demandait de lire une **seconde** source, avec sa propre
> fraicheur, **a cote** de la premiere et jamais a sa place. C'est fait, et le correctif a paye
> **des sa premiere execution** :
>
> | Source | Fraicheur | Paquets en retard | dont securite |
> |---|---:|---:|---:|
> | cache `apt` (`apt list --upgradable`) | **0 h** ✅ valide | **70** | **0** |
> | `/var/lib/update-notifier/updates-available` | **0 h** ✅ valide | **76** | **1** |
>
> **Les deux mesures sont valides, prises a vingt secondes d'intervalle, et elles ne disent pas la
> meme chose : 70 contre 76, et surtout 0 contre 1 correctif de securite.**
>
> ⚠️ **Le « 0 securite » est precisement le chiffre que VPS-M29 a ete ecrit pour proteger**, et
> c'est le chiffre publie a chaque passage ou le cache etait frais. Il aura suffi d'une seconde
> source pour montrer qu'un `0` sur cache frais n'est pas davantage une garantie qu'un `0` sur
> cache perime — le rapport le repetait a chaque passage (*« Ubuntu publie beaucoup de correctifs
> par `noble-updates`, qui ne porte pas le mot security »*), et **personne ne pouvait le
> verifier**. Maintenant si.
>
> **Ce que l'ecart ne dit PAS** : laquelle a raison. Les deux comptent des choses legerement
> differentes (`update-notifier` derive son compte d'un `apt-get -s dist-upgrade`, le cache d'un
> `apt list`). **L'ecart est l'information** : il date le moment ou l'une des deux a cesse de voir.
> ⚠️ **A NE PAS FAIRE : substituer l'une a l'autre**, ni retenir « la plus alarmante ». Les deux
> sont publiees cote a cote, avec leur age.
- **Mesure du 2026-08-17, conservée** : tourne sur 6.8.0-**136**, 6.8.0-**137** installe · 🟠 **COMPTE DE PAQUETS DE NOUVEAU NON MESURABLE** : cache apt du **2026-08-16 a 01 h 02 min 59, soit 25 h** pour un seuil de validite de 6 h. Indicatif non publiable : 64 en retard, 0 securite. **VPS-M29 refuse pour la 5e fois en 6 passages** ; il n'a publie qu'une seule fois, hier. ⚠️ **Le garde fonctionne — et c'est desormais la CADENCE le sujet, pas le garde.** `apt-daily.timer` porte un delai aleatoire de plusieurs heures : il a tire **23 h 02** hier soir, soit 3 h 22 avant la collecte, pour un cache qui datait deja de 25 h. Une mesure disponible **un matin sur six** n'est pas une surveillance. *Piste (angle mort n° 6 du 2026-08-17) : lire une SECONDE source — `/var/lib/update-notifier/updates-available`, ecrit par `update-notifier-download.timer` (declenche a 21 h 43, soit 4 h 41 avant la collecte) — a afficher **a cote** de la premiere, jamais a sa place.* ⚠️ **A NE PAS FAIRE : elargir le seuil de 6 h pour que le chiffre passe** — c'est exactement la tentation que VPS-M31 punit. · **4 services tournent sur une bibliotheque REMPLACEE** · **33/33 en `unless-stopped` — verifie par le collecteur**. *(mesure du 2026-08-16, conservee ci-dessous.)*
- **Mesure du 2026-08-16, conservée** : tourne sur 6.8.0-**136**, 6.8.0-**137** installe · ✅ **COMPTE DE PAQUETS ENFIN MESURABLE ET PUBLIE — premiere fois depuis le 2026-08-11** : cache apt rafraichi a **01 h 02 min 59, soit 1 h** pour un seuil de validite de 6 h → `✅ MESURE VALIDE`. **64 paquets en retard, 0 estampille securite.** VPS-M29 a refuse de publier **quatre fois de suite** ; ce matin il publie. *Un garde qui ne dit jamais oui ne prouve rien — celui-ci vient de montrer qu'il sait faire les deux.* ⚠️ Et meme sur cache frais, un 0 n'est pas une garantie : Ubuntu publie beaucoup de correctifs par `noble-updates`, qui ne porte pas le mot « security ». · **4 services tournent sur une bibliotheque REMPLACEE** · **33/33 en `unless-stopped` — verifie par le collecteur**. *(mesure du 2026-08-15, conservee ci-dessous.)*
- **Mesure du 2026-08-15, conservée** : 6.8.0-136 actif, 6.8.0-137 installe, compte **NON MESURABLE** (cache apt de 16 h, 4e refus de VPS-M29 ; indicatif 64/0), 4 services, 33/33.

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
- **Vu** : 2026-08-20 · **Mesure du jour** : **65 invocations/min** (93 600/jour) — **17e passage**, inchangee depuis le 2026-08-04. Denominateur affiche : **24 sondes sur 33 conteneurs, 9 SANS AUCUNE SONDE**. ⚠️ Taux de creation de processus : **1 230/min** — **septieme regime en sept jours** (1 866 / 684 / 1 680 / 1 548 / 1 062 / 1 674 / 1 230). Ce compteur reste **NON INTERPRETE** : deux hypotheses sont mortes, et aucune troisieme ne sera posee sans son critere de refutation ET sa precondition (VPS-M41). ⚠️ **La mesure du jour est prise pendant la 4e occurrence de VPS-016** : elle n est comparable ni au 08-19 (machine saine) ni au 08-18 (machine saturee), et il faut le dire plutot que de l aligner dans la serie. *(mesure du 2026-08-18, conservee ci-dessous.)*
- **Mesure du 2026-08-18, conservée** : **65 invocations/min** (93 600/jour) — **15e passage**, inchangee depuis le 2026-08-04. Denominateur affiche : **24 sondes sur 33 conteneurs, 9 SANS AUCUNE SONDE**. ⚠️ Taux de creation de processus : **1 062/min** — CINQUIEME regime en cinq jours (1 866 / 684 / 1 680 / 1 548 / 1 062). Ce compteur reste **NON INTERPRETE** : deux hypotheses sont mortes, et la troisieme ne sera pas posee sans son critere de refutation ET sa precondition (VPS-M41). ⚠️ **Il faut noter que la mesure de ce matin est prise sur une machine ou un BUILD tournait** — ce qui ne l'invalide pas, mais interdit de la comparer aux precedentes. *(mesure du 2026-08-17, conservee ci-dessous.)*
- **Mesure du 2026-08-17, conservée** : **65 invocations/min** (93 600/jour), inchangee depuis le 2026-08-04 — **14e passage**. Denominateur affiche : **24 sondes sur 33 conteneurs, 9 SANS AUCUNE SONDE**. ⚠️ Taux de creation de processus : **1 548/min**. Quatrieme regime en quatre jours (**1 866 / 684 / 1 680 / 1 548**), sur une machine dont la charge periodique n'a pas bouge d'un iota. **Les deux hypotheses avancees sont mortes** — « il mesure la boucle » et « il mesure les builds », la seconde refutee par son propre critere le 08-16. **Ce compteur reste NON INTERPRETE**, et il le restera tant qu'une troisieme hypothese n'aura pas ete posee **avec son critere de refutation ET sa precondition de validite** (VPS-M41). *(mesure du 2026-08-16, conservee ci-dessous.)*
- **Mesure du 2026-08-16, conservée** : **65 invocations/min** (93 600/jour) — **13e passage**. Denominateur affiche : **24 sondes sur 33 conteneurs, 9 SANS AUCUNE SONDE**. ❌ **Taux de creation de processus : 1 680/min — ET LE TEST ECRIT D'AVANCE EST TRANCHE CONTRE L'HYPOTHESE.** Le rapport du 08-15 posait : *« au prochain passage sans build dans les heures precedentes, le compteur doit retomber vers ~700 ; s'il remonte au-dessus de 1 300, l'hypothese est fausse. »* **1 680 > 1 300, et aucun build ne tournait pendant la collecte** (le dernier remonte a 2 h 17 plus tot, termine). L'hypothese « ce compteur mesure les BUILDS » est **refutee par son propre critere**. Troisieme regime en trois jours (1 866 / 684 / 1 680) sur une machine dont la charge periodique n'a pas bouge d'un iota. ⚠️ **Ni « il mesure la boucle » ni « il mesure les builds » ne tiennent** : ce compteur ne doit plus etre interprete tant qu'une troisieme hypothese n'est pas *testee* — et ne pas en proposer une sans son critere de refutation. *(mesure du 2026-08-15, conservee ci-dessous.)*
- **Mesure du 2026-08-15, conservée** : **65 invocations/min** (93 600/jour) — **12e passage**. Denominateur affiche : **24 sondes sur 33 conteneurs, 9 SANS AUCUNE SONDE**. ⚠️ Taux de creation de processus : **684/min — le plus BAS jamais mesure**, apres le 1 866/min de la veille qui etait le plus HAUT. **Un facteur 2,7 en 24 h sur une machine dont la charge periodique n'a pas bouge d'un iota.** ✅ **L'explication candidate remplace le « ne plus l'interpreter » d'hier** : ce compteur mesure les BUILDS, pas la boucle — le 08-14 un build tournait PENDANT la collecte (`maalem-dev-admin` a 04 h 16 min 52), le 08-15 le dernier remontait a 16 h. Plancher theorique connu : 65 sondes × ~5 processus = **~325/min**. ⚠️ **DEUX POINTS NE FONT PAS UNE LOI** (VPS-008, VPS-024 et VPS-025 l'ont paye) : le test est ecrit d'avance — *au prochain passage sans build recent, le compteur doit retomber vers ~700 ; s'il remonte au-dessus de 1 300, l'hypothese est fausse.* *(mesure du 2026-08-14, conservee : 65 invocations/min, 24/33 sondes, 1 866 processus/min.)*
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

- **Domaine** : sécurité · **Gravité** : 2 · **Statut** : 🔴 **`A_TRAITER` — ROUVERT le 2026-09-03**
  *(était `APPLIQUE` depuis le 2026-08-04)*
- 🟠 **Vu : 2026-09-06 — QUATRIÈME JOUR, ET LA PROGRESSION S'ARRÊTE : 0 → 12 → 16 → 16.**
  `github-actions-vizyo-auth` reste à **16 connexions root**, toujours **sans aucune option de
  restriction**. **2 empreintes vues sur la fenêtre, 0 non déclarée.**
  ⚠️⚠️ **ET IL NE FAUT PAS LIRE LA BAISSE DE `vizyo-vps-hostinger` (10 442 → 9 127) COMME UNE
  ACCALMIE.** Ces compteurs portent sur une **fenêtre glissante de 7 jours**, qui vient de laisser
  sortir le 08-29 pour n'entrer que **4 heures** du jour en cours. **C'est la fenêtre qui a bougé,
  pas l'usage** — et le total des sessions SSH le confirme par la même mécanique (10 458 → 9 143).
  *C'est le mode d'échec de **VPS-M76** sur une troisième famille de compteurs, celle de la
  section 6, qu'aucun constat ne couvrait ; il fonde la question ouverte du rapport de ce jour.*
  ⚠️ **Conséquence pour ce constat** : la série `0 → 12 → 16 → 16` est **elle aussi** glissante. Un
  palier n'y prouve pas un arrêt d'usage — seulement que les entrées et les sorties de fenêtre se
  compensent.
- 🔴 **Vu : 2026-09-05 — TROISIÈME JOUR, TROISIÈME VALEUR : `connexions` passe de 12 à 16.**
  `github-actions-vizyo-auth` : **0 → 12 → 16** en trois passages, toujours **sans aucune option de
  restriction**, toujours en root. La clé humaine `vizyo-vps-hostinger` est à **10 442** (9 371 la
  veille) et reste **volontairement** non restreinte — le 🟠 en face d'elle est le comportement
  voulu du détecteur. **2 empreintes vues, 0 non déclarée.**
  *La série 0 → 12 → 16 clôt définitivement le débat ouvert le 09-03 : cette clé n'est pas
  dormante, c'est un accès root de CI en usage quotidien.* Seuil de réescalade **inchangé**.
- **Vu** : 2026-08-04 · **Mesure à la découverte** : 3 des 4 clés de `/root/.ssh/authorized_keys`

> ### 🔴 2026-09-04 — LA CLÉ N'EST PAS DORMANTE : DOUZE SESSIONS ROOT EN VINGT ET UNE HEURES
>
> ```
>   github-actions-vizyo-auth  SHA256:OTSnEmsW…  connexions=12   🟠 AUCUNE option de restriction
>   2026-09-03 05:36 → 15:17   dix connexions root, depuis dix IP Azure distinctes
>   2026-09-04 00:36 et 00:54  les deux dernieres — vizyo-auth-api est construit a 00:57:13
> ```
>
> **Hier : `connexions=0`. Aujourd'hui : 12.** Le déploiement de `vizyo-auth` de la nuit est passé
> par cette clé. Elle est donc l'accès **root** d'une chaîne de CI **en usage quotidien**, et elle
> ne porte aucune des quatre options posées le 2026-08-04 sur l'autre clé de CI.
>
> **Ce que ça change** : une clé root non restreinte qui ne sert jamais est un risque théorique ;
> une clé root non restreinte qui ouvre **douze sessions par jour depuis douze adresses publiques
> différentes** est une surface **exercée**. La gravité reste 2, l'urgence monte.
>
> ✅ **Et l'avertissement écrit la veille est confirmé en un jour** : *« ⚠️ À ne pas faire :
> retirer la clé — `connexions=0` sur 7 jours ne veut pas dire “inutilisée” »*. La démonstration
> est arrivée au passage suivant. **Retirer la clé sur un `connexions=0` aurait cassé le
> déploiement de l'authentification de toutes les applications.**
>
> ⚠️ **Piège payé par l'auditeur le 2026-09-04, à consigner** : voyant `0 → 12`, j'ai grepé
> l'empreinte dans `auth.log auth.log.1` — **dans cet ordre** — et lu un `tail -15` qui ne montrait
> que des lignes des 23 et 24 août ; j'en ai conclu quelques minutes que le compteur comptait des
> événements vieux de onze jours et que **VPS-M77 était cassé**. `tail` lisait la fin du fichier
> le plus **ancien**, placé en second. *Un détecteur correct accusé à tort par la sortie mal
> ordonnée du contrôle censé le vérifier : VPS-M01 retourné contre l'auditeur.* **Ce qui a tranché
> a été de rejouer le filtre de fenêtre du collecteur lui-même, pas de refaire un contrôle à moi.**
>
> ### 🔴 2026-09-03 — LE CONSTAT ROUVRE : UNE TROISIÈME CLÉ ROOT, SANS RESTRICTION, DEPUIS DIX-NEUF JOURS
>
> ```
> declarees et ACTIVES : 3
>   vizyo-vps-hostinger          SHA256:cdd9XFoV…  connexions=6310  🟠 AUCUNE option de restriction
>   github-actions-deploy-maalem SHA256:Y/gE+zS4…  connexions=0     ✅ restreinte (no-port-forwarding,…)
>   github-actions-vizyo-auth    SHA256:OTSnEmsW…  connexions=0     🟠 AUCUNE option de restriction
> ```
>
> **`github-actions-vizyo-auth` n'apparaît nulle part dans ce référentiel.** Première utilisation
> le **2026-08-23 à 10 h 58 min 33 depuis `82.67.153.51`** — le poste d'administration, donc la
> signature d'une clé qu'on installe et qu'on essaie — puis depuis **douze IP Azure** les 23 et
> 24 août. **15 connexions au total, aucune depuis le 2026-08-24.**
>
> ### Ce que ce constat N'EST PAS
>
> **Ce n'est pas une intrusion.** La clé est **déclarée** dans `authorized_keys`, son commentaire
> la nomme, et son usage est celui d'une clé de déploiement GitHub Actions parfaitement ordinaire.
>
> ### Ce qu'il EST
>
> **Le correctif du 2026-08-04 a régressé sur une clé ajoutée dix-neuf jours après lui.** Ce
> correctif consistait à poser `no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-user-rc`
> sur les clés de CI, pour qu'une clé volée ne serve pas de **tunnel** vers Postgres, Redis ou
> MinIO. Le gain tient toujours sur `github-actions-deploy-maalem` ; il n'a jamais existé sur
> celle-ci.
>
> ### `pourquoiInvisible` — et c'est la partie qui instruit
>
> **Le collecteur n'a JAMAIS lu une seule empreinte.** Il publie, depuis le premier passage, un
> *« top 5 des IP dont des connexions ont RÉUSSI »* — et une adresse Azure ressemble à une autre
> adresse Azure. La phrase *« aucune clé inconnue »* a été vérifiée **à la main** aux passages des
> 08-09, 08-11 et 08-16 à 08-20 — **tous antérieurs au 08-23** — puis plus jamais.
>
> **Un statut `APPLIQUE` n'est plus relu : c'est le sens même du statut.** VPS-007 l'avait déjà
> payé (clos neuf passages sur un dénominateur tronqué), VPS-022 aussi (onze passages sur un
> périmètre de trois fichiers). **Celui-ci est le troisième**, et le premier où l'objet du constat
> a *changé* après la fermeture plutôt que d'avoir été mal mesuré à l'origine.
> *Un correctif qui vit dans un fichier, sans rien qui le vérifie, ne survit pas au prochain ajout.*
> Corrigé dans le collecteur le jour même — **VPS-M77**.
>
> ### QUOI FAIRE
>
> Poser sur la clé les mêmes options que sur l'autre clé de CI — dix secondes, aucun effet de bord,
> et c'est le geste **déjà prouvé** le 2026-08-04 sur une clé de test jetable.
>
> ```bash
> grep -n 'github-actions-vizyo-auth' /root/.ssh/authorized_keys   # relever la ligne AVANT
> ```
>
> ⚠️ **À ne pas faire : retirer la clé.** `connexions=0` sur une fenêtre de 7 jours ne veut pas
> dire « inutilisée », mais « elle n'a pas servi ces sept jours-là » — `auth.log` ne garde pas
> davantage. Le déploiement de `vizyo-auth`, qui porte l'authentification de **toutes** les
> applications, en dépend peut-être.
> ⚠️ **À ne pas faire non plus : poser `command="…"`.** VPS-012 l'a mesuré et écarté le 2026-08-04 :
> les workflows envoient des scripts shell multi-lignes.
> ⚠️ **Et ne pas « corriger » la clé humaine** : elle est **volontairement** non restreinte, c'est
> écrit dans `authorized_keys` depuis le 2026-08-04. Le 🟠 en face d'elle est le comportement voulu
> du détecteur.
>
> ### Seuil de réescalade
>
> Passer en **gravité 1** si une empreinte **non déclarée** apparaît dans `auth.log`, ou si une clé
> de CI sans restriction est utilisée depuis une adresse **hors** des plages de son fournisseur.
- ✅ **2026-08-20 — 17e passage, aucune clé inconnue, et le périmètre est désormais écrit noir sur blanc.** **1 183 connexions acceptées** en 7 jours glissants depuis `82.67.153.51` (clé humaine `cdd9XFoV…`), plus 4 connexions isolées d'adresses Azure (CI). **22 échecs sur 7 jours, 0 sur `root`**, `Currently banned: 0`. ⚠️ **Et il faut rappeler ce que ce contrôle ne couvre pas, parce que le rappel a servi ce matin** : **VPS-027 passe en `A_TRAITER` aujourd'hui** — le canal de l'hyperviseur a écrit dans `/etc/cron.d` et lancé un `docker builder prune`, **sans une ligne dans `auth.log`, sans empreinte à compter**. Dix-sept passages ont conclu « aucune clé inconnue » sur les accès **SSH**, et c'est vrai. *La conclusion est juste sur son périmètre ; le périmètre n'est pas celui qu'on croirait.*
- ✅ **2026-08-18 — 15e passage, et la vérification prend un sens nouveau.** Sur **1 095 connexions acceptées en 7 jours glissants, DEUX empreintes**, les deux déclarées : `cdd9XFoV…` (humaine, **1 064**) et `Y/gE+zS4…` (CI restreinte, **31 — soit +3 depuis hier**, donc la CI a déployé, ce que confirment les 5 images construites). Les **quatre IP inhabituelles** du jour — `64.236.169.3`, `52.182.171.82`, `52.161.56.65`, `52.160.224.98` — portent **toutes** l'empreinte de la clé CI, vérifiée nommément dans `auth.log`. ⚠️⚠️ **ET IL FAUT DÉSORMAIS ÉCRIRE CE QUE CETTE VÉRIFICATION NE COUVRE PAS.** Quinze passages ont conclu « aucune clé inconnue » sur les accès **SSH**, et c'est vrai. Mais **VPS-027**, découvert ce matin, établit qu'un tiers exécute des commandes **en root** dans la machine ~50 fois par jour **sans passer par SSH** — donc sans laisser une ligne dans `auth.log`, sans empreinte à compter, et sans que ce contrôle puisse le voir. *La conclusion était juste sur son périmètre ; c'est le périmètre qui n'était pas celui qu'on croyait.*
- ✅ **2026-08-17 — 14e passage, la même vérification, le même résultat.** Sur **983 connexions acceptées en 7 jours glissants, DEUX empreintes**, les deux déclarées : `cdd9XFoV…` (humaine, **955**) et `Y/gE+zS4…` (CI restreinte, **28 — inchangé depuis hier**, donc la CI n'a pas déployé). Les **quatre IP inhabituelles** du jour — `52.182.171.82`, `52.161.57.34`, `64.236.200.85`, `64.236.169.3` — portent **toutes** l'empreinte `Y/gE+zS4…`, la clé `github-actions-deploy-maalem`. ⚠️ **La clé révoquée `ulkonmDi…` reste hors de la fenêtre de 7 jours** : son absence n'est plus une preuve, seulement une conséquence de la fenêtre glissante — treize jours après sa révocation.
- ✅ **2026-08-16 — 13e passage, et une alerte levée par la vérification.** La section 6 affichait **quatre IP inhabituelles** parmi les connexions réussies — `64.236.142.147`, `64.236.200.85`, `64.236.169.3`, `52.241.147.113`. Vérifié dans `auth.log` : **les quatre portent l'empreinte `Y/gE+zS4…`**, la clé `github-actions-deploy-maalem` **restreinte** le 2026-08-04. Sur **938 connexions acceptées en 7 jours glissants, seulement DEUX empreintes**, les deux déclarées : `cdd9XFoV…` (humaine, **910**) et `Y/gE+zS4…` (CI, **28**). ⚠️ **La clé révoquée `ulkonmDi…` est désormais SORTIE de la fenêtre de 7 jours** : ses 3 connexions dataient toutes du 2026-08-04 à 20 h 37. Douze jours après sa révocation, elle n'a jamais resservi — et il faut noter que son absence de la liste n'est plus une preuve, seulement une conséquence de la fenêtre glissante.
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
- 🔴 **Vu : 2026-09-06 — 29ᵉ PASSAGE, INTACT, ET LES TROIS LIGNES VERTES SONT ENFIN PASSÉES À
  L'ORANGE.** Le correctif **VPS-M84** écrit ce passage aligne le seuil de la table de couverture
  sur celui de son bloc voisin : `capcom6`, `vizyo-manager` et `vizyo-texto`, à **47 h**, affichent
  désormais **`🟠 NUIT MANQUÉE (47 h > 30 h)`** au lieu de `✅ à jour (1 j)`. *Le dump manuel du
  09-04 a cessé de les blanchir au bout de 43 heures au lieu de sept jours.*
  Discriminant de cadence (VPS-M81), inchangé : `vizyo-manager` **salve précédente à 142 j**,
  `texto` et `capcom6` **une seule copie chacun**.
  ✅ **ET LE GABARIT À COPIER A MAINTENANT FAIT SES PREUVES** : `vizyo-auth-backup.timer` ne s'est
  pas contenté d'être posé, il s'est **déclenché seul deux fois** — le 09-05 à 04 h 01 min 41 et le
  09-06 à 04 h 04 min 10, `systemd[1]: Starting…` à l'appui — avec rétention 30 j active et
  journal. **3 copies, cadence mesurée 24 h.** La réserve écrite le 09-05 est levée : il n'y a plus
  rien à concevoir pour les trois autres, seulement à copier. **Créneaux pris : 03 h 00, 03 h 30,
  04 h 00 — 04 h 30 est libre.**
- 🔴 **Vu : 2026-09-05 — 28ᵉ PASSAGE, ET LE CONSTAT EST INTACT MALGRÉ TROIS LIGNES VERTES.** La
  table de couverture affiche `✅ à jour (0 j)` sur **les trois** bases. C'est un **dump lancé à la
  main** le 2026-09-04 à **04 h 52 min 04**, *la même seconde pour les trois*, et **rien ne le
  rejouera** : aucun timer, aucun cron, aucun script. Mesure du discriminant posé ce passage
  (VPS-M81) : `vizyo-manager` **salve précédente à 142 jours**, `texto` et `capcom6` **une seule
  copie chacun**.
  ⚠️ **Sans ce discriminant, ce constat de gravité 1 aurait paru refermé pendant sept jours** — le
  temps que l'âge de la copie franchisse le seuil d'abandon.
  ⚠️ **Et le script qui aurait pu les produire existe, sans appelant** :
  `/opt/vizyo-manager/deploy/backup-db.sh`, daté du **2026-03-21**, cité par aucun cron ni aucune
  unité. Il n'est même pas l'auteur du fichier du 09-04 : il nomme ses archives
  `vizyo_manager_<date>_<heure>` (souligné, forme des 25 copies antérieures, la dernière du
  2026-04-15) alors que le fichier neuf porte un **tiret**, comme `texto` et `capcom6`.
  ✅ **Ce qui a VRAIMENT changé, et c'est une bonne nouvelle** : `vizyo-auth` — une **8ᵉ** base,
  que cet audit n'avait jamais énumérée (VPS-M80) — a reçu le 2026-09-04 une vraie unité
  quotidienne, `vizyo-auth-backup.timer`, à **04 h 00 UTC** : *exactement le créneau que le plan
  d'action de ce référentiel désignait comme libre*, avec `RandomizedDelaySec=300`,
  `Persistent=true`, rétention 30 j et journalisation. **Le modèle à copier pour les trois autres
  est désormais sur la machine.** ⚠️ Il n'a encore **jamais tourné seul** : première échéance
  automatique le 2026-09-05 à 04 h 04.
- **Vu : 2026-08-26** · **Mesure du jour** : 3 bases de production sur 7 moteurs en service ; `vizyo-manager` a **132 jours** (3 191 h) ; **cout total d'y remedier : 17,7 Mo/jour** (`texto` 8 932 kB · `vizyo-manager` 8 396 kB · `capcom6` 0,4 Mo) — **23ᵉ passage sans action**, sur une machine qui a **45 Go libres** et garde deja 6,7 Go de sauvegardes Tracky.
- **Vu** : 2026-08-22 · **Mesure du jour** : 3 bases de production sur 7 moteurs en service ; `vizyo-manager` a **129 jours** (3 095 h) ; **cout total d'y remedier : 17,6 Mo/jour** (`texto` 8 836 kB · `vizyo-manager` 8 388 kB · `capcom6` 0,4 Mo) — **19e passage sans action**, sur une machine qui a **43 Go libres** et garde deja 6,8 Go de sauvegardes Tracky. *(mesure du 2026-08-21, conservee ci-dessous.)*
- **Mesure du 2026-08-21, conservée** : 3 bases de production sur 7 moteurs en service ; `vizyo-manager` a **128 jours** (3 073 h) ; **cout total d'y remedier : 17,6 Mo/jour** (`texto` 8 828 kB · `vizyo-manager` 8 388 kB · `capcom6` 0,4 Mo) — **18e passage sans action**. ⚠️ Rappel de ce que porte `texto-postgres`, seule base de PRODUCTION sans aucune copie : `messages`, `allowlist_entries` et `allowlist_audit_logs`, c'est-a-dire la passerelle SMS. *(mesure du 2026-08-20, conservee ci-dessous.)*
- **Mesure du 2026-08-20, conservée** : 3 bases de production sur 7 moteurs en service ; `vizyo-manager` a **126 jours** (3 047 h) ; **cout total d'y remedier : 17,5 Mo/jour** (`texto` 8 788 kB · `vizyo-manager` 8 388 kB · `capcom6` 0,4 Mo) — **17e passage sans action**. ⚠️ **Ce constat gagne un voisin ce passage** : **VPS-030** montre que le controle de couverture, defini par le chemin `/var/backups`, ne voit pas non plus 1,66 Go de dumps deposes dans `/root/backups`. *Les deux sont le meme defaut de perimetre, pris par ses deux bouts.* *(mesure du 2026-08-18, conservee ci-dessous.)*
- **Mesure du 2026-08-18, conservée** : 3 bases de production sur 7 moteurs en service ; `vizyo-manager` a **125 jours** (3 001 h) ; **cout total d'y remedier : 17,5 Mo/jour** (`texto` 8 780 kB · `vizyo-manager` 8 356 kB · `capcom6` 0,4 Mo) — **15e passage sans action**. *(mesure du 2026-08-17, conservee : `vizyo-manager` a 123 jours / 2 975 h.)*
- **Mesure du 2026-08-17, conservée** : 3 bases de production sur 7 moteurs en service ; `vizyo-manager` a **123 jours** (2 975 h) ; **cout total d'y remedier : 17,5 Mo/jour** (`texto` 8,7 Mo · `vizyo-manager` 8,4 Mo · `capcom6` 0,4 Mo) — **14e passage sans action**. *(mesure du 2026-08-16, conservee : `vizyo-manager` a 122 jours / 2 951 h, cout total 17,5 Mo/jour.)*
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

- **Domaine** : sauvegardes · **Gravité** : **2** · **Statut** : `A_TRAITER` — **volet SYMPTÔME `APPLIQUE` le 2026-08-14 (prouvé par le TIMER, deux nuits), volet CAUSE toujours intact**
- ✅ **Vu : 2026-09-06 — LE MODE D'ÉCHEC DE CE CONSTAT NE SE REJOUE PAS SUR `vizyo-auth`, ET C'EST
  MESURÉ, PAS SUPPOSÉ.** Le test écrit d'avance le 09-05 exigeait *« deux copies et une cadence
  d'environ 20 h »*. La machine rend **trois copies** et **24 h** :

  ```
  vizyo_auth_20260904-073414.sql.gz   ← lancement MANUEL
  vizyo_auth_20260905-040141.sql.gz   ← 1re echeance AUTOMATIQUE
  vizyo_auth_20260906-040410.sql.gz   ← 2e echeance AUTOMATIQUE
  2026-09-06T04:04:10  systemd[1]: Starting vizyo-auth-backup.service...
  2026-09-06T04:04:11  vizyo-auth-backup.sh: 3 sauvegarde(s) en place dans /var/backups/vizyo-auth.
  ```

  **C'est `systemd[1]` qui démarre l'unité, pas une session.** *Un script posé, une unité déclarée
  et rien qui se déclenche — le motif exact de ce constat — a été exclu par la mesure.*
  ⚠️ **Et il faut dire pourquoi la réserve avait été écrite** : la collecte du 09-05 tournait à
  **02 h 22**, soit **1 h 40 avant** la première échéance. *Le rapport d'hier ne pouvait pas voir
  cette exécution ; il a eu raison de ne pas la supposer.*
- ✅ **Vu : 2026-09-05 — LE MOTIF DE CE CONSTAT EST RECONNU ET REFERMÉ AILLEURS, PAR ÉCRIT.**
  `vizyo-auth-backup.service`, créé le 2026-09-04, porte dans son propre en-tête :
  *« Absente jusqu'au 03/09/2026 : les scripts de sauvegarde étaient déposés sur le VPS depuis le
  07/03/2026 mais rien ne les appelait. »* — **c'est VPS-015 mot pour mot, sur une autre
  application, diagnostiqué et corrigé sans cet audit.**
  ⚠️ **Et le motif s'est reproduit une troisième fois le même jour, sans être vu** :
  `/opt/vizyo-manager/deploy/backup-db.sh` est sur la machine **depuis le 2026-03-21** et **personne
  ne l'appelle** (VPS-013, VPS-M81). *Un script de sauvegarde posé sans déclencheur est le mode de
  panne le plus fréquent de cette machine : trois occurrences en six mois, sur trois applications.*
  ⚠️ **Ce que l'audit ne peut PAS encore dire** : `vizyo-auth-backup.timer` n'a **jamais tourné
  seul**. Sa seule exécution est manuelle (09-04 à 07 h 34) ; première échéance automatique le
  09-05 à 04 h 04. **Test écrit d'avance** : au passage du 2026-09-06, `/var/backups/vizyo-auth`
  doit porter **deux** copies et une cadence d'environ **20 h**, pas « une seule salve ».
- 🔴 **Vu : 2026-09-04 — LE SYMPTÔME TIENT (7 nuits d'affilée), LA CAUSE EST INTACTE, ET ELLE EST
  PLUS LARGE QU'ÉCRIT.** Le timer a déclenché **sept jours distincts de suite** (08-29 → 09-04,
  dernier à 03 h 30 min 30, 30 archives, toutes chiffrées) : *le volet symptôme ne bouge pas.*
  Mais la vérification de la **cause**, faite ce passage, rend trois faits :

  ```
  ExecStart=/opt/vizyo-verify/deploy/vps/backup.sh     ← toujours le script EN DIRECT
  OnFailure=                                            ← ABSENT
  -rwxrwxr-x  backup.sh  (Aug 12 07:10)                 ← le bit +x, qu un scp -r sans -p reperdra
  ```

  🆕 **ET LA MÊME QUESTION, POSÉE POUR LA PREMIÈRE FOIS À `tracky-backup`, REND LE MÊME
  RÉSULTAT** : `ExecStart=/opt/vizyo-tracky/deploy/vps/backup-db.sh`, **aucun `OnFailure=`**.
  *C'est la sauvegarde de `tracky_prod` — 5,7 Go, 41 copies, la base de production principale —
  et son échec n'alerte personne non plus.* Le constat ne portait que sur Vizyo Verify depuis le
  2026-08-06 ; **il porte en réalité sur les deux unités de sauvegarde de la machine.**

  **Conséquence chiffrée, inchangée et désormais doublée** : la collecte tourne à 02 h 2x, les
  timers à 03 h 02 et 03 h 30 — le délai de détection d'un échec reste **~23 h par construction**,
  pour **les deux** sauvegardes.
  ⚠️ **À ne pas faire** : décaler l'audit après 04 h. Ça déplacerait l'aveuglement et ferait
  tomber la collecte dans la fenêtre des sauvegardes — VPS-003 recréé. **Le correctif reste
  `OnFailure=`**, à poser sur les deux unités.
- **Vu** : 2026-08-20 · **Mesure du jour** : unité au vert (`✅ dernier résultat : succès`, **2026-08-19 à 03 h 30 min 20**), **20 archives, 20 chiffrées / 0 en clair**, dossier `700`, copie hors-site à jour (21 h). **Le timer a réussi NEUF nuits de suite.** La collecte est repassée à **02 h 21**, donc **avant** les timers de 03 h 04 et 03 h 31 : le rapport décrit de nouveau les sauvegardes de la **veille**, et le délai de détection d'un échec redevient **~23 h par construction**. ⚠️ Le 08-18 l'avait vu autrement **par accident** (collecte à 04 h 00) — il ne faut pas en conclure qu'il « suffit de décaler l'audit » : ce serait le faire tomber dans la fenêtre des sauvegardes. **Le correctif reste `OnFailure=`.** **La cause est intacte** : `ExecStart` pointe toujours le script directement. *(mesure du 2026-08-18, conservée ci-dessous.)*
- **Mesure du 2026-08-18, conservée** : unité au vert (`✅ dernier résultat : succès`, **2026-08-18 à 03 h 31 min 10**), **18 archives, 18 chiffrées / 0 en clair**, dossier `700`, copie hors-site à jour (19 h). **Le timer a réussi SEPT nuits de suite.** ✅ **ET POUR LA PREMIÈRE FOIS L'AUDIT RAPPORTE LES SAUVEGARDES DE LA NUIT MÊME**, non celles de la veille : la collecte est passée à **04 h 00**, donc **après** les deux timers (03 h 02 min 56 et 03 h 30 min 56). Le délai de détection ~23 h **n'est pas corrigé pour autant** — il l'a été par accident, parce que deux collectes ont été perdues sur VPS-M43. ⚠️ **À ne pas en tirer la conclusion « il suffit de décaler l'audit »** : ce serait déplacer l'aveuglement et faire tomber la collecte dans la fenêtre des sauvegardes. Le correctif reste `OnFailure=`. **La cause est intacte** : `ExecStart` pointe toujours le script directement. *(mesure du 2026-08-17, conservée ci-dessous.)*
- **Mesure du 2026-08-17, conservée** : unité au vert (`✅ dernier résultat : succès`, 08-16 à 03 h 31 min 25), **14 archives, 14 chiffrées / 0 en clair**, dossier `700`, copie hors-site à jour. **Le timer a désormais réussi CINQ nuits de suite** (08-13 → 08-16, `LastTriggerUSec` = Sun 2026-08-16 03 h 31 min 18). **La cause reste intacte, 100 % du constat restant** : `ExecStart` pointe toujours le script directement, et le prochain `scp -r` sans `-p` reperdra le bit d'exécution. La contrainte d'horaire est reconduite à la minute près : collecte à **02 h 22 min 30**, timers à **03 h 02 min 13** et **03 h 31 min 40** → **délai de détection d'un échec ≈ 23 h, par construction**. *(mesure du 2026-08-16, conservée ci-dessous.)*
- **Mesure du 2026-08-16, conservée** : unité au vert (`✅ dernier résultat : succès`, 08-15 à 03 h 31 min 01), **12 archives, 12 chiffrées / 0 en clair**, dossier `700`, copie hors-site à jour. **Le timer avait réussi QUATRE nuits de suite** (08-13, 08-14, 08-15, et `LastTriggerUSec` = Sat 2026-08-15 03 h 30 min 56). **La cause reste intacte** : `ExecStart` pointe toujours le script directement, et le prochain `scp -r` sans `-p` reperdra le bit d'exécution. La contrainte d'horaire est reconduite à la minute près : collecte à **02 h 21 min 59**, timers à **03 h 01** et **03 h 31** → **délai de détection d'un échec ≈ 23 h, par construction**. *(mesure du 2026-08-15, conservée ci-dessous.)*
- **Mesure du 2026-08-15, conservée** : unité au vert (08-14 à 03 h 31 min 35), 10 archives, **10 chiffrées / 0 en clair**, dossier `700`, copie hors-site à jour. **La cause reste intacte** : `ExecStart` pointe toujours le script directement. ⚠️ **ET CE PASSAGE ÉTABLIT UNE CONTRAINTE QUE PERSONNE N'AVAIT ÉCRITE** : la collecte tourne à **02 h 21**, les deux timers de sauvegarde à **03 h 02** et **03 h 30** — l'audit rapporte donc **structurellement celles de la VEILLE**, et 02 h 21 est l'heure **normale** (7 des 8 collectes archivées démarrent entre 02 h 21 et 02 h 22). Le rapport du 08-14 n'a pu écrire « les deux sauvegardes ont réussi cette nuit » que parce que ce passage-là avait démarré à 04 h 08 — une exception. **Conséquence chiffrée : le délai de détection d'un échec de sauvegarde est d'environ 23 heures, PAR CONSTRUCTION.** ⚠️ **À NE PAS FAIRE : décaler l'audit après 04 h.** Ça déplacerait l'aveuglement sans le supprimer, et ça ferait tomber la collecte dans la fenêtre des sauvegardes — deux `pg_dump` et un audit sur 2 vCPU, soit le défaut VPS-003 recréé sous une autre forme. Le correctif est `OnFailure=`, pas un changement d'horaire. *(mesure du 2026-08-14, conservée ci-dessous.)*
- **Mesure du 2026-08-14, conservée** : **le timer a produit la sauvegarde deux nuits de suite** — 08-13 à 03 h 31 min 47 et 08-14 à 03 h 31 min 27, avec `LastTriggerUSec` coïncidant à la seconde. **Mais `backup.sh` est toujours un `-rwxrwxr-x` daté du 08-12.**

> ### ✅ 2026-08-14 — le test écrit d'avance est tranché, et dans le BON sens
>
> Le rapport du 2026-08-13 posait le critère avant d'avoir la réponse : *« si `journalctl` montre
> une réussite à 03 h 30 → le chemin automatique est prouvé pour la première fois, et VPS-015
> passe en `APPLIQUE` sur son volet symptôme ; s'il montre un `203/EXEC` → on est revenu au
> jour 1. »*
>
> ```
> Aug 13 03:31:47  Starting vizyo-verify-backup.service...
> Aug 13 03:31:53  OK — base 12K + 13 fichiers 5.3M, verifiees (5s)
> Aug 14 03:31:27  Starting vizyo-verify-backup.service...
> Aug 14 03:31:35  OK — base 12K + 13 fichiers 5.3M, verifiees (8s)
> ```
>
> ```
> LastTriggerUSec = Fri 2026-08-14 03:31:27 UTC     ← le TIMER, a la seconde du demarrage
> ```
>
> **C'est bien le timer, et pas une main** : `LastTriggerUSec` coïncide à la seconde avec le
> `Starting` du service. **Deux nuits consécutives.** Le chemin automatique est prouvé pour la
> première fois depuis la création de l'unité. Volet symptôme → `APPLIQUE`.
>
> ⚠️ **Et la réussite du 08-13 avait déjà eu lieu quand le rapport du 08-13 a écrit « le timer
> n'a JAMAIS réussi ».** L'échéance était à 03 h 31 min 47 et la collecte à 02 h 21 : le rapport
> a été écrit **70 minutes trop tôt** pour la voir. Il n'a rien affirmé de faux — il a
> explicitement daté son critère à *« 1 h 05 après cette collecte »* — mais c'est un rappel utile :
> **une échéance qui tombe après la collecte n'est pas dans la collecte.**
>
> ### ⚠️ Le volet CAUSE n'a pas bougé d'un octet, et c'est tout ce qui reste
>
> ```
> -rwxrwxr-x 1 root root  /opt/vizyo-verify/deploy/vps/backup.sh   contenu = 2026-08-12 07:10:16
> ```
>
> Le bit d'exécution vient du **redéploiement du 08-12**, pas d'un correctif. Le point 3 —
> `ExecStart=/bin/bash …`, qui retire au bit d'exécution son statut de condition de survie —
> **n'a pas été appliqué**. Le prochain `scp -r` sans `-p` reproduira le 5 août à l'identique.
>
> **Ce que ces deux nuits prouvent exactement** : que le chemin automatique fonctionne **quand le
> bit est là**. Elles ne prouvent rien sur ce qui arrive quand il ne l'est pas — et c'est
> précisément l'événement dont on sait qu'il se produit. *Fermer un symptôme n'est pas fermer sa
> cause*, et cette fiche est désormais le cas d'école : son symptôme s'est refermé deux fois par
> accident, jamais par correction.
>
> ### Mesure du 2026-08-13, conservée
>
> **Une archive existe enfin** (2026-08-12 07 h 10 min 31, chiffrée, relue, 19 h) — **mais produite
> par un redéploiement, pas par le correctif du plan, et le timer n'avait à cette date JAMAIS
> réussi** (dernière exécution connue du timer : 2026-08-12 03 h 30 min 56, `203/EXEC`).

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

- **Domaine** : docker · **Gravité** : 1 · **Statut** : ✅ **`APPLIQUE` — 4e OCCURRENCE CLOSE le 2026-08-20 à 05 h 08 min 14, sans aucune interruption · ⚠️ MAIS LA PREMIÈRE REMÉDIATION A ÉCHOUÉ (VPS-M51)**
- **Durée de la 4e occurrence** : **2026-08-20 01 h 13 min 57 → 05 h 08 min 14 — 3 h 54.**
- ✅ **Vu : 2026-08-26 — 9ᵉ JOUR ETEINT, ET LE CHIFFRE S'AMELIORE ENCORE.** `dockerd` **0,3 %** en instantane ; cumul **232,4 h / 508,8 h**. Continuite : **+0,4 h de CPU en 23,9 h ecoulees = 1,7 % d'un cœur** (fourchette **1,3 a 2,1 %**, les deux cumuls etant arrondis au dixieme d'heure) — contre 3,7 % la veille, **le plus bas depuis la cloture**. **0 client docker bloque** sur un denominateur de 0, et **0 connexion ETABLIE** sur `/run/docker.sock` (3 sondages sur 1,1 s). ⚠️ `live-restore: true` est desormais actif dans `daemon.json` : un `systemctl restart docker` ne couterait plus les ~50 s d'interruption qui ont bloque ce point huit passages durant.
- **Vu** : 2026-08-21 · **Mesure du jour** : `dockerd` **0,7 %**, **0 client Docker bloqué** sur un dénominateur de **0 processus client**, cumul **229,2 h / 391,0 h**. Le delta de cumul (**+3,5 h de CPU en 26,2 h écoulées**) s'explique entièrement par la fin de la boucle d'hier (2 h 47 restantes à ~100 %) plus le fond habituel : **rien d'inexpliqué, aucune 5e occurrence.**

> ### ✅ 2026-08-21 — LE GARDE-FOU A TENU SA PREMIÈRE NUIT RÉELLE, ET LA PRÉCONDITION EST VÉRIFIÉE
>
> Le 08-20, la 4e occurrence a été **causée par l'audit du centre d'alerte**. Le jour même, un
> `timeout` et un `--tail 2000` ont été posés dans sa procédure **et** dans son `SKILL.md`. La nuit
> du 08-20 au 08-21 était donc **la première exécution réelle du correctif**.
>
> **La précondition d'abord** — sans elle, « rien ne s'est passé » ne prouve rien (leçon VPS-M41) :
>
> ```
> 2026-08-21T01:02:21  Accepted publickey for root from 82.67.153.51
> 2026-08-21T01:52:37  Accepted publickey for root from 82.67.153.51
>   → 7 sessions dans la fenetre 01 h 02 → 01 h 52 : l audit du centre d alerte A TOURNE
> ```
>
> **Le résultat, sur la même tranche horaire qu'hier :**
>
> | Tranche UTC | **08-21 %idle** | 08-20 %idle |
> |---|---:|---:|
> | 01:00 | **90,05** | 90,48 |
> | 01:10 | **88,90** | 90,51 |
> | 01:20 | **89,67** | **56,90** ← bascule |
> | 01:30 | **89,65** | 37,83 |
> | 01:50 | **89,93** | ~40 |
>
> **Plat.** Là où le 08-20 s'effondrait de 90,5 % à 38 % et n'en revenait jamais, le 08-21 ne bouge
> pas d'un point et demi. Et le détecteur — celui qui avait publié « ✅ aucun client orphelin » à
> tort (VPS-M49) — trouve **0 client sur un dénominateur de 0**, le seul « rien » qui se démontre.
>
> ⚠️ **Ce que ce résultat vaut, et ce qu'il ne vaut pas.** Il établit qu'**une** nuit d'un **seul**
> dispositif est passée sans rallumer la boucle, correctif en place. **Il ne ferme pas la classe** :
> VPS-M52 a démontré qu'aucun réglage global ne borne un client Docker, donc la couverture reste
> **par convention**, écrite dans trois fichiers. *Le quatrième dispositif, celui que personne n'a
> encore écrit, n'est protégé par rien.*

> ### ✅ 2026-08-20, 05 h 08 — CLOSE, ET LA PREMIÈRE TENTATIVE N'A RIEN DONNÉ
>
> | Heure UTC | Action | `dockerd` | `read()`/s |
> |---|---|---:|---:|
> | 05 h 02 min 55 | ❌ `kill 43987` — **le client seul** | **100,3 %** | **1 359 294** |
> | 05 h 08 min 14 | ✅ `kill 43986 370554 370555` — **le parent d'abord** | **1,4 %** | **3** |
> | 05 h 09 | confirmation | **0,8 %** | — |
>
> **Pourquoi le premier `kill` a échoué** : le `bash -c` parent contenait **deux** `docker logs`,
> pas un — le second dans une substitution de commande (`L=$(docker logs … --tail 200000)`). En
> tuant le premier, `bash` a exécuté le suivant : le remplaçant est né à **05 h 02 min 55, la
> seconde exacte du `kill`**. **La boucle n'a pas été interrompue, elle a été transmise.**
>
> **Ce que la production a vu** : rien. 33/33 conteneurs, 0 anomalie, PID 913 inchangé, 62 threads,
> les quatre points publics en **97 · 39 · 158 · 75 ms**, charge 1,60 → 0,80. **Deux occurrences
> fermées sans une seconde d'indisponibilité, et `systemctl restart docker` n'a été nécessaire
> ni le 08-18 ni aujourd'hui.**
>
> ### ⚠️ LA REMÉDIATION DE CETTE FICHE ÉTAIT INCOMPLÈTE — voir VPS-M51
>
> Elle disait : *« la remédiation est `kill <pid>` sur ces clients »*. **Vrai quand le parent est
> mort, faux quand il est vivant** — et le 08-18 les deux parents étaient morts, donc rien ne
> distinguait les deux cas.
>
> **La règle, réécrite pour être appliquée sans refaire l'enquête** :
> 1. lister les clients bloqués **avec leur chaîne de parents complète**, pas seulement le PID ;
> 2. parent = `init` (PPID 1) → `kill` le client suffit ;
> 3. **parent vivant → `kill` LE PARENT D'ABORD**, puis les descendants ;
> 4. vérifier en sortie : `pgrep -xc docker` = **0** et `dockerd` sous 5 %.
>
> ⚠️ **Ne pas `kill -9` d'emblée** : un `SIGTERM` a suffi sur les quatre processus.
- **Vu** : 2026-08-20 · **Mesure du jour** : `dockerd` à **101,7 %** d'un cœur, **1 038 542 `read()`/s pour 0,0000 octet**, PID **913 inchangé**, **62 threads**. Cumul **225,7 h / 364,8 h**. **Continuité sur la fenêtre de 24 h : 8,8 %** — et c'est ce chiffre bas qui prouve que la boucle est **récente**.
- **Durée totale de la 3e occurrence** : du **2026-08-11 à 21 h 01** au **2026-08-18 à 05 h 47** — **152 h 46**, dont 20 h 30 en second régime.

> ### 🔴🔴 2026-08-20 — 4e OCCURRENCE, DÉBUT DATÉ À LA SECONDE, ET LE CLIENT VIENT DE L'AUDIT
>
> **Début : 2026-08-20 à 01 h 13 min 57 UTC.** Deux méthodes indépendantes convergent :
>
> | Méthode | Résultat |
> |---|---|
> | Arithmétique du cumul (2,1 h de CPU en 23,85 h, fond 3,6 %, régime 101,7 %) | début vers **01 h 06**, fourchette 00 h 53 – 01 h 15 |
> | `sar -u` en tranches de 10 min | `idle` **90,51 → 56,90 → 37,83** : bascule **dans** la tranche 01 h 10 min 20 → 01 h 20 min 20, soit **≈ 01 h 14** |
> | `ps -o lstart` du seul client Docker de la machine | **01 h 13 min 57** |
>
> ```
> 43987  docker logs tracky-postgres --tail 200000     Sl  futex_wait_queue  TIME 00:00:00
> 43986  bash -c "docker logs … | grep -i 'delete from…|truncate|DROP TABLE' | tail -20"
> 43921  sshd: root@notty                              canal SSH encore ESTABLISHED
> ```
>
> **Le client consomme 0 seconde de processeur pendant que le démon en brûle un.**
>
> ### ⚠️⚠️ CE QUI CHANGE LE MÉCANISME : LE PARENT EST VIVANT
>
> | | 3e occurrence (08-11) | **4e occurrence (08-20)** |
> |---|---|---|
> | Shell parent | **mort**, adopté par init | **vivant** |
> | Canal SSH | disparu | **encore établi** |
> | PPID du client | **1** | **43986** |
> | Ce qu'a dit le détecteur posé le 08-18 | (n'existait pas) | **« ✅ aucun client orphelin »** |
>
> Le détecteur filtrait sur `PPID == 1`. **« Parent mort » était la forme qu'avait prise la
> 3e occurrence, pas la condition du défaut.** On avait codé le symptôme observé une fois, pas le
> phénomène. Corrigé le jour même : le discriminant est l'**âge** (un client `docker` en ligne de
> commande rend la main en moins d'une seconde). Voir **VPS-M49**.
>
> ### 🔴 Et le client vient du DISPOSITIF D'AUDIT lui-même
>
> Le rapport du **centre d'alerte** du 2026-08-20 déclare sa fenêtre de collecte :
> *« 2026-08-20 01 h 11 → 01 h 30 UTC »*. Le client démarre à **01 h 13 min 57**, dedans, avec un
> motif (`delete from`, `truncate`, `DROP TABLE`) qui correspond exactement à son enquête sur les
> 41 709 alertes effacées.
>
> **VPS-M12, écrite le 2026-08-05** : *« une commande envoyée à un démon ne doit pas être
> interrompue en cours de route — le client meurt, le travail côté serveur, non. »* Quinze jours,
> statut `APPLIQUE`, elle a servi à **trouver** la cause de la 3e occurrence — et un **autre agent
> du même dispositif**, qui ne lit pas ce référentiel, vient de la violer.
>
> ### Les quatre occurrences
>
> | Occurrence | Début | Fin | Durée | Client | Parent |
> |---|---|---|---|---|---|
> | 1 — 2026-08-05 | ~02 h 23 | 08-06 ~13 h 00 | 34 h 40 | non identifié | — |
> | 2 — 2026-08-10 | ~01 h 15 | ~14 h 45 | ~13 h 30 | non identifié | — |
> | 3 — 2026-08-11 | 21 h 01 | 08-18 05 h 47 | **152 h 46** | `docker logs` ×2 | **mort** |
> | **4 — 2026-08-20** | **01 h 13 min 57** | **05 h 08 min 14** | **3 h 54** | `docker logs` ×1 (puis son clone) | **vivant** |
>
> **Trois clients sur trois identifiés sont des `docker logs` lancés en diagnostic par SSH.** Ce
> n'est plus un accident, c'est une **classe**.
>
> ### 🔴 2026-08-20 — RÉTRO-ATTRIBUTION DE L'OCCURRENCE 2, et elle désigne le même audit
>
> En posant le garde-fou dans la procédure du centre d'alerte, son propre rapport du **2026-08-10**
> a livré ceci, en toutes lettres :
>
> > *« `docker logs texto-relay` **ne rend jamais la main** sur cet hôte (deux tentatives, **150 s
> > et 120 s**) »* — `docs/centre-alerte/rapports/2026-08-10.md`, ligne 160
>
> | Fait | Source |
> |---|---|
> | Fenêtre de collecte du centre d'alerte le 08-10 | **01 h 10 → 01 h 35 UTC** (en-tête du rapport) |
> | Début de l'**occurrence 2** de VPS-016 | **~01 h 15 UTC** (`sar`, établi le 2026-08-10) |
> | Deux `docker logs` qui ne rendent pas la main | **150 s et 120 s**, dans cette fenêtre |
>
> **C'est la signature de l'occurrence 4, dix jours plus tôt** : même audit, même heure, même
> famille de commande, et le début de la boucle **à l'intérieur** de la fenêtre de collecte.
>
> ⚠️ **Ce qui n'est PAS établi, et ne le sera jamais** : que ces deux clients aient survécu à leur
> session SSH et tenu le démon. Les journaux qui le diraient sont rotés depuis longtemps. *C'est
> une rétro-attribution solide, pas une preuve* — et elle est écrite avec cette réserve plutôt que
> passée sous silence, parce qu'elle change le classement du risque.
>
> ### Ce que le tableau des quatre occurrences devient
>
> | Occurrence | Déclencheur probable | Confiance |
> |---|---|---|
> | 1 — 2026-08-05 ~02 h 23 | **l'audit VPS lui-même** — `docker system df -v` interrompu, `dockerd` journalise `error reading preface from client` juste avant | **hypothèse** (VPS-M12 : *« on ne sait pas si c'est la cause, mais on cesse de la produire »*) |
> | 2 — 2026-08-10 ~01 h 15 | **l'audit du centre d'alerte** — 2 `docker logs` de 150 s et 120 s dans sa fenêtre | **forte, non prouvée** (journaux rotés) |
> | 3 — 2026-08-11 21 h 01 | diagnostics SSH manuels — 2 `docker logs` orphelins | **établie** (vidage de goroutines + inode de socket) |
> | **4 — 2026-08-20 01 h 13 min 57** | **l'audit du centre d'alerte** — `docker logs … --tail 200000` | **établie à la seconde** |
>
> > **La conclusion qui compte** : *sur quatre occurrences, trois désignent notre propre outillage,
> > et deux le même audit.* On a cherché treize jours une cause dans le démon. **Elle était dans
> > nos procédures**, et la règle qui l'interdit (VPS-M12) était écrite dès la première.
> > **Un incident dont l'outil de diagnostic est la cause se renouvelle à chaque diagnostic.**
>
> ### La remédiation — écrite ici à 02 h 30, ❌ RÉFUTÉE À L'EXÉCUTION À 05 h 02
>
> ⚠️ **Ce qui suit était faux sur son gain**, et l'encadré de clôture ci-dessus le corrige.
> Conservé : un raisonnement erroné ne se supprime pas, il s'explique.
>
> `kill 43987` — **2 secondes, aucune coupure, aucun conteneur touché**, gain ~50 % de la machine.
> ⚠️ Vérifier le PID d'abord : il n'est valable que pour cette collecte.
> ⚠️ **NE PAS `systemctl restart docker`** : le 08-18 a prouvé que le `kill` suffit, et le
> redémarrage coûte ~50 s sur 25 domaines **et efface l'état qui prouve la cause**.
> ⚠️ **Fenêtre périssable** : les occurrences 1 et 2 se sont refermées seules. Si celle-ci s'arrête
> avant qu'on agisse, on perd la seule occasion de vérifier que le `kill` d'un client **au parent
> vivant** produit le même effet que celui d'un orphelin — et il ne faudra **pas** lire cet arrêt
> comme une confirmation du `kill` (VPS-M41).
>
> ### Seuil de réescalade, réécrit une seconde fois
>
> Rouvrir si `dockerd` repasse **au-dessus de 50 % d'un cœur en instantané**. La première chose à
> regarder est la section **« Clients docker BLOQUÉS »** du collecteur — qui ne demande plus qu'un
> parent soit mort — puis `kill` sur ce qu'elle nomme. ⚠️ **Si elle est vide, ne pas conclure qu'il
> n'y a pas de client** : elle ne voit que les processus nommés exactement `docker`. Croiser alors
> `ss -xp` sur `/run/docker.sock` avant de sortir le `kill -USR1`.

> ### ✅ 2026-08-19 — LA PREUVE À 24 H, ET ELLE EST ARITHMÉTIQUE
>
> Un jour après le `kill`, PID **913 inchangé** (`lstart` = 2026-08-04 21 h 32 min 45). Les deux
> bornes viennent de la **même ligne du collecteur**, à deux jours d'intervalle — pas de mélange
> de sources :
>
> ```
> 08-18 04:00:34   cumul 220.3 h CPU / 318.5 h uptime
> 08-19 02:31:03   cumul 223.6 h CPU / 341.0 h uptime
> ```
>
> **Δuptime = 22,50 h** (exact — les horodatages donnent 22 h 30 min 29). **Δcumul = 3,3 h**, à
> **±0,2 h** près : les deux cumuls sont arrondis au dixième d'heure, et cette imprécision se
> propage. Si la coupure de 05 h 47 est bien la cause, la fenêtre se décompose en deux régimes :
>
> | Tranche | Durée | Régime | Processeur |
> |---|---:|---:|---:|
> | 04 h 00 min 34 → 05 h 47 (boucle active) | 1,77 h | 144,4 % | **2,56 h** |
> | 05 h 47 → 02 h 31 (après le `kill`) | 20,73 h | **3,6 %** | **0,74 h** |
> | **Total** | **22,50 h** | — | **3,3 h** = la mesure |
>
> **Facteur ~40 entre les deux régimes**, et la fourchette d'arrondi (**2,6 – 4,5 %** d'un cœur)
> ne la remet pas en cause. Le résidu de 0,74 h est la consommation normale d'un démon servant
> 33 conteneurs et 65 sondes/minute. Ce n'est plus une corrélation : c'est un bilan qui se ferme.
>
> **Contre-mesure indépendante, plus précise** : `ps -o time -p 913` à 02 h 25 donne
> `9-07:38:22`, soit **223,64 h** — cohérent avec le 223,6 arrondi du collecteur, et obtenu
> autrement. *Deux instruments, même valeur.*
>
> **Confirmations indépendantes** : `%idle` machine **84,02 %** (contre 19,54 le 08-17) ·
> **0 client `docker` orphelin**, dénominateur affiché · les 4 points publics **sous 60 ms**
> (27 à 32 ms contre 83 à 210 le 08-18) · PSI mémoire `full` retombée à **0,00** ·
> `kcompactd0` disparu de la tête des processus de l'hôte.
>
> ### ⚠️ Ce que la clôture a révélé de PLUS grave que l'incident : voir VPS-M48
>
> L'inactivité du 2026-08-11 — la journée où la boucle a commencé, à 21 h 01 — vaut **77,66 %**.
> Celle des cinq passages suivants, ~37 %. **La boucle confisquait ~45 points d'inactivité,
> près de la moitié de la machine, et l'audit décrivait cet état comme le fond de référence** :
> sa fenêtre de 7 jours glissait avec un incident de 7 jours. **VPS-M48.**
>
> ### ⚠️ Et le test écrit d'avance pour ce jour est SANS OBJET — ne pas le lire quand même
>
> Le 08-18 posait *« la continuité doit rester au-dessus de 130 % »*, **précondition : boucle en
> cours**. Elle vaut **14,7 %**. Lu au pied de la lettre, le test est réfuté ; lu correctement,
> **sa précondition a été détruite par le succès de la remédiation**. C'est **VPS-M41 dans sa
> forme la plus piégeuse** : *un test conditionné à la persistance d'un incident doit dire ce
> qu'on en fait quand l'incident cesse — sinon la réussite se présente comme une réfutation.*

> ### ✅✅✅ 2026-08-18, 05 h 47 — LA CAUSE EST TROUVÉE, ET C'ÉTAIENT DEUX PROCESSUS CLIENTS
>
> Le `kill -USR1 913`, **perdu huit fois**, a enfin été lancé. Le vidage (408 Ko, 488 goroutines)
> répond en trois lignes :
>
> | Ce que montre le vidage | Compte |
> |---|---:|
> | goroutines **`running`** | **1** — et c'est le vidage lui-même |
> | bloquées dans `daemon/internal/stream/**bytespipe**` | **66** |
> | **`httputils.WriteLogStream`** actives | **2** |
>
> **Rien ne tournait.** Les 170 % d'un cœur n'étaient pas du travail applicatif : c'était le démon
> qui tournait en rond à écrire vers **deux clients qui ne lisaient plus**. Retrouvés par l'inode
> de leur socket sur `/run/docker.sock` :
>
> ```
> pid  986774   docker logs --tail 40 --since 30m foodsqan-traefik   démarré 2026-08-11 21:01:20
> pid 3191099   docker logs texto-relay --tail 400                   démarré 2026-08-17 09:17:08
> ```
>
> ### ⚠️ Les deux dates tombent dans les deux fenêtres datées par `sar`, À LA MINUTE
>
> | Événement | Daté par `sar` | Client lancé à | Écart |
> |---|---|---|---|
> | Début de la 3e occurrence | 2026-08-11 **~21 h 05** | **21 h 01 min 20** | **< 4 min** |
> | Bascule du **second régime** | 2026-08-17 entre **09 h 10 et 09 h 30** | **09 h 17 min 08** | **dans la fenêtre** |
>
> **Deux événements indépendants, deux coïncidences exactes.** C'est ce qui transforme une
> corrélation en cause : une seule aurait pu être un hasard.
>
> ### La preuve par l'effet — `kill` sur deux PID, et rien d'autre
>
> | Mesure | Avant (05 h 44) | Après (05 h 50) |
> |---|---:|---:|
> | `dockerd` | **170,3 %** d'un cœur | **1,0 %** |
> | `read()` par seconde | **1 316 459** | **54** |
> | Octets ramenés par appel | **0,0000** | — |
> | Charge 1 min | **15,94** | **0,85** |
> | PSI mémoire `full` avg10 | 0,85 | **0,00** |
> | `WriteLogStream` actives | 2 | **0** |
> | **Conteneurs** | **33 / 33** | **33 / 33** |
>
> **Aucune coupure, aucun conteneur touché, PID du démon inchangé.** Le `systemctl restart docker`
> qui figurait au 4e rang du plan depuis huit passages — ~50 s d'interruption sur 25 domaines —
> **n'a pas été nécessaire**.
>
> ### ⚠️ Ni l'un ni l'autre n'avait `-f` : ils ne SUIVAIENT pas les journaux
>
> C'est le point qui explique pourquoi la piste a été manquée treize jours. On cherchait un
> *suiveur* de journal ; il n'y en avait pas. Les deux clients étaient bloqués **en écriture**,
> vers un canal SSH disparu : leurs shells parents (`bash -c …`, des diagnostics lancés par SSH)
> sont morts, les processus ont été **adoptés par `init`**, et le démon a continué de leur pousser
> des octets que personne ne lisait. Le `json.log` de `texto-relay` faisait **0 octet** — le
> descripteur pendait sur un fichier vidé par la rotation de minuit.
>
> ### ⚠️⚠️ Et la règle qui décrit exactement ça était écrite depuis le 2026-08-05
>
> **VPS-M12**, treize jours plus tôt :
>
> > *« Une commande envoyée à un démon ne doit pas être interrompue en cours de route — **le client
> > meurt, le travail côté serveur, non**. »*
>
> Elle a été écrite pour un `docker system df -v` interrompu, classée `APPLIQUE`, et **jamais
> appliquée à l'objet voisin** : personne n'a demandé *« reste-t-il des clients docker
> orphelins ? »*. La question coûtait un `pgrep`. Voir **VPS-M45**.
>
> ### Ce qui reste vrai des trois occurrences
>
> | Occurrence | Début | Fin | Durée | Fin par |
> |---|---|---|---|---|
> | 1 — 2026-08-05 | ~02 h 23 | 2026-08-06 ~13 h 00 | 34 h 40 | seule (client mort ?) |
> | 2 — 2026-08-10 | ~01 h 15 | ~14 h 45 | ~13 h 30 | seule (client mort ?) |
> | **3 — 2026-08-11** | **21 h 01** | **2026-08-18 05 h 47** | **152 h 46** | **`kill` sur 2 clients** |
>
> Les deux premières se sont arrêtées **seules** : très probablement parce que leur client a fini
> par mourir (délai TCP, `logrotate`, redémarrage du poste). ⚠️ **Ce n'est PAS établi** — les
> journaux qui le diraient sont rotés. Ce qui est établi, c'est le mécanisme de la troisième.
>
> ### Seuil de réescalade, réécrit
>
> Rouvrir si `dockerd` repasse **au-dessus de 50 % d'un cœur en instantané**. La **première** chose
> à regarder n'est plus le `wchan` ni les threads : c'est **la section « clients docker orphelins »
> du collecteur** (posée ce jour), puis `kill` sur ce qu'elle nomme. Le `kill -USR1` reste utile
> **si la liste est vide** — ce serait alors un mécanisme différent.
- **Vu** : 2026-08-18 · **Mesure du jour, AVANT remédiation** : `dockerd` à **80,3 %** d'un cœur en instantané (04 h 00), **170,3 %** à 05 h 44, et **52,5 % de la MACHINE** sur les 380 s de la collecte. PID **913 inchangé**, démarré `Tue Aug 4 21:32:45` (`ps` : `ELAPSED 13-06:35:01`, `TIME 9-04:28:20`). Cumul **220,47 h / 318,58 h = 69,2 %**. **62 threads** (42 la veille). ⚠️ **CONTINUITÉ : 37,08 h de processeur en 25,68 h écoulées = 144,4 %** — soit **72,2 % d'une machine à 2 vCPU, en moyenne, sur plus d'une journée.** *(mesure du 2026-08-17, conservée ci-dessous.)*

> ### 🔴🔴 2026-08-18 — LE CONSTAT PASSE EN GRAVITÉ 1 : UN SECOND RÉGIME, DATÉ À DIX MINUTES PRÈS
>
> La série des continuités fait **99,7 % → 100,0 % → 100,3 % → 144,4 %**. Le test écrit d'avance
> le 08-17 prévoyait ~**100,6 %** si la progression était linéaire. **Sa précondition est tenue**
> (PID 913 inchangé, boucle en cours — le bloc BUDGET mesure `dockerd` à 52,5 % de la machine sur
> la fenêtre de collecte), donc le résultat **se lit**, et il **réfute l'hypothèse de progression
> régulière** : ce n'est pas +0,3 point de plus, c'est **+44 points**.
>
> **`sar` date la bascule à dix minutes près, et c'est la mesure du jour :**
>
> | Tranche UTC (2026-08-17) | %user | %system | %idle |
> |---|---:|---:|---:|
> | 09:00:00 | 20,86 | 29,00 | **36,46** |
> | 09:10:27 | 20,62 | 28,97 | **36,98** |
> | **09:20:17** | **25,43** | **36,53** | **28,52** ← bascule |
> | **09:30:27** | **34,12** | **49,74** | **8,24** |
> | 09:40 → 23:00 | 32,3 – 36,2 | 43,6 – 52,9 | **2,4 – 8,5** |
>
> **L'inactivité passe de ~37 % à ~8 % entre 09 h 10 et 09 h 30, et n'est jamais revenue** — elle
> vaut 4,90 à 7,62 % ce matin, dix-neuf heures plus tard. La moyenne journalière le confirme :
> `%idle` fait 34,45 · 37,13 · 37,31 · 38,82 · 38,23 les cinq jours précédents, puis **19,54** le
> 08-17 et **6,75** le 08-18 partiel.
>
> ⚠️ **Ce n'est PAS une journée de build**, et c'est établi par trois faits : la veille (08-16) à
> **la même heure**, `sar` est plat à `idle` 38,1–38,8 ; les deux builds du 08-17 ont eu lieu à
> **15 h 47/15 h 51** et **22 h 05/23 h 16**, soit **six heures après** la bascule ; et le régime
> tient dans les heures **entre** les builds comme **après** eux.
>
> ⚠️ **Ce n'est PAS l'hyperviseur** : `%steal` vaut 13,37 % à 09 h 00 et **7,81 %** à 09 h 30 — il
> **baisse** pendant que notre consommation monte. Le temps consommé est **le nôtre**
> (`user` + `system` passent de ~50 % à ~84 %).
>
> ### ❌ La piste trouvée dans la fenêtre est RÉFUTÉE le jour même — et elle était séduisante
>
> Le journal ne contient **qu'un seul** événement dans la fenêtre de bascule, et il est spectaculaire :
>
> ```
> Aug 17 09:10:30 qemu-ga[3988652]: guest-file-open : /.hstgr-1786957830.scanner.py, mode: w
> Aug 17 09:10:30 qemu-ga[3988652]: guest-exec : timeout -s TERM -k 3660 3600 /bin/sh -c
>                                   trap 'rm /.hstgr-...' 0; /usr/bin/env python3 /.hstgr-....scanner.py
> ```
>
> L'hyperviseur écrit un script Python à la racine et l'exécute en root — **à la minute de la
> bascule**. Test de falsification lancé avant de conclure : *ce scanner est-il exceptionnel ?*
>
> **Non. Il tourne toutes les heures.** `journalctl -t qemu-ga` en garde **360 invocations depuis
> le 2026-08-11** (~50/jour), dont ~40 **avant** la bascule et 19 **depuis**. Un événement horaire
> ne peut pas expliquer une transition unique. **Hypothèse écartée** — mais elle a révélé VPS-027,
> qui vaut bien davantage.
>
> **Ce qui reste établi, et c'est tout** : la bascule est datée au 2026-08-17 entre 09 h 10 et
> 09 h 30 UTC, elle est à nous, elle dure, et **aucun événement connu ne l'explique**. Le journal
> de `dockerd` ne contient **aucune ligne** entre 08 h 00 et 10 h 00.
>
> ### ⏳ Le `kill -USR1` est perdu pour la HUITIÈME fois
>
> `Debug Mode = false`. La fenêtre dépasse désormais **151 heures** — les deux occurrences
> précédentes se sont refermées seules après 34 h et 13 h.
>
> > **Test écrit d'avance, avec sa précondition (VPS-M41)** : *si, au passage du 2026-08-19, le PID
> > est toujours **913** et la boucle en cours, la continuité doit rester **au-dessus de 130 %** —
> > le second régime est un palier, pas un pic. Si elle retombe entre 95 et 105 %, le 144 % du
> > 08-18 était une excursion et non un régime.*
> > **Précondition** : PID inchangé, boucle en cours, **et aucune session de build de plus de
> > 2 h dans la fenêtre** — sans quoi le chiffre mêle deux consommateurs et ne dit rien.
- **Mesure du 2026-08-17, conservée** : `dockerd` à **101,3 %** d'un cœur en instantané, **1 316 459 `read()`/s pour 0,0000 octet ramené par appel**, PID **913 inchangé** (`ps` : `ELAPSED 12-04:54:07`, `TIME 7-15:23:15`, jamais redémarré depuis le 2026-08-04). Cumul **183,4 h / 292,9 h = 62,6 %**. **42 threads — inchangé pour la 2e fois.**

> ### 🆕 2026-08-17 — LA BOUCLE A FRANCHI LE CŒUR PLEIN EN MOYENNE SUR 24 HEURES
>
> `ps -o etime,time` donne les deux grandeurs à la seconde près, deux jours de suite :
>
> ```
> 2026-08-16   ELAPSED 11-04:52:24   TIME 6-15:17:03    → 268,873 h / 159,284 h
> 2026-08-17   ELAPSED 12-04:54:07   TIME 7-15:23:15    → 292,902 h / 183,388 h
> ```
>
> **24,10 heures de processeur consommées en 24,03 heures écoulées, soit 100,3 %.** Sixième
> continuité établie par l'arithmétique seule, et **la première qui dépasse 100 %**. Sur un
> processus à **42 threads**, ça ne veut pas dire « un cœur épinglé » : la boucle **déborde par
> moments sur le second cœur**. Sur 2 vCPU, c'est **50,2 % de la machine, en moyenne, sur
> vingt-quatre heures pleines** — pas un pic, une moyenne.
>
> Les trois dernières continuités : **99,7 % → 100,0 % → 100,3 %.**
>
> ⚠️ **Trois points en progression régulière, et je refuse d'en faire une tendance** — c'est ce
> que VPS-008, VPS-024 et VPS-025 ont chacun coûté. La résolution de `ps` est la seconde, donc
> 0,3 % (≈ 4 min de CPU sur 24 h) est très au-dessus du bruit : **l'écart est réel**. Ce qui
> n'est pas établi, c'est qu'il **progresse**.
>
> > **Test écrit d'avance, AVEC sa précondition** (leçon VPS-M41, appliquée le jour même) :
> > *si, au passage du 2026-08-18, le PID est toujours **913** et la boucle toujours en cours, le
> > ratio doit valoir ~**100,6 %**. S'il retombe sous 100 %, la progression n'existe pas et les
> > trois points sont du bruit d'échantillonnage.*
> > **Précondition : PID inchangé ET boucle en cours.** Si `dockerd` redémarre — volontairement
> > ou non — ce test ne dit **rien**, et il ne faut pas lire son résultat.
>
> `sar` confirme indépendamment et à plat : **21,31 / 30,71** puis **21,56 / 31,17** % user/système
> sur les deux tranches de 02 h 00 à 02 h 20 — le profil exact des journées du 08-12 au 08-16.
> Sept jours, même signature, à la décimale.
>
> ### ❌ L'hypothèse `fstrim` est CLOSE — mais pas par le test qui devait la trancher
>
> Le rapport du 2026-08-10 datait sa falsification au *« lundi 2026-08-17 à 01 h 38 UTC »*.
> `fstrim` a tourné ce matin à **00 h 38 min 27 → 00 h 38 min 56**, **40,6 Gio découpés**, et `sar`
> est parfaitement plat autour (37,93 → **36,61** → 39,72 % d'inactivité).
>
> **Ça ne réfute rien : on ne teste pas un DÉCLENCHEUR sur une machine déjà déclenchée.** Et
> l'hypothèse était **déjà morte depuis le 2026-08-12** : `fstrim.timer` est hebdomadaire **le
> lundi**, or l'occurrence 1 a démarré un **mercredi** (08-05) et l'occurrence 3 un **mardi**
> (08-11) — 2 sur 3 incompatibles. Voir **VPS-M41**.
>
> ✅ **Fait neuf qui, lui, vaut** : `fstrim` **n'ARRÊTE pas** la boucle. 40,6 Gio découpés sur le
> système de fichiers du démon, en 29 secondes, sans un creux. Cette moitié-là n'avait jamais été
> testée. **Quatrième piste fermée** sur ce constat, après `texto-relay`, le temps volé par
> l'hyperviseur et la fenêtre 13 h–15 h.
- **Mesure du 2026-08-16, conservée** : `dockerd` à **99,3 %** d'un cœur — soit **50 % d'une machine à 2 vCPU, en permanence** —, **1 053 542 `read()`/s pour 0,0000 octet ramené par appel**, PID **913 inchangé** (`ps` : `ELAPSED 11-04:52:24`, `TIME 6-15:17:03`, jamais redémarré depuis le 2026-08-04). Cumul **159,3 h / 268,8 h = 59,2 %**. **42 threads — inchangé pour la première fois** (42 le 08-15, 33 le 08-14, 37 le 08-13, 47 le 08-12, 27 le 08-10), dont **`tid=156485` pour la SIXIÈME fois**. **Continuité établie pour la CINQUIÈME fois consécutive par l'arithmétique seule, et elle est parfaite : 159,28 − 135,40 = 23,88 h de processeur en 23,87 h écoulées = 100,0 %.**

> ### ⚠️⚠️ 2026-08-16 — LE `wchan` NE PROUVE RIEN, ET IL FAUT LE CORRIGER ICI AUSSI
>
> La ligne du 2026-08-15 ci-dessous présente *« la répartition sur les 42 threads donne 33
> `futex_wait_queue` (79 %) »* comme ce qui **lève** le doute de VPS-M36. **Ce raisonnement est
> faux**, et le cas témoin le montre : `containerd`, démon **parfaitement sain** à 0,3 % d'un cœur
> et 2,9 h de CPU cumulé, affiche **13 threads sur 14 en `futex_wait_queue`, soit 93 %** — plus
> que `dockerd`. Un runtime Go **au repos** gare ses threads dans un futex. Voir **VPS-M40**.
>
> **La conclusion « emballement de l'ordonnanceur Go » reste vraie**, mais elle n'a JAMAIS tenu au
> `wchan` : elle tient au **CPU**, et le premier énoncé de ce constat le disait déjà
> (*« un thread bloqué en `futex_wait_queue` **avec des heures de CPU cumulé** »*, 2026-08-12).
> C'est la seconde moitié de la phrase qui portait tout le poids, et elle s'est perdue en route.
>
> | | `dockerd` | `containerd` (témoin sain) |
> |---|---:|---:|
> | `wchan` majoritaire | 79 % futex | **93 % futex** |
> | CPU **maintenant** | **99,3 %** d'un cœur | **0,3 %** |
> | CPU **cumulé / uptime** | **159,3 h / 268,8 h = 59,2 %** | **2,9 h / 268,8 h = 1,1 %** |
>
> **Seules les deux dernières lignes discriminent.** Le collecteur imprime désormais la
> répartition de `containerd` à côté de celle de `dockerd`, sans verdict, en permanence.
- **Mesure du 2026-08-15, conservée** : `dockerd` à **99,0 %**, **1 330 933 `read()`/s**, cumul **135,4 h / 245,0 h = 55,2 %**, **42 threads**, `tid=156485` pour la 5e fois. *(La lecture du `wchan` faite ce jour-là est rectifiée ci-dessus.)*

> ### 🔴 2026-08-15 — 77 h 30, sixième journée, cinquième `kill -USR1` perdu
>
> **135,36 − 113,0 = 22,36 heures de processeur consommées en 22,42 heures écoulées, soit 99,7 %.**
> **Quatrième** passage consécutif où l'arithmétique seule établit la continuité, sans un creux.
>
> `sar` le confirme indépendamment et à plat : de 01 h 00 à 02 h 20, **21,7 à 22,7 % user et 31,5 à
> 32,7 % système sur neuf tranches consécutives** — le profil exact du 08-12 (22,27 / 30,89), du
> 08-13 (21,79 / 30,81) et du 08-14 (22,36 / 31,30).
>
> ⚠️ **Le nombre de threads ne veut rien dire** : 27 → 47 → 37 → 33 → **42**. Il oscille sans
> tendance sur cinq mesures. Ne pas le lire comme un indicateur de gravité — c'est le genre de
> série où l'on finit par voir une aggravation qui n'existe pas.
>
> ### Ce que ça ne coûte PAS, et il faut le dire
>
> La production répond : app-tracky **200 en 82 ms**, `/api/health` **200 en 66 ms**,
> `tracky.vizyoagency.com` **200 en 89 ms**, app-verify **302 en 299 ms**. Aucun conteneur n'est
> tombé, **0 OOM**, PSI `full` = **0,00** sur le processeur, et le swap **redescend**. C'est le
> processeur qui manque, pas la mémoire — sixième journée, et VPS-005 en tire la conséquence.
>
> ### Mesure du 2026-08-14, conservée
>
> `dockerd` à **99,7 %**, **1 236 156 `read()`/s pour 0,0000 octet**, cumul **113,0 h / 222,6 h =
> 50,8 %**, **33 threads**.

> ### 🔴 2026-08-14 — cinquième journée, 55 heures, et le `kill -USR1` perdu une QUATRIÈME fois
>
> **113,0 − 87,3 = 25,7 heures de processeur consommées en 25,8 heures écoulées.** Troisième
> passage consécutif où l'arithmétique seule établit la continuité, sans le moindre creux.
> Début daté entre 21 h 00 et 21 h 10 UTC le 2026-08-11 : **≥ 55 h 05 au moment de la collecte.**
>
> | Occurrence | Début | Fin | Durée |
> |---|---|---|---|
> | 1 — 2026-08-05 | ~02 h 23 | 2026-08-06 ~13 h 00 | 34 h 40 |
> | 2 — 2026-08-10 | ~01 h 15 | 2026-08-10 ~14 h 45 | ~13 h 30 |
> | **3 — 2026-08-11** | **~21 h 05** | **toujours en cours** | **≥ 55 h 05** |
>
> `sar` le confirme indépendamment : de 02 h 30 à 04 h 10 ce matin, **21,x % user / 31,x % système
> sans une variation**, exactement le profil des journées du 08-12 (22,27 / 30,89) et du 08-13
> (21,79 / 30,81).
>
> ### ⚠️ FAIT NEUF — le `wchan` du même thread donne DEUX réponses en six minutes
>
> | Échantillon | `tid=156485` |
> |---|---|
> | 04:09 (collecte) | **`wait_for_partner`** |
> | 04:15 (vérification) | `futex_wait_queue` |
> | 04:22 (vérification) | `futex_wait_queue` |
>
> Répartition des 33 threads au troisième échantillon : **23 `futex_wait_queue`, 6 `do_wait`,
> 2 « 0 », 1 `folio_wait_bit_common`, 1 `ep_poll`.**
>
> **Le collecteur ne prend qu'UN échantillon.** La conclusion « emballement de l'ordonnanceur Go »
> n'est pas remise en cause — 23 threads sur 33 en `futex_wait_queue` la portent largement — mais
> elle tenait jusqu'ici sur **trois lignes** qui pouvaient chacune être un tirage malheureux.
> C'est **VPS-M36**.
>
> ### ⚠️ La collecte reproduit, à chaque passage, la ligne de VPS-M12
>
> ```
> Aug 14 04:13:54  dockerd[913]: http2: server: error reading preface from client @:
>                  read unix /run/docker.sock->@: read: connection reset by peer
> ```
>
> **La collecte a tourné de 04 h 08 min 51 à 04 h 14 min 07.** C'est la ligne exacte qui précédait
> le premier emballement du 2026-08-05, et c'est un `timeout` du collecteur qui coupe un client
> Docker en cours de requête. VPS-M12 l'interdit depuis le 2026-08-06 ; **aucun `timeout` du
> script n'a été revu depuis**. Ce n'est pas une cause établie ici — la boucle tournait déjà
> depuis 55 h — mais c'est une règle écrite que le code ne respecte pas, et elle rejoint les
> angles morts.
>
> ### Ce que ça ne coûte PAS, et il faut le dire
>
> La production répond : app-tracky **200 en 108 ms**, `/api/health` **200 en 42 ms**,
> `tracky.vizyoagency.com` **200 en 54 ms**, app-verify **302 en 249 ms**. Aucun conteneur n'est
> tombé, 0 OOM, PSI `full` = 0. C'est le **processeur** qui manque, pas la mémoire — et `sar`
> montre que la machine garde **34 à 40 % d'inactivité** malgré la boucle.
>
> ### Mesure du 2026-08-13, conservée
>
> `dockerd` à **100,3 %**, **1 292 236 `read()`/s pour 0,0000 octet**, charge machine **2,18**,
> cumul **87,3 h / 196,8 h = 44,3 %**, **37 threads**.

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
- **Vu** : 2026-08-20 · **Mesure du jour** : `/root` **total = 6,1 Go**, et la ligne « hors caches » mesurée à chaque passage passe de **1,4 à 1,7 Go en 24 h**. 🔴 **Ces 1,7 Go ne sont PAS de l'outillage** : c'est `/root/backups`, 1,66 Go de dumps de pré-déploiement empilés les 18 et 19 août — **nouveau constat VPS-030**. ⚠️ **La phrase « `/root` hors caches pèse 27 Mo, et cette ligne-là est mesurée chaque passage : si `/root` grossit ailleurs, elle le dira » a tenu sa promesse** — elle a dit que ça grossissait. Ce qu'elle ne pouvait pas dire, c'est **quoi** : elle affiche un total. Il a fallu descendre d'un cran, exactement comme pour découvrir ce constat-ci le 2026-08-06. *(mesure du 2026-08-11, conservée ci-dessous.)*
- **Mesure du 2026-08-11, conservée** : 4,5 Go, **~155 000 fichiers** — chiffres du 2026-08-06, **volontairement non remesurés** : ces quatre caches sont exclus du parcours de l'audit (c'est le correctif VPS-M16), donc les remesurer reviendrait à repayer exactement ce qu'on a supprimé. `/root` hors caches pèse **27 Mo**, et cette ligne-là est mesurée chaque passage : si `/root` grossit ailleurs, elle le dira.

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
- **Vu** : 2026-08-22 · **Mesure du jour** : **17 / 18 sous-dossiers** en **38 s** (`maalem` abandonné à 12 005 ms, **8e fois**). `/opt/vizyo-leads` = **4,7 s sur 38,3 s = 12,4 %** du parcours, **dérivée de la mesure du passage** et non recopiée — c'est le correctif VPS-M55 qui prouve ici qu'il fonctionne : la part **a bougé** (11,9 % à froid le 08-21, 10,5 % à chaud), donc elle n'est plus figée. ⚠️ **Ne pas comparer cette part d'un passage à l'autre sans regarder les durées** : elle se déplace quand c'est le **dénominateur** qui change. *(mesure du 2026-08-20, conservee ci-dessous.)*
- **Mesure du 2026-08-20, conservée** : ⚠️ **NON COMPARABLE — 17 / 18 sous-dossiers**, en **36 s**, un seul manquant (`maalem`, 12 006 ms). Le total affiche (**4,4 Go**) ne vaut **rien** face aux 6,0 Go de la mesure complete d hier. ⚠️ **Et la cause du recul est nommee : la machine porte VPS-016 depuis une heure au moment de la collecte** — hier, calme, elle donnait 18/18 en 15 s. *Ce n est pas une regression du collecteur, et ce n etait pas non plus un progres hier.* **`/opt/vizyo-leads` a coute 4 870 ms pour 823 Mo** d une pile supprimee le 2026-08-04, soit ~14 % du parcours. *(mesure du 2026-08-18, conservee ci-dessous.)*
- **Mesure du 2026-08-18, conservée** : ⚠️ **NON COMPARABLE — 12 / 18 sous-dossiers**, en 49 s, la couverture la plus faible depuis le 08-15. Six manquants : `dg-epaviste-depannage maalem vizyo-manager vizyo-texto vizyo-tracky vizyo-verify`. Le total affiche (**1,6 Go**) ne vaut **rien** face aux 6,0 Go de la seule mesure complete (08-11). ⚠️ **SEPTIEME passage consecutif sans mesure complete**, et la cause est nommee cette fois : un **build tournait pendant la collecte**, `/opt/foodsqan` est passe de 1 431 ms a **12 028 ms** entre deux collectes distantes de 9 minutes (VPS-M18 — une duree n'est pas une propriete du script). **`/opt/vizyo-leads` a coute 5 562 ms pour 823 Mo** d'une pile supprimee le 2026-08-04. *(mesure du 2026-08-17, conservee ci-dessous.)*
- **Mesure du 2026-08-17, conservée** : ⚠️ **NON COMPARABLE — 15 / 18 sous-dossiers**, en 48 s. **La meilleure couverture depuis six passages**, et elle ne suffit toujours pas. Trois manquants, tous nommes : `maalem vizyo-tracky vizyo-verify`. Le total affiche (**3,2 Go**) ne vaut **rien** face aux 6,0 Go de la seule mesure complete (08-11). ⚠️ **SIXIEME passage consecutif sans mesure complete** (11/18, 13/18, 13/18, 11/18, 14/18, **15/18**). `/opt/maalem` epuise a lui seul le plafond de 12 s (**12 008 ms**), `/opt/vizyo-auth` **8 624 ms** pour 440 Mo, `/opt/vizyo-manager` **7 467 ms** pour 1004 Mo, et **`/opt/vizyo-leads` 7 171 ms pour 823 Mo — une pile SUPPRIMEE le 2026-08-04 qui coute toujours ~15 % du parcours**. *(mesure du 2026-08-16, conservee ci-dessous.)*
- **Mesure du 2026-08-16, conservée** : ⚠️ **NON COMPARABLE — 14 / 18 sous-dossiers**, en 46 s. Quatre manquants, tous nommes : `maalem vizyo-texto vizyo-tracky vizyo-verify`. Le total affiche (2,9 Go) ne vaut **rien** face aux 6,0 Go du 08-11. ⚠️ **CINQUIEME passage consecutif sans mesure complete** (11/18, 13/18, 13/18, 11/18, **14/18**). `/opt/maalem` a lui seul epuise le plafond de 12 s (**12 011 ms**), `/opt/vizyo-manager` **10 799 ms** pour 1004 Mo, `/opt/vizyo-leads` **9 033 ms** pour 823 Mo — **une pile SUPPRIMEE le 2026-08-04 qui coute toujours ~20 % du parcours**. *(mesure du 2026-08-14, conservee ci-dessous.)*
- **Mesure du 2026-08-14, conservée** : ⚠️ **NON COMPARABLE — 13 / 18 sous-dossiers**, en 51 s (plafond global atteint). Cinq manquants, tous nommes : `maalem vizyo-leads vizyo-texto vizyo-tracky vizyo-verify`. Le total affiche (2,0 Go) ne vaut **rien** face aux 6,0 Go du 08-11. ⚠️ **TROISIEME passage consecutif sans mesure complete** (11/18, 13/18, 13/18) : le delai de 12 s par sous-dossier a ete calibre sur une machine saine, et elle ne l'est plus depuis le 08-11. `/opt/dg-epaviste-depannage` coute **3 971 ms** pour 253 Mo, `/opt/vizyo-auth` **10 165 ms** pour 440 Mo, `/opt/vizyo-manager` **10 655 ms** pour 1004 Mo. *(mesure du 2026-08-13, conservee : 11/18 sous-dossiers en 46 s, total 0,6 Go, sans valeur.)*

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
- **Vu** : 2026-08-20 · **Mesure du jour** : **239 Mo (=) — ~683 486 lignes (estime)** sur une fenetre glissante de **5 jours** (2026-08-16 → 2026-08-20). `min` **et** `max` ont avance d un jour : la purge tourne, regime permanent. ⚠️ Cette table reste le **meilleur contre-exemple du referentiel** — 239 a 242 Mo pour un estime qui fait 710 951 → 523 268 → 688 458 → 697 413 → ~703 000 → 669 645 → **683 486** : du bruit de recalage (VPS-M20), jamais une tendance. *(mesure du 2026-08-18, conservee ci-dessous.)*
- **Mesure du 2026-08-18, conservée** : **242 Mo (+3) — ~703 000 lignes (estime)** sur une fenetre glissante de **4 jours** (2026-08-15 → 2026-08-18). `min` a avance de deux jours, `max` d'un : la purge tourne, regime permanent. ⚠️ Cette table reste le **meilleur contre-exemple du referentiel** — 239 a 242 Mo pour un estime de lignes qui fait 710 951 -> 523 268 -> 688 458 -> 697 413 -> ~703 000 : du bruit de recalage (VPS-M20), jamais une tendance. *(mesure du 2026-08-17, conservee ci-dessous.)*
- **Mesure du 2026-08-17, conservée** : **239 Mo (−2) — ~697 413 lignes (estime)** sur une fenetre glissante de **5 jours** (2026-08-13 → 2026-08-17), 24 % de `tracky_prod`. `min` et `max` ont avance d'un jour chacun : la purge tourne, regime permanent. ⚠️ **L'estime de lignes fait desormais 710 951 → 523 268 → 688 458 → 697 413 a taille quasi identique** : c'est du bruit de recalage (VPS-M20), et cette table reste le **meilleur contre-exemple du referentiel** — ne jamais en tirer une tendance. *(mesure du 2026-08-16, conservee ci-dessous.)*
- **Mesure du 2026-08-16, conservée** : **241 Mo — a l'octet pres le meme depuis trois passages — ~688 458 lignes (estime)** sur une fenetre glissante de **5 jours** (2026-08-12 → 2026-08-16), 24 % de `tracky_prod`. *(mesure du 2026-08-14, conservee ci-dessous.)*
- **Mesure du 2026-08-14, conservée** : **241 Mo — a l'octet pres le meme qu'hier — ~523 268 lignes (estime)** sur une fenetre glissante de **4 jours** (2026-08-11 → 2026-08-14), 24 % de `tracky_prod`. Le `min` a **avance de deux jours** ce passage : la purge a tourne, et la fenetre oscille entre 4 et 5 jours selon l'heure de la purge relativement a celle de l'audit. ⚠️ **L'estime de lignes BAISSE de 26 %** (710 951 → 523 268) a taille strictement identique — apres avoir bondi de 34 % la veille : c'est du bruit de recalage (VPS-M20), et cette table en donne le meilleur exemple du referentiel. *(mesure du 2026-08-13, conservee : 241 Mo, ~710 951 lignes estimees, fenetre de 5 jours (2026-08-09 → 08-13).)*

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
- **Vu** : 2026-08-20 · **Mesure du jour** : **7 conteneurs, 2 applications, 1 seul projet compose** — inchange, **14e passage** (`deploy` : 4 Maestroo dev + 3 Vizyo Manager prod). ⚠️ Le risque se multiplie toujours avec VPS-013 : `vizyo-manager-postgres` est dans ce projet et sa derniere sauvegarde a **126 jours**. *(mesure du 2026-08-18, conservee ci-dessous.)*
- **Mesure du 2026-08-18, conservée** : **7 conteneurs, 2 applications, 1 seul projet compose** — inchange, **12e passage** (`deploy` : 4 Maestroo dev + 3 Vizyo Manager prod). ⚠️ Le risque se multiplie toujours avec VPS-013 : `vizyo-manager-postgres` est dans ce projet et sa derniere sauvegarde a **125 jours**. *(mesure du 2026-08-17, conservee ci-dessous.)*
- **Mesure du 2026-08-17, conservée** : **7 conteneurs, 2 applications, 1 seul projet compose** — inchange, **11e passage** (`deploy` : 4 Maestroo dev + 3 Vizyo Manager prod). ⚠️ Le risque se multiplie toujours avec VPS-013 : `vizyo-manager-postgres` est dans ce projet et sa derniere sauvegarde a **123 jours**.

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

- **Domaine** : docker · **Gravité** : 2 · **Statut** : ✅ **`APPLIQUE` (2026-08-18)** — le garde-fou de lecture est posé ; le déplacement vers `/opt/infra-proxy/` reste ouvert
- **Vu** : 2026-08-20 · **Mesure du jour** : **1 seul conteneur tient les ports 80 et 443**, `foodsqan-traefik`, et il sert **25 domaines** portes par 21 conteneurs etiquetes. Bout-en-bout : app-tracky **200 en 44 ms**, `/api/health` **200 en 37 ms**, `tracky.vizyoagency.com` **200 en 50 ms**, app-verify **302 en 94 ms**. ✅ **Tous sous 100 ms ALORS QUE LA 4e OCCURRENCE DE VPS-016 TOURNE DEPUIS UNE HEURE** — a comparer aux 83/83/85/210 ms du 08-18, quinzieme jour de la 3e occurrence. **La degradation de bout-en-bout n arrive qu une fois la marge consommee** (VPS-M48), pas au debut : ces 44 ms ne disculpent donc rien. ⚠️ Il n a toujours AUCUNE sonde de sante, et ils sont **9 sur 33** dans ce cas — **11e passage**. *(mesure du 2026-08-18, conservee ci-dessous.)*
- **Mesure du 2026-08-18, conservée** : **1 seul conteneur tient les ports 80 et 443**

> ### ✅ 2026-08-18 — `NE-PAS-SUPPRIMER.txt` est posé, après neuf passages
>
> `/opt/foodsqan/NE-PAS-SUPPRIMER.txt` — 2 665 octets, mode 644, **troisième entrée d'un `ls`**
> (derrière `CHANGELOG.md` et `MAINTENANCE.md`), donc impossible à manquer en ouvrant le dossier.
>
> Il dit, dans cet ordre : que le nom **ment sur le rôle** ; que ce dossier définit
> `foodsqan-traefik`, unique tenant des ports 80/443 ; les **25 domaines** qui en dépendent ; la
> commande qui le vérifie (`docker compose ls`) ; les **trois** gestes à ne pas faire (`rm -rf`,
> toucher au volume `foodsqan-letsencrypt` qui n'est dans aucune sauvegarde, renommer le réseau
> `foodsqan-public`) ; et **pourquoi il existe** — le plan d'audit du 2026-08-07 avait lui-même
> proposé de supprimer ce dossier.
>
> ⚠️ **Ce qui reste ouvert** : le déplacement vers `/opt/infra-proxy/` avec un `name:` explicite.
> Le fichier ne fait que **rendre le piège lisible** — il ne le désarme pas. Mais c'est exactement
> ce que ce constat demandait au point 1, et il coûtait deux minutes depuis neuf passages., `foodsqan-traefik`, et il sert **25 domaines** portes par 21 conteneurs etiquetes. Bout-en-bout : app-tracky **200 en 83 ms**, `/api/health` **200 en 83 ms**, `tracky.vizyoagency.com` **200 en 85 ms**, app-verify **302 en 210 ms**. 🟠 **LES LATENCES ONT DOUBLE** — contre 49/31/56/83 ms le 08-17, soit des facteurs de **1,5 a 2,7**. Aucune erreur, aucun 5xx, aucun conteneur tombe : les codes sont inchanges. Mais **c'est la premiere fois depuis le 2026-08-05 que VPS-016 produit un effet mesurable HORS de la machine**, et la phrase « ce que ca ne coute PAS : la production repond », ecrite a quinze passages, doit etre nuancee. ⚠️ Mesure ponctuelle, mediane de 3, prise pendant une collecte ET un build — mais prise par le meme collecteur au meme endroit du script tous les jours, et les six passages precedents n'ont jamais depasse 119 ms sur les trois premiers points. ⚠️ Il n'a toujours AUCUNE sonde de sante, et ils sont **9 sur 33** dans ce cas — **9e passage**. *(mesure du 2026-08-17, conservee ci-dessous.)*
- **Mesure du 2026-08-17, conservée** : **1 seul conteneur tient les ports 80 et 443**, `foodsqan-traefik`, et il sert **25 domaines** portes par 21 conteneurs etiquetes. Bout-en-bout du 2026-08-17 : app-tracky **200 en 49 ms**, `/api/health` **200 en 31 ms**, `tracky.vizyoagency.com` **200 en 56 ms**, app-verify **302 en 83 ms** — **les meilleurs temps depuis le debut de la boucle**, pendant que la machine perd plus d'un coeur depuis **125 h 20**. ⚠️ Il n'a toujours AUCUNE sonde de sante, et ils sont **9 sur 33** dans ce cas — **8e passage**. *(mesure du 2026-08-16, conservee : 25 domaines, bout-en-bout 42/39/119/139 ms.)*

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
- **Domaine** : sécurité · **Gravité** : 2 · **Statut** : ✅ **`APPLIQUE` sur son périmètre d'origine (2026-08-18)** — 🔴 **mais le constat ROUVRE aussitôt, avec un périmètre 7× plus grand**
- **Vu** : 2026-08-20 · **Mesure du jour** : périmètre d'origine toujours fermé — aucun fichier d'environnement lisible par tous. ⚠️ **Les 3 jetons GitHub restent valides côté GitHub** : les fichiers sont en 600, mais un jeton en 600 reste un jeton. La révocation depuis GitHub est le point 11 du plan, **3e passage sans action**. *(mesure du 2026-08-18, conservée ci-dessous.)*
- **Mesure du 2026-08-18, conservée** : ✅ **33 fichiers fermés en tout**, et le balayage complet de `/opt` (51 candidats, sans limite de profondeur, `node_modules` exclus) rend **`AUCUN fichier d'environnement RÉEL lisible par tous`**. Contenu vérifié intact par **26 empreintes SHA-256 avant/après**. Production contrôlée après chaque lot : **33/33 conteneurs, 0 en anomalie**, les six points publics répondent en **26 à 56 ms**.

> ### ✅ 2026-08-18 — TROIS LOTS, ET LE DEUXIÈME A ÉTÉ TROUVÉ PAR UNE ERREUR DE MA MESURE
>
> | Lot | Fichiers | Ce qu'il contenait |
> |---|---:|---|
> | 1 — périmètre d'origine | **2** (+1 déjà en 600) | les 2 `.git/config` porteurs d'un jeton GitHub |
> | 2 — contre-épreuve `-maxdepth 3` | **13** | `vizyo-manager/.env.prod` (23 lignes), `vizyo-auth/.env` (9), `maestroo/.env.dev` + 4 `.bak`… |
> | **3 — balayage SANS limite de profondeur** | **13** | **`/opt/vizyo-tracky/deploy/vps/.env.prod` (25 lignes) + ses 9 sauvegardes**, `vizyo-texto/deploy/vps/.env`, `vizyo-auth/apps/api/.env.{development,postgres}` |
> | 4 — modèles qui n'en étaient pas | **5** | voir **VPS-028** |
>
> ⚠️⚠️ **Le lot 3 n'existe que parce que mon propre balayage était borné à `-maxdepth 3`.** Le
> fichier le plus sensible de la machine — l'environnement de production de **Tracky lui-même** —
> est à la profondeur **4** (`/opt/vizyo-tracky/deploy/vps/`). Je l'ai donc manqué en publiant, le
> même matin, deux constats sur des **périmètres trop étroits** (VPS-027, et VPS-022 lui-même).
> *Troisième fois dans la même journée, et la seule des trois où c'est la mesure de l'audit qui
> portait la borne.*
>
> ### Le risque a été mesuré AVANT d'agir, pas supposé
>
> | Question | Réponse |
> |---|---|
> | Un service systemd non-root lit-il `/opt` ? | **non** — les seules unités non-root sont `polkit`, `networkd`, `resolved`, `timesyncd` |
> | Un `EnvironmentFile` pointe-t-il vers `/opt` ? | **aucun** |
> | Un conteneur monte-t-il un `.env` par bind-mount ? | **aucun sur les 33** — Compose injecte les variables **au démarrage**, en root |
> | Un déploiement fonctionnerait-il encore ? | **oui**, vérifié : `docker compose --env-file .env.prod config` lit le fichier en 600 sans broncher |
>
> ⚠️ **Fausse alerte levée au passage** : `git status` a annoncé « 9 fichiers `.env` modifiés » dans
> `vizyo-tracky` juste après le `chmod`. Vérifié : les neuf sont en **`??` (non suivis)**, ce sont
> les `.bak`. Git ne suit que le bit **exécutable** — un 644 → 600 lui est invisible. *Un compteur
> qui mélange « modifié » et « non suivi » accuse un geste qui n'a rien fait.*
>
> ### ✅ 2026-08-18, 09 h 50 — les 13 sauvegardes sont SUPPRIMÉES, sur décision explicite
>
> C'est le **premier `rm` du dispositif**, et il sort du garde-fou de lecture seule : il a été
> demandé nommément par le propriétaire de la machine. **50 025 octets, 13 fichiers.**
>
> **Trois contrôles avant, parce qu'une suppression ne se relit pas :**
>
> | Question | Réponse |
> |---|---|
> | Une **clé** existe-t-elle dans une sauvegarde et plus dans le fichier courant ? | **une seule** — `ANTHROPIC_ANTHROPIC_API_KEY` (préfixe doublé, faute de frappe) |
> | …et sa **valeur** ? | **identique** à l'`ANTHROPIC_API_KEY` courante — le nom avait été corrigé, rien n'est perdu |
> | Une **valeur** longue absente du courant ? | **une seule** — `PARTNER_MAESTROO_API_URL`, une **URL** remplacée depuis ; le conteneur utilise bien la nouvelle |
>
> **Vérifications après** : 0 sauvegarde restante · `.env.prod` et `.env.dev` **inchangés à
> l'octet près** (empreintes SHA-256 avant/après) · **33/33 conteneurs, 0 en anomalie** ·
> `docker compose --env-file .env.prod config` lit toujours le fichier · production en 120 et
> 208 ms.
>
> ### Le gain réel, et il n'est pas le disque
>
> **Les copies de la clé d'API Anthropic passent de 10 à 1.** 50 Ko ne pèsent rien sur 96 Go ; ce
> qui comptait, c'est qu'une clé vivante existait en **dix exemplaires** sur une machine où trois
> comptes ont un shell de connexion. *Un fichier de sauvegarde de secrets n'est pas un fichier de
> sauvegarde : c'est une copie supplémentaire du secret, et elle vieillit sans que personne la
> relise.*
>
> ⚠️ **À ne pas généraliser** : ces treize-là étaient supprimables **parce que la vérification l'a
> montré**, pas parce que ce sont des `.bak`. Le test qui décide n'est pas le nom du fichier, c'est
> *« contient-il une clé ou une valeur qui n'existe nulle part ailleurs ? »*.

> ### ✅ 2026-08-18 — corrigé après onze passages, en dix secondes
>
> ```
> /opt/foodsqan/.git/config                644 -> 600  ✅
> /opt/dg-epaviste-depannage/.git/config   644 -> 600  ✅
> /opt/foodsqan/.env.production            déjà 600     =
> ```
>
> ⚠️ **Une correction au référentiel au passage** : la fiche disait « 3 fichiers, dont deux en mode
> 644 » et le plan disait « `chmod 600` sur les **3** fichiers ». **Seuls DEUX étaient à changer** —
> `.env.production` était déjà en 600. Le geste restait juste, le compte non.
>
> **Contrôle après** : `git -C /opt/foodsqan remote get-url origin` et son équivalent
> `dg-epaviste` répondent toujours. Les deux dépôts sont `root:root`, aucun conteneur ne les lit.
>
> ### 🔴 ET LA CONTRE-ÉPREUVE A TROUVÉ SEPT FOIS PLUS — le périmètre était faux depuis le début
>
> Le contrôle « reste-t-il un porteur de secret lisible par tous dans `/opt` ? », lancé **pour
> vérifier le correctif**, a élargi la recherche des `.git/config` aux `.env*`. Résultat :
>
> | Fichier **RÉEL** en 644 | Lignes sensibles | Ce qu'il porte |
> |---|---:|---|
> | `/opt/vizyo-manager/.env.prod` | **23** | Stripe, factures, clients |
> | `/opt/maestroo/.env.dev` | 19 | |
> | `/opt/vizyo-manager/vizyo-manager-api/.env` | 17 | |
> | `/opt/vizyo-leads/.env.prod` | 13 | pile supprimée le 08-04 |
> | `/opt/vizyo-leads/.env` | 10 | idem |
> | **`/opt/vizyo-auth/.env`** | **9** | **l'authentification de TOUTES les applications** |
> | `/opt/dg-epaviste-depannage/.env` | 1 | |
> | **+ 4 sauvegardes** `/opt/maestroo/.env.dev.bak*` | 13 à 19 chacune | dont une « avant-retrait-superadmin » |
>
> *(Les `.env.example` portent des marqueurs de gabarit — `changeme`, `your_`, `<…>` — et ne sont
> pas comptés. `/opt/vizyo-tracky/.env` est en 644 avec 9 lignes sensibles **mais 5 marqueurs** :
> à trancher à l'œil, il n'est pas classé ici.)*
>
> **Et il y a bien quelqu'un pour les lire** : `/etc/passwd` déclare **trois** comptes avec un shell
> de connexion — `root`, `sync`, **`ubuntu`**.
>
> ### Le risque du correctif est MESURÉ, et il est nul
>
> La question qui décide : *un conteneur non-root lit-il un de ces fichiers ?* Six conteneurs
> tournent en non-root (`nodejs`, `nestjs`, `nextjs`, `node`, `guest`). **Aucun ne monte un `.env`
> par bind-mount** — vérifié sur les 33 : leurs variables sont injectées par Compose **au
> démarrage**, en root. Un `chmod 600` ne peut donc rien casser.
>
> **Quoi faire** — 13 fichiers, dix secondes, réversible :
>
> ```bash
> chmod 600 /opt/vizyo-manager/.env.prod /opt/vizyo-manager/vizyo-manager-api/.env >           /opt/vizyo-auth/.env /opt/maestroo/.env.dev /opt/maestroo/.env.dev.bak* >           /opt/vizyo-leads/.env /opt/vizyo-leads/.env.prod /opt/dg-epaviste-depannage/.env
> ```
>
> ⚠️ **Les 4 `.bak` de `maestroo` méritent mieux qu'un `chmod`** : ce sont des copies d'un fichier
> d'environnement de développement, dont une nommée « avant-retrait-superadmin ». Les garder en 600
> ferme la lecture ; les **supprimer** ferme la question — mais c'est une décision, pas un geste
> d'audit.
>
> > **La leçon, et c'est la deuxième fois en un jour** : ce constat a vécu **onze passages** sur un
> > périmètre de trois fichiers, parce que la question posée le 2026-08-08 était *« où sont les
> > jetons GitHub ? »* et non *« qu'est-ce qui est lisible par tous et ne devrait pas l'être ? »*.
> > C'est exactement VPS-027 sur un autre objet : *un périmètre trop étroit ne se contredit
> > jamais — il rend des réponses justes à une question plus petite que celle qu'on croit poser.*
> > Ici, c'est **le correctif lui-même** qui a révélé le vrai périmètre, parce que sa contre-épreuve
> > a été écrite plus large que lui.
- **Mesure du 2026-08-17, conservée** : **3 fichiers**, dont deux en mode **644** — **10e passage sans action**. Le correctif (`chmod 600`) coute 10 secondes et n'a aucun effet de bord. Il est en tete du plan d'action depuis onze passages : ce n'est plus un sujet technique.
- **Mesure du 2026-08-17, conservée** : **3 fichiers**, dont deux en mode **644** — inchange, **10e passage sans action**. Le correctif (`chmod 600`) coute 10 secondes et n'a aucun effet de bord. Il est en tete du plan d'action depuis dix passages : ce n'est plus un sujet technique.

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
- **Vu** : 2026-08-20 · **Mesure du jour** : **36 certificats**, **25 domaines** routes par un conteneur vivant, **16 orphelins — inchange, 7e passage a l'identique**. `acme.json` toujours date du **2026-08-12 a 21 h 33**, et les deux certificats Tracky servis expirent le **10 novembre 2026** : le renouvellement automatique n a rien a faire avant le 11 octobre. *(mesure du 2026-08-18, conservee ci-dessous.)*
- **Mesure du 2026-08-18, conservée** : **36 certificats**, **25 domaines** routes par un conteneur vivant, **16 orphelins — inchange, 5e passage a l'identique**. `acme.json` toujours date du **2026-08-12 a 21 h 33**. *(mesure du 2026-08-17, conservee ci-dessous.)*
- **Mesure du 2026-08-17, conservée** : **36 certificats**, **25 domaines** routes par un conteneur vivant, **16 orphelins — inchange, 4e passage a l'identique**. `acme.json` toujours date du **2026-08-12 a 21 h 33**, et les deux certificats Tracky servis expirent le **10 novembre 2026** — la prediction du 2026-08-11 reste verifiee, le renouvellement automatique n'a rien a faire avant le 11 octobre. *(mesure du 2026-08-16, conservee : 36 certificats, 25 domaines, 16 orphelins.)*

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
- **Vu** : 2026-08-20 · **Mesure du jour** : **423 Mo (+8 Mo)** — du **2026-06-20 au 2026-08-20**, soit **62 jours**. `min` **ET** `max` ont avance d un jour, pour le **cinquieme** passage consecutif : la retention se comporte comme une purge par palier, l horizon reste stable a 62 j. Rien ne derive. *(mesure du 2026-08-18, conservee ci-dessous.)*
- **Mesure du 2026-08-18, conservée** : **402 Mo (+4 Mo)** — du **2026-06-18 au 2026-08-18**, soit **62 jours**. `min` ET `max` ont avance d'un jour, pour le **troisieme** passage consecutif : la retention se comporte comme une purge par palier et l'horizon reste stable a 62 j. Rien ne derive. *(mesure du 2026-08-17, conservee ci-dessous.)*
- **Mesure du 2026-08-17, conservée** : **398 Mo (+4 Mo)** — du **2026-06-17 au 2026-08-17**, soit **62 jours**. `min` ET `max` ont avance d'un jour, pour le **deuxieme** passage consecutif : la retention se comporte exactement comme une purge par palier, et l'horizon reste stable a 62 j. Rien ne derive. *(mesure du 2026-08-16, conservee : 394 Mo, du 2026-06-16 au 2026-08-16, 62 jours.)*
- **Mesure du 2026-08-15, conservée ci-dessous.**
- **Mesure du 2026-08-15, conservée** : **389 Mo (+2 Mo)** — du **2026-06-15 au 2026-08-15**, soit **62 jours**. Le `max` a avance d'un jour, le `min` n'a pas bouge : l'horizon oscille entre 61 et 63 jours, exactement comme une purge qui se declenche par palier. Rien ne derive. *(mesure du 2026-08-14, conservee : 387 Mo, 2026-06-15 → 08-14, 61 jours.)*

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

## VPS-025 — ~~Le disque a pris 23 Go en 24 heures, non récupérables~~ → **RÉFUTÉ : le ramasse-miettes les a rendus en 24 h**

- **Domaine** : disque · **Gravité** : 4 (était 2) · **Statut** : `ACCEPTE` — **thèse réfutée le 2026-08-14 ; oscillation confirmée au 4e point (08-16), amplitude portée à 24 Go au 5e (08-17)**
- **Vu** : 2026-08-20 · **Mesure du jour** : **53 Go (55 %), 44 Go libres** — **stable a l octet pres** par rapport au 08-19, pour la premiere fois de la serie. Inodes **1 754 357 (14 %)**. La serie fait 76 → 59 → 72 → 54 → 52 → 68 → 54 → **55 %**. Deux images construites en 24 h (`tracky-api` 1,82 Go, `tracky-web` 105 Mo) pour **1,93 Go annonces**, confirmes independamment par `sysstat` (**1 709 blocs/s ecrits le 08-19**, le plus haut de la semaine) — et le disque n a pourtant pas bouge : le ramasse-miettes **et** le `prune` non filtre de VPS-029 ont rendu autant. ⚠️ **44 Go libres, soit 19 Go au-dessus du seuil revise (25 Go)**. *(mesure du 2026-08-18, conservee ci-dessous.)*
- **Mesure du 2026-08-18, conservée** : **65 Go (68 %), 31 Go libres** — le disque a REPRIS **15 Go en 24 h**, et l'oscillation se poursuit exactement comme decrit : 76 -> 59 -> 72 -> 54 -> 52 -> **68 %**. Inodes **2 679 705 (21 %)**. La cause est datee et legitime : **5 images construites en 24 h** (`maalem-dev-api` 2,33 Go, `tracky-api` 1,82 Go, plus 3 frontaux), **4,42 Go annonces**, confirmes independamment par `sysstat` (**748 blocs/s ecrits le 08-17** contre 271 le 08-16). ⚠️ **31 Go libres, soit 6 Go au-dessus du seuil revise (25 Go)** — la marge la plus faible depuis le creux du 08-13, et un build tournait encore pendant la collecte. *(mesure du 2026-08-17, conservee ci-dessous.)*
- **Mesure du 2026-08-17, conservée** : **50 Go (52 %), 47 Go libres** — la **crête la plus haute des cinq points**, et **22 Go au-dessus du seuil révisé** (25 Go libres). Inodes **1 728 398 (14 %)**, le plus bas jamais mesuré.

> ### ✅ 2026-08-17 — le 5e point n'oscille PAS, et il faut dire pourquoi
>
> | Mesure | 08-13 | 08-14 | 08-15 | 08-16 | **08-17** |
> |---|---:|---:|---:|---:|---:|
> | Disque utilisé | 76 % | 59 % | 72 % | 54 % | **52 %** |
> | Espace libre | 23 Go | 40 Go | 27 Go | 45 Go | **47 Go** |
> | Inodes | 3,31 M | 2,23 M | 3,03 M | 1,82 M | **1,73 M** |
> | Images / somme | 27 / — | 27 / 16,80 | 27 / 16,80 | 26 / 16,79 | **27 / 16,82 Go** |
>
> Les quatre premiers points font une oscillation de **24 Go** (creux 23 Go libres le 08-13, crête
> 47 Go aujourd'hui). Le cinquième ne remonte pas : il **glisse** de 54 à 52 %.
>
> **Et l'explication est dans `sysstat`, pas dans Docker** : l'écriture disque du 08-16 tombe à
> **271 blocs/s**, le chiffre **le plus bas de la semaine** (contre 1 137 le 08-12). Les deux
> builds du jour — `tracky-web` 105 Mo et `tracky-api` 1,82 Go — n'ont annoncé que **1,93 Go**.
> **Ce n'est pas un progrès, c'est une journée calme**, et il fallait l'écrire : sans cette ligne,
> le 6e point se lira comme une amélioration du mécanisme.
>
> ⚠️ **Une image est revenue** (26 → 27, +0,03 Go) : c'est `alpine:latest`, retirée par le ménage
> du 08-16 puis retirée du néant par la sauvegarde de 03 h 31 — voir **VPS-026**, dont la règle
> vient d'être vérifiée pour la cinquième fois **et par prédiction**.
- **Mesure du 2026-08-16, conservée** : **52 Go (54 %), 45 Go libres** — le disque avait RENDU **17 Go en 24 h**, après en avoir pris 12, rendu 16 et pris 23 les jours précédents.

> ### ✅ 2026-08-16 — le 4e point confirme l'oscillation et corrige DEUX chiffres écrits la veille
>
> | Mesure | 08-13 | 08-14 | 08-15 | **08-16** |
> |---|---:|---:|---:|---:|
> | Disque utilisé | 76 % | 59 % | 72 % | **54 %** |
> | Espace libre | 23 Go | 40 Go | 27 Go | **45 Go** |
> | Cache `Shared` | 26,03 Go | 2,26 Go | 21,39 Go | **0,10 Go** |
> | Cache `Private` | 10,39 Go | 11,31 Go | 10,33 Go | **12,54 Go** |
> | Images / somme | 27 / — | 27 / 16,80 Go | 27 / 16,80 Go | **26 / 16,79 Go** |
> | Inodes | 3,31 M | 2,23 M | 3,03 M | **1,82 M** |
>
> Le mouvement s'explique entièrement : deux images de **production** reconstruites
> (`tracky-api` le 08-15 à 17 h 05, `tracky-web` le 08-16 à 00 h 04), les couches des anciennes
> déréférencées, et le ramasse-miettes les a prises — `cache.db` écrit **402 s** après le build.
>
> ### ⚠️ Correction n° 1 — l'amplitude n'est pas 15 Go, elle est de 23 Go
>
> Le seuil écrit le 08-15 — *« agir si un passage trouve moins de 15 Go libres »* — a été calibré
> sur une amplitude de 15 Go mesurée sur **trois** points. Le creux le plus bas reste 23 Go libres
> (08-13), la crête est désormais **45 Go**. **Le seuil est relevé à 25 Go libres** : une session
> de build a déjà coûté 23 Go (le 08-12) et 12 Go (le 08-14), donc un passage qui trouve 15 Go
> libres n'a plus la marge d'**une seule** journée de build. Aujourd'hui : 45 Go, **20 Go
> au-dessus du seuil révisé**.
>
> ### ⚠️ Correction n° 2 — « `Private` est plate » est affaibli
>
> La série fait **10,39 → 11,31 → 10,33 → 12,54**. L'amplitude passe de 0,98 à **2,21 Go**, et
> c'est la valeur la plus haute jamais mesurée : **25 % au-dessus du plafond de 10 Go**. Voir le
> test écrit d'avance dans **VPS-001**.
>
> ⚠️ **Une image a disparu** (27 → 26, −0,01 Go) : c'est `alpine:latest`, supprimée par le ménage
> de 00 h 40 — et c'est ce qui a permis d'établir la cause de **VPS-026**. Le chiffre est cohérent
> avec les ~8 Mo de l'image.
- **Mesure du 2026-08-15, conservée** : **69 Go (72 %), 27 Go libres** — le disque avait REPRIS **12 Go en 24 h**.

> ### ✅ 2026-08-15 — le troisième point donne à ce constat sa forme définitive
>
> | Mesure | 08-13 | 08-14 | **08-15** |
> |---|---:|---:|---:|
> | Disque utilisé | 76 % | 59 % | **72 %** |
> | Cache `Shared` | 26,03 Go | 2,26 Go | **21,39 Go** |
> | Cache `Private` | 10,39 Go | 11,31 Go | **10,33 Go** |
> | Somme des tailles d'images | — | 16,80 Go / 27 | **16,80 Go / 27** |
> | Inodes | 3,31 M | 2,23 M | **3,03 M** |
>
> **L'alarme du 08-13 et le soulagement du 08-14 décrivaient le même mouvement, saisi à deux
> phases.** Ni l'un ni l'autre n'était une tendance : le disque oscille d'environ **15 Go** au
> rythme des builds, et il revient. La grandeur qui ne bouge pas est `Private` — **0,98 Go
> d'amplitude sur trois passages**, pour un plafond de 10 Go.
>
> **Origine du +12 Go, donnée par le bloc écrit la veille** : trois images `maalem-dev` construites
> le 08-14 à 10 h 26 (2,50 Go annoncés), seule session de build de la fenêtre, confirmée
> indépendamment par `sysstat` (**560 blocs/s écrits le 08-14** contre 23 les jours calmes). C'est
> la première occasion réelle de ce bloc, et il répond du premier coup là où le 08-13 avait exigé
> une reconstitution par élimination puis une re-mesure à la main.
>
> ### Le seuil qu'on peut enfin écrire, parce que l'amplitude est connue
>
> **Agir si un passage trouve moins de 15 Go libres.** En dessous, une seule session de build peut
> consommer toute la marge avant que le ramasse-miettes ne rencontre son déclencheur. Au-dessus, le
> mécanisme a démontré **deux fois** qu'il reprend ce qu'il a laissé prendre. Aujourd'hui : 27 Go
> libres, soit **12 Go au-dessus du seuil** ; le creux le plus bas jamais mesuré reste les 23 Go du
> 08-13.
>
> ⚠️ **À ne pas faire : lire le seuil de VPS-009 (« 80 % ») comme une tendance.** Il est passé de
> 4 à 21 puis à 8 points en trois jours — parce qu'il oscille avec le disque, pas parce que la
> situation se dégrade ou s'améliore.
>
> ### Mesure du 2026-08-14, conservée
>
> **57 Go (59 %), 40 Go libres** — le disque avait rendu **16 Go en 24 h sans qu'aucune commande soit lancée**. `Shared` est passé de **26,03 à 2,26 Go** ; `Private` de 10,39 à **11,31 Go** ; les **27 images et leur somme de 16,80 Go sont identiques à l'octet près**. Inodes 26 % → **18 %**.
- **Mesure à la découverte (2026-08-13)** : 50 Go (52 %) → 73 Go (76 %) en 24 h, 23 Go libres ; inodes 14 % → 26 %

> ### ❌ 2026-08-14 — « ces 23 Go ne sont PAS récupérables » était FAUX, et le démenti a mis 24 heures
>
> Ce constat affirmait, en gras, ce qui faisait tout son sérieux :
>
> > *« Ces 23 Go ne sont PAS récupérables. […] 26 des 36 Go sont `Shared` avec des images en
> > service : le ramasse-miettes ne peut pas les libérer et n'a jamais prétendu le faire. »*
>
> Le ramasse-miettes les a libérés.
>
> | Mesure | 2026-08-13 | 2026-08-14 | Δ |
> |---|---:|---:|---:|
> | Disque utilisé | 73 Go (76 %) | **57 Go (59 %)** | **−16 Go** |
> | Espace libre | 23 Go | **40 Go** | **+17 Go** |
> | Cache de build — **`Shared`** | **26,03 Go** | **2,26 Go** | **−23,77 Go** |
> | Cache de build — `Private` | 10,39 Go | 11,31 Go | +0,92 Go |
> | Images / somme des tailles | 27 / 16,80 Go | **27 / 16,80 Go** | **0** |
>
> ### La cause, et elle est datée
>
> ```
> dernier build : tracky-api:latest   2026-08-13 17:18:50
>                 tracky-web:latest   2026-08-13 17:17:33
> cache.db de BuildKit modifie le     2026-08-13 17:24:31   ← 341 s apres
> ```
>
> Le build a produit un nouveau `tracky-api:latest` ; les couches de l'ancien ont cessé d'être
> référencées par une image vivante, sont devenues collectables, et le ramasse-miettes les a
> prises. `sysstat` confirme **373 blocs/s écrits le 08-13** contre 23 les jours calmes : **un**
> build, pas huit.
>
> ### L'erreur de raisonnement, nommée
>
> **`Shared` n'est pas une catégorie de couches, c'est un état à un instant donné.** Une couche
> est `Shared` *tant qu'une image vivante la référence* — c'est une **relation**, et une relation
> change quand l'une des deux parties change. Le constat a lu une répartition instantanée comme
> une propriété permanente.
>
> **Et la règle qui l'aurait évité était déjà écrite, dans la fiche voisine.** VPS-001 porte
> depuis le 2026-08-07 : *« pour lire une valeur qui ne bouge pas, il faut trois choses — la
> valeur, la fraîcheur de son producteur, et la fraîcheur de **ce qui déclenche** le
> producteur. »* Le déclencheur du ramasse-miettes est un **build** ; le 08-13, le dernier build
> de `tracky-api` remontait au 08-11. Les 26 Go de `Shared` n'avaient **encore rencontré aucun
> déclencheur**. Conclure « hors de portée » à ce moment-là, c'était lire une absence de
> déclenchement comme une impossibilité — l'exact miroir de l'erreur du 2026-08-06 sur VPS-001,
> où un mécanisme sain avait été lu comme arrêté.
>
> ### Ce qui exclut une intervention humaine
>
> | Commande hypothétique | Ce qu'elle aurait laissé | Ce qu'on observe |
> |---|---|---|
> | `docker buildx prune -af` | `Private` ≈ 0, cache vidé | **`Private` = 11,31 Go**, 99 à 142 entrées |
> | `docker image prune -af` | des images en moins | **27 images, somme inchangée** |
>
> Le ménage nocturne a bien tourné le 08-14 à 00 h 40 min 01, en 4 s, et n'a laissé **0 image
> pendante**. La seule cause compatible avec les trois chiffres est le ramasse-miettes de
> BuildKit.
>
> ### Ce qui reste vrai de ce constat, et qu'on garde
>
> 1. **Le pic est réel et il revient à chaque journée de build.** 76 % a été atteint ; le disque
>    n'a pas de marge pour deux journées comme le 08-12 rapprochées.
> 2. **L'arbitrage humain est intact** : dix conteneurs de développement (`maalem-dev-*` : 6,
>    `maestroo-dev-*` : 4) et leurs builds vivent sur la machine qui héberge sept bases de
>    production.
> 3. **Le total durable récupérable reste ~3,5 Go** — mais pour **40 Go libres**, ce qui retire
>    l'urgence.
>
> **Seuil de réescalade, réécrit** : repasser en `A_TRAITER` (gravité 2) si le disque franchit
> **80 %** *et* qu'aucun build n'a eu lieu depuis 48 h — c'est-à-dire si le volume tient **sans**
> que le ramasse-miettes ait eu son déclencheur. Le seuil de 85 % / 10 Go libres de la version
> initiale ne distinguait pas ces deux situations.
>
> **À ne pas faire, et c'est inchangé** : lancer `docker buildx prune -af`. Les 11,31 Go de
> `Private` reviennent au prochain build, au prix d'un premier build 2 à 4× plus long.

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

- **Domaine** : sauvegardes · **Gravité** : **3** · **Statut** : `A_TRAITER` — ✅ **CAUSE ÉTABLIE le 2026-08-16, et VÉRIFIÉE PAR PRÉDICTION le 2026-08-17**
- **Vu : 2026-08-26** · **Mesure du jour** : `alpine:latest` **ABSENT**. La sauvegarde des **pieces d'identite** de 03 h 30 **retelechargera son image depuis Docker Hub**. `registry-1.docker.io` a **245 ms / HTTP 401**. **Cause predictive 14 fois sur 14** — *et c'est la quatorzieme nuit d'affilee ou « ca marche » est la seule raison pour laquelle personne ne le voit.*
- **Vu** : 2026-08-22 · **Mesure du 2026-08-22** : `alpine:latest` **ABSENT**. Le ménage de 00 h 40 l'a supprimé comme le rapport du 08-21 l'avait écrit d'avance, et la sauvegarde des **pièces d'identité** de 03 h 31 **retéléchargera son image depuis Docker Hub**. `registry-1.docker.io` à **247 ms / HTTP 401**. **Cause prédictive 10 fois sur 10** — *et c'est la dixième nuit d'affilée où « ça marche » est la seule raison pour laquelle personne ne le voit.*
- **Mesure du 2026-08-21, conservée** : `alpine:latest` **PRÉSENT, tiré le 2026-08-20 à 03 h 30 min 26 — soit il y a 25 h**. 🔴 **Plus de 24 h : le ménage de 00 h 40 le supprimera cette nuit, et la sauvegarde de 03 h 30 le retéléchargera.** `registry-1.docker.io` mesuré à **244 ms / HTTP 401**. **Cause prédictive 9 fois sur 9.** ⚠️ **Le mécanisme est désormais entièrement lisible dans la seule section 7**, en deux lignes qui ne se connaissent pas : `/etc/cron.d/docker-image-prune` (`40 0 * * * docker image prune -af --filter "until=24h"`) et `vizyo-verify-backup.timer` (03 h 30). *Le défaut n'est ni dans l'une ni dans l'autre : il est dans le fait que la seconde dépend d'un objet que la première a le droit de détruire, et qu'aucune des deux ne mentionne l'autre.* Il coûte 20 minutes à fermer (point 1 du plan du 2026-08-21). *(mesures des 08-20 et 08-18 conservées ci-dessous.)*
- **Mesure du 2026-08-20, conservée** : `alpine:latest` **ABSENT** — la sauvegarde des pièces d'identité de cette nuit, à 03 h 31, **tirera son image depuis Docker Hub**. `registry-1.docker.io` à **250 ms / HTTP 401** : il répond, mais le seul dispositif de sauvegarde de données d'identité de la machine dépend d'un tiers **à l'heure exacte de son exécution**. **Cause prédictive 8 fois sur 8.**
- **Mesure du 2026-08-18, conservée** : `alpine:latest` **PRÉSENT**, `LastTagTime` = **2026-08-18 03 h 31 min 01** — c'est-à-dire **retiré à nouveau ce matin**, à la seconde de la sauvegarde. **La dépendance a joué 4 fois sur 6 exécutions connues.**

> ### ✅✅ 2026-08-18 — LA RÈGLE EXPLIQUE 6 OBSERVATIONS SUR 6, ET LE TEST A FAILLI ÊTRE MAL LU
>
> Le test posé le 08-16 et reconduit le 08-17 disait : *« au passage du **2026-08-18**, `alpine`
> doit être **ABSENT** (~45 h au ménage de 00 h 40) »*.
>
> **Lu au pied de la lettre, il est FAUX : l'image est PRÉSENTE.** Lu correctement, il est
> **confirmé**, et par une preuve plus forte que celle qu'il demandait :
>
> ```
> LastTagTime = 2026-08-18 03:31:01
> ```
>
> **On ne tire pas une image qu'on possède déjà.** Ce tirage, à la seconde de la sauvegarde de
> 03 h 31, établit que l'image était **absente juste avant** — donc qu'elle a bien été supprimée
> par le ménage de 00 h 40, à ~45 h d'âge, **exactement comme prédit deux jours à l'avance**.
>
> ### ⚠️ Pourquoi il a failli être mal lu : une précondition que personne n'avait écrite
>
> Le test portait sa précondition — *« que le ménage de 00 h 40 et le timer de 03 h 31 tournent
> tous les deux »* — et elle était tenue. **Il en avait une seconde, muette : que la collecte ait
> lieu ENTRE les deux.** Les quatorze passages précédents démarraient à 02 h 21–02 h 22, donc dans
> cette fenêtre, et personne n'a jamais eu à y penser.
>
> **Ce matin la collecte a démarré à 04 h 00** — après le tirage — parce que deux collectes ont été
> perdues sur VPS-M43. La fenêtre d'observation a changé, et avec elle le sens de la réponse.
> Conclure « PRÉSENT ≠ ABSENT, donc la règle est fausse » aurait **rouvert à tort un constat
> résolu**.
>
> > **La règle, en extension de VPS-M41** : *un test écrit d'avance doit porter, parmi ses
> > préconditions, **l'heure d'observation** quand la grandeur observée change au cours de la
> > journée.* Ici l'objet oscille deux fois par cycle de 24 h ; l'observateur croyait mesurer un
> > état, il mesurait une **phase**. VPS-M41 disait *« un rendez-vous qu'on prend sans savoir si on
> > sera libre »* ; celui-ci ajoute : *ni à quelle heure on arrivera*.
>
> **Le prochain test, avec ses DEUX préconditions** : au passage du **2026-08-19**, `alpine` doit
> être **PRÉSENT** avec un `LastTagTime` au **08-18 03 h 31** (épargné par le ménage, ~21 h d'âge)
> **si la collecte a lieu avant 03 h 31** ; s'il porte le **08-19 03 h 31**, c'est que la collecte
> est passée après le tirage — les deux sont conformes à la règle, et c'est `LastTagTime` qui
> tranche, jamais la présence seule.
- **Mesure du 2026-08-17, conservée** : `alpine:latest` **PRÉSENT**, `LastTagTime` = **2026-08-16 03 h 31 min 21**. `registry-1.docker.io` répond en 244 ms (401 attendu). **La dépendance a joué 3 fois sur 5 exécutions connues.**

> ### ✅✅ 2026-08-17 — LE TEST ÉCRIT D'AVANCE EST TRANCHÉ, ET LA RÈGLE A PRÉDIT L'HEURE
>
> Le rapport du 08-16 posait, avant d'avoir la réponse :
>
> > - **08-17** : `alpine` doit être **PRÉSENT** (tiré cette nuit à 03 h 31, donc ~21 h au ménage) ;
> > - **08-18** : `alpine` doit être **ABSENT** (~45 h au ménage).
>
> ```
> docker inspect alpine:latest --format '{{.Metadata.LastTagTime}}'
> 2026-08-16 03:31:21.286431779 +0000 UTC
> ```
>
> **Présent — et tiré à 03 h 31 min 21**, la seconde même où la sauvegarde de Verify s'exécutait.
> Ce n'est pas seulement la présence qui est conforme : c'est **l'heure du tirage**, annoncée
> vingt-quatre heures à l'avance. La règle `until=24h` explique désormais **5 observations sur 5**
> plus une prédiction vérifiée à la seconde.
>
> Le collecteur produit la suite tout seul, sans que personne ait à refaire le calcul :
>
> ```
> present, tire localement le 2026-08-16 03:31:21 — soit il y a 22 h
> 🟠 EPARGNE CETTE NUIT (moins de 24 h), SUPPRIME LA SUIVANTE
> ```
>
> > **Le test qui reste, inchangé — et avec sa précondition, leçon VPS-M41** : au passage du
> > **2026-08-18**, `alpine` doit être **ABSENT** (~45 h au ménage de 00 h 40).
> > **Précondition** : que le ménage de 00 h 40 **et** le timer de 03 h 31 tournent tous les deux.
> > Si l'un des deux saute, le test ne dit rien — et c'est justement pour ne pas relire un
> > résultat hors de son domaine de validité que cette ligne existe.
>
> ⚠️ **Et le piège de `docker inspect` se voit à l'œil nu sur la même sortie** : `Created` vaut
> **2026-06-16**, `LastTagTime` **2026-08-16**. **Deux mois d'écart** entre la date amont et la
> date locale, sur l'image même dont l'âge local décide de tout. C'est ce piège qui avait fait
> écarter la bonne explication pendant deux passages.
- **Mesure du 2026-08-16, conservée** : `alpine:latest` **ABSENT** (26 images contre 27 hier, somme 16,79 contre 16,80 Go — l'écart correspond aux ~8 Mo de l'image). La sauvegarde de cette nuit **tirera**, et c'est écrit d'avance. `registry-1.docker.io` répond en 247 ms (401 attendu). **La dépendance a joué 2 fois sur 4 exécutions connues, et la 5e est prévisible.**

> ### ✅ 2026-08-16 — la cause est mécanique, et elle explique les quatre observations
>
> ```
> docker image prune -af --filter "until=24h"     # 00 h 40, tous les jours
> ```
>
> `until=24h` **épargne** ce qui a moins de 24 h et **supprime** le reste. Le tirage a lieu à
> **03 h 31**, donc **après** le ménage du jour : l'image traverse la première nuit avec ~21 h au
> compteur, et meurt à la seconde avec ~45 h. **D'où une alternance de période 2 jours.**
>
> | Exécution | `alpine` présent avant ? | Tirage ? | Âge au ménage de 00 h 40 précédent |
> |---|---|---|---|
> | 08-12 07 h 10 | non | **oui** (5 s sur 7) | — |
> | 08-13 03 h 31 | **oui** | non | tirée le 08-12 à 07 h 10 → **17 h 30** |
> | 08-14 03 h 31 | non | **oui** (3 s sur 8) | la même → **41 h 30** |
> | 08-15 03 h 31 | **oui** | non | tirée le 08-14 à 03 h 31 → **21 h 09** |
> | **08-16 03 h 31** | **non** (vérifié à 02 h 24) | **oui — prévu** | la même → **45 h** |
>
> ### ❌ Pourquoi deux passages avaient ÉCARTÉ cette explication
>
> Le rapport du 08-14 écrivait : *« Le prune nocturne a tourné le 08-13 **comme** le 08-14 […]
> L'image a survécu à l'un et pas à l'autre. Le prune seul n'explique donc pas le phénomène. »*
>
> **Chaque mot est vrai, et la conclusion est fausse.** Ce qui change entre les deux nuits n'est
> pas le déclencheur — c'est la **grandeur sur laquelle il filtre**. La comparaison portait sur
> *« le prune a-t-il tourné ? »* alors que la question était *« quel âge avait l'image quand il a
> tourné ? »*.
>
> > **La règle, écrite pour ne plus la repayer** : quand un déclencheur porte un **filtre**,
> > vérifier qu'il s'est déclenché ne prouve rien. Il faut mesurer **la grandeur que le filtre
> > teste**. C'est la famille de VPS-001 (« la valeur, la fraîcheur du producteur, et la fraîcheur
> > du déclencheur ») avec un quatrième terme que personne n'avait nommé : **le critère du
> > déclencheur**.
>
> ### ⚠️ Le piège qui a coûté ces deux passages est dans `docker inspect`
>
> Le champ `Created` d'une image **tirée** est la date de publication **amont**, pas celle du
> tirage. Vérifié sur la machine :
>
> | Image | `Created` | `Metadata.LastTagTime` |
> |---|---|---|
> | `postgres:17-alpine` | 2026-02-26 | **2026-03-07** |
> | `nginx:alpine` | 2025-12-18 | **2026-01-02** |
>
> `Created` ne dit **rien** de l'âge local, et c'est pourtant la colonne que le collecteur affiche
> pour les images. La grandeur locale est `.Metadata.LastTagTime`.
> ⚠️ **Sa portée, écrite avant qu'elle ne coûte** : c'est la date du dernier **étiquetage**, pas
> strictement du tirage. Sur `tracky-api:latest`, construit à 17 h 05 le 08-15, elle vaut 00 h 05
> le 08-16 — un réétiquetage lors du déploiement suivant. Pour `alpine`, tiré puis jamais
> réétiqueté, les deux coïncident ; pour une image construite localement, cette ligne ne doit
> **pas** être lue comme une date de build.
>
> ### Le test écrit d'avance, qui se tranche gratuitement aux deux prochains passages
>
> - **08-17** : `alpine` doit être **PRÉSENT** (tiré cette nuit, donc ~21 h au ménage) ;
> - **08-18** : `alpine` doit être **ABSENT** (~45 h au ménage).
>
> Si l'un des deux tombe à l'envers, la règle est fausse et il faut chercher ailleurs.
>
> ### ✅ Et ce constat entre ENFIN dans le collecteur
>
> Quatre passages l'ont suivi **à la main**, par une commande tapée en marge : un constat de
> gravité 3 sur le seul chemin de sauvegarde de pièces d'identité, dont la mesure dépendait de la
> mémoire de l'opérateur. La section 11 affiche désormais la **présence ET l'âge local**, et
> **prédit** si la nuit à venir tirera.
>
> ⚠️ **L'`À ne pas faire` de cette fiche est LEVÉ.** Il disait : *« ne pas ajouter une exclusion au
> prune nocturne au cas où — on ne sait pas encore que c'est lui. »* On sait.
- **Mesure du 2026-08-15, conservée** : `alpine:latest` **présent**, mais mesure prise hors de la fenêtre où la question se pose (02 h 21 pour un timer à 03 h 30).
- **Mesure du 2026-08-14, conservée** : `alpine:latest` **de nouveau absent**, retéléchargé à 03 h 31 min 28 — **3 des 8 secondes** de la sauvegarde. La dépendance a joué **2 fois sur 3 exécutions connues**.
- **Mesure à la découverte (2026-08-13)** : 5 des 7 secondes de la sauvegarde du 2026-08-12 sont un `docker pull`

> ### 🔴 2026-08-14 — le seuil que cette fiche s'était écrit est franchi
>
> La fiche disait : *« passer en `A_TRAITER` si `alpine:latest` est constaté **absent** à un
> passage — la dépendance deviendrait alors active à chaque exécution. »*
>
> ```
> Aug 14 03:31:28  backup.sh: Unable to find image 'alpine:latest' locally
> Aug 14 03:31:29  backup.sh: latest: Pulling from library/alpine
> Aug 14 03:31:30  backup.sh: Status: Downloaded newer image for alpine:latest
> ```
>
> | Exécution | `alpine` présent ? | Tirage ? |
> |---|---|---|
> | 2026-08-12 07 h 10 | non | **oui**, 5 s sur 7 |
> | 2026-08-13 03 h 31 | **oui** | non |
> | **2026-08-14 03 h 31** | **non** | **oui**, 3 s sur 8 |
>
> **La dépendance réseau est réelle et récurrente : 2 fois sur 3.** Le seul dispositif de
> sauvegarde de **pièces d'identité** de la machine dépend, à 03 h 30, que `registry-1.docker.io`
> réponde. Il répond aujourd'hui (401 en 245 ms) ; une limite de débit sur les tirages anonymes
> suffirait, dans un chemin qui vient de passer huit jours en échec silencieux (VPS-015).
>
> ### ⚠️ Et la cause de la disparition n'est TOUJOURS pas établie — résister à la conclusion évidente
>
> Le prune nocturne a tourné **le 08-13 comme le 08-14**, à 00 h 40 min 01, vérifié dans les deux
> cas. **L'image a survécu à l'un et pas à l'autre.** Le prune seul n'explique donc pas le
> phénomène, ou pas à tous les coups. C'est la deuxième fois que l'hypothèse évidente est mise à
> l'épreuve sur ce constat et qu'elle ne passe pas — la première était le 2026-08-13, où elle
> avait été réfutée frontalement.
>
> **Le constat reste donc borné à ce qui est mesuré** : *le chemin de sauvegarde contient une
> dépendance réseau, et elle est active deux fois sur trois.* C'est suffisant pour agir : le
> correctif (épingler par empreinte et pré-tirer hors fenêtre) ne demande pas de connaître la
> cause de la disparition.

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

## VPS-027 — L'hyperviseur exécute des commandes en root dans la machine, toutes les heures, et rien ne le regardait

- **Domaine** : sécurité · **Gravité** : 2 · **Statut** : 🔴 **`A_TRAITER` — LE SEUIL DE RÉESCALADE EST FRANCHI (2026-08-20)**
- 🆕 **Vu : 2026-08-26 — L'HYPERVISEUR A REMPLACÉ SON SCRIPT, ET C'EST LE FILTRE QUI L'A APPRIS.**
  **325 exécutions** sur 6,25 jours, **52/jour, régulier à l'unité près** sur les 6 journées
  complètes (52 · 52 · 52 · 52 · 52 · 52) — **la cadence n'a pas bougé**, le seuil de 70 n'est pas
  approché. **Mais la sonde horaire a changé de nom** :

  ```
  scanner.py          264 executions   derniere le 2026-08-25 07:18:01
  usage-telemetry.py   38 executions   PREMIERE le 2026-08-25 08:14:26
  ```

  **Le remplacement a eu lieu le 2026-08-25 entre 07 h 18 et 08 h 14.** Le filtre du collecteur
  étant câblé sur l'ancien nom, il a publié **19 fausses « commandes INATTENDUES »** — voir
  **VPS-M70**, corrigé et contre-éprouvé le jour même (19 → 0). **Vraies commandes inattendues :
  0.** Le lot TRIM quotidien (24 sur la fenêtre) est inchangé.
  ⚠️ **Ce que l'audit ne peut PAS dire** : ce que fait `usage-telemetry.py`. Le script s'autodétruit
  en sortant ; le lire demanderait de le copier **pendant** son exécution, c'est-à-dire une
  écriture. Son nom évoque de la télémétrie d'usage — *c'est une lecture de son nom, pas une
  mesure*, et le référentiel a déjà payé une fois pour avoir affirmé une provenance sans la
  mesurer (VPS-029, 2026-08-20).
  ⚠️ **Le critère de réescalade n'est PAS franchi par ce renommage** : il porte sur une commande
  qui **modifie** autre chose que `fstrim.timer` / `provisioning_mode`. Un script de sonde
  remplacé par un autre script de sonde n'est pas une modification de l'état de la machine — mais
  il fallait le dire, parce que la tentation inverse était forte le matin où l'alarme affichait 19.
- **Vu** : 2026-08-20 · **Mesure du jour** : **365 exécutions** sur 6,75 jours ; **60 le 08-19**, contre un seuil de 70 — série **32 · 52 · 52 · 52 · 53 · 59 · 60**. **11 commandes INATTENDUES** hors sonde horaire et hors lot TRIM (dénominateur : 39 hors sonde, dont **28** de lot TRIM quotidien).
- **Mesure à la découverte (2026-08-18)** : **360 appels `guest-exec` conservés depuis le 2026-08-11**, soit ~50/jour
- **Mesure au 2026-08-19** : **333 exécutions réelles** sur 6,25 jours = **~52/jour** — répartition **8 · 52 · 52 · 52 · 52 · 53 · 59 · 5**, régulière à l'unité près
- **Seuil de réescalade** : ~~passer en `A_TRAITER` si la cadence quotidienne dépasse 70, ou si une commande reçue **écrit ailleurs que dans `/sys` et `/.hstgr-*`**~~ → **ATTEINT le 2026-08-20 par le second critère.**

> ### 🔴 2026-08-20 — LE SECOND CRITÈRE EST FRANCHI : ce canal ÉCRIT DANS `/etc/cron.d`
>
> Le critère écrit le 08-18 était : *« si une commande reçue écrit ailleurs que dans `/sys` et
> `/.hstgr-*` »*. Il est franchi, deux fois, et c'est **VPS-029** :
>
> ```
> 2026-08-18 13:22:05  echo '33 5 * * 4 …' > /etc/cron.d/docker-builder-prune && chmod 644 …
> 2026-08-18 13:22:08  docker builder prune -f --filter unused-for=168h
> 2026-08-19 11:02:38  echo '57 4 * * 4 …' > /etc/cron.d/docker-builder-prune && chmod 644 …
> 2026-08-19 11:02:41  docker builder prune -f
> ```
>
> Un fichier de planification et le cache de build de la machine, écrits par un canal qui n'apparaît
> ni dans `auth.log`, ni pour `fail2ban`, ni pour `ufw`. **La cadence, elle, n'est PAS le problème :
> 60/jour contre un seuil de 70.** C'est bien le second critère qui tranche, et il a été écrit avant
> qu'on sache ce qu'il attraperait.
>
> ### Deux corrections à cette fiche, établies le 2026-08-20
>
> 1. **Le lot TRIM n'est pas ponctuel, il est QUOTIDIEN.** Cette fiche l'a relevé comme un événement
>    du 08-18 entre 03 h 11 min 29 et 03 h 12 min 30. Le journal montre le **même lot de quatre
>    commandes** les 08-14, 08-15, 08-16, 08-17, 08-18 et **deux fois** le 08-19 — soit tous les
>    jours conservés. *Il n'avait rien d'exceptionnel ; il n'avait été regardé qu'une fois.*
> 2. **Le bloc du collecteur affichait « les 3 dernières lignes de commande ».** La sonde horaire
>    faisant ~98 % du journal, ces trois lignes étaient presque toujours trois lignes de routine :
>    les commandes qui **écrivent** ne remontaient jamais. **C'est pour ça que la provenance de
>    VPS-029 est restée invisible alors que la donnée était lue à chaque passage.** Corrigé —
>    **VPS-M50**.
>
> ### ⚠️ Ce que l'audit ne peut PAS trancher, et qu'il ne faut pas trancher à sa place
>
> **Qui envoie ces ordres.** Le canal est le même pour l'hébergeur et pour un humain utilisant la
> console web du panneau hPanel. Le style (ad hoc, itératif, un `docker ps` de reconnaissance avant
> chaque écriture, un script envoyé **encodé en base64** le 08-18 à 14 h 50) évoque une main plutôt
> qu'une routine — **mais ce n'est pas une mesure, c'est une impression, et VPS-029 vient de coûter
> exactement ça.**
>
> **Quoi faire.** La question devient adressable, et elle n'est pas technique : *qui écrit dans
> `/etc/cron.d` de cette machine, et sur quelle base ?* Elle se pose à l'hébergeur et à l'équipe,
> pas à la machine.

> ### 🆕 2026-08-19 — le compteur a été écrit DEUX FOIS, et la première version se trompait ×17
>
> `grep -c 'guest-exec'` rend **5 776** sur la fenêtre conservée — soit *« ~930 exécutions root
> par jour »*, un chiffre alarmant, publiable, et **faux**. `guest-exec-status` est le **sondage
> du résultat**, répété des dizaines de fois pour une seule exécution :
>
> | Motif | Compte | Ce que c'est |
> |---|---:|---|
> | `guest-exec called` | **333** | ⬅️ les **exécutions**, ~52/jour |
> | `guest-exec-status called` | **5 443** | le sondage du résultat — **ratio > 17 pour 1** |
> | `guest-file-open called` | 451 | l'écriture du script |
>
> **C'est VPS-M01 et VPS-M46 une troisième fois** : *un compteur doit prouver qu'il compte ce
> qu'il prétend compter.* Le collecteur affiche donc les deux nombres **côte à côte**, avec le
> ratio en toutes lettres — un lecteur pressé ne peut plus refaire l'erreur en silence.
>
> **Et la mesure confirme l'estimation initiale** (« ~50/jour ») : elle était juste. C'est
> l'estimation naïve qu'on aurait faite *en automatisant* qui était fausse — l'automatisation
> d'un comptage est exactement le moment où le motif cesse d'être relu.

> ### ❌ 2026-08-19 — une hypothèse contre l'hyperviseur, réfutée avant d'être publiée
>
> Le stamp du cache `apt` porte **2026-08-18 03 h 11 min 37**, et l'hyperviseur exécutait son lot
> root à **03 h 11 min 29**. Huit secondes d'écart : l'hypothèse *« l'hébergeur rafraîchit notre
> cache de paquets »* était séduisante et aurait fait un constat spectaculaire.
>
> `journalctl -u apt-daily.service` la réfute en une ligne : l'unité a démarré à **03 h 11
> min 30** et consommé **21,392 s**. **C'est `apt-daily` qui a écrit le stamp. L'hyperviseur est
> hors de cause.**
>
> **La leçon, symétrique de celle du 08-18** : VPS-027 rend toute coïncidence horaire suspecte —
> et c'est un biais dans **les deux sens**. *Deux mécanismes qui se déclenchent dans la même
> minute ne sont pas le même mécanisme.* Un constat récent et marquant devient le coupable par
> défaut de tout ce qui arrive ensuite.

**Quoi.** L'agent invité QEMU (`qemu-ga`, PID 3988652) reçoit de l'hôte des ordres d'exécution
arbitraires, en **root**, et les exécute. Trois familles, relevées dans `journalctl -t qemu-ga` :

| Cadence | Ce qui est exécuté |
|---|---|
| **toutes les heures**, ~:15 | écriture de `/.hstgr-<epoch>.scanner.py` puis `timeout -s TERM -k 3660 3600 /bin/sh -c "trap 'rm …' 0; python3 /.hstgr-….scanner.py"` |
| **toutes les heures**, ~:35 | `sh -c "ps -eo vsz,rss,%cpu,time,etimes,command --sort=-%cpu --no-header"` |
| plusieurs fois par heure | lecture de `/proc/meminfo` |

Et, le **2026-08-18 entre 03 h 11 min 29 et 03 h 12 min 30**, quatre ordres qui ne sont plus de la
lecture :

```
su - root -c systemctl enable fstrim.timer
su - root -c [[ $(cat $(find /sys/ -name provisioning_mode | head -n 1)) != 'unmap' ]] \
             && echo unmap > $(find /sys/ -name provisioning_mode | head -n 1)
fstrim -v --minimum 0 /
fstrim --listed-in /etc/fstab:/proc/self/mountinfo --verbose
```

**L'hébergeur active un timer systemd, écrit dans `/sys`, et déclenche un `fstrim`** sur une
machine dont l'audit prétend tenir le catalogue de tout ce qui se déclenche seul.

**Pourquoi c'était invisible — et c'est le vrai sujet.** Le dispositif surveille **trois** couches
et croyait les tenir toutes : le VPS (crons, timers, sondes), le poste (tâches planifiées), et le
permanent (healthchecks). **Il en existe une quatrième, au-dessus**, et elle n'entre par aucune
des portes que l'audit garde :

| Garde existant | Pourquoi il ne voit rien |
|---|---|
| VPS-012 — empreintes SSH, 1 095 connexions, 2 clés | `guest-exec` **ne passe pas par SSH** : aucune ligne dans `auth.log` |
| `fail2ban` | rien à voir : ce n'est pas une authentification |
| Pare-feu `deny (incoming)`, 4 ports | le canal est un **virtio-serial**, pas le réseau |
| Section 7 — crontab, `cron.d`, 16 timers | l'ordre vient de **l'extérieur de la machine** |

Trois passages ont vérifié « aucune clé inconnue » et l'ont écrit comme une conclusion sur les
accès root. **La conclusion était juste sur son périmètre, et le périmètre n'était pas celui qu'on
croyait.** C'est la famille VPS-018 (*« le nom du dossier a été pris pour le périmètre du
dossier »*), portée d'un cran : ici c'est le **catalogue** qui a été pris pour l'inventaire.

### ⚠️ Ce que ça coûte immédiatement : un constat a été clos sur une prémisse fausse

Le rapport du 2026-08-17 a fermé l'hypothèse *« `fstrim` déclenche la boucle de `dockerd` »* par un
argument **chronologique** :

> *« `fstrim.timer` est hebdomadaire **le lundi**, or l'occurrence 1 a démarré un **mercredi** et
> l'occurrence 3 un **mardi** — 2 sur 3 incompatibles. »*

**La prémisse est fausse.** `fstrim` ne tourne pas seulement le lundi : l'hyperviseur le déclenche
à la demande, n'importe quel jour — il l'a fait **ce matin, un mardi, à 03 h 11 min 34**. L'argument
qui a fermé la piste ne tient plus.

⚠️ **Et il ne peut plus être refait** : `journalctl -t qemu-ga` ne remonte qu'au **2026-08-11 à
07 h 12**, alors que les occurrences 1 et 2 datent des 08-05 et 08-10. **La donnée qui trancherait
a été rotée.** La piste `fstrim` repasse donc de `FERMÉE` à **`NON TRANCHÉE`**, et elle le restera :
c'est un coût définitif.

> **La leçon** : *une hypothèse fermée par un raisonnement, et non par une mesure, ne vaut que ce
> que vaut sa prémisse la plus faible — et une prémisse sur « ce qui peut déclencher X » suppose
> qu'on connaisse tous les acteurs.* VPS-024 l'avait dit dans l'autre sens (*« un constat qui énonce
> son critère de réfutation se ferme au passage suivant »*) ; celui-ci ajoute le symétrique : **une
> fermeture par raisonnement doit lister ce qu'elle suppose connu.**

**Quoi faire.** Rien dans l'urgence — c'est le fonctionnement normal d'un VPS managé, et couper
l'agent retirerait à l'hébergeur la console de secours qui a servi de filet lors du durcissement
SSH (VPS-002). Ce qui doit changer, c'est que ce soit **vu** :

1. **Porter cette couche dans `ordonnancement`** — fait ce passage. C'est le seul endroit où les
   collisions d'horaires se voient.
2. **Compter et publier les `guest-exec` à chaque passage** (angle mort n° 1 du rapport du
   2026-08-18) : un `journalctl -t qemu-ga | grep -c` et les 3 dernières lignes de commande. Coût :
   une lecture de journal, aucun fork Docker.
3. **Décider en connaissance de cause**, ce qui suppose de savoir ce que fait le script. Il
   s'autodétruit (`trap … 0`), donc le lire demande de le copier **pendant** son exécution — une
   écriture, hors de cet audit. C'est une question à poser à l'hébergeur, pas à la machine.

**Seuil de réescalade** : passer en `A_TRAITER` si un `guest-exec` **modifie autre chose** que
`fstrim.timer` / `provisioning_mode` (ces deux-là sont des réglages de TRIM, cohérents avec un
stockage en surprovisionnement), ou si le nombre d'appels quotidiens double.

**À ne pas faire** : désactiver `qemu-guest-agent`. On perdrait la console de secours et le
redimensionnement à chaud, pour un risque qui n'est pas une intrusion mais une **dépendance
contractuelle** — et on la découvrirait au pire moment, exactement comme `/opt/foodsqan` (VPS-021).

---

## VPS-028 — ~~Quatre `.example` commités portent les vraies valeurs de production~~ → **ENTIÈREMENT RÉFUTÉ : il n'y avait aucun secret, pas même en développement**

- **Domaine** : sécurité · **Gravité** : — · **Statut** : `ACCEPTE` (**réfuté** le 2026-08-18, en deux temps, avant toute action irréversible)
- **Vu** : 2026-08-18 · **Mesure** : sur les **20** « valeurs identiques » relevées, **une seule est un secret**, et c'est une valeur de **développement**. Les cinq bases de production portent des mots de passe de **32 à 64 caractères** ; aucun n'a fuité.

> ### ❌ 2026-08-18, 08 h 45 — CE CONSTAT ÉTAIT SURÉVALUÉ, ET LA ROTATION AURAIT ÉTÉ VAINE
>
> Le constat annonçait, en gravité 1 : *« les secrets sont dans quatre dépôts GitHub, hors de cette
> machine »*, et recommandait une **rotation**. Avant de l'exécuter — sur l'authentification de
> toutes les applications, un mardi à 08 h 45 — les valeurs concernées ont été **nommées**. Elles ne
> sont pas ce que le constat disait.
>
> | Ce qui a « fuité » | Nature réelle |
> |---|---|
> | `APP_DOMAIN`, `LP_DOMAIN`, `APP_URL`, `PUBLIC_ORIGIN`, `PUBLIC_BASE_URL`, `ADMIN_BASE_URL`, `DASHBOARD_URL`, `VIZYO_AUTH_API_URL`, `VIZYO_LEADS_API_URL`, `REDIS_URL` | **des URL et des noms de domaine** — publics par construction |
> | `TRAEFIK_NETWORK`, `STORAGE_DIR`, `POSTGRES_DB`, `JWT_ISSUER`, `VAPID_SUBJECT`, `RESEND_FROM_EMAIL` | **de la configuration** — un nom de réseau, un chemin, un nom de base, une adresse d'expéditeur |
> | `DATABASE_URL` (vizyo-leads, vizyo-auth *dev*, 2 `.example`) | contient le mot de passe **`password`** — vérifié : son `sha256` vaut `5e884898da28…`, c'est le **défaut**, pas un secret |
> | **`JWT_SECRET`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`** (vizyo-auth) | **les seuls vrais secrets** — 13 caractères, et de **DÉVELOPPEMENT** |
>
> ### La production n'est pas concernée, et c'est vérifié à deux endroits
>
> ```
> JWT_SECRET          example=211c3a6bf59e   dev=211c3a6bf59e   PROD=2593c20f13c8   different
> JWT_ACCESS_SECRET   example=211c3a6bf59e   dev=211c3a6bf59e   PROD=a2bdefba9951   different
> JWT_REFRESH_SECRET  example=211c3a6bf59e   dev=211c3a6bf59e   PROD=c96708b09e8d   different
> ```
>
> Vérifié **dans le fichier** (`/opt/vizyo-auth/.env`) **et dans l'environnement du conteneur en
> service** (`docker exec vizyo-auth-api printenv`) : **44 caractères**, et différents des trois.
> *Un fichier sur disque ne prouve pas ce qu'un processus utilise — d'où les deux lectures.*
>
> Et les cinq bases de production :
>
> | Base | Longueur du mot de passe | Est-ce `password` ? |
> |---|---:|---|
> | `vizyo-auth-db` | **44** | non |
> | `tracky-postgres` | **64** | non |
> | `vizyo-verify-postgres` | **48** | non |
> | `vizyo-manager-postgres` | **32** | non |
> | `texto-postgres` | **32** | non |
>
> `vizyo-auth-db` ne publie **pas** son port sur `0.0.0.0` : réseau Docker interne seulement.
>
> ### ❌❌ SECOND TEMPS, 09 h 20 — le « seul vrai secret » était un MARQUEUR, lui aussi
>
> Après la première correction, il restait **une** ligne présentée comme un vrai secret fuité : le
> JWT de développement de `vizyo-auth`, 13 caractères. La rotation en a été demandée, et acceptée.
> **En l'exécutant, le `git diff` a affiché l'ancienne valeur :**
>
> ```
> - JWT_SECRET=dev_change_me
> ```
>
> **`dev_change_me`.** Treize caractères qui disent littéralement *« change-moi »*. Ce n'est pas un
> secret oublié : c'est un **marqueur de gabarit**, et mon détecteur de marqueurs ne l'a pas
> reconnu **à cause d'un tiret bas** — il cherchait `changeme`, `CHANGEME`, `your[-_]`,
> `placeholder`… et la chaîne s'écrit `change_me`.
>
> ### ⚠️ Et la « correction » que j'allais commiter était une RÉGRESSION, sur deux plans
>
> Le dépôt contient une **garde de production** dans `apps/api/src/config/env.validation.ts` :
>
> ```js
> const weakSecrets = ['dev_change_me', 'dev_admin_change_me', 'change_me', 'secret'];
> if (weakSecrets.some(weak => env.JWT_SECRET.includes(weak))) throw new Error('Production requires strong JWT_SECRET…');
> ```
>
> `dev_change_me` n'est donc pas une négligence : c'est une valeur **délibérément reconnaissable**,
> que le code **refuse de laisser démarrer en production**. Ma modification aurait :
>
> | Ce que j'allais faire | Conséquence |
> |---|---|
> | mettre un vrai secret de 44 car. dans `.env.development` | **introduire un vrai secret dans un fichier SUIVI PAR GIT**, là où il n'y en avait aucun |
> | mettre `<generer: openssl rand -base64 32>` dans `.env.example` | **désarmer la garde** — vérifié : cette chaîne **passe** le contrôle de production |
>
> ```
> 🛑 REFUSE en prod    dev_change_me (le marqueur actuel)
> ✅ accepte en prod   <generer: openssl rand -base64 32>  (ce que j allais mettre)
> ```
>
> **La branche a été supprimée, le dépôt est revenu sur `main`, arbre propre, rien n'a été poussé.**
>
> > **La leçon, et elle est plus dure que la première** : *un « correctif » de sécurité doit prouver
> > qu'il laisse le système au moins aussi protégé qu'il l'a trouvé.* Ici la mesure de sécurité
> > existait déjà, dans le code, en évidence — et le correctif proposé l'aurait contournée. C'est le
> > symétrique exact de VPS-M31 (*un garde-fou qui cache un défaut est plus dangereux qu'un
> > garde-fou absent*) : ici, **un correctif qui retire un garde-fou est pire que le défaut qu'il
> > croit corriger**.
>
> ### Bilan des deux temps
>
> | Ce qui était annoncé | Ce qui était vrai |
> |---|---|
> | « 20 valeurs de production fuitées dans 4 dépôts GitHub » | **19 configurations** (URL, domaines, noms) **+ 1 marqueur** `dev_change_me` |
> | « gravité 1, rotation requise » | **rien à faire** — et la rotation aurait désarmé une garde |
>
> **Zéro secret. Deux détecteurs faux. Une remédiation dangereuse évitée deux fois.**

> ### La cause de l'erreur : un détecteur qui comptait des URL comme des secrets
>
> Le motif employé contenait `_URL` et un seuil de 12 caractères — donc
> `APP_URL=https://app-tracky.vizyoagency.com` **compte comme une ligne sensible**. Sur 20 valeurs
> identiques, **19 étaient de la configuration**. Voir **VPS-M46**.
>
> ### Ce qui reste vrai, et c'est peu
>
> 1. **Un secret JWT de développement (13 caractères) est dans `vizyo-auth` sur GitHub.** Sans effet
>    sur la production, mais 13 caractères est faible et un `.example` n'a aucune raison de porter
>    une vraie valeur. *À corriger au fil de l'eau, dans le dépôt — pas sur le VPS.*
> 2. Les `.example` gagneraient à porter de vrais marqueurs (`<votre-cle>`). **C'est de l'hygiène,
>    pas un incident.**
>
> **À ne pas faire — et c'est le cœur de la correction** : exécuter la rotation qui avait été
> demandée. Elle aurait coupé les sessions de tous les utilisateurs de toutes les applications, un
> mardi matin, **pour remplacer des noms de domaine par d'autres noms de domaine**.
>
> > *Le coût d'un constat surévalué n'est pas l'inquiétude qu'il crée : c'est l'action dangereuse
> > qu'il justifie.* Un constat sous-évalué se paie en incident ; un constat surévalué se paie en
> > remédiation inutile sur un système sain — et celle-ci était irréversible.

---

## VPS-029 — Un second mécanisme gouverne le cache de build, posé hier après-midi, et le catalogue ne l'aurait pas montré

- **Domaine** : docker · **Gravité** : **3** (était 4) · **Statut** : ✅ **volet SYMPTÔME `APPLIQUE` le 2026-08-20 à 05 h 39 (filtre remis, `RELOAD` confirmé) · volet CAUSE INTACT : on ignore toujours qui écrit ce fichier**
- **Vu** : 2026-08-21 · **Mesure du jour** : le fichier porte toujours `--filter "unused-for=168h"` et sa date du **2026-08-20 05 h 39**. **Aucune troisième écriture `guest-exec`** — les 11 commandes inattendues du journal de l'hyperviseur sont **toutes historiques** (17, 18 et 19 août). Le détecteur de fraîcheur a signalé `🆕 docker-builder-prune (modifié il y a 0 j)` : **c'est notre propre geste du 08-20**, exactement comme le rapport de la veille l'avait écrit d'avance pour que ce passage ne le prenne pas pour un incident.
- ✅ **2026-08-21 — L'ARBITRAGE EST TRANCHÉ PAR LA MESURE, ET C'EST VPS-031 QUI LE TRANCHE.** La fiche demandait si le cron non filtré était « redondant » ou s'il faisait quelque chose de plus. Le 08-20 a répondu « quelque chose de plus » : 4,5 Go retirés que BuildKit gardait délibérément. **Le 08-21 complète la réponse : ce qu'il fait ne dure pas.** `Private` est remonté de **5,057 à 9,543 Go en 23 h** — soit **+4,486 Go**, à 0,025 Go près la valeur d'avant la purge — sous l'effet d'**un seul build**, à 23 h 40. *On a payé un premier build 2 à 4× plus long, sur une machine qui avait 44 Go libres, pour un gain qui a duré moins d'une journée.* **Le filtre remis le 08-20 est donc le bon réglage**, et pour une raison qu'on ne pouvait pas connaître avant de mesurer : **le cache de build n'est pas un stock qu'on vide, c'est un flux qui se reconstitue au premier build.**

> ### ✅ 2026-08-20, 05 h 39 min 05 — le filtre est remis, et la preuve est POSITIVE
>
> | | |
> |---|---|
> | Avant | `57 4 * * 4 root docker builder prune -f > /dev/null 2>&1` |
> | Après | `57 4 * * 4 root docker builder prune -f --filter "unused-for=168h" > /dev/null 2>&1` |
> | Sauvegarde | `/root/docker-builder-prune.bak-20260820-053905` (`cp -p`) |
> | Droits | `644 root:root` — inchangés · fichier terminé par une nouvelle ligne (vérifié) |
> | Prochaine échéance | **jeudi 2026-08-27 à 04 h 57 UTC** |
>
> **La confirmation ne vient PAS d'une absence d'erreur** — c'était le piège VPS-M02, et il était
> tendu : `journalctl -u cron --since -2min` rendait `-- No entries --`. En attendant le scan
> suivant :
>
> ```
> 2026-08-20T05:40:01  cron[748]: (*system*docker-builder-prune) RELOAD (/etc/cron.d/docker-builder-prune)
> ```
>
> `cron` relit `/etc/cron.d` chaque minute : aucun redémarrage. Et le même journal porte le
> `RELOAD` du **08-19 à 11 h 03 min 01**, 23 s après l'écriture de l'hyperviseur — *le même
> mécanisme observé deux fois, ce qui vaut mieux qu'une explication.*
>
> **Le fichier porte désormais un en-tête de commentaires** disant pourquoi le filtre est là et ce
> qu'a coûté sa disparition. Même intention que le `NE-PAS-SUPPRIMER.txt` de VPS-021 : rendre le
> piège lisible **là où quelqu'un ouvrira le fichier**. Le collecteur filtre les commentaires, donc
> la section 7 continue d'afficher la seule ligne active.
>
> ### ⚠️ Ce correctif déclenchera le détecteur VPS-M50 au passage du 08-21 — et c'est NOUS
>
> Le bloc de fraîcheur posé le matin même signalera `🆕 2026-08-20 05:39 … docker-builder-prune`.
> **Ne pas le lire comme une troisième réécriture par l'hyperviseur** : `journalctl -t qemu-ga |
> grep cron.d` ne montre que les deux écritures des 08-18 et 08-19. *Un détecteur neuf produit son
> premier signal sur le geste de celui qui l'a posé ; si ce n'est pas écrit, le passage suivant le
> prend pour un incident.*
>
> ### ⚠️ Le volet CAUSE n'a pas bougé d'un octet
>
> Remettre le filtre traite la **conséquence**. Ce fichier a été écrit deux fois par un canal qui
> n'apparaît dans **aucun** journal d'authentification (VPS-027), et rien n'empêche de le retrouver
> modifié jeudi prochain.
>
> > **Test écrit d'avance, avec sa précondition.** *Au passage du **2026-08-28** — lendemain de
> > l'échéance —, le fichier doit porter la date du 2026-08-20 et contenir toujours
> > `--filter "unused-for=168h"`, et `Private` ne doit **pas** avoir chuté de plusieurs Go entre le
> > 08-27 et le 08-28. Si le filtre a disparu, un tiers réécrit ce fichier de façon répétée et
> > **VPS-027 passe en gravité 1**.* **Précondition** : que personne d'autre n'y ait touché entre
> > temps — vérifiable par la date de modification, désormais publiée à chaque passage.

- **Statut du matin du 2026-08-20** : `SURVEILLANCE` — 🔴 **PROVENANCE RÉFUTÉE et CONTENU MODIFIÉ**
- **Vu** : 2026-08-20 · **Mesure du soir** : 🔴 **LE CRON A TOURNÉ À 04 h 57 min 01, PENDANT 53 SECONDES, ET IL N'EST PAS REDONDANT.** `Private` est passé de **9,568 Go à 5,057 Go** — il a retiré **4,5 Go que le ramasse-miettes gardait délibérément**, alors que `Private` était **sous** la borne `keepStorage` de 10 Go. Total `docker system df` 11,37 → **6,863 Go**, entrées 74 → **60**, disque 55 % → **50 %** (48 Go libres). La question que cette fiche posait — *« redondant et inoffensif » ou « il fait quelque chose que le ramasse-miettes ne fait pas » ?* — est **tranchée par les faits, et sans la précondition « au moins un build »** : c'est la seconde réponse. ⚠️ **Le coût, chiffré honnêtement** : 4,5 Go rendus sur une machine qui avait déjà 44 Go libres — *un gain dont personne n'avait besoin* — contre un premier build 2 à 4× plus long sur chaque projet, chaque jeudi. Sur 2 vCPU, c'est le mauvais côté de l'échange. ⚠️ Et `sar` en porte la trace : l'inactivité tombe à **11,25 %** sur la tranche 04 h 50 → 05 h 00, contre ~40 % les six tranches précédentes.
- **Mesure du matin** : le fichier a été **RÉÉCRIT le 2026-08-19 à 11 h 02 min 38** — il a **perdu son filtre** et changé d'horaire. Prochaine échéance : **jeudi 2026-08-20 à 04 h 57 UTC**. Toujours jamais exécuté par `cron`.
- **Mesure du 2026-08-19, conservée** : créé le 2026-08-18 à 13 h 22 min 06, jamais exécuté, première échéance annoncée au jeudi 2026-08-20 à 05 h 33 UTC.

```
57 4 * * 4 root docker builder prune -f > /dev/null 2>&1          ← aujourd hui (08-19 11h02)
33 5 * * 4 root docker builder prune -f --filter "unused-for=168h" ← version du 08-18 13h22
```

> ### 🔴 2026-08-20 — LA PROVENANCE INSCRITE ICI ÉTAIT FAUSSE, ET LA PREUVE ÉTAIT DANS LA COLLECTE
>
> Ce constat affirmait, sous `aNePasFaire` : *« Il a été créé par une **action humaine délibérée**
> le 08-18 à 13 h 22, **hors de toute session d'audit**. »* Le journal `qemu-ga` — **que la
> section 7 du collecteur lit à chaque passage** — dit autre chose :
>
> ```
> 2026-08-18 13:22:05  guest-exec: su - root -c echo '33 5 * * 4 root docker builder prune -f
>                      --filter "unused-for=168h" …' > /etc/cron.d/docker-builder-prune
> 2026-08-18 13:22:08  guest-exec: su - root -c docker builder prune -f --filter unused-for=168h
> 2026-08-19 11:02:38  guest-exec: su - root -c echo '57 4 * * 4 root docker builder prune -f
>                      > /dev/null 2>&1' > /etc/cron.d/docker-builder-prune
> 2026-08-19 11:02:41  guest-exec: su - root -c docker builder prune -f > /dev/null 2>&1
> ```
>
> **Le fichier a été écrit par le canal de l'HYPERVISEUR, pas par SSH.** Le mot « humaine » était
> peut-être juste — ces commandes sont ad hoc et itératives, ce qu'une routine d'hébergeur ne fait
> pas — mais il a été **affirmé sans être mesuré**. Et l'audit **ne peut pas** distinguer ici
> l'hébergeur d'un humain utilisant la console web du panneau : les deux entrent par la même porte
> (VPS-027). *La bonne phrase n'était pas « c'est humain », c'était « c'est arrivé par un canal
> que quinze passages de vérification SSH ne peuvent pas voir ».*
>
> ### ⚠️ Le filtre a disparu, et tout le raisonnement reposait dessus
>
> | | posé le 08-18 | **réécrit le 08-19** |
> |---|---|---|
> | Horaire | jeudi 05 h 33 | **jeudi 04 h 57** |
> | Filtre | `--filter "unused-for=168h"` | **aucun** |
>
> La fiche concluait : *« le filtre du cron (168 h) est plus faible que celui du ramasse-miettes
> (48 h) ; tout ce qu'il voudrait supprimer a déjà été supprimé cinq jours plus tôt. **Il ne devrait
> rien trouver.** »* **Sans filtre, c'est l'inverse** : `docker builder prune -f` purge tout le
> cache inutilisé quel que soit son âge. Il est désormais **plus agressif** que le ramasse-miettes.
>
> ### ⚠️ Conséquence : le 8e point de VPS-001 n'est plus attribuable
>
> `Private` fait **10,39 → 11,31 → 10,33 → 12,54 → 10,70 → 11,19 → 10,65 → 9,57**. Sept passages
> ont attribué ce retour à la borne au ramasse-miettes. **Le huitième a deux causes candidates**,
> et la seconde est datée : un `docker builder prune -f` **non filtré** le 08-19 à 11 h 02 min 41.
> Le ramasse-miettes a bien tourné aussi (`cache.db` écrit 10 s après le build de 17 h 21).
> **Les deux ont agi ; leur part respective n'est pas mesurable.**
>
> ### ⚠️ Le test écrit d'avance est CADUC — et il ne faut pas le lire quand même
>
> Le 08-19 posait : *« au 08-21, `Private` doit être dans 10,3 – 12,6 Go ; précondition : ≥ 1 build
> entre le 08-20 05 h 33 et la collecte. »* **Trois de ses termes sont morts** : l'heure (04 h 57),
> le filtre, et **la bande elle-même** — `Private` vaut 9,57 Go aujourd'hui, hors bande, **avant que
> le cron n'ait jamais tourné**. Une bande dérivée de sept points s'est révélée trop étroite au
> huitième.
>
> > **La leçon** : *un test écrit d'avance vaut par sa précondition, et il lui manquait la plus
> > élémentaire — que l'objet mesuré n'ait pas changé entre-temps.* VPS-M41 disait « si l'incident
> > cesse, le test ne dit rien » ; il faut ajouter : **« si le MÉCANISME est réécrit, le test ne dit
> > rien non plus »**.

**Quoi.** Le cache de build Docker est le poste que cet audit suit de plus près : **VPS-001**, sept
points consécutifs, chacun concluant que `Private` *« revient à sa borne grâce au ramasse-miettes
de BuildKit »*. Depuis hier 13 h 22, **ce n'est plus le seul acteur** : un cron hebdomadaire purge
le même objet.

| Mécanisme | Où | Politique | Cadence |
|---|---|---|---|
| Ramasse-miettes BuildKit | `daemon.json` | `keepStorage 8 Go` + `unused-for=48h`, puis `10 Go` sur tout | **permanent**, à chaque build |
| 🆕 `docker-builder-prune` | `/etc/cron.d` | `--filter unused-for=168h` | **hebdomadaire**, jeudi 05 h 33 |

**Ce n'est très probablement pas nuisible, et il faut le dire aussi précisément que le reste** :
le filtre du cron (**168 h**) est **plus faible** que celui du ramasse-miettes (**48 h**). Tout
ce que le cron voudrait supprimer a déjà été supprimé cinq jours plus tôt. **Il ne devrait rien
trouver.** Coût : quelques secondes par semaine.

**Le coût réel n'est pas la ressource, c'est l'interprétation.** À partir de jeudi, la série
`Private` de VPS-001 aura **deux causes candidates** au lieu d'une, et le rapport qui écrirait
*« le ramasse-miettes a tourné »* ne pourrait plus le prouver par la seule valeur. C'est
exactement ce que la doctrine §6 bis met en garde : *« préférer ce qui s'autorégule à ce qui se
planifie — un mécanisme unique et permanent, donc aucun risque de doublon : le défaut VPS-003 »*.
**VPS-003, c'était deux planificateurs pour la même sauvegarde.** Ici, deux pour le même cache.

**`pourquoiInvisible`.** Il ne l'était pas — il est apparu **hier**, et il est relevé à son
premier passage. Mais il a été trouvé **en relisant la section 7 à la main**, pas parce que
quelque chose l'a signalé : *le catalogue `ordonnancement` liste ce qui se déclenche seul, et
n'a aucune notion de « nouveau depuis le passage précédent »*. Un cron ajouté puis retiré entre
deux passages ne laisserait aucune trace.

**Quoi faire.** Rien dans l'immédiat — **le laisser tourner jeudi et mesurer**. C'est la seule
manière de trancher entre « redondant et inoffensif » et « il fait quelque chose que le
ramasse-miettes ne fait pas ». Décider avant la mesure, c'est le défaut VPS-011 (*un gain non
mesurable n'est pas un gain*) pris à l'envers.

> **Test écrit d'avance, avec sa précondition.** *Au passage du **2026-08-21**, `Private` doit
> se trouver dans sa bande habituelle (10,3 – 12,6 Go). S'il est **nettement en dessous**, le
> cron a retiré ce que le ramasse-miettes gardait, et l'attribution des sept points de VPS-001
> doit être rouverte.* **Précondition** : au moins un build entre le 08-20 05 h 33 et la
> collecte — sinon `Private` est figé et la mesure ne discrimine rien.

**`aNePasFaire`.** ⚠️ **Ne pas supprimer ce cron sans demander pourquoi il a été posé.** ~~Il a été
créé par une action humaine délibérée le 08-18 à 13 h 22, hors de toute session d'audit~~ →
**RÉFUTÉ le 2026-08-20** (voir l'encadré ci-dessus) : il a été écrit **par le canal `qemu-ga` de
l'hyperviseur**, deux fois, et la seconde fois sans son filtre. *(Le seul autre changement de
configuration de la journée du 08-18 est `daemon.json` à 06 h 04, qui est le `live-restore` du
rapport du 08-18 — celui-là est expliqué.)* ⚠️ **Et l'effacer sans traiter la source donne
l'illusion de l'avoir réglé** : il a déjà été réécrit une fois. ⚠️ **Et ne pas le confondre avec
`/etc/cron.d/docker-image-prune`**, qui date du 2026-04-16, purge les **images** et non le
**cache**, et dont le passage de 00 h 40 est ce qui a rendu 13 Go cette nuit.

**Note de méthode, au passage** : les deux lignes de `/etc/cron.d/e2scrub_all` sont **inertes** —
elles portent le garde `test -e /run/systemd/system ||`, et ce chemin existe. Seul
`e2scrub_all.timer` agit. Le catalogue avait raison de ne lister que le timer ; c'est vérifié,
pas supposé (même famille que VPS-M04, le crontab Alpine).

---

## VPS-030 — 1,70 Go de sauvegardes empilées hors de toute rétention, dans **deux** dossiers, et hors de tous les contrôles

- **Domaine** : disque · **Gravité** : 3 · **Statut** : `A_TRAITER`
- **Vu : 2026-08-26** · **Mesure du jour** : **inchange — 13 fichiers, 1,70 Go, deux endroits** (`/root/backups` 1 679,3 Mo en 12 fichiers ; `/opt/backups/tracky` 57,0 Mo en 1 fichier, **36 jours**). Aucune retention de la machine ne couvre ces chemins : ces octets ne seront enleves par **rien**. Gain recuperable inchange : **~1,5 Go** sur `/root/backups` seul.
- 🔴 **Vu : 2026-08-25 — IL Y A UN SECOND DOSSIER, ET LE CONSTAT NE LE NOMMAIT PAS.** Le balayage **par contenu** ajouté ce passage (angle mort n° 4, fermé au 5ᵉ report) rend **13 fichiers, 1,70 Go, en DEUX endroits** :

  ```
  /root/backups          1 679,3 Mo en 12 fichiers   (18-19 aout, deja connus)
  /opt/backups/tracky       57,0 Mo en  1 fichier    <- 2026-07-21, 35 JOURS, JAMAIS SIGNALE
  ```

  Le fichier neuf est `positions-avant-purge60j-20260721-163020.sql.gz` : un instantané pris avant une purge de la table `positions`, oublié depuis cinq semaines.

  **⚠️ ET LES OCTETS ÉTAIENT AFFICHÉS DEPUIS TOUJOURS.** La section 3 du même collecteur imprime `58M /opt/backups` à chaque passage, dans la répartition de `/opt`. Ce qui manquait n'était pas la donnée, **c'était la question** : personne n'avait demandé *« ce dossier contient-il des sauvegardes ? »*, il était lu comme un poste de disque parmi seize. *Troisième occurrence en quatre passages — VPS-034 (la socket Docker était dans `INSPECT_JSON`), VPS-M45 (les clients Docker), celui-ci. Un audit ne bute pas sur ce qu'il ne collecte pas, il bute sur ce qu'il collecte sans l'interroger.*

  ⚠️ **`/opt/backups/tracky` NE SE TRAITE PAS COMME `/root/backups`** : c'est l'instantané d'avant une purge de `positions`, donc **la seule trace connue des lignes purgées**. Le supprimer se décide côté produit, pas côté disque. Le gain récupérable reste chiffré à **~1,5 Go**, sur `/root/backups` seul.
- **Vu** : 2026-08-20 · **Mesure à la découverte** : `/root/backups` = **1,7 Go, 15 fichiers**, dont **11 dumps `tracky-avant-graphiques-*.sql.gz` de 138 à 152 Mo, tous des 18 et 19 août** (~1,63 Go). `/root` mesuré passe de **1,4 à 1,7 Go en 24 h**.

**Quoi.** Onze sauvegardes de pré-déploiement de `tracky_prod`, prises à chaque itération d'une
même session de travail — 03 h 59, 05 h 31, 05 h 46, 13 h 51, 21 h 13, 21 h 32, 21 h 50, 21 h 57 le
18 août, puis 01 h 49 et 02 h 50 le 19. Elles sont dans `/root/backups`, pas dans `/var/backups`.

**Pourquoi c'est invisible, et c'est le vrai sujet.** La section 11 du collecteur pose la bonne
question — *« chaque application a-t-elle une copie récente ? »* — mais elle énumère les **dossiers
de `/var/backups`**. `/root/backups` n'en est pas un :

| Contrôle | Pourquoi il ne voit rien |
|---|---|
| « âge de la dernière sauvegarde par dossier » | n'énumère que `/var/backups/*` |
| détecteur de doublons de sauvegarde | même périmètre |
| rétention de `backup-db.sh` | ne connaît que son propre dossier de destination |
| ligne `du -sh /root` de la section 3 | affiche **un total**, qui ne dit pas ce qu'il contient |

C'est **VPS-013 à l'identique, dans l'autre sens** : là-bas une base sans dossier était absente de
la liste, et l'absence se lisait « rien à signaler » ; ici un dossier hors périmètre est bien
présent sur le disque et absent de **tous** les contrôles. *Un contrôle défini par un chemin ne dit
rien de ce qui vit ailleurs — et il ne signale pas qu'il n'en dit rien.*

**Ce que ça coûte.** 1,66 Go aujourd'hui, **et rien ne les enlèvera jamais** : aucune rétention ne
couvre ce chemin. Au rythme observé — 10 dumps en 48 h pendant une session de déploiement — un mois
de travail comparable ajouterait plusieurs gigaoctets sans qu'aucune alerte ne se déclenche.

**Quoi faire.** Lire d'abord, jamais supprimer d'abord :

```bash
ls -1t /root/backups/tracky-avant-graphiques-*.sql.gz | tail -n +2
```

**Gain** : ~1,5 Go en gardant la plus récente.
**Risque** : faible — ce sont des copies *supplémentaires* d'une base qui a par ailleurs 55 copies
dans `/var/backups`, dont la dernière est relue et complète.
**Contrepartie** : on perd la possibilité de revenir à un état intermédiaire précis de la session
du 18 août.

**À ne pas faire** : `rm -rf /root/backups`. Le dossier contient aussi
`maestroo_dev_avant_reset_*.sql.gz` — seules copies connues d'un état de la base Maestroo de
développement avant réinitialisation — et elles pèsent 0,46 Mo : les garder ne coûte rien.

**À ne pas faire non plus** : conclure que le problème est ce dossier. Le problème est qu'**un
contrôle de sauvegarde défini par un chemin ne peut pas signaler ce qui vit hors de ce chemin.**
Le correctif durable est le balayage proposé en angle mort n° 3 du rapport du 2026-08-20.

---

## VPS-031 — La purge hebdomadaire du cache de build a été annulée par un seul build, en 18 heures

- **Domaine** : docker · **Gravité** : 4 · **Statut** : `ACCEPTE` (mesuré, et il n'y a rien à faire)
- **Vu** : 2026-08-22 · **Mesure à la découverte** : `Private` **5,057 Go** le 08-20 à 05 h 08 (après la purge non filtrée) → **9,543 Go** le 08-21 à 04 h 31. **+4,486 Go en 23 h**, contre **9,568 Go** avant la purge : le cache est revenu **à 0,025 Go près** à son point de départ.
- ✅ **Confirmation du 2026-08-22, et elle affine le mécanisme** : `Private` = **10,42 Go**, soit **+0,88 Go en 21,9 h** pour **un** build (`tracky-api`, 08-21 23 h 45). **Un build a rendu 4,49 Go, le suivant 0,88 — cinq fois moins, pour le même geste.** Le premier reconstruisait un cache **vidé**, le second ajoutait à un cache **déjà là**. *Le cache de build n'est pas un stock qu'on vide : c'est un flux qui remonte vite jusqu'à sa borne, puis se stabilise.* Il est sous son seuil d'alerte de 15 Go, et le ramasse-miettes a tourné (`cache.db` écrit **9 s** après le build).

**Quoi.** Le cron `docker-builder-prune` (VPS-029), temporairement privé de son filtre, a retiré
4,5 Go le 2026-08-20 à 04 h 57 en 53 secondes. **Un unique déploiement, 18 h 43 plus tard, les a
tous rendus** :

```
── Images creees dans les dernieres 24 h ──
      1.82GB  2026-08-20 23:40:16  tracky-api:latest
       105MB  2026-08-20 23:40:16  tracky-web:latest
```

| Ce que la purge a coûté | Ce qu'elle a rapporté |
|---|---|
| Un premier build **2 à 4× plus long** sur chaque projet | **4,5 Go** pendant **18 h** |
| 53 s de la machine à 04 h 57, sur 2 vCPU | sur une machine qui avait déjà **44 Go libres** |

**Pourquoi c'est instructif.** La règle du §6 bis de la procédure dit qu'*un gain non mesurable
n'est pas un gain*. Ici le gain **était** mesurable — 4,5 Go, chiffrés à l'octet. Il manquait la
question d'après : **combien de temps dure-t-il ?** *Un gain qui s'évapore avant le passage suivant
n'est pas un gain non plus, et aucune des sept mesures précédentes ne pouvait le dire, parce
qu'aucune ne portait sur un intervalle où l'on connaissait les deux bouts.*

**Ce que ça vaut pour VPS-001.** Les huit premiers points de la série `Private` décrivaient un
mécanisme unique et auto-régulé. Le 9ᵉ ne rompt plus la série : il la **restaure**, en montrant que
le cache revient à sa borne **par les builds**, indépendamment de qui l'a vidé.

**Quoi faire : rien.** `Private` est **sous** sa borne de 10 Go, le ramasse-miettes de BuildKit a
tourné (`cache.db` écrit **27 s** après le build), il reste 44 Go libres. Le mécanisme s'autorégule.

**`aNePasFaire`** : ⚠️ **ne pas purger le cache « pour faire de la place »** — la place existe, et
chaque purge se rembourse au déploiement suivant en temps de build. ⚠️ **Ne pas non plus en
conclure que le cron de jeudi est inoffensif *parce que* le filtre est revenu** : il a été réécrit
deux fois par un canal hors SSH, et le test posé pour le **2026-08-28** reste la seule vérification
qui compte.

---

## VPS-032 — 7 385 sessions SSH réussies en sept jours, et rien ne les comptait

- **Domaine** : ordonnancement · **Gravité** : 3 · **Statut** : `A_TRAITER` — **le correctif est côté POSTE, pas côté VPS**
- **Vu** : 2026-08-22 · **Mesure à la découverte** : **7 422 connexions SSH acceptées** sur 7 jours glissants, dont **7 385 depuis `82.67.153.51`** (notre poste). Par jour : **44 · 46 · 109 · 175 · 630 · 4 252 · 2 094**. Coût mesuré contre témoin : **445 forks/20 s à vide contre 1 527 pendant 20 sessions → ~54 processus par session** (plancher, témoin unique).

**Quoi.** Notre outillage parle au VPS en ouvrant **une session SSH par commande**. Le profil
horaire du 2026-08-20 établit que ce ne sont pas les audits planifiés :

```
08-20T10 : 271   08-20T13 : 325   08-20T16 : 395   08-20T19 : 231   08-20T22 : 294
08-20T11 : 329   08-20T14 : 193   08-20T17 : 351   08-20T20 : 357   08-20T23 :  79
08-20T12 : 345   08-20T15 : 259   08-20T18 : 319   08-20T21 : 318
```

**~5 sessions par minute, de 10 h à 23 h.** Chaque session ouvre un `sshd`, un PAM, une session
`logind` **et** une instance `systemd --user`, puis referme le tout en ~0,9 s.

**Ce que ça coûte — et ce que ça NE coûte PAS.** `4 252 × 54 ≈ 230 000 processus` le 08-20,
contre ~468 000 pour la totalité des healthchecks. C'est la **deuxième source de forks de la
machine** les jours de travail.

> ⚠️ **Ce n'est pourtant PAS un gain de processeur à revendiquer**, et la règle du §6 bis de la
> procédure l'interdit : rapporté à la minute cela fait ~159 processus/min sur 1 374, soit
> **12 %** — or la série `processusParMinute` vaut **1 674 · 1 230 · 762 · 1 374** d'un passage à
> l'autre, un facteur **2,2**. *Le gain est sous la variance de la mesure*, exactement comme
> VPS-011 dont les « 126 720 exécutions/jour » n'ont rien fait bouger une fois supprimées.

**Le coût réel est ailleurs, et il est vérifiable :**

1. **Le journal de sécurité est noyé.** `auth.log` fait **7,4 Mo** et porte 7 385 lignes
   `Accepted` pour **17 échecs** : un rapport signal/bruit de **1 pour 434**. Toute lecture
   humaine d'`auth.log` après une alerte se fait désormais à travers ce mur.
2. **~1 h d'attente par jour de travail** côté poste (4 252 poignées de main à ~0,9 s).

**Pourquoi c'était invisible.** Le collecteur **lisait ces lignes depuis le premier passage** —
il en tirait les échecs, et n'affichait les réussites que sous forme d'un « top 5 des IP »
destiné à *aider à reconnaître ses propres accès*. *Un chiffre affiché pour servir d'aide à la
lecture n'est jamais lu comme une mesure : personne n'a regardé s'il était grand.* C'est la
famille de VPS-M45 (« le collecteur n'a jamais regardé les CLIENTS de Docker ») : la donnée
était sous les yeux, la question ne lui avait pas été posée.

**Quoi faire — et cela ne touche PAS le VPS.** Multiplexer les connexions côté poste :

```
Host 72.62.26.240
  ControlMaster auto
  ControlPath ~/.ssh/cm-%r@%h:%p
  ControlPersist 10m
```

**Gain** : N commandes → **une** session. **Risque** : **nul pour le VPS** — aucun paquet, aucune
configuration serveur, aucun processus ajouté ; le seul effet côté serveur est *moins* de travail.
**Contrepartie** : un socket de contrôle vit 10 min sur le poste après la dernière commande ;
qui a accès au compte local pendant ce temps réutilise la connexion **sans la clé**.

**`aNePasFaire`** : ⚠️ **ne rien borner côté serveur** (`MaxStartups`, `ClientAliveInterval`). Le
problème n'est pas que `sshd` accepte les sessions, c'est que le client en demande 4 252.
*Borner côté serveur transforme une inefficacité en panne intermittente le jour où l'on en aura
légitimement besoin.* ⚠️ **Ne pas conclure que le 08-20 est une anomalie** : le 08-19 (630) et le
08-21 (2 094) sont du même ordre — c'est le **régime des journées de travail**. ⚠️ **Et ne pas
prendre le 08-22 pour référence** : l'audit du jour a lui-même porté ce compte de ~46 à 81 en
mesurant le phénomène (VPS-M12, nouvelle forme).

### Suivi

- **2026-08-23** — **7 737 sessions** sur la fenêtre de 7 jours. ⚠️ **Et le chiffre du 08-22 publié
  hier était faux d'un facteur 5** : le rapport a écrit **72**, la journée complète en vaut
  **360**. La cause est VPS-M61, découvert le lendemain : le dernier jour d'un histogramme
  glissant n'a pas eu lieu, et rien ne le disait. *Le « ~46 par journée calme » de la fiche
  ci-dessus est donc lui aussi à relire avec précaution : 44 et 46 étaient les valeurs des 08-15
  et 08-16 lues au **bord gauche** de leur fenêtre, donc amputées.* Le régime réel d'une journée
  sans intervention reste à établir sur un jour **complet et central**.
- **2026-08-23** — journée partielle à **87** sessions à 02 h 22, dont **54 entre 01 h 30 et
  02 h 10** : c'est le déploiement manuel de Tracky, pas un régime de fond.

---

## VPS-033 — La mesure des correctifs de sécurité est perdue 4 passages sur 5, parce que sa source est aléatoire par conception

- **Domaine** : sécurité · **Gravité** : 2 · **Statut** : `A_TRAITER`
- ✅ **Vu : 2026-09-06 — PREMIÈRE MESURE VALIDE DEPUIS ONZE PASSAGES, ET PAR CHANCE : le cache
  `apt` avait 1 h.** Et elle tranche l'alerte laissée ouverte hier. Le rapport du 09-05 avait
  relevé, **sur un cache de 9 h donc hors mesure**, deux sources indicatives passant de « 0-1
  correctif de sécurité » à **« 20-26 »**, en refusant de les reporter et en écrivant que *« ce
  n'est pas une mesure — c'est une raison de refaire la mesure »* :

  | source | 09-05 (cache 9 h, **non mesurable**) | 09-06 (cache **1 h**, ✅ VALIDE) |
  |---|---:|---:|
  | cache `apt` | 95, dont **20** sécurité | **75**, dont **0** |
  | `update-notifier` | 101, dont **26** | **75**, dont **1** |

  Entre les deux, `apt-daily-upgrade` a tourné le **09-05 à 06 h 41 min 30**. **Le canal a fait son
  travail** — *et la seule raison pour laquelle on peut l'affirmer est que le rapport d'hier s'était
  interdit d'appeler « mesure » ce qui n'en était pas une.*
  ⚠️ **Ce vert ne referme pas le constat** : la mesure n'a été valide que parce que le tirage
  aléatoire d'`apt-daily` est tombé à 02 h 59, une heure avant la collecte. **La cause — une source
  rafraîchie à heure tirée au hasard dans une fenêtre de 12 h — est intacte.**
  ⚠️ **Et les 75 restants ne sont PAS encore un retard** (bloc VPS-M74) : le cache a été rafraîchi
  **20 h après** le dernier passage de l'installateur. **Le test est écrit** : si au passage suivant
  l'installation du 09-06 06 h 31 a eu lieu **et** que le compte n'a pas baissé, la panne est
  établie.
- 🟠 **Vu : 2026-09-03 — 8ᵉ ÉCHEC EN 10 PASSAGES (cache apt à 25 h), MAIS LE TEST ÉCRIT D'AVANCE
  EST TRANCHÉ, ET DANS LE BON SENS.** Le rapport du 09-02 exigeait : *« si l'installation a eu lieu
  et que le compte n'a pas baissé, le canal est en panne et le constat monte en gravité 2 »*.

  ```
  2026-09-02 06:15:49 → 06:18:03   unattended-upgrade, 34 paquets, « All upgrades installed »
                                    apt-daily-upgrade.service : 1 min 55,183 s de CPU
  ```

  **Compte relevé par `update-notifier` deux minutes après la fin : 109 → 75 paquets, et
  34 → 1 de sécurité.** *109 − 75 = 34, exactement le nombre installé et exactement le nombre
  d'estampillés sécurité.* **Le canal fonctionne ; VPS-033 ne monte PAS en gravité 2.** Le temps
  CPU le confirme indépendamment et **échelonne** : 3,1 à 4,2 s les jours vides, 18,4 s le 08-27
  (4 paquets), 31,6 s le 08-28 (9), **115 s** ici (34).

  ⚠️ **Ce 109 → 75 ne vient PAS de la mesure du jour**, qui est `NON MESURABLE` (cache de 25 h) et
  dont les « 75 paquets, dont 0 sécurité » ne doivent pas être reportés. Il vient de
  `unattended-upgrades.log` et du fichier d'`update-notifier` écrit à 06 h 18 min 01 le 09-02 —
  une source **datée d'avant et d'après** l'installation, qui est l'instrument que le test
  demandait. *Publier le chiffre du cache périmé au motif qu'il confirme ce qu'on espère serait le
  mode d'échec de VPS-010.*

  🔴 **ET L'INSTALLATION A UNE CONSÉQUENCE QUE PERSONNE N'AVAIT ÉCRITE** : les services tournant
  sur une bibliothèque **remplacée** passent de **4 à 6**, et **`docker.service` en fait partie**
  (avec `dbus`, `systemd-logind`, `unattended-upgrades` et deux `getty`). Neuf des 34 paquets sont
  des bibliothèques partagées — `libssh-4`, `zlib1g`, `libgcrypt20`, `libuuid1`, `libblkid1`,
  `libmount1`, `libtinfo6`, `libattr1`, `libbz2-1.0` — échangées sous les pieds des démons qui les
  avaient chargées. **Voir VPS-010** : *un paquet installé n'est pas un service redémarré*, et
  c'est la première fois que ce constat est **daté et attribué** à une installation précise.
- ✅ **Vu : 2026-09-02 — 3ᵉ MESURE VALIDE EN 9 PASSAGES, ET ELLE A FAILLI PRODUIRE UN CONSTAT
  FAUX.** Cache de **1 h** (rafraîchi à 00 h 48 min 58), seconde source de **1 h**, les deux
  d'accord : **109 paquets en retard, dont 34 estampillés sécurité**. Série des neuf derniers :
  ❌ ❌ ✅ ❌ ❌ ❌ ✅ ❌ ✅. **Le défaut n'est pas corrigé, le tirage est tombé du bon côté pour
  la troisième fois.**

  🔑 **Et ce passage ajoute au dossier un argument que les précédents n'avaient pas.** Lu seul, ce
  compte valide annonçait *« cinq jours de correctifs de sécurité non appliqués »* — **et c'était
  faux** : les index sont datés du 09-01 au soir, le rafraîchissement les a vus à 00 h 48, et
  **l'installateur passe à 06 h 52**, soit 4 h 30 après la collecte (voir **VPS-M74**). *Un tirage
  aléatoire ne dégrade donc pas seulement la DISPONIBILITÉ de la mesure : il rend sa POSITION dans
  le cycle imprévisible, ce qui maximise la chance de mesurer au pire moment.* Un rafraîchissement
  à heure fixe rendrait aussi cette position **constante d'un passage à l'autre** — c'est un second
  bénéfice du même correctif, et il n'avait jamais été écrit.
- **Vu : 2026-08-26** · **Mesure** : ✅ **VALIDE — cache de 2 h** (rafraîchi à 00 h 06,
  soit 2 h 16 avant la collecte). **2ᵉ mesure valide en 7 passages** ; le tirage aléatoire est
  simplement tombé du bon côté, exactement comme le 08-21. **Le défaut n'est pas corrigé, il est
  en congé.** Série des sept derniers : ❌ ❌ ✅ ❌ ❌ ❌ ✅.
  ✅ **Et ce passage démontre ce que le constat coûte** : c'est la **première fois** que l'audit
  dispose de **deux mesures valides comparables** (85/17 le 08-21, 79/10 aujourd'hui). Elles ont
  suffi à établir en une lecture que le canal automatique fonctionne — question restée ouverte
  cinq passages faute de deux points. *Un instrument qui ne mesure qu'un jour sur quatre ne
  produit pas une surveillance quatre fois moins bonne : il ne produit aucune tendance du tout.*
- **Vu** : 2026-08-23 · **Mesure à la découverte** : **4 des 5 derniers passages** ont publié
  `NON MESURABLE` faute d'un cache `apt` de moins de 6 h.

**QUAND.** Établi sur les cinq collectes archivées :

| Passage | Heure de collecte (UTC) | Cache apt écrit le | Âge | Verdict |
|---|---|---|---:|---|
| 08-19 | 02:31 | 08-18 03:11 | 23 h | 🟠 NON MESURABLE |
| 08-20 | 02:35 | 08-19 03:05 | 23 h | 🟠 NON MESURABLE |
| **08-21** | **04:31** | **08-21 03:04** | **1 h** | **✅ VALIDE — 85 paquets** |
| 08-22 | 02:23 | 08-21 03:04 | 23 h | 🟠 NON MESURABLE |
| 08-23 | 02:22 | 08-22 02:59 | 23 h | 🟠 NON MESURABLE |

**QUOI — la cause, et ce n'est pas un horaire mal choisi.**

```
OnCalendar=*-*-* 6,18:00
RandomizedDelaySec=12h
Persistent=true
```

`apt-daily.timer` tire son heure **au hasard dans une fenêtre de douze heures**, deux fois par
jour. Les exécutions réellement journalisées : **09:15, 18:23, 10:39, 03:04, 13:30, 02:59,
09:11**. Le passage du 08-21 n'a pas mesuré parce qu'il était mieux placé — il est tombé du bon
côté du tirage.

> ⚠️ **La cause d'abord écrite était fausse, et elle était plausible.** Les quatre horodatages que
> le collecteur avait rapportés — 03:11, 03:05, 03:04, 02:59 — tiennent dans une bande de douze
> minutes sur quatre jours, d'où la conclusion « le rafraîchissement a lieu vers 03 h 00, l'audit
> passe 37 min trop tôt ». *Quatre points dans une bande étroite ne sont pas une régularité : sur
> un tirage uniforme, c'est ce qui arrive de temps en temps.* Le démenti est venu de
> `systemctl cat`, pas de la relecture : **quatre lectures de la TRACE et zéro de l'UNITÉ qui la
> produit** — VPS-M15, treize passages plus tard, sur un autre objet.

**Pourquoi c'était invisible.** VPS-M21 avait décrit ce défaut comme *« la section sécurité
devient aveugle **un jour sur sept** »*. La mesure dit **quatre sur cinq**. *La fiche n'a jamais
été relue contre la série réelle : on a fait confiance à une fréquence estimée une seule fois, et
elle est restée dans le référentiel comme un fait.*

**QUOI FAIRE.** Figer le délai aléatoire — c'est la **seule** correction déterministe :

```bash
systemctl edit apt-daily.timer   # [Timer] / RandomizedDelaySec=30m
```

**Gain** : restaure une mesure perdue 4 fois sur 5. **Risque** : faible. **Contrepartie réelle** :
le délai aléatoire existe pour **étaler la charge sur les miroirs Ubuntu** — le réduire sur une
machine est sans effet mesurable, le généraliser ne le serait pas. Préférer `30m` à `0`.

**`aNePasFaire`** : ⚠️ **ne pas lancer `apt update` depuis le collecteur** — ce serait une
**écriture** et un accès réseau sortant dans un audit déclaré en lecture seule. ⚠️ **Ne pas
promettre qu'un décalage de l'audit règle le problème** : chiffré sur la série, un passage à
03 h 30 UTC aurait rattrapé **3 des 4 échecs** (08-21, 08-22, 08-23) et **pas** le 08-20, dont le
premier rafraîchissement n'a eu lieu qu'à 10 h 39. ⚠️ **Ne jamais lire un `0 paquet de sécurité`
sur cache périmé comme une bonne nouvelle** : c'est l'écart exact qui a masqué 11 correctifs
(VPS-010).

---

## VPS-034 — Le conteneur le plus exposé de la machine pilote le démon Docker, et personne ne l'avait écrit

- **Domaine** : sécurité · **Gravité** : 2 · **Statut** : `A_TRAITER`
- **Vu** : 2026-08-24 · **Mesure** : `foodsqan-traefik` monte `/var/run/docker.sock` (`RW=false`),
  publie `0.0.0.0:80` et `0.0.0.0:443`, sert **25 domaines**, tourne sur l'étiquette **`traefik:latest`**
  et n'a **aucune sonde de santé**. Seul conteneur des 33 dans ce cas.

**Quoi — et d'abord ce que ce n'est PAS.** Ce n'est **pas une porte ouverte** et **pas une erreur
de configuration**. Traefik a besoin de cette socket : il tourne avec `--providers.docker=true`,
c'est-à-dire qu'il découvre les routes en lisant l'API Docker. Des dizaines de milliers
d'installations font exactement cela. **Le constat ne porte pas sur la présence du montage, il
porte sur son rayon d'explosion — que rien n'avait chiffré en vingt passages.**

**Ce que ce montage donne réellement.** Qui obtient l'exécution de code dans ce conteneur obtient
l'API Docker complète, donc `root` sur l'hôte en une requête (créer un conteneur privilégié qui
monte `/`). **Le `ro` n'y change rien** — et c'est le point contre-intuitif qui mérite d'être
écrit noir sur blanc : le montage en lecture seule protège le **fichier** socket contre son
remplacement, pas l'**API** contre ses écritures. On parle au démon par `connect()`, jamais par
`write()` sur l'inode.

**Pourquoi ça compte ici plus qu'ailleurs.** C'est la conjonction, pas le montage :

1. c'est le **seul** point d'entrée HTTP/HTTPS de **toute** la production (VPS-021) ;
2. il est **exposé à Internet** sur 80 et 443, sans rien devant lui ;
3. il tourne sur **`traefik:latest`** — étiquette flottante : la prochaine recréation change la
   version du composant qui termine le TLS de 25 domaines, **sans que personne ne le décide** ;
4. il **n'a aucune sonde** : sa panne est invisible à Docker (14ᵉ report, point 6 du plan) ;
5. il appartient à `/opt/foodsqan`, la pile déclarée morte que VPS-021 interdit de supprimer
   précisément parce qu'elle tient ces ports.

**Pourquoi c'était invisible.** L'audit lisait `.Mounts` depuis le 2026-08-12 — `INSPECT_JSON`
sérialise l'état complet des 33 conteneurs à chaque passage — et **ne lui avait jamais posé cette
question**. C'est mot pour mot la famille de VPS-M45 et de VPS-032 : *la donnée était sous les
yeux du collecteur, la question ne lui avait pas été posée.* Elle ne l'a été que parce que le
bloc des clients Docker a été instrumenté ce passage (VPS-M65) et qu'il fallait bien nommer les
clients permanents.

**Quoi faire — la moitié gratuite d'abord.**

Épingler l'étiquette. Effet : la version du proxy ne change plus qu'à la demande. Risque : nul.
Contrepartie : les correctifs de sécurité de Traefik demandent désormais un geste explicite —
c'est le but, mais il faut que quelqu'un le fasse.

```bash
docker inspect foodsqan-traefik --format '{{.Image}}'   # relever le digest ACTUEL avant tout
```

**La seconde moitié n'est PAS gratuite, et il faut le dire.** Le correctif de manuel est un
mandataire de socket (`tecnativa/docker-socket-proxy`) qui n'expose que `GET /containers`. Il
réduit le rayon d'explosion à une lecture — mais il **ajoute un conteneur** sur une machine à
2 vCPU dont les healthchecks sont déjà la 1ʳᵉ source de forks, et il **insère un saut de plus
devant l'unique point d'entrée de la production**. *Un composant ajouté devant le point de panne
unique est lui-même un point de panne.* À arbitrer, pas à appliquer par réflexe.

**`aNePasFaire`** : ⚠️ **ne pas retirer le montage** — Traefik perdrait toute découverte de
routes et **les 25 domaines tomberaient**. ⚠️ **Ne pas passer le montage en `rw`/`ro` en croyant
changer quelque chose** : mesuré ci-dessus, `ro` ne restreint pas l'API. ⚠️ **Ne pas traiter ceci
comme une urgence** : il n'y a **aucune intrusion constatée**, `Currently banned: 0`, 27 échecs
SSH en 7 jours et 0 sur `root`. Le surclasser en gravité 1 rejouerait VPS-M46, où un détecteur a
produit un constat de gravité 1 sur une chaîne qui n'était pas un secret.

---

## VPS-035 — Le débit d'ingestion de Tracky a triplé le 08-23 → **INVERSÉ le 08-24 : aucun boîtier perdu, facture retirée, cadence à décider**

- **Domaine** : données · **Gravité** : 3 (était 2) · **Statut** : `SURVEILLANCE` — **le déluge est terminé, la facture est retirée, le régime est caractérisé, la cadence reste à décider**
- ✅ **Vu : 2026-08-26 — LE RÉGIME EST STABLE ET MODULÉ ; LE « IL BAISSE ENCORE » D'HIER ÉTAIT UN CREUX DE NUIT.**

  Le rapport du 08-25 publiait : *« le débit est 40 % SOUS son niveau d'avant, **et il baisse encore**, la pente est monotone : 169,5 → 149,0 → 139,1 → … → 110,7 sur 17 h »*. **Mesuré heure par heure sur 30 h, il ne baissait pas : il passait par son minimum quotidien.**

  ```
  08-25 03h : 104.4 /h/boitier   <- le PLANCHER, UNE HEURE APRES la collecte du 08-25
  08-25 15h : 164.5              <- le PIC de la meme journee
  08-26 00h : 129.5   (08-25 00h : 110.7  ->  +17 %)
  08-26 01h : 127.2   (08-25 01h : 110.7  ->  +15 %)
  ```

  **À heure comparable, le débit est AU-DESSUS de celui d'hier.** La collecte du 08-25 est passée à 02 h 22, soit trente-huit minutes avant le minimum de la journée, et les cinq points de la « pente monotone » étaient les cinq dernières heures de la descente nocturne.

  **🔑 CE QUI A RÉELLEMENT CHANGÉ, ET C'EST UNE INFORMATION NEUVE SUR TRK-045 :**

  | jour | moy. /h/boîtier | min | max | amplitude | boîtiers |
  |---|---:|---:|---:|---:|---:|
  | 08-22 *(avant, 21 h conservées)* | **196,0** | 180,2 | 214,5 | **×1,19** | 37 |
  | 08-23 *(la rampe)* | 316,7 | 179,2 | 522,4 | ×2,92 | 38 |
  | 08-24 *(la rupture)* | 276,2 | 114,5 | 610,8 | ×5,33 | 38 |
  | **08-25** *(1ᵉʳ jour plein du nouveau régime)* | **136,7** | **104,4** | **164,5** | **×1,58** | **38** |

  **Avant l'incident, les boîtiers émettaient à cadence PLATE jour et nuit (±9 %) ; depuis le correctif, l'émission est MODULÉE (±58 %)** — le comportement d'une cadence qui suit l'activité du véhicule, c'est-à-dire très probablement ce que TRK-045 visait. **La baisse réelle est de 196,0 → 136,7 = −30 %**, et non les −40 % publiés hier, dont les deux termes étaient mal appariés.

  ✅ **38 émetteurs distincts chaque heure des 30 dernières, sans un trou** (un 37 isolé à 08-25 13 h) : aucun émetteur perdu, 9ᵉ jour. Ce discriminant est désormais **dans le collecteur** (angle mort n° 1 fermé le 2026-08-26).

  ⚠️ **LE SEUIL ÉCRIT LE 08-25 SE SERAIT DÉCLENCHÉ À TORT DÈS AUJOURD'HUI.** La dernière heure de la fenêtre affiche **56,8**, sous le seuil de 60 — **parce qu'elle est partielle** (coupée à 02 h 26 par la collecte). Lu au pied de la lettre, ce seuil rouvre un constat sain **à chaque passage, par construction**. C'est **VPS-M61 appliqué à un seuil** au lieu d'un histogramme. Voir **VPS-M69**.

- ✅ **Vu : 2026-08-25 — INVERSÉ, ET AUCUN BOÎTIER N'A ÉTÉ PERDU.** Le débit a culminé le **08-24 à 05-06 h** (23 210/h, **610,8 trames/h/boîtier**, soit une toutes les **5,9 s**) puis s'est effondré **en deux heures** : 16 968/h à 07 h, **6 442/h à 08 h**. Sur 24 h glissantes : `wire_logs` **×0,67** (212 056 contre 317 886), `position_sampling_decisions` **×0,63** (188 211 contre 296 759).

  **🔑 LA VÉRIFICATION QUI DÉCIDAIT DE TOUT.** Un déluge qui s'arrête peut vouloir dire *« on l'a corrigé »* ou *« les émetteurs se sont tus »* — **la même courbe descendante, et la seconde est un incident majeur déguisé en bonne nouvelle**. Le discriminant est le compte d'émetteurs **distincts, heure par heure** : **37 avant la rampe, 38 pendant, 38 après, sans un seul trou**. Toute la variation est portée par les trames **par boîtier**. *Rien dans le collecteur ne posait cette question ; elle a été posée à la main, et c'est le premier angle mort du rapport du 2026-08-25.*

  **LA FACTURE EST RETIRÉE.** Les projections à fenêtre pleine tombent à **272 Mo** (`wire_logs`) et **236 Mo** (`position_sampling_decisions`), soit **508 Mo** contre les **773 à 1 200 Mo** annoncés la veille — et **moins que leur taille actuelle** (282 et 245 Mo). Les **+2,1 à +5,4 Go durables** annoncés le 08-24, sauvegardes comprises, **n'auront pas lieu**. ⚠️ Ces deux projections sont désormais des **PLAFONDS** et non des planchers, la moyenne des 24 h écoulées contenant encore le haut de la rampe — c'est le défaut de méthode **VPS-M67**, trouvé en écrivant cette ligne.

  ⚠️ **La base grossit encore : 1 182 → 1 215 Mo (+33 Mo en 24 h), et ce n'est PAS une contradiction.** La fenêtre de rétention de 3,98 jours **contient encore les heures du déluge** ; elle finira de les évacuer vers le **2026-08-28**. *Ne pas lire ce +33 Mo comme la poursuite du problème — ni, à l'inverse, s'en servir pour rouvrir le constat.*

  🔴 **CE QUI RESTE OUVERT, ET QUI N'EST PAS UNE BONNE NOUVELLE** : le régime **n'est pas revenu à son niveau d'avant l'incident, il est 40 % EN DESSOUS et il baisse encore.** Base du 08-22 : **184,0** trames/h/boîtier (une toutes les 19,6 s). Maintenant : **110,7** (une toutes les 32,5 s), après une pente monotone sur 17 h (169,5 → 149,0 → 139,1 → … → 110,7). Deux lectures, et **l'audit ne peut pas trancher depuis la machine** : soit la correction est allée au-delà de sa cible, soit la cadence continue de s'allonger seule. *Pour le VPS, moins de trames est un gain ; pour le produit, une cadence qui dérive sans qu'on l'ait décidée est le défaut de TRK-045 avec un signe différent.*

  **🆕 ET LA RUPTURE NE VIENT PAS D'UN DÉPLOIEMENT.** `tracky-api` a été recréé le **08-24 à 15:08:43** — **sept heures APRÈS** la rupture de 07-08 h. Le conteneur qui tournait à 08 h était celui de 06 h. Le changement vient donc des **boîtiers**, pas du serveur : la montée était une **rampe** de 22 h (adoption boîtier par boîtier), la descente est une **marche** de 2 h (une commande à la flotte). *C'est l'inverse de ce que le constat affirmait le 08-24, où la rampe avait été attribuée au build de 03:59:29 — l'attribution tenait à une coïncidence d'horaire, et elle ne se reproduit pas.*

- **Seuil de réescalade** (exigé pour tout `SURVEILLANCE`) — ⚠️ **RÉÉCRIT le 2026-08-26, l'ancienne formulation était piégée** : repasser en `A_TRAITER` si la **moyenne des 24 h glissantes par émetteur** — la grandeur que le collecteur publie désormais — dépasse **300 trames/h/boîtier** ou descend sous **60**. **Au 2026-08-26 : 138,3.**
  ⚠️ **Ne JAMAIS lire ce seuil sur une heure isolée** : la dernière heure de toute fenêtre est partielle (VPS-M61) et affiche mécaniquement un tiers de sa valeur, et le débit varie de ×1,58 entre la nuit et la mi-journée (VPS-M69). L'ancien seuil, écrit sur « le débit » sans dire lequel, se serait déclenché à tort dès le lendemain de son écriture.
- **Vu** : 2026-08-24 · **Mesure à la découverte** : `wire_logs` **+115 634 lignes en 24 h** (708 320 → 823 954,
  **+16,3 %**) et `position_sampling_decisions` **+145 774** (581 918 → 727 692, **+25,1 %**),
  **à fenêtre de rétention inchangée**. Débit horaire mesuré ligne à ligne : **7 213/h le 08-22**
  → **20 296/h le 08-24 à 01 h** = **×2,81**.

**Quoi — la cause est datée à l'heure.** Le comptage heure par heure de `wire_logs` ne laisse
aucune place au doute :

```
08-22 (journée entière) : ~7 000/h, plat du début à la fin
08-23 03:59:29          : image tracky-api reconstruite   <- le déploiement
08-23 04h : 7 850   05h : 9 420   06h : 11 029   ...  15h : 11 709
08-23 16h : 13 470  19h : 15 857  22h : 18 610   23h : 19 852
08-24 00h : 19 796  01h : 20 296
```

La rupture tombe **dans l'heure qui suit la reconstruction de l'image**, et la montée est
**progressive** — signature d'un parc d'émetteurs qui adopte une nouvelle cadence boîtier par
boîtier, au fil des reconnexions, et non d'un basculement serveur. `position_sampling_decisions`
suit la même courbe (**×2,01** sur 24 h).

> **Ce n'est pas un défaut du VPS, et l'audit n'a pas à le corriger.** La cause est un correctif
> applicatif déployé le 08-23, suivi côté produit sous **TRK-045**. Le rôle de ce constat est de
> chiffrer **ce que ça coûte à la machine, et à quelle échéance** — ce que le centre d'alerte ne
> mesure pas.

**La rétention fonctionne, et c'est justement le piège.** Les deux fenêtres sont **inchangées** :
`2026-08-20 03:00 → 2026-08-24 02:28`, soit **3,98 jours**, purgées chaque nuit à 03 h 00 et
03 h 30. *À durée constante, le volume est le produit de la durée par le débit* — la rétention
borne le premier facteur et ne dit rien du second. C'est le défaut de méthode VPS-M64, trouvé
en écrivant ce constat.

**Ce que ça coûte, avec ses deux hypothèses écrites.**

| | aujourd'hui | à fenêtre pleine, au débit des **24 h écoulées** | à fenêtre pleine, au débit de la **dernière heure** |
|---|---:|---:|---:|
| `wire_logs` | 266,5 Mo | 404 Mo | 619 Mo |
| `position_sampling_decisions` | 229,3 Mo | 369 Mo | 581 Mo |
| **somme** | **496 Mo** | **773 Mo** (+277) | **1 200 Mo** (+704) |
| `tracky_prod` | 1 182 Mo | ~1,46 Go | ~1,89 Go |

La colonne du milieu est un **plancher** : la moyenne des 24 h écoulées inclut la montée. La
colonne de droite suppose que le débit se stabilise à son niveau actuel. **L'échéance est de
~4 jours** — le temps que la fenêtre se renouvelle entièrement au nouveau régime, soit autour du
**2026-08-28**.

**Et la facture ne s'arrête pas à la base.** Le dump quotidien pèse **150,6 Mo** pour une base de
1 182 Mo (**7,85:1**). En supposant que ces lignes de journal compressent *au moins* aussi bien —
hypothèse conservatrice, ce sont des enregistrements très répétitifs — chaque dump prend **+35 à
+90 Mo**, et **52 copies sont conservées** : `/var/backups/vizyo-tracky` passerait de **6,8 Go** à
**8,6–11,5 Go**. Total durable sur ~7 semaines : **+2,1 à +5,4 Go**, soit **5 à 13 % des 41 Go
libres**.

**Ce qui va bien, et qu'il faut dire.** `positions` — la donnée **métier** — **n'a pas bougé** :
**×0,77** sur 24 h, fenêtre stable à 62 jours, 446 Mo inchangés. *La couche de décision
d'échantillonnage absorbe donc les trames supplémentaires et ne les promeut pas en positions.*
Le triplement coûte du **journal**, pas de la donnée utile — c'est la meilleure nouvelle de ce
constat, et elle borne l'enjeu.

**Pourquoi c'était invisible.** Le bloc de rétention affichait, **le jour même**, son verdict
rassurant : *« fenêtre COURTE et STABLE = rétention active, rien à faire »*. Il était exact sur
ce qu'il mesurait et faux dans ce qu'il concluait. Voir VPS-M64.

**Quoi faire.** Rien sur le VPS aujourd'hui — **41 Go libres, et l'échéance est en semaines.**
La décision appartient au produit :

1. **Trancher TRK-045** (ramener les boîtiers à leur cadence) : supprime la cause. Gain : la
   totalité des +2,1 à +5,4 Go. Aucun coût VPS.
2. **Sinon, raccourcir la rétention de ces deux tables** de 4 jours à 2 : gain ~50 % du
   surcoût, sans toucher aux émetteurs.

⚠️ **Contrepartie de la seconde option, et elle est réelle** : `wire_logs` est **la pièce qui a
permis de dater cette rupture à l'heure près**. C'est aussi elle qui, le 2026-08-20, a servi à
établir qu'un déluge d'alertes s'était arrêté *parce que les trames avaient cessé*. Raccourcir
sa fenêtre, c'est raccourcir la mémoire de diagnostic **au moment précis où l'on en a besoin**.

**`aNePasFaire`** : ⚠️ **ne pas purger ces tables à la main** — elles ont une rétention qui
fonctionne, et une purge manuelle ne fait que déplacer la date sans changer le régime.
⚠️ **Ne pas conclure « le disque monte » sans le décomposer** : les **+2 Go** de disque de ce
passage viennent des **8 images reconstruites** le 08-23 (8,73 Go annoncés) et du cache de build,
**pas** de ces tables — qui n'ont pris que 55 Mo. Les deux phénomènes sont indépendants et
confondre les deux ferait accuser le mauvais coupable.

---

## VPS-036 — Un tiers exécute `kill -KILL` en root sur la production, par un canal qui ne passe ni par SSH ni par le pare-feu

- **Domaine** : sécurité · **Gravité** : 2 · **Statut** : `A_TRAITER` *(était `SURVEILLANCE` —
  monté le 2026-09-02)*
- 🔴 **Vu : 2026-09-02 — DEUXIÈME OCCURRENCE, ET CELLE-CI MASQUE UN SERVICE SYSTEMD. LE SEUIL
  ÉCRIT D'AVANCE EST FRANCHI DEUX FOIS.**

  Le **2026-09-01 à 15 h 16 min 24 UTC**, le même canal a livré **1 104 caractères** de base64.
  Décodés :

  ```
  systemctl cat multipathd.service >/dev/null 2>&1 || { echo "R state=absent ..."; exit 0; }
  DEV=$(multipath -ll 2>/dev/null | grep -c .)
  if [ "$DEV" -gt 0 ]; then echo "R state=has-devices ..."; exit 0; fi
  if [ "$ACT" != active ]; then echo "R state=not-running ..."; exit 0; fi
  if [ "apply" = apply ]; then
      systemctl mask --now multipathd.socket  >/dev/null 2>&1
      systemctl mask --now multipathd.service >/dev/null 2>&1
  ```

  **L'ordre a abouti, et l'effet est DURABLE — vérifié en lecture seule le 2026-09-02 :**

  ```
  systemctl is-enabled multipathd.service  →  masked
  systemctl is-active  multipathd.service  →  inactive
  /etc/systemd/system/multipathd.service -> /dev/null   (lien créé le Sep  1 15:16)
  /etc/systemd/system/multipathd.socket  -> /dev/null   (lien créé le Sep  1 15:16)
  ```

  *L'horodatage du lien symbolique et celui de l'ordre `guest-exec` coïncident à la minute. Ce
  n'est pas une concomitance d'horaire prise pour une identification (VPS-M01) : c'est le fichier
  que la commande crée, portant l'heure de la commande.*

  **Le seuil de réescalade écrit le 2026-09-01 exigeait `A_TRAITER` « à la deuxième occurrence,
  ou dès qu'un ordre de ce canal touche autre chose que des clients Docker et des pagers — un
  conteneur, un SERVICE, un fichier ». Les deux conditions sont remplies le même jour.** Le
  constat monte sans arbitrage — *c'est le propre d'un seuil rédigé avant l'événement, et c'est
  la deuxième fois en deux passages qu'un test écrit d'avance tranche seul.*

  ⚠️ **L'acte lui-même est défendable, et il faut le dire aussi nettement que le reste** :
  `multipathd` gère les disques à chemins multiples, cette machine n'en a aucun — le script le
  teste (`DEV=0`) avant d'agir. Le masquer rend quelques mégaoctets et supprime un démon inutile.
  **Le constat ne porte pas sur cet usage-là, il porte sur la CAPACITÉ** : un tiers modifie
  durablement la configuration système d'une machine qui porte sept bases de production, sans
  passer par SSH, sans trace dans `auth.log`, et sans que personne côté Vizyo ne l'ait décidé.

  ✅ **Et le correctif de la veille a payé dès son premier cas neuf** : sans le décodage base64
  posé le 09-01 (VPS-M72), cet ordre se serait affiché `/bin/sh -c echo c3lzdGVtY3Rs…` et l'audit
  aurait publié *« 🟠 2 commandes INATTENDUES »* sans savoir que l'une masquait un service.
  *Le correctif a été écrit pour un cas passé ; il a attrapé un cas futur, cinq jours plus tard.*

- **Vu** : 2026-09-01 · **Mesure à la découverte** : **une** occurrence, le **2026-08-28 à
  13 h 48 min 37 UTC**, sur toute la fenêtre conservée par `journalctl -t qemu-ga`. Reçue par
  `guest-exec`, exécutée en root, **1 420 caractères** encodés en base64.

  Contenu décodé (extraits fidèles) :

  ```
  snap=$(ps -eo pid,etimes,comm,args --no-headers | grep -v '<defunct>')
  r1=  ... docker (service |container )?(logs|stats)|docker[ -]compose( .*)? logs ...
         ... etimes > 21600  et NI (flock|timeout) NI --follow NI -f
  r2=  ... comm ~ /^(more|less|sngrep|htop|ugrep)$/ ... etimes > 21600
  for p in $pids; do kill -TERM "$p"; done; sleep 3; for p in $pids; do kill -KILL "$p"; done
  exit 10
  ```

- **QUOI — la cause** : le canal `guest-exec` de l'hyperviseur (déjà catalogué **VPS-027**) n'est
  pas un canal de lecture. Il porte des ordres arbitraires en root, et celui-ci **tue des
  processus**. Le catalogue d'ordonnancement de cet audit prétend tenir la liste de ce qui se
  déclenche sur la machine : une quatrième couche capable de `kill` y appartient.

- **Ce que ce constat N'EST PAS, et il faut le dire aussi nettement** : ce n'est **pas une
  intrusion**. La cible (`sngrep`, outil SIP, à côté de `htop`, `less`, `more`, `ugrep`) est celle
  d'un **balai d'hébergeur contre les sessions interactives abandonnées**. Aucune persistance,
  aucun téléchargement, aucune écriture de fichier, aucune modification de configuration.

- **🔑 L'ironie utile** : ce script vise **exactement la cause de VPS-016** — les clients
  `docker logs` bloqués, qui ont coûté 1,44 cœur pendant treize jours. Et **nos propres audits en
  sont exclus par construction** : le filtre `r1` écarte tout ce qui est enveloppé dans `flock` ou
  `timeout`, et le garde-fou `timeout` posé sur l'audit du centre d'alerte le **2026-08-20** nous
  place dans l'exclusion. *Vérifié en lisant le filtre, pas supposé.*

- **`pourquoiInvisible`** : le collecteur **avait signalé la commande** — le compteur a
  parfaitement fonctionné, et il l'a comptée en `🟠 1 commande INATTENDUE`. Ce qu'il en publiait
  était tronqué à 165 caractères, et ces 165 caractères étaient du **base64**. Voir **VPS-M72** :
  un filtre juste ne suffit pas si ce qu'il donne à lire ne porte pas l'information.

- **QUOI FAIRE** — ⚠️ **élargi le 2026-09-02** : ouvrir **un seul** ticket à l'hébergeur couvrant
  **les deux** ordres (le balai `kill` du 08-28, le masquage du 09-01), pour obtenir dans cet
  ordre : la **paternité**, la **cadence**, puis **la liste des actions que ce canal s'autorise
  sans préavis**. *Les deux premières sont des faits du passé ; la troisième est la seule qui
  protège l'avenir.*

  ```bash
  journalctl -t qemu-ga --since '30 days ago' | grep -c 'guest-exec called'
  ```

- **`aNePasFaire`** : ⚠️ **ne pas désactiver `qemu-guest-agent` pour « fermer le canal »**. On
  perdrait les sauvegardes-images et la console de secours de l'hébergeur — pour empêcher une
  commande qui, en l'état, tue exactement ce que VPS-016 nous a coûté treize jours.
  ⚠️ **Ne pas attribuer une provenance qu'on ne mesure pas** : sur ce canal, l'audit ne peut PAS
  distinguer l'hébergeur d'un humain utilisant la console web du panneau. Les deux arrivent par la
  même porte (VPS-M01).
  ⚠️ **Ajouté le 2026-09-02 — ne pas « démasquer » `multipathd` par réflexe.** Il ne sert à rien
  sur cette machine, et le remettre en route ajouterait un démon sur 2 vCPU dont les healthchecks
  sont déjà la 1ʳᵉ source de forks. **Le défaut est le canal, pas son effet du jour** — annuler
  l'effet donnerait le sentiment d'avoir traité le constat sans rien changer à ce qui le produit.

- **Seuil de réescalade** — ⚠️ **RÉÉCRIT le 2026-09-02, l'ancien ayant été franchi.** L'ancienne
  formulation (*« passer en `A_TRAITER` à la deuxième occurrence, ou dès qu'un ordre touche autre
  chose que des clients Docker et des pagers — un conteneur, un service, un fichier »*) a
  fonctionné exactement comme prévu et a produit la montée du 2026-09-02. Le nouveau seuil :
  **passer en gravité 1 si un ordre de ce canal touche un conteneur, un volume, une base, une
  règle de pare-feu ou un fichier de `/opt`** — c'est-à-dire la production elle-même, et non
  l'outillage système de l'hôte. **Rester en gravité 2** tant que la cible reste l'hygiène de
  l'hôte (démons inutiles, sessions abandonnées).

---

## VPS-037 — La copie hors-site des sauvegardes dépend du même poste de travail que l'audit, et elle a dépassé son seuil

- **Domaine** : sauvegardes · **Gravité** : 3 · **Statut** : `A_TRAITER` — **volet SYMPTÔME refermé
  le 2026-09-03, volet CAUSE intact**
- ✅ **Vu : 2026-09-03 — LA COPIE RENTRE DANS SON SEUIL : 69 h → 21 h.** Contenu copié : 22 h,
  14 copies locales, destination inchangée (PC local `D:`). **Le symptôme est fermé.**
  ⚠️ **Et la cause n'a pas bougé d'un octet** : le seul exemplaire qui ne vive pas sur le VPS a
  toujours pour **unique dépositaire un poste de travail** — le même que celui qui porte la
  planification de cet audit. *Il ne s'est refermé par aucun correctif : il s'est refermé parce que
  le dépositaire est revenu.* C'est exactement le motif de **VPS-015**, dont le symptôme s'est
  refermé deux fois par accident et jamais par correction — et qui a rechuté. **Un symptôme qui se
  referme tout seul se rouvrira tout seul.** Le constat reste `A_TRAITER`.
  ⚠️ **Ce que l'audit ne peut PAS dire** : ce qui a tourné, ni quand exactement. Le seul fait
  établi reste le couplage.
- 🟠 **Vu : 2026-09-02 — AGGRAVÉ : la copie passe de 51 h à 69 h.** L'écart au seuil de 48 h
  passe de **3 h à 21 h en un seul passage**, et la source, elle, est à jour (**22 h**). *Ce
  n'est donc pas la sauvegarde qui manque, c'est son unique exemplaire hors machine qui ne se met
  plus à jour.* Le couplage établi le 09-01 tient : le poste de travail est dépositaire à la fois
  de la planification de cet audit et de la seule copie qui ne vive pas sur le VPS. **Rien ne
  vieillit plus vite qu'une sauvegarde dont le dépositaire est éteint.**
- **Vu** : 2026-09-01 · **Mesure à la découverte** : copie hors-site de `vizyo-verify` à **51 h**,
  seuil de péremption **48 h**. Destination : **PC local (D:)**. Contenu copié : 4 h — *la copie
  ne peut pas être plus fraîche que sa source, et la source, elle, est à jour.*
- **QUOI — la cause** : le **seul exemplaire des sauvegardes qui ne vive pas sur le VPS** a pour
  dépositaire un poste de travail — le même que celui qui porte la planification de cet audit.
  Cinq passages ont été manqués (27 → 31 août) ; la copie a vieilli au-delà de son seuil.
- **⚠️ Ce que l'audit ne peut PAS dire** : quelle tâche du poste effectue cette copie. Elle date
  de 51 h, soit le **08-30 vers 04 h 40** — donc **quelque chose a tourné le 08-30**, et ce
  n'était pas cet audit. Imputer la panne à l'absence de *ce* passage serait une concomitance
  d'horaire prise pour une identification (**VPS-M01**). **Le fait établi est le couplage** : les
  deux dépendent du même poste, et l'un des deux est une sauvegarde.
- **QUOI FAIRE** : donner un **second dépositaire** à la copie hors-site, indépendant du poste.
- **`aNePasFaire`** : ⚠️ **ne pas remonter le seuil de 48 h à 96 h pour éteindre l'alerte.** C'est
  le motif exact du correctif anti-bruit qui, sur le centre d'alerte de Tracky, a éteint l'alarme
  d'alimentation de 33 boîtiers sur 42 chaque nuit.

---

## VPS-038 — Six boîtiers se sont tus le dimanche en deux heures, tous dans la même flotte

- **Domaine** : données · **Gravité** : **1** (montée le 2026-09-05, sur le seuil écrit le 09-03) ·
  **Statut** : `A_TRAITER`
- ✅ **Vu : 2026-09-06 — PREMIER PASSAGE SANS PERTE NOUVELLE DEPUIS LE 08-31, ET LE CONSTAT RESTE
  EN GRAVITÉ 1.** Les quatorze silencieux d'hier sont les quatorze d'aujourd'hui, **chacun vieilli
  de vingt-quatre heures** : aucun nom neuf. Les trois chemins de code indépendants donnent
  **30 émetteurs contre 30** (`wire_logs`, `positions`, `position_sampling_decisions`). **La
  trajectoire s'arrête** : 39 · 39 · 38 · 38 · 32 · 32 · 32 · 30 · **30**.
  **La cohorte est à 134,4 – 136,3 h**, soit **5,6 jours**, tous les six `OFFLINE`, tous dans
  `2ad69ac1…`, tous encore rattachés à un véhicule.
  ⚠️ **Le constat NE redescend PAS**, et c'est le seuil qui le dit : il exige *« 32 sur une journée
  complète »*. Il est à **30**. *Un compteur qui arrête de descendre n'est pas un compteur qui
  remonte* — neuf boîtiers manquent toujours à l'appel.
  ⚠️ **Le total du registre est identique (14), et pour la bonne raison cette fois** : la
  ventilation par bande (VPS-M78) montre qu'**un seul boîtier a bougé**, de `1-3 j` (2 → **1**)
  vers `3-7 j` (6 → **7**) ; `6-24 h` reste à **0** et `> 7 j` à **6**. *Le déplacement d'un
  boîtier d'une bande à la suivante explique la totalité de l'écart : aucune entrée, aucune
  sortie.*
  ⚠️ **Et VPS-M83 est confirmé un SECOND jour** : les deux boîtiers que le rapport du 09-04 avait
  rangés hors cohorte — dont l'un déclaré *« garé pour la nuit »* — sont à **57,3 h** et **74,3 h**,
  et **aucun des deux n'a réémis**. Le second vient de franchir les trois jours.
  🆕 **Voir aussi VPS-039, écrit ce passage** : à effectif constant, le taux de rétention de
  l'échantillonnage perd 11 points en trois jours. ⚠️ **Ne pas confondre les deux** — l'un compte
  des émetteurs, l'autre mesure un taux.
- 🔴 **Vu : 2026-09-05 — GRAVITÉ 1. LE SEUIL ÉCRIT D'AVANCE ARRIVE À ÉCHÉANCE, ET IL N'EST PAS
  TENU.** Il exigeait le retour des six *« au passage du 2026-09-05 »* : ils sont muets depuis
  **108,6 à 110,6 heures**, soit **4,6 jours**, tous les six, tous `OFFLINE`, tous dans
  `2ad69ac1…`. **La montée en gravité ne repose sur aucune mesure neuve ni aucune interprétation :
  c'est le test écrit il y a deux jours qui se prononce.**
  ⚠️ **La PREMIÈRE branche du seuil n'est PAS franchie** : `2ad69ac1…` compte toujours **8
  silencieux sur 30**, dont 2 antérieurs à l'incident. Aucun septième boîtier de cette flotte ne
  s'est tu. C'est la **seconde** branche, datée, qui décide.
  🔴 **ET LA FLOTTE CONTINUE DE SE RÉDUIRE — deux boîtiers de plus le 09-03**, dans **deux flottes
  différentes** : `864035053277662` (`7cc3c2f7…`, dernière trame 09-03 18 h 38) et
  `864035054756649` (`88627f81…`, 09-03 01 h 45). `positions`, par jour, sur huit jours :
  **39 · 39 · 38 · 38 · 32 · 32 · 32 · 30** — soit **−23 %**.
  ⚠️ **Et le volume ne le montre toujours pas** : 21 464 lignes le 09-04 contre 21 930 le 09-03,
  **−2 %** pour **6 % d'émetteurs en moins**. Le rapport à J-7, lui, le dit : **×0,82**.
  ⚠️ **Ce que l'audit ne peut PAS dire, et ne dira donc pas** : si les trois pertes ont la même
  cause. Les six du 08-31 sont mono-flotte et groupés en deux heures ; les deux du 09-03 sont dans
  deux flottes et séparées de 17 heures. **Les traiter comme un seul incident serait une hypothèse,
  pas une mesure** (VPS-M01). Le fait établi est la trajectoire.
  ⚠️ **Ne pas lire « 14 muets au registre » contre « 14 hier » comme une stabilisation** : le total
  est identique, les **bandes** ont bougé (`6-24 h` : 1 → **0** ; `1-3 j` : 1 → **2**). Le boîtier
  qui était à 7 h 30 est à **31 h 30** — il a changé de bande, pas disparu (VPS-M78).
  🔑 **Nouveau seuil de réescalade** : redescend en **gravité 2** dès que le compte d'émetteurs de
  `positions` repasse à **32 sur une journée complète**, et en `SURVEILLANCE` à **38**. Reste en
  gravité 1 tant que ce compte ne remonte pas, **quel que soit** l'état des autres compteurs.
- 🔴 **Vu : 2026-09-04 — LA COHORTE EST INCHANGÉE À SIX, MUETS DEPUIS 84 À 86 h.** Dernières
  trames toujours du **08-31 entre 11 h 53 et 13 h 50**. **Le seuil de réescalade n'est PAS
  atteint** : il exigeait *« un septième boîtier de la flotte `2ad69ac1…` »*, et il n'y en a pas.
  Flotte mesurée **31 émetteurs contre 32**, confirmé **indépendamment** par `positions`
  (31 contre 32) ; débit par boîtier **106,6 trames/h** contre 111,0 (**−4 %**, dans la bande).
  **La seconde branche du seuil — l'absence de retour au passage du 2026-09-05 — arrive à
  échéance demain.**
  ⚠️⚠️ **ET IL NE FAUT PAS LIRE « 14 MUETS AU REGISTRE » CONTRE « 12 HIER » COMME UNE EXTENSION
  DE LA PANNE.** Les deux boîtiers supplémentaires appartiennent à **d'autres flottes**
  (`7cc3c2f7…` et `88627f81…`) et sont muets depuis **7 h 30** et **24 h 30** — le premier est un
  véhicule **garé pour la nuit**. Voir **VPS-M78**, écrit ce passage : *un total sans fenêtre monte
  pour des raisons qui ne sont pas la panne.* La ventilation par flotte, mesurée ce passage :
  `2ad69ac1…` **8 silencieux sur 30** (dont **2 antérieurs** à l'incident, 08-19 et 08-21),
  `88627f81…` 2 sur 4, `7cc3c2f7…` 1 sur 7, et **3 boîtiers sans aucun véhicule**.
  🔴 **CONSTAT NEUF DU 2026-09-04, révélé par cette ventilation** : **5 boîtiers sont muets depuis
  plus de 7 jours, jusqu'à 91** (`864035054756177` 13,6 j, `864035054756730` 15,6 j,
  `864035053277480` 21,0 j, `864035054756292` 64,8 j, `863378070030776` 90,6 j), dont **3 sans
  véhicule**. Ce n'est pas une panne : c'est du matériel déposé qui n'a jamais été sorti du parc,
  et il représente **11 des 32 points** de « flotte muette » affichés en permanence. ⚠️ Décision
  **produit** (statut de sortie de parc), pas action VPS — et **ne pas les `DELETE`** : un boîtier
  supprimé perd son historique de rattachement.
- 🔴 **Vu : 2026-09-03 — LES SIX SONT MUETS DEPUIS 60 h 30, ET AUCUN SEPTIÈME NE S'EST AJOUTÉ.**
  Dernières trames inchangées à la seconde (08-31, 11 h 53 min 43 → 13 h 50 min 47). **La flotte
  est stable à 32 contre 32** sur les deux fenêtres de 24 h, et `positions` le confirme désormais
  **par un chemin de code indépendant** (32 contre 32) — le discriminant y est automatique depuis
  ce passage. Débit par boîtier **111,0 trames/h** contre 113,2 : stable à 2 %.
  **Le seuil de réescalade n'est pas atteint** — il exige un septième boîtier de la flotte, ou
  l'absence de retour au passage du **2026-09-05**. Il reste deux jours.
  ⚠️⚠️ **ET IL NE FAUT SURTOUT PAS LIRE « 6 MUETS » CONTRE « 7 HIER » COMME UN PROGRÈS.** Le
  septième (`864035054755856`) n'est pas revenu : il a **0 ligne** dans `wire_logs`, dont la borne
  basse est passée au 08-30 03 h 00. Le registre `trackers`, sans rétention, compte **12
  silencieux sur 44 les deux jours**. Voir **VPS-M76**, écrit ce passage : *un compteur de silence
  borné par une rétention décroît à mesure que la panne dure.*
- **Vu** : 2026-09-02 · **Mesure à la découverte** : `wire_logs` passe de **38 à 32 émetteurs
  distincts** sur 24 h (×0,84), et `positions` de **38 à 32 traceurs distincts** par jour. Les six
  dernières trames tombent entre le **2026-08-31 11 h 53 min 43** et le **2026-08-31 13 h 50 min 47
  UTC**, soit une fenêtre de **1 h 57**. Les six sont **tous rattachés à la flotte `2ad69ac1…`**
  (30 boîtiers) et **tous marqués `OFFLINE`** dans `trackers`.

  ```
  864035054757027  2026-08-31 11:53:43      864035054756102  2026-08-31 13:15:45
  864035054756755  2026-08-31 12:30:40      864035054756714  2026-08-31 13:50:25
  864035054756763  2026-08-31 12:48:28      864035054489431  2026-08-31 13:50:47
  ```

  Comptage horaire : **38 → 37 → 35 → 32 → 31 → 30** entre 11 h et 16 h le 08-31, puis **plat à
  32 pendant 27 heures** (09-01 00 h → 09-02 02 h).

- **🔑 LA CONTRE-ÉPREUVE QUI DÉCIDAIT DE TOUT.** Un compteur d'émetteurs qui baisse peut vouloir
  dire « six boîtiers sont morts » **ou** « la colonne `imei` a cessé d'être remplie » — et la
  seconde hypothèse fabriquerait un incident majeur à partir d'un défaut d'écriture. Le
  discriminant est une **seconde table alimentée par un autre chemin de code** : `positions`
  compte **38 traceurs distincts du 08-27 au 08-31, puis 32 les 09-01 et 09-02**. Les deux tables
  donnent le même nombre le même jour. *La perte est réelle.*

- **⚠️ ET LE DÉBIT TOTAL NE LA MONTRE PAS** : `positions` fait **23 952 lignes le 09-01** contre
  **22 211 le 08-31** — *plus* de lignes avec *moins* de traceurs. C'est le mode d'échec exact que
  le discriminant de flotte existe pour empêcher : **une flotte amputée de 16 % se lit comme une
  journée normale** si l'on ne regarde que le volume.

- **QUOI — la cause** : **six arrêts indépendants ne tombent pas dans une fenêtre de deux heures.**
  Il y a une cause commune, et l'appartenance des six à une **seule flotte** la resserre encore.
  ⚠️ **Ce que l'audit ne peut PAS dire depuis la machine, et ne dira donc pas** : laquelle. Un
  site partagé (dépôt, parking), une coupure d'opérateur ou de SIM, une action de flotte et une
  panne d'alimentation groupée produisent **la même trace ici**. Nommer l'une d'elles serait
  VPS-M01 — une plausibilité présentée comme une identification.
  ⚠️ **Ce n'est pas un déploiement** : les quatre reconstructions de `tracky-api` du 09-01
  (09 h 35, 14 h 23, 14 h 46, 15 h 09) sont **postérieures de 20 à 25 heures** au dernier arrêt.

- **`pourquoiInvisible`** : le rapport du **2026-09-01 à 07 h 39** a publié *« la flotte est
  intacte : 38 émetteurs distincts sur 24 h contre 38 les 24 h précédentes, 15ᵉ jour sans
  perte »* — **dix-huit heures après** l'arrêt des six. Le compteur n'avait pas tort : sa fenêtre
  de 24 h remontait au 08-31 07 h 39 et contenait encore leurs dernières trames. **Une comparaison
  « 24 h contre 24 h » ne peut structurellement pas détecter un arrêt de moins de 24 heures**, et
  rien dans la sortie ne le disait. Voir **VPS-M75**, corrigé le jour de la découverte.

- **Le décompte complet est pire que six.** La mesure de fraîcheur ajoutée par VPS-M75 compte
  **7 émetteurs muets depuis plus de 6 h** dans `wire_logs` : le septième
  (`864035054755856`) s'est tu le **2026-08-29 à 21 h 15**, donc **hors des deux fenêtres de
  24 h** — invisible à la comparaison par construction. Et `trackers` en dénombre **12 silencieux
  sur 44** (32 vus dans les 6 dernières heures), dont **8 des 30 de la flotte `2ad69ac1…`, soit
  27 %** : les six du 08-31, plus `864035054756730` (08-19) et `864035054756177` (08-21).

- **Ce que ce constat N'EST PAS** : **ni un défaut du VPS, ni un angle mort de l'application.** Les
  six sont marqués `OFFLINE` dans `trackers`, donc le centre d'alerte de Tracky dispose de
  l'information. Le rôle de ce constat est de **dater la perte à l'heure**, d'établir qu'elle est
  **groupée** et **mono-flotte**, et de fournir les six IMEI — ce que ni le centre d'alerte ni
  l'écran ne produisent sous cette forme.

- **QUOI FAIRE** : **rien sur le VPS.** La chaîne d'ingestion est saine, et c'est mesuré : les 32
  boîtiers restants émettent **113,2 trames/h chacun** contre 104,2 la veille, et `positions` est
  à **×1,03** contre la veille et **×0,95** contre J-7. L'action est côté produit : porter ces six
  IMEI et l'heure de leur dernière trame à l'exploitant de la flotte `2ad69ac1…`, et **chercher ce
  qu'ils ont en commun** — site, lot d'installation, opérateur SIM.

- **`aNePasFaire`** : ⚠️ **ne pas lire la hausse de 104,2 → 113,2 trames/h/boîtier comme une
  amélioration de cadence.** Le numérateur n'a pas monté, **le dénominateur a baissé** — c'est
  VPS-M71 sous une autre forme : une moyenne dont on ne surveille pas l'effectif.
  ⚠️ **Ne pas lire le seuil de VPS-035 comme rassurant** : 113,2 est bien dans la bande 60–300,
  mais ce seuil est écrit **par boîtier** et ne dit rien du **nombre** de boîtiers. *Un seuil par
  tête ne voit pas une flotte qui rétrécit.*
  ⚠️ **Ne pas purger ni archiver ces boîtiers** dans l'application pour « nettoyer » le compte :
  ils sortiraient du dénominateur et le constat se refermerait tout seul, sans qu'un seul véhicule
  ait été retrouvé.

- **Seuil de réescalade** : passer en **gravité 1** si un septième boîtier de la flotte
  `2ad69ac1…` se tait, **ou** si les six ne sont pas revenus au passage du **2026-09-05** (cinq
  jours de silence). Redescendre en `SURVEILLANCE` dès que le compte d'émetteurs de `wire_logs`
  repasse à 38 sur 24 h.

---

## VPS-039 — ~~Le taux de rétention de l'échantillonnage perd 11 points en trois jours~~ → **RÉFUTÉ : la flotte roulait de moins en moins**

- **Domaine** : données · **Gravité** : 4 · **Statut** : `ACCEPTE` — **réfuté le 2026-09-06, le jour
  même de son ouverture**
- ✅ **RÉFUTÉ : 2026-09-06 (quelques heures après l'ouverture du constat).** La table
  `position_sampling_decisions` porte deux colonnes que je n'avais pas ouvertes — `decision` (le
  motif de chaque rejet) et `state` (l'état du véhicule). Elles répondent, sans attendre le
  2026-09-09, à la question que ce constat déclarait non tranchable :

  ```
     jour        MOVING   STOPPED   SKIPPED_THROTTLE   taux retenu
   jeu 09-03      28,0 %    70,1 %        60,4 %          40,8 %
   ven 09-04      25,3 %    72,9 %        62,3 %          34,7 %
   sam 09-05      18,6 %    79,9 %        68,6 %          29,8 %
   dim 09-06       1,6 %    98,1 %        85,8 %          14,1 %  (partiel)
  ```

  **Le taux de rétention suit la part de véhicules EN MOUVEMENT.** L'échantillonneur bride les
  trames des véhicules à l'arrêt — c'est sa fonction. La flotte a roulé de moins en moins du jeudi
  au dimanche ; **il n'y a pas de dérive, il y a un week-end.** Aucune action.
  ⚠️ **Réserve de mesure, écrite plutôt que tue** : les 40,8 % de la découverte viennent d'un
  rapport `positions` / `decisions` **entre deux tables** ; la table des décisions rend **36,4 %**
  d'`INSERTED` pour le même jour (+0,8 % de `RECOVERED_BUFFER`). Les niveaux absolus diffèrent —
  bornes de journée, et des positions arrivent par des chemins qui ne journalisent pas de
  décision. **La pente, elle, est identique**, et c'est elle qui portait le constat.
  🔑 **Ce que ce constat laisse derrière lui, et qui vaut mieux que lui** : voir **VPS-M85**. La
  réfutation que j'avais écrite le matin même était fondée sur la **mauvaise grandeur**, et la
  colonne qui nommait la cause était **dans la table d'à côté, depuis toujours**.
  ⚠️ **Et il laisse une conséquence produit, elle bien réelle** : un seuil d'alerte à « ≤ 32 % »
  aurait crié **13,7 % le jour de sa mise en service**, un dimanche, parce que les camions sont au
  parking. *Un instrument calibré sur ce constat serait né faux.*
- **Vu** : 2026-09-06 · **Mesure à la découverte** : la part des décisions d'échantillonnage qui
  devient une position enregistrée passe de **40,8 % → 34,7 % → 29,8 %** en trois jours, sur une
  flotte **stable à 30 émetteurs** et un volume de décisions **stable** (53 810 · 61 832 · 58 423).

  ```
     jour      sem  emetteurs  positions  decisions  pct_retenu  par_emetteur
   2026-09-03  Thu      32       21930      53810      40.8 %         685
   2026-09-04  Fri      30       21464      61832      34.7 %         715
   2026-09-05  Sat      30       17399      58423      29.8 %         580
   2026-09-06  Sun      30        1477      10505      14.1 %          49   ← PARTIEL
  ```

- **QUOI — ce qui est établi, et rien de plus** : c'est cette grandeur qui porte l'écart entre les
  trois compteurs de la section 5 — `wire_logs` **×0,95** (trames reçues),
  `position_sampling_decisions` **×0,94** (décisions prises), `positions` **×0,81** (positions
  écrites). *L'ingestion va bien, l'échantillonneur tourne : c'est sa sortie qui rétrécit.*

- **⚠️ Ce que l'audit ne peut PAS dire, et ne dira donc pas** : **ni la cause, ni s'il s'agit d'une
  dérive.** Deux limites, toutes deux mesurées :
  1. **La fenêtre ne fait que trois jours.** `position_sampling_decisions` a une rétention de
     **3,03 j** : il n'existe aucun point avant le 09-03. **Trois points ne distinguent pas une
     pente d'un cycle hebdomadaire** — c'est l'angle mort n° 3 du référentiel qui se paie ici pour
     la première fois.
  2. **Le 09-05 est un samedi — mais l'explication « c'est le week-end » est FAIBLE, et c'est
     mesuré** : sur `positions` par émetteur, le samedi 08-29 rendait **610** contre **619** le
     vendredi (−1 %), quand le dimanche 08-30 tombait à **395** (−35 %). *Le samedi n'est pas un
     jour creux sur cette flotte ; le dimanche l'est.* Un samedi n'explique pas 11 points.

- **`pourquoiInvisible`** : **aucun compteur vert ne la montre.** Les trois lignes de flotte
  affichent `✅ flotte STABLE (30 contre 30)` et le débit de `positions` est déclaré `✅ stable
  (×0,81, dans la bande 0,67-1,50)`. **Chaque contrôle dit vrai séparément** ; c'est le *rapport*
  entre deux d'entre eux qui bouge, et il n'était calculé nulle part.

- **🔑 Seuil de réescalade — le test de réfutation, écrit d'avance** : **au passage du 2026-09-09**,
  le premier qui mesurera une **journée ouvrée pleine** (mardi 09-08), le taux doit être revenu à
  **38 % ou plus**. S'il l'est, la variation était un cycle hebdomadaire et le constat se referme.
  **S'il reste à 32 % ou moins, l'hypothèse du cycle est réfutée** : dérive établie, **gravité 2**
  confirmée, enquête côté produit.

- **`aNePasFaire`** :
  ⚠️ **Ne PAS trancher sur le passage du 2026-09-07** : il mesurera un **dimanche**, le seul jour
  dont on sait déjà qu'il est creux sur cette flotte (395 contre 610). *Un test qui tombe le jour
  où la mesure ne veut rien dire est **VPS-M41**, et il a déjà été payé une fois.*
  ⚠️ **Ne pas lire ce constat comme une aggravation de VPS-038.** VPS-038 compte des **émetteurs**
  (30, stable) ; celui-ci mesure un **taux à effectif constant**. Les confondre ferait croire que
  la flotte continue de tomber alors qu'elle a arrêté.
  ⚠️ **Ne pas se réjouir de la baisse de volume de `positions`.** La projection à fenêtre pleine
  descend de 324 Mo — mais un gain de disque obtenu en écrivant moins de positions n'est un gain
  que si l'on a **décidé** d'en écrire moins.

- **QUOI FAIRE** : **rien aujourd'hui, et c'est le point.** Attendre le 2026-09-09 et appliquer le
  test. La seule action utile d'ici là serait côté produit : savoir si une consigne
  d'échantillonnage a été modifiée entre le 09-03 et le 09-05 — question qui se pose à un humain,
  pas à la machine.

---

## Constats de méthode (sur l'audit lui-même)

### VPS-M86 — La note de passation existait, elle répondait d'avance à quatre questions, et deux passages de suite ne l'ont pas ouverte

- **Domaine** : méthode · **Gravité** : **2** · **Statut** : ✅ `APPLIQUE` le 2026-09-06 (le fichier
  est retiré, son contenu versé dans la roadmap unique)
- **Vu** : 2026-09-06 · **Mesure à la découverte** : `docs/vps-audit/ROADMAP.md` se terminait par une
  section **« ⚠️ POUR L'AGENT D'AUDIT DE DEMAIN (2026-09-05) »**, écrite le 04/09. Elle répondait
  **d'avance** à quatre questions que les passages suivants ont traitées comme ouvertes :

  | ce que la note disait, le 04/09 | ce que les passages ont fait |
  |---|---|
  | *« Trois sauvegardes ponctuelles ont été créées le 2026-09-04 vers 04 h 52. Aucun timer n'a été posé. »* | **VPS-M81** (05/09) a consacré un chapitre entier à identifier l'auteur du dump |
  | *« Vérifier que le correctif VPS-M59 est déployé, pas seulement commité. »* | Le rapport du 06/09 republie VPS-M59 en **angle mort ouvert, « hors de portée de l'agent », 11ᵉ report** — deux jours après sa correction |
  | *« `tracky-backup` n'a pas d'`OnFailure=` non plus. »* | Jamais repris : le périmètre doublé de VPS-015 est resté invisible |
  | *« Quatre tâches sont prêtes, leurs digests sont relevés — ne pas les re-préparer. »* | Le plan d'action du 06/09 redemande de relever les digests |

- **QUOI — la cause, et elle est dans la procédure, pas dans la négligence** : le §3 de
  `PROCEDURE-AUDIT.md` impose de relire **`REFERENCE-CONSTATS.md` en entier** et **le dernier
  rapport**. **Il ne mentionne pas la roadmap.** Or c'est exactement là que le passage du 04/09 —
  le seul qui ait agi sur la machine — avait déposé ce qu'il avait fait et ce qu'il fallait
  vérifier ensuite. *La passation n'a pas été omise : elle a été écrite dans le seul fichier que
  la procédure n'oblige pas à ouvrir.*

- **`pourquoiInvisible`** : **une note de passation ne produit aucun symptôme quand on ne la lit
  pas.** Elle ne casse rien, ne rend pas de chiffre faux, ne déclenche aucun contrôle. Son
  non-usage se voit uniquement à ceci — *l'audit redécouvre, à grands frais, ce qui était écrit.*
  Et cette redécouverte **ressemble à du bon travail** : VPS-M81 est un constat juste, bien
  argumenté, qui a produit un correctif utile. *Rien, dans son résultat, ne trahit qu'il était
  inutile.*

- **QUOI FAIRE** — **appliqué ce passage, et le correctif est structurel** : il n'y a plus qu'**une
  seule roadmap**, `docs/centre-alerte/ROADMAP-CORRECTIFS.md`, et elle porte les deux dispositifs.
  Le contenu de passation y est versé. ⚠️ **Reste à faire, et ce n'est pas fait** : ajouter la
  roadmap à la liste de lecture obligatoire du §3 de `PROCEDURE-AUDIT.md`. *Sans quoi le même
  oubli se rejouera sur le nouveau fichier — on aura déplacé la note, pas l'habitude.*

- **`aNePasFaire`** : ⚠️ **ne pas en conclure qu'il ne faut plus écrire de note de passation.**
  Elle était juste, complète et datée ; c'est sa **place** qui était mauvaise. ⚠️ Et **ne pas
  supprimer VPS-M81 pour autant** : le correctif qu'il a produit (l'écart entre deux salves, qui
  distingue un mécanisme d'un geste) est **bon et il reste**. *Un travail redondant n'est pas un
  travail faux.*

- **Gain** : deux constats republiés à tort en moins (VPS-M59, VPS-M81), quatre jeux de valeurs
  préparées récupérés, et un élargissement de VPS-015 qui touche **la sauvegarde de la base de
  production principale** (`tracky_prod`, 5,7 Go) — *lequel serait resté invisible.*

---

### VPS-M85 — J'ai réfuté la bonne hypothèse avec la mauvaise grandeur, et la colonne qui nommait la cause était dans la table d'à côté

- **Domaine** : méthode · **Gravité** : 2 · **Statut** : ✅ `APPLIQUE` le 2026-09-06 (règle
  d'enquête, pas de code)
- **Vu** : 2026-09-06 · **Mesure à la découverte** : le rapport du matin ouvrait **VPS-039** en
  écrivant *« ni la cause, ni s'il s'agit d'une dérive »* et en datant un test au **2026-09-09**.
  La cause était mesurable **le matin même**, dans `position_sampling_decisions.state` : le taux de
  rétention suit la part de véhicules `MOVING` (28,0 → 25,3 → 18,6 → 1,6 %). **Constat réfuté le
  jour de son ouverture.**

- **QUOI — la cause, et elle n'est pas « je n'ai pas cherché »** : j'ai bien formulé l'hypothèse
  du cycle hebdomadaire, et j'ai bien voulu la tester. **J'ai simplement testé avec une grandeur
  qui ne pouvait pas y répondre.** J'ai comparé les *positions par émetteur* du samedi 08-29 (610)
  au vendredi 08-28 (619) et conclu *« le samedi n'est pas un jour creux sur cette flotte »*. La
  grandeur qui répondait était la **part de `MOVING`**, et elle, elle tombe.
  🔑 **Une réfutation est une mesure comme une autre : elle doit porter sur la grandeur dont
  parle l'hypothèse.** « La flotte roule-t-elle moins ? » ne se teste pas avec un volume de
  lignes écrites — qui dépend *à la fois* du roulage et de l'échantillonnage — mais avec la part
  de temps en mouvement, qui ne dépend que du roulage.

- **`pourquoiInvisible`** : **parce que la réfutation avait l'air rigoureuse.** Elle citait deux
  chiffres réels, comparait le bon jour de semaine, et concluait explicitement contre le confort
  (*« l'explication est mesurable, alors je l'ai mesurée »*). Rien dans sa forme ne trahissait que
  l'instrument était le mauvais. *Un raisonnement faux qui se donne les gestes de la rigueur est
  plus difficile à attraper qu'un raisonnement paresseux — il a déjà passé le contrôle qu'on
  aurait fait.*
  ⚠️ **Et le collecteur ne pouvait pas rattraper ça** : il lit trois tables et n'a jamais ouvert
  les colonnes `decision` et `state`, qui existent pourtant **depuis la création de la table**.

- **QUOI FAIRE** — deux règles, et la seconde compte plus que la première :
  1. **Avant de dater un test dans le futur, épuiser les colonnes du présent.** Un test à J+3 est
     une dette ; il ne se justifie que si la donnée d'aujourd'hui ne peut pas répondre. Ici elle
     pouvait, et personne n'avait regardé le schéma.
  2. **Écrire, à côté de chaque réfutation, la grandeur qu'elle emploie et pourquoi c'est
     celle-là.** *« Je teste "la flotte roule moins" avec les positions par émetteur »* aurait
     rendu l'erreur visible à la relecture : les positions par émetteur dépendent de deux facteurs,
     et l'hypothèse n'en nomme qu'un.

- **`aNePasFaire`** : ⚠️ **ne pas en conclure qu'il fallait s'abstenir de réfuter.** L'abstention
  est le défaut symétrique, et il est pire : c'est VPS-M83, qui laisse une explication rassurante
  sans test. **Le geste était juste, l'instrument était faux** — il fallait réfuter, avec la part
  de `MOVING`.
  ⚠️ **Ne pas ajouter la mesure de `MOVING` au collecteur VPS par réflexe.** Elle appartient à
  l'application, pas à l'audit machine : c'est une sentinelle du centre d'alerte que ce constat a
  fait naître, pas une section de plus dans une collecte déjà à 116 s pour un budget de 90.

- **Gain** : un constat de gravité 2 fermé **trois jours avant son échéance**, et une sentinelle
  qui, calibrée sur le constat non réfuté, serait née fausse — elle aurait crié **13,7 % un
  dimanche**, son premier jour.

---

### VPS-M84 — Deux blocs de la même section rendaient des verdicts opposés sur les mêmes fichiers

- **Domaine** : méthode · **Gravité** : 2 · **Statut** : ✅ `APPLIQUE` le 2026-09-06
- **Vu** : 2026-09-06 · **Mesure à la découverte** : à **47 h**, `vizyo-manager` et `vizyo-texto`
  étaient **« ✅ à jour (1 j) »** dans la table de couverture et **« ⚠️ PÉRIMÉE (> 30 h) »** vingt
  lignes plus bas, **dans la même section, sur les mêmes fichiers**.

  ```
  ── Couverture : chaque base EN SERVICE a-t-elle une sauvegarde ? ──
    texto-postgres             ✅ a jour (1 j)          vizyo-texto
    vizyo-manager-postgres     ✅ a jour (1 j)          vizyo-manager
  ── Age de la derniere sauvegarde, par dossier ──          ← VINGT LIGNES PLUS BAS
    vizyo-manager               47 h  ⚠️ PERIMEE (> 30 h)
    vizyo-texto                 47 h  ⚠️ PERIMEE (> 30 h)
  ```

- **QUOI — la cause** : **deux unités et deux seuils dans le même bloc de code.** La table de
  couverture calculait `(MAINTENANT - recent) / 86400` — des **jours entiers, tronqués** — et
  alertait à `>= 2`, soit **48 h**. Le bloc voisin calcule un `age_h` en **heures** et alerte à
  **30 h**. **Entre 30 h et 48 h s'ouvre une bande aveugle de dix-huit heures.**

- **`pourquoiInvisible` — et c'est la ligne verte qui gagne** : la table de couverture nomme les
  **conteneurs**, le bloc par dossier nomme des **répertoires**. Pour rapprocher les deux il faut
  déjà savoir que `vizyo-texto` est la sauvegarde de `texto-postgres`. Un lecteur s'arrête à la
  première — c'est elle qui pose la question et qui porte les ✅ — et n'a aucune raison de
  descendre vérifier qu'on lui dit l'inverse.
  ⚠️ **Et le moment était le pire possible** : les trois lignes vertes portaient sur les **trois
  bases de VPS-013**, seul constat de gravité 1 encore ouvert — celles-là mêmes que **VPS-M81**
  venait de sauver, la veille, d'un faux vert.

- **La famille, à sa troisième forme** : **VPS-M15** lisait la trace et jamais l'unité qui la
  produit ; **VPS-M81** confondait l'âge et le mécanisme ; celui-ci **mesure deux fois la même
  chose avec deux règles** et publie les deux. *À chaque fois, la version rassurante est celle qui
  reste à l'écran.*

- **Le correctif** : le **même seuil de 30 h des deux côtés**, l'âge affiché en **heures** sous
  48 h, et une bande neuve `🟠 NUIT MANQUÉE`.
  ⚠️ **Elle ne remplace PAS « en retard », et c'est délibéré** : 31 h est une **exécution sautée**,
  3 jours un **mécanisme arrêté**. Les fondre reperdrait ce que ce correctif fait gagner.

- **Contre-épreuve** : jouée sur la machine sur **12 âges couvrant les 5 branches** (0, 12, 29, 30,
  31, 47, 48, 71, 96, 167, 168, 200) **plus la branche dégénérée** (dossier vide) → **zéro
  divergence** avec le bloc voisin. Rejouée sur les **7 dossiers réels** : `capcom6`,
  `vizyo-manager` et `vizyo-texto` basculent de `✅ à jour (1 j)` à `🟠 NUIT MANQUÉE (47 h)`.
  ⚠️ **Portée honnête du banc** : il itère `/var/backups` directement, là où le collecteur
  rapproche par une clé. Il valide **le verdict**, pas le rapprochement.
  ⚠️ **Le vrai risque n'était pas dans la bande neuve, il était aux DEUX BORNES** : le premier banc
  n'exerçait que 31 h et 47 h, et ils passaient tous les deux. C'est en ajoutant **48, 167 et 168**
  que la frontière `ABANDONNEE` a été vérifiée intacte après changement d'unité.

- **`aNePasFaire`** : ⚠️ **ne pas supprimer le bloc « âge par dossier » sous prétexte qu'il fait
  doublon.** Les deux ne couvrent pas le même ensemble : la couverture part des **bases en
  service**, le bloc par dossier part des **dossiers existants** — et c'est ce second qui voit un
  dossier de sauvegarde dont la base a disparu. *Le défaut était la divergence de seuil, pas la
  redondance.*

- **COÛT : ZÉRO commande supplémentaire** — `recent` était déjà un horodatage epoch, il était
  seulement divisé trop tôt.

---

### VPS-M83 — Une explication rassurante offerte sans le test qui la réfuterait

- **Domaine** : méthode · **Gravité** : 2 · **Statut** : ✅ `APPLIQUE` (règle de rédaction, pas de code)
- **Vu** : 2026-09-05 · **Mesure** : le rapport du 2026-09-04 a écrit qu'un boîtier muet depuis
  **7 h 30** était *« un véhicule **garé pour la nuit** »*. Vingt-quatre heures plus tard il est à
  **31,5 h**, le second boîtier de la même phrase à **48,6 h**, et **aucun des deux n'a réémis**.
  `positions` confirme leur départ par un chemin indépendant : **32 émetteurs le 09-03, 30 le 09-04**.
- **QUOI — la cause** : **le détecteur avait raison, la rédaction est allée plus loin que lui.** La
  ventilation par bande refusait de compter ces deux boîtiers comme une extension de VPS-038 —
  c'était juste, ils sont dans d'autres flottes et ils y restent. Mais la bande `6-24 h` porte le
  commentaire *« un véhicule garé la nuit entre ici »* : c'est une **liste de possibles**, et elle
  a été lue puis republiée comme un **diagnostic**.
- **`pourquoiInvisible`** : parce qu'une explication plausible ne coûte rien à écrire, rassure
  immédiatement, et n'a **pas de compteur qui la contredise**. Contrairement à un chiffre faux,
  elle ne laisse aucune trace mesurable — sauf le jour où elle est démentie.
- **QUOI FAIRE** : **une explication écrite pour désamorcer un chiffre doit porter le test qui la
  réfuterait, ou ne pas être écrite.** « Garé pour la nuit » avait un test évident et gratuit —
  *il doit avoir réémis au passage suivant* — et il n'a pas été écrit. Le seul énoncé que la mesure
  autorisait était : *« deux boîtiers d'autres flottes, muets depuis 7 h 30 et 24 h 30 ; à revoir
  demain. »*
- **`aNePasFaire`** : ⚠️ **ne pas ajouter de sonde au collecteur pour ça.** `collecte.sh` dit déjà
  la bonne chose (*« Ne PAS le compter comme une panne **sans une autre preuve** »*). Ajouter un
  mécanisme pour se protéger de sa propre plume serait le mauvais remède, et il coûterait à une
  machine à 2 vCPU.
- **Famille** : VPS-M01 sous sa forme la plus discrète — non pas une concomitance prise pour une
  identification, mais une **cause nommée** pour clore un chiffre gênant ; puis VPS-M55, qui décrit
  la republication d'une attribution jamais réexaminée.

---

### VPS-M82 — Un contrôle d'intégrité qui imprimait sa propre réfutation, sur la ligne d'à côté

- **Domaine** : méthode · **Gravité** : 3 · **Statut** : ✅ `APPLIQUE` (corrigé le 2026-09-05)
- **Vu** : 2026-09-05 · **Mesure** : l'archive `capcom6_sms_20260904-045204.sql.gz` — un
  `mysqldump` **parfaitement complet** — était affichée :

  ```
  🟠 capcom6   se relit, mais SANS le marqueur de fin de pg_dump — dump interrompu, ou
               archive qui n est pas un pg_dump.
               Derniere ligne : -- Dump completed on 2026-09-04  4:52:05
  ```

- **QUOI — la cause** : le motif cherché était `dump complete`, en **minuscules** et sans variante.
  `pg_dump` écrit *« PostgreSQL database dump complete »* ; `mysqldump` écrit
  *« -- Dump completed on \<date\> »* — majuscule, et « complet**ed** ». `capcom6-mysql` est le seul
  MySQL de la machine : le contrôle était **monolingue** sur un parc bilingue.
- **`pourquoiInvisible`** : parce que le 🟠 était **plausible**. Un dump interrompu est un mode de
  panne réel, la phrase de repli disait déjà *« ou archive qui n'est pas un pg_dump »*, et le seul
  objet concerné est une base secondaire. **La preuve du contraire était imprimée par le contrôle
  lui-même, une ligne plus bas, et personne ne l'avait rapprochée.**
- **QUOI FAIRE** : motif **nommé par moteur**, et la sortie dit **lequel** a été trouvé —
  *(marqueur pg_dump)* ou *(marqueur mysqldump)*. Un élargissement futur redevient visible au lieu
  d'être silencieusement laxiste.
- **Contre-épreuve — c'est la branche du REFUS qui comptait.** Élargir un motif de validation
  risque de rendre le contrôle permissif : un **témoin fabriqué** (archive gzip valide, aucun
  marqueur) est bien signalé 🟠. Les 6 archives réelles rendent 6 marqueurs identifiés, **0 🟠**.
- **`aNePasFaire`** : ⚠️ **ne pas remplacer le motif par un `grep -qi "dump"`.** N'importe quelle
  ligne de commentaire contenant le mot passerait : le contrôle deviendrait vert sur une archive
  tronquée, ce qui est le seul défaut qu'il existe pour attraper.

---

### VPS-M81 — « À jour » ne veut pas dire « sauvegardée » : trois bases vertes sur un geste manuel

- **Domaine** : méthode · **Gravité** : 2 · **Statut** : ✅ `APPLIQUE` (corrigé le 2026-09-05)
- **Vu** : 2026-09-05 · **Mesure** : la table de couverture affichait

  ```
  vizyo-manager-postgres  ✅ a jour (0 j)   |  texto-postgres  ✅ a jour (0 j)
  capcom6-mysql           ✅ a jour (0 j)
  ```

  **sur les trois bases exactes que VPS-013 signale sans filet depuis 27 passages.** Le contenu de
  `/var/backups` tranche : **une copie chacune, toutes les trois horodatées `2026-09-04 04:52:04`
  — la même seconde.** Aucun timer, aucun cron, aucun script ne les rejouera.

- **QUOI — la cause** : **la table ne mesure qu'une chose, l'ÂGE de la copie la plus récente**, et
  cette grandeur ne distingue pas un **mécanisme** d'un **geste**. Elle aurait affiché `✅ à jour`
  le lendemain (1 j), `🟠 en retard` le surlendemain, et ne serait repassée au rouge qu'au
  **septième** jour — pendant lequel le seul constat de gravité 1 encore ouvert du référentiel
  aurait paru refermé.
- **⚠️ Et le script qui aurait pu les produire existe, sans appelant** :
  `/opt/vizyo-manager/deploy/backup-db.sh`, daté du **2026-03-21**, n'est cité par aucun cron,
  aucune unité, aucun fichier de `/root`. Il n'est même pas l'auteur du fichier du 09-04 : il nomme
  ses archives `vizyo_manager_<date>_<heure>` (souligné) — forme des 25 copies antérieures, la
  dernière du **2026-04-15** — alors que le fichier neuf porte un **tiret**, comme ceux de `texto`
  et `capcom6`. *Trois fichiers, une convention commune, une seule seconde : un geste.*
- **`pourquoiInvisible`** : parce que le contrôle **disait vrai**. La copie a bien 0 jour. C'est la
  question qui n'était pas celle qu'on croyait poser : on demandait *« cette base est-elle
  sauvegardée ? »* et on mesurait *« quel âge a le dernier fichier ? »*. Le bloc « L'unité qui
  PRODUIT chaque sauvegarde » existe précisément pour l'autre moitié — il ne liste que 4 unités,
  aucune pour ces trois bases — mais **rien ne rapprochait les deux blocs de la même section**, et
  un lecteur lit la table, pas la liste d'unités au-dessus.
- **QUOI FAIRE** : publier l'**écart entre la copie la plus récente et la SALVE précédente**. Une
  cadence en laisse une trace régulière ; un geste unique, non. Mesuré ce passage :
  `vizyo-manager` **salve précédente à 142 j**, `texto` / `capcom6` / `vizyo-auth` **une seule
  salve**, `vizyo-tracky` **24 h**, `vizyo-verify` **23 h**.
- **⚠️ DÉFAUT DE MON PROPRE CORRECTIF, ATTRAPÉ AU BANC AVANT PUBLICATION.** La première version
  comparait les deux **fichiers** les plus récents. Or `vizyo-verify` en dépose **deux par
  exécution** (la base, puis les pièces) : elle annonçait **« cadence mesurée : 0 h »** sur la
  sauvegarde la mieux tenue de la machine. *Fabriquer, dans le correctif écrit contre les nombres
  qui ne mesurent pas ce qu'ils nomment, un nombre qui ne mesure pas ce qu'il nomme.* Corrigé en
  comparant la **salve** précédente (> 1 h d'écart). **Le banc sur les six dossiers réels l'a
  montré ; essayer le bloc sur le seul cas qui m'intéressait ne l'aurait pas montré** (VPS-M35).
- **`aNePasFaire`** : ⚠️ **ne pas chercher le producteur par `grep` du chemin dans les scripts.**
  Ça marche sur les quatre unités existantes, et ça déclarerait « aucun mécanisme » sur n'importe
  quel script calculant sa destination (`DEST=/var/backups/$APP`). **Un contrôle de sauvegarde qui
  crie au loup se fait désactiver en trois jours** (VPS-M13). L'écart entre deux salves est un
  **fait**, pas une inférence.
- **Coût** : **zéro commande supplémentaire** — le `find` était déjà lancé pour l'âge ; on garde
  tous ses horodatages au lieu de n'en retenir qu'un.
- **Famille** : VPS-004, VPS-M06, VPS-M13, VPS-M15 — troisième occurrence de *« on vérifiait la
  TRACE et jamais l'EFFET »*, cette fois **à l'intérieur d'une section qui contient déjà les deux
  moitiés sans les rapprocher**.

---

### VPS-M80 — Une base de production n'a jamais été énumérée, et le dénominateur la cachait

- **Domaine** : méthode · **Gravité** : 2 · **Statut** : ✅ `APPLIQUE` (corrigé le 2026-09-05)
- **Vu** : 2026-09-05 · **Mesure** :

  ```
  filtre par NOM seul  (avant) : 7 conteneurs de base
  filtre nom OU IMAGE  (apres) : 8
  rattrapee par l image seule  : vizyo-auth-db (postgres:17-alpine, PostgreSQL 17.9)
  ```

  `vizyo-auth-db` porte la base `vizyo_auth` — **l'authentification de toutes les applications de
  la machine**.
- **QUOI — la cause** : le filtre d'énumération était
  `docker ps --format '{{.Names}}' | grep -Ei "postgres|postgis|mysql|maria|mongo"`. Il porte sur
  le **nom du conteneur**. Un conteneur nommé `-db` n'y entre pas — **depuis le premier passage de
  cet audit.**
- **Ce que ça cachait, aux trois endroits où le filtre servait** :

  | section | affiché | manquant |
  |---|---|---|
  | 5 — Données PostgreSQL | 6 bases détaillées | taille, cache, connexions, tables, rétention de `vizyo_auth` |
  | 12 — Levier 4 | **« ✅ 6 / 6 bases PostgreSQL examinées »** | le **dénominateur** vient du filtre défaillant : vert **sur son propre angle mort** |
  | 11 — Couverture des sauvegardes | 7 lignes | `vizyo-auth-db` absent — et une base sans sauvegarde y apparaît **par son absence** |

- **`pourquoiInvisible`** : **parce que le seul symptôme était une absence, et qu'aucune ligne ne
  l'annonçait.** La section 5 affichait six bases saines ; rien ne disait combien il aurait dû y en
  avoir. *« 6 / 6 » n'est pas une mesure de couverture, c'est une tautologie : numérateur et
  dénominateur viennent du même filtre.* Et l'ironie est mesurable : `vizyo-auth-db` a reçu une
  sauvegarde le 2026-09-04, **sans que cet audit l'ait jamais demandée** — s'il n'en avait pas reçu,
  l'audit ne l'aurait **jamais** dit.
- **QUOI FAIRE** : filtre sur le **nom OU l'image**, et **publier ce que le nom seul aurait raté**
  (un rattrapage silencieux serait un correctif dont on ne pourrait plus mesurer la valeur).
- **⚠️ DEUXIÈME CORRECTION, DISTINCTE DE LA PREMIÈRE** : reconnaître un objet et savoir le
  **rapprocher** sont deux choses. Une fois détecté, `vizyo-auth-db` ne correspondait à aucun
  dossier de `/var/backups` (`vizyo-auth-db` ⊄ `vizyo-auth`) et serait entré dans la table pour y
  être déclaré **« AUCUNE SAUVEGARDE » à tort** — un faux positif sur la base d'authentification,
  c'est-à-dire exactement le genre d'alerte qui fait désactiver un contrôle. Le suffixe
  `-db`/`-database` est retiré de la clé de rapprochement.
- **Contre-épreuve, jouée sur la machine** : 7 → 8 conteneurs ; les **8** clés dérivées correctes
  (`capcom6-mysql`→`capcom6`, `vizyo-auth-db`→`vizyo-auth`, …) ; un motif introuvable
  (`cockroach|firebird`) rend du vide sans faux positif.
- **Coût** : **zéro commande supplémentaire** — le même `docker ps`, avec un champ de plus dans le
  gabarit.
- **`aNePasFaire`** : ⚠️ **ne pas conclure que `vizyo-auth-db` est mesuré pour autant.** Le
  collecteur corrigé n'a **pas** été rejoué ce passage (133 s de production pour revalider un bloc
  serait un mauvais échange) : ses tables et son `random_page_cost` ne seront lus qu'au passage
  suivant. *Un correctif écrit n'est pas une mesure faite.*
- **Famille** : **VPS-M34 mot pour mot** — « le levier PostgreSQL n'examinait que la moitié des
  bases » — et la règle qui l'interdit (VPS-M08 / VPS-M22 : *« toute extraction conditionnelle doit
  annoncer son dénominateur »*) était écrite **dans le commentaire de ce bloc même**.

---

### VPS-M79 — Une disparition attribuée au seul mécanisme visible, alors qu'un ménage quotidien la produit et jette sa trace

- **Domaine** : méthode · **Gravité** : 2 · **Statut** : 🟠 `A_TRAITER` (la remédiation modifie le VPS)
- **Vu** : 2026-09-04 · **Mesure** : après le redéploiement de `tracky-api` le 2026-09-04 à
  **01 h 14 min 35**, il ne reste **AUCUNE** étiquette `avant-*` sur la machine. Le cron
  `/etc/cron.d/docker-image-prune` a tourné à **00 h 40 min 01** le même jour — **34 minutes
  avant** — et fait `docker image prune -af --filter "until=24h" > /dev/null 2>&1`.

**QUAND.** Le rapport du **2026-09-03** avait constaté la disparition des étiquettes
`avant-trk056/057/058` et écrit : *« Le déploiement de TRK-059, le 09-02 à 21 h 04, a retiré les
trois précédentes. **Il existe donc bien un mécanisme de rotation**, et la projection “dix en
coûteront” ne tient pas. »* Il avait accompagné cette conclusion d'un **test écrit d'avance**,
échu au passage du 2026-09-04.

**QUOI — la cause.** Le test est tranché, et il réfute l'attribution qui l'accompagnait.

| candidat capable de retirer l'étiquette | actif ? | trace exploitable ? |
|---|---|---|
| le déploiement de `tracky-api` (01 h 14) | oui | l'état **après**, seulement |
| `docker image prune -af --filter until=24h` (00 h 40, **quotidien**) | oui | **aucune — `> /dev/null 2>&1`** |

`-a` retire les images **sans conteneur, étiquetées comprises**. Une étiquette de repli est par
construction une image étiquetée et non utilisée : elle est donc éliminée **dès qu'elle passe
24 heures**. Le ménage est donc une cause **suffisante à lui seul**, et il tourne tous les jours.

**`docker events --since 48h --filter type=image` rend du vide** : le tampon d'événements du
démon ne remonte pas si loin. Vérifié — **mesure NON FAITE**, et non « aucun événement ».

> **Le défaut n'est pas dans la mesure, il est dans le raisonnement.** L'audit a observé une
> disparition, l'a attribuée au seul mécanisme qu'il **voyait**, puis en a tiré une **règle**
> (« il existe donc bien un mécanisme de rotation ») et fermé un point de son plan d'action. Le
> mécanisme qui l'explique au moins aussi bien était **dans son propre catalogue
> d'ordonnancement**, à la bonne heure et à la bonne cadence — mais il jette sa sortie, donc son
> effet est indémontrable **dans les deux sens** : on ne peut ni le lui imputer, ni l'en disculper.

**`pourquoiInvisible`.** Le catalogue `ordonnancement` déclare **quand** une tâche se déclenche,
jamais **ce qu'elle a fait**. Une entrée présente, exacte et complète peut donc rester
inutilisable pour expliquer un fait — et son exactitude même donne l'impression contraire.
*C'est la famille de VPS-M01 (une concomitance d'horaire n'est pas une identification) et de
VPS-M55 (une attribution écrite une fois est ensuite republiée sans être réexaminée).*

**QUOI FAIRE.** Deux gestes distincts, et le second n'est pas gratuit.

1. **Au manifeste** — ajouter à chaque entrée de `ordonnancement` un champ `trace` :
   *journalisée / silencieuse / autodétruite*, et **refuser d'attribuer un fait à une entrée
   `silencieuse` sans une seconde source**. Coût : une ligne par entrée. Fait au passage du
   2026-09-04 pour `docker-image-prune`.
2. **Sur le VPS, à décider** — exempter du ménage **une seule** image de repli par service :

```bash
docker image prune -af --filter "until=24h" --filter "label!=repli=1"   # exige d'ETIQUETER les images de repli au build
```

**`aNePasFaire`.** ⚠️ **Ne pas exempter sans borne.** Toute image soustraite au ménage revient
dans le poste « Images » — **25,33 Go annoncés le 2026-09-04** — et ce ménage de 00 h 40 est
précisément ce qui le tient. Une exemption non bornée rejoue **VPS-001** (le cache de build que
rien ne purgeait). ⚠️ **Et ne pas remplacer une attribution non prouvée par une autre** : la
rédaction du 2026-09-04 a d'abord imputé la disparition au ménage avec la même assurance que la
veille l'imputait au déploiement. La seule phrase que la mesure autorise est *« deux candidats,
indépartageables »*.

**Conséquence opérationnelle, à ne pas perdre.** Quel que soit le coupable, **il n'existe
aujourd'hui aucune image de repli locale pour `tracky-api`.** Ce n'est pas grave — l'image se
reconstruit depuis git — mais un repli qui prend un build n'est pas un repli en trois minutes.
Et la conséquence est **l'inverse** de celle qu'annonçait le rapport du 09-03 : les étiquettes de
repli ne s'accumulent pas, **elles ne survivent pas à une nuit**.

---

### VPS-M78 — Le remède de VPS-M76 portait le défaut symétrique : un total sans fenêtre monte pour des raisons qui ne sont pas la panne

- **Domaine** : méthode · **Gravité** : 2 · **Statut** : ✅ `APPLIQUE` (2026-09-04)
- **Vu** : 2026-09-04 · **Mesure** : le registre `trackers` passe de **12 à 14 silencieux sur
  44**, et **aucun boîtier de la cohorte de VPS-038 n'a été ajouté**. Les deux « nouveaux » sont
  dans **d'autres flottes**, muets depuis **7 h 30** et **24 h 30**.

**QUAND.** Écrit **un jour** après VPS-M76, qui l'a produit. VPS-M76 corrigeait un compteur qui
**décroissait** quand la panne durait, parce que sa source (`wire_logs`) a une rétention de
3,97 jours. Son remède — publier à côté le compte d'une **table de registre sans rétention** —
est bon, et il a introduit le défaut **symétrique** dès le passage suivant.

**QUOI — la cause.** Une source **sans fenêtre n'oublie rien, donc elle accumule tout.** Les 14
silencieux du 2026-09-04, ventilés à la main :

```
h_silence  flotte                                  ce que c'est
     7.5   7cc3c2f7…  (1 sur 7)                    ← un vehicule GARE POUR LA NUIT
    24.5   88627f81…  (2 sur 4)
  84.6 · 84.6 · 85.2 · 85.6 · 85.9 · 86.5
           2ad69ac1…                                ← LA COHORTE DE VPS-038, inchangee
   125.2   (sans vehicule)
   325.7 · 374.9   2ad69ac1…                        ← ANTERIEURS a l'incident (08-19, 08-21)
   504.3   88627f81…
  1554.2 · 2174.7  (sans vehicule)                  ← muets depuis 65 et 91 JOURS
```

**Quatre populations sans rapport dans un seul nombre** : un incident de 6 boîtiers, 2 boîtiers de
la même flotte muets **avant** lui, 3 boîtiers **sans véhicule** muets depuis 5 à 91 jours, et
2 véhicules d'autres flottes dont l'un est simplement à l'arrêt un matin.

> **Un compteur qui ment dans le sens alarmant n'est pas meilleur qu'un compteur qui ment dans le
> sens rassurant.** Il fabrique une aggravation ; une aggravation fabriquée fait ouvrir un
> incident là où il n'y en a pas, mobiliser un exploitant sur un véhicule garé — et, le jour où
> une vraie extension arrivera, elle se noiera dans une série qui montait déjà.

**`pourquoiInvisible`.** Parce que le remède de la veille **était le bon** : la source sans
fenêtre est effectivement la seule dont la série se compare. L'erreur n'était pas de la choisir,
c'était de croire qu'en supprimant la fenêtre on rendait la mesure **vraie**. *Supprimer une
fenêtre ne rend pas une mesure vraie : ça change le sens dans lequel elle se trompe.*

**QUOI FAIRE — fait ce passage.** Le registre publie la **ventilation par durée de silence** —
`6-24 h` / `1-3 j` / `3-7 j` / `> 7 j` — à côté du total, avec l'interdiction écrite de comparer
les totaux d'un passage à l'autre. La durée est le seul discriminant que la table porte.

**Contre-épreuves, les deux exigées avant publication :**

1. **La partition est exacte** : `1 + 1 + 7 + 5 = 14`, recalculé par une requête **séparée** du
   total silencieux. Une bande qui recouvrirait ou oublierait une borne se verrait ici.
2. **Les trois branches sont exercées** — nominale (7 champs), **dégénérée** (3 champs), absente.
   ⚠️ **La dégénérée est celle qui comptait** : le code de la veille testait `split(...) == 3` ;
   passer la requête à 7 champs **sans** toucher au test aurait fait retomber la sortie sur
   *« AUCUN REGISTRE trouvé »* — c'est-à-dire qu'une correction aurait **éteint** le recoupement
   introduit la veille, avec une phrase rassurante pour le dire. Le bloc distingue désormais
   *« registre trouvé mais ventilation ILLISIBLE — mesure NON FAITE »* de *« aucun registre »*
   (**VPS-M02**).

**COÛT : ZÉRO requête supplémentaire, +0,00 s.** Quatre `FILTER` de plus sur le **même** parcours
des 44 lignes, déjà borné par `reltuples < 10000`. Chronométré 3 fois : **0,08 / 0,09 / 0,09 s**,
contre 0,08 / 0,08 / 0,10 s mesurés le 2026-09-03 pour la version à deux agrégats — l'écart est
sous la résolution de la mesure.

**`aNePasFaire`.** ⚠️ **Ne pas revenir au compteur borné par `wire_logs`** : il a le défaut
inverse, et il est pire (VPS-M76). ⚠️ **Ne pas « corriger » le total en excluant les boîtiers sans
véhicule** : ce serait choisir la population qui arrange, et rendre invisible le vrai constat que
la ventilation a révélé — **5 boîtiers muets depuis plus de 7 jours, jusqu'à 91**, dont 3 sans
véhicule, qui gonflent le total à chaque passage pour toujours.

---

### VPS-M77 — L'audit comptait des IP et jamais des empreintes, et une troisième clé root est passée dix-neuf jours sans être nommée

- **Domaine** : méthode · **Gravité** : 2 · **Statut** : ✅ `APPLIQUE` (2026-09-03)
- **Vu** : 2026-09-03 · **Mesure** : `authorized_keys` porte **trois** clés actives, dont
  `github-actions-vizyo-auth` (`SHA256:OTSnEmsW…`) **sans aucune option de restriction**, active
  depuis le **2026-08-23**. Voir **VPS-012**, rouvert le même jour.

**QUOI — la cause.** Le bloc de sécurité publie depuis le premier passage :

```
IP dont des connexions ont REUSSI (a reconnaitre : ce sont vos acces) :
     6251 82.67.153.51
       20 37.167.61.43
```

**Des adresses. Jamais une empreinte.** Or c'est l'empreinte qui identifie une clé : les douze
adresses Azure de la clé neuve sont indiscernables des adresses Azure de l'autre clé de CI, et le
`head -5` les écrase de toute façon. Le libellé du bloc dit d'ailleurs exactement ce qu'il fait —
*« à reconnaître : ce sont vos accès »* — c'est une **aide à la lecture**, jamais un contrôle.

**`pourquoiInvisible`.** C'est la famille de **VPS-032** (*« le collecteur lisait déjà ces lignes
et n'en comptait que les échecs »*) et de **VPS-M45** (*« la donnée était sous les yeux, la
question ne lui avait pas été posée »*) — avec une aggravation : ici la question **avait** été
posée, dans VPS-012, et sa réponse avait été jugée assez solide pour **fermer** le constat. La
vérification a ensuite été refaite à la main jusqu'au 08-20, puis plus du tout, et l'objet a changé
trois jours après.

> **La leçon, et elle dépasse les clés SSH.** *Une vérification faite à la main ne se distingue pas,
> dans un rapport, d'une vérification faite par le collecteur — les deux produisent la même phrase.*
> La première s'arrête le jour où personne ne la refait, et rien ne le signale. C'est ce qui a
> permis à VPS-007, VPS-022 et maintenant VPS-012 de vivre fermés sur une affirmation qui n'était
> plus mesurée.

**QUOI FAIRE — appliqué le 2026-09-03.** Inventaire croisé **déclarées / vues** : pour chaque clé
active, son empreinte, son commentaire, ses options de restriction et son nombre de connexions sur
la fenêtre ; puis toute empreinte **vue dans `auth.log` sans être déclarée** en 🔴.

**Contre-épreuve sur trois branches, exécutée sur la machine :**

| cas | attendu | obtenu |
|---|---|---|
| réel | 3 clés, dont 2 sans restriction | **3 déclarées, 2 en 🟠, 0 empreinte non déclarée** |
| `authorized_keys` illisible | refus de conclure | *« inventaire NON FAIT, ce n'est pas “aucune clé” »* |
| témoin amputé de la clé **qui a servi** | 🔴 | **🔴 EMPREINTE NON DÉCLARÉE : SHA256:cdd9XFoV…** |

⚠️ **Le premier cas dégénéré que j'avais écrit ne testait pas ce que je croyais** : j'avais retiré
du témoin la clé `vizyo-auth`, qui a **zéro** connexion dans la fenêtre de 7 jours — le détecteur
ne pouvait donc pas crier, et son silence ne prouvait rien. Refait en retirant la clé aux 6 310
connexions. *Un cas dégénéré qui passe pour la mauvaise raison est pire qu'un cas dégénéré absent :
il fabrique une confiance.*

**COÛT : un `ssh-keygen -lf` et des `grep` sur des lignes déjà en mémoire. Aucune E/S disque,
aucun fork Docker.**

**`aNePasFaire`** : ⚠️ **ne pas faire de ce bloc un juge de légitimité** — il ne peut pas l'être.
Une clé inconnue peut être un provisionnement légitime non documenté, et une clé déclarée peut être
de trop. Il rend deux inventaires et signale les écarts ; nommer un coupable serait VPS-M01.
⚠️ **Ne pas lire `connexions=0` comme « clé inutilisée »** : `auth.log` ne garde que 7 jours. Les
**deux** clés de CI affichent 0 ce passage, et l'une a servi 15 fois les 23 et 24 août.
⚠️ **Ne pas lire « 0 empreinte non déclarée » comme « aucun accès inconnu »** : le canal `guest-exec`
de l'hyperviseur (VPS-027 / VPS-036) exécute du root **sans passer par SSH** et ne laisse aucune
ligne ici. La portée est écrite dans la sortie elle-même.

---

### VPS-M76 — Le compteur de boîtiers muets DÉCROÎT à mesure que la panne dure, et sa série se lit comme un rétablissement

- **Domaine** : méthode · **Gravité** : 2 · **Statut** : ✅ `APPLIQUE` (2026-09-03)
- **Vu** : 2026-09-03 · **Mesure** :

  | | 2026-09-02 | 2026-09-03 |
  |---|---:|---:|
  | `wire_logs` — muets > 6 h | **7** | **6** |
  | `trackers` — silencieux / 44 (**aucune rétention**) | **12** | **12** |

  **Aucun boîtier n'est revenu.** Le septième (`864035054755856`, muet depuis le 2026-08-29 à
  21 h 15) a **0 ligne** dans `wire_logs`, dont la borne basse est passée au **2026-08-30 à
  03 h 00** : il est **sorti de la fenêtre**.

**QUOI — la cause, et elle est pire qu'un plancher.** L'agrégat de fraîcheur posé la veille
(VPS-M75) portait la mention *« c'est un PLANCHER : il ne voit que les émetteurs encore présents
dans la fenêtre de rétention »*. **Cette mention était juste, et insuffisante.**

Un plancher suggère une borne prudente, qu'on peut lire dans le bon sens. Celui-ci ne l'est pas :

> **Plus un boîtier se tait longtemps, plus il est CERTAIN de disparaître du compte.** Le compteur
> est **anti-corrélé** à la gravité qu'il mesure. Sa série — 7, puis 6, puis 5 — se lit exactement
> comme une flotte qui se rétablit **pendant qu'elle s'éteint**.

*C'est la famille de VPS-M31 : un garde-fou qui se dégrade dans le sens rassurant est plus
dangereux qu'un garde-fou absent.* Et un avertissement de plus n'y pouvait rien — il en portait
déjà un, écrit la veille, par moi, et je l'ai relu **après** avoir écrit la phrase qu'il devait
empêcher.

**Les quatre instruments s'ordonnent par la longueur de leur fenêtre**, mesuré ce passage sur la
même question :

| instrument | fenêtre | muets > 6 h |
|---|---:|---:|
| `wire_logs` | 3,97 j | **6** |
| `position_sampling_decisions` | 3,95 j | **6** |
| `positions` | **62 j** | **10** |
| **`trackers`** (registre) | **aucune** | **12** |

**Quatre réponses, rangées exactement par la taille de la fenêtre.** Ce n'est pas une contradiction
entre les tables : c'est la démonstration que le nombre publié dépendait de **l'instrument**, pas
de la flotte.

**QUOI FAIRE — appliqué le 2026-09-03.** Le collecteur cherche, dans la même base, une table de
**registre** — petite (`reltuples < 10000`, ce qui interdit de parcourir un journal), portant la
même colonne d'émetteur **et** un horodatage de dernière vue — et publie son compte à côté, avec
l'écart en toutes lettres et la consigne : *c'est CE chiffre-ci, et lui seul, qui se compare d'un
jour à l'autre.*

**Contre-épreuve sur les deux branches** : `wire_logs` → `trackers (lastSeenAt)` → **12|44** ;
`positions` → *« AUCUN REGISTRE trouvé »*, qui **le dit** au lieu de retomber en silence sur le
plancher (VPS-M02).

**COÛT : 0,08 s MESURÉ** (3 mesures : 0,10 / 0,08 / 0,08 s) — la table fait 44 lignes.

**`aNePasFaire`** : ⚠️ **ne pas supprimer l'agrégat de `wire_logs` au motif que le registre est
meilleur.** Ils ne disent pas la même chose : le journal date l'arrêt **à la minute** (c'est lui
qui a donné 08-31 13 h 50), le registre donne le **total**. ⚠️ **Ne pas relever le seuil de 6 h
pour « lisser » la série** — ce serait le motif exact de VPS-M31. ⚠️ **Et ne pas conclure qu'un
registre est toujours meilleur** : il n'a pas de fenêtre, donc il ne peut pas dire *quand*, et un
enregistrement supprimé de l'application en sort sans laisser de trace.

---

### VPS-M75 — Une comparaison de fenêtres de 24 h publiée comme un état courant, et six boîtiers morts sous une ligne verte

- **Domaine** : méthode · **Gravité** : 2 · **Statut** : `APPLIQUE` (2026-09-02)
- **Vu** : 2026-09-02 · **Mesure** : le rapport du **2026-09-01 à 07 h 39** publie *« la flotte est
  intacte : 38 émetteurs distincts sur 24 h contre 38 les 24 h précédentes, 15ᵉ jour sans perte »*.
  **Six boîtiers étaient muets depuis dix-huit heures** (dernières trames le 08-31 entre 11 h 53
  et 13 h 50). Voir **VPS-038**.

**QUOI — la cause, et ce n'est pas une erreur de calcul.** Le compteur est **juste**. À 07 h 39 le
09-01, sa fenêtre de 24 h remontait au 08-31 07 h 39 et contenait encore les dernières trames des
six. **Une comparaison « 24 h contre 24 h » ne peut structurellement pas voir un arrêt de moins de
24 heures**, et selon l'heure de la collecte elle peut le cacher **jusqu'à un jour entier**.

Le défaut est que la sortie **ne dit pas qu'elle décrit une fenêtre**. *« ✅ flotte STABLE (38
contre 38) »* se lit comme un état présent, et c'est ainsi que le rapport l'a repris.

**Sa parenté.** C'est la **troisième période** de la même famille :

| | ce qui manque | ce que ça produit |
|---|---|---|
| **VPS-M69** | le cycle **diurne** est plus long que la lecture | un débit lu à une heure, publié comme un régime |
| **VPS-M71** | le cycle **hebdomadaire** est plus long que la fenêtre | un lundi comparé à un dimanche, ×1,50 sur une chaîne saine |
| **VPS-M75** | l'événement est plus **court** que la fenêtre | un état périmé de 18 h publié comme courant |

*Les deux premiers fabriquent une variation qui n'existe pas ; celui-ci cache une variation qui
existe. Le remède n'est pas le même : là il fallait une seconde fenêtre, ici il faut une grandeur
**sans fenêtre**.*

**QUOI FAIRE — appliqué le 2026-09-02.** Le collecteur mesure désormais, dans la **même requête**,
le nombre d'émetteurs dont la **dernière trame** date de plus de 6 h, et l'horodatage du dernier
arrêt. Cette grandeur n'a **aucune latence** : un arrêt y apparaît dès la 7ᵉ heure.

**Contre-épreuve sur les 3 tables réelles**, rejouée sur la machine :

- `wire_logs` → **🔴 7 émetteurs muets, dernier arrêt 08-31 13:50** — soit **un de plus** que ce
  que la comparaison de fenêtres a trouvé ;
- `positions` et `position_sampling_decisions` → branche *« colonne d'émetteur non reconnue,
  mesure NON FAITE »*, sans rien inventer (VPS-M02).

**🔑 Le septième est la preuve que ce correctif n'est pas une redondance.** `864035054755856` s'est
tu le **2026-08-29 à 21 h 15**, donc **hors des deux fenêtres de 24 h** : la comparaison ne pouvait
pas le voir, et ne le verrait jamais, quel que soit le jour. *Le correctif attrape une classe de
cas que la mesure existante exclut par construction.*

**COÛT : +55 ms, MESURÉ** sur 5 paires appariées, la première jetée (cache froid) : 0,16/0,18/0,17/0,17 s
sans, 0,23/0,23/0,22/0,23 s avec. `wire_logs` étant la seule table portant une colonne d'émetteur,
c'est **+55 ms sur toute la collecte**.

**`aNePasFaire`** : ⚠️ **ne pas remplacer la comparaison de fenêtres par cette mesure.** Elles ne
disent pas la même chose : l'une donne une **tendance** (la flotte grandit-elle ?), l'autre un
**état** (qui est muet maintenant ?). Supprimer la première pour « simplifier » perdrait la
détection d'une flotte qui rétrécit lentement, sans arrêt franc.
⚠️ **Ne jamais lire un « 0 muet » comme « aucun boîtier perdu ».** L'agrégat ne voit que les
émetteurs encore présents dans la fenêtre de rétention (**3,98 j** sur `wire_logs`) : un boîtier
muet depuis six jours en a disparu et n'est **pas compté**. **C'est un plancher, jamais un total**
— six des douze traceurs silencieux du 2026-09-02 étaient dans ce cas. La portée est écrite dans
la sortie elle-même, pour qu'on ne la redécouvre pas.

---

### VPS-M74 — Un compte d'en-attente valide, publié sans sa position dans le cycle qui le vide

- **Domaine** : méthode · **Gravité** : 2 · **Statut** : `APPLIQUE` (2026-09-02)
- **Vu** : 2026-09-02 · **Mesure** : la section sécurité rend une mesure que le garde VPS-M29
  **accepte** — cache apt de **1 h**, seconde source (`update-notifier`) de **1 h**, les deux
  d'accord : **109 paquets en retard, dont 34 estampillés sécurité**, contre 79/10 le 08-26. Et
  `dpkg.log` ne montre **aucune** installation depuis le **08-28**.

**Le constat était écrit** : *« le canal automatique de correctifs a cessé d'installer depuis cinq
jours, et 34 correctifs de sécurité se sont accumulés »*. **Gravité 2, sur une machine qui porte
sept bases de production. Il était faux.**

**LES TROIS MESURES QUI L'ONT RÉFUTÉ.**

**1. La date des index eux-mêmes** — les fichiers `Packages` portent la date de publication du
miroir :

```
noble-security_universe  2026-09-01 16:22      noble-updates_universe  2026-09-01 17:48
noble-security_main      2026-09-01 17:10      noble-updates_main      2026-09-01 18:26
```

Le lot **a douze heures**, pas cinq jours.

**2. La position de la collecte dans le cycle :**

```
dernier RAFRAICHISSEMENT (apt-daily)        : 2026-09-02 00:48:53
    ↓  1 h 34
CETTE COLLECTE                              : 2026-09-02 02:22:18
    ↓  4 h 30
prochaine INSTALLATION (apt-daily-upgrade)  : 2026-09-02 06:52:59
```

**La collecte est tombée dans le seul créneau où le compte est à la fois exact et trompeur :
après la découverte, avant l'installation.**

**3. Le journal de l'installateur, qui n'a jamais échoué.** `apt-daily-upgrade.service` a tourné
**tous les jours** du 08-27 au 09-01, terminé par `Deactivated successfully` à chaque fois, et le
09-01 à 06 h 39 `unattended-upgrades` conclut *« No packages found that can be upgraded
unattended »* — **correct ce jour-là**. Le **temps CPU** le confirme sans ambiguïté : **18,4 s le
08-27** et **31,6 s le 08-28** (jours où il a installé 4 puis 9 paquets) contre **3,1 à 4,2 s** les
jours vides. `apt-mark showhold` ne retient que `cloud-init` ; **zéro** paquet différé pour
*phasing*.

**QUOI — la cause.** Le garde VPS-M29 pose **une seule** question — *« ce chiffre est-il
frais ? »* — et il la pose bien. Mais un compte d'**en-attente** en exige une **seconde** :
*« où est cette mesure dans le cycle qui vide la file ? »* Sans elle, un compte frais et exact
conduit à la conclusion **inverse** de la réalité.

> **La leçon dépasse `apt`.** Ce collecteur publie plusieurs compteurs de file d'attente —
> paquets en retard, doublons de sauvegarde, volumes orphelins, certificats orphelins — et
> **aucun ne déclarait quand son videur passe**. C'est la même famille que la question ouverte du
> 2026-09-01 (une comparaison qui ne déclare pas la période du phénomène) : **une mesure sans son
> cadre temporel n'est pas une mesure, c'est un nombre.**

**QUOI FAIRE — appliqué le 2026-09-02.** Sous tout compte valide, le collecteur publie désormais la
**dernière** et la **prochaine** installation, et **tranche** entre « retard » et « file en
attente ». **Contre-éprouvé sur deux branches, sur la machine** : le cas réel (*« 🟠 CE COMPTE
N'EST PAS (ENCORE) UN RETARD : le cache a été rafraîchi 18 h APRÈS le dernier passage de
l'installateur »*) et le cas dégénéré, horodatage illisible (*« la position de cette mesure dans
le cycle n'est PAS établie. Ne pas trancher »*) — il **avoue** au lieu de rassurer, discipline
VPS-M28. **COÛT : deux `systemctl show`, aucune E/S disque.**

**🧪 Test écrit d'avance pour le passage suivant** : `/var/log/apt/history.log` doit porter une
entrée `Commandline: /usr/bin/unattended-upgrade` datée du **2026-09-02 vers 06 h 53**, et le
compte doit être **nettement tombé sous 109**. **Si l'installation a eu lieu et que le compte n'a
pas baissé, le canal est bien en panne** et le constat monte en gravité 2 — c'est ce test-là qui
tranche, jamais le compte seul.

**`aNePasFaire`** : ⚠️ **ne pas élargir le seuil de fraîcheur de 6 h pour « avoir plus de
mesures ».** Le problème de ce passage n'est pas que la mesure manquait, c'est qu'**elle était
là et mal cadrée**. Élargir le seuil ajouterait des mesures moins fiables au même défaut de
lecture — et c'est exactement ce que VPS-M31 punit.
⚠️ **Ne pas lancer `apt update` depuis le collecteur** pour « se placer au bon moment » : c'est une
**écriture** et un accès réseau sortant dans un audit déclaré en lecture seule.

---

### VPS-M73 — Cinq passages manqués, et une conséquence que le raisonnement écrit n'avait pas prévue

- **Domaine** : méthode · **Gravité** : 3 · **Statut** : `A_TRAITER`
- **Vu** : 2026-09-01 · **Mesure** : dernier rapport le **2026-08-26**. Les **27, 28, 29, 30 et
  31 août** n'ont **aucun passage**. Conséquence mesurée le même matin : **copie hors-site à 51 h,
  périmée** (VPS-037).
- **QUOI — la cause** : la procédure prévoit ce cas et le déclare acceptable — *« si le poste est
  éteint, l'audit ne tourne pas ; un jour manqué se voit dans le journal des passages, alors qu'un
  doublon silencieux ne se voit nulle part »*. **Ce raisonnement reste juste**, et le choix de
  planifier côté poste plutôt que sur le VPS reste le bon (c'est lui qui garantit l'absence du
  doublon VPS-003). **Mais il n'envisageait qu'une seule conséquence : l'absence de mesure.** Il y
  en a une seconde, et c'est une **sauvegarde**.
- **`pourquoiInvisible`** : rien dans le dispositif ne signale une **absence**. Le journal des
  passages liste ce qui a eu lieu ; un trou de cinq jours n'y produit aucun signal, seulement une
  ligne manquante que personne ne compte. *Un mécanisme qui rend une absence visible « par
  déduction » ne la rend pas visible.*
- **QUOI FAIRE** : afficher, à l'écran `/admin` → Audit VPS, **l'écart en jours depuis le dernier
  passage**, et le marquer au-delà de 2 jours. La donnée est déjà là — c'est la date du premier
  élément de `passages`.
- **`aNePasFaire`** : ⚠️ **ne pas déplacer la planification sur le VPS** pour « garantir » les
  passages. Ce serait rejouer **VPS-003** : deux planificateurs pour la même tâche, et un doublon
  silencieux coûte plus cher qu'un jour manqué visible.

### VPS-M72 — Une charge utile en base64 est illisible à la troncature, et l'audit a publié « 1 commande INATTENDUE » sans pouvoir dire qu'elle TUAIT

- **Domaine** : méthode · **Gravité** : 2 · **Statut** : ✅ `APPLIQUE` (2026-09-01)
- **Vu** : 2026-09-01 · **Mesure** : le **2026-08-28**, le bloc des ordres de l'hyperviseur a
  publié `🟠 1 commande(s) INATTENDUE(S)` suivie de la ligne tronquée à **165 caractères** :

  ```
  2026-08-28 13:48:37  "/bin/sh -c echo c25hcD0kKHBzIC1lbyBwaWQsZXRpbWVzLGNvbW0sYXJncyAtLW5vLWhlYWRlcnMgMj4vZGV2L251bGwgfCBncmVwIC12ICc8ZGVmdW5jdD4nKQpyMT0kKHBy
  ```

  Décodés le 2026-09-01 : **1 420 caractères** qui envoient `kill -TERM` puis `kill -KILL` en root
  (**VPS-036**).

- **QUOI — la cause** : **le compteur avait raison, c'est l'affichage qui était aveugle.** Une
  charge utile encodée est le seul cas où une troncature ne coupe pas « la fin d'une phrase » :
  elle coupe **la phrase entière**. Ce que l'audit publiait de cette commande était exactement la
  partie dépourvue d'information — l'invocation `/bin/sh -c echo <blob>`.

- **`pourquoiInvisible`** : la famille **VPS-M22 / VPS-M46** — un extracteur qui rend du vide en
  silence — avec une variante plus retorse : **le texte était PRÉSENT**. Il y avait 165 caractères
  à l'écran. Rien n'avait l'air cassé ; c'était simplement illisible, et « illisible » ne
  déclenche aucune alarme.

- **Correctif (posé et contre-éprouvé le 2026-09-01)** : détection d'un blob
  `[A-Za-z0-9+/]{40,}={0,2}`, décodage, publication bornée (**25 lignes × 200 caractères**) et
  **relevé des verbes d'écriture** (`kill -*`, `pkill`, `rm -rf`, `systemctl`, `chmod`, `chown`,
  `mkfs`, `dd if=`, `iptables`, `ufw`, `crontab`, `docker rm|stop|kill|prune`).

  **Contre-épreuve sur trois cas, exécutée sur la machine** :

  | cas | attendu | obtenu |
  |---|---|---|
  | le blob réel du 08-28 | décodé et signalé | **9 lignes rendues, `🔴 kill -KILL kill -TERM`** |
  | une commande **sans** base64 | rien du tout | **silence complet** (le `grep` ne rend rien, la boucle ne tourne pas) |
  | un blob **binaire** (90 o d'aléatoire) | refus de lire | **« decode en BINAIRE (non textuel) — contenu NON LU »** |

  **Coût : nul en l'absence de base64.**

- **`aNePasFaire`** : ⚠️ **ne pas lire l'absence de verbe comme une garantie de lecture seule.**
  Le relevé dit ce que le texte **contient**, pas ce qu'il **fait** ; un script peut écrire sans
  aucun de ces mots. La sortie est libellée « aucun verbe RELEVÉ », jamais « lecture seule » —
  discipline **VPS-M28** (réparer un silence en fausse rassurance est pire que le silence).

### VPS-M71 — Le rapport « 24 h contre les 24 h précédentes » compare un jour ouvré à un DIMANCHE une fois sur deux

- **Domaine** : méthode · **Gravité** : 2 · **Statut** : ✅ `APPLIQUE` (2026-09-01)
- **Vu** : 2026-09-01 · **Mesure** : le collecteur publiait

  ```
  positions   debit : 23183 arrivees sur 24 h  contre  15498 les 24 h precedentes  = x1.50
              ✅ debit stable (x1.50, dans la bande 0,67-1,50)
  ```

  **×1,50 est exactement le bord de la bande** — le seuil rouge est `r >= 1.5`. Un point de plus
  et l'audit ouvrait un constat 🔴 *« LE DÉBIT MONTE »* sur l'ingestion de Tracky, **un lundi
  matin parfaitement normal**.

- **QUOI — la cause** : profil journalier mesuré sur les dix journées conservées —

  | jour | `positions` | `wire_logs` | trame → position |
  |---|---:|---:|---:|
  | 08-28 Ven | 26 101 | — | — |
  | 08-29 Sam | 23 797 | 101 571 | **23,4 %** |
  | **08-30 Dim** | **15 024** | 100 125 | **15,0 %** |
  | 08-31 Lun | 22 211 | 97 184 | **22,9 %** |

  La fenêtre « 24 h précédentes » était presque entièrement ce **dimanche** ; la fenêtre courante
  est un **lundi**. **Et `wire_logs` ne bouge quasiment pas** (−4 % le dimanche) : les boîtiers
  émettent que le véhicule roule ou non. **Les deux tables ne mesurent pas la même chose** —
  l'émission d'un côté, le mouvement de l'autre — d'où une divergence sans que rien ne soit cassé.

- **Sa parenté — c'est VPS-M69 à la période supérieure.** M69 : *une grandeur qui vient
  d'acquérir un cycle **diurne** ne se lit pas à une seule heure.* M71 dit la même chose du cycle
  **hebdomadaire** : une grandeur cyclique comparée sur une fenêtre plus courte que son cycle
  **fabrique une variation qui n'existe pas**. Même mode d'échec, et il frappe **dans le sens
  accusateur**, un lundi matin sur deux.

- **Correctif (posé et contre-éprouvé le 2026-09-01)** : une troisième fenêtre — les **24 h d'il y
  a une semaine** — entre dans la **même requête**, avec l'étiquette du jour de semaine des deux
  fenêtres et un verdict croisé quand les deux comparaisons se contredisent.

  ```
  positions   debit : 23226 sur 24 h  contre  15609 les 24 h precedentes  = x1.49
              meme jour de semaine (J-7) : 23684 arrivees = x0.98  [fenetre J = Mon, fenetre J-1 = Sun]
  ```

  **Coût : +90 ms par table, MESURÉ** sur trois paires appariées d'`EXPLAIN ANALYZE`
  (246/192/182 ms sans, 311/311/270 ms avec), soit **~+0,27 s** sur une passe de 138 s. *Le
  premier jet annonçait « coût nul » au motif que le parcours de table était déjà fait : juste sur
  les E/S, faux sur le processeur — l'erreur exacte déjà payée le 2026-08-26.*

- **⚠️ Le piège adjacent, attrapé AU MONTAGE et non en relisant le code** : `wire_logs` et
  `position_sampling_decisions` n'ont qu'une rétention de **3,2 jours**. J-7 y est **hors
  fenêtre**. Sans garde, elles auraient affiché **« 0 arrivée il y a 7 jours »** — un effondrement,
  sur les tables les plus surveillées de la machine. C'est **VPS-M02 à l'identique**, et dans le
  sens accusateur. Le bloc dit désormais *« Comparaison à même jour de semaine IMPOSSIBLE : mesure
  NON FAITE, PAS un débit nul »*.

- **`aNePasFaire`** : ⚠️ **ne pas élargir la bande 0,67-1,50 pour « éviter les faux positifs ».**
  Le défaut n'était pas le seuil, c'était la **référence**. Élargir la bande aurait aussi masqué
  les vraies excursions — dont le déluge de TRK-045, qui a culminé à ×2,92.

### VPS-M70 — Le filtre de la sonde horaire de l'hyperviseur était câblé sur un NOM de fichier, et l'hyperviseur l'a renommé

- **Domaine** : méthode · **Gravité** : 2 · **Statut** : ✅ `APPLIQUE` (2026-08-26)
- **Vu** : 2026-08-26 · **Mesure** : `scanner.py` **264 exécutions**, dernière le **2026-08-25 à
  07 h 18 min 01** ; `usage-telemetry.py` **38 exécutions**, première le **2026-08-25 à
  08 h 14 min 26**. Le collecteur a publié **🟠 19 commandes INATTENDUES** dont **les dix-neuf**
  étaient cette sonde renommée.

**Quoi.** Le bloc VPS-027 écarte la routine horaire de l'hyperviseur pour faire remonter les
commandes qui comptent — celles qui **écrivent**. Il l'écartait par un motif câblé sur le nom du
fichier :

```bash
grep -vE 'hstgr-[0-9]+\.scanner\.py|ps -eo vsz|/proc/meminfo'
```

L'hébergeur a remplacé son script le 2026-08-25 entre 07 h 18 et 08 h 14. Du jour au lendemain,
une sonde parfaitement routinière est tombée dans la catégorie « inattendue », **sur le seul canal
par lequel un tiers exécute du root dans cette machine**.

**Pourquoi c'était invisible — et c'est la partie qui instruit.** Ce filtre a été écrit le
2026-08-20, **précisément pour corriger ce genre de défaut** (VPS-M50) : il sépare « hors sonde »
de « hors routine » et publie deux dénominateurs côte à côte, pour qu'un lot connu ne soit jamais
confondu avec une anomalie. **Il était juste, et il l'est resté jusqu'à la seconde où l'objet
qu'il nommait a changé de nom.**

> *Un filtre qui identifie le bruit par son NOM est vrai jusqu'au jour où le bruit est renommé —
> et ce jour-là il ne se tait pas : il crie.* C'est la famille de **VPS-M55** (une attribution
> écrite en dur qui devient fausse sans que rien ne le signale), avec une différence qui la rend
> plus coûteuse : ici le défaut est **bruyant du côté alarmant**. Il ne rassure pas à tort, il
> **consomme l'attention** — et il la consomme sur le canal le plus sensible de la machine.

**Quoi faire — FAIT.** Le filtre porte désormais sur la **FORME** (`hstgr-<epoch>.<nom>.py`, le
script auto-détruit que l'hyperviseur dépose puis exécute), pas sur un nom.

**Contre-épreuve exécutée sur la machine, ancien et nouveau filtre sur le même journal :**

```
AVANT (filtre cable sur « scanner ») : hors sonde 43 | TRIM 24 | INATTENDUES 19
APRES (filtre par FORME)             : hors sonde 24 | TRIM 24 | INATTENDUES  0
```

⚠️ **Un filtre plus large est un risque, et il est compensé plutôt que tu.** Un script réellement
nouveau passant par le même chemin serait désormais écarté lui aussi. Le bloc publie donc **dans
tous les cas** l'**inventaire des noms de sonde** avec leur compte, et **signale tout changement
de nom** :

```
       264 scanner.py
        38 usage-telemetry.py
     🟠 2 noms de sonde DIFFERENTS dans la fenetre : l hyperviseur a renomme ou
        remplace son script pendant la periode observee.
```

C'est exactement la leçon de VPS-M50 sur le lot TRIM, appliquée à son propre correctif : *on
écarte le bruit sans perdre la capacité de voir qu'il a changé.*

**`pourquoiInvisible`** : le défaut ne pouvait pas se manifester tant que le nom tenait. Il n'a
pas été trouvé en relisant le code — il a été trouvé parce que l'objet a changé de nom et que
l'alarme a crié. *Un filtre par nom est un pari silencieux sur la stabilité d'un nom que l'on ne
contrôle pas.*

**`aNePasFaire`** : ⚠️ **ne pas se contenter d'ajouter `usage-telemetry` à la liste des noms** —
ce serait rejouer le même défaut au prochain renommage, et la liste grandirait sans jamais
protéger. ⚠️ **Ne pas masquer l'inventaire au motif qu'il est verbeux** : c'est lui qui rend le
filtre réfutable, et sans lui le filtre élargi devient un angle mort. ⚠️ **Ne pas conclure de ce
renommage que l'hébergeur fait quelque chose de nouveau** : le nom est tout ce qu'on en voit, le
script s'autodétruit, et lire son contenu demanderait une écriture.

---

### VPS-M69 — Un débit lu à UNE SEULE HEURE, publié comme un régime, sur une grandeur qui venait d'acquérir un cycle diurne

- **Domaine** : méthode · **Gravité** : 2 · **Statut** : ✅ `APPLIQUE` (2026-08-26)
- **Vu** : 2026-08-26 · **Mesure** : le rapport du 08-25 a publié *« 40 % sous son niveau d'avant,
  **et il baisse encore** »* sur un débit qui valait **104,4 une heure plus tard** puis **164,5 le
  même après-midi**. À heure comparable, il était **+15 %** au-dessus du jour précédent.

**Quoi.** Le rapport du 2026-08-25 a comparé **110,7 trames/h/boîtier**, relevé à 01 h, à une
valeur de référence de **184,0** — et en a tiré deux conclusions : une baisse de 40 %, et une
pente descendante qui menaçait de continuer. **Les deux termes de la comparaison étaient mal
appariés, et les deux conclusions sont fausses.**

| ce qui était comparé | ce que c'était réellement |
|---|---|
| 110,7 « le régime actuel » | le **creux nocturne** du nouveau régime, 38 min avant son minimum |
| 184,0 « le niveau d'avant » | une valeur de l'**ancien** régime, qui était **plat** jour et nuit |
| « la pente est monotone sur 17 h » | les 17 dernières heures d'une **descente nocturne** |

**Et le piège tient à un fait que personne ne pouvait deviner : la grandeur a changé de nature
pendant l'incident.** Avant, l'émission était plate (amplitude **×1,19** sur 24 h) ; après le
correctif de TRK-045, elle est modulée (**×1,58**). *Une moyenne journalière et une valeur
nocturne étaient interchangeables dans l'ancien régime ; elles ne le sont plus dans le nouveau —
et c'est exactement au moment de la bascule qu'on les a comparées.*

**Pourquoi c'était invisible.** Parce que la méthode avait toujours marché. Tant que la grandeur
est plate, lire une heure au hasard **est** lire le régime. Le défaut ne pouvait apparaître que le
jour où le régime cesse d'être plat — c'est-à-dire le jour même où l'on cherchait à le
caractériser. **C'est la famille de VPS-M64** (*un détecteur qui vérifie A et conclut B est
indiscernable d'un détecteur correct tant que A et B varient ensemble*), appliquée non plus à un
verdict du collecteur mais à une **lecture faite à la main dans le rapport**.

**Le second défaut, et il est structurel** : le seuil de réescalade de VPS-035 était écrit sur
« le débit », sans dire lequel. La **dernière heure de toute fenêtre est partielle** (VPS-M61) :
elle affiche ce matin **56,8**, sous le seuil de 60. *Le seuil se serait déclenché à tort dès le
lendemain de son écriture, puis à chaque passage, par construction.*

**Quoi faire — FAIT, en trois endroits.**

1. Le collecteur publie le taux **par émetteur sur 24 h glissantes** — une moyenne qui intègre le
   cycle complet — et écrit dans sa sortie **pourquoi** c'est une moyenne :
   *« lu a une SEULE heure, il confond le creux de la nuit avec une derive du regime »*.
2. Le seuil de VPS-035 est réécrit sur cette moyenne, jamais sur une heure.
3. La fiche VPS-035 porte désormais le tableau **moyenne / min / max / amplitude par journée** —
   sans l'amplitude, un changement de *nature* du signal reste invisible derrière une moyenne.

**`aNePasFaire`** : ⚠️ **ne pas « corriger » en prenant toujours l'heure la plus haute ou la plus
basse** : on remplacerait un biais par un autre, et on perdrait le cycle. ⚠️ **Ne pas lire la
moyenne 24 h comme une garantie d'absence de pic** — elle est aveugle à une rafale d'une heure,
exactement comme `idle%` est aveugle à une saturation de vingt minutes (VPS-M62). C'est pour ça
que min et max sont publiés **à côté** de la moyenne, et non à sa place. ⚠️ **Et ne pas conclure
que la baisse de 30 % est bénigne parce que la baisse de 40 % était fausse** : la question produit
— *quelle cadence veut-on ?* — reste entière et n'a toujours pas de réponse écrite.

---

### VPS-M68 — `processusParMin` est publié en série de tendance depuis vingt passages, et c'est du bruit de mesure

- **Domaine** : méthode · **Gravité** : 2 · **Statut** : ✅ `APPLIQUE` (2026-08-25)
- 🔴 **Vu : 2026-08-26 — CONFIRMÉ, ET LE CONSTAT ÉTAIT SOUS-ÉVALUÉ.** Le correctif posé la veille
  rend, à sa deuxième exécution : valeur publiée **1 122/min**, sous-fenêtres 3 s/3 s/4 s
  **400 · 2 440 · 675**, **étendue intra-fenêtre 2 040/min = 182 % de la valeur publiée** (contre
  80 % la veille). **Entre deux sous-fenêtres distantes de trois secondes, le taux varie d'un
  facteur 6,1.** La série de vingt passages (facteur 1,8) tient **très largement** dans le bruit de
  la mesure elle-même. *Un correctif qui, à sa deuxième exécution, montre que le défaut était deux
  fois pire que mesuré, est la meilleure preuve qu'il fallait le poser.*
- **Vu** : 2026-08-25 · **Mesure** : l'étendue **à l'intérieur** de la fenêtre de 10 s vaut
  **80 %** de la valeur publiée (sous-fenêtres 3 s/3 s/4 s : **1 220 · 480 · 1 305** /min pour une
  valeur publiée de **1 032**). Et **cinq sondages consécutifs en quinze minutes**, machine
  inchangée : **942 · 1 446 · 1 278 · 1 296 · 1 500** — **étendue ×1,59**.

**Quoi.** Le manifeste publie `processusParMin` parmi ses `chiffres` de tendance depuis vingt
passages. La série vaut **1 230 · 762 · 1 374 · 786 · 1 224**, soit un facteur **1,8** entre
passages. **La dispersion de cinq mesures prises de suite couvre ×1,59.** *La « tendance » de vingt
jours tient presque entièrement dans ce qu'on obtient en mesurant cinq fois d'affilée.*

**Ce que ça a produit.** Le champ `previsions.chargeDeFond.note` portait l'affirmation inverse,
écrite noir sur blanc et republiée à chaque passage :

> *« La variance est entre les JOURS, pas dans la mesure (témoin indépendant le 08-22 : 3 % d'écart
> avec le collecteur). »*

**Pourquoi c'était invisible — et c'est la partie qui instruit.** Le témoin du 08-22 comparait
**deux instruments sur la même fenêtre**, et trouvait 3 % d'écart. C'est une mesure d'**accord
entre instruments**, pas de **reproductibilité de la grandeur**. *Deux thermomètres qui s'accordent
à 3 % ne disent rien de la stabilité de la température.* La preuve avait la **forme** d'une
validation — un témoin indépendant, un écart chiffré, une conclusion — et elle validait une autre
proposition que celle qu'elle servait à défendre. C'est la famille de VPS-M64, appliquée non plus à
un verdict du collecteur mais à une **preuve écrite dans le manifeste**.

**Quoi faire — fait.** La même fenêtre de 10 s est découpée en **trois** (3+3+4). La valeur
publiée **ne change pas** — vingt passages de comparaison sont préservés, ce qu'un renommage aurait
cassé sans prévenir (VPS-M60, VPS-M63) — et l'**étendue** est imprimée à côté, avec un verdict.
**Coût : zéro seconde**, deux lectures de `/proc/stat` en plus.

**`pourquoiInvisible`** : parce que personne n'avait mesuré la **dispersion** de la grandeur. Sa
*définition* est correcte, son *instrument* est correct, son *témoin* était correct — seule la
question « combien varie-t-elle si je la mesure deux fois de suite ? » n'avait jamais été posée.

**`aNePasFaire`** : ⚠️ **ne pas allonger la fenêtre** pour « mieux mesurer » — à 20 s, la collecte
dépassait déjà 90 s (VPS-M05), et le budget est une règle de la procédure, pas un confort. ⚠️ **Ne
pas retirer la clef du manifeste** : une série de vingt points, même bruitée, garde sa valeur
d'archive ; ce qu'il faut retirer, c'est la **lecture en tendance**. ⚠️ **Ne pas lire une étendue
intra-fenêtre faible comme une preuve de reproductibilité inter-jours** : elle éliminerait
seulement la rafale courte. Le collecteur l'écrit dans ses deux branches.

---

### VPS-M67 — La borne de la projection de volume était écrite en dur, et elle se trompait de sens le jour où le débit baissait

- **Domaine** : méthode · **Gravité** : 3 · **Statut** : ✅ `APPLIQUE` (2026-08-25)
- **Vu** : 2026-08-25 · **Mesure** : sur `wire_logs` à **×0,67** et
  `position_sampling_decisions` à **×0,63**, le collecteur imprimait *« ⚠️ PLANCHER »* sur des
  projections qui sont des **plafonds**.

**Quoi.** Le bloc de projection — **posé la veille**, en correctif de VPS-M64 — annonçait :

```
⚠️ PLANCHER, pas une prevision : si le debit monte encore, la projection monte avec lui.
```

La mention était **codée en dur**, et elle a été écrite **un jour où le débit montait**. Or la
projection est bâtie sur la moyenne des 24 h écoulées :

| tendance du débit | ce que la moyenne des 24 h contient | la projection est un… |
|---|---|---|
| montant | le **bas** de la rampe | **plancher** ✅ |
| descendant | le **haut** de la rampe | **plafond** ❌ *annoncé « plancher »* |

**Pourquoi c'était invisible.** Le bloc n'avait vécu qu'**un seul jour**, et ce jour-là le débit
montait : l'étiquette et la réalité coïncidaient. **Il ne pouvait se tromper que le jour où le
débit baisserait** — c'est-à-dire le jour où l'on annonce une amélioration. Et une amélioration
**sous-estimée ne se fait jamais contredire** : personne ne rouvre un constat pour signaler que la
bonne nouvelle était meilleure que prévu.

> C'est **VPS-M64 dans la même section, un jour plus tard, à l'intérieur de son propre correctif**.
> *Le correctif d'un défaut de raisonnement peut porter le même défaut de raisonnement.*

**Quoi faire — fait.** La borne suit désormais le **signe** de la tendance (`r > 1.05` → plancher,
`r < 0.95` → plafond), avec un troisième cas pour le débit plat. **Coût nul.** **Vérifié sur les
quatre branches** — montant, descendant, plat, et dénominateur nul — en rejouant hors ligne les
lignes réelles du jour.

**`pourquoiInvisible`** : un bloc d'un jour d'âge n'a été confronté qu'à un seul régime. *Toute
étiquette conditionnelle écrite en dur est vraie jusqu'au premier changement de régime, et c'est
exactement là qu'on la lit.*

**`aNePasFaire`** : ⚠️ **ne pas présenter la projection à débit descendant comme « le gain
acquis »** — elle le sous-estime. ⚠️ Et ⚠️ **ne pas supprimer la borne pour éviter le problème** :
une projection sans borne annoncée est pire qu'une borne du mauvais côté, parce qu'elle ne se
laisse pas réfuter.

---

### VPS-M66 — Le plan d'action a republié pendant sept passages un gain que le collecteur, deux lignes plus bas, déclarait non durable

- **Domaine** : méthode · **Gravité** : 3 · **Statut** : ✅ `APPLIQUE` (2026-08-24)
- **Vu** : 2026-08-24 · **Mesure** : la mémoire de `dockerd` passe de **1 377 Mo à 510 Mo
  (−63 %) sans aucun redémarrage** — même processus, `uptime` continu de 436,9 h à 460,9 h.

**Quoi.** Le point 5 du plan (« Redémarrer pour prendre le noyau ») porte depuis sept passages
l'argument : *« Rend aussi la mémoire de `dockerd` (1 377 Mo) »*. Or le levier 7 du collecteur
imprime, **sur la ligne même où il donne ce nombre** :

```
memoire de dockerd  1377 Mo (uptime 436.9 h) -> viser < 400 Mo :
suit les BUILDS, pas l'uptime — un redemarrage ne regle rien de durable
```

**Le collecteur disait donc explicitement de ne pas en faire un gain de redémarrage, et le plan
en a fait un gain de redémarrage.** La série mesurée le confirme :

```
08-17  08-18  08-19  08-20  08-21  08-22  08-23  08-24
1211   1427   1333   1744   1486   1562   1377    510   Mo
```

Le **510** est une rupture nette, à `uptime` strictement croissant : la mémoire est revenue
**toute seule**, après le build du 08-23. Ce n'est plus une mise en garde, c'est une réfutation.

**Pourquoi c'était invisible.** *Un avertissement placé à côté d'un nombre ne voyage pas avec le
nombre.* Le plan recopiait la valeur ; la phrase qui en interdisait cette lecture restait dans la
collecte. **C'est exactement VPS-M63**, où `paquetsEnRetard` a voyagé sans son « à titre
indicatif SEULEMENT » — et c'est la question ouverte du rapport du 08-23, *« qui garantit qu'un
chiffre marqué invalide à la production le reste à la recopie ? »*, dont voici la **troisième**
occurrence en deux passages. La réponse empirique est : **personne**.

**Quoi faire.** Fait ce passage : le point 5 du plan ne porte plus de gain mémoire, et son gain
est désormais le seul qui résiste — **prendre le noyau 6.8.0-138**. Le reste du travail est celui
que la question ouverte du 08-23 désignait déjà : marquer les valeurs invalides **dans la sortie
elle-même**, pas à côté.

**`aNePasFaire`** : ⚠️ **ne pas en conclure que le redémarrage est inutile** — il reste requis
pour le noyau (deux versions de retard) et pour les 4 services sur bibliothèque remplacée. C'est
**l'argument mémoire** qui tombe, pas l'action.

### VPS-M65 — L'angle mort n° 4 était documenté depuis quatre passages, et une portée écrite avait pris la place de la mesure

- **Domaine** : méthode · **Gravité** : 3 · **Statut** : ✅ `APPLIQUE` (2026-08-24)
- **Vu** : 2026-08-24 · **Mesure** : le bloc des clients Docker publiait **« 0 processus client
  `docker` au total »** chaque nuit, suivi de cinq lignes disant que ce 0 ne couvrait pas les
  clients anonymes — **sans jamais dire combien il y en avait**.

**Quoi.** La portée était juste, écrite le 2026-08-20 après VPS-M49, et re-signalée comme angle
mort n° 4 dans **quatre** rapports consécutifs (08-19 → 08-23), le dernier la qualifiant de
*« le moins cher des angles morts restants et le seul qui touche le constat de gravité 1 le plus
récent »*. Elle n'a jamais été mesurée.

> *Un avertissement qui remplace une mesure finit par se lire comme la mesure.* Le lecteur voit
> un `0`, une case verte, et cinq lignes de prose — il retient le `0`.

**Le correctif compte les CONNEXIONS, pas les noms** : côté serveur, tout client de l'API tient
une socket unix ÉTABLIE sur `/run/docker.sock`, qu'il s'appelle `docker`, `curl`, `traefik` ou
rien du tout.

**⚠️ Et le premier piège a été tendu à l'écriture même.** `ss -x` **seul ne rend rien** pour
`/run/docker.sock` : il faut `-p`. Vérifié sur la machine — la même commande sans `-p` rend
**zéro ligne**, avec `-p` elle les rend toutes. Écrire `ss -x` aurait donc produit un **`0`
permanent et faux, du côté rassurant** : la famille VPS-M28 exactement, un détecteur qui n'a
jamais rien pu voir. *Seul l'essai avec un témoin l'a montré* — la lecture du code ne pouvait
pas.

**⚠️⚠️ Et le second piège : c'est un ÉCHANTILLON.** Le compte valait **8** à 02 h 40 et **0** à
02 h 55 le jour de son écriture. Publier le second comme un fait aurait rejoué **VPS-M36**
(« le `wchan` est un échantillon, et il sert de preuve »). On prend donc **trois sondages sur
1,1 s** et on publie l'étendue. La portée est alignée sur le défaut recherché **et elle est
dite** : 1,1 s attrape un client qui **dure** — la cible, puisque VPS-016 est causé par des
clients qui vivent des **minutes** ; elle rate un client éclair, qui ne bloque rien.

**Vérification.** Deux cas exécutés sur la machine, dont un **témoin actif** :

```
CAS 1 (repos)  : aucune connexion ETABLIE sur /run/docker.sock (3 sondages sur 1,1 s)
CAS 2 (témoin) : 1 connexion(s) ETABLIE(S) ... pour 0 processus nomme(s) « docker »
```

Le témoin est un `curl --unix-socket` : **un client que l'ancien détecteur ne pouvait pas voir,
et que le nouveau voit.** L'angle mort est fermé et la fermeture est prouvée, pas affirmée.

**Bénéfice imprévu.** Nommer les clients permanents a produit **VPS-034** : `foodsqan-traefik`
monte la socket. La donnée était dans `INSPECT_JSON` depuis le 08-12.

**Coût** : ~1,2 s, dont 1,0 s d'attente délibérée. Aucun appel à Docker.

### VPS-M64 — La fenêtre de rétention prouvait une DURÉE et concluait sur un VOLUME

- **Domaine** : méthode · **Gravité** : 2 · **Statut** : ✅ `APPLIQUE` (2026-08-24)
- **Vu** : 2026-08-24 · **Mesure** : le bloc a imprimé *« fenêtre COURTE et STABLE = rétention
  active, rien à faire »* sur `wire_logs` (**+16,3 % en 24 h**) et sur
  `position_sampling_decisions` (**+25,1 %**), le jour même.

**Quoi.** Le bloc lisait `min(date)`, `max(date)` et le nombre de jours distincts, puis tranchait
la question qu'il s'était posée — *« accumulation ou régime permanent ? »*. Les deux fenêtres
étaient identiques à la veille. Le verdict rassurant est donc tombé, **exact sur ce qu'il
mesurait**.

**Le verdict était un non-sequitur.** Une fenêtre borne une **durée**, jamais un **volume** : à
rétention constante, le volume est le produit de la durée **par le débit d'arrivée** — et le
débit n'était mesuré nulle part. Les émetteurs ont triplé leur cadence le 08-23 (VPS-035) : la
fenêtre n'a pas bougé d'une minute et les tables vont vers le triple de leur taille.

> C'est la règle du §0 de la procédure — *« un compteur doit prouver qu'il compte ce qu'il
> prétend compter »* — prise en défaut sur le mot le plus discret de la phrase : le compteur
> comptait des **jours** et répondait sur des **octets**.

**Pourquoi c'était invisible.** Parce que le bloc **avait raison tous les jours précédents**. Un
détecteur qui vérifie A et conclut B est indiscernable d'un détecteur correct **tant que A et B
varient ensemble** — ici, tant que le débit est stable, c'est-à-dire depuis toujours. Il ne se
trompe que le jour où il faudrait qu'il parle. *La famille est celle de VPS-M10 : un seuil qui
ne peut se tromper que le jour où il compte.*

**Le correctif.** Deux agrégats `FILTER` de plus **sur le parcours de table qui avait déjà lieu**
— arrivées des 24 h contre arrivées des 24 h précédentes — plus la taille lue au catalogue, et
une projection à fenêtre pleine. **Coût : nul** ; aucune requête ni `docker exec` de plus.

**⚠️ La comparaison est INTERNE à la passe.** Le collecteur n'a aucune mémoire d'un passage à
l'autre, et un détecteur qui exige cette mémoire **ne se déclenche jamais le jour où il
faudrait** — c'est la leçon de VPS-M50 (« le catalogue n'a aucune notion de nouveau »).

**Vérification, cas sain compris (discipline VPS-M40).** Exécuté sur la machine :

```
wire_logs    x1.84  LE DEBIT MONTE       projection 404 Mo (266,5 aujourd hui)
psd          x2.01  LE DEBIT MONTE       projection 369 Mo (229,3 aujourd hui)
positions    x0.77  debit stable         fenetre 62 j, 446 Mo — INCHANGEE
table vide   ->     (debit non comparable : 0 arrivee sur les 24 h PRECEDENTES)
```

`positions` est le **cas sain** : même bloc, même passage, verdict vert. Un détecteur qui n'a
jamais vu un cas sain n'est pas un détecteur, c'est une alarme.

**`aNePasFaire`** : ⚠️ **ne pas lire la projection comme une prévision** — elle suppose le débit
des 24 h écoulées constant, et le collecteur l'imprime explicitement comme un **plancher**.
⚠️ **Ne pas retirer les bornes de fenêtre** : elles restent le seul détecteur d'une rétention
qui **s'arrête**. Les deux mesures répondent à deux questions différentes ; c'est de les avoir
confondues que venait le défaut.

### VPS-M63 — Le manifeste republie, dans sa série de tendance, le nombre que le collecteur lui interdit de reporter

- **Domaine** : méthode · **Gravité** : 2 · **Statut** : ✅ `APPLIQUE` (2026-08-23)
- **Vu** : 2026-08-23 · **Mesure** : **2 passages sur 5** portent dans `paquetsEnRetard` une
  valeur que le collecteur avait marquée « à titre indicatif SEULEMENT ».

**Ce que le collecteur écrit**, depuis sa correction du 08-19 (VPS-M29) :

```
  🟠 NON MESURABLE — le cache apt a 23 h (seuil de validite : 6 h).
     Ce que le cache PERIME affiche, a titre indicatif SEULEMENT : 68 paquets en retard,
     dont 0 estampilles securite. NE PAS reporter ces deux nombres comme une mesure.
```

**Ce que le manifeste a enregistré :**

| Passage | Verdict du collecteur | `chiffres.paquetsEnRetard` |
|---|---|---|
| 08-19 | NON MESURABLE — *indicatif* : 70 | `70` ❌ |
| 08-20 | NON MESURABLE — *indicatif* : 64 | `64` ❌ |
| 08-21 | ✅ mesure valide : 85 | `85` ✅ |
| 08-22 | NON MESURABLE | chaîne explicite ✅ |

**Les deux ❌ sont POSTÉRIEURS à la correction du collecteur.** L'endroit où le mauvais nombre est
**produit** a été réparé ; l'endroit où il est **recopié** ne l'a pas été.

**Pourquoi c'était invisible.** L'avertissement est **du texte à côté du nombre**, et le nombre
voyage seul. Une recopie machinale prend `70`, qui est un entier plausible, et laisse derrière
elle la phrase qui l'invalidait.

> *Marquer une valeur comme invalide ne la protège que de quelqu'un qui lit la marque. Contre
> l'automatisme, il faut que la valeur elle-même devienne inutilisable.*

**Correctif appliqué** : les deux valeurs sont remplacées dans le manifeste par une chaîne
explicite portant leur origine. Aucune n'est supprimée — elles deviennent lisibles pour ce
qu'elles sont.

**`aNePasFaire`** : ⚠️ ne pas se contenter de corriger les deux points passés. La **piste** posée
pour le passage suivant est de préfixer les valeurs invalides dans la sortie du collecteur
(`⛔70` plutôt que `70`), pour qu'une recopie machinale produise une chaîne visiblement fausse au
lieu d'un entier plausible.

### VPS-M62 — Dix-neuf passages de « production 🟢 » sans jamais mesurer la capacité

- **Domaine** : méthode · **Gravité** : 3 · **Statut** : ✅ `APPLIQUE` (2026-08-23)
- **Vu** : 2026-08-23 · **Angle mort reporté 4 fois** avant d'être traité.

**Quoi.** Le rapport concluait « production 🟢 » sur des temps de réponse (28 ms sur quatre
points). *La disponibilité est un indicateur **binaire et tardif** : il bascule quand c'est déjà
arrivé.* Rien ne disait s'il restait de la marge.

**Correctif.** Un bloc en section 9 qui compare l'inactivité de **la veille** à la **plus ancienne
journée conservée**, publie l'étendue des journées complètes, et porte **ses seuils de réescalade
écrits** — 🟠 sous 50 % sur une journée entière, 🔴 sous 25 % ou 🟠 trois jours de suite. Première
mesure : **87,93 %** la veille contre **38,82 %** pour la plus ancienne, étendue 19,54 % →
87,93 %.

**Coût : nul.** La donnée était déjà lue par le tableau ; elle est relue depuis une variable, sans
un appel `sar` de plus.

**Pourquoi maintenant.** Quatre journées calmes d'affilée donnent une référence **saine**. Un
indicateur né le jour d'un incident naîtrait avec le régime de panne pour normale — VPS-M48.

**`aNePasFaire`** : ⚠️ **ne pas lire `idle%` comme une garantie d'absence de saturation** : c'est
une moyenne sur 24 h, aveugle à un pic de vingt minutes. Le 08-17 l'illustre — 19,54 %
d'inactivité **et** un pic de charge à 17,35. La portée est écrite dans la sortie elle-même.
⚠️ **Exclure le jour en cours par règle et non par distraction** : il est partiel (VPS-M61), et le
comparer aux jours complets ferait dire n'importe quoi à l'écart.

### VPS-M61 — Les deux bords de chaque histogramme « par jour » sont partiels, et le manifeste l'a publié comme une preuve de régularité

- **Domaine** : méthode · **Gravité** : 2 · **Statut** : ✅ `APPLIQUE` (2026-08-23)
- **Vu** : 2026-08-23 · **Mesure** : la même journée vaut **52** puis **27** ; une autre **52**
  puis **8** ; une troisième **72** puis **360**.

**QUOI.** Les histogrammes « par jour » sont découpés dans une fenêtre de **7 jours glissante**,
qui commence et finit **à l'heure de la collecte**. Le premier jour est amputé de son début, le
dernier n'a pas eu lieu. Trois paires, prises sur les collectes archivées :

| Journée | passe du 08-21 | du 08-22 | du 08-23 | bloc |
|---|---:|---:|---:|---|
| 08-15 | **52** | **27** | — | hyperviseur |
| 08-16 | 52 | **52** | **8** | hyperviseur |
| 08-16 | — | **46** | **30** | sessions SSH |
| 08-22 | — | **72** | **360** | sessions SSH |

Les journées du **milieu** sont identiques à l'unité près (08-17 → 08-21 : 109, 175, 630, 4 252,
2 094 des deux côtés) : **le compteur est sain, seuls les deux bords mentent.**

La démonstration s'est rejouée à huit minutes d'intervalle le 08-23 : la collecte de 02:22 donne
**30** pour le 08-16, la vérification de 02:30 donne **27**.

**Pourquoi c'était invisible — et c'est la partie qui compte.** *Le collecteur portait déjà la
leçon, à un seul endroit* : la section 9 écrit depuis le premier jour *« la dernière étant le jour
EN COURS (partielle) »*. Trois autres blocs avaient le même défaut et ne l'ont jamais reçue.

> *Une leçon apprise localement ne se propage pas toute seule. Tant qu'elle reste un commentaire à
> côté d'un bloc, elle protège ce bloc et rien d'autre — il faut la **factoriser** pour qu'elle
> devienne une propriété du collecteur.*

**Ce que ça a coûté.** Le manifeste décrit `8 · 52 · 52 · 52 · 52 · 53 · 59 · 5` comme
**« régulière à l'unité près »** : le `8` et le `5` sont les deux seuls nombres de la série qui ne
mesurent rien. La conclusion (~52/jour) reste **juste**, mais elle l'est *malgré* sa preuve.

**Correctif appliqué.** Une fonction unique `hist_jour`, appelée par les **trois** histogrammes
(échecs SSH, sessions SSH, hyperviseur) : elle marque les deux bords, nomme la fenêtre, et publie
le nombre de jours réellement comparables. **Coût nul** — aucune commande, aucune lecture de plus.
**Vérifiée sur la machine**, cas limites compris (histogramme vide ; histogramme de 2 lignes,
c'est-à-dire *que* des bords).

**`aNePasFaire`** : ⚠️ **ne pas « corriger » en élargissant la fenêtre à 8 jours** — cela déplace
les bords, ça ne les supprime pas. ⚠️ **Ne pas comparer un bord d'un passage au même jour vu par
un autre passage** : c'est ce qui fabrique des tendances qui n'existent pas.

### VPS-M60 — Deux pourcentages de disque dans la même collecte, et la série de tendance piochait dans les deux

- **Domaine** : méthode · **Gravité** : 3 · **Statut** : ✅ `APPLIQUE` (2026-08-22)
- **Vu** : 2026-08-22 · **Mesure** : `df -h` affiche **56 %**, la section 10 calcule **55 %** — même disque, même collecte. Relevé des cinq passages précédents : manifeste = **68** (section 10) le 08-18, **54** (section 10) le 08-19, **55** (`df`) le 08-21, et **50** le 08-20 — qui ne vient d'**aucune** des deux.

**Quoi.** La carte « Prévisions » de l'écran calcule la **pente de remplissage du disque** à
partir de `passages[].chiffres.disqueUtilisePct`. Ce champ est recopié à la main depuis la
collecte — et la collecte en contient **deux**, à un point d'écart, sans dire laquelle prendre.
Le disque avance d'environ **0,1 point par jour** : **un point d'écart vaut dix jours de
tendance**, et la série en contenait au moins trois sauts de définition.

**Et la cause de l'écart n'est pas celle que j'avais écrite.** Le premier commentaire disait que
`df` comptait les 5 % de blocs réservés à root. **Faux**, et le contrôle l'a dit immédiatement :

```
total=100476656  used=55459356  avail=45000916
used/(used+avail) = 55.205 %      used/total = 55.196 %      df -h dit : 56 %
```

**Les deux formules donnent 55,2 %.** L'écart est un **arrondi** : GNU `df` arrondit le
pourcentage **au supérieur**, pas au plus proche.

> *Deux chiffres qui diffèrent d'un point n'ont pas forcément deux définitions — ils peuvent
> n'avoir que deux arrondis, et on ne le sait qu'en refaisant le calcul à la main.* J'ai failli
> publier une explication plausible et fausse **dans le commentaire du correctif** : elle
> n'aurait contredit aucune mesure, et elle aurait survécu comme les « ~25 % » de VPS-M55.

**Quoi faire — FAIT.** La section 10 **nomme** désormais la valeur canonique, calculée avec
`ceil()` et **vérifiée contre `df -h` sur la machine : 56 = 56**. La ligne rappelle que l'autre
pourcentage est le même nombre arrondi autrement.

**`aNePasFaire`** : ⚠️ **ne pas recalculer rétroactivement la série** pour « l'homogénéiser ». Les
valeurs passées ont été lues dans des collectes archivées ; les réécrire ferait perdre la seule
trace de ce qui a été réellement observé. *La série repart d'ici, et le rapport le dit.*

---

### VPS-M59 — `previsions.chargeDeFond.note` est écrit à chaque passage et n'est affiché nulle part

- **Domaine** : méthode · **Gravité** : 3 · **Statut** : ✅ `APPLIQUE` (2026-09-04)
- ✅ **Vu : 2026-09-04 — CORRIGÉ, ET LA MENTION « HORS DE PORTÉE DE L'AGENT » ÉTAIT FAUSSE.**
  Le constat est sorti **neuf fois** en portant *« l'agent ne peut pas le corriger : c'est du code
  applicatif »*. Ce n'est pas du code applicatif hors de portée : c'est **une ligne de gabarit dans
  notre propre dépôt**, et le correctif a pris un `@if` et six lignes de CSS.
  *Une portée écrite prend la place de la mesure et se recopie ensuite sans être relue — c'est
  VPS-M65 et VPS-M42, appliqués cette fois à une auto-limitation.*

  🔴 **ET LE PASSAGE A TROUVÉ PLUS GRAVE QUE CE QU'IL CHERCHAIT : LA GARDE QUE TOUT LE MONDE
  CROYAIT POSÉE N'EXISTAIT PAS.** Le gabarit ne portait qu'un `@if (idx.previsions; as p)` et
  lisait ensuite `p.chargeDeFond.healthchecksParMinute` **sans aucune garde**. Un passage qui
  n'écrirait pas `previsions.chargeDeFond` referait donc disparaître **toute la carte
  « Prévisions », tableau du disque compris** — **TRK-033 à l'identique** (2026-08-19). Vérifié
  aussi : le service API sert le JSON **brut, sans validation** — le type `VpsWikiPrevisions` est
  *une promesse que le compilateur n'a aucun moyen de tenir*.

  **Correctif appliqué** : garde `@if (p.chargeDeFond; as cf)` **avec branche `@else`** qui dit
  *« mesure absente du manifeste — ce n'est PAS “aucune charge de fond” »* (VPS-M02), plus le
  rendu de `note` dans un encadré distinct.

  **Vérifié à quatre niveaux** : `tsc --noEmit` ✅ (après **13 erreurs** au 1ᵉʳ jet), `ng build`
  ✅ `NG_EXIT=0` — seul juge du `@if`/`@else` —, présence dans le **bundle servi**
  (`chunk-K4HBXQ56.js`), et **5/5 garde-fous maison**.

  ⚠️ **Le 1ᵉʳ jet a rejoué LE PIÈGE DES ACCENTS GRAVES, pour la QUATRIÈME fois sur ce projet.**
  Mes commentaires citaient le code entre accents graves, dans un gabarit qui est un *template
  literal* : **un seul accent grave y ferme la chaîne et décapite le composant entier.**
  13 erreurs `TS1005/TS1109/TS1443`. *Première fois qu'il est attrapé avant publication — parce
  que le typecheck a été lancé au lieu d'être supposé.*

  ⚠️ **NON DÉPLOYÉ** : commité, pas déployé. `/admin/vps` affiche encore l'ancienne version — sans
  la note **et sans la garde** — jusqu'au prochain déploiement de `tracky-web`.
- **Vu** : 2026-08-22 · **Mesure à la découverte** : `apps/web/src/app/features/observability/admin-vps.component.ts`, lignes **180-184**, n'utilise que `healthchecksParMinute`, `conteneursSondes`, `healthchecksParJour` et `processusParMinute`. **`note` n'apparaît dans aucun gabarit** (le seul `note` rendu, ligne 219, est celui d'`ordonnancement`). Le champ courant fait **plus de 900 caractères**.

**Quoi.** Le manifeste porte, dans `previsions.chargeDeFond.note`, les avertissements qui disent
**comment lire les nombres affichés juste à côté** — notamment que les 762 processus/min du
08-21 ne se comparent pas aux 1 230 du 08-20 parce que la machine était alors saturée. **Rien de
tout cela n'atteint l'écran.**

**Pourquoi c'était invisible, et c'est le vrai sujet.** Le champ est déclaré `note?: string` dans
l'interface du service : il est donc **valide**, le typage est satisfait, et rien ne se plaint.
*Un champ facultatif qu'aucun gabarit ne lit est indiscernable, côté données, d'un champ lu.*

> **C'est la face douce de TRK-033.** Là-bas, un champ **absent** du manifeste et lu **sans garde**
> par le gabarit éteignait toute la carte « Prévisions ». Ici, un champ **présent** dans le
> manifeste et lu par **personne** disparaît en silence. *Les deux viennent de la même cause : un
> type TypeScript posé sur un JSON non validé n'est pas un contrat, c'est une promesse que le
> compilateur n'a aucun moyen de tenir.*

**Quoi faire.** Deux réponses, et elles ne sont **pas** équivalentes — c'est pourquoi l'audit ne
tranche pas seul : soit le gabarit **rend** `note` (et l'avertissement sert enfin), soit le champ
est **retiré** du manifeste (et l'on cesse d'écrire pour personne). La première ajoute du texte à
un écran déjà dense ; la seconde perd une information qu'aucun autre endroit ne porte.

**`aNePasFaire`** : ⚠️ **ne pas ajouter de nouvelle clé à `previsions` en attendant.** Toute clé
ajoutée subirait exactement le même sort — écrite, jamais lue — et l'on ne s'en apercevrait pas
davantage. C'est pour cette raison que la mesure de VPS-032 a été portée dans `chiffres`, qui est
rendu **génériquement** (`Object.entries`), et non dans `chargeDeFond`.

---

### VPS-M58 — La ligne verte du levier 1 se contredisait à l'œil nu

- **Domaine** : méthode · **Gravité** : 4 · **Statut** : ✅ `APPLIQUE` (2026-08-22)
- **Vu** : 2026-08-22 · **Mesure** : la sortie affichait `✅ cache de build (Private) 10.42GB … contenu par son ramasse-miettes (plafond 10 Go)` — une valeur **au-dessus** du plafond qu'elle cite, sous une coche verte.

**Quoi.** Le verdict était **juste** : il porte sur le **seuil d'alerte**, qui vaut `plafond × 1,5`
= **15 Go** depuis le correctif VPS-M10. Mais ce seuil n'était écrit **nulle part** dans la branche
verte — seule la branche rouge l'affichait. Le lecteur voyait donc une coche verte à côté de deux
nombres qui se contredisent, sans moyen de savoir à quoi 10,42 avait été comparé.

> *Un verdict juste dont on ne publie pas le critère se lit comme un verdict faux* — et le doute
> qu'il installe coûte autant qu'une erreur : il a fallu ouvrir le script et remonter jusqu'à
> `SEUIL_BC` pour l'écarter. **Ce temps-là est le coût réel du défaut**, et il se serait repayé à
> chaque relecture.

**Quoi faire — FAIT.** La ligne publie désormais son critère :
`sous son seuil d alerte de 15 Go (= plafond 10 Go du ramasse-miettes + 50 % de marge, VPS-M10)`.

**`aNePasFaire`** : ⚠️ **ne pas ramener le seuil à 10 Go** « pour que la ligne soit cohérente ».
C'est précisément ce que VPS-M10 a corrigé : un seuil égal à la cible du mécanisme qu'il
surveille déclenche une alerte **quotidienne** sur un état parfaitement normal.

---

### VPS-M57 — Les deux audits planifiés ont collisionné, et le catalogue les déclarait à 3 h 20 d'écart

- **Domaine** : méthode · **Gravité** : 2 · **Statut** : ✅ `APPLIQUE` (2026-08-22) — **détecteur posé, mais son dessin d'origine a été RÉFUTÉ**
- **Vu** : 2026-08-21 · **Mesure du 2026-08-22** : **aucune collision.** Le centre d'alerte a collecté de **01 h 11 à 01 h 36**, la collecte VPS de **02 h 23 min 36 à 02 h 25 min 41** — **47 minutes d'écart**, et `auth.log` porte **exactement une session** pendant cette fenêtre : la mienne. Le voisin est **à l'heure** (01 h 09 déclarée, 01 h 11 observée) après avoir dérivé de 3 h 22 la veille.
- **Mesure du 2026-08-21, conservée** : l'audit du centre d'alerte a collecté de **04 h 31 à 04 h 33** (déclaré par son propre rapport), précédé d'une rafale de **8 sessions SSH en 7 secondes** (04 h 30 min 04 → 04 h 30 min 11). La collecte VPS a tourné de **04 h 31 min 07 à 04 h 32 min 55** — **entièrement recouverte**. L'`ordonnancement` déclarait **01 h 09 UTC** et **04 h 21 UTC** : 3 h 20 d'écart.

> ### 🔴 2026-08-22 — LE CORRECTIF QUE CE CONSTAT DEMANDAIT ÉTAIT LE MAUVAIS, ET C'EST SA PROPRE MESURE QUI L'A DIT
>
> Le « quoi faire » ci-dessous proposait de signaler *« une rafale de sessions SSH encadrant la
> collecte »*. **VPS-032 réfute ce dessin** : sur une journée de travail il y a **~5 sessions par
> minute de 10 h à 23 h**. La rafale n'est pas un événement, c'est **le régime permanent** — et un
> détecteur calibré dessus crierait **chaque après-midi**. C'est VPS-M10 à l'identique : *une
> alerte qui se déclenche tous les jours sur un état normal n'est plus une alerte.*
>
> **Ce qui a été posé à la place** : un **compteur avec son dénominateur**, qui dit *combien* et
> refuse de dire *qui*. Il identifie sa propre session par son **port source** (`SSH_CONNECTION`
> croisé avec `from <ip> port <port>` d'`auth.log`) au lieu de la supposer, et signale le cas où
> il ne la retrouve pas plutôt que de publier un « reste » sur-évalué en silence.
>
> > **La leçon** : *un constat peut être juste et son remède faux.* Celui-ci décrivait
> > correctement une collision réelle, et proposait un détecteur qu'aucune mesure n'avait
> > étayé — parce que la grandeur dont il dépendait (« combien de sessions y a-t-il
> > normalement ? ») **n'avait jamais été mesurée**. Elle l'a été le lendemain, et elle vaut
> > 4 252 par jour. **Écrire un seuil avant d'avoir mesuré la ligne de base, c'est le
> > VPS-M52 des détecteurs.**

**Quoi.** Deux dispositifs planifiés ont interrogé la même machine à 2 vCPU dans la même fenêtre de
deux minutes. L'un parcourt `/opt` en priorité d'E/S `idle`, l'autre enchaîne des requêtes courtes
sur `tracky-postgres`. **Un parcours en classe « idle » attend d'autant plus que quelqu'un d'autre
lit le disque** (VPS-M16) : la collision explique à la fois les 35 s de `/opt` et la ligne
« **reste 30,9 %** » du discriminant, anormalement grosse pour une machine au repos.

**Pourquoi c'était invisible — et c'est le vrai constat.** L'`ordonnancement` existe **précisément**
pour ça : *« c'est le seul endroit où l'on voit les collisions »*. Mais ses heures sont
**déclaratives** — elles décrivent le déclenchement prévu, et **rien ne les vérifie**. Le rapport du
centre d'alerte note lui-même que la veille sa collecte était à « 01:1x » et aujourd'hui à 04 h 33 :
**son heure réelle dérive de plus de trois heures d'un jour à l'autre.**

> *Un catalogue d'ordonnancement rempli à la main décrit les intentions, pas les exécutions. Il ne
> peut pas signaler une collision entre deux tâches dont il tient les horaires **annoncés** plutôt
> que les horaires **observés**.* Deux planificateurs qui vivent sur le même poste, et dont aucun ne
> connaît l'heure réelle de l'autre, produisent une collision que **ni l'un ni l'autre ne peut
> voir** — chacun n'a que sa propre fenêtre.

**Quoi faire.** Le collecteur peut le détecter seul et **pour rien** : il lit déjà `auth.log`
(section 6). Une rafale de sessions SSH encadrant la collecte, **hors** de celles qu'il a lui-même
ouvertes, est le signal.

```bash
grep "$(date -u '+%Y-%m-%dT%H')" /var/log/auth.log | grep -c "Accepted publickey"
```

**`aNePasFaire`** : ⚠️ **ne pas décaler l'un des deux audits sans mesurer d'abord** — on corrigerait
une collision observée **une fois**, sur des horaires dont on vient d'établir qu'ils dérivent.
*Décaler une heure déclarée pour éviter une collision réelle, c'est traiter le catalogue au lieu de
traiter la machine.* ⚠️ **Et ne pas en conclure que VPS-M56 est annulé** : le budget reste tenu
1 fois sur 9, et les sept autres dépassements ne s'expliquent pas par cette collision.

---

### VPS-M56 — Le budget de 90 s est dépassé 8 fois sur 9 ~~sans aucune cause extérieure~~

- **Domaine** : méthode · **Gravité** : 2 · **Statut** : `A_TRAITER` — **arbitrage humain requis, il n'est pas technique**
- **Vu : 2026-08-26** · **Mesure du jour** : **137 s pour un budget de 90 (+47 s, 1,5×)** — **14ᵉ depassement sur 14**, et **5 s de MOINS qu'hier** malgre +0,4 s de code ajoute. Discriminant : **audit 22,0 %** · `dockerd` **3,6 %** · **reste 32,0 %** · inactif **42,4 %**. La charge annoncee (0,45 → 1,57) est une **file d'attente**, pas une consommation. Candidat mesure : `iowait` **6,6 %**, c'est-a-dire le parcours de `/opt` (**46 s**, un tiers de la collecte). ⚠️ **La ligne « reste 32,0 % » est la plus grosse jamais publiee sur une machine calme, et elle n'est pas expliquee** : ce n'est pas un autre audit (`auth.log` ne montre qu'une session, la mienne). Elle rejoint les angles morts.
- **Vu** : 2026-08-22 · **Mesure du jour** : **125 s pour un budget de 90**, charge **0,33 → 1,43**. Discriminant : **audit 21,8 %** · `dockerd` **4,7 %** · **reste 34,1 %** · inactif **39,4 %**. Série des **10** passages : 224, 316, 186, 146, 175, 380, **71**, 141, 108, **125 s** — **le budget a été tenu une fois sur dix**.

> ### ✅ 2026-08-22 — CETTE FOIS L'ABSENCE DE CAUSE EXTÉRIEURE EST MESURÉE, PAS AFFIRMÉE
>
> Le 08-21, ce constat a été publié sous « aucune cause extérieure » **sans l'avoir cherchée**, et
> il y en avait une (VPS-M57). Le 08-22, la question a été posée à `auth.log` sur la fenêtre
> exacte de la collecte :
>
> ```
> awk '$1 >= "2026-08-22T02:23:36" && $1 <= "2026-08-22T02:25:41"' /var/log/auth.log | grep -c "Accepted"
> 1
> ```
>
> **Une seule session : la mienne.** Charge de départ **0,33**, `dockerd` à **4,7 %**, **39,4 %**
> d'inactivité restante. *La différence entre « il n'y avait personne » et « personne n'a été
> trouvé parce qu'on a regardé » est tout ce que ce constat a gagné en un jour — et c'est la seule
> chose qui le rend opposable.*
>
> La ligne « **reste 34,1 %** » est **plus grosse** qu'hier (30,9 %) sur une machine **plus
> calme** : elle ne peut donc pas être un autre audit. Le candidat que le collecteur mesure est
> `iowait` = **5,5 %**, c'est-à-dire le parcours de `/opt` (**38 s**, un tiers de la collecte,
> dont **12 s** perdues sur `/opt/maalem` abandonné pour la 8ᵉ fois).

> ### ⚠️ CORRIGÉ LE JOUR MÊME — LE SOUS-TITRE D'ORIGINE ÉTAIT FAUX
>
> Ce constat a d'abord été publié sous le titre *« et cette fois sans aucune cause extérieure »*.
> **Il y en avait une** : l'audit du centre d'alerte collectait **dans la même fenêtre**
> (VPS-M57). Je n'avais pas cherché de seconde collecte concurrente, et le discriminant la
> désignait pourtant — dans la ligne « reste 30,9 % » que je n'ai pas lue. *Le discriminant sépare
> l'audit du démon ; il ne sépare pas l'audit d'un **autre audit**, qui tombe alors dans « reste ».*
>
> **Ce qui tombe** : la phrase « aucune cause extérieure ce matin ».
> **Ce qui reste, et qui est le constat** : le budget est tenu **1 fois sur 9**, et les sept autres
> dépassements ne s'expliquent pas par cette collision.

**Quoi.** Les huit passages précédents avaient tous une cause externe à nommer — un build Docker,
ou VPS-016. Le 2026-08-21 en avait une aussi, mais d'un genre nouveau : **un autre dispositif
d'audit**. Ce qui ne change pas, c'est qu'un budget dépassé huit fois sur neuf ne borne plus rien.

Et le journal des passages montre que ce n'est pas un accident :

| Passage | 08-13 | 08-14 | 08-15 | 08-16 | 08-17 | 08-18 | 08-19 | 08-20 | **08-21** |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Durée (s) | 224 | 316 | 186 | 146 | 175 | 380 | **71** | 141 | **108** |

**Le budget a été tenu une fois sur neuf.**

**Où va le temps** (jalons `[t+Ns]` du collecteur) : section 3 **38 s** — dont **`/opt` : 35 s**,
soit un tiers de la collecte, **et 12 de ces 35 secondes sont dépensées sans rien rendre**
(`/opt/maalem` abandonné) ; section 4 **25 s** ; section 7 **12 s** ; tout le reste **33 s**.

**Pourquoi c'était invisible.** Parce qu'il y avait **toujours** un coupable disponible. Chaque
rapport nommait honnêtement la cause externe du jour et passait à autre chose — et le collecteur,
lui, faisait exactement ce qu'on lui demandait : il **attribuait**. *Un dépassement qui trouve une
excuse chaque nuit ne devient jamais un constat ; il faut une nuit sans excuse pour qu'il en
devienne un.*

**Quoi faire — et les trois réponses ont chacune un coût réel :**

1. **Alléger.** Le seul gisement est `/opt` (35 s). Le réduire, c'est perdre la mesure par
   sous-dossier qui **justifie VPS-018** et qui a permis, le 08-21, de chiffrer à 11,9 % ce qu'on
   croyait valoir 25 % (VPS-M55).
2. **Recalibrer.** Assumer que 90 s décrivait la machine du 2026-08-04, qui portait moins de code.
   Honnête — mais *un budget qu'on relève dès qu'il gêne ne borne plus rien.*
3. **Ne rien faire**, et continuer à publier chaque nuit un dépassement que personne ne lit.

**Recommandation de l'agent, non appliquée** : **recalibrer à 120 s ET borner `/opt` à 25 s** — ce
qui rend le budget tenable *et* garde une contrainte réelle sur le poste qui dérive.

**`aNePasFaire`** : ⚠️ **ne pas relever le délai de `/opt/maalem` de 12 à 20 s** pour « enfin le
mesurer » : ce serait **+8 s sur une collecte déjà hors budget**, pour un dossier de développement
sans enjeu de production. ⚠️ **Et ne pas relever le budget en silence** : un budget modifié sans que
le rapport le dise transforme un dépassement en conformité, sans que rien n'ait changé.

---

### VPS-M55 — Une attribution de coût écrite en dur, republiée chaque nuit, fausse d'un facteur 2

- **Domaine** : méthode · **Gravité** : 3 · **Statut** : ✅ `APPLIQUE` (2026-08-21)
- **Vu** : 2026-08-21 · **Mesure** : le collecteur affirmait **« ~25 % de ce parcours »** pour `/opt/vizyo-leads`. Valeur réelle du jour : **11,9 %** (4 170 ms sur 34 800) à froid, **10,5 %** à chaud. Le manifeste, lui, portait **14 %**.

**Quoi.** Le bloc `/opt` publiait chaque nuit, en texte figé :

> *« Le cout suit les INODES, pas les octets : au 2026-08-11, /opt/maalem (1,6 Go) coute ~1 s quand
> /opt/vizyo-leads (823 Mo, pile SUPPRIMEE) en coute ~6 — soit ~25 % de ce parcours pour du code
> qui ne tourne plus. »*

**Trois choses y étaient fausses ou périmées :**

1. **La part.** Datée du 2026-08-11, jamais recalculée. **11,9 % le 2026-08-21.**
2. **Le classement.** Elle présente maalem comme **bon marché** (~1 s) et vizyo-leads comme cher
   (~6 s). À froid c'est **l'inverse** : maalem dépasse les 12 s, vizyo-leads en coûte 4,2.
3. **Le régime de mesure.** Les deux durées de 2026-08-11 étaient des mesures **à chaud**,
   publiées comme des propriétés du dossier — VPS-M18, une fois de plus.

**Trois valeurs pour une même grandeur** — 25 % dans le script, 14 % dans le manifeste, 11,9 % dans
la mesure — et c'est celle du script qui s'imprimait chaque nuit dans la sortie que le rapport lit.

**Pourquoi c'était invisible.** Le chiffre était **plausible**, il servait un constat **juste**
(VPS-018 : ce dossier ne devrait pas être là), et il ne contredisait rien de visible. *Une
attribution fausse au service d'une conclusion vraie ne déclenche aucune alarme.*

**Correctif appliqué.** La part est désormais **dérivée** de la mesure du passage : le coût de
chaque enfant est cumulé (`OPT_MS_TOT`), celui de `vizyo-leads` retenu (`OPT_MS_LEADS`), et la part
calculée en `awk`. **Vérifié sur la machine :**

```
/opt/vizyo-leads (823 Mo, pile SUPPRIMEE le 2026-08-04) : 0.4 s sur 4.0 s
= 10.5 % de ce parcours pour du code qui ne tourne plus (VPS-018).
```

Deux gardes ajoutés : si `vizyo-leads` **n'est pas mesuré**, le bloc dit **« NON MESURE — aucune
part ne peut en être dérivée »** au lieu d'afficher 0 % (VPS-M02) ; et il rappelle qu'**une part
froide et une part chaude ne se comparent pas**.

> **La leçon, et c'est la troisième fois dans ce fichier** : *une attribution dérivée de la mesure
> survit au changement de situation ; une attribution écrite en dur devient fausse sans que rien ne
> le signale.* C'est **VPS-M47** (le verdict de charge qui nommait une cause disparue) au même
> fichier, à un autre endroit. **Corriger un défaut ne corrige pas ses jumeaux** — VPS-M22, 6ᵉ fois.

**`aNePasFaire`** : ⚠️ **ne pas comparer la part d'un passage à l'autre sans regarder les durées** :
elle se déplace quand c'est le **dénominateur** qui change, pas `vizyo-leads`.

---

### VPS-M54 — L'audit travaille dans un dépôt partagé dont la branche change sous lui, et il ne le voit pas

- **Domaine** : méthode · **Gravité** : 2 · **Statut** : `ACCEPTE` (compris, contourné le 2026-08-20)
- **Vu** : 2026-08-20 · **Coût** : **une heure** passée à traquer un défaut qui n'existait pas, et un `git checkout --` qui a écrasé un fichier dans l'arbre d'une autre session.

**Quoi.** Pendant la passe du 2026-08-20, le dépôt est passé de `perf/garde-fou-tests-et-workers`
à `fix/trk-033-admin-vps-charge-de-fond`, puis à `fix/trk-031-episodes-gps-bornes` — trois branches
en quelques heures, par d'autres sessions travaillant dans le **même arbre de travail**.

**Ce que ça a produit, dans l'ordre :**

| Geste | Conséquence |
|---|---|
| `git checkout -- docs/vps-audit/collecte.sh` | a restauré la version de **l'autre branche** (2 255 lignes) et non la mienne (2 714) |
| trois exécutions du collecteur | ont fait tourner **le script de quelqu'un d'autre** sur la production |
| diagnostic d'un `RPC_CACHE: unbound variable` | réel dans **leur** version, **inexistant dans la mienne** — `RPC_CACHE=''` y est ligne 1264 depuis le correctif VPS-M43 du 08-18 |
| une heure d'enquête | pour un défaut que je n'avais pas, sur un fichier qui n'était pas le mien |

**Et c'est ce qui explique le « mystère » que l'enquête n'arrivait pas à résoudre** : la collecte
de **02 h 37 réussissait** et celle de **10 h 12 mourait**, avec ce que je croyais être le même
script. *Ce n'était pas le même script.* J'ai cherché une cause côté machine pendant que la cause
était côté dépôt.

**Pourquoi c'était invisible.** L'audit lit des chemins (`docs/vps-audit/collecte.sh`), jamais un
**état de dépôt**. Rien dans la procédure ne demande sur quelle branche on se trouve **avant** de
lire un fichier — la seule vérification de branche existante est au moment de **committer** (§8
bis), c'est-à-dire tout à la fin. *Un chemin est stable ; ce qu'il contient ne l'est pas.*

> **La règle, transposable à tout agent travaillant dans un dépôt partagé** : *un fichier lu dans
> un arbre de travail partagé n'est pas une donnée stable — c'est un instantané dont un tiers
> détient le contrôle.* La branche doit être relevée **au début**, avec les chiffres, et non
> seulement au moment du commit.

**Quoi faire — appliqué ce passage.** Le travail s'est poursuivi dans un **worktree dédié**
(`git worktree add`), hors du dépôt partagé : la branche y est stable, l'autre session n'est pas
gênée, et le worktree est retiré à la fin.

**`aNePasFaire`** : ⚠️ **ne jamais faire `git checkout <branche>` dans l'arbre partagé** pour
récupérer sa branche — cela arrache l'arbre de travail à la session qui l'occupe, au milieu de son
travail. ⚠️ **Et se méfier de `git checkout -- <fichier>`** : il restaure depuis le HEAD *courant*,
qui n'est pas forcément celui qu'on croit. Ici il a détruit l'état d'un fichier dans l'arbre d'une
autre session — sans que rien ne le signale.

⚠️ **Ce qui n'est pas prouvé** : que ce `git checkout --` n'ait pas emporté des modifications non
commitées de l'autre session sur ce fichier. Leur travail portait sur l'écran Angular, donc c'est
peu probable — **mais ce n'est pas démontrable après coup**, et c'est le vrai coût du geste.

---

### VPS-M53 — Le collecteur appelait `docker system df` six fois, à six instants différents

- **Domaine** : méthode · **Gravité** : 3 · **Statut** : ✅ `APPLIQUE` (2026-08-20)
- **Vu** : 2026-08-20 · **Mesure** : six appels (section 4, section 10, levier 1), à **~2 s pièce** sur machine saine — mesure de six appels consécutifs : **1,96 / 1,85 / 4,26 / 2,22 / 1,76 / 1,92 s**, et **3,05 s** après 30 s d'inactivité.

**Quoi.** `docker system df` était invoqué **six fois** pour une valeur qui ne change pas pendant
une collecte : une fois pour la table de la section 4, trois fois dans la section 10 (dont deux
sous-shells imbriqués pour `Active` et `TotalCount`), et deux fois au levier 1.

**Le gain de temps est le moindre des deux.** Les six appels avaient lieu à des **instants
différents** — section 4 vers **t+50 s**, section 10 vers **t+110 s**, levier 1 vers **t+131 s**.
Le 2026-08-14, le total est passé de **18,92 à 13,38 puis 17,35 et 16,57 Go à l'intérieur d'une
même collecte**, et le rapport ne pouvait pas dire laquelle était « la » mesure.

**Quoi faire — FAIT.** Une **capture unique** en tête de section 4, horodatée et affichée, relue
par les sections 10 et 12. Six appels → **deux** (le tableau texte et la forme `--format`).
Toutes les sections décrivent désormais **le même instant**.

**Vérifié sur la machine, script entier** : `RC=0`, `FIN DE COLLECTE`, 6 bases, 14 sections,
`stderr` vide, les trois consommateurs servis, `✅ 6 / 6 bases PostgreSQL examinees`.

**`pourquoiInvisible`.** Chaque appel était **local et justifié** : celui de la section 4 affiche
la table, ceux de la section 10 remplissent une ligne, ceux du levier 1 alimentent un verdict.
*Aucun n'est faux ; c'est leur SOMME qui l'est, et personne ne lit un script en comptant les
invocations d'une même commande.* Il a fallu chercher un chiffre — les 16 s — pour les voir.

**`aNePasFaire`** : ⚠️ **ne pas revendiquer un gain de durée sur la foi de cette passe** (VPS-M18) :
la machine portait un build et une charge de 2,34 au départ. Le gain structurel est de **~8 s**
(4 appels × ~2 s) ; **la cohérence, elle, est acquise et ne dépend d'aucune mesure de temps.**
⚠️ **Et le « 16,02 s » qui a lancé cette enquête était FAUX** : un échantillon unique, publié comme
une propriété. Six appels consécutifs donnent ~2 s. *C'est VPS-M52 deux heures plus tard, sur un
chiffre au lieu d'une recommandation — un nombre mesuré une seule fois n'est pas une mesure.*

---

### VPS-M52 — J'ai recommandé trois fois un réglage qui n'existe pas, sans jamais l'essayer

- **Domaine** : méthode · **Gravité** : 2 · **Statut** : ✅ `APPLIQUE` (mesuré et rétracté le 2026-08-20)
- **Vu** : 2026-08-20 · **Coût** : la recommandation figurait **trois fois** dans le rapport publié, comme *« la bonne réponse »* et *« ce qui fermerait la classe »*. Elle a été demandée à l'exécution — et il a suffi de deux mesures pour montrer qu'elle ne fait **rien**.

**Quoi.** Le rapport du 2026-08-20 concluait, à trois reprises : *« la bonne réponse serait côté
machine — un `DOCKER_CLIENT_TIMEOUT` global »*. **Cette variable n'est pas lue par ce client
Docker.**

| Méthode | Résultat |
|---|---|
| `strings $(command -v docker) \| grep -c '^DOCKER_CLIENT_TIMEOUT$'` | **0** — la chaîne n'est pas dans le binaire |
| `DOCKER_CLIENT_TIMEOUT=1 docker system df` | **16,02 s, rc=0, aucune erreur** — la variable est ignorée |

Client **Docker 29.1.3 (Go)**. `DOCKER_CLIENT_TIMEOUT` vient de **`docker-py` et de
`docker-compose` v1**, tous deux en Python ; le CLI Go ne l'a jamais implémentée. *Deux méthodes
indépendantes, comme la procédure l'exige pour un constat — sauf que je ne les avais appliquées ni
l'une ni l'autre avant de l'écrire.*

**Pourquoi c'était invisible — et c'est le pire mode d'échec du dispositif.** Une recommandation
n'est pas une mesure : **rien dans l'audit ne vérifie les propositions qu'il émet.** Les constats
portent une commande de vérification ; les *pistes* n'en portent aucune. Celle-ci était plausible
(le nom est bien formé, la variable a réellement existé), écrite en position de conclusion, et
répétée — la répétition lui a donné du poids sans lui donner de preuve.

⚠️ **Ce que ça aurait coûté si elle avait été appliquée sans être mesurée** : un `export
DOCKER_CLIENT_TIMEOUT=30` dans `/etc/environment`, un rapport annonçant « la classe est fermée »,
et **aucune protection**. C'est exactement **VPS-M06** (*fail2ban tournait, s'annonçait actif, et
ne surveillait rien*) et **VPS-M21** (*un défaut qui rassure n'a pas de plaignant*), appliqués
cette fois non pas à une garde existante mais à une garde **qu'on venait de poser**.

> **La règle, et elle vaut pour tout plan d'action** : *un constat doit prouver ce qu'il affirme ;
> une **recommandation** doit prouver que son mécanisme **existe**.* Le coût de la vérification
> était de deux commandes en lecture seule. Le coût de l'omission aurait été une fausse sécurité
> permanente.

**Quoi faire — et il n'y a pas d'équivalent global.** Docker n'offre **aucun** réglage côté client
qui borne la durée d'une commande, et rien côté démon qui borne un client lent. Ce qui existe
réellement, et qui est en place :

| Levier | État | Portée |
|---|---|---|
| `timeout N docker …` par appel | ✅ posé dans les 2 procédures d'audit qui parlent à Docker | les dispositifs planifiés |
| Détecteur de clients bloqués (section 4 du collecteur) | ✅ posé le 2026-08-20 (VPS-M49) | **détecte**, ne prévient pas |
| `curl --max-time` dans `send-report-mail.sh` | ✅ posé le 2026-08-20 | le seul appel réseau non borné trouvé |

**`aNePasFaire`** — ⚠️ **ne pas fabriquer un « global » en enveloppant `docker` dans une fonction
shell qui appelle `timeout`.** Ça paraît séduisant et c'est dangereux : `docker compose up --build`
dure **jusqu'à 27 minutes** sur cette machine (mesuré le 2026-08-19), et son processus s'appelle
aussi `docker`. Un plafond global couperait les déploiements. ⚠️ **Et ne pas poser de cron
« tueur de clients »** : la procédure d'audit interdit explicitement d'installer un cron, un timer
ou un agent sur le VPS, et un tueur qui se trompe de cible coûte plus cher que le défaut.

**Mesure recueillie au passage, et elle vaut d'être notée** : `docker system df` a pris
**16,02 secondes** — sur une machine saine, sans boucle. Le collecteur l'appelle à chaque passage.

---

### VPS-M51 — La remédiation écrite le 08-18 supposait un parent mort, et personne ne pouvait le voir

- **Domaine** : méthode · **Gravité** : 2 · **Statut** : ✅ `APPLIQUE` (2026-08-20, vérifié par l'exécution)
- **Vu** : 2026-08-20 · **Coût** : une remédiation exécutée **pour rien** sur une machine qui perdait un cœur, et **5 min 19 de boucle en plus** entre les deux `kill`.

**Quoi.** La fiche VPS-016 écrivait, depuis la 3e occurrence : *« la remédiation est `kill <pid>`
sur ces clients — 2 secondes, aucune coupure »*. Exécutée le 2026-08-20 à 05 h 02 min 55, elle a
tué sa cible **et n'a rien changé** : `dockerd` est resté à 100,3 %, avec 1 359 294 `read()`/s.

**La cause.** Le `bash -c` parent contenait **deux** `docker logs`, le second dans une substitution
de commande. En tuant le premier, `bash` a exécuté le suivant — le remplaçant est né à
**05 h 02 min 55, la seconde exacte du `kill`**. *La boucle n'a pas été interrompue : elle a été
transmise.*

| | 3e occurrence (08-18) | 4e occurrence (08-20) |
|---|---|---|
| Parent du client | **mort** (adopté par init) | **vivant** |
| Tuer la feuille suffit ? | **oui** — rien ne peut relancer | **non** — le parent enchaîne |
| Bonne cible | le client | **le `bash -c` parent, en premier** |

**Pourquoi c'était invisible.** Le 08-18 les deux parents étaient morts. **Rien, ce jour-là, ne
distinguait « tuer le client » de « tuer ce qui tient le client »** — les deux formulations
décrivaient la même action et donnaient le même résultat. Une remédiation validée sur un cas où
deux hypothèses coïncident ne dit pas laquelle elle a vérifiée.

> **La leçon, et c'est VPS-M49 d'un cran plus loin** : *le 08-18 a produit un **détecteur** et une
> **remédiation**, tous deux calibrés sur un parent mort. On a corrigé le détecteur ce matin
> (VPS-M49) — sans regarder la remédiation, qui souffrait du même défaut, pour la même raison, et
> **dans le même paragraphe**.* **Corriger un défaut ne corrige pas ses voisins, même quand ils
> partagent sa cause.** C'est VPS-M22 pour la cinquième fois, et la plus courte distance jamais
> observée entre le défaut corrigé et son jumeau manqué : trois lignes de la même fiche.

**Quoi faire — FAIT.** La fiche VPS-016 porte désormais une remédiation en **quatre étapes**, dont
la troisième est *« parent vivant → `kill` LE PARENT D'ABORD »*, et le collecteur affiche déjà la
chaîne de parents complète (correctif VPS-M49 du matin, qui sert ici une seconde fois).

**`aNePasFaire`** : ⚠️ ne pas `kill -9` d'emblée — un `SIGTERM` a suffi sur les quatre processus.
⚠️ Et ne pas conclure « il faut toujours tuer la session SSH » : c'est plus large que nécessaire,
et le canal peut appartenir à quelqu'un qui travaille. Le `bash -c` est la bonne granularité.

**Vérification** : `dockerd` 99,7 % → **1,4 %**, `read()` 1 326 127/s → **3**, 33/33 conteneurs,
0 anomalie, PID du démon inchangé, quatre points publics en 97 · 39 · 158 · 75 ms.

---

### VPS-M49 — Le détecteur de clients Docker exigeait un parent MORT, et la 4e occurrence a un parent VIVANT

- **Domaine** : méthode · **Gravité** : 1 · **Statut** : ✅ `APPLIQUE` (2026-08-20, le jour même)
- **Vu** : 2026-08-20 · **Coût** : le bloc écrit le 08-18 **pour trouver exactement ça** a publié « ✅ aucun client docker orphelin » sur une machine dont un cœur brûlait depuis une heure — **avec le coupable dans son propre dénominateur**.

**Quoi.** Le détecteur posé le 2026-08-18 (VPS-M45) listait les processus `docker` et ne signalait
que ceux dont le **PPID vaut 1**. Ce matin, la chaîne du client fautif est **entièrement vivante** :

```
43987  docker logs tracky-postgres --tail 200000   Sl  futex_wait_queue  TIME 00:00:00
43986  bash -c "docker logs … | grep … | tail -20"
43921  sshd: root@notty                            canal SSH encore ESTABLISHED
```

Le tube n'est pas cassé, le shell n'est pas mort, **personne n'est orphelin** — et `dockerd` brûle
101,7 % d'un cœur.

**Pourquoi c'était invisible.** *« Parent mort » était la **forme** qu'avait prise la 3e occurrence,
pas la **condition** du défaut.* Le bloc a été écrit le jour où la cause a été trouvée, en codant
ce qu'on venait de voir — deux clients adoptés par init — plutôt que le phénomène : *un client qui
ne draine plus ce que le démon lui pousse*. Un détecteur écrit à partir d'un seul cas encode ce cas.

⚠️ **Et il a été validé sur quatre branches synthétiques le 08-18**, dont une nommée « un client
légitime au parent vivant » — mais ce cas-là était construit comme **sain**, pas comme bloqué. *Une
branche de test ne vérifie que la question qu'on a pensé à poser.*

**Quoi faire — FAIT le jour même.** Le discriminant devient l'**âge** : un client `docker` en ligne
de commande rend la main en moins d'une seconde ; au-delà de **60 s**, il est bloqué, que son parent
respire ou non. Tous les clients sont listés, avec âge, **CPU consommé** et `wchan` ; le PPID reste
affiché — c'est une information utile — mais il n'est plus un **filtre**.

**Vérifié sur la machine, sur le cas RÉEL** (leçon VPS-M43/M40, le montage et non les branches) :

```
🔴 BLOQUE   pid 43987    age  4811s  cpu 00:00:00  ppid=43986    docker logs tracky-postgres --tail 200000
             bloque dans : futex_wait_queue
```

**`aNePasFaire`** : ne pas s'accuser soi-même. La collecte lance ses propres clients Docker ; le
bloc remonte la chaîne des parents et écarte tout ce qui descend de `$$`. Sans ce garde, il se
dénoncerait à chaque passage un peu lent — et un détecteur qui crie au loup sur lui-même finit
ignoré (VPS-M17).

**Portée, écrite dans le code pour ne pas la repayer** : ce bloc ne voit que les processus dont le
**nom** est exactement `docker`. Un `curl` sur `/run/docker.sock`, un SDK dans un conteneur ou un
outil de supervision resteraient invisibles. *Les trois clients identifiés à ce jour sont des
`docker logs` ; ça ne prouve rien sur le quatrième.*

---

### VPS-M50 — Le catalogue n'a aucune notion de « nouveau », et le journal de l'hyperviseur n'affichait que sa routine

- **Domaine** : méthode · **Gravité** : 2 · **Statut** : ✅ `APPLIQUE` (2026-08-20)
- **Vu** : 2026-08-20 · **Coût** : **deux passages de suite**, le même fichier trouvé **à la main**, et une provenance fausse publiée au référentiel (VPS-029).

**Quoi — deux défauts d'un même angle mort.**

**1. Le catalogue `ordonnancement` ne sait pas dire « nouveau ».** Le 08-19,
`/etc/cron.d/docker-builder-prune` était apparu la veille : trouvé en relisant la section 7 à la
main. Le 08-20, **le même fichier avait été réécrit** — filtre supprimé, horaire déplacé : trouvé à
la main, encore. *Deux versions d'un même fichier se ressemblent dans une liste de quatre qu'on
relit chaque matin. Une date, non.*

**2. « Les 3 dernières lignes de commande » de l'hyperviseur ne montraient que la routine.** La
sonde horaire et le `ps` horaire représentent ~98 % du journal `qemu-ga` : les trois dernières
lignes étaient donc, presque toujours, trois lignes de routine. **Les commandes qui écrivent
étaient noyées et ne remontaient jamais.** C'est ainsi que la provenance de VPS-029 est restée
invisible **alors que la donnée était lue à chaque passage** — le défaut n'était pas dans la
collecte, il était dans le **découpage** de ce qu'elle affiche.

**Quoi faire — FAIT.**
- Date de dernière modification de chaque fichier de `/etc/cron.d` et de chaque unité
  `.timer`/`.service`, avec signalement de celles de moins de 2 jours. **Vérifié sur la machine :**
  `🆕 2026-08-19 11:02 (modifie il y a 0 j) /etc/cron.d/docker-builder-prune`.
- Extraction et publication des commandes `guest-exec` **hors sonde horaire**, les 12 dernières.

### ⚠️ Et mon correctif portait le défaut qu'il corrige — l'exécution réelle l'a montré

La première version titrait **« commandes NON ROUTINIÈRES »** et en comptait **39**. Sur ces 39,
**28 sont le lot TRIM de l'hébergeur, qui tourne tous les jours** — c'est-à-dire la définition même
de la routine. **C'est VPS-M01 / VPS-M46 / VPS-027 pour la quatrième fois**, et cette fois *dans le
correctif écrit pour appliquer cette leçon* : un compteur doit prouver qu'il compte ce qu'il prétend
compter.

Corrigé en publiant **deux dénominateurs côte à côte**, jamais l'un sans l'autre :

```
hors sonde : 39  |  dont lot TRIM quotidien (connu, VPS-027) : 28  |  INATTENDUES : 11
```

**`aNePasFaire`** : ⚠️ **ne pas masquer le lot TRIM**. Il est compté à part et son existence
affichée. *Filtrer un bruit connu, c'est perdre la capacité de voir qu'il a changé* — et c'est
précisément en ne le regardant qu'une fois qu'on avait cru ce lot ponctuel alors qu'il est quotidien.

**Portée, écrite dans le code** : ceci date le **fichier**, pas la règle. Un cron créé **puis
retiré** entre deux passages ne laisse toujours aucune trace. C'est une réduction de l'angle mort,
pas sa fermeture.

### ⚠️ Le piège des accents graves, tendu pour la TROISIÈME fois dans ce fichier

Le bloc a d'abord été écrit avec `` `ordonnancement` `` dans un `echo` en guillemets **doubles** —
donc une **substitution de commande** : le collecteur aurait exécuté `ordonnancement` pour afficher
une phrase. Le même piège est documenté deux fois plus haut (`docker stats` le 08-08, `kill <pid>`
le 08-18). Attrapé à la relecture, avant exécution.

> *Ce n'est plus de l'inattention : le réflexe « accent grave = citation » vient du Markdown, et ce
> fichier est du shell.* La note est désormais écrite **à l'endroit du troisième piège**, pas
> seulement des deux premiers.

---

### VPS-M48 — La fenêtre d'observation glissait avec l'incident, et l'audit a pris le régime de panne pour la normale

- **Domaine** : méthode · **Gravité** : 2 · **Statut** : ✅ `APPLIQUE` (2026-08-19)
- **Vu** : 2026-08-19 · **Coût** : **cinq passages** (08-13 → 08-17) ont décrit comme état normal une machine amputée de **~45 points d'inactivité**, et le plan d'action a classé le correctif au 4e rang pendant huit passages.

**Quoi.** La section 9 lisait l'historique `sysstat` par `for i in $(seq 7 -1 1)`. Deux effets que
personne n'avait regardés, parce qu'ils ne produisent **aucune anomalie visible** :

1. le **jour en cours** n'était jamais lu (`i` s'arrête à 1) ;
2. la fenêtre était figée à **7 jours** alors que `/var/log/sysstat` en gardait **9**.

Et la colonne qui aurait tout dit — **`%idle`** — n'était pas publiée : la section affichait
`%user`, `%system`, `%iowait`, `%steal`, jamais l'inactivité.

En lisant les neuf journées et en publiant `idle%` :

| Jour | idle % | Ce que c'est |
|---|---:|---|
| **08-11** | **77,66** | ⬅️ **la machine saine.** VPS-016 démarre ce soir-là à 21 h 01 |
| 08-12 → 08-16 | 34,45 · 37,13 · 37,31 · 38,82 · 38,23 | **la boucle en régime permanent** |
| 08-17 | 19,54 | boucle + second client (09 h 17) |
| 08-18 | 66,05 | `kill` à 05 h 47 — journée à cheval |
| **08-19** | **84,02** | ⬅️ **la machine saine, à nouveau** |

**~38 % n'a jamais été la normale de cette machine.** Sa normale est **~78–84 %**.

**Pourquoi c'était invisible, et ce n'est pas une inattention.** *Un incident qui dure plus
longtemps que la fenêtre d'observation efface sa propre référence.* La boucle a duré 152 h ; la
fenêtre en couvrait 168 — mais elle **glissait d'un jour chaque jour**. Dès le 08-18, `sa11`
était sortie de la fenêtre **lue** alors qu'elle était encore sur le **disque**. Rien ne signale
cette perte : le tableau reste plein, les chiffres restent cohérents **entre eux**, et ils sont
tous faux *par rapport à quoi*.

**Le coût réel n'est pas la description, c'est le classement.** `systemctl restart docker` est
resté au 4e rang huit passages durant, derrière trois gestes à risque nul, avec pour argument
*« ça ne coûte rien à la production »*. Il coûtait **la moitié du processeur**, en continu. Les
latences publiques, seul indicateur consulté, n'ont bougé qu'au **15e jour** — parce qu'il
restait de la marge.

> **La leçon, et elle dépasse `sysstat`** : *un indicateur de bout-en-bout ne détecte pas une
> perte de capacité tant qu'il reste de la marge ; il ne bascule qu'une fois la marge consommée.*
> Surveiller la disponibilité ne remplace pas mesurer la capacité.

**Quoi faire — FAIT.** Le collecteur lit **tous** les `sa??` présents, jour en cours compris,
**triés par date d'écriture** (`ls -tr` — immunisé au changement de mois, où `sa28` peut venir du
mois précédent), avec la date **dérivée de l'en-tête `sar`** et non du nom de fichier, la colonne
`idle%`, le **compte de journées affiché** et l'avertissement en clair. Le titre de la section,
qui annonçait *« 7 JOURS »*, a été corrigé — il contredisait son propre contenu.

**`pourquoiInvisible`** : la fenêtre bougeait à la même vitesse que l'incident, donc l'écart
n'apparaissait jamais dans le tableau. Une référence perdue ne laisse pas de trou : elle laisse
une ligne plausible.

**`aNePasFaire`** : ne pas dériver la date du **nom** du fichier (`sa14` peut être le 14 du mois
dernier), et ne pas trier les fichiers par ordre **lexical** — un passage du 31 au 1er
replacerait le mois précédent en tête sans rien signaler.

---

### VPS-M47 — Le verdict de charge nommait une cause disparue, dans une ligne verte

- **Domaine** : méthode · **Gravité** : 3 · **Statut** : ✅ `APPLIQUE` (2026-08-19)
- **Vu** : 2026-08-19

**Quoi.** Le bloc BUDGET a publié, en ligne **✅**, sur la collecte de 02 h 21 :

```
✅ LA CHARGE ANNONCEE EST UNE FILE D ATTENTE, PAS UNE CONSOMMATION.
   [...] Les processus s empilent en sommeil ININTERRUPTIBLE sur le
   socket d un demon en boucle (VPS-016) [...]
```

**VPS-016 était clos depuis 20 heures**, et le même bloc mesurait `dockerd` à **5,7 %** trois
lignes plus haut. **Le chiffre était juste ; l'explication désignait un phénomène disparu.**

**La cause.** L'attribution était **écrite en dur dans le texte de la branche**, alors que la
mesure qui l'aurait contredite (`pdock`) était déjà calculée et déjà affichée. Une explication
figée survit indéfiniment à son objet.

**`pourquoiInvisible`** : elle vivait dans une ligne **✅**. VPS-M21 le dit — *un défaut qui
rassure n'a pas de plaignant*. Une explication fausse accolée à un chiffre juste, dans une ligne
verte, ne rencontre aucun contradicteur.

> **La règle** : *une attribution se dérive de la mesure de la même fenêtre, ou ne s'écrit pas.*

**Quoi faire — FAIT.** Trois branches dérivées de la mesure : `pdock ≥ 25` nomme `dockerd` **en
citant sa part** ; `pdock < 25` **refuse de nommer** et ne propose `iowait` comme candidat que
s'il dépasse **5 %** ; `pdock` non mesurable dit qu'il ne peut **ni accuser ni disculper**.

**`aNePasFaire`** : ne pas remplacer une attribution en dur par une autre attribution en dur.
La première écriture du correctif proposait `iowait` **systématiquement** — et sur la passe
d'essai `iowait` valait **0,4 %** : une piste que la ligne suivante démentait. *Un candidat
qu'on ne mesure pas est le défaut qu'on vient de corriger, sous un autre nom.*

---

### VPS-M46 — Mon détecteur de secrets comptait les URL, et il a produit un constat de gravité 1

- **Vu** : 2026-08-18 · **Statut** : `APPLIQUE` (constat corrigé **avant toute action** ; le motif ne vit que dans les vérifications en marge, pas dans `collecte.sh`)

**Quoi.** Le tri des porteurs de secrets de `/opt` reposait sur un motif contenant `_URL` et un
seuil de 12 caractères. Conséquence : **`APP_URL=https://app-tracky.vizyoagency.com` est compté
comme une ligne sensible.** Sur les **20** « valeurs identiques » qui ont fondé **VPS-028** en
gravité 1, **19 étaient de la configuration** — noms de domaine, URL publiques, nom de réseau
Docker, chemin de stockage, nom de base, adresse d'expéditeur. La vingtième, un secret JWT, était
une valeur de **développement**, la production en utilisant une autre.

**Ce que ça a failli coûter.** Le constat recommandait une **rotation** des secrets de `vizyo-auth`,
c'est-à-dire de l'authentification de **toutes** les applications, un mardi à 08 h 45. Elle aurait
déconnecté tous les utilisateurs — **pour remplacer des noms de domaine par d'autres noms de
domaine**.

**Ce qui l'a rattrapé.** Avant de tourner quoi que ce soit, les clés ont été **listées par leur
nom**. Elles se lisent en trois secondes et elles disent tout : `APP_DOMAIN`, `LP_DOMAIN`,
`TRAEFIK_NETWORK`, `RESEND_FROM_EMAIL`… La mesure décisive a ensuite été prise **deux fois** — dans
le fichier **et** dans l'environnement du conteneur en service — parce qu'un fichier sur disque ne
prouve pas ce qu'un processus utilise.

**Pourquoi c'était invisible.** Le motif a été écrit **pour trouver**, pas pour **compter**. Comme
critère de *recherche* il est bon : large, il ne rate rien. Comme critère de *dénombrement* il est
faux — et c'est en dénombrant (« 23 lignes sensibles », « 25 lignes ») que le constat a pris sa
gravité. **Le même motif a servi aux deux usages sans être requalifié entre les deux.**

> **C'est VPS-M01 à quatorze jours d'écart, sur le même mode d'échec** : *un compteur d'incidents
> doit prouver qu'il compte des **incidents**.* Le premier passage avait désigné une IP
> d'administration comme « principale attaquante » parce que le motif `from <IP>` capturait aussi
> les connexions **réussies**. Ici le motif capture aussi les **URL**.

**Quoi faire.** Le motif n'entre **pas** dans `collecte.sh` — il ne vit que dans les vérifications
en marge, et le « corriger » dans un fichier qui ne le contient pas ne servirait à rien. La règle,
elle, entre au référentiel : *avant de publier un dénombrement, afficher les **noms** de ce qui est
compté sur un échantillon.* Trois lignes de sortie auraient suffi à voir `APP_DOMAIN` dans la liste.

### ⚠️⚠️ Le SECOND défaut du même détecteur, trouvé une heure plus tard

Après la première correction, une ligne survivait : un JWT de développement de 13 caractères,
présenté comme *« le seul vrai secret »*. La rotation en a été demandée. **Le `git diff` de ma
propre modification a affiché l'ancienne valeur : `dev_change_me`.**

Mon détecteur de marqueurs cherchait `changeme|CHANGEME|your[-_]|YOUR[-_]|xxxx|XXXX|<[a-z]+>|
example\.com|placeholder|dummy|fake`. **La chaîne s'écrit `change_me`, avec un tiret bas.** Un
caractère a suffi pour promouvoir un marqueur au rang de secret — et pour justifier une rotation.

> **Le motif de recherche était trop large et le motif de MARQUEUR trop étroit : les deux erreurs
> poussent dans le même sens**, celui du faux positif. Un détecteur à deux motifs doit être éprouvé
> sur les deux, et sur des cas où l'on connaît la réponse. `dev_change_me` en était un.

### ⚠️ Et le correctif proposé aurait DÉSARMÉ une garde existante

Le dépôt contient déjà, dans `env.validation.ts`, une liste `weakSecrets` qui **refuse le démarrage
en production** si le secret contient `dev_change_me`, `change_me` ou `secret`. Vérifié :

```
🛑 REFUSE en prod    dev_change_me                         (le marqueur actuel)
✅ accepte en prod   <generer: openssl rand -base64 32>    (ce que j allais commiter)
```

Le remplacement aurait donc **fait passer** en production une valeur que le code rejetait, **et**
introduit un vrai secret dans un fichier suivi par git. Branche supprimée, rien poussé.

> **La règle** : *un « correctif » de sécurité doit prouver qu'il laisse le système **au moins aussi
> protégé** qu'il l'a trouvé.* C'est le symétrique de VPS-M31 : un garde-fou qui cache un défaut est
> dangereux — **un correctif qui retire un garde-fou l'est davantage**, parce qu'il se présente
> comme un progrès.

**À ne pas faire** : durcir le motif jusqu'à ne plus rien trouver. Un critère de recherche doit
rester large — c'est le **dénombrement** qui doit être qualifié, pas la recherche. Et **ne jamais
proposer une rotation sans avoir lu la valeur en place** : trois secondes de `git diff` ont réfuté
ce que deux heures de mesure indirecte avaient construit.

---

### VPS-M45 — Le collecteur n'a jamais regardé les CLIENTS de Docker, et la cause y était depuis treize jours

- **Vu** : 2026-08-18 · **Statut** : `APPLIQUE` (bloc posé dans `collecte.sh` le jour même)

**Quoi.** VPS-016 a coûté **152 heures à 1 à 1,7 cœur** sur une machine qui en a deux. Sa cause
tenait dans deux processus, et la commande qui les trouve est un `pgrep` :

```bash
pgrep -x docker            # puis, pour chacun : son PPID vaut-il 1 ?
```

Le collecteur mesure `dockerd` sous tous les angles depuis le 2026-08-06 (VPS-M14) — CPU instantané,
cumul/uptime, `read()` contre octets ramenés, `wchan`, threads, descripteurs. **Il n'a jamais compté
les processus qui lui PARLENT.** Treize passages ont ausculté le serveur ; aucun n'a regardé les
clients.

### ⚠️ Et la règle qui désignait exactement ce défaut était écrite le 2026-08-05

**VPS-M12** : *« une commande envoyée à un démon ne doit pas être interrompue en cours de route — le
client meurt, le travail côté serveur, non. »* Écrite pour un `docker system df -v` interrompu par
l'agent lui-même, classée `APPLIQUE`, et jamais transposée : la fiche disait de **ne pas créer** de
clients orphelins, jamais de **vérifier s'il en existe**.

C'est **VPS-M22 pour la quatrième fois** — *écrire qu'un piège existe ne le désarme pas sur les
autres objets* — et c'est la plus chère des quatre : VPS-M38 coûtait une accusation fausse, VPS-M44
un faux négatif rattrapé le jour même, celle-ci **152 heures de moitié de machine**.

> **La leçon, plus large que Docker** : *quand on instrumente un service qui va mal, on mesure le
> service. Ses **clients** sont hors du champ par construction — ils ne sont ni dans son journal, ni
> dans ses métriques, ni dans son `status`.* Or un serveur qui brûle un cœur **sans qu'aucune de ses
> tâches internes ne tourne** est, presque par définition, en train de servir quelqu'un qui n'écoute
> plus.

**Quoi faire — et c'est fait.** Un bloc en section 4 liste les clients `docker` dont le **PPID vaut
1** (shell parent mort), avec leur âge et leur ligne de commande, et affiche son **dénominateur**
dans tous les cas. **Aucun appel à Docker** : on ne diagnostique pas un démon malade en lui parlant.
Coût : un `pgrep` et une lecture de `/proc` par client trouvé (0 ou 1 en temps normal).

**Quatre branches synthétiques essayées** — aucun client · un client **légitime** au parent vivant ·
les deux orphelins réels du jour · un mélange des deux. Le détecteur trie correctement.

### ⚠️⚠️ Et les quatre branches ont TOUTES manqué un défaut du bloc — l'exécution réelle l'a vu

Première écriture du dénominateur : `pgrep -xc docker 2>/dev/null || echo 0`.
**`pgrep -c` écrit « 0 » sur `stdout` ET sort en statut 1 quand il ne compte rien** : le `|| echo 0`
ajoutait une *seconde* ligne, et la sortie affichait `(denominateur : 0` puis `0 processus…)`.

**C'est VPS-M33 mot pour mot** — le même piège avec `grep -c`, corrigé le 2026-08-13, re-tendu cinq
jours plus tard sur `pgrep -c`. Les quatre branches ne pouvaient pas le voir : elles **bouchonnaient
`pgrep`**, donc ne reproduisaient pas son **statut de sortie**. Seule l'exécution du bloc **sur la
machine** et **sur le cas SAIN** l'a montré.

> Les deux règles posées le matin même — **VPS-M43** (*essayer les branches ne remplace pas essayer
> le montage*) et **VPS-M40** (*tout détecteur doit voir un cas sain*) — ont été vérifiées dans la
> même minute, **sur le correctif qui les cite**. On n'interroge donc pas le statut : on assainit la
> valeur (`case … *[!0-9]* … NB=0`), exactement comme VPS-M33 l'avait conclu.

**À ne pas faire** : tuer un client `docker` sans regarder son **PPID**. Un `docker compose up
--build` de déploiement a un parent vivant et doit être laissé tranquille — le détecteur les
distingue, et c'est la seule chose qui l'empêche d'être dangereux.

---

### VPS-M44 — L'audit a failli publier « la boucle s'est arrêtée » sur un démon qui brûlait 1,44 cœur

- **Vu** : 2026-08-18 · **Statut** : `APPLIQUE` (corrigé dans `collecte.sh` le jour même, **avant publication**)

**Quoi.** La première collecte du 2026-08-18, à 03 h 51 min 06, a affiché ceci :

```
dockerd   maintenant   0.0 %  |  cumul 220.1 h CPU / 318.3 h uptime = 69.2 %
          🟠 SEQUELLE — calme maintenant ; le cumul garde la trace d une boucle PASSEE
```

**C'était la nouvelle du jour, et elle était fausse.** VPS-016 dure depuis le 2026-08-11 ; un
`maintenant 0,0 %` signifie que la boucle a cessé — le seul événement que sept passages
attendaient. Trois mesures indépendantes disent le contraire :

| Source | Fenêtre | Ce qu'elle dit |
|---|---|---|
| `ps -o etime,time -p 913` | 25,68 h | **37,08 h de processeur** = **144,4 %** d'un cœur |
| `sar -u` | tranche 03:50 | **5,75 % d'inactivité**, 43,0 % de temps système |
| Bloc BUDGET, collecte de 04 h 00 | 380 s | `dockerd` = **52,5 % de la machine** |

**La cause est une ligne de repli**, et c'est la même que celle que VPS-M39 a corrigée :

```bash
INST=$(… awk … )      # le grand instantané ne rend rien pour ce PID
[ -z "$INST" ] && INST=0        # ← une ABSENCE devient une AFFIRMATION
```

`snap()` lit **~900 fichiers** de `/proc` en priorité `nice -n 19`. Sur une machine à ~6 %
d'inactivité, il arrive qu'un PID manque à l'un des deux échantillons : `awk` ne rend alors rien,
et le repli **fabriquait un zéro**. Ce zéro se lit *« il n'a rien consommé »*, il échoue au test
`inst > 50`, et le verdict tombe sur la branche **rassurante**.

### ⚠️ Le coût ne s'arrête pas au chiffre : le collecteur a sauté son propre diagnostic

`EMB_PID` n'est renseigné que si l'instantané dépasse 50 %. Avec un zéro fabriqué, il reste vide —
et **tout le bloc « signature de boucle » de VPS-M28 est sauté, en silence**. Vérifié sur les
sorties : le bloc est **absent** de la collecte de 03 h 51 et **présent** dans celle de 04 h 00. Le
matin où il servait, le détecteur écrit pour trancher le constat le plus lourd du dispositif ne
s'est pas exécuté, et rien ne l'a dit.

### ⚠️ Et c'est VPS-M39 à l'identique, à TROIS LIGNES de là

VPS-M39, corrigé le 2026-08-16, décrit **mot pour mot** ce repli — dans le bloc BUDGET :

> *« Le repli s'écrivait `(pdock >= 0 ? pdock : 0)` : quand la part de `dockerd` n'était **pas**
> mesurable, il publiait **« dockerd 0,0 % »** — ce qui se lit *« dockerd n'a rien consommé »*.
> Une **affirmation** tirée d'une **absence**. »*

La leçon a été appliquée au bloc du bas et **jamais à celui du haut** — celui qui, lui, décide du
verdict. C'est exactement le mode de récidive que VPS-M38 avait déjà nommé (*« la leçon était déjà
écrite, une colonne plus loin »*) et que VPS-M22 avait nommé avant lui : *écrire qu'un piège existe
ne le désarme pas sur les autres objets.* **Troisième récidive de la même famille en dix jours.**

**Pourquoi c'était invisible.** Le repli ne se déclenche **que sur une machine assez saturée pour
que la lecture de `/proc` rate** — c'est-à-dire exactement le jour où la mesure compte. Sur une
machine saine il ne s'exécute jamais. C'est la famille **VPS-M28** (*un code qui ne s'exécute que
pendant une panne n'est jamais démenti par les passages normaux*), et elle mord ici **dans le sens
rassurant**, qui est celui qui n'a aucun plaignant (VPS-M21).

**Quoi faire — et c'est fait.** Trois changements :

1. **Plus aucun zéro fabriqué.** Mesure absente → `maintenant NON MESURABLE`, et si le cumul
   dépasse 50 % : `🔴 CUMUL ÉLEVÉ ET INSTANTANÉ NON MESURABLE — on ne peut PAS dire si la boucle
   est en cours ou éteinte`, avec les deux commandes qui trancheraient.
2. **Une reprise ciblée** avant d'avouer : 2 lectures de `/proc/<pid>/stat` et 1 s d'attente pour
   ce seul PID, au lieu de deux balayages de 900 fichiers. Coût quand tout va bien : **nul** — la
   branche n'est jamais atteinte.
3. **Un avertissement quand l'instantané est BAS et le cumul HAUT** : *« 3 s ne suffisent pas à
   conclure que la boucle est finie ; confirmer par `ps -o etime,time` AVANT d'écrire qu'elle a
   cessé. »* C'est VPS-M36 appliqué ici — *un échantillon unique présenté comme un état*.

**Quatre branches essayées, dont le cas SAIN** (règle VPS-M40) :

| Cas | Attendu | Rendu |
|---|---|---|
| mesure **absente**, cumul 69,2 % | 🔴 NON MESURABLE, aucun verdict rassurant | ✅ |
| mesure **réelle** 0,0 %, cumul 69,2 % | 🟠 + l'avertissement « 3 s ne suffisent pas » | ✅ |
| mesure réelle 80,3 % (valeurs de 04 h 00) | 🔴 EMBALLEMENT EN COURS | ✅ |
| **témoin sain** — `containerd`, 0,3 % / 1,1 % | **aucun verdict, aucun bruit** | ✅ **il discrimine** |

**À ne pas faire** : lire un instantané de 3 secondes comme un état, dans un sens **ou dans
l'autre**. Ce constat naît d'un faux négatif ; le faux positif symétrique — un pic de 3 s pris pour
une boucle — coûterait un `systemctl restart docker` inutile. La grandeur qui a toujours tranché
sur VPS-016 est la **continuité** (`etime` contre `time`), et elle demande deux passages, pas trois
secondes.

---

### VPS-M43 — Le correctif d'hier a décapité la collecte, et le garde écrit pour rendre les erreurs visibles est ce qui l'a cachée

- **Vu** : 2026-08-18 · **Statut** : `APPLIQUE` (deux correctifs posés dans `collecte.sh` le jour même)

**Quoi.** La collecte du 2026-08-18 s'est arrêtée **au milieu de la section 5**, deux fois de
suite, sans un mot d'explication. Huit sections sur douze manquaient : sécurité, planification,
journaux, historique `sysstat`, les sept leviers, le budget — et le test `alpine` de VPS-026, qui
arrivait justement à échéance ce matin.

La cause tient en une variable :

```bash
set -uo pipefail                                   # ligne 27, depuis toujours
...
[ -n "$RPC_UN" ] && RPC_CACHE="${RPC_CACHE}${pg}=${RPC_UN}"   # section 5 — jamais initialisée
```

`RPC_CACHE` est l'accumulateur introduit **la veille**, le 2026-08-17, pour fermer l'angle mort
n° 3 : le levier 4 relisait `random_page_cost` que la section 5 venait de lire, et le correctif le
lui fait **dériver** au lieu de relancer six `docker exec`. Bonne idée, correctement raisonnée —
et la variable n'a **jamais reçu de valeur initiale**. Sous `set -u`, sa première lecture, à la fin
de la **première** itération, est une variable non liée : `bash` s'arrête net, statut 1.

### ⚠️ Le second défaut est le vrai sujet : la mort était SILENCIEUSE

`exec 2>"$ERRBUF"` (ligne 51) est le correctif **VPS-M33**, écrit le 2026-08-13 précisément pour
que le collecteur cesse de jeter ses propres messages d'erreur. Il capture `stderr` dans un tampon
et le **publie en fin de collecte**.

**On ne l'atteint jamais quand on meurt en route.** Le message `RPC_CACHE: unbound variable` est
donc parti dans un fichier que rien n'a lu, et le `stderr` côté poste est resté **vide**.

| Ce qu'on avait | Ce que ça disait |
|---|---|
| Sortie tronquée, `FIN DE COLLECTE` absent | **qu'**elle est morte ✅ |
| `stderr` local vide | rien |
| Tampon `$ERRBUF` sur le VPS | la réponse — **jamais publiée** |

Le garde-fou écrit pour rendre les erreurs du collecteur visibles est exactement celui qui a rendu
celle-ci invisible. *Le marqueur de fin a fait son travail — il a dit `QUE`. Il ne pouvait pas dire
`POURQUOI`,* et ça a coûté **deux collectes complètes** à une machine à 2 vCPU avant qu'un `grep`
côté poste ne trouve la cause en trois secondes.

### ⚠️ Et la leçon n'est PAS « penser à initialiser ses variables »

C'est **VPS-M35, mot pour mot, trois jours plus tard** :

> *« Les huit branches avaient toutes été validées **séparément** ; c'est l'essai de
> l'**assemblage** qui a montré la seconde face. Essayer les branches ne remplace pas essayer le
> montage. »*

Le correctif du 08-17 a été validé par **six branches** (nominal, cache vide, base muette, témoin
sain, nom préfixe d'un autre, extraction `awk`) **et** une contre-épreuve `6/6` sur la machine.
**Aucune de ces sept vérifications ne pouvait voir le défaut** : elles rejouaient le **bloc**,
jamais le **script**. Un bloc extrait de son fichier n'hérite ni de son `set -u`, ni de l'état des
variables qui le précèdent — c'est-à-dire précisément de ce qui casse ici.

C'est aussi la famille de **VPS-M28** sous un autre angle. VPS-M28 : *un code qui ne s'exécute QUE
pendant une panne n'est jamais traversé par les passages normaux.* VPS-M43 : *un code essayé
seulement hors de son montage n'est jamais traversé dans les conditions où il tourne.* Dans les
deux cas, le chemin réellement emprunté en production n'a jamais été parcouru une seule fois.

**Pourquoi c'était invisible.** Le correctif a été écrit, essayé et publié le 08-17 ; la sortie
archivée ce jour-là a été produite par la version **antérieure**, et le rapport le disait lui-même
(*« qui prennent effet au prochain passage »*). Il y avait donc, écrit noir sur blanc, un correctif
non essayé de bout en bout qui allait s'appliquer pour la première fois **sans témoin** — et rien
dans le dispositif ne traite cette phrase comme un risque.

**Quoi faire — et c'est fait, en deux correctifs distincts.**

1. **Le défaut** : `RPC_CACHE=''` avant la boucle de la section 5.
2. **Le mode d'échec** : un `trap … EXIT` publie le tampon `stderr` **sur `stdout`** dès que la
   collecte sort autrement que par sa fin normale, avec `FIN_NORMALE=1` posé juste avant le
   marqueur. Coût sur un passage sain : **nul** — le trap rend la main immédiatement.

**Trois branches essayées, dont le cas SAIN** (règle VPS-M40, *tout détecteur doit être passé sur
une entrée dont on sait qu'elle est saine*) :

| Cas | Attendu | Rendu |
|---|---|---|
| collecte saine | trap muet, `FIN DE COLLECTE` | ✅ muet |
| **variable non liée — le défaut du jour** | 🔴 + la ligne `unbound variable` | ✅ **il NOMME la cause** |
| mort par **signal** | 🔴 + « tampon vide » | ✅ et il refuse de publier le statut |

⚠️ **La troisième branche a attrapé un défaut du correctif lui-même**, avant publication : dans un
`trap EXIT`, `$?` ne porte **pas** le `143` d'une mort par signal — il vaut **0**. La première
écriture publiait donc *« statut de sortie 0 »* sur une collecte tuée, c'est-à-dire une
**affirmation que tout allait bien au moment de mourir**. Le bloc annonce désormais ce statut comme
non significatif plutôt que de le donner pour une mesure. *Quatrième passage consécutif où la
discipline VPS-M13 attrape le correctif du jour même.*

**À ne pas faire** : conclure « il suffit d'enlever `set -u` ». C'est exactement l'échange que
VPS-M31 punit — élargir la tolérance d'un garde au lieu de corriger ce qu'il a correctement
signalé. `set -u` a fait son travail : il a **refusé** de fabriquer une chaîne vide à partir d'une
variable qui n'existe pas. Sans lui, `RPC_CACHE` serait resté vide en silence et le levier 4
aurait affiché `🔴 0 / 6 bases examinées` — un aveu, certes, mais après combien de passages ?

---

### VPS-M41 — Un test de réfutation écrit d'avance, sans sa précondition, arrive à échéance un jour où il ne veut rien dire

- **Vu** : 2026-08-17 · **Statut** : `APPLIQUE` (règle de méthode, appliquée le jour même aux deux tests posés par le rapport du 2026-08-17)

**Quoi.** Le rapport du 2026-08-10 datait, noir sur blanc, la falsification gratuite de
l'hypothèse « `fstrim` déclenche la boucle de `dockerd` » :

> *« Le seul événement planifié de la fenêtre est `fstrim` (01 h 17 min 17 → 01 h 17 min 49,
> 43,8 Gio libérés). ⚠️ Coïncidence, pas cause : `fstrim` est hebdomadaire **le lundi**, et le
> premier emballement était un mercredi. L'hypothèse est faible mais **falsifiable gratuitement —
> prochain passage le lundi 2026-08-17 à 01 h 38 UTC**. »*

L'échéance est arrivée. `fstrim` a tourné le 2026-08-17 à **00 h 38 min 27 → 00 h 38 min 56**,
**40,6 Gio découpés**, et `sar` est parfaitement plat autour :

| Tranche UTC | %user | %system | %idle |
|---|---:|---:|---:|
| 00:30:27 | 20,86 | 29,62 | 37,93 |
| **00:40:07** *(contient `fstrim`)* | **21,95** | **31,21** | **36,61** |
| 00:50:27 | 22,10 | 31,50 | 39,72 |

**Et cette platitude ne réfute rien.** On ne teste pas un **déclencheur** sur une machine **déjà
déclenchée** : `dockerd` boucle sans interruption depuis le 2026-08-11. Si `fstrim` déclenchait
des boucles, une machine déjà en boucle n'aurait rien de plus à montrer. Le test supposait
implicitement que la machine serait revenue au calme le 08-17 — **cette précondition n'a jamais
été écrite, et elle n'est pas tenue.**

### ⚠️ Le second défaut est pire : le test était DÉJÀ tranché, et depuis cinq passages

`fstrim.timer` est hebdomadaire **le lundi**. Les trois occurrences de VPS-016 :

| Occurrence | Date | Jour | Compatible avec un déclencheur du lundi ? |
|---|---|---|---|
| 1 | 2026-08-05 ~02 h 23 | **mercredi** | ❌ non |
| 2 | 2026-08-10 ~01 h 15 | **lundi** | ✅ oui — c'est elle qui a fait naître l'hypothèse |
| 3 | 2026-08-11 ~21 h 05 | **mardi** | ❌ non |

Le rapport du 08-10 avait **lui-même** noté la première incompatibilité et programmé le test quand
même. Le **2026-08-12**, la troisième occurrence a démarré un **mardi** — la seconde
incompatibilité, et la dernière nécessaire. **Une donnée en main réfutait l'hypothèse ce jour-là**,
et le test est resté écrit tel quel dans **quatre rapports** (08-13, 08-14, 08-15, 08-16), jusqu'à
arriver à terme sur un état où il ne pouvait plus rien dire.

C'est **VPS-008 à l'identique** (*« la donnée était disponible dès le premier jour, il a fallu six
passages pour lancer la requête »*), déplacé d'un cran : ici la donnée n'était même pas à
demander — elle était **déjà publiée dans le tableau des occurrences**, à trois lignes de
l'hypothèse qu'elle réfutait.

**Pourquoi c'était invisible.** Les tests écrits d'avance sont la meilleure habitude du
dispositif : c'est ce qui a fermé VPS-024 en **un** passage là où VPS-008 en a coûté **six**. Mais
un test qui a payé quatre fois de suite cesse d'être relu — on attend son échéance au lieu de
vérifier qu'il est encore testable. **Rien ne tient leur registre**, donc rien ne peut signaler
qu'un test est périmé avant son terme.

> **La règle, écrite pour ne plus la repayer** : *tout test écrit d'avance porte sa **précondition
> de validité**, et cette précondition est **relue à chaque passage**, pas seulement à l'échéance.*
> C'est le symétrique exact de ce qui a fait la réussite de VPS-026 : ce test-là a une précondition
> **inconditionnelle** (un ménage nocturne et un tirage nocturne, tous les jours), donc il ne
> pouvait pas échouer à être interprétable. Celui de `fstrim` en avait une, forte, et muette.

**Ce que ce passage établit quand même, et qui est neuf** : `fstrim` **n'arrête pas** la boucle.
40,6 Gio découpés sur le système de fichiers du démon, en 29 secondes, sans un creux dans `sar`.
Cette moitié-là n'avait jamais été testée. **L'hypothèse `fstrim` est close — par la chronologie,
pas par ce matin.** Quatrième piste fermée sur VPS-016, après `texto-relay`, le temps volé par
l'hyperviseur et la fenêtre 13 h–15 h.

**Quoi faire — et c'est fait pour la partie qui dépend de moi.** Les deux tests posés par le
rapport du 2026-08-17 portent leur précondition en clair : celui de VPS-026 (*« que le ménage de
00 h 40 et le timer de 03 h 31 tournent tous les deux »*) et celui du ratio de continuité de
VPS-016 (*« PID 913 inchangé et boucle en cours ; si le démon redémarre, ce test ne dit rien »*).

**À ne pas faire** : lire le résultat d'un test dont la précondition n'est pas tenue « puisqu'on
a la mesure ». C'est précisément ce qui a failli fermer l'hypothèse `fstrim` sur une observation
qui n'y touche pas — et une hypothèse close à tort ne se rouvre jamais.

**Piste pour le collecteur** (angle mort n° 7 du rapport du 2026-08-17) : un tableau `tests` dans
`wiki.json` — un par ligne, avec son **échéance**, sa **précondition** et son **statut** — que
l'écran affiche et que le passage suivant est obligé de trancher. Coût pour la machine : **nul**,
c'est du côté poste.

---

### VPS-M42 — Un angle mort désignait un objet qui n'existe pas, et il a été re-reporté deux fois sans être relu

- **Vu** : 2026-08-17 · **Statut** : `APPLIQUE` (angle mort fermé par l'inventaire, 2 correctifs structurels posés dans `collecte.sh` le jour même)

**Quoi.** L'angle mort n° 2 des rapports du 08-14, 08-15 et 08-16 était écrit ainsi :

> *« Le collecteur coupe encore des clients Docker en cours de requête. VPS-M12 l'interdit depuis
> le 2026-08-06 ; aucun `timeout` du script n'a été revu. **Piste : inventorier les `timeout` qui
> enveloppent un `docker …`** et leur substituer une borne côté client. »*

**Il n'en existe aucun.** L'inventaire, qui coûte un `grep` :

| Les 11 `timeout` du script | Commande enveloppée |
|---:|---|
| 6 | `du` |
| 3 | `curl` |
| 1 | `openssl s_client` |
| 1 | `gzip -dc` |
| **0** | **`docker …`** |

La piste écrite depuis trois passages désignait une famille **vide**. Elle venait d'un
raisonnement plausible, tenu le 2026-08-14 en relisant la ligne
`error reading preface from client` dans le journal de `dockerd` pendant la fenêtre de collecte —
et personne n'a lancé le `grep` qui l'aurait réfutée en trois secondes.

### La vraie famille restante, et elle est bénigne

Ce qui coupe un client Docker dans ce script n'est pas un `timeout`, c'est un **SIGPIPE** :
`head` ferme son entrée dès qu'il a ses lignes, et le producteur en amont meurt en cours d'écriture.
C'est d'ailleurs ce que le collecteur savait déjà — la note du 2026-08-12 en tête du levier 4 dit
exactement ça. Les **6** sites `docker … | …` du script :

| Site | Filtre intermédiaire | Coupure possible ? |
|---|---|---|
| `docker stats … \| sort \| head -15` | `sort` | ❌ non — `sort` lit **tout** avant d'écrire |
| `docker images \| sort -r \| head -1` (×2) | `sort` | ❌ non |
| `docker buildx inspect \| grep \| sort \| head -1` | `grep` + `sort` | ❌ non |
| **`docker images alpine:latest --format … \| head -1`** | aucun | ⚠️ concevable — mais le filtre est un `repo:tag` exact, donc **une ligne au plus** |
| **`docker images alpine:latest -q \| head -1`** | aucun | ⚠️ idem |

**Aucun site ne coupe réellement un client aujourd'hui.** Les deux derniers ont quand même été
passés à `awk 'NR==1'`, qui lit jusqu'à EOF pour le même fork : *un argument « ça ne peut pas
arriver » doit être refait à chaque relecture, un `awk` non.*

**Quatre branches essayées sur la machine** : image présente (`head` et `awk` rendent la même
chaîne à l'octet près), image absente (les deux rendent vide), sortie multi-lignes (le cas où
`head` couperait), et la contre-lecture `-q`.

**Pourquoi c'était invisible.** Une liste d'angles morts se recopie d'un rapport à l'autre —
c'est sa fonction, elle est la feuille de route du collecteur. Mais **elle se périme exactement
comme un classement de rendement** (VPS-M30) : le monde bouge, la formulation reste. Celui-ci a
survécu deux passages en désignant une chose qui n'existe pas, et chaque report a **augmenté** sa
crédibilité — « reporté 2 fois » se lit comme « confirmé 2 fois ».

> **La règle** : *un angle mort reporté doit voir son **énoncé** re-vérifié avant d'être
> re-reporté, pas seulement sa priorité.* C'est **VPS-M22 appliqué à la feuille de route** —
> *écrire qu'un piège existe ne prouve pas qu'il existe* — et c'est la famille de VPS-M41, posé le
> même matin sur un autre objet écrit d'avance : un test.

**Ce que le même passage a fermé sans mériter de fiche** : l'angle mort n° 3 (« la section 5 lit
`random_page_cost` pour les six bases, et le levier 4 le relit »), reporté **cinq** fois. C'était
une récidive franche de **VPS-M30** — six `docker exec` et six backends PostgreSQL pour une valeur
déjà en mémoire — et le correctif est le patron de VPS-M30 tel quel : capturer une fois, dériver.
**Contre-épreuve faite, 6/6 valeurs identiques à l'ancienne méthode**, et le garde de dénominateur
de VPS-M34 conservé intact. Un défaut connu, un correctif connu : il n'ouvre pas de fiche, il
ferme une ligne.

**À ne pas faire** : retirer un angle mort de la liste au motif que son énoncé était faux. Ce qui
se ferme ici, c'est **la question** (« le collecteur coupe-t-il des clients Docker ? » — non), pas
la ligne. Une piste réfutée vaut une piste ouverte, et elle doit rester écrite pour que personne
ne la rouvre de mémoire.

---

### VPS-M40 — La répartition du `wchan` ne distingue pas un démon sain d'un démon emballé, et j'allais en tirer un verdict

- **Vu** : 2026-08-16 · **Statut** : `APPLIQUE` (corrigé dans `collecte.sh` le jour même, **avant publication**)

**Quoi.** L'angle mort n° 7 du rapport du 2026-08-15 demandait de fermer le volet *échantillonnage*
de VPS-M36 : le `wchan` n'était lu qu'une fois, sur trois threads. Le correctif écrit ce matin
prenait la répartition sur **tous** les threads — c'était la bonne idée — et en tirait un verdict :

```
≥ 50 % des threads en futex_wait_queue
  → 🔴 c est l ORDONNANCEUR Go qui tourne en rond, signature de VPS-016
```

Sur `dockerd` : **33 threads sur 42, soit 79 %** → 🔴. Cohérent avec cinq passages de diagnostic.

**Puis le même bloc a été passé sur un cas TÉMOIN** — `containerd`, démon parfaitement sain, qui
consomme **0,3 % d'un cœur** et affiche **2,9 h de CPU cumulé pour 268,8 h d'uptime** :

```
containerd   14 threads : 13 futex_wait_queue, 1 ep_poll   → 93 % en « futex_wait_queue »
```

**93 % — plus que `dockerd`.** Un runtime Go **au repos** gare ses threads dans un futex : c'est
l'état **normal** d'un démon qui attend, pas celui d'un démon qui s'emballe. La répartition ne
discrimine **rien**.

**Ce que ça a failli coûter.** Le verdict aurait donné au constat le plus lourd du dispositif
(VPS-016, 7e journée) une corroboration qui n'en est pas une — et il l'aurait fait **à chaque
passage**, en vert, sans que rien ne le signale.

**Le coût rétroactif, à écrire aussi.** Le rapport du 2026-08-15 présentait
*« une répartition à 79 % : la conclusion « emballement de l'ordonnanceur Go » ne repose plus sur
un tirage »* comme un renforcement. **Elle ne reposait pas sur un tirage — elle ne reposait sur
rien.** La conclusion elle-même **reste vraie**, mais elle tient au **CPU** : 99,3 % maintenant et
159,3 h cumulées pour `dockerd`, contre 0,3 % et 2,9 h pour `containerd`. C'est le CPU qui a
toujours discriminé, et le référentiel le disait dès le 2026-08-12 (*« un thread bloqué en
`futex_wait_queue` **avec des heures de CPU cumulé** »*) — la moitié qui compte s'était perdue en
route.

**Quoi faire — et c'est fait.** Le bloc affiche la répartition **sans aucun verdict**, et imprime
**celle de `containerd` juste à côté**, en permanence. Le témoin n'est pas un ornement : c'est lui
qui empêche de relire la ligne du dessus comme une preuve. S'il disparaît, le verdict fabriqué
revient avec lui.

**Pourquoi c'était invisible.** Parce que le défaut ne se manifeste **que sur une entrée saine**.
Les branches dégénérées (donnée absente, illisible, pid mort) ont toutes été essayées et toutes
passé ; l'essai d'intégration aussi — mais il tourne sur `dockerd`, qui **est** malade. Aucun de
ces essais ne pouvait le révéler.

> **La règle, à ajouter à la discipline d'essai** : tout détecteur doit être passé sur **une entrée
> dont on sait qu'elle est SAINE**. Un détecteur qui n'a jamais vu de cas sain n'a jamais été
> testé — il a seulement été **confirmé**. C'est le symétrique de VPS-M13 (« essayer le correctif
> du jour ») : ici il faut l'essayer sur ce qu'il doit **laisser passer**.

**À ne pas faire** : retirer la ligne `containerd` au motif qu'elle « n'apporte rien ». C'est
exactement ce qu'elle apporte — elle coûte ~14 lectures de `/proc` et elle désarme une déduction
que cinq passages ont failli graver.

---

### VPS-M39 — Le discriminant de charge savait dire « ce n'est pas l'audit » et jamais « c'est ceci »

- **Vu** : 2026-08-16 · **Statut** : `APPLIQUE` (corrigé dans `collecte.sh` le jour même)

**Quoi.** Le discriminant posé le 2026-08-15 (VPS-M35) mesure le CPU réellement consommé par
l'audit et le `%idle` de la fenêtre exacte. À son **premier passage réel**, il a rendu :

```
🟠 MACHINE SATUREE (5.3 % d inactivite), mais l audit n y est que pour 15.7 %.
   Chercher le consommateur AILLEURS : user 27.6 % + sys 51.3 % ne sont pas de l audit.
```

Le verdict est **juste**. Il est aussi **inutile** : le consommateur était imprimé **800 lignes
plus haut**, dans la section 1 du même fichier — `dockerd` à **99,3 % d'un cœur**, soit **50 % d'une
machine à 2 vCPU**, en boucle depuis 101 heures.

**Deux mesures justes, côte à côte, sans lien.** C'est le mode d'échec nommé par VPS-026 (*« la
sonde Docker Hub mesure bien Docker Hub depuis le premier jour, mais rien ne la reliait à un chemin
de sauvegarde »*), et c'est ici la même chose à l'intérieur d'un seul bloc.

**Pourquoi c'était invisible.** Le bloc a été écrit et validé le 08-15 sur **huit branches**, dont
une contre-épreuve où 22,4 s de CPU brûlés volontairement déclenchaient bien le verdict rouge.
Toutes portaient sur *« l'audit est-il coupable ? »* — la seule question qu'il avait été conçu
pour trancher. Aucune ne demandait *« et sinon, qui ? »*, parce que la branche « sinon » n'était
qu'un renvoi, jamais une réponse.

**Quoi faire — et c'est fait.** La part de `dockerd` est mesurée sur **exactement la même fenêtre**
(deux lectures de `/proc/<pid>/stat`, aucun fork, aucun appel Docker — le même prix que ce qui est
déjà prélevé pour l'audit), et le bloc imprime une répartition à quatre termes qui **somme à
100 %** :

```
→ repartition : audit 12.9 %  |  dockerd 55.1 %  |  reste 0.1 %  |  inactif 31.9 %
```

Nouveau verdict 🔴 quand la machine sature **et** que `dockerd` dépasse 25 % : *« LE CONSOMMATEUR
EST NOMMÉ »*, avec le renvoi à VPS-016.

**Trois branches dégénérées, et chacune AVOUE** (discipline VPS-M28) : compteur qui **recule** (le
démon a redémarré pendant la collecte — un événement en soi, pas une mesure à lisser), démon
disparu, lecture impossible.

> ⚠️ **Une de ces branches était fausse à la première écriture, et l'essai l'a attrapée.** Le
> repli s'écrivait `(pdock >= 0 ? pdock : 0)` : quand la part de `dockerd` n'était **pas**
> mesurable, il publiait **« dockerd 0,0 % »** — ce qui se lit *« dockerd n'a rien consommé »*.
> Une **affirmation** tirée d'une **absence**. Deux branches distinctes désormais, et la seconde
> dit explicitement *« ne pas lire cette absence comme : dockerd n'y est pour rien »*.

**Le gain, chiffré.** Le PID est résolu **au début** et conservé : le résoudre à la fin comparerait
deux processus différents si le démon avait redémarré entre-temps, et rendrait un delta absurde
sans rien signaler.

---

### VPS-M38 — `redem=N` est un compteur cumulé publié sans sa fenêtre, et il accuse un conteneur sain

- **Vu** : 2026-08-15 · **Statut** : `APPLIQUE` (corrigé dans `collecte.sh` le jour même)

La table des conteneurs affichait ce matin :

```
maalem-dev-admin | redem=8 | sante=healthy | memlimit=0 | redem_pol=unless-stopped | projet=maalem-dev
```

**Huit redémarrages se lisent comme une boucle.** `docker inspect` dit exactement l'inverse :

```
Created    = 2026-08-14T10:30:03      FinishedAt = 2026-08-14T10:31:16
StartedAt  = 2026-08-14T10:31:29      ExitCode   = 0        Status = running
```

**Les huit redémarrages tiennent dans les 86 secondes qui ont suivi son déploiement**, et le
conteneur tourne sans broncher depuis **seize heures**. Un démarrage difficile, pas une boucle.

**Le défaut n'est pas le chiffre** — `RestartCount` est exact. C'est qu'il est publié **sans dire
quand**, donc sans que le lecteur puisse distinguer un incident en cours d'un historique éteint.

**Ce qui rend ce constat gênant, c'est que la leçon était déjà écrite, une colonne plus loin.** La
section 1 porte depuis le 2026-08-08, pour le cumul CPU des démons :

> *« Le cumul ne DIMINUE JAMAIS — il ne s'efface qu'au redémarrage du démon. Un 🟠 peut donc rester
> allumé des semaines après la fin de l'incident : c'est "maintenant" qui tranche. »*

La phrase est juste, elle est publiée à chaque passage, et elle n'a jamais été appliquée au
compteur d'à côté. *Écrire qu'un piège existe ne le désarme pas sur les autres objets — c'est
exactement ce que VPS-M22 avait déjà constaté, ici sur une règle de lecture plutôt que sur une mesure.*

**Correctif appliqué** : un bloc *« Conteneurs qui ont REDÉMARRÉ : la boucle est-elle ACTIVE, ou
ÉTEINTE depuis ? »*, qui classe sur la date du dernier démarrage — 🔴 moins de 2 h · 🟠 moins de
24 h · ✅ au-delà — et n'affiche que les conteneurs au compteur non nul.

- **`StartedAt` vient du gabarit déjà récupéré** : aucun appel Docker supplémentaire.
- **Comparaison lexicographique** sur l'horodatage RFC3339 UTC, valide parce que Docker émet
  toujours ces dates en `Z` et zéro-remplies. 33 `date -d` auraient rejoué VPS-M14.
- **Six branches essayées sur la machine** : nominal, seuils reculés → 🔴, seuils au futur → ✅,
  seuil vide → **refus de classer** (pas de verdict rassurant sur un seuil absent, leçon VPS-M28),
  jeu sans redémarrage, liste vide.
- **Et le contrôle qui comptait vraiment** : ajouter un 7e champ au gabarit `docker inspect` est
  précisément le geste qui avait fait disparaître sept conteneurs en silence (VPS-M08). Vérifié
  avant tout le reste : **33 / 33 lignes rendues, 7 champs**.

**Leçon générale.** *Un compteur cumulé publié sans la date de son point zéro n'est pas une mesure,
c'est une accusation sans date.* C'est le symétrique exact de la leçon du 2026-08-14 (trois
grandeurs d'**instant** lues comme permanentes) : ici une grandeur **cumulée** lue comme présente.
Les deux sont la même erreur — une mesure sans sa fenêtre de validité — et celle-ci mord dans le
sens accusateur, qui n'a pas plus de plaignant que le sens rassurant.

### VPS-M35 — Le verdict de charge de l'audit est démenti par `sar`, et il l'accuse à tort

- **Vu** : 2026-08-15 · **Statut** : `APPLIQUE` (corrigé dans `collecte.sh` le 2026-08-15, ouvert le 2026-08-14)

> ### ✅ Corrigé le 2026-08-15 — et chiffré pour la première fois
>
> **Le correctif.** Deux mesures ajoutées au bloc BUDGET, pour **quatre lectures de `/proc`, aucun
> fork, aucun appel Docker** :
>
> 1. **`/proc/$$/stat` champs 14-17** (`utime + stime + cutime + cstime`) → le temps processeur
>    **réellement** consommé par le script et tous ses enfants déjà récupérés. C'est une mesure
>    **directe** du coût de l'audit, pas une déduction à partir de `loadavg`. `$$` désigne le shell
>    principal même lu depuis une substitution de commande, contrairement à `/proc/self/stat`.
> 2. **Delta de `/proc/stat`** → `%idle`, `%nice`, `%user`, `%system`, `%iowait`, `%steal` sur
>    **exactement** la fenêtre de la collecte. `sar` ne peut pas le donner : à l'heure normale du
>    passage, la tranche de 10 minutes qui contient la collecte n'est pas encore écrite quand le
>    script se termine.
>
> **Portée, écrite pour ne pas la surestimer** : `cutime`/`cstime` ne comptent que les enfants
> **déjà attendus**, et le coût de `sshd` côté serveur n'y figure pas. Le chiffre est donc un
> **plancher** — ce qui est le bon sens de l'erreur : il ne peut pas disculper l'audit à tort.
>
> **Huit branches essayées sur la machine**, dont une **contre-épreuve** qui est le vrai test :
> 22,4 s de processeur brûlés volontairement en priorité *idle* → `🔴 C EST BIEN L AUDIT : 44,8 %` ;
> le **même** jeu de données machine avec le compteur propre de l'audit figé → `🟠 MACHINE SATURÉE,
> l'audit n'y est que pour 0,0 %`. **Le discriminant discrimine**, et il le fait sur une charge
> réelle, pas sur une constante forcée.
>
> ### ⚠️ Et ce correctif était FAUX sur sa branche dégénérée — attrapé à l'essai, avant publication
>
> La première écriture portait `capacite_s = (d>0 ? d*np : 1)`. Avec une durée de collecte nulle,
> elle divisait 0,3 s de processeur par **une seconde de capacité inventée**, annonçait
> « 32 % de la machine » et déclenchait `🔴 C EST L AUDIT`. **Un dénominateur fabriqué produisait
> une accusation sûre d'elle**, sur une machine qui n'avait rien fait.
>
> La branche rend désormais `🔴 COÛT NON CALCULABLE : durée nulle, donc aucune capacité de
> référence`, et publie les secondes de processeur **sans en tirer de pourcentage**.
>
> *C'est VPS-M28 retourné : la fausse rassurance et la fausse accusation coûtent exactement pareil,
> et le coupable est toujours le repli qui **fabrique** une valeur au lieu d'avouer qu'il n'en a
> pas. Troisième passage consécutif où la discipline VPS-M13 attrape un correctif du jour même.*
>
> ### Le premier chiffrage, pris sur le passage du 2026-08-15
>
> | Tranche UTC | %user | **%nice** | %system | %iowait | **%idle** |
> |---|---:|---:|---:|---:|---:|
> | 02:20:07 (avant la collecte) | 21,66 | **0,08** | 31,80 | 0,16 | **38,80** |
> | 02:30:15 (contient la collecte **et** les vérifications) | 23,74 | **0,30** | 39,03 | 1,81 | **28,99** |
>
> `loadavg` a monté de **+2,60** (1,20 → 3,80) ; l'inactivité a perdu **9,81 points**, soit ~0,20 cœur
> sur 2 — **et c'est un majorant**, la tranche contenant aussi les vérifications en marge.
>
> **Le rapport entre ce que `loadavg` annonce et ce que la machine consomme vaut ici ~13 pour 1.**
> Le 2026-08-14 il valait ~150 pour 1 (+12,27 pour 3,95 points). **Le phénomène n'est donc pas
> réservé aux lectures extrêmes** : c'est la lecture *ordinaire* de `loadavg` qui est fausse sur
> cette machine tant que VPS-016 dure.
>
> ### ⚠️ Le défaut a DEUX faces, et l'essai d'intégration a révélé la seconde
>
> Ce constat n'avait vu que la face **accusatrice**. L'essai de bout en bout du correctif, dans le
> vrai contexte d'invocation (`bash -s` par SSH) avec un corps réduit à 6 secondes, a rendu :
>
> ```
> charge 1 min : 1.45 au DEBUT  →  1.50 a la FIN
> ✅ charge maitrisee : 1.45 → 1.50 (+0.05).        ← l ANCIEN verdict
> cout REEL de l audit : 5.1 s de CPU sur 6 s x 2 coeurs = 42.8 % de la machine
> 🔴 C EST BIEN L AUDIT, ET C EST MESURE : 42.8 %.   ← le NOUVEAU
> ```
>
> | Fenêtre | Ce que `loadavg` dit | Ce qui se passe |
> |---|---|---|
> | Longue, machine bloquée (08-14, 08-15) | « +12,27 » / « +2,60 » | l'audit ne consomme presque rien — **fausse accusation** |
> | **Courte** (6 s) | « **✅ charge maîtrisée** » | l'audit consomme **43 %** — **fausse rassurance** |
>
> La moyenne de charge est lissée sur une minute : sur une fenêtre courte, elle n'a pas le temps de
> bouger. **Et c'est la face rassurante qui est la plus dangereuse** — VPS-M21, *un défaut qui
> rassure n'a aucun plaignant*.
>
> **La leçon de méthode, et elle est nouvelle** : les huit branches avaient toutes été validées
> **séparément** ; c'est l'essai de l'**assemblage** qui a montré la seconde face. *Essayer les
> branches ne remplace pas essayer le montage* — la discipline VPS-M13 gagne ici une marche.

**Le défaut, tel qu'il a été constaté le 2026-08-14.** Le bloc BUDGET a rendu :

Le bloc BUDGET a rendu :

```
charge 1 min : 2.43 au DEBUT  →  14.70 a la FIN
🟠 CHARGE PARTAGEE : […] elle finit a 14.70 (+12.27).
```

**Sur une machine à 2 cœurs, « +12,27 » se lit comme une catastrophe.** `sar` dit autre chose,
sur exactement la même fenêtre :

| Tranche UTC | %user | **%nice** | %system | %iowait | %steal | **%idle** |
|---|---:|---:|---:|---:|---:|---:|
| 04:00:27 (avant la collecte) | 21,88 | **0,01** | 31,42 | 0,20 | 7,85 | **38,63** |
| 04:10:13 (contient la collecte) | 21,60 | **0,04** | 34,88 | 1,16 | 7,64 | **34,68** |

**La machine a perdu 3,95 points d'inactivité — ~0,08 cœur sur 2 — pendant que la charge annoncée
montait de 12,27.** Et `%nice`, dont VPS-M27 a établi que c'est la signature propre de l'audit
(seul lui tourne en `nice -n 19`), passe de 0,01 à **0,04**.

**La cause est mécanique.** La moyenne de charge de Linux compte les processus *runnable* **et**
ceux en sommeil **ininterruptible** (état `D`). Sur cette machine, chaque `docker …` — du
collecteur comme des **65 sondes de santé par minute** — attend sur le socket d'un démon qui
tourne en boucle depuis 55 heures (VPS-016). Ils s'empilent dans la file **sans consommer un
cycle**. La charge mesure ici la **longueur d'une file d'attente sur un démon bloqué**, pas une
consommation de processeur.

**Ce que ça coûte, et ça vaut rétroactivement.** Les verdicts `🔴 C EST L AUDIT` /
`🟠 CHARGE PARTAGEE` posés par VPS-M27 reposent tous sur `loadavg`. Sur une machine saine c'est un
bon indicateur ; sur celle-ci, depuis le 2026-08-11, il est dominé par VPS-016. **Les valeurs
`chargeApresCollecte` de la série (4,20 · 5,02 · 3,22 · 14,70) ne mesurent donc pas toutes la même
chose**, et le 14,70 d'aujourd'hui n'est pas trois fois pire que le 5,02 du 08-12.

**Correctif proposé, pas encore posé.** Ce n'est **pas** d'abandonner `loadavg` — il est juste sur
une machine saine — mais de lui adjoindre le discriminant, qui est **déjà collecté** : `%idle` et
`%nice` de la tranche `sar` qui contient la collecte (section 9). Deux `awk` sur une sortie déjà
en mémoire, coût nul.

⚠️ **Pourquoi il n'est pas posé ce passage** : deux correctifs ont déjà été écrits et essayés
branche par branche ce matin, et **VPS-M28 enseigne qu'un troisième écrit dans la foulée est
celui qu'on n'essaie pas**. Il est en tête des angles morts du rapport.

**Leçon générale.** C'est VPS-M27 poussé d'un cran : cette fiche avait établi qu'*« une mesure de
fin sans mesure de début est un niveau, pas un delta »*, et le delta a bien été ajouté. Il
manquait la marche suivante : **un delta sans le discriminant de sa cause reste un delta sans
responsable.** Et le mode d'échec est celui de VPS-M21 dans l'autre sens — non pas un défaut qui
rassure, mais un défaut qui **accuse** : l'audit se dénonce chaque matin pour une charge qu'il n'a
pas produite, et un lecteur qui vérifie une fois cesse de lire la ligne.

### VPS-M36 — Le `wchan` est un échantillon, et il sert de preuve sur le constat le plus lourd

- **Vu** : 2026-08-15 · **Statut** : `APPLIQUE` sur son volet lisibilité (corrigé le 2026-08-14), `A_TRAITER` sur son volet échantillonnage — **le doute qu'il soulevait est levé, mais par une vérification en marge, pas par le collecteur**

> ### ✅ 2026-08-15 — le doute est levé sur le fond, le défaut de méthode reste entier
>
> Second échantillon pris six minutes après la collecte, sur les mêmes threads :
>
> | Thread | Collecte (02 h 21) | Vérification (02 h 27) |
> |---|---|---|
> | `tid=3786165` | `futex_wait_queue` | **`futex_wait_queue`** |
> | `tid=156485` | `futex_wait_queue` | **`futex_wait_queue`** |
> | `tid=3786190` | `futex_wait_queue` | **`futex_wait_queue`** |
>
> Répartition sur les **42 threads** : **33 `futex_wait_queue` (79 %)**, 6 `do_wait`,
> 1 `hrtimer_nanosleep`, 1 `ep_poll`, 1 « 0 ». La conclusion « emballement de l'ordonnanceur Go »
> ne repose plus sur un tirage.
>
> ⚠️ **Mais c'est une vérification EN MARGE qui a apporté le second échantillon, pas le script.**
> Le collecteur en prend toujours **un seul**. Le volet échantillonnage reste `A_TRAITER`, et le
> fait qu'il ait « bien répondu » deux jours de suite ne le corrige pas — c'est précisément le
> raisonnement que VPS-M12 et VPS-M37 punissent : *une vérification en marge n'est pas un garde,
> parce qu'elle n'a lieu que quand quelqu'un y pense.*

Deux défauts distincts, trouvés le même matin sur la même ligne.

**1. La valeur `0` n'était pas traduite** — angle mort n° 5 du rapport du 2026-08-13. Le repli
`|| echo 'espace utilisateur (running)'` ne traitait que le cas où le **fichier** est illisible.
Or le noyau écrit littéralement `0` dans `/proc/<pid>/task/<tid>/wchan` quand le thread s'exécute
en espace utilisateur : `cat` **réussit**, le repli n'est pas pris, et la ligne affichait
`bloque dans : 0`.

**Correctif appliqué**, trois cas explicitement séparés : nom symbolique → le thread dort dans
cette fonction du noyau ; `0` → *« espace utilisateur (running) — AUCUNE attente noyau »* ;
fichier absent → *« thread disparu entre le classement et la lecture »*. **Les trois branches
essayées sur la machine**, en valeurs forcées **et** réelles : `dockerd` compte en ce moment
**2 threads dont le `wchan` vaut littéralement « 0 »** — la branche n'était pas hypothétique.

**2. Et le vrai défaut est plus profond : c'est UN SEUL échantillon.**

| Échantillon | `tid=156485` |
|---|---|
| 04:09 (collecte) | **`wait_for_partner`** |
| 04:15 (vérification) | `futex_wait_queue` |
| 04:22 (vérification) | `futex_wait_queue` |

**Le même thread, deux réponses en six minutes.** C'est la ligne censée distinguer un `futex`
d'une E/S sur VPS-016 — le constat le plus lourd du dispositif — et elle repose sur un instantané
d'une valeur qui change plusieurs fois par seconde.

**Ce que ça ne remet PAS en cause** : la conclusion « emballement de l'ordonnanceur Go » tient, et
elle tient mieux qu'avant, parce qu'on dispose maintenant d'une **répartition** au lieu de trois
lignes — **23 des 33 threads en `futex_wait_queue`**. Mais jusqu'à ce matin, cette conclusion
reposait sur trois tirages dont chacun pouvait être malheureux, et **rien dans la sortie ne le
disait**.

**Correctif proposé, non posé** : échantillonner le `wchan` des threads chauds **3 fois** à une
seconde d'intervalle et afficher la **répartition** plutôt qu'une valeur, ou afficher directement
le décompte par `wchan` sur l'ensemble des threads. Coût : trois lectures de `/proc` de plus,
aucun fork.

**Leçon générale.** *Une mesure qui sert de preuve doit porter le nombre d'observations sur
lequel elle repose.* C'est la famille VPS-M20 (*une valeur estimée ne doit jamais être présentée
sous un nom qui promet un comptage*), appliquée non plus à un estimé mais à un **échantillon
unique présenté comme un état**.

### VPS-M37 — Un filtre `journald` a failli faire publier qu'une tâche planifiée ne tournait plus

- **Vu** : 2026-08-14 · **Statut** : `APPLIQUE` (règle de vérification, comme VPS-M12)

En cherchant si le ménage nocturne avait tourné, la commande lancée en marge était :

```bash
journalctl _COMM=cron --since "2026-08-13 00:00" | grep "docker image prune"
```

**Une seule ligne, datée du 08-13. Rien pour le 08-14.** La phrase *« le prune nocturne ne tourne
plus »* était à un mot d'être écrite : un constat neuf, spectaculaire, et **faux** — qui aurait en
outre réorienté toute l'analyse du disque de la journée.

La vérification, en fenêtre serrée et **sans le filtre `_COMM`** :

```
Aug 14 00:40:01  CRON[944302]: (root) CMD (docker image prune -af --filter "until=24h" …)
Aug 14 00:40:05  CRON[944301]: pam_unix(cron:session): session closed for user root
```

**Il a tourné, en 4 secondes**, et `systemctl show cron` confirme `NRestarts=0` depuis le
2026-08-04. Le filtre `_COMM=cron` ne ramène pas toutes les lignes émises par `cron` : il en a
retenu **5 sur 7 jours** là où il y en a une par jour.

**Ce qui a rattrapé le coup** : avoir demandé la **fenêtre** avant de conclure sur l'**absence**.

**Leçon générale, et c'est la famille VPS-M08 / M22 / M34 sur un troisième objet** : *un filtre
qui sélectionne sans annoncer son dénominateur produit une absence, et une absence se lit comme un
fait.* La différence avec les précédents est que celui-ci n'était pas dans le collecteur — il
était dans une **vérification en marge**, exactement comme VPS-M12, et les vérifications en marge
sont précisément celles qui explorent l'inhabituel.

**Règle applicable telle quelle** : toute affirmation de la forme *« X n'a pas tourné »* doit être
établie par une **fenêtre temporelle sans filtre de champ**, jamais par l'absence d'un motif dans
une requête filtrée. Une présence prouve ; une absence dans un sous-ensemble ne prouve rien.

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
