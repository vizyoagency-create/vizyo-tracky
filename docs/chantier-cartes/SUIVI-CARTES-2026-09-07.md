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
| A | Prouver et finir la reconstruction des couches après perte de contexte WebGL | fait | 1-5 |
| B1+B4 | Échelle de vitesse unique (source + tests), sans câblage | fait | 1-5 |
| B3 | `segmentsColores()` + `<app-legende-vitesse>` + légendes générées | fait | 1-5 |
| B2 | Câblage carte par carte : trip-replay, period-replay, public-trip (+DTO), depot | fait | 1-5 |
| C | Traînées : mesurer, puis corriger | fait | 1-5 |
| D | Légende repliable et mémorisée | fait (D3 laissé au propriétaire) | 1-5 |
| E | Repères de lieux NON déplaçables depuis les cartes (demande du 07/09 soir) | fait | 1-5 |
| R | Recette finale : captures 4 largeurs, sondes, correction des défauts | fait | 1-5 |
| F | Décisions tranchées selon les choix clients (§ 9) : vigie critique, fonds Esri, Calques, contrôle de l'automatisation, tracé paramétrable | fait | 1-5 |

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
- [x] Recette (production, 08/09 00:45-01:25, session du propriétaire) : le réglage hérité
      `trailLength: 20` du compte est bien retombé à 4 au chargement. Carte cdef31 laissée
      ouverte 25 min avec 22 véhicules à l'arrêt : **aucune traînée** derrière eux (l'ancienne
      règle en aurait fabriqué à partir du bruit GPS). HD-779-MA (A2R) suivi en roulant (39 à
      96 km/h, vue libre, échelle 100 m) : **une traînée courte de deux à trois tronçons** verte
      derrière le véhicule, qui le suit trame après trame. Sans fil ACC : la règle ne lit pas
      `ignition`, prouvé par les tests ; pas de véhicule sans ACC en mouvement à cette heure.

## 5. Tâche D — soin visuel

- [x] D1 — HUD de bureau : bouton « Légende » (aria-expanded), repliée par défaut, préférence
      `legendeRepliee` (défaut + persistance + anciennes préférences → défaut). Spec prouvée
      rouge en changeant le défaut (2 échecs), verte ensuite. **Vérifié en production** :
      repliée à l'ouverture, cinq bandes au clic, préférence écrite, état conservé après
      rechargement dans les deux sens.
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
- [x] Recette production (08/09) : sur la carte cdef31, glisser simulé de 80 × 48 px sur le
      repère « Auchan — Launaguet » → **0 px de déplacement**, aucune requête vers
      `/api/fleet-places`. Page Lieux → « Déplacer » sur le même lieu → boîte avec carte et
      repère, bouton inactif ; le même glisser déplace le repère de 80 × 48 px, les
      coordonnées passent à 43,65873 / 1,45675 « nouvelle position, non enregistrée », bouton
      actif ; « Annuler » referme sans requête, la liste garde 43,6591 / 1,4559. L'enregistrement
      lui-même n'a pas été joué sur un lieu client (contrat couvert par les tests).

---

## 5 ter. État des déploiements

| Commit(s) | Contenu | Déployé | Artefact vérifié |
|---|---|---|---|
| `09d04e2b` | A — reprise WebGL | 19:50 | `fond-reapplique` dans le paquet web |
| `c4d6b9d4` `95f86cf5` | B1+B4, B3 | 20:00 | `lv-pastille`, `991b1b` |
| `0ce1e70c` `ad5b12bc` `11c44103` | B2a, B2b, B2c (+ `3fb96da9` d'une autre session) | 20:40 (second lancement, le premier n'avait pas recréé les conteneurs) | `speedsKmh` ×4 dans l'API, `pj-legende`, `tr-legende-v`, `pr-legende-v` |
| `df9905cf` `7f184173` | C, D1, E1, E2 | 21:05 | `mp-legende-b`, `pm-boite` |
| `1e3841c0` | R1+R2 : infobulle, légende hors des commandes | 08/09 01:22 (conteneurs recréés 23:22:46Z) | `chunk-XOA6VNXP.js` : `"right","56px"` présent, `glissez` absent (0) — puis **contre-vérifié à l'écran** |
| `c2afb01f` | R3 : géométrie de la polyligne, recalage par lots de dix, recalage à la demande | 08/09 02:25 | API : route `map-matching`, `OSRM_MAX_COORDONNEES`, `vitessesSurTrace` dans le tracé public ; web : `chunk-Y3POCC2H.js` — puis **contre-vérifié à l'écran** |
| `cfc91f82` `2c68c65e` `f988c74e` `a9c5a4a9` | F : fonds Esri, tracé et traînée paramétrables, vigie critique, docs | 08/09 02:57 (conteneurs recréés 00:56 UTC, hors de la fenêtre HH:44-HH:56 ; le passage de 00:45 s'était clos à 00:51:21) | web : `chunk-A7MPWIKC.js` (`World_Light_Gray_Base`), `chunk-3BYQORV7.js` (`cl-trainee-curseur`), `chunk-K3MRYL4P.js` (`tr-legende-case`, `pr-legende-case`), **0 fichier `cartocdn`** ; API : `critical_error_alert` dans `email.service.js` et `email-admin.service.js`, `VIGIE_CRITIQUE` dans la vigie — puis **contre-vérifié à l'écran** (§ 9) |

| `dae97b03` `3e46c222` `3d6834b8` | La ligne au départ (automatisation) + retouches de libellé | 08/09 07:42 puis 07:52 (conteneurs recréés 05:42:51 et ~05:56 UTC, hors passage) | migration `20260908053000` appliquée à 05:42:53, `status` défaut `'done'` ; API : `ouvrirLigne`, `marquerPassagesInterrompus` ; web : `chunk-VYFVK5HZ.js` (`ta-run-etat`) — puis **contre-vérifié sur un vrai passage tué** (§ 9.4 bis) |

**Le chantier est terminé, décisions comprises.** Les six tâches (A, B1+B4, B3, B2, C, D1, E),
les trois défauts de recette (R1, R2, R3), les cinq décisions (§ 9) et la ligne au départ de
l'automatisation (§ 9.4 bis, demandée le 08/09 au matin) sont passés par les cinq niveaux,
jusqu'à la mesure en production.

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
- 2026-09-08 02:35 — Le propriétaire demande de trancher les décisions restantes selon les
  choix clients (détail maximal, lisible, paramétrable dans les filtres). Lecture des données
  de production (vigie, tuiles, passages d'automatisation, planche Calques).
- 2026-09-08 02:40 — Tuiles Esri Gray Canvas téléchargées et LUES (Toulouse z12 et z16) :
  propres, libellés dans le calque de référence et dans la base dès z16.
- 2026-09-08 02:45 — Code des quatre lots écrit. Rouge d'abord prouvé par `git stash` du seul
  fichier de code : vigie 4 échecs / 7, catalogue des fonds 3 / 6, préférence = erreur de
  compilation. Sept garde-fous verts, `ng build` 70 s, Karma **714** (705 avant), typecheck
  API vert, jest API 3815 verts + 1 échec pré-existant (`catalogue-exhaustif` : le cron
  `email-health` d'une autre session n'est pas catalogué — pas à moi), jest shared 416.
- 2026-09-08 02:51 — Quatre commits par chemin explicite (dont une ligne du catalogue e-mails
  posée dans l'index par `git apply --cached`, le fichier étant en cours d'édition par une
  autre session), push. Attente de la fin du passage d'automatisation de 00:45 UTC (clos
  00:51:21), déploiement 00:53 → 00:57 UTC, artefacts lus dans les conteneurs.
- 2026-09-08 03:00 — Recette en production sur la session du propriétaire (§ 9) ; réglages
  remis tels qu'ils étaient (fond « Plan », traînée 4 points, couleur active, filtre
  véhicules « Tous »).
- 2026-09-08 07:20 — Le propriétaire demande la ligne au départ de l'automatisation (§ 9.4
  bis). Schéma + migration (SQL généré par `prisma migrate diff`, appliqué en local), service,
  DTO partagé, écran d'historique ; rouge d'abord prouvé ; typecheck, jest API (3838 verts, le
  seul échec est le `catalogue-exhaustif` d'une autre session), shared 416, garde-fous, `ng
  build`, Karma 717.
- 2026-09-08 07:36 — Déploiement placé AVANT le passage de 05:45 UTC (fini 05:43:17), puis test
  grandeur nature : passage tué à 05:45:06, marqué interrompu à 05:45:22, e-mail critique
  livré à 05:50:00, écran vérifié à 05:52. Deux libellés retouchés et redéployés (05:51 →).

## 7. Défauts trouvés en recette (à corriger, puis cocher)

Recette de production du 08/09 (00:30-01:20), session du propriétaire, deux sondes sur `/map`,
`/places`, `/reports`, `/t/:token` à 375, 768, 1440 et 1920 px.

- [x] **R1 — L'infobulle du repère disait encore « glissez pour déplacer »** alors que le
      glisser est retiré (E1). Vu en simulant le glisser : 0 px de déplacement, mais le `title`
      promettait le geste. Corrigé : `title = nom`, plus de curseur « grab ».
      **Contre-vérifié en production le 08/09** (service worker retiré et 11 caches purgés
      d'abord, société cdef31, 12 repères) : aucun `title` ne contient « glissez », les
      infobulles ne portent que le nom, le curseur est `pointer` partout, et un glisser simulé
      de 120 × 70 px donne **0 px de déplacement**, `transform` inchangé, **0 requête**
      `/api/fleet-places`, aucun message de confirmation.
- [x] **R2 — La pastille « Légende » repliée chevauchait les commandes MapLibre** (zoom,
      boussole, posées en bas à droite) : zone commune de 19 px mesurée à 768 et 1920 px par
      la sonde de collision, confirmée par `elementFromPoint`. Corrigé : HUD décalé à
      `right: 56px`, à gauche des commandes. Absent à 375 (HUD masqué) et invisible à 1440
      seulement par chance de hauteur.
      **Contre-vérifié en production le 08/09**, repliée ET dépliée, à 768, 1440 et 1920 px :
      **0 collision**, **15 px d'écart** entre le bord droit de la légende et le bord gauche
      des commandes à chaque largeur. Test de touche : le centre du bouton « Légende » atteint
      la légende, le centre de « Zoomer » atteint le bouton de zoom. Légende dépliée : cinq
      bandes et cinq repères ; repliée de nouveau, préférence réécrite à `true`.

⚠️ **Le service worker sert l'ancien paquet** : sans le purger, cette contre-vérification
aurait jugé le paquet d'avant le correctif. Toujours le retirer avant de juger une correction
d'interface (piège 0.6 du dossier de reprise).

- [x] **R3 — « Les courbes sont mauvaises » (propriétaire, 08/09 01:55, capture du rejeu
      GA-490-SJ 21:23 UTC, 9,1 km, pointe 106)** : le tracé coloré est fait de droites entre
      quelques points, une diagonale orange traverse Les Izards.
      **Cause 1, ma régression (B2a/B2b/B2c)** : le tracé coloré prenait sa géométrie dans les
      POSITIONS stockées, alors que le trait vert d'avant prenait la polyligne recalée quand
      elle existe. Mesuré en base : ce trajet a 29 positions pour 9,1 km, une trame toutes
      les 24 à 99 s à plus de 90 km/h, **2 558 m sans point** entre le péage et Borderouge —
      le serveur avait tout inséré (« mouvement actif »), il n'y avait rien de plus.
      **Cause 2, préexistante** : le recalage OSRM échouait pour tout trajet de plus de dix
      points. Mesuré contre `router.project-osrm.org` avec les 29 points réels : **10
      coordonnées passent, 11 sont refusées (HTTP 400)** ; rayon 40 m passe, 50 m refusé ;
      chaque lot de 5 à 10 points se recale à 90 % de confiance, 154 points de route pour
      9 points bruts. Le code envoyait des lots de 100. En base sur huit jours : 100 % de
      recalés sous 10 points, 39 % entre 10 et 29, **0 % au-delà de 30**.
      **Correctif** : (a) `vitessesSurTrace` (paquet partagé) prête à chaque sommet de la
      polyligne la vitesse du relevé le plus proche, en avançant ; rejeu, rejeu de période et
      page publique colorent la POLYLIGNE (recalée, sinon brute), plus jamais les relevés ;
      (b) recalage par lots de 10 qui se chevauchent d'un point, pause de 150 ms, un lot
      refusé garde ses points bruts sans perdre le trajet ; (c) recalage **à la demande** :
      `POST /api/trips/:id/map-matching` quand un rejeu s'ouvre sur un trajet sans tracé
      recalé, résultat rangé pour les rejeux suivants ; le tracé brut s'affiche sans attendre,
      la route vient le remplacer sous le véhicule sans toucher au curseur.
      Tests : 5 (partagé), 6 (lots, 2 rouges avant), 6 (à la demande), 24 (public, 2 rouges
      avant), +1 web. Commit `c2afb01f`, déployé 08/09 02:25.
      **Vérifié en production (02:30, session du propriétaire)** : rejeu du trajet même de la
      capture → `POST /api/trips/d281a6cd…/map-matching` répond 201 en 1,06 s, journal API
      « 23 -> 344 points », tracé rouge sur l'A620, orange dans l'échangeur, vert vers
      Croix-Daurade, **plus aucune diagonale**, rangé en base (344 points). Rejeu du trajet du
      lien public FV-941-LZ (84 km) → recalé de même ; la page publique sert désormais
      **1 463 points** qui suivent l'A68, colorés par bande.
      ⚠️ Reste vrai : un trajet jamais rejoué garde sa polyligne brute (le recalage se fait au
      premier rejeu) ; le rejeu de période ne déclenche pas de recalage (trop de requêtes pour
      le service public) et colore ce qui existe. Un OSRM auto-hébergé (`OSRM_BASE_URL`)
      lèverait ces limites.

Écartés, préexistants et hors chantier :
- « Toutes les sociétés » élidé dans la puce du sélecteur à 375 et 768 px (`w 96 / sw 101`) :
  élision volontaire d'un libellé long dans la barre du haut.
- « Assistance » recouvert de 12 px par la carte « Agent IA » à 1440 px : c'est le bas de la
  liste de navigation défilante — même faux positif que la recette du 07/09 (atteignable
  après défilement).
- « Carte » contre « Départ » / « Arrivée » sur la page publique : un marqueur (role=button)
  posé sur le canevas (tabindex 0) est la définition même d'une carte, pas une collision.

## 8. Décisions laissées au propriétaire

Le 08/09 (02:35), le propriétaire m'a demandé de **trancher moi-même, selon les choix
clients** : « un max de détail facile à comprendre, et paramétrable dans les filtres ». Ce qui
a été décidé et fait est en section 9 ; cette liste garde l'état de chaque point.

1. ~~Alerte par gravité dans le watchdog~~ — **TRANCHÉ (§ 9.1)** : une erreur CRITICAL suffit.
2. ~~Fonds CARTO « Plan clair / sombre »~~ — **TRANCHÉ (§ 9.2)** : fonds gris Esri, sans clé.
3. ~~`showPlates: true` par défaut~~ — **GARDÉ tel quel** : le client veut le détail d'emblée,
   et la case « Étiquettes plaques » de la planche Calques permet déjà de le couper.
4. Contrôle du 08/09 07:15 — **FAIT à 02:30 (§ 9.4)** : le trou n'est pas revenu de lui-même,
   mais un passage a de nouveau disparu SANS TRACE, tué par un redéploiement. ⚠️ Le conteneur
   API a été recréé le 07/09 (déploiements de ce chantier) : ses journaux d'avant sont dans
   `/root/journaux-tracky/` sur le VPS, `docker inspect` ne dira plus rien d'avant 17:38Z.
6. ~~**Chaque redéploiement déconnecte la session du propriétaire**~~ — **RÉSOLU par une autre
   session** (`9a6531a8`, déployé). Le symptôme que j'avais relevé deux fois (07/09 21:05,
   08/09 01:35) avait la cause suivante : pendant la recréation du conteneur, Traefik perd le
   routeur de l'API, `/api/*` retombe sur le front, et nginx répond **405** à un POST. Or
   `tryRefresh()` ne jugeait « indisponible » qu'un code 0 ou ≥ 500 : le 405 passait pour un
   refus et l'intercepteur déconnectait. Désormais seuls 401 et 403 sont des refus.
   ✅ Constaté ici : un redéploiement a eu lieu pendant cette recette et **la session a tenu**.
5. **Le rouge de la bande 101-140 (`#EF4444`) est aussi le rouge des excès confirmés**, et
   l'orange 66-100 (`#F59E0B`) celui des pointes. Sur le rejeu, excès et pointes restent des
   PASTILLES cerclées de blanc (pas des tronçons), et la légende de vitesse nomme les bandes ;
   la distinction tient par la forme. — **TRANCHÉ (§ 9.5)** : la couleur reste (le détail
   d'emblée), et devient une CASE retenue par utilisateur, dans les rejeux et dans Calques ;
   les teintes des bandes, `COULEURS_CARTE.exces` et `.pointe` n'ont pas bougé.

## 9. Décisions tranchées selon les choix clients (08/09, 02:35 → )

Règle de décision, donnée par le propriétaire : le client veut **un maximum de détail, facile
à comprendre, et paramétrable dans les filtres**. Chaque point ci-dessous a suivi les cinq
niveaux (rouge d'abord — prouvé par un `git stash` du seul fichier de code, spec lancée,
`stash pop` —, garde-fous, `ng build`, suites complètes, production).

### 9.1 Vigie : une erreur critique suffit

- **Constat** : `ErrorRateWatchdogService` ne regardait que le DÉBIT (5 erreurs/heure). Le
  07/09 à 18:50 (UTC), `agents-locaux` a écrit « Passage manqué : agent-limites-vitesse » en
  CRITICAL ; aucun e-mail, la ligne était seule dans l'heure.
- **Décision** : toute erreur CRITICAL de l'heure glissante prévient, même seule, sous le seuil.
  Refroidissement PROPRE d'une heure (`CLES_REFROIDISSEMENT.VIGIE_CRITIQUE`, en base comme
  l'autre). Au-dessus du seuil, l'e-mail de saturation cite déjà les critiques et pose les
  DEUX refroidissements : un seul e-mail par heure, quelle que soit la vigie qui parle. Même
  destinataire (`ERROR_RATE_ALERT_TO`, défaut `contact@vizyoagency.com`). Interrupteur
  `ERROR_CRITICAL_ALERT=off` pour couper cette vigie seule.
- **E-mail** : nouveau gabarit `critical_error_alert` (`buildCriticalErrorAlertEmail`), même
  coque que la saturation, filet rouge, détail limité aux sources CRITIQUES, bouton « Ouvrir le
  centre d'alerte ». Catalogué (`email-admin.service.ts`) et couvert par les deux specs
  exhaustives des gabarits.
- **Rouge d'abord** : `vigie-erreurs-critiques.spec.ts` contre l'ancien service → 4 échecs sur
  7 (les trois verts sont les cas de silence).
- **Non fait, exprès** : aucune erreur CRITICAL synthétique injectée en production pour « voir
  l'e-mail partir » — ce serait polluer le centre d'alerte et la boîte d'exploitation. La
  mécanique est prouvée par les tests ; le premier vrai CRITICAL l'exercera.
- ✅ **Contre-vérifié en production** (03:00) : `GET /api/admin/emails/templates/critical_error_alert/preview`
  → 200, sujet « 1 erreur critique — trip-automation », HTML avec le titre, le détail des sources
  et le bouton « Ouvrir le centre d'alerte » (fichier remis au propriétaire) ; le gabarit figure
  dans `GET /api/admin/emails/templates` ; l'écran des tâches de fond nomme désormais la tâche
  « Vigie du centre d'alerte » avec sa nouvelle raison d'être. Aucune ligne de vigie au journal
  API depuis le redémarrage : aucune erreur critique dans l'heure, c'est le comportement attendu.

### 9.2 Fonds « Plan clair / sombre » : Esri à la place de CARTO

- **Constat** : les tuiles `basemaps.cartocdn.com` répondent 200 avec « API KEY REQUIRED » en
  travers ; l'hybride prenait aussi ses libellés chez CARTO.
- **Décision** : `Canvas/World_Light_Gray_Base` + `World_Light_Gray_Reference` (clair),
  `Canvas/World_Dark_Gray_Base` + `World_Dark_Gray_Reference` (sombre), libellés de l'hybride
  par `Reference/World_Boundaries_and_Places` — tous chez `server.arcgisonline.com`, sans
  clé, `maxZoom` 16 (mesuré : la base gris clair porte les noms de rues dès z16). Tuiles
  vérifiées une à une avant le remplacement (Toulouse, z12 et z16 : propres, sans filigrane).
  Les identifiants `dark` / `light` / `hybrid` ne changent pas : la préférence persistée de
  chaque utilisateur reste valide.
- **Rouge d'abord** : `map-style.service.spec.ts` contre l'ancien catalogue → 3 échecs sur 6.
- ✅ **Contre-vérifié en production** (03:00, 1440×900) : « Plan clair » puis « Plan sombre »
  choisis dans le sélecteur de la carte — fond gris propre, noms de communes lisibles
  (Aucamville, Launaguet, L'Union, Saint-Jean, Blagnac), **aucun filigrane** ; le paquet web ne
  contient plus une seule URL `cartocdn`. Fond remis sur « Plan » (préférence relue : `osm`).

### 9.3 Panneau Calques : la traînée se règle dans les filtres

- « Trajets du jour » mentait (la traînée fait quelques points, pas la journée) → **« Traînée
  derrière les véhicules »**, et sous sa case, en retrait : **« Colorée par la vitesse »** et
  un **curseur « Longueur : N points » (2 à 8)**. Le curseur raccourcit la traînée TOUT DE
  SUITE (les points en trop sont coupés, puis les dernières trames sont rejouées), sans
  attendre la trame suivante — un véhicule à l'arrêt n'en envoie qu'une toutes les 2 à 6 min.
- « Étiquettes plaques » reste (point 3 de la section 8).
- ✅ **Contre-vérifié en production** (03:00) : la planche montre « Traînée derrière les
  véhicules », « Colorée par la vitesse » et « Longueur : 4 points » avec son curseur. Case
  décochée → préférence `traceParVitesse: false` relue en localStorage, recochée → `true` ;
  curseur cliqué à gauche → « Longueur : 2 points » et `trailLength: 2` retenu, remis à 4.
  (Les flèches du clavier n'ont pas bougé le curseur dans le volet : le focus n'y était pas ;
  le clic sur la piste, lui, fait le réglage.)

### 9.4 Contrôle de l'automatisation des trajets (fait à 02:30 au lieu de 07:15)

Lu en base (`trip_automation_runs`, `system_activity_logs`) :

| Passage (UTC) | État |
|---|---|
| 21:45 → 21:54 | OK, 4 analysés |
| 22:45 → 22:53 | OK, 4 analysés |
| **23:45** | **AUCUNE ligne**, ni run, ni « tick annulé par la garde » |
| 00:45 | à venir (le conteneur a été recréé à 00:20 par ce chantier) |

Le conteneur API a été recréé à **23:29 UTC** par une autre session, puis par moi à 00:20 UTC.
Le passage de 23:45 n'a laissé aucune trace : ce n'est pas la garde anti double-run (elle écrit
`trip_automation_tick_annule`), c'est un passage **jamais démarré ou tué en vol**, et
`recordRun` n'écrit la ligne qu'à la FIN. Les journaux du conteneur d'avant 00:20 ont disparu
avec lui. Conclusion : le trou du 07/09 n'est pas revenu « tout seul », il revient à chaque
redéploiement qui tombe entre HH:45 et HH:55 — et **rien ne le signale**.

~~Proposition (non faite, hors périmètre cartes, à décider) : écrire la ligne de
`trip_automation_runs` AU DÉPART (`finishedAt` nul) et la compléter à la fin.~~ → **DEMANDÉE
par le propriétaire le 08/09 à 07:20, FAITE (§ 9.4 bis)**. Mesure complémentaire (autre
session, même nuit) : un passage dure de 2 à 54 min selon la charge, quatre passages tués le
07/09 (14:45, 15:45, 17:45, 23:45 UTC) — la fenêtre à risque va donc de HH:45 à HH+1:09, pas
HH:44-HH:56. Règle d'exploitation : **lire `trip_automation_runs` avant de déployer** (avec la
ligne au départ, un passage en cours s'y voit désormais).

### 9.4 bis La ligne au départ — un passage tué ne disparaît plus sans trace

**Ce que ça fait, en clair.** Avant, l'automatisation n'écrivait sa ligne d'historique qu'à la
FIN du passage. Un passage tué en plein vol (conteneur recréé par un déploiement, crash, OOM)
ne laissait donc rien : ni ligne, ni « tick annulé », ni erreur — comme si l'heure avait été
sautée en silence. Désormais :

1. **Au premier instant du passage**, une ligne est écrite dans `trip_automation_runs` avec
   l'heure de départ, l'origine (planifié / manuel) et l'état `running` — avant de toucher à
   la moindre flotte.
2. **À la clôture**, c'est cette MÊME ligne qui est complétée : fin, durée, compteurs, trajets
   traités, état `done` (ou `failed` si le passage s'est arrêté sur une exception).
3. **Au redémarrage de l'API**, toute ligne encore `running` est forcément un passage mort (ce
   processus est le seul à en lancer, et il vient de naître) : elle passe à `interrupted`, sa
   fin reste vide, une ligne va au journal d'activité (`trip_automation_passage_interrompu`) et
   une erreur **CRITICAL** au centre d'alerte — la vigie des critiques (§ 9.1) l'envoie par
   e-mail dans les dix minutes.
4. **Ce qui n'est pas fait, exprès** : relancer le travail. Le passage suivant (HH:45) reprend
   les trajets non traités, le pipeline partant toujours du reste à faire. Et si la ligne de
   départ ne peut pas s'écrire (base injoignable à cet instant), le passage tourne quand même
   et la clôture la crée comme avant : rien de l'ancien comportement n'est perdu.

**Garde anti double-run** : inchangée dans son effet. Elle mesure depuis le dernier DÉPART
persisté ; un passage interrompu y laisse maintenant son départ, comme un passage clos.

**Implémentation** : colonne `status` (`running | done | failed | interrupted`, défaut `done`
pour les lignes existantes, toutes closes) — migration
`20260908053000_passage_automatisation_ligne_au_depart`, SQL généré par `prisma migrate
diff`, appliquée sur la base locale avant tout. `ouvrirLigne()`, `recordRun()` complète par
identifiant (recrée si la ligne a disparu), `marquerPassagesInterrompus()` au
`onApplicationBootstrap`. DTO partagé : `TripAutomationRunDto.status`. Écran
`/admin/trip-automation` : pastille « En cours / Interrompu / Échec » et résumé en mots à la
place de « 0 analysés ».

**Rouge d'abord** : `ligne-au-depart.spec.ts` (10 tests) contre l'ancien service → suite en
échec de compilation (`onApplicationBootstrap` inexistant, DTO sans `status`) ;
`trip-automation-etat.spec.ts` contre l'ancien composant → `etatPassage` inexistant.
L'ancien `trip-automation.service.spec.ts` attendait « un seul `create` avec les chiffres » :
aligné sur le nouveau contrat (un `create` au départ, la même ligne complétée par `update`).

✅ **Contre-vérifié en production, sur un VRAI passage tué** (08/09, heures UTC) :

| Heure | Fait |
|---|---|
| 05:42:51 | Conteneurs recréés (`dae97b03` + docs `3e46c222`), migration appliquée à 05:42:53, colonne `status` défaut `'done'`, artefacts lus (`ouvrirLigne`, `marquerPassagesInterrompus`, `ta-run-etat`). Le déploiement a été placé AVANT le passage de 05:45, exprès. |
| 05:45:00 | Le passage planifié écrit sa ligne `160aee4d…` : `running`, `scheduled` — lue en base à 05:45:06, **pendant** le passage. Avant ce lot, rien n'existait à cet instant. |
| 05:45:06 | `docker restart tracky-api` : exactement ce qu'un déploiement fait au passage en cours. |
| 05:45:22 | L'API redémarre et marque la ligne `interrupted` (fin nulle) ; centre d'alerte : **CRITICAL** `TRIP_AUTOMATION` « Passage d'automatisation interrompu : commencé le 08/09/2026 07:45 (planifié), jamais terminé… » ; journal d'activité `trip_automation_passage_interrompu` ; journal API « 1 passage(s) … marqué(s) au démarrage ». |
| 05:50:00 | La vigie des critiques (§ 9.1) envoie l'e-mail : `email_logs` → `critical_error_alert`, `contact@vizyoagency.com`, sujet « 1 erreur critique — TRIP_AUTOMATION », **DELIVERED**. |
| 05:52 | Écran `/admin/trip-automation` (session du propriétaire, service worker purgé) : « 08/09 07:45 · Auto · **INTERROMPU** · commencé, jamais terminé — l'API a redémarré pendant le passage ; la suite au passage suivant », détail « durée inconnue ». |
| 06:45 | Le passage suivant doit partir normalement : 60 min depuis le départ interrompu, la garde laisse passer. |

Deux retouches vues à l'écran, faites dans la foulée : « redémarré 0 min plus tard » devient
« moins d'une minute » (`3d6834b8`), et le détail d'un passage interrompu ne dit plus « Rien
de nouveau à traiter » mais « Le passage n'est pas allé jusqu'au bout ».

Coût de ce test : le passage de 05:45 n'a pas fait son travail, repris à 06:45 — le même
retard qu'un déploiement mal placé, mais cette fois signalé partout où il doit l'être.

### 9.5 Le rouge du tracé : une case, pas une teinte

- Préférence `map.traceParVitesse` (défaut `true`, retenue par utilisateur, normalisée comme
  les autres). Case **« Tracé coloré par la vitesse »** dans la légende du rejeu de trajet,
  **« Tracés colorés par la vitesse »** dans le rejeu de période, **« Colorée par la
  vitesse »** dans Calques ; décochée, le trait reprend le vert du tracé et la légende de
  vitesse se replie. Le rejeu de période garde les relevés reçus par trajet : recolorer ne
  redemande rien à l'API.
- Titre **« Pastilles »** devant la légende d'analyse du rejeu (arrêt / excès / pointe), pour
  que les deux légendes ne se lisent plus l'une pour l'autre.
- La page publique de trajet (sans compte, donc sans préférence) reste colorée : c'est le
  détail que le destinataire du lien vient chercher.
- **Rouge d'abord** : `trace-par-vitesse-defaut.spec.ts` contre l'ancien service de
  préférences → erreur de compilation (`traceParVitesse` inconnu).
- ✅ **Contre-vérifié en production** (03:05) : rejeu de trajet (0,6 km, mh cars) — la légende
  porte la case « Tracé coloré par la vitesse » et le titre « Pastilles » devant « Arrêt » ;
  décochée → préférence `false`, légende de vitesse repliée, trait vert ; recochée → tout
  revient. Rejeu de période (FM-772-JH, 65 trajets, 1 643 km) — case « Tracés colorés par la
  vitesse » : décochée, les 65 tracés repassent au vert d'un coup (relevés gardés en mémoire,
  aucune requête) ; recochée, les tronçons orange et rouges reviennent. Préférence remise à
  `true`, filtre véhicules remis sur « Tous ».
- ⚠️ Vu pendant cette recette, PAS un défaut du produit : le rejeu de période affiche « Carte
  indisponible (délai 3 s dépassé) » dans le volet navigateur masqué, alors que la carte est
  rendue derrière. C'est le banc (aucun rAF tant que le volet ne capture pas, cf. mémoire
  « volet masqué = page gelée »), le même faux positif que pour la carte blanche.
