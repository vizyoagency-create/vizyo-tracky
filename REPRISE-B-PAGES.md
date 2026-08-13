# Reprise — lot B-pages

> Écrit le 2026-08-11, à la fin de la séance qui a livré les maquettes, **B0′**, **B-kit** et
> les 23 premières lignes de **B-pages**.
> Branche `feat/refonte-tracky-v2`, **40 commits**, poussée sur `origin`, rien en attente.
> Feuille de route unique : `REFONTE-TRACKY-V2.md` — **496 / 604**.

---

## Le prompt à coller en première demande

> Reprends le lot **B-pages** de la refonte Tracky, sur la branche `feat/refonte-tracky-v2`.
> Lis d'abord `REPRISE-B-PAGES.md` à la racine, puis `REFONTE-TRACKY-V2.md` § « Bloc B ».
>
> **Trois règles non négociables :**
>
> 1. **Une maquette est une référence de conception, pas du code.** Les 28 planches sont dans
>    `design/maquettes/`. On traduit la décision en classes Tailwind existantes et en
>    composants du kit — jamais un style en ligne recopié.
> 2. **On reprend la décision de la planche, pas sa valeur, dès qu'elle tombe sous 4,5:1 sur
>    du texte.** Les planches sont tenues en thème sombre et plus lâches en clair ; trois
>    écarts sont déjà mesurés et tranchés dans `design/TOKENS.md`.
> 3. **Vérifie chaque page DANS LE NAVIGATEUR, à 375 px.** La sonde de recette est décrite
>    plus bas : elle a trouvé un bouton de navigation à 18 px de large, un menu stylé pour le
>    mobile seulement, et une carte de chaleur illisible au doigt. Aucun des trois ne se voit
>    en relisant le code.
>
> Ne modifie aucun DTO ni contrat d'API existant sans me demander.

---

## Où en est le travail

| Lot | État | |
|---|:-:|---:|
| Étape 0 · A1 · A2 · A5 · A3 · A4 | 🟢 livrés | — |
| **B0′** — reliquat du socle | 🟢 livré | 27/28 |
| **B-kit** — kit partagé | 🟢 livré | 26/28 |
| **B-pages** | 🟡 **en cours** | **45/57** |
| **B-mails** | ⬜ à faire | 0/12 |
| **PROD** | ⬜ à faire | 0/28 |

### Ce qui est fait dans B-pages

- `/vehicles/:id` — **10 onglets en 4 familles** (Suivi · Analyse · Sécurité · Exploitation).
  Le classement est une fonction pure, `features/vehicles/onglets-familles.ts`, et **9 tests**
  vérifient que l'union des familles redonne la liste d'entrée, pour tous les profils.
- **Mode simplifié** — le menu garde tout (il promettait « toutes les pages restent
  accessibles » et n'en montrait que 5 sur 13). Paramètres détaché, en violet, sous-titré
  « Revenir en interface complète ».
- **Carte de chaleur de `/reports`** — drill-down par jour. Ses 168 cellules ne se lisaient
  qu'au survol, inexistant au doigt.
- **Passe de cibles tactiles sur 15 pages**, mesurée avant/après à 375 px.
- **`/fleet-admin/activity`** — le résultat avant l'événement. `lastError` était **déjà en base**
  et affiché nulle part ; les échecs passent en tête (« À vérifier · N ») ; la présence devient
  un panneau permanent au-delà de 1024 px ; et un 500 ne s'affiche plus comme une liste vide.
  Cibles 4 → 0, contraste 47/47 dans les deux thèmes.

### ⚠️ Deux commentaires de `styles.css` qui promettaient plus que leur code

Corrigés cette séance, mais à connaître — **ils font sauter la vérification** :

1. La règle « GLOBALE … rattrape aussi celles à venir » (`styles.css`, cibles tactiles) est en
   réalité une **liste de six noms de classes**. Elle ne peut rattraper aucune barre nouvelle :
   `/fleet-admin/activity` écrivait `.fa-tabs button` et sortait à **37 px**. Toute nouvelle
   barre d'onglets doit porter `.tab-btn` pour entrer dans la garantie.
2. `/* Touch targets : garantir minimum 44px */` déclarait `min-height: 36px`. La valeur est
   laissée à 36 (monter `a` casserait les liens en ligne — exception déjà assumée) et c'est le
   **texte** qui a été corrigé. Ce plancher est un filet, jamais la preuve.

### Ce qui reste — 33 lignes

> ### 🔓 Ouvrir une SURFACE BLOQUANTE pour la vérifier
>
> Ces écrans ne s'affichent que sur anomalie — impossible à provoquer par l'interface. En
> build de dev, **`window.ng` donne accès aux services** :
>
> ```js
> const c = ng.getComponent(document.querySelector('app-dashboard-layout'));
> c.security.maskedEmail.set('a•••@duchamp.fr');
> c.security.mustVerify.set(true);      // → la porte de vérification s'affiche
> ```
>
> `app-dashboard-layout` expose `security` (42 champs au total). C'est la seule façon
> pratique d'atteindre les portes d'accès : elles sont décidées au boot, et un rechargement
> efface toute fixture XHR posée après coup.

> ### ⚠️ Reste sur le panneau surveillance : le WEEK-END EN SURVEILLANCE PERMANENTE
>
> Le dénouement et le conseil sont livrés ; **la moitié « week-end » de la ligne B1 ne l'est
> pas**. La planche est explicite : « Samedi et dimanche en violet : la surveillance y est
> **permanente**, pas seulement nocturne. Un week-end n'a pas d'heures ouvrées. » Cela touche
> `scheduleDays` / `scheduleStartTime` / `scheduleEndTime` et **la logique d'armement côté
> serveur**, pas seulement l'affichage — d'où l'arrêt : c'est une décision de comportement,
> pas de mise en page.

> ### 🔎 Chercher les variables CSS QUI N'EXISTENT PAS
>
> Trouvé le 2026-08-11 sur le panneau surveillance : **17 occurrences de `var(--color-fg-*)`,
> `var(--color-bg-*)`, `var(--color-border-*)`** — des noms qui ne sont définis **nulle part**
> dans `styles.css`. Le repli hexadécimal gagnait donc **toujours** : ces couleurs ne suivaient
> aucun thème, et les badges de statut tombaient à **1,47:1 en clair**.
>
> `verif:couleurs-kit` ne les voit pas (il ne couvre que `shared/ui` et `shared/components`).
>
> ✅ **Balayé et fermé le 2026-08-11.** Un audit sur tout `apps/web/src` a sorti **9 noms
> fantômes, 29 occurrences, dont 18 sans le moindre repli** — corrigés. Et le nouveau contrôle
> **`pnpm verif:variables`** couvre désormais tout `apps/web/src` et refuse les quatre formes :
>
> | Forme écrite | Ce que fait le navigateur |
> |---|---|
> | `var(--surface)` | la déclaration entière est **jetée** — un `border: 1px solid var(--border)` retombe sur `border-style: none`, la bordure **disparaît** |
> | `var(--x, #94a3b8)` | l'hexadécimal gagne **toujours** — la couleur ne suit plus aucun thème |
> | `var(--surface, var(--bg-secondary))` | s'affiche juste, mais le nom de tête est mort : le prochain copier-coller le propagera **sans** son repli |
> | `var(--color-fg-tertiary)` | déclaré dans `@theme inline`, donc **non émis dans `:root`** — cf. `design/TOKENS.md` § « Les noms de la couche 2 » |
>
> La quatrième est la plus retorse : `var(--color-border-subtle)` **résout** aujourd'hui et
> `var(--color-fg-tertiary)` **non**, alors que les deux sont dans le même bloc. Tailwind
> n'émet le nom que tant qu'une classe utilitaire correspondante subsiste dans un gabarit.
>
> Distinguer les faux positifs : `--pill`, `--u`, `--driver-color`, `--chart-height` **ne sont
> pas** des fantômes — elles sont posées au rendu par `[style.--x]` ou `setProperty()`.
>
> Même famille que les `--tk-*` déjà relevés sur `/integrations`.

**Bloc F — surfaces bloquantes.** ✅ **CLOS — 12/12** (séance du 2026-08-11).

| Surface | Ce qui a été trouvé en mesurant |
|---|---|
| Assistant de démarrage | l'action principale **repliée sur 2 lignes** à 375 px (133 × 85) |
| QR véhicule | la carte **débordait de 38 px de chaque côté** ; format 60 × 90 mm réellement imprimé |
| Rejeu de trajet | une branche de code **inatteignable** ; « 1× » ne multipliait rien |
| Rejeu de période | la nuit occupait **58 % et 71 %** d'une barre ; curseur invisible à 0 % |
| Créer un véhicule | `bg-tracky text-white` (règle B0-SOCLE) ; compteur 15/15 ; « 2 champs requis sur 11 » calculé |
| Éditeur d'horaires | une phrase partagée **disait l'inverse du système** — cf. ci-dessous |

> ### ⚠️ `MIXTE_SANS_CADRE` : la phrase disait l'inverse du code
>
> `ETATS_VIE_PRIVEE.MIXTE_SANS_CADRE.sens` annonçait « le véhicule serait **privé en
> permanence** — donc invisible pour vous ». C'est faux : `resolveEffectivePrivacy`
> (précédence n° 4 — « aucun cadre → TRACÉ, on ne coupe jamais le suivi sans cadre
> défini ») renvoie `isPrivate: false`. Le véhicule est **suivi 24/7, domicile compris**,
> et `/privacy-coverage` — l'écran qui sert de preuve — annonçait le contraire.
> Corrigé aux deux endroits (la source est partagée), plus le commentaire de l'API.
>
> La distinction qui manquait : un cadre **actif mais vide** (`enabled=true`, aucun jour)
> rend bien le véhicule privé en permanence, lui.

> ### ✅ PASTILLES VÉHICULE EN SVG — livré le 2026-08-12, ligne B1 `/map` CLOSE
>
> La pastille était une pile de quatre `div` aux formes dessinées en CSS : anneau en
> `border`, flèche en triangle de `border-*`, cœur en `box-shadow`. C'est **un SVG**
> (`buildVehicleMarkerEl`) : anneau, flèche de cap, cœur, contact et icône y sont des
> formes. Net à toute densité, et décrit au même endroit.
>
> Trois décisions de la planche, reprises — pas ses valeurs :
>
> 1. **La couleur est portée UNE FOIS** par le conteneur ; toutes les formes la
>    reprennent en `currentColor`. Avant, elle était recopiée dans un style en ligne du
>    cœur *et* dans le triangle CSS — un oubli laissait la pastille d'une couleur et sa
>    flèche d'une autre.
> 2. **L'icône passe en encre sombre** sur le fond vif.
> 3. **Pas de flèche de cap sur une position figée** : un véhicule hors ligne n'a pas de
>    direction à montrer.
>
> Et l'étiquette porte **`plaque · vitesse`** (`FT-108-XR · 48`), avec
> **« hors ligne »** au lieu d'un chiffre dès que la télémétrie est périmée — la planche
> l'écrit elle-même (`AZ-330-PB · hors ligne`).
>
> ⚠️ **L'ENCRE NE PEUT PAS ÊTRE FIXE — ce que la planche ne pouvait pas voir.** Elle ne
> montre que des véhicules **en mouvement**, donc des fonds vifs. Mesuré sur toute la
> palette :
>
> | Bande | Blanc (avant) | Encre sombre |
> |---|---:|---:|
> | 0 km/h `#5C746C` | 5,04 | **3,85** ← régression |
> | 1-50 `#10E0A0` | 1,72 | **10,43** |
> | 51-90 `#F59E0B` | 2,15 | **8,53** |
> | 91+ `#EF4444` | 3,76 | **5,12** |
> | hors ligne `#9ca3af` | 2,54 | **7,26** |
>
> Une teinte sombre fixe **régresse** sur la couleur « à l'arrêt », déjà sombre. D'où
> `markerInk()` : le choix se fait **par luminance du fond** — teinte sombre sur fond
> clair, blanc sur fond sombre. **6 tests** vérifient que les six couleurs de la palette
> passent 4,5:1. C'est la leçon : *une décision de planche se vérifie sur toute la
> donnée, pas sur les cas qu'elle illustre.*
>
> ### ⚠️ DEUX FOIS, LE MÊME MARQUEUR DISAIT DEUX CHOSES
>
> Les deux trouvés **en mesurant**, aucun visible en relisant le code :
>
> 1. Une pastille **ROUGE** portait « TE002ST · **18** ». La teinte lisait
>    `colorSpeedKmh` (vitesse robuste dérivée du déplacement) et le chiffre `speedKmh`
>    (brute du boîtier).
> 2. Une pastille **VERTE** portait « TE001ST · **0** ». À 0,4 km/h, `speedColor`
>    répond « en mouvement » (> 0) pendant que l'étiquette arrondit à 0.
>
> Corrigés par `vitesseAffichee()` : **un seul nombre, arrondi AVANT de choisir la
> couleur**, pour la teinte comme pour le chiffre. Deux tests le verrouillent.
>
> ### ⚠️ Trois règles CSS devenues MORTES par le renommage
>
> `.tracky-marker--mini .tracky-marker__heading-ring`, et
> `.tracky-marker--hydrated/--offline .tracky-marker__core` visaient des classes qui
> n'existaient plus. Elles ne signalent rien — elles cessent simplement de s'appliquer.
> **Après tout renommage de classe dans une feuille GLOBALE, balayer les sélecteurs
> composés** : `grep` sur l'ancien nom, pas seulement sur le fichier modifié.
>
> ### ⚠️ `verif:variables` a refusé mon `var(--tracky-ink, #000)` — à raison
>
> Deux fois de suite : d'abord le **repli en dur** (l'hexadécimal gagne toujours), puis
> **« sans repli, la déclaration est jetée »**. La bonne forme était déjà sous mes yeux :
> `--tracky-color` passe parce qu'elle est **déclarée par défaut sur `.tracky-marker`**.
> Une variable posée au rendu doit avoir son **défaut déclaré dans la feuille**, pas un
> repli en ligne.
>
> **Portée** : `buildVehicleMarkerEl` sert **cinq surfaces** — `/map`, `mini-map` du kit,
> rejeu de trajet, rejeu de période. `/map` est vérifiée au navigateur ; les quatre
> autres le sont par le build et les **364 tests**, pas à l'œil. À regarder si vous
> passez dessus.
>
> **Reste ouvert** : la planche masque l'étiquette de plaque sur téléphone
> (`.mfrm .vk-plate { display: none }`). Non appliqué : `showPlates` est une préférence
> **persistée** de l'utilisateur, et en changer le défaut se ferait contre son choix
> stocké. À trancher.

**Bloc C — supervision (3 livrées sur 5).** `/dashboard`, **`/map`** et **`/vehicles`**
faits ; restent `/places` et `/alerts`. *(`/vehicles/:id` livré plus tôt.)*

> ### ✅ `/vehicles` — livré le 2026-08-12
>
> ⚠️ **LE `catch` QUI POSE UN TABLEAU VIDE — UNE CINQUIÈME FOIS.**
>
> ```ts
> } catch (err) {
>   swallow('vehicles-list:loadVehicles', err);
>   this.vehicles.set([]);          // ← ici
> }
> ```
>
> Sur une panne d'API, `/vehicles` annonçait « **Aucun véhicule dans votre flotte** »
> **avec le bouton « Ajouter votre premier véhicule »** — à un gestionnaire dont la
> flotte existe. Cinquième écran, sans aucun rapport avec les quatre autres
> (`activity`, `privacy-coverage`, `integrations`, `driver`). Ce n'est décidément pas
> une négligence locale.
>
> Remplacé par `<app-zone>` : `erreur` nomme la panne et porte un recours ; si une
> liste précédente existait, l'état devient `partiel` (le contenu reste, un bandeau dit
> ce qui manque). Le **rond de chargement devient un squelette** (règle 2 du kit), et
> « aucun résultat de filtre » cesse d'être confondu avec « flotte vide ».
>
> **Filtres en feuille** (ligne B1 « sur mobile : cartes + filtres en feuille »). La
> barre d'outils mettait à 375 px un champ de recherche de **294 × 20** et un `select`
> de **122 × 20** — moins de la moitié du plancher tactile. Sous 768 px elle cède la
> place à la feuille de la planche : puces **Statut** (Tous · En roulage · À l'arrêt ·
> Hors ligne · Pas de boîtier) avec compteurs, puces **Groupe**, recherche, et le pied
> qui annonce le résultat **avant** de fermer (« Voir 2 véhicules »).
>
> ⚠️ **« On ne sait pas encore » n'est pas « à l'arrêt ».** Premier jet : les puces
> comptaient `liveStatus(v.id)?.kind === 'moving'`. Or `liveStatus` vaut **null** tant
> qu'aucune position live n'est arrivée — au premier rendu, les deux véhicules étaient
> comptés « à l'arrêt » alors que leurs cartes affichaient une vitesse. Repli sur le
> drapeau `moving` de la charge REST, la même source que `seedMovingState`. Le relevé
> est passé de « À l'arrêt 2 » à « **En roulage 2** ». Même famille que l'ACC `unknown`
> des marqueurs : **un état inconnu ne se range pas dans un état connu.**
>
> Les puces partent de `connectivity()` et `liveStatus()` — **les mêmes sources que les
> lignes**. Une puce qui compterait autrement afficherait « En roulage 6 » au-dessus
> d'une liste qui n'en montre que 4.
>
> **Mesure à 375 px, les deux thèmes** : 18 éléments, 4 ratios distincts, **0 échec de
> contraste**, **0 cible sous 44 px**, **0 débordement**.
>
> **Non fait, à reprendre** : la **liste groupée par groupe avec en-têtes**
> (« Groupe Sud · 5 véhicules ») que la planche montre sur les trois plateformes — le
> mode `grouped` existe mais reste une option du sélecteur de vue, pas le rendu par
> défaut. Et les états particuliers de la planche : « Dormant · 89 j », « Pose à
> vérifier », « Pas de boîtier → Assigner un boîtier ».

> ### ⚠️ `/map` — LA FEUILLE DE POSITION ÉTAIT UNE SURFACE CLAIRE EN DUR
>
> Séance du 2026-08-12. `.bn-vcard` — la « feuille de position » de la ligne B1 —
> était écrite **entièrement pour le thème clair** : `background: rgba(255,255,255,.92)`,
> plaque en `#111`, libellés en `#888` / `#555` / `#ccc`, et **onze couleurs en dur en
> style inline** dans le gabarit.
>
> En clair, elle est juste — c'est le thème dans lequel l'app est développée. En
> **sombre**, le fond restait blanc alors que le texte hérité passait à `--fg-primary`
> (`#EAEFED`) : **du blanc cassé sur du blanc**. Mesuré à 375 px :
>
> | Élément | Sombre, avant | Après |
> |---|---:|---:|
> | « Contact ON » | **1,36:1** | 6,97 |
> | « Jour » (groupe) | **1,46:1** | passe |
> | vitesse `2 km/h` | **2,40:1** | 9,00 |
> | « Couper » | 3,69:1 | 4,56 |
> | pastille active du menu (`--tracky` en texte) | 1,56:1 **en clair** | 4,65 |
>
> **Bilan : 16 échecs → 12 en clair, 16 → 11 en sombre.** Les 11 restants sont hors
> de ce que je pouvais trancher (cf. ci-dessous).
>
> La correction reprend la **décision** de la planche (feuille translucide floutée
> au-dessus de la carte, vitesse lue à sa couleur de régime) et non ses **valeurs** :
> `--surface-quaternary` pour la surface posée sur la carte, et la famille
> `--texte-*` pour tout le petit texte. Le tableau des couples a été mesuré dans les
> **deux** thèmes avant d'écrire une ligne — `--tracky` donne 6,97 en sombre mais
> **2,83 en clair**, et `--tracky-dark` l'inverse (2,19 / 4,53) : aucun des deux ne
> convient, seul `--texte-succes` tient les deux (6,97 / 4,65).
>
> Deux pièges du journal se sont vérifiés à la lettre :
> 1. **La fiche mesurée à `translateY(181,7px)` pour 182 px de haut**, stable sur 4 s :
>    elle semblait s'ouvrir hors de l'écran. C'était le panneau qui ne composite
>    aucune frame, donc une `transition: all` qui n'avance jamais. Après injection de
>    `*{transition:none!important}` : 630→812, **entièrement visible**. Faux défaut évité.
> 2. **`--texte-alerte` rapporté « absent » en clair** : il y vaut un `color-mix()`,
>    que `getPropertyValue` rend **non résolu**. Il faut faire résoudre la valeur par
>    le navigateur (poser l'expression sur un élément et relire `getComputedStyle`),
>    jamais lire le jeton brut.
>
> **Cible corrigée** : la croix de la feuille mesurait **30 × 36**. La règle de 44 px
> de `map.component.ts` est — comme celle de `styles.css` — une **liste de noms de
> classes** ; `.bn-vcard-close` n'y était pas. Or sur iOS c'est le seul moyen de
> refermer la fiche. Désormais **44 × 44**, 0 cible sous le seuil, 0 débordement.
>
> ### 🟠 `/map` — ce qui reste, et pourquoi je n'y ai pas touché
>
> | Ce qui échoue | Mesure | Pourquoi c'est resté |
> |---|---:|---|
> | 10 libellés de légende | 3,16 clair / 3,75 sombre | C'est **O5** — `--text-tertiary`, jeton 3:1 employé comme couleur de texte. Point en attente d'arbitrage |
> | Glyphes « P » et « ! » | 2,77 et 3,76 | 7 px de blanc dans une pastille de 10 px. Ce sont des **clés de légende** qui doivent rester synchronisées avec `speedColor()` de `maplibre-markers.ts` : les changer seules ferait mentir la légende |
> | `group-badge-name` « Jour » | 4,38 en clair | Composant du **kit partagé** (`shared/ui/group-badge/`), hors `/map`. À reprendre avec le kit, pas ici |
>
> **Restent aussi les deux autres tiers de la ligne B1 `/map`** — non faits, non
> bricolés : les **pastilles de véhicule à reprendre en SVG** (leurs couleurs vivent
> dans `speedColor()`, et la légende en dépend), et la **feuille « Calques &
> lisibilité »** de la planche : le tri-état « Lieux sur la carte : Masqués /
> Discrets / Tous » avec sa phrase (« Discrets réduit les lieux et regroupe les plus
> proches : les véhicules restent toujours au premier plan ») et la légende « Cycle
> de vie d'un lieu ». Aujourd'hui l'écran offre à la place **quatre cases éparses**.
>
> ### ✅ La FEUILLE FLOTTE — livrée le 2026-08-12
>
> C'était le plus gros écart à la planche : **sur mobile, `/map` n'avait aucune liste
> de véhicules**. Pire, la pastille « N actif(s) » — le seul élément qui NOMME la
> flotte — ouvrait une feuille de **réglages** (actions, style, caméra, calques,
> légende). L'élément qui nomme la flotte n'ouvrait pas la flotte.
>
> Livré : onglets « Véhicules N / Lieux N », les quatre puces de la planche
> (Tous · En route · Arrêt · Hors ligne) avec leurs compteurs, et la liste. Tap sur
> une ligne → la feuille se ferme, la carte centre, la fiche s'ouvre (vérifié :
> `TE001ST` → fiche `TE001ST`). Le kit fait le travail : `app-bottom-sheet` en
> variante **`sansVoile`** (la carte doit rester lisible SOUS la feuille) et
> `app-zone` pour les états.
>
> **Mesure à 375 px : 18 éléments, 6 ratios distincts, 0 échec de contraste dans les
> deux thèmes, 0 cible sous 44 px, 0 débordement.**
>
> ⚠️ **La règle que ce code existe pour tenir** — extraite en fonction pure
> `features/map/flotte-lignes.ts`, **11 tests** :
>
> > **Une vitesse ne s'affiche que si le boîtier est `ONLINE`.**
>
> C'est l'incident FS-253 transposé à une liste : hors direct, la vitesse est un
> SOUVENIR. Un véhicule muet depuis cinq jours ne doit pas afficher « 88 km/h » —
> on nomme l'état et depuis quand. L'état vient de `getVehicleConnectivityState`,
> **la même dérivation que les marqueurs** : sans cela la liste annoncerait
> « 72 km/h » là où la carte affiche une pastille grise. `PARKED` est un **arrêt**,
> pas une panne.
>
> Et le filtre à zéro ne ment pas : « Aucun véhicule à l'arrêt » **+ la sortie**
> (« Voir les 2 véhicules »), au lieu d'une flotte annoncée vide.
>
> **Ce que la planche demande et que je n'ai PAS mis** : le libellé de lieu
> (« Renault Clio · **A61 sortie 17** »). Aucun DTO ne le porte — ni `VehicleSnapshotDto`
> ni les positions. Non bricolé, conformément à la consigne. La ligne affiche
> `marque · modèle`, et « Modèle non renseigné » quand les deux manquent.
>
> **Observation kit (non corrigée)** : la poignée `.bs-handle-wrap` d'`app-bottom-sheet`
> mesure **375 × 36** — sous 44 px en hauteur, mais pleine largeur. Elle est partagée
> par toutes les feuilles de l'app : à trancher au niveau du kit, pas ici.
>
> ### ✅ CALQUES & LISIBILITÉ — livré le 2026-08-12
>
> **Le tri-état « Lieux sur la carte : Masqués · Discrets · Tous »** remplace trois
> cases éparses (*Stations-service*, *Parkings souterrains / zones mortes*, *Lieux de
> la flotte*) qui posaient trois fois la même question sans jamais la poser en entier :
> « combien de lieux je veux voir ? ». Il ne double pas ces calques, **il les pilote** —
> ils restent la source de vérité du rendu, du chargement et du comptage de filtres
> actifs, sinon un état sur deux finirait par mentir à l'autre.
>
> Vérifié au navigateur, en lisant l'état réel du composant :
>
> | Mode | Trois calques | Couche MapLibre | Rayon des stations |
> |---|---|---|---|
> | Masqués | `false` | `visibility: none` | — |
> | Discrets | `true` | visible | `1→6 · 5→9 · 15→13` |
> | Tous | `true` | visible | `1→9 · 5→15 · 15→22` |
>
> Et la géométrie des repères DOM, lue sur la chaîne de style que le constructeur écrit :
> **26 px / z 880** en « Tous », **17 px / z 700** en « Discrets ».
>
> ⚠️ **RENVERSEMENT ASSUMÉ : les véhicules passent devant les lieux.** Les repères de
> lieux portaient `z-index: 880` et les zones mortes `900`, avec un commentaire qui
> l'assumait (« pour passer devant les véhicules ») — pendant que le wrapper du marqueur
> véhicule n'avait **aucun** z-index. La planche tranche l'inverse : « les véhicules
> restent toujours au premier plan ». Sur une carte de supervision, ce qu'on surveille
> prime sur le décor. Les véhicules sont désormais à **950**, et les deux commentaires
> qui affirmaient le contraire ont été corrigés — un commentaire faux coûte plus cher
> qu'un code faux.
>
> ⚠️ **La phrase de la planche a été RÉÉCRITE pour dire ce que le code fait.** La planche
> écrit : « *Discrets réduit les lieux et **regroupe les plus proches*** ». Le
> regroupement n'est **pas** livré : les lieux de la flotte et les zones mortes sont des
> marqueurs DOM, qui ne se regroupent pas nativement — il faudrait les convertir en
> couches GeoJSON, avec leurs gestionnaires de clic. La phrase affichée est donc :
> « **réduit les lieux et les fait passer derrière** : les véhicules restent toujours au
> premier plan » — exactement ce qui est implémenté et mesuré. C'est la leçon de
> `MIXTE_SANS_CADRE` : une phrase qui promet plus que son code est un défaut, pas un
> raccourci.
>
> **Le jumeau est mort.** Le panneau desktop et la feuille mobile portaient **deux copies
> identiques** de la liste des calques : corriger l'une laissait l'autre mentir. Elles
> partagent maintenant un `ng-template` unique, rendu par `ngTemplateOutlet` aux deux
> endroits — vérifié aux deux largeurs (375 et 1280), même contenu, 0 débordement.
>
> Ajouté aussi : la légende **« Cycle de vie d'un lieu »** (Détecté → Seuil atteint →
> Validé), et les noms de la planche — « Traces » devient **« Trajets du jour »**,
> « Plaques » devient **« Étiquettes plaques »** (ni l'un ni l'autre ne disait de quoi
> ni de quand). Les clés de légende hexadécimales du gabarit sont devenues des classes.
>
> **Mesure à 375 px, les deux thèmes** : 55 éléments, 7 ratios distincts, **0 cible sous
> 44 px** (le tri-état fait 110 × 44), **0 débordement**. Mes blocs : phrase 6,28 / 7,28 ·
> tri-état actif 5,03 / 7,94 · inactif 5,93 / 6,76 · cycle 6,28 / 7,28. Les 11 échecs
> restants du panneau sont **tous** préexistants : les libellés O5 (3,16 / 3,75) et les
> glyphes de légende.

> ### ⚠️ Le `catchError` en FIN DE TUYAU tue le sondage
>
> Trouvé sur `/dashboard` en écrivant le message honnête « nouvelle tentative dans moins
> d'une minute » — puis en vérifiant que c'était vrai. Ça ne l'était pas :
>
> ```ts
> switchMap(() => this.vehiclesApi.stats(...)),
> catchError(() => of(null)),          // ← remplace le flux ENTIER
> ```
>
> `of(null)` se termine, donc le flux se termine : **au premier échec réseau, le sondage
> de 30 s s'arrêtait définitivement**. Le `catchError` doit être DANS le `switchMap`.
> C'est le pendant technique du « catch qui ment » déjà relevé cinq fois.

> ⚠️ **NE JAMAIS réécrire un fichier source via PowerShell `Set-Content`.** Le 2026-08-11,
> un aller-retour `Get-Content -Raw` / `Set-Content -Encoding utf8` a **corrompu l'encodage**
> de `two-factor-proposal.component.ts` : 47 accents transformés en mojibake, puis une
> tentative de réparation Latin-1 → UTF-8 y a laissé un caractère de remplacement en tête
> (`ef bf bd`) — Angular a répondu « File appears to be binary ». Le fichier a dû être
> restauré par `git checkout --` et les modifications refaites.
> **Utiliser l'outil d'édition, ou Node (`fs.writeFileSync(p, t, 'utf8')`).** PowerShell
> traite en plus l'accent grave comme caractère d'échappement : un test de mutation écrit
> avec lui n'insère pas ce qu'on croit.

> ⚠️ **La coupure moteur n'est faite qu'à moitié.** Seule la variante critique est branchée
> (plaque à retaper sur la coupure). Le reste de sa ligne B1 est intact : **compte à rebours
> pendant les 90 s**, raison du refus hors du `title`, 3 sorties sur l'état non confirmé,
> avertissement boîtier muet en 3 étapes numérotées. Coupure moteur (compte à rebours
pendant les 90 s, la raison du refus sort du `title`), consentement RGPD, vérification
d'appareil (6 cases séparées, collage depuis l'e-mail), QR véhicule, rejeu de trajet et de
période, création/édition de véhicule (« le boîtier devient facultatif »), éditeur d'horaires
(« bloc imbriqué derrière un filet vert »).

**Bloc A.** ✅ **Terminé** — `/book/:token`, `/reserve/:token` et `/driver/unlock` sont livrées.

**Bloc B.** ✅ **Terminé** — `/driver` est livrée.

> ### ⚠️ Aucun compte DRIVER en base de développement
>
> `SELECT role, count(*) FROM users` : 4 FLEET_ADMIN, 3 DEPOT, 3 SUPER_ADMIN, 2 FLEET_MANAGER,
> 1 VIEWER — **zéro DRIVER**. La route `/driver` n'exige que `authGuard` (c'est
> `driverAwayFromDashboardGuard` qui y REDIRIGE les conducteurs), donc elle s'ouvre avec un
> compte fleet-admin et la liste reste bornée côté serveur. Suffisant pour mesurer la mise en
> page, les cibles et le contraste — **pas** pour vérifier le périmètre réel d'un conducteur.

> ### 🔑 Ouvrir les pages à jeton — ce qui marche vraiment
>
> Pas besoin de simuler : **l'API crée de vrais liens**, avec le jeton fleet-admin.
>
> ```
> POST /api/reservation-booking-links   {"label":"Demander un vehicule"}   → token
> POST /api/installation-bookings/links                                    → token
> ```
>
> `/driver/unlock` n'a besoin d'aucun jeton valide pour vérifier l'écran d'accueil
> (`?token=` quelconque) : l'appel ne part qu'au clic. Et pour `/book`, un **jeton bidon
> suffit** à obtenir l'écran « lien introuvable » — c'est justement le cul-de-sac à vérifier.

> ### 📏 La taille d'une cible se décide par le CONTEXTE
>
> Les 44 px sont un **plancher pour une commande ordinaire**, pas une cible pour le geste
> central d'un écran utilisé dehors, debout, ganté. Les planches le disaient déjà :
> **micro de `/reserve` : 112 px** · **déverrouillage de `/driver/unlock` : 128 px**.
> Les deux sont **mesurés** au navigateur, pas déclarés.

**Contenu propre de D et E.** ✅ **Terminé** — `/fleet-admin/activity`, `/admin/ai-usage`,
`/settings`, `/integrations` et `/privacy-coverage` sont livrées et mesurées.

> ### ⚠️ Le motif le plus répandu de cette base : le `catch` qui pose un tableau vide
>
> Trouvé **trois fois** dans la même séance, sur trois écrans sans rapport :
>
> | Écran | Ce qu'une panne affichait |
> |---|---|
> | `/fleet-admin/activity` | « Aucune action moteur sur cette flotte » |
> | `/privacy-coverage` | « 0 véhicule » — donc « rien à corriger » |
> | `/integrations` | un constat muet, sans aucun recours |
> | `/driver` | « Aucun véhicule ne vous est attribué » — soit « on ne vous a rien confié » |
>
> **Quatre écrans sans aucun rapport entre eux.** Ce n'est pas une négligence locale, c'est un
> réflexe d'écriture : `error: () => this.loading.set(false)` se tape plus vite que la
> distinction. Le pire des quatre est `/driver` — un conducteur debout devant son camion, à qui
> l'écran dit qu'il n'est affecté à rien, et qui n'a personne à qui demander.
>
> À chaque fois, **le mensonge est rassurant** et tombe sur l'écran qui sert précisément à
> vérifier que tout va bien. C'est le premier réflexe à avoir en reprenant une page : chercher
> le `catch` et regarder ce qu'il pose. `app-zone` existe pour ça — `erreur`, `vide` et
> `interdit` sont trois états, pas un.

> 🔑 **Pour ouvrir `/integrations`, il faut un FLEET-ADMIN.** Toutes ses routes exigent le rôle
> *et* la permission `integrations_manage` : un super-admin n'y voit que l'état d'erreur. Jeton
> utilisable : `authUserId` **`cmnusapj5000f07s7ipjkdcf4`** (`tracky1@gmail.com`). ⚠️ L'identifiant
> de seed `cdef31-admin` **ne marche pas** — `/api/auth/me` répond 500, ce n'est pas un vrai id
> Vizyo Auth. Prendre un `authUserId` en forme de cuid.

### 🟠 Ce qui bute sur un contrat d'API — trois fois, jamais touché

Trois lignes de planche demandent une donnée qu'**aucun DTO ne porte**. Aucune n'a été
bricolée, aucun contrat n'a bougé :

| Page | Ce que la planche demande | Ce qui manque |
|---|---|---|
| `/admin/ai-usage` | « 418 trajets analysés ce mois » sous chaque fonction | `AiUsageBreakdownRowDto` n'a que `calls`, `tokens`, `costEur` — **aucun compteur de résultat** |
| `/integrations` | Le volume par catégorie (« 3 412 trajets », « 186 pleins ») | Ni `PartnerLinkStatus` ni `PartnerScopeOption` ne le portent ; le reconstituer = un appel par catégorie |
| `/admin/ai-usage` | Le ratio consommation / forfait (« 45 % ») | Calculable, mais **expose la marge** — décision commerciale, pas technique |
| `/book/:token` | 3 sorties : « être prévenu », « appeler », « redemander un lien » | `PublicBookingLinkDto` n'a **ni téléphone de société ni endpoint d'abonnement**. Seule « redemander un lien » est livrée (mailto pré-rempli) |

Sur `/integrations`, ce qui EST affiché est ce qu'on sait avec certitude : **« Rien n'est
transmis »** quand la catégorie est éteinte. C'est la moitié qui compte.

### 🟠 Trois décisions en attente sur `/admin/ai-usage`

La page est livrée et vérifiée, mais **trois choses ont été volontairement laissées de côté** :

1. **Le ratio consommation / forfait.** La planche affiche « 45 % de votre forfait » et une
   barre — donc, en clair, **elle expose la marge** au client (18,74 € de calcul pour 42 € de
   forfait). J'ai livré le forfait ET la consommation, mais **pas le rapport entre les deux** :
   c'est une décision commerciale, pas une décision d'écran, et elle part en recette sur le
   VPS. Une fois affichée, elle ne se reprend pas.
2. **« Chaque euro rattaché à un résultat. »** La planche écrit « 418 trajets analysés ce
   mois » sous chaque fonction. `AiUsageBreakdownRowDto` porte `calls`, `tokens`, `costEur` —
   **aucun compteur de résultat**. C'est le seul point de la page qui demanderait un
   **changement de contrat d'API** ; non fait, conformément à la consigne.
3. **O5 — `--text-tertiary` sous 4,5:1 dans les deux thèmes** (cf. `design/TOKENS.md`).
   Corrigé sur cette page et sur `/fleet-admin/activity` ; la reprise globale touche 29 écrans.

> ⚠️ **`verif:contraste` ne verra jamais O5** : il vérifie les 46 couples **déclarés**, pas les
> usages réels d'un jeton dans les gabarits. Sur cette page, 24 textes échouaient sans qu'aucun
> contrôle ne bronche. **La mesure au navigateur reste le seul juge.**

**Bloc G — le shell, EN DERNIER.** Ordre non négociable de `B1-PAGES.md`.

---

## La sonde de recette — à reposer au début de chaque séance

Les critères de recette de `B1-PAGES.md` se **mesurent**, ils ne se jugent pas. Coller ceci
dans la console du navigateur (`javascript_tool`), puis appeler `__recette('nom de la page')`
sur chaque route :

```js
window.__recette = function (nom) {
  const res = { page: nom, largeur: innerWidth, coupes: [], tronques: [], ciblesPetites: [], debordement: null };
  const decoratif = (el) => {
    if (el.closest('[aria-hidden="true"]')) return true;
    if (el.classList.contains('sr-only') || el.querySelector(':scope > .sr-only')) return true;
    const cs = getComputedStyle(el);
    return cs.pointerEvents === 'none' || cs.position === 'fixed';
  };
  for (const el of document.querySelectorAll('*')) {
    if (decoratif(el)) continue;
    const cs = getComputedStyle(el);
    if ((cs.overflow === 'hidden' || cs.overflowY === 'hidden') && el.clientHeight > 40) {
      const srh = [...el.children].filter(c => c.classList.contains('sr-only')).reduce((n, c) => n + c.scrollHeight, 0);
      const perdu = el.scrollHeight - el.clientHeight - srh;
      if (perdu > 8) res.coupes.push({ sel: (el.className || el.tagName).toString().slice(0, 45), perdu });
    }
    if (cs.textOverflow === 'ellipsis' && el.scrollWidth - el.clientWidth > 2 && (el.innerText || '').trim()) {
      res.tronques.push({ txt: (el.innerText || '').trim().slice(0, 34), titre: el.getAttribute('title') || el.closest('[title]')?.getAttribute('title') || null });
    }
  }
  if (innerWidth <= 430) {
    for (const el of document.querySelectorAll('button, a[href], [role="button"]')) {
      const r = el.getBoundingClientRect();
      if (r.width && r.height && (r.height < 44 || r.width < 44)) {
        res.ciblesPetites.push((el.innerText || el.getAttribute('aria-label') || '?').trim().slice(0, 22) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
      }
    }
  }
  res.debordement = document.documentElement.scrollWidth > innerWidth + 2 ? document.documentElement.scrollWidth - innerWidth : null;
  return res;
};
```

### ⚠️ La sonde de CONTRASTE — cinq pièges, tous corrigés le 2026-08-11

Mesurer un contraste au navigateur est plus fragile qu'il n'y paraît. Cinq défauts m'ont
donné des verdicts faux **dans les deux sens** :

1. **`color-mix()` se calcule en `color(srgb 0.95 0.98 0.97)`** — des flottants **0-1**, pas
   du 0-255 comme `rgb()`. Les lire tels quels donne un quasi-noir : un texte mesuré à
   **17,81:1 était rapporté à 1,11**. Toute la palette du dépôt passe par `color-mix`.
2. **Le repli quand aucun ancêtre n'est opaque.** Retomber sur du blanc en dur est
   fortuitement juste en thème clair et **faux partout en sombre**.
3. **`body` a une transition de 300 ms sur son fond**, et le panneau **ne composite aucune
   frame**. La transition n'avance donc jamais : en sombre, on mesure du texte clair sur un
   fond resté clair, d'où des ratios à ~1,05 sur des pages correctes.
4. **L'alpha de `color(srgb … / 0.16)` doit être lu, et les fonds COMPOSÉS.** Sauter les
   ancêtres non opaques pour chercher plus haut ne suffit pas : une pastille au fond
   `color-mix(… var(--color-tracky-light) 16%, transparent)` était prise pour du vert
   **plein**. Faux échecs relevés sur `/settings` : `.rule-state.on` à « 1,74 » et deux
   paragraphes de `.note` à « 1,48 » — tous corrects une fois l'alpha composé. Il faut
   empiler les fonds jusqu'au premier opaque et les composer un à un vers le bas.
5. **Un élément créé en JS ne reçoit AUCUN style de composant Angular.** L'encapsulation de
   vue préfixe chaque règle d'un attribut `_ngcontent-ng-cXXXX` ; un `document.createElement`
   ne le porte pas. Symptôme reconnaissable : **toutes** les classes testées rendent le même
   ratio et la même taille de police. Vu ici sur les 10 états du panneau de surveillance,
   tous à « 18,85 ». Remède : lire l'attribut sur un élément existant du composant et le
   poser sur l'élément injecté.

**Le remède** : injecter `*{transition:none!important;animation:none!important}` avant toute
bascule de thème, lire le fond réel via `getComputedStyle(document.body)`, gérer
`color(srgb …)` **avec son alpha** dans le parseur, composer la pile de fonds, et recopier
l'attribut d'encapsulation sur tout élément injecté.

> **Le réflexe qui rattrape les cinq :** un relevé où plusieurs lignes portent la **même**
> valeur, ou une valeur ronde comme 1,00, mesure la sonde et non la page. Vérifier d'abord
> que la sonde avait de la matière (`elementsInspectes`) et que les valeurs **varient**.

### ⚠️ Après un rechargement à CHAUD, les styles de composant peuvent ne plus s'appliquer

Relevé le 2026-08-11 sur `/dashboard` : un bouton mesurait **36 px** alors que sa règle
`min-height: 44px` était bien présente dans la feuille, avec la bonne spécificité
(`.widget-relance[_ngcontent-ng-c1600520906]`). Le HMR avait remplacé la feuille avec un
NOUVEL identifiant d'encapsulation, mais le DOM rendu portait encore l'ancien : plus aucune
règle du composant ne s'appliquait. Après un rechargement complet : **92 × 44**.

**Ne jamais conclure sur une mesure de cible ou de style après une série de rechargements à
chaud.** Recharger la page d'abord.

### ⚠️ Deux autres relevés jetés le même jour

- **Le mauvais écran.** L'onglet avait dérivé vers « Centre d'alertes » ; la sonde a rapporté
  86 échecs qui n'étaient pas ceux de `/dashboard`. **Toujours relire `document.title` et
  `location.pathname` dans le relevé lui-même.**
- **Des éléments injectés en JS.** Créés pour éprouver un état d'échec, ils ne portaient pas
  l'attribut d'encapsulation : mesurés **sans aucun style de composant**. Un état ne se
  mesure que rendu par Angular — ici en coupant réellement les requêtes (`XMLHttpRequest`
  détourné), pas en fabriquant le DOM à la main.

### ⚠️ La sonde de CIBLES mesure parfois le mauvais élément

Une case à cocher **enveloppée dans son `<label>`** se signale à 18 × 36 px alors que la
cible réelle est le libellé — 337 × 44 sur l'éditeur d'horaires, et cliquer dessus bascule
bien la case (vérifié : `true → false`). Mesurer l'`<input>` seul produit un faux échec.

**Le remède** : quand un `input` est signalé, remonter à son `closest('label')` et mesurer
CELUI-LÀ ; puis prouver le lien en cliquant le libellé et en relisant `checked`. Même
principe pour un bouton dont la zone de visée est un parent (cf. les repères de la frise
du rejeu de trajet, où la cible de 44 px enveloppe un trait de 3 px).

**Et surtout : balayer TOUT le texte, pas une liste de sélecteurs.** La liste ne trouve que ce
qu'on a pensé à y mettre — le balayage générique a sorti à lui seul 2 échecs de
`/admin/ai-usage` qu'elle avait manqués.

> ⚠️ **`pnpm verif:contraste` ne remplace pas cette mesure** : il vérifie les 46 couples
> **déclarés**, pas les usages réels d'un jeton dans les gabarits (cf. O5).

**⚠️ Le navigateur peut mentir sur une chaîne de `packages/shared`.** Constaté le 2026-08-11
sur `/privacy-coverage` : l'état `interdit` affichait « **Gerer le mode vie privee** » sans
accents, alors que `packages/shared/src/permissions/permissions.ts:670` porte bien « Gérer le
mode vie privée » et que `pnpm verif:accents` est vert. Vérifié au code de caractère
(`e` = 101, pas `é` = 233) : ce n'est pas un artefact de lecture. **La source est juste ; c'est
le serveur de dev qui sert un chunk périmé du paquet partagé.** HMR recompile les fichiers de
`apps/web` mais pas forcément la dépendance. Conséquence de méthode : pour tout ce qui vient
de `packages/shared`, **la source fait foi, pas l'écran** — et il faut redémarrer `ng serve`
avant de conclure à un défaut de libellé.

**Une limite du PANNEAU, découverte le 2026-08-11.** Le panneau navigateur **n'émule pas
`pointer: coarse`** : la règle `@media (max-width: 768px) and (pointer: coarse)` de `styles.css`
n'est donc **jamais** appliquée dans nos mesures, alors qu'elle l'est sur un vrai téléphone. Ce
que la sonde mesure est le cas SANS ce plancher — c'est le cas défavorable, donc la mesure reste
valable, mais ne pas conclure de l'inverse. Idem pour `matchMedia` : le redimensionnement du
panneau (CDP) **n'émet pas d'événement `change`**, donc une bascule de point de rupture ne se
teste qu'en **rechargeant** à la largeur voulue, pas en redimensionnant.

**Deux limites connues, à ne pas « corriger » :**

- elle compte une case à cocher isolément, alors que c'est son **étiquette** qui porte la
  cible (mesurée 44 × 128 sur `/login`) ;
- elle signale les **liens en ligne dans une phrase** (« Coûts IA », « Se connecter »). Les
  élargir casserait le texte. Le critère vise les commandes, pas la typographie.

Six cibles restent signalées pour ces deux raisons. Aucune n'appelle une correction.

---

## Les cinq contrôles qui tournent

```bash
pnpm verif:litteraux && pnpm verif:contraste && pnpm verif:accents && pnpm verif:confirmations && pnpm verif:couleurs-kit && pnpm verif:variables
```

| | |
|---|---|
| `verif:litteraux` | un accent grave dans un commentaire de `template:`/`styles:` **ferme le littéral** — `tsc` passe, Angular échoue sans nommer le fichier, et le serveur sert un bundle périmé. ⚠️ **Angle mort corrigé le 2026-08-11** : il ne voyait que `styles: [` suivi IMMÉDIATEMENT de l'accent grave. La forme `styles: [` + saut de ligne (plusieurs composants, dont les portes d'accès) était **entièrement ignorée**. Vérifié par mutation : le piège réintroduit est maintenant attrapé |
| `verif:contraste` | 46 couples dans les deux thèmes |
| `verif:accents` | mots français sans accent dans les chaînes affichées, bornes Unicode (le `\b` ASCII casse sur « paramètres ») |
| `verif:confirmations` | une modale de danger sans `[consequences]` |
| `verif:couleurs-kit` | hex, classes de palette Tailwind **et `rgba()` teintés** dans `shared/ui` et `shared/components` |
| `verif:variables` | **ajouté le 2026-08-11** — les `var()` pointant sur un nom que rien ne définit, sur **tout `apps/web/src`** : c'est le trou que `verif:couleurs-kit` laisse. Refuse aussi le vocabulaire `@theme inline`, non émis dans `:root`. Vérifié par mutation sur les quatre formes |

**`pnpm verify` se termine maintenant** (~40 s) : typecheck · smoke · 277 partagés · 328 web ·
1900 API. Le P1 de la feuille de route est corrigé.

---

## Les pièges de cette base, déjà payés

1. **Backtick dans un commentaire de `template:`/`styles:`** — cf. ci-dessus. `pnpm verif:litteraux`.
2. **Une règle CSS correcte qui ne s'applique pas.** Trois fois cette séance : enfermée dans
   un `@media (max-width: 768px)` alors que le mode simplifié navigue au bouton à toute
   largeur · écrasée par une seconde règle plus bas dans la même feuille · écrite dans un
   composant alors que l'écran mesuré est **son jumeau** (`installation-editor` vs
   `installations-client`, mêmes classes, feuilles séparées par l'encapsulation).
   **Toujours corriger la source, jamais empiler une règle de plus.**
3. **Le cookie de session prime sur le jeton Bearer.** Pour tester un rôle :
   `await fetch('/api/auth/logout', {method:'POST', credentials:'include'})` **avant**
   d'injecter le jeton dans `localStorage` (`vizyo-tracky-token`).
4. **Prisma échoue sur `localhost` après une veille** — Node résout en IPv6 et le proxy Docker
   tombe. Forcer `127.0.0.1`. Ne pas modifier le `.env` de l'utilisateur.
5. **`ng test` du web** : Karma/Jasmine, **pas Jest**. `it.each` et `jest.fn()` ne compilent
   pas — et cassent **toute** la suite, pas seulement leur fichier.

### Remonter l'environnement

```bash
docker compose up -d
```

Puis `preview_start` sur `web-refonte` (4205) et `api-refonte` (3000). Jeton admin :

```bash
pnpm --filter @vizyo/tracky-api exec ts-node prisma/gen-test-token.ts
```

---

## ⚠️ Deux choses à ne pas rater

**1. Du travail en cours qui n'est pas le nôtre.** `apps/api/src/tracker-fix-mode/` porte des
modifications **non commitées** : un `AckWaiterService` ajouté au constructeur du service sans
être fourni au module de test → **30 tests en échec**. Les commits de cette séance stagent
`apps/web` uniquement. **Ne pas committer ces fichiers, ne pas les corriger sans demander.**
Même chose pour `docs/centre-alerte/` et `docs/vps-audit/`, modifiés hors de ce chantier.

**2. Une décision en attente.** La **variante critique** de `confirm-modal` existe — liseré
rouge, état de l'objet rappelé, plaque à retaper — mais elle **n'est branchée nulle part**.
`B1-PAGES.md` § F la spécifie pour la coupure moteur. Ajouter une saisie à un geste d'urgence
est une décision d'écran, pas de kit : **demander avant de la brancher**.

---

## Ce que le kit met à disposition, et qu'il faut utiliser

- **`<app-zone>`** (`shared/ui/zone/`) — les **6 états** rendus une fois : `chargement`
  (squelette, et une sortie au-delà de 8 s) · `rempli` · `vide` · `erreur` (toujours un
  recours) · `partiel` (le contenu reste, un bandeau nomme ce qui manque) · `interdit`
  (**nomme la permission**, libellé tiré de `PERMISSION_LABELS`).
  **Le brancher dans les écrans qui gèrent encore leurs états à la main est le vrai travail
  de fond de B-pages.**
- **`<app-confirm-modal>`** — `consequences` chiffrées obligatoires sur un danger,
  `irreversible`, `critique`, feuille sous 640 px.
- **`<app-bottom-sheet>`** — géométrie de plateforme (jetons `--feuille-*`), hauteur
  annonçable, variante `sansVoile` pour les feuilles posées sur la carte.
- **Jetons `--texte-*`** — le petit texte lisible dans les deux thèmes. `--danger` reste le
  rouge des liserés ; `--texte-alerte` est celui des caractères.
- **`--surface-quaternary`** — ce qui se pose SUR une carte (chips, squelettes).

---

## Le journal de bord

`REFONTE-TRACKY-V2.md` se termine par un tableau « Journal de bord », une ligne par séance.
**Le tenir à jour** : c'est lui qui porte les décisions et les points ouverts d'une séance à
l'autre.
