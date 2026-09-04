# Roadmap de correction — VPS de production Tracky

> **Source** : les **26 fiches ouvertes** de [`REFERENCE-CONSTATS.md`](REFERENCE-CONSTATS.md) au
> 2026-09-04, plus le constat neuf du jour (5 boîtiers muets depuis plus de 7 jours).
> **Ordre** : par **gravité** (1 → 4), et à gravité égale par **rendement** — ce que ça rapporte
> pour ce que ça coûte.

---

## Comment lire ce fichier

Chaque tâche porte une **classe d'exécution**. C'est elle qui décide si un agent a le droit de
l'exécuter seul, et c'est le cœur de ce document : *une roadmap qui ne dit pas ce qu'on a le
droit de faire tout seul est une invitation à casser la production un dimanche.*

| Classe | Sens | Qui exécute |
|:--:|---|---|
| 🟢 **AUTO** | Additif, réversible, vérifiable immédiatement, **aucun impact production**. | L'agent, seul, et il **prouve** le résultat. |
| 🟡 **PRÉPARÉ** | L'agent **mesure, prépare et écrit la commande**, mais l'application demande un arbitrage. | Humain, après lecture. |
| 🔴 **HUMAIN** | **Destructif ou interrompt la production.** Jamais exécuté par un agent. | Humain, exclusivement. |
| 🔵 **PRODUIT** | Ce n'est pas une action sur le VPS. | Exploitant / équipe produit. |

> ⚠️ **La règle qui gouverne les classes.** Un agent qui a le droit de `prune` a le droit de se
> tromper de `prune`. Les classes 🔴 ne sont pas de la timidité : **VPS-002** a établi qu'on perd
> une machine en coupant un accès avant d'avoir prouvé le suivant, et **VPS-009** qu'une commande
> de nettoyage ne distingue pas un cache d'une base de données.

**Journal d'exécution** : en fin de fichier. Chaque tâche exécutée y porte sa **preuve**.

---

## Vue d'ensemble

| # | Fiche | G | Domaine | Titre court | Classe | État |
|--:|---|:-:|---|---|:--:|---|
| 1 | VPS-013 | **1** | sauvegardes | 3 bases de production sans aucune sauvegarde | 🟢 AUTO | ✅ **FAIT** |
| 2 | VPS-038 | 2 | données | 6 boîtiers muets depuis 86 h (flotte `2ad69ac1…`) | 🔵 PRODUIT | ⏳ (produit) |
| 2b | *(neuf)* | 2 | données | 5 boîtiers muets depuis > 7 j, dont 3 sans véhicule | 🔵 PRODUIT | ⏳ (produit) |
| 3 | VPS-012 | 2 | sécurité | Clé CI root **non restreinte**, 12 sessions/jour | 🟡 PRÉPARÉ | 🟡 PRÊT |
| 4 | VPS-015 | 2 | sauvegardes | La sauvegarde Verify n'a jamais tourné seule | 🟢 AUTO | ✅ **MESURÉ** — cause élargie |
| 5 | VPS-033 | 2 | sécurité | Mesure des correctifs perdue 9 fois sur 11 | 🟡 PRÉPARÉ | 🟡 PRÊT |
| 6 | VPS-M79 | 2 | méthode | Attribution au seul mécanisme visible | 🟢 AUTO | ✅ **FAIT** (manifeste) |
| 7 | VPS-M56 | 2 | méthode | Budget de collecte dépassé 18 fois | 🟢 AUTO | ✅ MESURÉ |
| 8 | VPS-036 | 2 | sécurité | Un tiers exécute des écritures root hors SSH | 🔵 PRODUIT | ⏳ (produit) |
| 9 | VPS-027 | 2 | sécurité | L'hyperviseur exécute du root toutes les heures | 🔵 PRODUIT | ⏳ (produit) |
| 10 | VPS-034 | 2 | sécurité | `traefik:latest` non épinglé sur 25 domaines | 🔴 HUMAIN | 🟡 **PRÊT** — digest relevé |
| 11 | VPS-020 | 2 | docker | Deux applications partagent le projet `deploy` | 🔴 HUMAIN | ⏳ |
| 12 | VPS-005 | 2 | docker | 30 conteneurs sur 33 sans limite mémoire | 🔴 HUMAIN | ⏳ |
| 13 | VPS-010 | 2 | sécurité | Noyau non redémarré, 6 services sur lib remplacée | 🔴 HUMAIN | ⏳ |
| 14 | VPS-M59 | 3 | méthode | `chargeDeFond.note` écrit et jamais affiché | 🟢 AUTO | ✅ **FAIT + BUILD VERT** |
| 15 | VPS-037 | 3 | sauvegardes | Copie hors-site à dépositaire unique | 🟡 PRÉPARÉ | ⏳ |
| 16 | VPS-030 | 3 | disque | 1,70 Go de dumps hors de toute rétention | 🟡 PRÉPARÉ | 🟡 **PRÊT** — 1,4 Go listés |
| 17 | VPS-026 | 3 | sauvegardes | `alpine:latest` retéléchargé un jour sur deux | 🟡 PRÉPARÉ | 🟡 **PRÊT** — digest relevé |
| 18 | VPS-017 | 3 | disque | 4,5 Go d'outillage de dev dans `/root` | 🔴 HUMAIN | ⏳ |
| 19 | VPS-029 | 3 | docker | Second mécanisme sur le cache de build | 🟡 PRÉPARÉ | ⏳ |
| 20 | VPS-032 | 3 | ordonnancement | Sessions SSH non comptées (×10 les jours de déploiement) | 🟢 AUTO | ✅ MESURÉ |
| 21 | VPS-011 | 3 | docker | Healthchecks = 1ʳᵉ source de forks | 🟡 PRÉPARÉ | ⏳ |
| 22 | VPS-035 | 3 | données | Débit d'ingestion — surveillance | 🟢 AUTO | ✅ MESURÉ |
| 23 | VPS-M36 | 3 | méthode | `wchan` échantillonné sert de preuve | 🟡 PRÉPARÉ | ⏳ |
| 24 | VPS-M73 | 3 | méthode | Passages manqués | 🟢 AUTO | ✅ MESURÉ |
| 25 | VPS-018 | 4 | disque | `/opt/vizyo-leads` parcouru chaque nuit (pile morte) | 🔴 HUMAIN | 🟡 **DÉBLOQUÉ** — distant vérifié |
| 26 | VPS-007 | 4 | données | `random_page_cost` = 4 sur 5 bases | 🟡 PRÉPARÉ | ⏳ (déconseillé) |

**Répartition** : 🟢 8 · 🟡 9 · 🔴 6 · 🔵 4.

---

# Gravité 1 — perte de données possible aujourd'hui

## 1. VPS-013 — Trois bases de production n'ont aucune sauvegarde exploitable — 🟢 AUTO

**27ᵉ passage.** `vizyo-manager` : dernière copie il y a **141 jours**. `texto-postgres` et
`capcom6-mysql` : **jamais aucune**.

**Pourquoi c'est gravité 1** : ces trois bases portent respectivement les abonnements Stripe, la
passerelle SMS (`allowlist_entries`, `messages`) et le relais Capcom6. Une corruption aujourd'hui
est **définitive**.

**Coût mesuré** : ~17,8 Mo/jour avant compression, sur **45 Go libres**.

```bash
docker exec texto-postgres pg_dump -U postgres vizyo_texto | gzip > /var/backups/vizyo-texto/texto_$(date +%Y%m%d-%H%M%S).sql.gz
```

⚠️ **À ne pas faire** : planifier à 03 h 00 ou 03 h 30 — créneaux de `tracky-backup` et
`vizyo-verify-backup`. **04 h 00 est libre.** Et **ne pas remettre un cron** : VPS-003 est né de
deux planificateurs pour la même sauvegarde.

**Ce que l'agent peut faire seul** : la **copie ponctuelle** — additive, vérifiable par relecture
de l'archive. **Ce qu'il ne peut pas** : poser le timer, qui est un mécanisme durable.

---

# Gravité 2 — dégradation certaine, ou garde de sécurité inopérante

## 2. VPS-038 — Six boîtiers muets depuis 86 heures — 🔵 PRODUIT

Cohorte **inchangée à 6**, flotte `2ad69ac1…`, dernières trames du **08-31 entre 11 h 53 et
13 h 50**. **Rien à faire sur le VPS** : la chaîne d'ingestion est saine, mesurée **deux fois**
par deux chemins de code indépendants (31 émetteurs sur `wire_logs`, 31 traceurs sur `positions`).

**L'action est un appel à l'exploitant**, avec les six IMEI et l'heure de leur dernière trame :

```
864035054757027  08-31 11:53      864035054756102  08-31 13:15
864035054756755  08-31 12:30      864035054756714  08-31 13:50
864035054756763  08-31 12:48      864035054489431  08-31 13:50
```

⚠️ **À ne pas faire** : lire « 14 muets » contre « 12 hier » comme une extension (**VPS-M78**),
ni conclure sur la cause depuis les données du VPS (**VPS-M01**).

**Échéance écrite d'avance** : la seconde branche du seuil de réescalade — *absence de retour au
passage du 2026-09-05* — **arrive à échéance demain**.

## 2b. Cinq boîtiers muets depuis plus de sept jours — 🔵 PRODUIT

Constat **neuf du 2026-09-04**, révélé par la ventilation de VPS-M78.

| IMEI | dernière vue | silence | rattachement |
|---|---|---:|---|
| `864035054756177` | 08-21 12:43 | 13,6 j | flotte `2ad69ac1…` |
| `864035054756730` | 08-19 11:34 | 15,6 j | flotte `2ad69ac1…` |
| `864035053277480` | 08-14 02:05 | 21,0 j | flotte `88627f81…` |
| `864035054756292` | 07-01 08:16 | **64,8 j** | **aucun véhicule** |
| `863378070030776` | 06-05 11:45 | **90,6 j** | **aucun véhicule** |

Ils valent **11 des 32 points** de « flotte muette » affichés en permanence. Décision **produit** :
un statut de sortie de parc.

⚠️ **À ne pas faire** : `DELETE FROM trackers`. Un boîtier supprimé perd son historique de
rattachement, et un incident devient irreconstituable six mois plus tard.

## 3. VPS-012 — Clé de CI root non restreinte, en usage quotidien — 🟡 PRÉPARÉ

**L'urgence a monté le 2026-09-04** : `github-actions-vizyo-auth` est passée de `connexions=0` à
**12 sessions root en 21 heures**, depuis douze adresses Azure, et elle a déployé `vizyo-auth` à
00 h 57. Elle ne porte **aucune** des quatre options posées le 2026-08-04 sur l'autre clé de CI.

**Le geste** — poser `no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-user-rc` :

```bash
cp -a /root/.ssh/authorized_keys /root/.ssh/authorized_keys.avant-vps012-$(date +%Y%m%d)
```

```bash
grep -n 'github-actions-vizyo-auth' /root/.ssh/authorized_keys   # relever la ligne AVANT toute modification
```

> ### 🔴 Pourquoi ceci n'est PAS 🟢 AUTO, alors que le geste est trivial
>
> **L'ordre des étapes est ce qui protège la machine, et il n'est pas automatisable.** Une faute
> de frappe dans `authorized_keys` ne casse pas seulement cette clé : elle peut rendre **tout
> accès root SSH impossible**, sur une machine dont c'est la seule porte. La séquence sûre exige
> de **garder la session courante ouverte** pendant qu'on en ouvre une seconde pour vérifier — ce
> qu'un agent qui rend la main entre deux commandes ne peut pas garantir.
>
> *C'est exactement VPS-002 : couper l'accès avant d'avoir prouvé le suivant, c'est perdre la
> machine.*

⚠️ **À ne pas faire** : **retirer la clé** — elle sert **tous les jours**, c'est désormais mesuré,
et elle déploie l'authentification de **toutes** les applications. ⚠️ **Ni poser `command="…"`** :
VPS-012 l'a mesuré le 08-04, les workflows envoient des scripts multi-lignes qu'un `command=`
remplacerait tous. ⚠️ **Ni restreindre la clé humaine `vizyo-vps-hostinger`** : elle est
**volontairement** non restreinte depuis le 08-04, son 🟠 est le comportement voulu du détecteur.

## 4. VPS-015 — La sauvegarde de Vizyo Verify n'a jamais tourné toute seule — 🟢 AUTO (vérification)

Vérifiable sans rien modifier : l'unité systemd rend-elle succès, l'archive se relit-elle, le
contenu est-il chiffré, et la copie hors-site suit-elle ?

## 5. VPS-033 — La mesure des correctifs est perdue 9 fois sur 11 — 🟡 PRÉPARÉ

Le canal **fonctionne** — prouvé le 09-03, 34 paquets installés, compte 109 → 75. C'est la
**mesure** qui est perdue, parce que `apt-daily.timer` tire son heure au hasard dans 12 heures et
que le cache a presque toujours plus de 6 h au moment de l'audit.

```bash
systemctl edit apt-daily.timer   # [Timer] / RandomizedDelaySec=30m
```

**Contrepartie réelle** : le délai aléatoire **étale la charge sur les miroirs Ubuntu**. Le
réduire sur **une** machine est sans effet mesurable ; le généraliser ne le serait pas. Préférer
`30m` à `0`.

⚠️ **Pourquoi 🟡 et non 🟢** : un `systemctl edit` malformé fait **échouer le chargement du
timer**, donc supprime le rafraîchissement `apt` au lieu de le rendre déterministe — on
remplacerait une mesure perdue par un mécanisme perdu.

## 6. VPS-M79 — Une disparition attribuée au seul mécanisme visible — 🟢 AUTO (volet manifeste)

**Volet manifeste** — chaque entrée d'`ordonnancement` porte un champ `trace` (*journalisée /
silencieuse / autodétruite*) et l'interdiction d'attribuer un fait à une entrée `silencieuse`
sans seconde source.

**Volet VPS : 🔴 non exécutable**, il modifierait le cron de nettoyage :

```bash
docker image prune -af --filter "until=24h" --filter "label!=repli=1"   # exige d'ETIQUETER les images de repli au build
```

⚠️ **À ne pas faire** : exempter sans borne. Toute image soustraite au ménage revient dans le
poste « Images » — **25,33 Go** — et ce ménage est ce qui le tient. **Une exemption non bornée
rejoue VPS-001.**

## 7. VPS-M56 — Le budget de collecte — 🟢 AUTO (mesure)

**18ᵉ dépassement, et le plus faible jamais mesuré** : 96 s pour 90 s (**1,1×**), charge
0,16 → 1,71 **sous** la limite de 2. Aucune action : le constat se surveille.

**Seuil de réescalade** : repasser en aggravation si la durée dépasse **135 s (1,5×)** ou si la
charge finale repasse **au-dessus de 2** deux passages de suite.

## 8-9. VPS-036 et VPS-027 — L'hyperviseur agit en root — 🔵 PRODUIT

Aucun ordre d'écriture neuf au 2026-09-04, cadence stable à **52/jour**. Le ticket reste à ouvrir
auprès de l'hébergeur : **paternité**, **cadence**, puis **la liste des actions que ce canal
s'autorise sans préavis**.

⚠️ **À ne pas faire** : désactiver `qemu-guest-agent` (c'est le canal de support de l'hébergeur),
ni démasquer `multipathd` par réflexe (l'acte du 09-01 est défendable, le script teste avant
d'agir).

## 10. VPS-034 — `traefik:latest` non épinglé — 🔴 HUMAIN

Le composant qui termine le TLS de **25 domaines** et qui **monte `/run/docker.sock`** tourne sur
une étiquette flottante.

```bash
docker inspect foodsqan-traefik --format '{{.Image}}'   # relever le digest ACTUEL avant tout
```

⚠️ **🔴 parce qu'appliquer l'épinglage recrée le conteneur** — et ce conteneur tient les ports
**80 et 443 de toute la production**, 25 domaines, sept applications. À faire en fenêtre annoncée.

## 11. VPS-020 — Deux applications partagent le projet `deploy` — 🔴 HUMAIN

`maestroo-dev-*` et `vizyo-manager-*` partagent le même projet compose : **un `docker compose
down` dans l'un arrête l'autre.** Corriger exige de recréer les conteneurs sous un nouveau nom de
projet — donc une interruption des deux applications.

## 12. VPS-005 — 30 conteneurs sur 33 sans limite mémoire — 🔴 HUMAIN

**0 OOM en 30 jours** : pas d'urgence, mais le jour où il y en aura une, **le choix de la victime
ne nous appartiendra pas** — l'OOM killer choisit sur un score de mémoire, pas sur l'importance
métier.

⚠️ **Contrepartie réelle** : une limite trop basse transforme une fuite lente en **redémarrage en
boucle**. Commencer par les trois conteneurs déjà limités comme référence.

## 13. VPS-010 — Noyau non redémarré — 🔴 HUMAIN

Noyau actif `6.8.0-136`, installés `-137` et `-138`. **6 services tournent sur une bibliothèque
remplacée, dont `docker.service`** — conséquence datée de l'installation du 09-02.

⚠️ **Vérifier AVANT tout redémarrage** : les 33 conteneurs sont en `unless-stopped` — mesuré le
2026-09-04. **Dans l'autre ordre, on redémarre une machine dont on ne sait pas si la production
remonte seule.**
⚠️ **Ne pas compter la mémoire dans la justification** : VPS-014 l'a mesuré, le gain dure **cinq
heures**.

---

# Gravité 3 — gaspillage mesurable, sans risque immédiat

## 14. VPS-M59 — `chargeDeFond.note` écrit à chaque passage et affiché nulle part — 🟢 AUTO

**9ᵉ report, et il sortait à chaque fois « hors de portée de l'agent ».** Il ne l'est pas : c'est
une ligne de gabarit dans notre propre dépôt.

Le champ est **déclaré** (`note?: string`), **écrit à chaque passage** — il porte les
avertissements de VPS-M68 et VPS-M78, c'est-à-dire *précisément les phrases qui empêchent de mal
lire les deux chiffres affichés juste au-dessus* — et **aucun gabarit ne le rend**.

## 15. VPS-037 — Copie hors-site à dépositaire unique — 🟡 PRÉPARÉ

Elle tient son seuil (**21 h**, 15 copies) mais dépend toujours d'un **unique poste de travail** —
le même que celui qui porte la planification de cet audit.

⚠️ **À ne pas faire** : remonter le seuil de 48 h pour éteindre l'alerte.

## 16. VPS-030 — 1,70 Go de dumps hors de toute rétention — 🟡 PRÉPARÉ

```bash
ls -1t /root/backups/tracky-avant-graphiques-*.sql.gz | tail -n +2
```

⚠️ **À ne pas faire** : `rm -rf /root/backups` — le dossier porte aussi les **seules copies** d'un
état de Maestroo. ⚠️ **Ni toucher à** `/opt/backups/tracky/positions-avant-purge60j-*` : 57 Mo
pour la **seule trace connue** des lignes purgées le 2026-07-21.

**🟡 et non 🔴** parce que la commande ci-dessus **ne supprime rien** : elle *liste* ce qui serait
supprimé. La suppression, elle, est 🔴.

## 17. VPS-026 — `alpine:latest` retéléchargé un jour sur deux — 🟡 PRÉPARÉ

**Cause prédictive 16 fois sur 16.** Le ménage de 00 h 40 supprime l'image dès qu'elle dépasse
24 h ; la sauvegarde des **pièces d'identité** de Vizyo Verify la retélécharge à 03 h 31 depuis
Docker Hub. **Une sauvegarde de données personnelles dépend d'un tiers joignable.**

Le correctif est d'**épingler l'image par digest** dans le script de sauvegarde — donc de modifier
`/opt/vizyo-verify/deploy/vps/backup.sh` sur le VPS.

## 18. VPS-017 — 4,5 Go d'outillage de dev dans `/root` — 🔴 HUMAIN

`/root/.local`, `.npm`, `.cache`, `.claude` — ~155 000 inodes sur un serveur de production.
Destructif, et certains caches sont utilisés par l'outillage en place.

## 19. VPS-029 — Second mécanisme sur le cache de build — 🟡 PRÉPARÉ

Deux règles de ramasse-miettes coexistent (`keepStorage: 8GB / unused-for=48h` et
`keepStorage: 10GB / all`), **posées et réécrites par le déployeur**. Le cache est à **10,66 Go**
au 2026-09-04, *au-dessus* du plafond de 10 Go — attendu juste après 4 builds, à surveiller s'il
y reste **sans build récent**.

## 20. VPS-032 — Sessions SSH non comptées — 🟢 AUTO (mesure)

**9 383 sur 7 jours**, et **4 528 le seul 09-03** contre 450 la veille. À ~54 processus par
session, un jour de déploiement vaut **~244 000 forks** — soit **2,6 fois** la charge quotidienne
des sondes de santé. *Un jour de déploiement est la première source de forks de la machine,
devant les healthchecks.*

## 21. VPS-011 — Healthchecks, 1ʳᵉ source de forks — 🟡 PRÉPARÉ

**65 invocations/min, ~93 600/jour, 24 conteneurs sondés sur 33.** Neuf n'ont **aucune** sonde,
dont `foodsqan-traefik` (ports 80/443), `tracky-web` et `tracky-lp`.

⚠️ **Contrepartie chiffrée** : chaque sonde ajoute ~5 processus par invocation. **Ne sonder que ce
qui sert du trafic**, à 60 s — pas les six conteneurs de développement.

## 22-24. VPS-035, VPS-M36, VPS-M73 — surveillance

- **VPS-035** : débit d'ingestion **stable** (×0,98 contre la veille, ×0,83 contre J-7 — effet de
  calendrier, jeudi contre jeudi). Aucune action.
- **VPS-M36** : le `wchan` est un **échantillon** et sert de preuve sur VPS-016. Sans objet tant
  que `dockerd` est éteint (18ᵉ jour) — **à rouvrir à la 5ᵉ occurrence**.
- **VPS-M73** : passages manqués (08-27 → 08-31). Le journal des passages le montre ; c'est le
  comportement voulu — *un jour manqué se voit, un doublon silencieux non*.

---

# Gravité 4 — bruit, cosmétique, méthode

## 25. VPS-018 — `/opt/vizyo-leads` parcouru chaque nuit — 🔴 HUMAIN

**823 Mo, pile supprimée le 2026-08-04**, et **12,9 % du parcours de `/opt`** chaque nuit
(2,9 s sur 22,8 s, mesuré ce passage).

```bash
rm -rf /opt/vizyo-leads
```

⚠️ **Vérifier d'abord que le dépôt distant existe.** ⚠️ Et **ne pas comparer** cette part à celle
d'un autre passage sans regarder les durées : froid et chaud diffèrent d'un facteur ~20
(**VPS-M18**).

## 26. VPS-007 — `random_page_cost` = 4 sur 5 bases — 🟡 PRÉPARÉ

⚠️ **L'audit recommande de NE PAS le faire pour le gain.** Le gain de production réel se limite à
`vizyo-manager-postgres` et `texto-postgres`, **toutes deux sous 10 Mo, en cache à 100 %** : il
n'y a pas de lecture disque à optimiser. *Un gain non mesurable n'est pas un gain.* Listé **pour
être vu, pas pour être fait**.

---

# Journal d'exécution — 2026-09-04

## ✅ T1 · VPS-013 — les trois sauvegardes manquantes existent

**Exécuté.** Trois archives créées, et **vérifiées deux fois** — parce qu'un dump « complet »
peut être une coquille vide (mauvais utilisateur, aucun droit) :

| base | archive | intégrité | **données confrontées à la base VIVANTE** |
|---|---|---|---|
| `vizyo_texto` | 69 K, 1 895 lignes | ✅ se relit, marqueur de fin présent | 7 tables ; `allowlist_entries` **47 en base = 47 dans le dump** |
| `vizyo_manager` | 7,6 K, 654 lignes | ✅ se relit, marqueur de fin présent | 8 tables ; `users` **7 en base = 7 dans le dump** |
| `sms` (capcom6) | 15 K, 1 081 lignes | ✅ se relit, `Dump completed` | 9 tables `CREATE`, 7 `INSERT` |

> 🔐 **Le mot de passe MariaDB n'a jamais quitté le conteneur** : il est lu par
> `sh -c 'mariadb-dump -p"$MARIADB_ROOT_PASSWORD" …'` **à l'intérieur**, donc il n'apparaît ni
> dans la ligne de commande de l'hôte — celle que l'hyperviseur exfiltre chaque heure par
> `ps -eo … command` (**VPS-027**) — ni dans aucune sortie de ce rapport.

⚠️ **Ce qui reste ouvert, et il ne faut pas le confondre avec ce qui est fait** : c'est une copie
**ponctuelle**. Aucun timer n'a été posé, donc **ces trois bases seront de nouveau périmées
demain**. *Fermer un symptôme n'est pas fermer sa cause* — VPS-015 et VPS-037 l'ont chacun
démontré. La fiche **reste `A_TRAITER`**.

## ✅ T2 · VPS-M59 — la note s'affiche, et une garde manquante a été trouvée en chemin

**9ᵉ report, classé « hors de portée de l'agent » à chaque fois. Il ne l'était pas.**

**Et le passage a trouvé mieux que ce qu'il cherchait.** En ouvrant le gabarit :

```
@if (idx.previsions; as p) {          ← la SEULE garde existante
  …
  {{ p.chargeDeFond.healthchecksParMinute }}   ← AUCUNE garde sur chargeDeFond
```

> 🔴 **La garde que tout le monde croyait posée n'existait pas.** La note interne du projet
> affirme que « le gabarit a depuis été gardé, donc l'oublier ne casse plus rien ». **C'est faux
> pour ce fichier** : un passage qui n'écrirait pas `previsions.chargeDeFond` referait tomber
> **toute la carte Prévisions, tableau du disque compris** — c'est-à-dire **TRK-033 à
> l'identique**. Le service API sert le JSON **brut, sans aucune validation** (vérifié) : le type
> TypeScript est exactement *« une promesse que le compilateur n'a aucun moyen de tenir »*.

**Deux correctifs, donc** : la garde `@if (p.chargeDeFond; as cf)` **avec une branche `@else`**
qui dit *« mesure absente du manifeste — ce n'est PAS “aucune charge de fond” »*, et le rendu de
`note`.

**Vérifié à quatre niveaux** — et le premier a **échoué**, ce qui est le seul intérêt de l'avoir
lancé :

| contrôle | résultat |
|---|---|
| `tsc --noEmit` | 🔴 **13 erreurs** au 1ᵉʳ jet → puis ✅ |
| `ng build` (compilateur Angular, seul juge du `@if`/`@else`) | ✅ `NG_EXIT=0`, 14,1 s |
| présence dans le **bundle servi** | ✅ `chunk-K4HBXQ56.js` porte le repli **et** `fond-note` |
| 5 garde-fous maison (`accents`, `littéraux`, `contraste`, `couleurs-kit`, `variables`) | ✅ 5/5 |

> ⚠️ **Ce qui a échoué au premier jet, et c'est un piège déjà documenté trois fois dans ce
> référentiel.** Mes commentaires citaient le code entre **accents graves**. Le gabarit Angular
> est un *template literal* : **un seul accent grave y ferme la chaîne et décapite le composant
> entier.** 13 erreurs `TS1005/TS1109/TS1443`. *C'est la quatrième fois que ce piège se referme
> sur ce projet (VPS-M50), et la première fois qu'il est attrapé avant publication — parce que le
> typecheck a été lancé au lieu d'être supposé.* Le commentaire porte désormais son propre
> avertissement.

⚠️ **NON DÉPLOYÉ.** Le correctif est dans le worktree et commité ; il ne sera **visible sur
`/admin/vps` qu'après un build et un déploiement de `tracky-web`**, qui est une décision humaine.
⚠️ **Non vérifié visuellement** : le rendu exige une session admin authentifiée contre l'API.
Compilé, empaqueté et contrôlé — *pas* regardé.

## ✅ T3 · VPS-015 — le symptôme tient, la cause est intacte, et elle est **plus large** qu'écrit

**Le symptôme reste fermé** : le timer a déclenché **7 jours distincts d'affilée** (08-29 →
09-04, dernier à 03 h 30 min 30), 30 archives, **toutes chiffrées**, dossier `700`.

**Mais la cause, vérifiée directement ce passage, n'a pas bougé** :

```
ExecStart=/opt/vizyo-verify/deploy/vps/backup.sh     ← toujours le script EN DIRECT
OnFailure=                                            ← ABSENT
-rwxrwxr-x  backup.sh (Aug 12 07:10)                  ← le bit +x qu un scp -r sans -p reperdra
```

> 🆕 **Et la même question, posée pour la première fois à `tracky-backup`, rend le même
> résultat** : `ExecStart=/opt/vizyo-tracky/deploy/vps/backup-db.sh`, **aucun `OnFailure=`**.
> *C'est la sauvegarde de `tracky_prod` — 5,7 Go, 41 copies, la base de production principale —
> et son échec n'alerte personne non plus.* Le constat ne visait Vizyo Verify que parce que
> **personne n'avait posé la question à l'autre unité.**

**Délai de détection d'un échec : ~23 h par construction, pour les DEUX sauvegardes.**

## ✅ T4 · Préparations — quatre tâches passées de « à faire » à « prêt à appliquer »

Toutes en **lecture seule**. Elles capturent les valeurs qu'il faut relever *avant* d'agir — la
partie qu'on oublie et qui rend le geste irréversible.

| fiche | ce qui manquait | relevé le 2026-09-04 |
|---|---|---|
| **VPS-034** | le digest à épingler | `traefik@sha256:82d3d16dde0474a51fef00b28de143d48b67f7a27453224d5e7b5aaefff26a97` |
| **VPS-026** | le digest **et** la ligne à modifier | `alpine@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b` — lignes **163 et 165** de `/opt/vizyo-verify/deploy/vps/backup.sh` |
| **VPS-030** | ce qui serait réellement supprimé | **10 fichiers, 1,4 Go** ; conservé : `tracky-avant-graphiques-20260819-030105.sql.gz` |
| **VPS-018** | la précondition « le dépôt distant existe-t-il ? » | ✅ `git@github-leads:vizyoagency-create/vizyo-leads.git`, **0 modification non commitée** |

> **VPS-018 change de nature.** La suppression était bloquée depuis le 2026-08-04 sur une
> précondition que **personne n'avait vérifiée**. Elle est vérifiée : le code est sur un dépôt
> distant et rien n'est en attente localement. **823 Mo et 12,9 % du parcours nocturne de `/opt`**
> ne dépendent plus que d'un `rm -rf` humain.

---

# ⚠️ POUR L'AGENT D'AUDIT DE DEMAIN (2026-09-05)

**À traiter en priorité, dans cet ordre :**

### 1. 🔴 Le test de VPS-038 arrive à échéance AUJOURD'HUI

Le seuil écrit le 09-03 avait deux branches. La première (*un septième boîtier de la flotte
`2ad69ac1…`*) n'est pas atteinte. **La seconde — *absence de retour au passage du 2026-09-05* —
échoit à ton passage.** Si les six sont toujours muets : **VPS-038 monte, et il faut le dire.**

⚠️ **Ne le tranche PAS sur le total du registre.** Regarde la **bande `3-7 j`** de la ventilation
(VPS-M78) : c'est la seule grandeur comparable d'un passage à l'autre. Le total monte quand un
véhicule se gare.

### 2. 🔴 VPS-013 est REFERMÉ mais pas RÉGLÉ — le vérifier explicitement

Trois sauvegardes ponctuelles ont été créées le 2026-09-04 vers 04 h 52. **Aucun timer n'a été
posé.** Ton passage doit donc voir :

```
vizyo-manager   ~1 j       ← et non 141 j
vizyo-texto     ~1 j       ← dossier NEUF, cree ce passage
capcom6         ~1 j       ← dossier NEUF, cree ce passage
```

⚠️ **Si tu lis « à jour » et que tu classes VPS-013 résolu, tu te trompes** : l'âge repartira à la
hausse d'un jour par jour. **Le constat reste `A_TRAITER` jusqu'à ce qu'un timer existe**, et le
créneau libre est **04 h 00** (03 h 00 et 03 h 30 sont pris).

### 3. 🟠 VPS-015 a doublé de périmètre — le collecteur ne le voit toujours pas

`tracky-backup` **n'a pas d'`OnFailure=`** non plus, et personne ne l'avait jamais vérifié.

*Piste concrète, gratuite* : le bloc « L'unité qui PRODUIT chaque sauvegarde a-t-elle réussi ? »
lit déjà chaque unité. **Lui faire afficher `OnFailure=` présent/absent** coûte un
`systemctl show -p OnFailure` par unité — trois appels, aucune E/S disque.

### 4. 🟠 Vérifier que le correctif VPS-M59 est **déployé**, pas seulement commité

Le gabarit est corrigé et le build est vert, **mais `tracky-web` n'a pas été redéployé**. Tant
qu'il ne l'est pas, `/admin/vps` affiche encore l'ancienne version : **sans la note, et sans la
garde**.

**Test écrit d'avance** : *ouvrir `/admin/vps` → carte « Prévisions ». Si le bloc jaune
« Charge de fond » n'est **pas** suivi d'un second encadré portant le texte de
`previsions.chargeDeFond.note`, alors le déploiement n'a pas eu lieu — et il ne faut pas
conclure que le correctif ne marche pas.*

### 5. 🟢 Quatre tâches sont prêtes à appliquer — leurs valeurs sont déjà relevées

VPS-034, VPS-026, VPS-030 et VPS-018 (voir le journal ci-dessus). **Ne pas les re-préparer** :
seuls les digests sont à re-relever s'ils ont changé.

⚠️ **Et vérifier que `traefik` tourne toujours sur le même digest.** S'il a changé sans qu'on ait
rien fait, c'est que l'étiquette flottante a bougé sous la production — **ce qui est exactement le
risque décrit par VPS-034**, et ce serait la première preuve directe qu'il se réalise.

### 6. ⚠️ Ce que ce passage a écrit sur le VPS — à savoir avant de lire les chiffres

Contrairement à un passage d'audit ordinaire, **celui du 2026-09-04 n'a pas été en lecture
seule.** Il a créé :

- `/var/backups/vizyo-texto/` et `/var/backups/capcom6/` (dossiers **neufs**, `700`) ;
- trois archives, **~91 Ko au total** ;
- une archive de plus dans `/var/backups/vizyo-manager/` (26 au lieu de 25).

**Aucune suppression, aucun redémarrage, aucune modification de configuration.** Si un compteur de
sauvegardes ou de dossiers bouge dans ton passage, **c'est ça** — et ce n'est pas une dérive.
