# Icônes — symboles de maquette → lucide-angular

> Étape 0 du livrable (`B0-SOCLE.md` § « Écart 3 »). Les maquettes définissent des `<symbol>`
> SVG en ligne (`ic-power`, `ic-truck`, `ic-shield`…). L'application utilise
> **lucide-angular** (`^0.460.0`).
>
> Les pictogrammes des maquettes ont été dessinés dans le style Lucide (trait 1,9 px, bouts
> arrondis) précisément pour que la correspondance soit directe. **Mais elle doit être
> écrite, pas devinée.**

---

## La règle de conversion

Un symbole `ic-nom-compose` devient l'export Lucide en PascalCase : `NomCompose`.

```
ic-power        →  Power
ic-poweroff     →  PowerOff
ic-truck        →  Truck
ic-shield       →  Shield
ic-map-pin      →  MapPin
ic-alert-circle →  AlertCircle
```

L'import se fait toujours nommé, jamais en `*` :

```ts
import { LucideAngularModule, Truck, MapPin } from 'lucide-angular';
```

**Trois cas sortent de la règle** et exigent une décision écrite :

1. Lucide n'a pas d'équivalent → § « Décisions ».
2. Lucide en a plusieurs, sans que le nom tranche → § « Décisions ».
3. Le symbole n'est pas une icône d'interface → § « L'exception ».

---

## La règle de priorité — avant de choisir une icône

**Chercher d'abord dans les 181 icônes déjà employées** (inventaire ci-dessous). Le critère
de recette n° 2 de `B1-PAGES.md` — « icônes issues de `design/ICONS.md`, aucune inventée » —
vise exactement ce point : chaque icône nouvelle est un vocabulaire de plus à retenir pour
l'utilisateur, et un poids de plus dans le bundle.

Une icône n'est ajoutée que si aucune des 181 ne dit la chose. L'ajout est alors consigné
dans le § « Ajouts » de ce fichier, avec sa raison.

---

## Décisions

### D-I1 — `ic-van` → `Truck`

Lucide n'a **pas** de camionnette distincte du camion. Les deux emploient `Truck`.

La distinction visuelle entre `VAN` et `TRUCK` reste possible là où elle compte vraiment —
sur la carte — parce que les pastilles de véhicule ne sont pas des icônes Lucide (cf.
« L'exception »). Dans les listes et les formulaires, `Truck` suffit : le type est déjà
écrit en toutes lettres à côté.

### D-I2 — Le compte dépôt prend `Warehouse` — le seul ajout du bloc A

`A5-COMPTES.md` § 3 demande « pastille *Dépôt* avec l'icône camion ». Employer `Truck` pour
le **compte** dépôt et pour le **véhicule** dans la même liste rend les deux illisibles :
dans `/users`, la colonne Rôle porterait le même pictogramme que la colonne Périmètre.

`Building2` ne convient pas non plus — c'est déjà, sans ambiguïté, l'icône **flotte /
société** du dépôt de code : `FleetIcon = Building2` (`admin-ai-usage`), `Building2Icon` sous
le titre « Flotte » (`admin-sims`), `fleet-selector`, `sa-fleet-badge`. La réemployer pour le
compte dépôt entrerait en collision frontale avec la règle de vocabulaire d'`A0` : « dans
l'interface du dépôt, on ne dit jamais « société » ».

**Décision** : `Warehouse` pour le **compte** dépôt (avatar dans `/users`, sélecteur de
destinataire dans la modale de mission), `Truck` pour le véhicule, `Building2` pour la
société. Export vérifié présent en 0.460.

C'est le **seul ajout au vocabulaire** du bloc A : aucune des 181 icônes employées ne dit
« dépôt ». Le libellé « Dépôt » accompagne toujours la pastille — l'icône ne porte jamais
seule l'information.

### D-I3 — La mission prend `Route`

Une mission est un trajet déclaré entre deux points. `Route` (déjà employée) le dit mieux que
`Calendar` (qui parlerait de l'agenda, pas de la mission) ou `Navigation` (qui parle de
direction instantanée).

`Calendar` reste l'icône de l'onglet Agenda ; `Route` celle de l'onglet Missions à
l'intérieur.

### D-I4 — Le partage prend `Share`, pas `Share2`

Les deux sont exportées par la 0.460. `Share` est **déjà employée**
(`install-banner.component.ts`) pour l'action de partage iOS. Réemployer la même pour le lien
de suivi garde une seule idée de « partage » dans l'application, au lieu de deux
pictogrammes voisins que rien ne distingue à l'usage. **Aucun ajout.**

### D-I5 — Le lien fermé prend `Unlink`

`LinkOff` **n'existe pas** en 0.460 — vérifié. Deux candidats réels : `Unlink` et `Link2Off`.
`Unlink` est déjà employée. Elle sert à l'état « lien fermé » de la page publique et au
bouton « Révoquer » de la modale de partage. **Aucun ajout.**

### D-I6 — Les paires d'alias : retenir la forme déjà employée

`lucide-angular` 0.460 exporte **les deux formes** de plusieurs icônes renommées en amont —
vérifié : `AlertTriangle` **et** `TriangleAlert`, `AlertCircle` **et** `CircleAlert` sont
toutes présentes. Aucune ne casse la compilation.

Le risque n'est donc pas l'échec de build, c'est la **divergence** : deux fichiers important
le même pictogramme sous deux noms, et une recherche dans le code qui n'en trouve qu'un.

**Décision** : retenir la forme **déjà majoritaire dans le dépôt** — `AlertTriangle` (employée
par `confirm-modal`) et `AlertCircle`. Les deux formes coexistent aujourd'hui dans le code ;
l'uniformisation se fera au lot B-kit, pas en étape 0.

---

## L'exception — les pastilles de véhicule de la carte

> B0 : « Les pastilles de véhicule sur la carte (CAR, TRUCK, VAN, MOTORCYCLE, BICYCLE, BUS,
> CONSTRUCTION, OTHER) **ne sont pas** des icônes Lucide. Elles ont été redessinées pour
> rester lisibles en petit avec rotation selon le cap. **À reprendre telles quelles en SVG**
> depuis la planche Carte. »

**Elles existent déjà dans le dépôt** : `apps/web/src/app/shared/utils/vehicle-icons.ts`,
tableau `VEHICLE_TYPES` — les 8 types, chacun avec son `svg` en `viewBox="0 0 24 24"`.

| Clé | Libellé |
|---|---|
| `CAR` | Voiture |
| `TRUCK` | Camion |
| `VAN` | Camionnette |
| `MOTORCYCLE` | Moto |
| `BICYCLE` | Vélo |
| `BUS` | Bus |
| `CONSTRUCTION` | Engin |
| `OTHER` | Autre |

**Règles** :
- Ces SVG ne sont **jamais** remplacés par des icônes Lucide, dans aucun écran de carte.
- Ils sont rendus en blanc sur pastille colorée, avec rotation selon le cap
  (`--tracky-heading`, cf. `styles.css:457`).
- La carte live du bloc A (`/depot`) et la page publique (`/s/:token`) les réemploient tels
  quels — pas de second jeu de marqueurs.
- Hors carte (listes, formulaires, fiches), c'est `Truck` / `Car` de Lucide qui s'applique.

*Note : le commentaire d'en-tête de `vehicle-icons.ts` mentionne « Leaflet markers ». Le
dépôt est passé à MapLibre. Commentaire à rafraîchir au passage du lot B-pages `/map`.*

---

## Ajouts pour le bloc A

**Un seul** : `Warehouse`, pour le compte dépôt (cf. D-I2). Tous les autres besoins se
couvrent avec des icônes déjà employées.

| Besoin | Icône | Déjà employée |
|---|---|:-:|
| Compte dépôt | `Warehouse` | ➕ **ajout** |
| Mission | `Route` | ✅ |
| Partager un suivi | `Share` | ✅ |
| Révoquer / lien fermé | `Unlink` | ✅ |
| Signaler un incident | `AlertTriangle` | ✅ |
| Position live / suivi | `Navigation` | ✅ |
| Fenêtre horaire | `Clock` | ✅ |
| Document / bon de livraison | `FileText` | ✅ |
| Export | `Download` | ✅ |
| Téléphone du conducteur | `Phone` | ✅ |
| Périmètre fermé (encart cadenas) | `Lock` | ✅ |

---

## Inventaire — les 181 icônes employées

Extraites de tous les `import … from 'lucide-angular'` de `apps/web/src`. **C'est le
vocabulaire de l'application.** Chercher ici avant d'ajouter.

**Actions** · `Check` `CheckCheck` `CheckCircle` `CheckCircle2` `Copy` `ClipboardCopy`
`Download` `Upload` `Edit2` `Edit3` `Pencil` `Save` `Send` `Share` `Trash2` `Plus` `X`
`RefreshCw` `RotateCcw` `Play` `Pause` `Printer` `Search` `Filter` `Link` `Link2` `Unlink`
`ExternalLink` `Maximize2` `MoveVertical` `GripVertical`

**Navigation** · `ArrowUp` `ArrowDown` `ArrowLeft` `ArrowRight` `ArrowUpRight`
`ArrowDownLeft` `ArrowLeftRight` `ArrowRightLeft` `ArrowUpDown` `ChevronUp` `ChevronDown`
`ChevronLeft` `ChevronRight` `CornerDownLeft` `Menu` `MoreHorizontal` `MoreVertical`
`LayoutDashboard` `LayoutGrid` `List` `Table` `Inbox` `FolderOpen` `Archive`

**Véhicule et flotte** · `Truck` `Car` `Fuel` `Gauge` `Route` `Navigation` `Compass`
`Crosshair` `MapPin` `Map` `ParkingSquare` `Footprints` `Spline` `Timer` `Wrench` `Leaf`

**État et connectivité** · `Wifi` `WifiOff` `Radio` `Satellite` `SatelliteDish` `Plug`
`Unplug` `Network` `Power` `PowerOff` `Zap` `Activity` `Circle` `CircleDot` `Square`
`OctagonX`

**Alerte et sécurité** · `AlertCircle` `AlertTriangle` `CircleAlert` `Ban` `Bell` `BellOff`
`BellRing` `Shield` `ShieldAlert` `ShieldCheck` `ShieldOff` `ShieldQuestion` `Lock` `Unlock`
`KeyRound` `Fingerprint` `Eye` `EyeOff` `Bug` `XCircle`

**Temps** · `Calendar` `CalendarCheck` `CalendarClock` `CalendarDays` `Clock` `AlarmClock`
`History`

**Personnes** · `User` `UserCheck` `UserCircle2` `UserPlus` `UserRound` `UserX` `Users`
`IdCard` `Baby` `Briefcase`

**Communication** · `Mail` `MessageCircle` `MessageSquare` `Phone` `PhoneOff` `Mic` `MicOff`
`Ear` `StickyNote`

**Données et analyse** · `BarChart3` `TrendingUp` `TrendingDown` `FileBarChart`
`FileSpreadsheet` `FileText` `ClipboardList` `ListChecks` `Database` `HardDrive`
`MemoryStick` `Server` `Cpu` `Terminal` `FlaskConical` `ScanSearch` `Sliders`

**Commerce** · `BadgeEuro` `CreditCard` `Wallet` `Gift` `Tag` `Trophy` `ThumbsUp`
`PartyPopper`

**Système et réglages** · `Settings` `Settings2` `Palette` `Sun` `Moon` `Monitor`
`Smartphone` `Tablet` `Globe` `Building2` `Layers` `QrCode` `BookOpen` `Info` `Lightbulb`
`Sparkles` `Bot` `Loader` `LoaderCircle` `LogIn` `LogOut` `MousePointer2`
`MousePointerClick`

---

## Points ouverts

**O-I1 — La table `ic-*` exhaustive attend les maquettes.** Ce fichier pose la règle de
conversion, les 6 décisions déterminables, l'exception carte et l'inventaire des 181 icônes
employées. La table symbole par symbole ne peut être écrite que devant les 27 `.dc.html` —
c'est là que vivent les `<symbol id="ic-…">`. À compléter dès leur livraison, **avant** la
première page du bloc B.

**O-I2 — Vérifier chaque nom d'export avant emploi.** Lucide a renommé des icônes au fil des
versions ; la 0.460 exporte souvent **les deux formes**, mais pas toujours — `LinkOff` est
absente alors que `Unlink` et `Link2Off` sont présentes. Un nom absent ne produit pas une
icône manquante à l'écran : il produit une **erreur de compilation**.

Commande de vérification :

```bash
grep -cE "(^| |,)NomIcone ?[=,}]" node_modules/.pnpm/lucide-angular@0.460.0*/node_modules/lucide-angular/fesm2020/lucide-angular-src-icons.mjs
```

**O-I3 — Deux paires d'alias coexistent dans le code.** `AlertTriangle` / `TriangleAlert` et
`AlertCircle` / `CircleAlert` sont toutes deux employées aujourd'hui. Uniformisation prévue
au lot B-kit sur les formes retenues en D-I6.
