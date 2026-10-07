> **Archive — note de recette du 07/09/2026, rangée dans le dépôt le 07/10/2026.** Elle vivait hors
> du dépôt (`D:\www\vizyo-agency\vizyo-tracky\reprise-cartes\`), sans aucune copie.
>
> **Statut au 07/10/2026 : les six défauts sont corrigés dans `main`, et en production.**
>
> | # | Défaut | Correctif |
> |---|---|---|
> | 1 | Vitesse et statut d'un véhicule muet présentés au présent | `be57394f` (07/09) |
> | 2 | Plaque et lien collés sur les lignes d'alerte | `be57394f` |
> | 3 | Chiffres des cartes KPI tronqués (Rapports) | `be57394f` |
> | 4 | Filtres de Rapports qui se recouvrent | `be57394f` |
> | 5 | « À l'arrêt » déduit d'un fil ACC non raccordé | `558213a8` (07/09) |
> | 6 | La carte meurt à la perte du contexte WebGL | `872f0fda` + `09d04e2b` (07/09), gardé depuis par `verif:carte-gardes` |

---
# Constats de recette — production, 2026-09-07

## ⚠️ Limite du banc
Le volet navigateur **ne peint pas** (0 image/s même onglet au premier plan) : MapLibre diffère
`Style.loadJSON` à `requestAnimationFrame`, donc **aucune tuile n'est demandée** et tout canvas
reste noir. Les cartes ne sont PAS jugeables ici. Tout le DOM l'est.

---

## 1. Vitesse et statut d'un véhicule muet depuis 4,5 jours — présentés au présent

**Où** : `apps/web/src/app/features/vehicles/vehicles-list.component.ts`, `liveStatus()` (~l.1613)
**Vu** : `GLA•KC•31` affiche **« À l'arrêt · 7 km/h »**, colonne VITESSE comprise.
**Réel** (snapshot API) : `lastSeenAt` = **108,1 h**, `lastPositionAt` = 109,9 h,
`lastIgnition: false`, `trackerStatus: OFFLINE`, `presumedParkedZone: null`.

**Mécanisme** : `liveStatus()` porte DEUX gardes — dormance (> 7 j) et `GPS_LOST` — toutes deux
ajoutées après incident, avec le même raisonnement écrit en commentaire : sans elles « le badge de
présence — le seul à dire la vérité — ne s'afficherait JAMAIS (il est dans la branche `@else`) ».
Aucune des deux ne couvre un véhicule muet **entre 15 min et 7 jours**. Il obtient donc la pastille
live et une vitesse tirée de sa dernière trame, indiscernables d'une donnée de la seconde.

De plus les deux sources se contredisent : `realtime.positionsList()` porte `ignition: true` et
`7,389 km/h`, le snapshot dit contact coupé.

**Ampleur mesurée** : 1 seule vitesse fantôme (GLA), mais 11 boîtiers OFFLINE dont 3 sous les
7 jours (`GLA•KC•31` 4,6 j, `FG-669-DQ` 3,8 j) reçoivent la pastille live.

**Correctif proposé** : `liveStatus()` rend `null` quand la trame dépasse
`TRACKER_ONLINE_THRESHOLD_MS` (15 min, la définition même de « live » du tri-état). Le badge de
connectivité prend alors le relais et DATE la donnée. ~3 à 6 lignes changent d'aspect.

---

## 2. Plaque et lien collés sur chaque ligne d'alerte

**Où** : `apps/web/src/app/features/alerts/alerts.component.ts` l.326-333 (`.al-meta`)
**Vu** : « FM-772-**JHVoir le trajet** → » — la plaque et le lien se lisent comme un seul mot.
**HTML rendu** : `<a class="al-plate">FM-772-JH</a><!----><a class="al-trip">Voir le trajet →</a>`

**Mécanisme** : la ligne sépare bien ses autres membres par `<span class="al-sep">·</span>`
(avant le message, avant l'horodatage) mais RIEN entre la plaque et le lien de trajet. Angular
supprime l'espace entre deux blocs `@if` (`preserveWhitespaces: false`), donc le saut de ligne du
gabarit disparaît à la compilation.

**Portée** : `.al-meta` seulement. Le bloc des occurrences (`.al-occ`) est en `flex; gap: 10px`,
il est sain.

**Correctif** : un `·` dans le bloc du lien, conditionné à la présence de la plaque — même
grammaire visuelle que le reste de la ligne.

---

## 3. 🔴 Les chiffres des cartes KPI sont tronqués — sur TOUS les écrans d'ordinateur portable

**Où** : `apps/web/src/app/features/reports/reports.component.ts` — `.rep-kpi-value` (l.1892) et la
règle corrective l.1935-1936.
**Vu à 1440 px** : `1221` → « 1… », `19 016,1 km` → « 19 0… », `585h38` → « 58… ».
Un lecteur y voit 1 trajet au lieu de 1221, et 19 km au lieu de 19 016.

**Mesures** (largeur → valeurs coupées) :

| 375 px | 482 px | 768 px | 1023 px | 1280 px | 1440 px | 1920 px |
|---|---|---|---|---|---|---|
| aucune | 3 | 1 | 1 | 3 | 3 | aucune |

**Mécanisme** : le défaut a DÉJÀ été corrigé une fois — le commentaire l.1928 dit « Le chiffre est
la raison d'être de la carte : il ne se tronque JAMAIS » — mais la règle est enfermée dans
`@media (max-width: 480px)`, alors que la grille reste à 2 colonnes jusqu'à 1023 px puis passe à
4 colonnes (cartes de nouveau étroites). Le seul endroit où le correctif s'applique est le
téléphone ; la bande cassée va de 481 px à ~1700 px, c'est-à-dire tous les portables.

**Correctif** : sortir la protection du média téléphone — la valeur ne se tronque à aucune largeur,
la courbe et la mention passent à la ligne (exactement ce que fait déjà la règle ≤ 480 px).

---

## 4. 🔴 Les trois filtres de Rapports se chevauchent et recouvrent les puces de période

**Où** : mêmes fichier — `.rep-dropdown-wrapper` (l.2383) et `.rep-dropdown-trigger` (l.2387).
**Mesuré à 1440 px** : boutons de **180 px** dans des conteneurs de **90 px**.
4 collisions confirmées par test de touche (`elementFromPoint`) :
« Tous les conducteurs » recouvre « Tous les groupes » (84×44), « Tous les véhicules » (132×44),
« Aujourd'hui » (89×44) et « 7 jours » (36×44). Cliquer la période dans cette zone atteint le
mauvais contrôle.

**Mécanisme** — deux règles qui se contredisent :
```css
.rep-dropdown-wrapper { min-width: 0 }      /* le conteneur accepte d'être comprimé */
.rep-dropdown-trigger { min-width: 180px }  /* le bouton refuse — donc il déborde */
```
Le conteneur est l'élément flexible (`.rep-selectors` est en `display: contents`) : flex le réduit
à 90 px, le bouton reste à 180 px et déborde sur son voisin.

**Correctif** : `.rep-dropdown-wrapper` doit refuser de descendre sous la largeur de son bouton.
`.rep-filters` est déjà en `flex-wrap: wrap` — la rangée passera proprement à la ligne.

---

## ✅ Écarté après vérification (ne PAS corriger)

- **« Assistance » et « Demandes d'assistance » inatteignables dans le menu** : faux positif. Elles
  sont simplement défilées hors vue dans `.sidebar-nav` (`overflow-y: auto`, 778 > 646 px). Après
  défilement, `elementFromPoint` les rend ATTEIGNABLES. `.sidebar-foot` est en `position: static`,
  il ne recouvre rien.
- **Carte noire du tableau de bord** : limite du banc (0 image/s, aucune tuile demandée), pas le produit.
- **Débordement horizontal des Rapports** : `scrollWidth == clientWidth`. Les éléments hors cadre
  sont décoratifs (`top-bar-wave`) ou en `sr-only`.

---

## Suites parcourues sans défaut

- **Tableau de bord** — 44 véhicules = 5 en mouvement + 30 à l'arrêt + 9 injoignables. Cohérent.
- **Agenda** — 0 collision. Les 33 troncatures sont des libellés de cellules de calendrier
  (131/139 px) : élision normale. Les compteurs (0 en retard / 0 à venir / 3 incidents) portent
  sur les entretiens, ce que le sous-titre annonce — pas sur les trajets récurrents affichés.
- **Alertes** — compteurs cohérents (0/1/0/0 pour « 1 affichée »).
- **Hub admin** — rend correctement ; aucune tuile de liens de partage (d'où la nouvelle).

## État des correctifs

| # | Défaut | Correctif | Test |
|---|---|---|---|
| 1 | Pastille live sur une trame de 4,5 j | `pastille-live.ts` — on EXIGE un boîtier vivant | 7 tests, 4 rouges sans le correctif |
| 2 | Plaque et lien collés (alertes) | séparateur `·` conditionné | vérifié en production |
| 3 | Chiffres KPI tronqués | protection sortie du média téléphone | 2 rouges sans |
| 4 | Filtres qui se recouvrent | override bureau après la règle mobile | 2 rouges sans |

Commit `be57394f`, déployé et vérifié dans le paquet servi.

---

# Vue d'ensemble des liens de partage — vérifiée en production

`/admin/liens-partages` (super-admin). Les deux mécanismes réunis : partage de trajet et suivi
de livraison, toutes sociétés.

## Épreuves passées en production

| Épreuve | Attendu | Obtenu |
|---|---|---|
| Lecture de la vue | 200, les deux types | 200 — 5 liens, 1 actif / 2 expirés / 2 révoqués |
| Fuite de jeton | aucun champ `token` | aucun ✅ |
| Règle 1 — lien révoqué | refus | 409 `LIEN_REVOQUE` |
| Règle 3 — plafond 30 j | refus | 409 `PLAFOND_VIE_ATTEINT` + `plafondAt` + « il reste 5 j » |
| Chemin nominal | +1 h | 201, échéance 09:58 → 10:58, `prolongations=1` |
| Révocation | coupe | 200 |
| Idempotence | pas d'erreur | 200 au second appel |
| Trace en base | qui / quand | `extendedCount=1`, `lastExtendedAt`, `lastExtendedById` = admin@ |
| Journal | deux lignes | `share_link_extended` + `share_link_revoked`, acteur et société |

⚠️ Le message de plafond porte `plafondAt` — un champ métier **supplémentaire** qui arrive au
client. C'est la confirmation en production du 3ᵉ correctif de la chaîne d'erreurs de ce matin
(le filtre ne servait que `code`/`message`/`requestId` et jetait le reste).

## Ce que l'écran dit ne pas savoir

Il ne nomme aucun visiteur — un destinataire n'a pas de compte. La phrase est à l'écran, pas
laissée à l'interprétation de la colonne « Ouvertures ». Empreintes vérifiées tronquées en
base : `82.67.x.x`, `72.62.x.x`.

## Défauts trouvés dans mon PROPRE travail, pendant la relecture

1. `--texte-danger` **n'existe pas** — jeton inventé. Les trois marques de révocation seraient
   sorties sans couleur. Attrapé par `pnpm verif:variables`, que j'aurais dû lancer plus tôt.
2. Le filtre de type court-circuitait une table → les **compteurs auraient suivi le filtre**
   (« 2 actifs » pour un parc qui en compte 5), exactement le faux calme que l'écran doit ôter.
3. `AuthModule` manquant au module → panne d'injection invisible à la compilation, attrapée par
   le smoke-boot.

---

## 5. 🔴 « À l'arrêt » déduit d'un fil ACC qui n'est pas raccordé

Trouvé **en vérifiant le correctif n°1**, sur la même liste.

**Vu** : `GA-490-SJ` affiché « À l'arrêt » — avec **31 km/h** dans la colonne vitesse.
**Réel** : vu il y a 0 min, tracker ONLINE, `lastIgnition: false`, **`accConnected: false`**.

**Mécanisme** : sur les trois états d'une pastille, un seul exige le fil ACC du boîtier —
« au ralenti » (immobile moteur tournant). Les deux autres se lisent sur le GPS. Quand le fil
n'est pas posé, `ignition` vaut `false` en permanence : le lire ne donne pas une approximation,
il donne l'INVERSE.

**Ampleur** : **6 des 30 véhicules vivants** ont `accConnected: false`.

**Correctif** : sans le fil, on s'en tient à ce que le GPS prouve (roule / ne roule pas) et
« au ralenti » n'est jamais affirmé. Et fil raccordé mais contradictoire (remorquage, roue
libre) : on croit le GPS. `accConnected: null` garde le comportement d'avant.

Commit `558213a8`. Règle prouvée rouge, 6 tests neufs, suite web 654.

---

## 6. ⚠️ SIGNALÉ, NON CORRIGÉ — la carte meurt à la première perte de contexte WebGL

**Vu dans les journaux de production**, pas dans mon banc : deux plantages non rattrapés à
13:01 et 13:04, utilisateur `standard@cdef31.org` (société cdef31), page `/map` :

```
[uncaught] TypeError: Cannot read properties of null (reading 'getSource')
    at a.applyPositions (chunk-43LCW2LO.js)
```

**Cause, trouvée dans la source de maplibre-gl 5.24** — la bibliothèque met elle-même le style
à null sur une perte de contexte WebGL :

```
"... WebGL context loss. You will need to re-add them manually after context restoration."
this.style.destroy(), this.style = null
```

La référence `this.map` reste valide (la garde `if (!this.map) return` passe donc), mais chaque
`getSource()` lève ensuite. D'où deux erreurs à trois minutes d'intervalle : une par lot de
positions reçu.

**Ampleur** : **19 appels `getSource`** et 4 appels de calque dans le composant carte, et
**aucune écoute de `webglcontextlost` / `webglcontextrestored`** nulle part dans l'application.
Après une perte de contexte, la carte du client est donc morte — figée, muette, et levant à
chaque trame — jusqu'à ce qu'il recharge de lui-même. Rien ne le lui dit.

**Pourquoi je ne l'ai pas corrigé** : patcher un point d'appel sur 23 serait cosmétique, et le
vrai correctif (écouter la perte, prévenir l'utilisateur, reconstruire les couches à la
restauration) ne peut pas être vérifié dans ce banc — le volet ne peint pas, donc il n'y a pas
de carte, donc pas de perte de contexte à simuler. Sur l'écran désigné comme critique, livrer
non vérifié est le mauvais échange.

**Ce que ça vaut la peine de faire ensuite** : `map.on('webglcontextlost')` → marquer la carte
inutilisable et afficher « la carte a été interrompue, rechargez la page » ;
`map.on('webglcontextrestored')` → reconstruire sources et calques.
