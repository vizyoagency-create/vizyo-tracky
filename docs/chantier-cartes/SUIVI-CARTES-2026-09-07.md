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
| E | Repères de lieux NON déplaçables depuis les cartes (demande du 07/09 soir) | à faire | — |
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
- [x] A0 — Mesuré (journal du 19:35). Les couches reviennent ; les deux trous sont réels.
- [x] A1 — `reprise-contexte-webgl.ts` + spec : 2 tests rouges sur 4 avant correctif
      (drapeau baissé avant `styledata` ; fond jamais réappliqué sur style nul).
- [x] A2 — Correctif, 4/4 verts. Re-mesuré sur le banc : les deux scénarios reviennent à
      4 sources / 16 couches / données repeuplées / 0 erreur, bandeau retiré APRÈS.
- [x] A3 — 7 garde-fous verts, `ng build` OK (avertissements de budget préexistants),
      `ng test` 662/662, `jest` 3779/3779. Commit `09d04e2b`, poussé.
- [x] A4 — Journaux sauvegardés : `/root/journaux-tracky/tracky-api-avant-deploiement-*.log`
      (1 591 lignes, 0 CRITICAL depuis le démarrage de 16:09Z ; OOMKilled=false, exit 0).
      Déploiement lancé (embarque aussi `2a0d2326`, `cff8fc87`, `e4348461`).
- [x] A5 — **Prouvé en production** (session réelle du propriétaire, 1440 px, 20:10) :
      avant → 0 erreur, pas de bandeau ; perte+800 ms → bandeau « Affichage de la carte
      interrompu », 0 erreur ; retour+300 ms → bandeau ENCORE là (style pas rechargé, rAF en
      attente), 0 erreur ; après rAF → bandeau retiré, **2 requêtes `/api/geofences`**
      (`recreerCouches` a passé sa garde), 0 erreur, 41 marqueurs, carte repeinte. Captures
      prises aux quatre instants.

---

## 3. Tâche B — échelle de vitesse unique

Bandes demandées : 0 arrêt · 1–65 vert · 66–100 orange · 101–140 rouge · > 140 rouge foncé.

- [x] B1 — `BANDES_VITESSE` + `couleurVitesse()` dans `shared/utils/couleurs-carte.ts` ;
      `speedColor()` délègue (export conservé). Rouge d'abord : 3 tests de seuil rouges sur
      l'ancienne échelle (60 → orange, 95 → rouge, 150 → rouge et non foncé), puis verts.
      Vitesse absente (`NaN`) → gris « à l'arrêt », jamais le rouge foncé.
- [x] B4 — `maplibre-markers.spec.ts` : `PALETTE` générée depuis `BANDES_VITESSE` (7 fonds),
      contraste 4,5:1 sur chacun ; `couleurs-carte.spec.ts` : forme de la table, bornes,
      `speedColor === couleurVitesse` de 0 à 200. 35/35 verts.
- [x] B3 — `segmentsColores(points)` (`shared/utils/segments-vitesse.ts`, tronçons fusionnés
      par bande, point frontière répété, vitesse du point d'arrivée) ;
      `<app-legende-vitesse>` (`shared/ui/legende-vitesse/`) générée depuis la table, trois
      dispositions (liste, grille, ligne) ; les deux légendes manuscrites de
      `map.component.ts` remplacées. 44/44 verts sur les 4 specs. Commits `c4d6b9d4` (B1)
      et `95f86cf5` (B3), suite web 684/684, **déployés** — artefact vérifié
      (`lv-pastille`, `991b1b` présents dans le paquet servi).

**Ce que la base de production a appris (2026-09-07, lecture seule)** : les polylignes
stockées (`trips.polyline`, Douglas-Peucker 5 m, ≤ 500 points) ne portent AUCUNE vitesse ;
seuls 588 trajets sur 5 239 des 30 derniers jours ont un tracé recalé. Les vitesses sont
dans `positions.speedKmh`. L'historique fin (`GET /api/positions/history?detail=fine`, une
trame par relevé, 5 000 points au plus, refusé au-delà de 14 jours) est donc la source des
tronçons colorés des deux rejeux ; la page publique reçoit les siennes de l'API du partage.

- [x] B2a — `trip-replay` : trait vert immédiat depuis la polyligne, puis `history(fine)` du
      trajet → `pointsDepuisHistorique` (mêmes garde-fous : coordonnées invalides, sauts
      > 5 km) → `segmentsColores` posé sur la source ; peinture `coalesce(get color, vert)`
      donc repli vert uni si l'historique ne vient pas. Légende en bas à droite de la carte,
      au-dessus de la mention légale. Géométrie animée inchangée (polyligne). **À vérifier en
      production.**
- [x] B2b — `period-replay` : idem, trajet par trajet, trois requêtes en parallèle, repli vert
      par trajet. Légende idem. **À vérifier en production.**
- [x] B2c — contrat public : `PartageTrajetPublicDto.speedsKmh` (entiers, même index que
      `path`, décimés du même pas, dernier point compris). 3 tests rouges avant (clés,
      alignement, décimation), 22/22 après. `public-trip` : tronçons colorés + repli vert si
      l'API ne sert pas les vitesses ; légende « Couleur du tracé » sous la carte. **À
      vérifier en production** (nécessite un lien de partage actif).
- [x] B2d — `depot-map.component.ts` : vérifié, **aucun tracé** (marqueurs seulement). Rien à
      câbler.
- [x] Recette production (session du propriétaire, 1440 px, 20:15-20:30) :
      · **B2a** rejeu du trajet GA-490-SJ 14:17 (A2R, 39,5 km, pointe 106) : historique fin
        demandé (200, 102 ms), tracé vert en ville, orange sur la rocade, pastilles d'excès
        et de pointes intactes par-dessus, légende à cinq bandes en bas à droite ;
      · **B2b** rejeu de période GA-490-SJ 07/09 (11 trajets, 200 km) : 11 historiques
        demandés, tracés colorés trajet par trajet, légende. ⚠️ Un bandeau « la carte n'a
        pas pu se charger (délai dépassé) » apparaît sur la PREMIÈRE capture : artefact du
        banc (le volet ne tire ses rAF qu'à la capture, le garde-fou de chargement expire
        avant le premier rendu), la carte se peint à la capture suivante — pas un défaut ;
      · **B2c** page publique `/t/aHsm…` (FV-941-LZ, mh cars, 84 km, pointe 132) : l'API sert
        84 vitesses alignées sur 84 points et rien d'autre (10 champs), légende « Couleur du
        tracé » sous la carte, tracé vert en ville / orange / **rouge sur l'autoroute**.
        Lien de test déjà existant (18 ouvertures), aucun lien créé sur un trajet client.

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

- [x] C0 — **Mesuré en base de production** (90 dernières minutes, 19:55) : trois
      véhicules en route émettent toutes les **10 à 16 s** (pas 30) ; treize à l'arrêt
      émettent toutes les **2 à 6 min** avec un bruit GPS de **7 à 23 m en moyenne, 65 à
      243 m au pire** entre deux trames, et jusqu'à 31 positions distinctes sans bouger.
      L'ancienne règle (déduplication sur l'égalité exacte, aucune purge) faisait donc de
      chaque trame bruitée un point de traînée, et rien ne l'effaçait. À 20 points, la
      traînée d'un véhicule en route couvrait 3 à 5 min de route.
      Le code ne lit `ignition` nulle part pour la traînée : le GPS seul décide, déjà.
- [x] C1 — `features/map/trainee.ts` : une trame n'entre que si elle est NEUVE (horodatage
      boîtier jamais vu, car `applyPositions` rejoue la dernière trame à chaque flush) ET que
      le GPS prouve un mouvement (vitesse annoncée > 3 km/h ou déduite > 8 km/h, au-dessus du
      bruit mesuré) ; trois minutes sans mouvement effacent tout. Défaut 4 points, curseur
      2-8, un réglage hors plage (l'ancien défaut 20 recopié chez tous) retombe au défaut.
      7 tests rouges sur l'ancien comportement, 15/15 verts après. Lissage inchangé.
- [ ] Recette (production) : 2-3 traînées pour ceux qui roulent, aucune pour un arrêt
      ≥ 3 min, y compris pour un véhicule sans ACC.

## 5. Tâche D — soin visuel

- [x] D1 — HUD de bureau : bouton « Légende » (aria-expanded), repliée par défaut, préférence
      `legendeRepliee` (défaut + persistance + anciennes préférences → défaut). Spec prouvée
      rouge en changeant le défaut (2 échecs), verte ensuite. **À vérifier en production.**
- [ ] D3 — `showPlates` par défaut : **décision propriétaire**, ne pas toucher.

## 5 bis. Tâche E — les repères de lieux ne bougent plus depuis les cartes

**Demande du propriétaire (2026-09-07, 20 h)** : sur mobile, en déplaçant la carte, on déplace
parfois une station ou un parking sans le vouloir. Le glisser-déposer d'un repère ne doit
exister que depuis la page Lieux, jamais depuis les pages carte.

**Constat** : `map.component.ts` (`renderFleetPlaceMarkers`, ~l.5499) crée le marqueur avec
`draggable: canManagePlaces()` et persiste au `dragend`. Un doigt qui veut faire défiler la
carte et tombe sur un repère de 44 px le déplace, et la position est enregistrée en base.

- [x] E1 — `draggable: false` sur la carte temps réel, `persistPlaceMove` retiré.
      **Constat** : la page Lieux n'avait AUCUN moyen de déplacer un lieu (pas de carte) ;
      retirer le glisser de la carte aurait rendu le déplacement impossible.
- [x] E2 — `features/places/place-move.component.ts` : bouton « Déplacer » (droit
      `places_manage`) → boîte avec une carte faite pour ça, repère glissable, bouton
      d'enregistrement inactif tant que rien n'a bougé ; 3 tests (contrat d'enregistrement,
      échec dit, rien d'émis sans déplacement).
- [ ] Recette production, mobile 375 px : faire défiler la carte sur un repère ne le déplace
      pas ; page Lieux → Déplacer → glisser → Enregistrer déplace bien.

---

## 5 ter. État des déploiements

| Commit(s) | Contenu | Déployé | Artefact vérifié |
|---|---|---|---|
| `09d04e2b` | A — reprise WebGL | 19:50 | `fond-reapplique` dans le paquet web |
| `c4d6b9d4` `95f86cf5` | B1+B4, B3 | 20:00 | `lv-pastille`, `991b1b` |
| `0ce1e70c` `ad5b12bc` `11c44103` | B2a, B2b, B2c (+ `3fb96da9` d'une autre session) | 20:40 (second lancement, le premier n'avait pas recréé les conteneurs) | `speedsKmh` ×4 dans l'API, `pj-legende`, `tr-legende-v`, `pr-legende-v` |
| `df9905cf` `7f184173` | C, D1, E1, E2 | 21:05 | `mp-legende-b`, `pm-boite` |

⚠️ Un `docker compose up -d --build` a rendu la main avec exit 0 SANS recréer les conteneurs
(20:25) : les images n'avaient pas été reconstruites. Toujours lire l'artefact ; relancer si
`docker ps` montre des conteneurs plus vieux que le déploiement.

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

Recette de production du 08/09 (00:30-01:20), session du propriétaire, deux sondes sur `/map`,
`/places`, `/reports`, `/t/:token` à 375, 768, 1440 et 1920 px.

- [x] **R1 — L'infobulle du repère disait encore « glissez pour déplacer »** alors que le
      glisser est retiré (E1). Vu en simulant le glisser : 0 px de déplacement, mais le `title`
      promettait le geste. Corrigé : `title = nom`, plus de curseur « grab ».
- [x] **R2 — La pastille « Légende » repliée chevauchait les commandes MapLibre** (zoom,
      boussole, posées en bas à droite) : zone commune de 19 px mesurée à 768 et 1920 px par
      la sonde de collision, confirmée par `elementFromPoint`. Corrigé : HUD décalé à
      `right: 56px`, à gauche des commandes. Absent à 375 (HUD masqué) et invisible à 1440
      seulement par chance de hauteur.

Écartés, préexistants et hors chantier :
- « Toutes les sociétés » élidé dans la puce du sélecteur à 375 et 768 px (`w 96 / sw 101`) :
  élision volontaire d'un libellé long dans la barre du haut.
- « Assistance » recouvert de 12 px par la carte « Agent IA » à 1440 px : c'est le bas de la
  liste de navigation défilante — même faux positif que la recette du 07/09 (atteignable
  après défilement).
- « Carte » contre « Départ » / « Arrivée » sur la page publique : un marqueur (role=button)
  posé sur le canevas (tabindex 0) est la définition même d'une carte, pas une collision.

## 8. Décisions laissées au propriétaire

1. Alerte par gravité dans le watchdog (une tâche à l'arrêt n'envoie aucun e-mail).
2. Fonds CARTO « Plan clair / sombre » : tuiles « API KEY REQUIRED » en HTTP 200.
3. `showPlates: true` par défaut.
4. Contrôle du 08/09 07:15 : le trou d'automatisation est-il revenu ? ⚠️ Le conteneur API a
   été recréé le 07/09 (déploiements de ce chantier) : ses journaux d'avant sont dans
   `/root/journaux-tracky/` sur le VPS, `docker inspect` ne dira plus rien d'avant 17:38Z.
5. **Le rouge de la bande 101-140 (`#EF4444`) est aussi le rouge des excès confirmés**, et
   l'orange 66-100 (`#F59E0B`) celui des pointes. Sur le rejeu, excès et pointes restent des
   PASTILLES cerclées de blanc (pas des tronçons), et la légende de vitesse nomme les bandes ;
   la distinction tient par la forme. À valider à l'œil par le propriétaire ; si elle ne
   suffit pas, c'est la teinte des bandes qu'il faut changer, jamais `COULEURS_CARTE.exces`
   ni `.pointe`.
