# Procédure d'audit VPS

Ce que l'audit fait, dans quel ordre, et pourquoi. Écrit pour que **n'importe qui** (humain ou
agent) puisse refaire le même passage et obtenir des chiffres comparables.

---

## 0. Les garde-fous, avant tout le reste

| Règle | Pourquoi |
|---|---|
| **Lecture seule, sans exception.** | Un audit qui modifie ce qu'il mesure ne mesure plus rien. Et un agent qui a le droit de `prune` a le droit de se tromper de `prune`. |
| **Aucune commande de remédiation n'est exécutée.** | Elles sont **écrites dans le rapport**, avec leur gain, leur risque et leur contrepartie. Un humain les lit, puis décide. |
| **Chaque chiffre porte sa source.** | Sinon on ne peut ni le vérifier, ni le reproduire, ni comprendre pourquoi il a changé. |
| **Ce qui va bien se dit aussi.** | Un rapport qui ne liste que des problèmes empêche de voir qu'un problème a disparu. |
| **Tout parcours de disque est borné.** | Sur 2 vCPU, un `du /` non borné fausse la mesure de charge qu'il est censé produire. |

> ⚠️ **Les seules écritures autorisées**, et elles sont toutes dans `docs/vps-audit/` : mettre à
> jour le rapport, le référentiel et le manifeste dans le dépôt local, **copier** le dossier vers
> `/opt/tracky-vps-audit` sur le VPS (§8 — un dossier dédié, hors de l'arbre git du serveur), et
> **committer ce seul chemin** (§8 bis). Aucun `git push`, aucune autre écriture sur le VPS,
> aucun fichier hors de `docs/vps-audit/`.

---

## 1. Collecter

```bash
ssh root@72.62.26.240 'bash -s' < docs/vps-audit/collecte.sh > /tmp/collecte.txt
```

Une seule passe. Le script couvre neuf domaines dans cet ordre : identité et charge, mémoire,
disque, Docker, données, sécurité, planification, journaux, historique 7 jours.

### Le coût de l'audit — un engagement, pas une estimation

**Mesuré le 2026-08-04 : 59 secondes, charge passée de 0,38 à 1,31 sur 2 cœurs.**
Soit un pic à ~65 % d'un cœur, sur une machine qui en a deux.

Trois décisions rendent ce chiffre possible, et **il faut les préserver** :

1. **Tout parcours de disque passe par `nice -n 19 ionice -c3`** (variable `$LOW`). Classe
   d'E/S « idle » : le collecteur ne lit que lorsque plus personne n'attend le disque. Un
   `du` en priorité normale sur 2 vCPU ralentit les services qu'il est censé surveiller.
2. **`/var/lib/docker/rootfs` et `overlay2` ne sont PAS parcourus.** Ce sont ~12 Go de couches
   empilées, plusieurs minutes d'E/S soutenues — pour un chiffre que `docker system df` donne
   gratuitement. La première version les parcourait : elle mettait 3 à 5 minutes.
3. **Aucune boucle, aucune reprise, aucun démon.** Le script s'exécute une fois, de haut en
   bas, et rend la main. Il ne s'installe pas sur la machine.

> ⚠️ **Si une future version dépasse ~90 secondes ou fait monter la charge au-dessus de 2**,
> c'est un défaut à corriger avant de l'utiliser — consignez-le en `VPS-M<n>`. Un audit qui
> pèse sur la production n'est plus un audit, c'est une charge de plus.

### Où tourne la planification (et pourquoi pas sur le VPS)

La tâche quotidienne est planifiée **côté poste de travail** (tâche Claude Code), pas sur le
VPS. C'est délibéré :

- Le VPS ne gagne **aucun** processus, aucun cron, aucun timer.
- Il n'y a **qu'un seul planificateur**, donc pas de doublon possible. C'est exactement le
  défaut VPS-003 (deux planificateurs pour la même sauvegarde, deux `pg_dump` concurrents à
  3 h du matin) : ne pas le reproduire ici.
- Si le poste est éteint, l'audit ne tourne pas — et c'est acceptable : un jour manqué se voit
  dans le journal des passages, alors qu'un doublon silencieux ne se voit nulle part.

**Vérifier que la collecte est complète avant d'analyser** : le script se termine par
`FIN DE COLLECTE`. S'il manque, une section a été tronquée — relancer plutôt qu'interpréter.

---

## 2. Lire l'historique AVANT l'instantané

C'est l'étape que l'on saute le plus volontiers, et c'est celle qui évite les faux diagnostics.

La section 9 du collecteur donne 7 jours de `sysstat`. **Un pic n'est un problème que s'il ne
s'explique pas.** Exemple du 2026-08-04 : la charge atteint 13,47 sur 2 cœurs le 08-03 — ce qui
ressemble à une machine en détresse. Mais l'écriture disque du même jour passe à 2 840 blocs/s
contre 20 les jours calmes : c'est un build Docker, pas une dérive. Sans l'historique, ce pic
serait devenu un constat de gravité 1 — faux.

**Règle** : pour tout chiffre inquiétant relevé à l'instant T, chercher d'abord s'il est
habituel. `sysstat` garde 7 jours ; au-delà, la comparaison se fait entre rapports (les
`chiffres` du manifeste, cf. §6).

---

## 3. Relire les rapports précédents

Avant d'écrire quoi que ce soit :

1. Lire `REFERENCE-CONSTATS.md` **en entier**. Un constat déjà connu ne redevient pas neuf.
2. Lire le dernier rapport de `rapports/`, en particulier sa section **« Améliorer l'agent »** —
   elle contient les angles morts identifiés au passage précédent, à couvrir cette fois.
3. Comparer les `chiffres` du manifeste (`passages[]`) avec ceux du jour : c'est la seule
   source de tendance au-delà de 7 jours.

Pour chaque constat existant, trancher : **toujours vrai** (mettre à jour `vuDerniere` et la
mesure), **résolu** (passer en `APPLIQUE`, avec la preuve), ou **aggravé** (monter la gravité,
dire de combien).

---

## 4. Classer, pas seulement lister

Un constat n'entre au référentiel que s'il répond aux trois questions :

- **QUAND** — depuis quand, vu combien de fois, avec quelle mesure ;
- **QUOI** — la **cause**, pas le symptôme. « Le disque est plein » n'est pas une cause ;
  « le cache de build n'est purgé par aucune tâche » en est une ;
- **QUOI FAIRE** — l'action à l'impératif, précise au point d'être applicable sans refaire
  l'enquête, **avec son gain chiffré et sa contrepartie**.

Deux champs supplémentaires font la différence entre un rapport utile et une liste :

- **`pourquoiInvisible`** — pourquoi personne ne l'avait vu. C'est presque toujours plus
  instructif que le défaut lui-même : VPS-001 était invisible *parce qu'une tâche de nettoyage
  existait et réussissait*.
- **`aNePasFaire`** — le piège adjacent. VPS-009 : « ne pas lancer `docker volume prune` », parce
  que la commande ne distingue pas un cache d'une base de données.

### Gravité

| Niveau | Critère |
|---|---|
| 1 | Perte de données, indisponibilité ou intrusion **possible aujourd'hui**. |
| 2 | Dégradation certaine à court terme, ou garde de sécurité inopérante. |
| 3 | Gaspillage mesurable, sans risque immédiat. |
| 4 | Bruit, cosmétique, ou constat de méthode. |

> **`SURVEILLANCE` exige un seuil de réescalade.** Sans seuil écrit, « on surveille » veut dire
> « on ne fera rien et on ne saura pas quand s'en inquiéter ». VPS-005 : *passer en `A_TRAITER`
> si la mémoire moyenne dépasse 60 %, ou au premier OOM.*

---

## 5. Écrire le rapport

`docs/vps-audit/rapports/AAAA-MM-JJ.md`, dans cet ordre :

1. **Verdict** — un encadré de trois phrases. Ce qu'on lit même quand on ne lit rien d'autre.
2. **Tableau par domaine** — 🟢 / 🟠 / 🔴 et une phrase chacun.
3. **Ce qui va bien** — avec les chiffres qui le prouvent.
4. **Un chapitre par domaine en défaut** — mesure, cause, pourquoi c'était invisible, commande.
5. **Plan d'action par ordre de rendement** — gain, risque, durée. Pas par ordre de gravité :
   par ordre de *ce que ça rapporte pour ce que ça coûte*.
6. **Améliorer l'agent** (§7 ci-dessous).

**Les commandes vont dans des blocs séparés, une par bloc**, précédées de leur effet et de leur
risque. Un bloc = une décision. Une suite de commandes collée d'un bloc est une suite de
décisions non prises.

Quand l'ordre compte, le dire **et** dire ce qu'on risque à l'inverser (cf. VPS-002 : couper
les mots de passe avant d'avoir prouvé que la clé fonctionne, c'est perdre la machine).

---

## 6. Mettre à jour le manifeste

`app/wiki.json` — la partie qui ne se devine pas du disque :

- **`fiches`** : une entrée par constat. C'est ce que l'écran affiche en tableau de bord.
- **`passages`** : ajouter le passage **en tête** (le plus récent d'abord), avec `verdict`,
  `chiffres` et `aTraiter`.
- **`documents`** : facultatif — un rapport non déclaré s'affiche quand même, avec un titre
  dérivé de son nom. C'est délibéré : un oubli de déclaration ne doit jamais rendre un rapport
  invisible.

**Les `chiffres` sont la mémoire longue des tendances.** `sysstat` oublie au bout de 7 jours ;
ces valeurs, non. Garder les mêmes clés d'un passage à l'autre — une clé renommée casse la
comparaison sans prévenir.

### Vérifier le manifeste avant de publier (obligatoire)

Le champ `ancre` de chaque fiche doit correspondre exactement au titre du référentiel, tel que
`slugifyHeading` le transforme. Écrites à la main, **les 12 ancres du premier passage étaient
fausses** (accents conservés, double tiret) : douze liens morts, et aucune erreur nulle part
pour le signaler (VPS-M03).

Cette commande les **dérive** de la source et corrige le manifeste :

```bash
node -e "
const fs=require('fs');
const slug=t=>t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^\w\s-]/g,'').trim().replace(/\s+/g,'-');
const md=fs.readFileSync('docs/vps-audit/REFERENCE-CONSTATS.md','utf8');
const parId=new Map();
for (const [,t] of md.matchAll(/^#{2,3} (.+)$/gm)) { const id=t.match(/^(VPS-[A-Z0-9]+)/); if (id) parId.set(id[1], slug(t)); }
const p='docs/vps-audit/app/wiki.json', j=JSON.parse(fs.readFileSync(p,'utf8'));
let n=0; for (const f of j.fiches) { const a=parId.get(f.id); if (a && a!==f.ancre) { f.ancre=a; n++; } }
fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n');
console.log(n+' ancres corrigees | fiches sans titre: '+(j.fiches.filter(f=>!parId.has(f.id)).map(f=>f.id).join(',')||'aucune'));
"
```

Elle signale aussi les fiches **sans titre correspondant** dans le référentiel — c'est-à-dire
un constat déclaré au manifeste mais que personne n'a documenté.

---

## 6 bis. Les leviers d'optimisation — sept, et une règle

La **section 11** du collecteur affiche sept leviers, chacun avec sa valeur actuelle, la valeur
visée et un verdict. Ce n'est pas une liste de souhaits : c'est une **grille de relecture** qui
répond à *« que reste-t-il à gagner, et est-ce que ça en vaut la peine ? »*

| # | Levier | Cible | Pourquoi |
|---|---|---|---|
| 1 | Cache de build Docker | < 10 Go | Se reconstitue à **chaque build** : mesuré à +14 Go en 4 h pour 3 déploiements. |
| 2 | `vm.swappiness` | 10 | 60 est la valeur « bureau » : elle swappe par anticipation alors qu'il reste de la RAM. |
| 3 | Limites mémoire des conteneurs | 0 sans limite | Sans plafond, l'OOM killer choisit selon un score de mémoire, pas selon l'importance métier. |
| 4 | `random_page_cost` | 1.1 | À 4 (valeur pour plateaux), le planificateur préfère des parcours de table là où un index irait plus vite. |
| 5 | Redis borné | `maxmemory` + `allkeys-lru` | Sans borne + `noeviction`, le cache refuse les écritures au lieu d'oublier — c'est lui qui décide quand tout s'arrête. |
| 6 | Journaux système | < 500 Mo | Piège classique du disque plein. |
| 7 | Noyau actif = noyau installé | égal | Un noyau installé n'est **pas** un noyau actif. Le redémarrage rend aussi la mémoire de `dockerd`. |

### ⚠️ Un levier « déjà bon » s'affiche quand même, en vert

C'est délibéré. Sans ça, on ne peut pas voir qu'un réglage a **régressé** — et ils régressent :
`cloud-init` réécrit des fichiers au démarrage, un redéploiement recrée un conteneur sans ses
limites, un `ALTER SYSTEM` saute à une restauration de sauvegarde.

### La règle qui gouverne tout le reste

> **Un gain non mesurable n'est pas un gain.**

VPS-011 l'a coûté : « 126 720 exécutions par jour » est un chiffre impressionnant, et il a
conduit à surestimer le constat. Une fois 26 % des sondes supprimées, le taux de création de
processus est passé de 1 527 à 1 512/min — **sous la variance naturelle**. Le gain existait,
mais il était trop petit pour être vu.

**En pratique, avant de proposer une optimisation** :

1. **Chiffrer le gain attendu**, pas le volume apparent. « 126 720/jour » ne dit rien ;
   « 16 % des créations de processus » dit quelque chose.
2. **Le comparer au bruit de la mesure.** Si le gain est sous la variance, le dire — et
   proposer quand même *si le coût est nul*, jamais si le coût est une interruption.
3. **Compter le coût réel**, pas seulement technique : redéployer quatre projets de production
   pour 1 % de CPU est un mauvais échange, même si le correctif est trivial.
4. **Préférer ce qui s'autorégule à ce qui se planifie.** Le cache de build est borné par le
   ramasse-miettes de BuildKit (`daemon.json`), pas par un cron : un mécanisme unique et
   permanent, donc **aucun risque de doublon** — le défaut VPS-003 que cet audit a lui-même trouvé.

## 7. Améliorer l'agent (obligatoire à chaque passage)

Le rapport se termine par une section **« Améliorer l'agent »**, en trois parties :

### a. Ce qui a été corrigé dans `collecte.sh` pendant ce passage

Si l'audit a produit un chiffre faux, ambigu ou muet, **corriger le collecteur immédiatement**
et le consigner. Deux exemples du passage d'amorçage :

- Le comptage des IP attaquantes mélangeait succès et échecs, et désignait un accès légitime
  comme principal attaquant (VPS-M01) ;
- Un `timeout` expiré rendait une section vide, indiscernable de « rien à signaler » (VPS-M02).

Ces défauts entrent au référentiel comme les autres, préfixés `VPS-M`. Un défaut de méthode qui
n'est pas écrit se reproduit.

### b. Les angles morts identifiés, non encore couverts

Ce que l'audit **ne voit pas** et qui compte. Chacun avec une piste concrète. Cette liste est la
feuille de route du collecteur : au passage suivant, on en traite au moins un.

### c. Une question ouverte pour le prochain passage

Une seule, celle qui débloquerait le plus. Souvent une question qui n'est pas technique :
*« `position_sampling_decisions` a-t-elle encore un lecteur ? »* se tranche côté produit, mais
c'est elle qui décide de 180 Mo.

> **Pourquoi cette section est obligatoire.** Un agent qui refait chaque nuit exactement la même
> collecte plafonne à ce qu'il savait voir le premier jour. Celui-ci lit ses propres rapports
> (§3), en tire ses angles morts, et corrige son collecteur. C'est la seule partie du dispositif
> qui le rend meilleur avec le temps plutôt que simplement régulier.

---

## 8. Publier

```bash
ssh root@72.62.26.240 "mkdir -p /opt/tracky-vps-audit" && scp -r docs/vps-audit/. root@72.62.26.240:/opt/tracky-vps-audit/
```

⚠️ Le `mkdir -p` n'est pas une précaution, c'est une **obligation** : si le dossier monté
n'existe pas, Docker le crée vide et **masque** la copie embarquée dans l'image. L'écran
afficherait alors une documentation vide sans rien expliquer.

Vérifier ensuite dans Tracky : `/admin` → **Audit VPS**. Le nouveau rapport doit apparaître en
tête de la section « Rapports de passage », **sans rebuild ni redémarrage**.

En cas d'écran vide : `GET /api/admin/vps/wiki/debug` dit où le service a cherché et ce qu'il a
trouvé.

---

## 8 bis. Committer la documentation (obligatoire depuis le 2026-08-11)

**La copie du §8 ne suffit pas, et l'oublier a coûté six rapports.** Constaté le 2026-08-11 : les
rapports du 05/08 au 10/08 étaient publiés sur le VPS mais **jamais commités**. Conséquences
concrètes :

- dans le dépôt — donc sur toute autre machine, et pour toute relecture humaine — **ils n'existent
  pas** ;
- l'image Docker, construite depuis git, embarque une documentation **figée au 04/08**. Le montage
  la masque en production… tant qu'il tient. Le jour où il saute, l'écran affiche une documentation
  vieille d'une semaine **sans rien signaler** — exactement le mode de panne que le `mkdir -p` du
  §8 existe déjà pour éviter, sous une autre forme.

Donc, à chaque passage, après le §8 :

```bash
git add docs/vps-audit
```

```bash
git commit -m "docs(vps-audit): audit du <AAAA-MM-JJ>"
```

| Règle | Pourquoi |
|---|---|
| **`git add docs/vps-audit` — jamais `-A`, jamais `.`** | Le dépôt est partagé ; d'autres sessions ont du travail en cours qu'un `-A` emporterait. Le chemin explicite est la seule protection. |
| **Aucun `git push`** | Pousser une branche est une décision humaine. La production, elle, est déjà à jour par la copie du §8. |
| **Relire la collecte brute avant de la committer** | `collectes/*.txt` est une sortie de commandes **non retouchée** : elle est versionnée, donc elle ne doit porter ni mot de passe, ni clé, ni URL de connexion complète. Vérifié le 2026-08-11 sur les trois fichiers existants — seuls des **noms** d'options `sshd` y apparaissent, aucune valeur secrète. Refaire ce contrôle si `collecte.sh` gagne une commande qui lit un environnement (`docker inspect`, `env`, `cat .env`). |
| **Vérifier la branche** (`git branch --show-current`) | Un commit de documentation sur une branche de fonctionnalité reste acceptable, mais il faut le savoir et le dire dans la restitution. |

> **Les trois gestes sont distincts et aucun ne remplace les autres :** écrire le fichier
> (le rapport existe), le copier sur le VPS (l'écran le montre), le committer (il survit).
> Sauter le troisième ne se voit nulle part — c'est exactement pourquoi il faut une consigne.

---

## 9. Ce que l'audit ne fait pas

Écrit noir sur blanc pour éviter les malentendus :

- **Il ne supprime rien.** Ni fichier, ni image, ni volume, ni conteneur.
- **Il ne redémarre rien.** Ni conteneur, ni service, ni machine.
- **Il n'installe rien.** `fail2ban` est *recommandé*, jamais posé.
- **Il ne modifie aucune configuration.** Ni `sshd_config`, ni `docker-compose`, ni Postgres.
- **Il ne pousse pas, et ne commite que `docs/vps-audit/`** (§8 bis), par chemin explicite. Tout
  le reste du dépôt appartient à quelqu'un d'autre. *L'ancienne règle — « il ne commite pas, la
  revue et le commit restent humains » — a été retirée le 2026-08-11 : personne ne relisait, donc
  personne ne commitait, et six rapports sont restés hors du dépôt. Un garde-fou qui délègue à un
  geste que personne ne fait ne protège rien, il perd des fichiers.*
- **Il ne bannit aucune IP.** VPS-M01 dit pourquoi : il s'est déjà trompé de coupable une fois,
  et c'était au premier passage.
