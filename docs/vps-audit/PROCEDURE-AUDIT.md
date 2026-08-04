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

> ⚠️ **La seule exception d'écriture** : l'agent met à jour `docs/vps-audit/` (rapport,
> référentiel, manifeste) **dans le dépôt local**. Il ne commite pas, il ne pousse pas, et il
> n'écrit jamais sur le VPS.

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

## 9. Ce que l'audit ne fait pas

Écrit noir sur blanc pour éviter les malentendus :

- **Il ne supprime rien.** Ni fichier, ni image, ni volume, ni conteneur.
- **Il ne redémarre rien.** Ni conteneur, ni service, ni machine.
- **Il n'installe rien.** `fail2ban` est *recommandé*, jamais posé.
- **Il ne modifie aucune configuration.** Ni `sshd_config`, ni `docker-compose`, ni Postgres.
- **Il ne commite pas et ne pousse pas.** Les fichiers de `docs/vps-audit/` sont modifiés
  localement ; la revue et le commit restent humains.
- **Il ne bannit aucune IP.** VPS-M01 dit pourquoi : il s'est déjà trompé de coupable une fois,
  et c'était au premier passage.
