# Réarchitecture de l'arborescence — dépôt Tracky et `/opt` du VPS

> **Statut : PLAN. Rien n'a été exécuté.** Analyse du 2026-09-07, en lecture seule sur le VPS et
> sans aucun déplacement dans le dépôt.
>
> **Décision du propriétaire (2026-09-07)** : *« tous les fichiers liés à Tracky dans le dossier
> `vizyo-tracky` » ; « tous les docs, tous les `.md`, dans `vizyo-tracky/docs/` » ; « ne rien mettre
> à la racine ».*

---

## 0. Ce que dit la mesure, avant toute proposition

| Grief | Mesure |
|---|---|
| « c'est quoi ce bordel dans `/opt` » | **19 entrées**, dont **3 appartiennent à Tracky** et sont à trois endroits différents ; **2 sont des déchets** (`vizyo-leads` 823 Mo, pile supprimée le 04/08 ; `vizyo-auth-frontend-features` 80 Ko, orphelin depuis le 21/05) |
| « c'est quoi tous ces `.md` à la racine » | **14 fichiers `.md`** à la racine du dépôt, **13 sans raison d'y être** (`README.md` excepté) — de **81 à 1 684 lignes** |
| « tout doit être dans `docs/` » | `docs/` porte déjà **38 `.md` en vrac à sa racine** + **19 sous-dossiers**. *Déplacer les 13 sans rien d'autre ferait 51 fichiers en vrac au lieu de 38 : on descendrait le désordre d'un étage.* |

**Total du dépôt : 183 fichiers `.md` suivis par git.**

### ✅ La bonne nouvelle, et elle est décisive

**Aucun code ne lit les `.md` de la racine.** Vérifié sur `*.ts`, `*.js`, `*.mjs`, `*.json`,
`*.yml`, `*.sh` et les `Dockerfile` : les seules occurrences sont **deux citations en commentaire**
(`geofences-list.component.ts:425`, `installations-client.component.ts:272`) et **un titre de tâche**
(`docs/centre-alerte/app/taches.json:341`). Aucune ne casse à l'exécution.

**Conséquence : le lot 1 ci-dessous ne peut pas casser l'application.** Le seul dégât possible est
un lien mort dans un document — silencieux, mais réparable et vérifiable.

### 🔴 La mauvaise nouvelle, et elle commande tout l'ordre des opérations

**`/opt/vizyo-tracky/docs/vps-audit` et `/opt/vizyo-tracky/docs/centre-alerte` existent déjà, et
sont SUIVIS PAR GIT** — 60 et 44 fichiers respectivement, dans un arbre de travail sur `main` que le
déploiement met à jour par `git pull`.

> **C'est pour cela que les documents servis vivent aujourd'hui dans `/opt/tracky-vps-audit`.**
> Y faire un `scp` ne créerait pas des fichiers en trop : cela **modifierait des fichiers suivis**.
> Le `git pull` suivant s'arrête sur *« Your local changes would be overwritten by merge »* — et
> **quand le `pull` échoue, le build suivant tourne sur du code périmé sans rien signaler**
> (piège déjà payé, consigné dans la mémoire de l'agent d'audit).
> *Un agent qui republie deux fois par jour dans l'arbre de déploiement casserait le déploiement
> environ deux fois par jour.*

**Le placement actuel n'est donc pas une négligence : c'est une isolation.** Ce qu'il faut corriger,
c'est qu'elle a été obtenue en posant les dossiers à la racine de `/opt` alors qu'on pouvait
l'obtenir **à l'intérieur de `vizyo-tracky`**, dans une zone que git ne possède pas.

---

## 1. Ce qui NE DOIT PAS bouger — et ce que coûterait de le déplacer quand même

| Chemin | Pourquoi il est figé |
|---|---|
| `docs/vps-audit/` | Chemin **écrit en dur** dans `deploy/vps/Dockerfile.api:43`, dans `apps/api/src/observability/vps-audit-wiki.service.ts`, dans son `.spec`, dans le montage du compose **et** dans la tâche planifiée `audit-vps-tracky`. Résolu depuis `apps/api` par `../../docs/vps-audit`. |
| `docs/centre-alerte/` | Idem : `Dockerfile.api:39`, `centre-alerte-wiki.service.ts`, son `.spec`, le montage, et la tâche `audit-centre-alerte`. |
| `README.md` (racine) | Convention de dépôt : c'est le fichier qu'un forge affiche. **12 fichiers le citent.** |
| `CLAUDE.md` (racine) | Convention de l'outil : Claude Code ne le lit **qu'**à la racine. *Une règle « rien à la racine » ne peut pas s'écrire ailleurs qu'à la racine — c'est l'exception qui la porte.* |
| `/opt/foodsqan` | 🔴 **Ne jamais supprimer** : ce projet tient les ports **80 et 443 de TOUTE la production** (`foodsqan-traefik`). |
| `/opt/backups/tracky/positions-avant-purge60j-*` | 🔴 **Seule trace connue** des lignes purgées de `positions` le 2026-07-21 (VPS-030). 57 Mo pour une donnée irrécupérable. |

> ⚠️ **Déplacer `docs/vps-audit` ou `docs/centre-alerte` est un chantier à part entière** : 6 points
> de câblage chacun, dont un `Dockerfile` et deux tâches planifiées qui tournent la nuit. **Ce plan
> ne le fait pas.** Ils restent à `docs/<nom>` — ce ne sont pas des documents *à lire*, ce sont des
> **artefacts servis** ; le futur `docs/README.md` le dira, plutôt que de les ranger comme les autres.

---

## 2. La cible

### 2.1 Racine du dépôt — 4 fichiers au lieu de 14

```
vizyo-tracky/
  README.md          ← reste (convention de forge)
  CLAUDE.md          ← à CRÉER (convention de l'outil, porte la règle)
  package.json  pnpm-workspace.yaml  turbo.json  tsconfig.base.json  docker-compose.yml
  apps/  packages/  deploy/  docker/  docs/  lp/  outils/  scripts/  design/
```

### 2.2 `docs/` — une structure, pas un tas

```
docs/
  README.md              ← INDEX (à créer) : où trouver quoi, et ce qui est « servi » vs « à lire »
  produit/               REFERENCE_COMMERCIALE, INVENTAIRE_PRODUIT, A6-DEMANDES-ET-DEVIS
  technique/             protocole Coban, hardware-bench, tcp-commands, sms-gateway,
                         logging, observability-guide, dette auth-httponly, partitionnement
  exploitation/          DEPLOYMENT-VPS, VERIFIER-AVANT-DE-DEPLOYER, runbooks
  conformite/            rgpd-retention, rgpd-registre-temps-travail, consent/
  roadmaps/              toutes les roadmaps produit + ROADMAP-AGENTS-LOCAUX
  integrations/          SIM/WhereverSIM, Maestroo (4 fichiers), Vizyo Verify
  campagnes/             les 13 fichiers de la racine + A-VALIDER, DEPLOY_AUDIT,
                         PERMISSIONS_AUDIT, TEST_PLAN, EXECUTION-TRACKER…
  sprints/               sprint-0.1 … sprint-9-ai (19 dossiers regroupés)
  cdef-boitiers-muets/  feature-conducteurs/  prompts/
  centre-alerte/         🔒 SERVI PAR L'API — ne bouge pas
  vps-audit/             🔒 SERVI PAR L'API — ne bouge pas
```

### 2.3 `/opt` du VPS — 2 entrées de moins, et Tracky rassemblé

```
/opt/vizyo-tracky/
  _docs-servies/           ← NOUVEAU, ignoré par git ET par le contexte de build
    vps-audit/             ← ex-/opt/tracky-vps-audit      (4,3 Mo)
    centre-alerte/         ← ex-/opt/tracky-centre-alerte  (2,5 Mo)
```

Le montage du compose devient :

```yaml
- /opt/vizyo-tracky/_docs-servies/centre-alerte:/app/docs/centre-alerte:ro
- /opt/vizyo-tracky/_docs-servies/vps-audit:/app/docs/vps-audit:ro
```

> *Le préfixe `_` reprend la convention déjà présente dans `.gitignore` (`_scratch-*`). Le nom est
> discutable — `var/`, `.runtime/` conviendraient aussi ; ce qui compte est qu'il soit **ignoré par
> git**, sans quoi on rejoue exactement le défaut décrit au §0.*

---

## 3. 🔴 Le risque que ce déplacement CRÉE, et qui n'existe pas aujourd'hui

**`git clean -fdx` supprime les fichiers ignorés.** C'est la commande qu'on tape justement pour
réparer un arbre de déploiement cassé. Aujourd'hui elle est sans effet sur `/opt/tracky-vps-audit`
(hors du dépôt). Demain, elle **effacerait les documents servis** — et Docker, trouvant le point de
montage absent, **le recréerait vide et masquerait la copie embarquée dans l'image** : écran blanc,
sans message, jusqu'au prochain passage de l'audit.

**Deux atténuations, à choisir :**

1. **Auto-réparation au déploiement** — le script de déploiement recopie
   `docs/<wiki>/ → _docs-servies/<wiki>/` avant de démarrer. `git clean` devient alors sans
   conséquence : le prochain déploiement remet tout, et l'audit republie sous 24 h de toute façon.
   *C'est l'option recommandée : elle transforme un mode de panne silencieux en non-événement.*
2. **Ne pas déplacer** et documenter la raison à la racine de `/opt`. Coût nul, bénéfice nul.

> ⚠️ **À ne pas faire** : supprimer le montage et se contenter de la copie embarquée dans l'image.
> Chaque passage d'audit exigerait alors **un rebuild de 3 min** au lieu d'un `scp` — deux fois par
> jour, sur une machine à 2 vCPU. *Le montage existe précisément pour éviter ça.*

---

## 4. Les lots, par ordre d'exécution

**L'ordre n'est pas une préférence.** Chaque lot est réversible seul ; enchaînés dans le désordre,
deux d'entre eux produisent une panne silencieuse.

---

### Lot 0 — Poser la règle *(risque : nul · durée : 15 min · réversible)*

Créer `CLAUDE.md` à la racine et y écrire la convention, pour qu'aucune session — humaine ou agent —
ne recrée un `.md` à la racine. Même règle dans la mémoire de l'agent.

**Fait en premier, sinon on range une pièce pendant que quelqu'un y jette encore des affaires.**

---

### Lot 1 — Les 13 `.md` de la racine → `docs/campagnes/` *(risque : FAIBLE · durée : 1 h · réversible)*

| Fichier | Lignes | Dernier commit |
|---|---:|---|
| `SUIVI-REFONTE.md` | 1 684 | 22/08 |
| `REFONTE-TRACKY-V2.md` | 1 652 | 22/08 |
| `REPRISE-B-PAGES.md` | 1 044 | 22/08 |
| `ROADMAP-AGENTS-LOCAUX.md` | 760 | 23/08 |
| `PERMISSIONS_AUDIT.md` | 426 | 22/08 |
| `TEST_PLAN.md` | 334 | 22/08 |
| `TACHES-AMELIORATION.md` | 314 | **05/09 — encore vivant** |
| `REPRISE-A3.md` | 292 | 22/08 |
| `ETAT-RESTE-A-FAIRE-2026-08-22.md` | 241 | 22/08 |
| `DEPLOY_AUDIT_V1.10.md` | 195 | 22/08 |
| `DECISIONS-A-TRANCHER-2026-08-23.md` | 189 | 23/08 |
| `BUGS-MOBILE-375-2026-08-23.md` | 122 | 23/08 |
| `RECETTE-A-FAIRE.md` | 81 | 22/08 |

**Contraintes :**

- **`git mv`, jamais supprimer-recréer.** Sinon `git log --follow` perd l'historique de fichiers qui
  portent jusqu'à 1 684 lignes de décisions.
- **Le déplacement ET la réécriture des liens dans le MÊME commit.** Il y a **101 occurrences
  textuelles** de ces 13 noms dans le dépôt. Un commit intermédiaire = 101 liens morts, et *un lien
  markdown mort ne lève aucune erreur*.
- **Vérification obligatoire après coup** : rejouer le comptage et exiger **0 occurrence** pointant
  vers l'ancien chemin.
- `ROADMAP-AGENTS-LOCAUX.md` ira plutôt dans `docs/roadmaps/`, `TACHES-AMELIORATION.md` est encore
  actif (touché le 05/09) — **et il est déjà l'objet de la tâche T23** du centre d'alerte
  (*« créer ou déréférencer `TACHES-AMELIORATION.md` »*). **Traiter T23 avant ou pendant ce lot**,
  pas après.

---

### Lot 2 — Ranger les 38 `.md` de `docs/` *(risque : FAIBLE · durée : 2 h · réversible)*

Mêmes contraintes que le lot 1. À faire **après**, jamais en même temps : mélanger les deux rend le
diff illisible et la vérification des liens impossible à attribuer.

**Deux décisions humaines bloquent une partie du lot** — voir §6.

---

### Lot 3 — Rassembler les documents servis sous `vizyo-tracky` *(risque : MOYEN · durée : 30 min · réversible)*

**C'est le seul lot qui touche la production.** Un changement de point de montage **ne se prend pas
à chaud** : il exige une **recréation** du conteneur `tracky-api` — quelques secondes d'interruption
de l'API.

**Ordre impératif :**

1. `mkdir -p /opt/vizyo-tracky/_docs-servies/{vps-audit,centre-alerte}` **et les peupler** ;
2. ajouter `_docs-servies/` à `.gitignore` **et** créer un `.dockerignore` qui l'exclut ;
3. **seulement ensuite**, modifier les deux lignes du compose (`docker-compose.prod.yml:140` et
   `:147`) et recréer `tracky-api` ;
4. vérifier `/admin` → **Audit VPS** *et* **Centre d'alerte** ;
5. **seulement après vérification**, retirer `/opt/tracky-vps-audit` et `/opt/tracky-centre-alerte` ;
6. mettre à jour `PROCEDURE-AUDIT.md` §8 et les **deux tâches planifiées**.

> 🔴 **Ce qu'on risque à inverser 1 et 3** : si le compose est appliqué alors que le dossier n'existe
> pas, **Docker le crée vide et masque la copie embarquée dans l'image**. L'écran devient blanc
> **sans aucun message**. Le compose porte déjà cet avertissement en commentaire, lignes 144-146 —
> il a donc déjà été payé une fois.
> 🔴 **Ce qu'on risque à inverser 4 et 5** : plus de source pour revenir en arrière.
> ⚠️ **`scp` ne supprime pas** : l'étape 5 est un `rm` explicite, elle ne se fait pas toute seule.

---

### Lot 4 — Le ménage de `/opt` *(risque : à qualifier · durée : 20 min · IRRÉVERSIBLE)*

Hors périmètre « documentation », mais c'est la moitié du « bordel » constaté :

| Entrée | Taille | État |
|---|---:|---|
| `vizyo-leads` | **823 Mo** | Pile **supprimée le 04/08**. Coûte **16,6 % du parcours de `/opt`** à chaque audit nocturne (VPS-018, tâche **V10**). ⚠️ Vérifier d'abord que le dépôt distant existe. |
| `vizyo-auth-frontend-features` | 80 Ko | Orphelin depuis le **21/05** — ne contient qu'un `apps/`. |
| `.claude` | 16 Ko | Un `settings.local.json` à la racine de `/opt`, daté du 13/06. |
| `backups` | 58 Mo | **Propriété mixte** : `tracky/`, `maestroo-*`, `pre-deploy-subscriptions`, `error-logs`. 🔴 **Ne pas déplacer en bloc** — voir §1. |

---

## 5. Deux constats trouvés en chemin, hors sujet mais mesurés

1. **Il n'existe aucun `.dockerignore`**, et le contexte de build déclaré est `context: ../..`,
   c'est-à-dire **tout `/opt/vizyo-tracky` (1,2 Go)**. L'intégralité de l'arbre est donc envoyée au
   démon Docker à **chaque** build. *À mesurer avant d'en tirer une conclusion — mais c'est un
   candidat sérieux pour la signature de build très lourde relevée par l'audit du 07/09 (lecture
   à 17 000 blocs/s).* Ajouter un `.dockerignore` est de toute façon requis par le lot 3.
2. **`docs/tmp/ETAT-PROJET.md` est suivi par git** — un dossier nommé `tmp` sous gestion de version.
   `docs/review_loop/`, lui, est bien ignoré.

---

## 6. Ce qui reste à trancher — décisions humaines, pas techniques

1. **`docs/DEPLOYMENT-VPS.md` (8,7 ko) contre `docs/DEPLOYMENT-VPS.md.md` (30 ko).** La double
   extension est un artefact d'écriture, et le fichier **le dit lui-même** : *« renommage à décider
   par le propriétaire »*. Le petit est la **procédure courante** (référencée par
   `deploy/vps/README.md`) ; le gros est le **guide d'installation initiale d'avril 2026**.
   → *Proposition : `exploitation/deploiement-vps.md` et `campagnes/2026-04-installation-initiale.md`.*
2. **L'atténuation du §3** : auto-réparation au déploiement, ou renoncer au lot 3.
3. **Le nom `_docs-servies/`** — ou `var/`, ou `.runtime/`.
4. **La granularité du lot 2** : les 8 dossiers proposés au §2.2 sont une proposition, pas une
   contrainte.

---

## 7. ⚠️ La contrainte qui gouverne le calendrier

**Ce dépôt est partagé et actif.** Mesuré ce jour : **7 commits en 6 heures**, et `HEAD` est passé
de `f7b07881` à `fd4c414b` **pendant cette analyse**.

Un `git mv` de masse touche des centaines de chemins : **il entre en conflit avec tout travail en
cours**, et un conflit de renommage se résout beaucoup plus mal qu'un conflit de contenu.

> **Les lots 1 et 2 doivent être faits dans une fenêtre courte et annoncée, sur un arbre propre,
> et poussés immédiatement.** Les étaler sur plusieurs jours est le pire des scénarios : chaque
> branche ouverte pendant ce temps rapportera les anciens chemins.

---

## 8. Vérification — comment on saura que c'est réussi

| Contrôle | Attendu |
|---|---|
| `ls *.md` à la racine | **`README.md` et `CLAUDE.md`**, rien d'autre |
| `grep -rn` des 13 anciens noms | **0 occurrence** vers l'ancien chemin |
| `git log --follow docs/campagnes/SUIVI-REFONTE.md` | l'historique complet, **pas un fichier neuf** |
| `ls /opt` | **17 entrées**, plus aucune `tracky-*` |
| `/admin` → Audit VPS **et** Centre d'alerte | le rapport du jour s'affiche |
| `git -C /opt/vizyo-tracky pull` | réussit — *c'est le contrôle qui justifie tout le §0* |
| `pnpm verify` | inchangé — aucun code n'est touché par les lots 0 à 2 |
