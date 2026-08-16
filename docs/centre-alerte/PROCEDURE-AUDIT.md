# Procédure d'audit du centre d'alerte Tracky

> Mode d'emploi de l'audit quotidien. Suivre **dans l'ordre**, sans sauter d'étape.
> Le référentiel qui accumule le savoir est [`REFERENCE-ERREURS.md`](./REFERENCE-ERREURS.md).

---

## 0. Garde-fous — non négociables

| 🚫 Interdit | Pourquoi |
|---|---|
| **Supprimer ou vider `error_logs`** | Une erreur reste visible tant qu'elle n'est pas corrigée **et vérifiée**. Le centre d'alerte n'est pas une boîte de réception à vider. Consigne explicite du propriétaire. |
| **Acquitter une commande / fermer une alerte** pour faire baisser un compteur | Même raison. Éteindre le témoin n'éteint pas le défaut. |
| **`git add -A`, `git commit -a`, toucher un fichier HORS `docs/centre-alerte/`** | Le dépôt est partagé et d'autres sessions y travaillent : un `-A` emporterait leur WIP. Seul `docs/centre-alerte/` se commite, **chemin explicite obligatoire** (voir §11.b). |
| **`git push`** | La publication en production passe par la copie de fichiers (§11.a), jamais par un push. Pousser une branche est une décision humaine. |
| **Modifier du code applicatif** | L'audit **propose**. Le passage à l'acte est une décision humaine (voir §8). |
| **Redémarrer / rebuild un conteneur, toucher la prod** | Un audit lit. Il n'agit pas. |
| **Écrire un secret, un mot de passe ou une URL de base complète** dans un rapport | Les rapports sont versionnés. |

---

## 1. Anti-doublon — à faire en premier

Un seul rapport par jour. Si `docs/centre-alerte/rapports/<AAAA-MM-JJ>.md` existe déjà pour la
date **du jour**, s'arrêter immédiatement et répondre :
« Audit du centre d'alerte déjà effectué le \<date\> — rien à refaire aujourd'hui. »

C'est ce qui rend le rattrapage sûr : la tâche planifiée peut se déclencher à 3 h, ou au
lancement suivant de Claude si le poste était éteint, sans jamais produire deux rapports.

---

## 2. Collecte — une seule commande

Depuis la racine du dépôt (`D:\www\vizyo-agency\vizyo-tracky\vizyo-tracky`) :

```bash
ssh root@72.62.26.240 'docker exec -i tracky-postgres psql -U tracky -d tracky_prod -X -A -F "|" -q' < docs/centre-alerte/collecte.sql
```

Le SQL est versionné dans [`collecte.sql`](./collecte.sql) et découpé en sections `### SECTION …`.
Il passe par **stdin**, ce qui évite l'enfer de l'échappement de quotes à travers SSH.

Puis la corrélation avec les redémarrages — **indispensable**, voir §4 :

```bash
ssh root@72.62.26.240 'date -u; for c in tracky-api tracky-web; do printf "%s " $c; docker inspect $c --format "{{.State.StartedAt}} restarts={{.RestartCount}}"; done; docker images --format "{{.Repository}}:{{.Tag}} {{.CreatedAt}}" | grep -i tracky'
```

### Pièges d'outillage, déjà payés
- La base est **`tracky_prod`**, utilisateur `tracky`, conteneur `tracky-postgres`.
  `/opt/vizyo-tracky/.env` annonce `vizyo_tracky` sur `localhost` : **il est périmé**. La vérité
  est dans `docker inspect tracky-api` → `DATABASE_URL`.
- Tables en `snake_case` (`error_logs`), colonnes en `camelCase` **à guillemeter** (`"createdAt"`).
  Un `created_at` échoue.
- L'heure du serveur est en **UTC**. Les horodatages du rapport aussi — le préciser.
- 🔴 **Les journaux de `tracky-api` mentent sur leur propre fenêtre — `--since` ET `--tail N`.**
  Le conteneur tourne en `json-file` / `max-size=10m` / `max-file=3`, et la lecture ne recolle pas
  au-delà du fichier courant. Deux mesures :

  | Mesuré le | Commande | Ce qu'elle rend |
  |---|---|---|
  | 2026-08-08 | `--since 26h` | 205 lignes **se terminant 25 h avant l'heure courante** |
  | 2026-08-09 | `--tail 200000` | 3714 lignes **se terminant 79 min avant l'heure courante** |
  | 2026-08-09 | `--tail 3` | des lignes **de la seconde** |

  Le remède écrit le 08/08 (« utiliser `--tail N` ») est donc **faux pour N grand** : il rend une
  tranche tronquée à une frontière de rotation. Aucune forme de la commande n'est fiable a priori.

  **La seule règle qui tient : mesurer la fenêtre obtenue, et la citer.** Un rapport donne le
  **premier et le dernier horodatage réellement observés**, jamais la fenêtre demandée — et si
  cette fenêtre ne va pas jusqu'à l'heure de collecte, il le dit.
  ```bash
  ssh root@72.62.26.240 'L=$(docker logs tracky-api --tail 200000 2>&1); echo "$L" | head -1; echo "$L" | tail -1; docker logs tracky-api --tail 1'
  ```
  *Un compteur sur une fenêtre qu'on n'a pas vérifiée est un compteur inventé — y compris quand on
  croit avoir déjà corrigé le piège.*

---

## 3. Ce qu'il faut regarder, et dans quel ordre

L'ordre compte : le plus révélateur vient en dernier.

1. **`erreurs_detail`** — les lignes du centre d'alerte. Le point de départ, jamais l'arrivée.
2. **`trackers_failing` / `trackers_offline` / `commandes_en_attente`** — le reste de l'écran
   « Centre d'alertes ». Une erreur applicative n'est qu'une moitié du sujet.
3. **`commandes_sante_7j` / `commandes_motifs_7j` / `cadence_derive`** — **l'angle mort**.
   Ces sections montrent ce qui échoue **sans produire d'alerte**. C'est exactement là qu'a été
   trouvé [TRK-008](./REFERENCE-ERREURS.md#trk-008) : 72 échecs par jour depuis des mois, et le
   centre d'alerte affichait « 0 ».

> 🔑 **La question la plus rentable de tout l'audit** n'est pas « qu'est-ce qui a crié ? » mais
> **« qu'est-ce qui casse sans crier ? »**. Un centre d'alerte vide n'est pas une preuve de
> bonne santé — c'est peut-être juste un capteur éteint.

---

## 4. Corréler avant d'accuser

Avant de qualifier quoi que ce soit, poser ces quatre questions :

1. **L'erreur est-elle postérieure au dernier correctif ?** Comparer son horodatage à
   `git log`. Si elle est antérieure, c'est de l'historique : elle reste affichée mais ne
   demande aucune action. *(Le piège inverse s'est produit le 28/07 : des alertes qu'on croyait
   obsolètes étaient toutes postérieures aux correctifs — c'était donc le correctif la source.)*
2. **Y a-t-il eu un redémarrage ou un déploiement à cet instant ?** Un redéploiement rend l'API
   injoignable quelques secondes : tous les clients échouent en même temps. Ce n'est pas une
   panne, c'est un déploiement. *(Incident du 15/07 : ~100 fausses `CRITICAL`.)*
3. **Pour une erreur front : le bundle incriminé existe-t-il encore ?** Les piles archivées
   citent des chunks (`chunk-XXXX.js`). S'ils sont absents du bundle servi, l'erreur vient d'une
   version qui n'est plus en ligne — donc déjà corrigée.
   ```bash
   ssh root@72.62.26.240 'docker exec tracky-web sh -c "test -f /usr/share/nginx/html/chunk-XXXX.js && echo PRESENT || echo ABSENT"'
   ```
   ⚠️ **Vérifier le bundle SERVI, pas le commit.** Un correctif commité n'est pas un correctif déployé.
4. **L'état incriminé est-il encore vrai maintenant ?** Une alerte « GPS perdu il y a 2 h » se
   vérifie en base : `lastPositionAt` est-il toujours figé ? Distinguer *incident clos* et
   *incident en cours* change complètement l'urgence.

---

## 4 bis. Dérive ou fluctuation ?

Un audit quotidien voit des nombres bouger. Il est tentant d'y lire une tendance — et c'est le
plus facile des faux diagnostics, parce qu'il *se raconte bien* : « passé de 4 à 10 en 24 h »
sonne comme une aggravation démontrée. Ça n'en est pas une.

**Avant d'annoncer une évolution, trois questions :**

1. **La grandeur est-elle stable par nature ?** Beaucoup ne le sont pas. La liste des boîtiers
   à cadence dérivée, par exemple, est **réécrite en continu** par l'auto-alignement : elle
   change d'une heure à l'autre sans que rien n'empire. *(Mesuré le 2026-08-04 : 10 boîtiers à
   00:59, 9 à 01:11 — douze minutes plus tard.)*
2. **Compare-t-on la même définition ?** Un seuil qui change entre deux passages fabrique une
   variation de toutes pièces. Reprendre le chiffre de `cadence_resume`, pas un comptage refait
   à la main sur le détail.
3. **Combien de points ?** Deux mesures ne font pas une tendance. Il en faut **au moins trois**,
   espacées, sur la même définition.

**Règle :** tant qu'on n'a pas trois points comparables, écrire le **fait mesuré**
(« 14 boîtiers sous le minimum matériel ce jour ») et non l'**interprétation**
(« la dérive s'étend »). Le journal des passages accumule ces chiffres précisément pour qu'une
tendance devienne dicible plus tard — c'est ce qui rend l'audit cumulatif plutôt que quotidien.

⚠️ Ce qui se compte, lui, se compare sans réserve : le **volume d'échecs de commandes** est
d'une régularité de métronome (72/jour, 36 boîtiers, dix jours de suite). Là, la stabilité EST
l'information — elle prouve un plafond atteint, pas un hasard.

---

## 5. Normaliser en signature

Une **signature** identifie un problème, pas une occurrence. Deux lignes qui décrivent le même
défaut sur deux véhicules doivent produire la **même** signature.

```
SIGNATURE = source | level | message normalisé
```

Règles de normalisation, à appliquer au message :

| Remplacer | Par |
|---|---|
| IMEI (15 chiffres) | `<IMEI>` |
| Plaque d'immatriculation | `<PLAQUE>` |
| UUID | `<ID>` |
| Durée (`2 h`, `45s`, `120min`, `5 j`) | `<DURÉE>` |
| Nombre isolé (compteurs, `N arrêt(s)`) | `<N>` |
| Date / horodatage | `<DATE>` |
| Chemin de chunk JS (`chunk-XXXX.js`) | `<CHUNK>` |
| Variante de message d'un même défaut | garder le tronc, mettre la variante en `<TYPE>` |

Exemple :
`GPS perdu : FZ-862-VY (864035054756102) — boîtier vivant mais sans position GPS depuis 2 h.`
→ `gps-integrity | ERROR | GPS perdu : <PLAQUE> (<IMEI>) — boîtier vivant mais sans position GPS depuis <DURÉE>.`

⚠️ **Ne pas sur-normaliser.** `TypeError: Load failed` et `TypeError: Failed to fetch` sont le
même défaut (→ `<TYPE>`), mais `Load failed` et `NG02100` ne le sont pas. Dans le doute :
signatures distinctes. Deux fiches valent mieux qu'une fusion qui masque une cause.

---

## 6. Confronter au référentiel

Pour chaque signature observée :

| Cas | Action |
|---|---|
| **Connue, statut 🟢 CORRIGÉ** | 🔴 **RÉGRESSION** — remonter en tête du rapport. Un correctif vérifié qui casse à nouveau est prioritaire sur tout le reste. |
| **Connue, statut 🔴 / 🟠** | Mettre à jour occurrences + « dernière vue ». Rappeler le correctif proposé. **Ne pas ré-enquêter.** |
| **Connue, statut ⚪ / 🔵** | Compter. Signaler seulement si le volume **change d'ordre de grandeur**. |
| **INCONNUE** | 🆕 **Enquêter (§7), puis créer la fiche.** C'est la raison d'être de cet audit. |

---

## 7. Enquêter sur une signature inconnue

Un diagnostic qui s'arrête au message n'est pas un diagnostic. La règle : **remonter jusqu'au
code qui émet la ligne.**

1. **Trouver l'émetteur** — `grep` le message (ou son tronc stable) dans `apps/api/src` et
   `apps/web/src`. Le `source` du log donne presque toujours le module.
2. **Lire la fonction entière**, pas la ligne. Les commentaires de ce dépôt sont denses et
   expliquent souvent *pourquoi* le code est ainsi — et parfois quel incident l'a motivé.
3. **Nommer la cause racine en une phrase**, sans jargon de pile. « `navigator.onLine` vaut
   `true` sur un appareil qui vient de se réveiller » est une cause. « TypeError » n'en est pas une.
4. **Vérifier en base** que l'état décrit est réel.
5. **Chercher les jumeaux.** Le même défaut existe souvent 10 lignes plus loin sur un chemin
   voisin. *(TRK-004 : la porte « budget IA » et la porte « IA désactivée » ont le même défaut.)*
6. **Classer** :

| Le message… | Famille |
|---|---|
| tourne en rond (« échec car en attente de réessai ») | **circulaire** — il ne capture jamais la vraie cause |
| affirme une cause fausse | **mensonger** — le plus grave, il envoie enquêter au mauvais endroit |
| répète l'erreur de transport brute | **brut** — il ne dit ni quelle dépendance ni quelle conséquence |
| décrit un refus voulu (plafond, droit) | **faux positif** — pas une faute, ne doit pas être archivé |
| décrit un état stable qui dure | **à lire, pas à notifier** — un état qui dure des mois se consulte sur une page dédiée |
| décrit un fait matériel | **terrain** — vrai signal, action non logicielle |

---

## 8. Politique de correction

**Aujourd'hui : l'audit PROPOSE, il ne corrige pas.** Il écrit le correctif dans la fiche, avec
assez de précision pour être appliqué sans refaire l'enquête.

Le jour où l'on passera à la correction automatique, la frontière sera :

- ✅ **Autorisé** — correctif d'une seule famille, sur une branche dédiée, avec test, vérifié par
  `pnpm -w typecheck` + la suite concernée, **et jamais mergé sans relecture**.
- ❌ **Interdit** — tout ce qui touche une **garde de sécurité** (coupe-circuit, permissions,
  cloisonnement de flotte), une **migration**, ou un chemin de paiement.

> 🔴 **Règle anti-boucle.** Si une signature revient **3 fois en 7 jours après avoir été
> déclarée corrigée**, ne plus proposer de correctif : escalader. Quelque chose la remet
> activement en cause, et réparer en silence masquerait la vraie cause.

### Deux réflexes qui évitent les faux correctifs
- **Corriger un message ≠ affaiblir une garde.** Si un garde-fou crie mal, on corrige le cri —
  pas le garde-fou. *(Le refus de couper un véhicule dont on ignore la vitesse fait son travail,
  même s'il alerte tous les jours.)*
- **Un correctif qui ne fait que vider l'écran n'est pas un correctif.** Chaque fiche doit
  porter une vérification qui porte sur la **cause**, pas sur l'affichage.

---

## 9. Rédiger le rapport

Écrire `docs/centre-alerte/rapports/<AAAA-MM-JJ>.md` (date du jour, heure locale) :

```markdown
# Audit du centre d'alerte — <AAAA-MM-JJ>

**Verdict :** <une phrase — l'état réel de la plateforme, pas un compte de lignes>

## Chiffres
| | |
|---|---|
| Lignes `error_logs` | <n> (dont <n> sur 24 h, <n> CRITICAL) |
| Trackers FAILING | <n> |
| Trackers hors ligne > 1 h | <n> (dont <n> jamais mis en service) |
| Commandes en attente > 10 min | <n> |
| Commandes échouées / jour (7 j) | <n> |

## 🔴 À traiter
<signatures nouvelles ou régressions, cause racine + correctif proposé>

## 🟠 Connu, correctif en attente
<rappel une ligne + lien vers la fiche>

## ⚪ Bruit / 🔵 Terrain
<liste courte>

## Angles morts examinés
<ce qui a été vérifié SANS produire d'alerte — et le verdict>

## Fiches ajoutées ou mises à jour
<TRK-xxx …>
```

**Le verdict est la seule ligne que quelqu'un lira toujours.** Qu'elle dise l'état réel :
« 12 lignes, dont 0 nouvelle — mais 72 commandes échouent chaque jour sans alerte » est un bon
verdict. « 12 erreurs » n'en est pas un.

---

## 10. Mettre à jour le référentiel

Dans [`REFERENCE-ERREURS.md`](./REFERENCE-ERREURS.md) :
- ajouter une fiche par signature nouvelle (même modèle que les existantes — signature, cause
  racine, correctif proposé, vérification) ;
- mettre à jour l'index (statut, dernière vue) ;
- ajouter une ligne au **journal des passages** en bas de fichier ;
- si une signature 🟢 réapparaît : la repasser en 🔴 et **écrire pourquoi le correctif n'a pas tenu**.

---

## 11. Publier dans l'application

Toute cette documentation est lisible **depuis Tracky** : `/admin/alerts` → bouton
**Documentation**. L'API la sert en lecture (`GET /api/admin/alerts/wiki`, SUPER_ADMIN) en
parcourant `docs/centre-alerte/` sur le disque.

### 11.a — Pousser les fichiers en production (sinon rien ne bouge)

En production, l'API lit `/opt/tracky-centre-alerte`, **monté en lecture seule** depuis le VPS.
Un dossier dédié, volontairement **hors de l'arbre git** du serveur : y écrire directement
salirait le dépôt et ferait échouer le prochain `git pull`.

L'image Docker embarque bien une copie de la documentation, mais une image est **figée** :
sans cette publication, un rapport écrit cette nuit n'apparaîtrait qu'au prochain rebuild.

Deux commandes, depuis la racine du dépôt :

```bash
ssh root@72.62.26.240 "mkdir -p /opt/tracky-centre-alerte"
```

```bash
scp -r docs/centre-alerte/. root@72.62.26.240:/opt/tracky-centre-alerte/
```

Puis vérifier que le serveur voit bien le nouveau rapport :

```bash
ssh root@72.62.26.240 "ls /opt/tracky-centre-alerte/rapports/ && docker exec tracky-api ls /app/docs/centre-alerte/rapports/"
```

Les deux listes doivent être identiques. Aucun redémarrage n'est nécessaire : le service lit
le disque à chaque appel.

⚠️ **Le `mkdir -p` n'est pas décoratif.** Si le dossier n'existe pas, Docker le crée VIDE au
démarrage du conteneur et **masque le contenu de l'image** : l'écran afficherait une
documentation vide. Le cas est détecté et expliqué à l'écran, mais mieux vaut ne pas le
provoquer.

⚠️ Cette copie n'efface jamais rien — elle ajoute et remplace. Un document retiré du dépôt
resterait publié ; c'est volontaire (on ne perd pas un rapport par accident).

### 11.b — Committer la documentation (obligatoire depuis le 2026-08-11)

**La copie du §11.a ne suffit pas, et l'oublier a coûté sept rapports.** Constaté le 2026-08-11 :
les rapports du 05/08 au 10/08 étaient publiés sur le VPS mais **jamais commités**. Conséquences
concrètes :

- dans le dépôt — donc sur toute autre machine, et pour toute relecture humaine — **ils n'existent
  pas** ;
- l'image Docker, construite depuis git, embarque une documentation **figée au 04/08**. Le montage
  la masque en production… tant qu'il tient. Le jour où il saute, l'écran affiche une documentation
  vieille d'une semaine **sans rien signaler**.

Donc, à chaque passage, après le §11.a :

```bash
git add docs/centre-alerte
```

```bash
git commit -m "docs(centre-alerte): audit du <AAAA-MM-JJ>"
```

| Règle | Pourquoi |
|---|---|
| **`git add docs/centre-alerte` — jamais `-A`, jamais `.`** | Le dépôt est partagé ; d'autres sessions ont du travail en cours. Le chemin explicite est la seule protection. |
| **Aucun `git push`** | Pousser une branche est une décision humaine. La production, elle, est déjà à jour par la copie du §11.a. |
| **Vérifier la branche avant de committer** (`git branch --show-current`) | Un commit de documentation sur une branche de fonctionnalité en cours reste acceptable, mais il faut le savoir et le dire dans la restitution. |

> **Les trois gestes sont distincts et aucun ne remplace les autres :** écrire le fichier
> (le rapport existe), le copier sur le VPS (l'écran le montre), le committer (il survit).
> Sauter le troisième ne se voit nulle part — c'est exactement pourquoi il faut une consigne.

### Ce qui est automatique — et ce qui ne l'est pas

| | |
|---|---|
| **La liste des documents** | 🤖 **Automatique.** Un `.md` déposé apparaît, sans rien déclarer. C'est délibéré : un rapport écrit chaque nuit ne doit pas pouvoir devenir invisible à cause d'un oubli. |
| **Le journal des passages** | ✍️ **À écrire.** « Ce qui a été fait » ne se devine pas d'une liste de fichiers. |
| **La copie sur le VPS (§11.a)** | ✍️ **À faire.** Sans elle, le rapport n'existe que sur le PC. |
| **Le commit (§11.b)** | ✍️ **À faire.** Sans lui, le rapport n'existe que sur le VPS — et disparaît du dépôt comme de l'image. |

### Ce qu'il faut donc faire, à chaque passage

Éditer `app/wiki.json` :

1. **Ajouter une entrée en tête de `passages`** — jamais en remplacer une, jamais en retirer :

```json
{
  "date": "2026-08-04",
  "origine": "agent",
  "rapport": "rapports/2026-08-04.md",
  "verdict": "<la MÊME phrase que le verdict du rapport>",
  "chiffres": {
    "erreurs": 0, "critical": 0, "trackersFailing": 0,
    "trackersHorsLigne": 0, "commandesEnAttente": 0, "echecsCommandesParJour": 0
  },
  "fiches": { "nouvelles": 0, "misesAJour": 0 },
  "aTraiter": ["TRK-008"],
  "note": "<facultatif : ce qu'un lecteur pressé doit savoir>"
}
```

2. **Ajouter le rapport à `documents`** avec un titre et une description courte
   (`"section": "rapports"`). Facultatif — sans ça il s'affiche quand même, sous un titre
   dérivé du nom de fichier — mais une description rend la liste bien plus lisible.

3. **Mettre `updatedAt` à la date du jour.**

### ⚠️ Le fichier doit rester du JSON valide

C'est la seule façon de casser l'affichage : un JSON invalide fait retomber l'API sur la
découverte disque seule — les documents restent visibles, mais **le journal des passages
disparaît en silence**. Après édition, vérifier :

```bash
node -e "JSON.parse(require('fs').readFileSync('docs/centre-alerte/app/wiki.json','utf8')); console.log('JSON valide')"
```

---

## 12. Restituer

Finir par un résumé court dans la conversation : le verdict, le nombre de nouvelles signatures,
et **la seule chose à faire en premier**. Le rapport détaillé est sur disque et lisible dans
l'application ; le message, lui, doit tenir en quelques lignes.

Ne jamais annoncer « tout va bien » sur la seule foi d'un centre d'alerte vide sans avoir
regardé les sections d'angle mort (§3.3).
