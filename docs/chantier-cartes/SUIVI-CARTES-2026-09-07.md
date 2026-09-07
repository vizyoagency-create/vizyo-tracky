# Chantier CARTES — suivi d'exécution

> Fichier de suivi vivant. Une ligne par étape franchie, une entrée par défaut trouvé.
> Dossier de reprise (pièges, commandes, protocole) : `reprise-cartes/PREPARATION.md` et
> `reprise-cartes/CONSTATS-RECETTE.md`, hors dépôt, à la racine de `vizyo-tracky/`.
> Tout ce qui est écrit ici a été **mesuré**. Quand ce n'est pas le cas, c'est dit.

**Départ (2026-09-07 soir)** : `main` propre sur `e4348461`. Production : conteneurs construits à
18:09, soit le code de `872f0fda` ; l'arbre git du VPS est déjà à `e4348461`. Le premier
déploiement de ce chantier embarquera donc aussi `2a0d2326` (invitations, API) et `e4348461`.

---

## 0. Règles du chantier (rappel, non négociable)

- Cinq niveaux par tâche, dans l'ordre : **rouge d'abord → garde-fous → `ng build` → suites
  complètes → production mesurée et capturée**. Une tâche n'est pas finie avant le cinquième.
- `pnpm typecheck` ne couvre pas `apps/web` : seul `ng build` valide le composant carte.
- Aucun accent grave dans `template:` ni `styles: [\`…\`]`.
- `git add` par chemin explicite, jamais `-A`. Dire la branche avant de committer.
- Ne pas toucher aux récits ni à `COULEURS_CARTE.exces` / `.pointe`.
- Les décisions de la section 5 du dossier de reprise restent au propriétaire.
- Volet navigateur **au premier plan** pour toute mesure : masqué, il ne peint pas et bride
  les minuteurs (0 image/s, 0 XHR).

### Commandes de contrôle

```bash
pnpm verif:litteraux && pnpm verif:variables && pnpm verif:contraste \
  && pnpm verif:confirmations && pnpm verif:couleurs-kit && pnpm verif:accents \
  && pnpm verif:carte-gardes
pnpm --filter @vizyo/tracky-web exec ng build
pnpm --filter @vizyo/tracky-web exec ng test --watch=false --browsers=ChromeHeadless
pnpm --filter @vizyo/tracky-api exec jest
```

Déploiement et preuve d'artefact : dossier de reprise §1.3 et §0.8.

---

## 1. Ordre imposé et état

| # | Tâche | État | Niveaux passés |
|---|---|---|---|
| A | Prouver et finir la reconstruction des couches après perte de contexte WebGL | à faire | — |
| B1+B4 | Échelle de vitesse unique (source + tests), sans câblage | à faire | — |
| B3 | `segmentsColores()` + `<app-legende-vitesse>` + légendes générées | à faire | — |
| B2 | Câblage carte par carte : trip-replay, period-replay, public-trip (+DTO), depot | à faire | — |
| C | Traînées : mesurer, puis corriger | à faire | — |
| D | Légende repliable et mémorisée | à faire | — |
| R | Recette finale : captures 4 largeurs, sondes, correction des défauts | à faire | — |

---

## 2. Tâche A — perte de contexte WebGL

### Ce que MapLibre 5.24 fait réellement (lu dans `src/ui/map.ts`, pas dans le minifié)

- **Perte** (`_contextLost`, l.3497) : `painter.destroy()`, puis `_lostContextStyle =
  _getStyleAndImages()` — c'est `style.serialize()`, qui embarque **toutes les sources et
  couches, les nôtres comprises, avec leurs données** (`GeoJSONSource.serialize()` renvoie
  `data`). Puis `style.destroy(); style = null; fire('webglcontextlost')`.
- ⚠️ `serialize()` renvoie **`undefined` si le style n'est pas chargé** (`style.ts:1466`).
- **Retour** (`_contextRestored`, l.3531) : si la sauvegarde existe, `setStyle(sauvegarde,
  {diff:false})` → nouvel objet `Style` créé **synchrone**, chargement différé à un
  `requestAnimationFrame` (`loadJSON`, `style.ts:458`) → `_load` pose sources et couches,
  met `_loaded = true`, émet `styledata`. Ensuite seulement `fire('webglcontextrestored')`.
- `isStyleLoaded()` renvoie `undefined` (avec un `warnOnce`) quand le style est nul.

### Conséquences pour notre gestionnaire (`map.component.ts` l.3733)

- Cas nominal (style chargé à la perte) : au `styledata`, nos 8 `setup*` sortent sur leur
  garde « source déjà présente » ; `recreerCouches()` repeuple. **Devrait marcher — à mesurer.**
- Trou 1 : **perte pendant un style non chargé** (changement de fond, onglet à peine ouvert).
  Sauvegarde vide → MapLibre ne restaure rien → `style` reste nul → on retire le bandeau et on
  attend un `styledata` qui ne vient jamais. Carte vide, sans message, définitivement.
- Trou 2 : **le bandeau tombe à l'événement de retour**, la reconstruction n'arrive qu'au
  `styledata` (un rAF plus tard, jamais dans un onglet en arrière-plan). Fenêtre sans bandeau
  avec une carte noire.

### Plan

- [ ] A0 — Mesurer le comportement ACTUEL sur le banc local (`ng.getComponent`), sonde `etat()`
      avant / pendant / après. Critère : 4 sources présentes et nombre de couches revenu.
- [ ] A1 — Extraire le séquencement du retour dans une fonction pure testable
      (`features/map/reprise-contexte-webgl.ts`), tests rouges sur les deux trous.
- [ ] A2 — Correctif : style nul → réappliquer le fond courant ; drapeau levé au moment de
      reconstruire, pas avant. Vert.
- [ ] A3 — Garde-fous (7), `ng build`, `ng test`, `jest`.
- [ ] A4 — Sauvegarder les journaux du conteneur API hors arbre git AVANT de déployer
      (contrôle du 08/09). Déployer, attendre l'artefact.
- [ ] A5 — Production : reproduire la perte, compter les erreurs soi-même (0), bandeau,
      requête `/api/geofences` après le retour comme témoin, captures.

---

## 3. Tâche B — échelle de vitesse unique

Bandes demandées : 0 arrêt · 1–65 vert · 66–100 orange · 101–140 rouge · > 140 rouge foncé.

- [ ] B1 — `BANDES_VITESSE` + `couleurVitesse()` dans `shared/utils/couleurs-carte.ts` ;
      `speedColor()` délègue (export conservé).
- [ ] B4 — `maplibre-markers.spec.ts` : table `PALETTE` à 5 bandes, contraste 4,5:1 sur
      chacune (le rouge foncé `#991B1B` porte du blanc à ~8,3:1).
- [ ] B3 — `segmentsColores(points)` → `FeatureCollection` de segments `properties.color` ;
      `<app-legende-vitesse>` générée depuis `BANDES_VITESSE` ; remplacer les deux légendes
      manuscrites de `map.component.ts` (HUD l.1069-1081, planche l.996-1008).
- [ ] B2a — `reports/trip-replay.component.ts` (l.1454) : segments colorés. Vérifier.
- [ ] B2b — `reports/period-replay.component.ts` (l.1060). Vérifier.
- [ ] B2c — `public-trip` : le DTO public ne porte pas de vitesse → contrat API
      (`trip-share.service.ts`, `trace()`), tests, puis la carte. Vérifier.
- [ ] B2d — `depot-map.component.ts` : vérifier s'il y a un tracé.
- [ ] Recette : un rejeu d'autoroute change de couleur (ville / route / autoroute).

---

## 4. Tâche C — traînées

**Consignes du propriétaire (2026-09-07, en cours de chantier)** :
- **Tout se mesure en PRODUCTION**, véhicules réels en route. Le simulateur local fausse
  beaucoup de choses (positions, cadence, contact). Le banc local ne sert qu'à atteindre
  l'objet carte (`ng.getComponent`), rien d'autre.
- **Véhicules dont le fil ACC n'est pas raccordé** (réglage de la fiche véhicule,
  `accConnected: false` ; 6 des 30 véhicules vivants le 07/09) : `ignition` y vaut `false`
  en permanence, donc « roule / à l'arrêt » — et par conséquent les traînées — se décident
  sur le **GPS seul** (vitesse, déplacement), jamais sur le contact. Fil raccordé mais
  contradictoire : on croit le GPS. `accConnected: null` garde le comportement d'avant.
  (Même règle que la pastille, commit `558213a8`.)

- [ ] C0 — Mesurer en production sur 2-3 véhicules en route et 2-3 à l'arrêt, dont un sans
      ACC : `trailPoints.size`, âge du plus ancien point, ce qui est affiché. Lire
      `trailPoints`, `lastTruthPosition`, `motion`, `rejectStreak` avant.
- [ ] C1 — Corriger selon la mesure (longueur en points vs durée ; purge à l'arrêt ≥ 3 min ;
      hydratation initiale ; ACC non raccordé). Ne pas doubler la machinerie de lissage.
- [ ] Recette (production) : 2-3 traînées pour ceux qui roulent, aucune pour un arrêt
      ≥ 3 min, y compris pour un véhicule sans ACC.

## 5. Tâche D — soin visuel

- [ ] D1 — Légende repliable, repliée par défaut, choix mémorisé (patron `lieuxAffichage`).
- [ ] D3 — `showPlates` par défaut : **décision propriétaire**, ne pas toucher.

---

## 6. Journal (une ligne par étape, heure locale)

- 2026-09-07 — Lecture des deux dossiers ; état vérifié (branche, HEAD, VPS, MapLibre source).
  État du conteneur API relevé avant tout déploiement : OOMKilled=false, ExitCode=0,
  démarré 16:09:38Z.
- 2026-09-07 19:35 — **A0 mesuré** sur le banc local (`ng.getComponent`, compte tracky1).
  Cas nominal : après `restoreContext()`, style présent mais `loaded=false`, 0 `styledata`,
  0 rAF pendant 6 s — le volet ne tire ses rAF que pendant une capture (`raf` passe à 7 à la
  première capture). Dès qu'un rAF tire : `loaded=true`, 4 sources, 16 couches, traînées et
  clusters repeuplés (2 et 2), 0 erreur. **Les couches SONT reconstruites.**
  Défaut mesuré 1 : à `retour+300 ms`, bandeau retiré et `interrompue=false` alors que
  `loaded=false` et aucune source — fenêtre sans message, permanente onglet masqué.
  Défaut mesuré 2 : perte pendant un style non chargé (`map.setStyle(json)` puis perte) →
  au retour `style=null`, bandeau retiré, 0 `styledata` même après 10 rAF. Carte noire,
  marqueurs orphelins, aucun message, définitif.

## 7. Défauts trouvés en recette (à corriger, puis cocher)

_(vide pour l'instant)_

## 8. Décisions laissées au propriétaire

1. Alerte par gravité dans le watchdog (une tâche à l'arrêt n'envoie aucun e-mail).
2. Fonds CARTO « Plan clair / sombre » : tuiles « API KEY REQUIRED » en HTTP 200.
3. `showPlates: true` par défaut.
4. Contrôle du 08/09 07:15 : le trou d'automatisation est-il revenu ?
