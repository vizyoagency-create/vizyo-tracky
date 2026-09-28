# Refonte UX du module Agenda — conception, 2026-09-28 (soir)

**Commande du propriétaire (28/09, 11 points + 5 captures)** : « l'utilisation doit être évidente,
fluide et rapide, même pour un utilisateur qui découvre complètement le module » ; « un utilisateur
du CDEF découvre cette nouvelle version et se dit : *Waouh, ça me change la vie* ».

Ce document est la **cible** décidée avant de coder, à partir d'une lecture complète du module tel
qu'il est (inventaire du 22/09, code du 28/09 au soir : `agenda.component.ts` 2 852 lignes, cinq
feuilles, un dialogue QR, un sélecteur de créneau, l'API réservations / IA / réorganisation). Le
journal de réalisation et la recette sont dans `SUIVI-REVUE-AGENDA-2026-09-24.md` (section du 28/09,
soir).

---

## 0. Le diagnostic en une page

| Constat (capture ou lecture) | Cause dans le code | Décision |
|---|---|---|
| **Huit boutons** en tête de page (Réserver · Demandes · QR · Réorganiser · Optimisation · Propositions IA · + Événement · ⚙️), « l'impression qu'il faut tout faire en même temps » | chaque lot a ajouté son bouton à `.ag-actions` | **Quatre entrées** : Réserver · Demandes (si > 0) · + Événement · ⋯ (QR, Réorganiser, Paramètres). Les gestes IA quittent l'en-tête pour une **vue dédiée**. |
| Le créneau se choisit dans un **grand calendrier** déplié (capture 2 : « 28 → 30 »), la plage multi-jours « existe mais personne ne la trouve » (F9) | `datetime-range-picker` = grille 42 cases + deux heures | **Sélecteur compact** : Début (date · heure) → Fin (date · heure), raccourcis (Même jour · +1 j · +1 sem. · Journée), et une ligne de lecture « 3 jours · lun. 5 → mer. 7 oct. · 09:00 → 17:00 ». Plus de grille. |
| Une réservation de trois jours se lit comme trois pilules identiques ; sa durée n'est nulle part sans ouvrir | `joursCouverts` pose une « suite » sans dire J2/3 | Pilule du premier jour « titre · 3 j », suites « ↳ titre (2/3) » ; carte du jour « du lun. 5 09:00 au mer. 7 17:00 · 3 jours (jour 2/3) » ; liste À venir et file de validation portent « · 3 j ». |
| **Réorganiser** ouvre sur « Aucune réservation ne correspond » (capture 3) | cible par défaut « posées par l'agent » — or l'agent **ne réserve plus fermement** depuis le 23/09 : ce lot est structurellement vide | La feuille dit **à quoi elle sert** (trois cas), montre les **comptes par origine** sur les choix, explique le vide, et gagne le geste qui manquait : **réaffecter** les réservations d'un véhicule (au garage) vers un autre, ou « auto ». Entrée depuis la création d'une immobilisation. |
| Le **QR** déborde de l'écran (capture 4) | carte 452 × 792 px à l'échelle 1 + textes + actions | Carte réduite par `--tqu` (l'unité de la carte) selon la hauteur disponible, deux colonnes sur grand écran, textes fusionnés : **tout visible sans défiler**. L'impression garde la carte pleine. |
| **Optimisation** : on ne sait pas ce qu'« Analyser » va changer, ni la différence avec « Appliquer » ; l'analyse se relance à volonté (capture 5) | feuille sans explication d'ordre ; résultat gardé dans le navigateur (P1-5), aucune garde serveur | Devient l'**étape 1 de la vue Assistant IA** : « Analyser = l'IA lit et propose, rien n'est écrit ; Appliquer = vous écrivez les fiches cochées ». **Une analyse par jour et par société**, refusée par le serveur (429) et **expliquée** à l'écran, résultat **conservé côté serveur** (table `ai_capacity_analyses`) — visible de tout poste, appliqué par véhicule. |
| **Propositions IA** : une carte par proposition, on se perd quand un véhicule en a plusieurs | liste plate | **Regroupées par véhicule**, une ligne par proposition (jour · heure · destination · confiance · ✓ ✗), actions par véhicule (tout réserver / tout écarter), repliables. |
| Le groupe n'existe pas sur une réservation | `metadata` : requesterId, reason, criteria | **`metadata.group`** = le groupe **qui utilise** le véhicule : pré-rempli avec le groupe du véhicule, modifiable à la demande (gestionnaire), à la validation et à l'édition ; **jamais écrit sur le véhicule**. Le filtre « groupe » de l'agenda retient une réservation par son groupe **ou** par celui du véhicule. |
| Maintenance et incident : deux « types » pour un même formulaire ; un événement ne sait rien des réservations qu'il écrase | même modal, `blocksVehicle` seul lien | Un formulaire « Indisponibilité » assumé : nature (Entretien / Incident) expliquée en une ligne, et un bloc **« Réservations pendant cette période »** : pour chaque réservation du véhicule sur la fenêtre, *Laisser · Annuler · Réaffecter (auto)*, décisions tracées dans `metadata.reservations` de l'événement. |
| Le paramétrage des véhicules (places, équipements, sièges) est **dans trois écrans** (Parc & capacités, Paramètres de l'agenda, fiche véhicule) | historique des sprints | Nouvelle **vue Parc** dans l'agenda : schéma des véhicules (places, sièges à bord, équipements, groupe, état), **stock de sièges visuel** (à bord / en stock), clic → réglage rapide. Le bloc « Sièges auto » des Paramètres se réduit à un résumé + « Ouvrir la vue Parc ». |

## 1. L'architecture cible de la page

```
Agenda                                     [Réserver] [Demandes 3] [+ Événement] [⋯]
sous-titre · pastille des travaux IA · 3 compteurs · « À clore »
Vue :  ( Calendrier | Missions | Parc | Assistant IA •3 )
```

- **Calendrier** — comme aujourd'hui : filtres (groupe, véhicule, type, mois), grille, légende,
  « À venir & en retard ». Le type « Mission » quitte le segment de type : c'est une **vue**, pas un
  filtre (il remplaçait déjà la grille).
- **Missions** — l'onglet dépôt inchangé (vue par défaut sans `agenda_view`, comme avant).
- **Parc** *(reservations_view)* — le schéma des véhicules et le stock de sièges. Réglage rapide au
  clic (`vehicles_edit` pour places/équipements ; admin pour les sièges).
- **Assistant IA** *(reservations_view)* — trois étapes numérotées, chacune dit **ce qu'elle lit, ce
  qu'elle change, ce qu'on doit faire** :
  1. **Vérifier le parc** — analyse des capacités (1×/jour/société, résultat conservé, appliquer par
     véhicule) ; renvoi vers la vue Parc pour vérifier à la main.
  2. **Propositions de l'agent** — regroupées par véhicule, actions en ligne ; « Lancer un passage »
     et « Réglages de l'agent » (feuille Paramètres) ; derniers passages.
  3. **Réserver avec l'IA** — explique « Suggérer avec l'IA » (placement) et ouvre Réserver.
  Puis **Sous-utilisation** (sans IA, déterministe) : les véhicules libres à mutualiser.
- **⋯** — QR de réservation · Réorganiser des réservations · Paramètres de l'agenda.

Les feuilles **Optimisation** et **Propositions de l'agent** disparaissent (leur contenu vit dans la
vue Assistant IA). La pastille des travaux IA reste : « Voir » bascule sur la vue.

## 2. Décisions de conception, point par point

### 2.1 Multi-jours (points 1 et 10)
- Le serveur acceptait déjà n'importe quelle durée (`parseSlot`) ; le défaut était **la saisie et la
  lecture**. Le nouveau `app-datetime-range` garde ses entrées/sorties (`YYYY-MM-DDTHH:mm`) : la
  feuille Réservation ne change pas de câblage. Règle de cohérence : si la fin passe avant le début,
  elle est ramenée au même jour (même heure + 1 h si nécessaire).
- Lecture : `dureeEnJours` (déjà là) devient la source des « 3 j » partout ; la grille numérote les
  suites (jour 2/3). Une réservation de 20 jours reste 20 pilules : la borne de 62 de
  `joursCouverts` tient.
- Le lien public garde ses deux `datetime-local` (déjà compacts) : hors périmètre.

### 2.2 Groupe de réservation (point 9)
- DTO partagé `ReservationGroupDto { id: string | null; name: string }` ; `group?` sur
  `RequestReservationDto`, `ConfirmReservationDto`, `UpdateReservationDto` (`null` retire).
- Serveur : `id` vérifié dans la société (`vehicle_groups`), sinon 400 ; nom ≤ 60 caractères. Défaut :
  le groupe du véhicule **au moment où le véhicule est fixé** (demande avec véhicule, attribution
  automatique, validation). Un changement de véhicule à l'édition **ne touche pas** le groupe déjà
  posé : c'est celui qui utilise, pas celui qui possède.
- Interface : champ « Groupe qui utilise le véhicule » (liste des groupes de la société + « Autre… »
  en texte libre), aide « Par défaut, le groupe du véhicule. Le véhicule garde le sien. » Visible en
  demande (gestionnaire), en édition, et sur chaque carte « À valider ». Affiché sur la carte du
  jour, la liste À venir et la file.

### 2.3 Assistant IA (points 2, 6, 7)
- **Une analyse de capacités par jour et par société** : `POST /ai/capacity/suggest` refuse (429,
  message avec l'heure de la prochaine) s'il existe une analyse réussie de moins de 24 h pour la
  société ; un super-admin peut passer `force` (recette). `GET /ai/capacity/latest` rend la dernière
  analyse (propositions, date, véhicules déjà appliqués) et `nextAllowedAt`.
- Pourquoi une par jour (texte à l'écran) : « le parc ne change pas d'heure en heure, et chaque
  analyse est facturée ; relancer sans avoir rien changé redonne le même résultat ».
- Le résultat n'est plus dans `localStorage` : il est en base (`ai_capacity_analyses`), donc visible
  d'un autre poste et après un rechargement — P1-5 est couvert par construction.
- Propositions de l'agent : même API (`apply` / `dismiss` par id) ; « tout réserver / tout écarter »
  enchaîne les appels côté client, un compte-rendu par véhicule.

### 2.4 Vue Parc (point 3)
- Lit `GET /vehicles/capacity-overview` (places, énergie, équipements, groupe, sièges à bord) et
  `GET /agenda/child-seats` (possédés, installés, stock, politique). Écrit avec ce qui existe :
  `PATCH /vehicles/:id` (places, équipements), `PUT /agenda/child-seats/vehicles/:id` (sièges à
  bord), `PUT /agenda/child-seats` (possédés, politique). **Aucune nouvelle route.**
- Le stock est dessiné : une rangée de sièges par type, pleins = à bord (la plaque au survol),
  creux = en stock, et le réglage sous la rangée.

### 2.5 Réorganiser (point 4)
- Trois cas nommés dans l'en-tête de la feuille : *un véhicule part au garage* (réaffecter), *une
  journée tombe* (annuler), *les horaires glissent* (décaler).
- La simulation rend en plus `totaux` par origine (agent / lien public / manuelle) et `parVehicule`
  : les choix affichent leurs comptes, le vide s'explique (« l'agent ne réserve plus fermement
  depuis le 23/09 »), et un véhicule se cible.
- Nouvelle primitive serveur `POST /reservations/:id/reaffecter { versVehicleId? }` (`auto` = premier
  véhicule libre conforme aux critères, hors véhicule d'origine), utilisée par le lot
  (`action: 'reaffecter'`) **et** par le formulaire d'indisponibilité. Chaque refus remonte avec son
  motif, comme aujourd'hui.

### 2.6 QR (point 5)
- `--tqu: min(0.72px, (100vw − 48px)/452, (100dvh − 230px)/792)` : la carte tient toujours dans la
  hauteur, textes et actions compris. Deux colonnes dès 700 px. Le bouton « Imprimer » ouvre la
  carte pleine, comme avant.

### 2.7 Événements (point 8)
- Le formulaire s'intitule **Indisponibilité** (nature Entretien / Incident), en deux colonnes sur
  grand écran (quoi | quand), la sévérité n'apparaît que pour un incident (déjà), et le bloc
  « Réservations pendant cette période » liste les réservations du véhicule qui chevauchent la
  fenêtre quand « Immobilise le véhicule » est coché. Les décisions s'appliquent **après** la
  création de l'événement, et sont écrites dans `metadata.reservations`.
- Pas de fusion des types en base : maintenance et incident portent des plans, des sévérités et des
  compteurs différents (`overdue`, `openIncidents`). La factorisation est **d'usage** : un seul
  formulaire, un seul vocabulaire, une seule mécanique de clôture (déjà « À clore »).

## 3. Ordre de réalisation et vérification

| Lot | Contenu | Vérifié par |
|---|---|---|
| A | sélecteur compact, lecture multi-jours (grille, carte du jour, À venir, file) | tests `agenda-calendar` (numérotation), recette démo (créer / modifier une réservation de 3 jours, la lire sans l'ouvrir) |
| B | groupe de réservation (DTO, API, feuille, cartes, filtre) | tests `reservations.service` (défaut, vérification société, édition), recette démo |
| C | QR compact | recette démo (iPhone 390 × 844 : rien à défiler) |
| D | en-tête à quatre entrées, sélecteur de vue, vue Assistant IA, analyse 1×/jour conservée | tests `ai-optimization.service` (garde 24 h, conservation), recette démo |
| E | vue Parc + réglage rapide, Paramètres allégés | recette démo (régler places / sièges depuis la vue, relire dans Réserver) |
| F | `reaffecter`, Réorganiser refondu, bloc réservations du formulaire d'indisponibilité | tests `reservations.service` (réaffectation, refus), recette démo |
| G | passe globale : mobile, textes, `ng build`, `pnpm verify`, déploiement, recette prod **sans courriel vers @cdef31.org** | journal de suivi |

Ce qui n'est **pas** dans cette refonte : la page publique de réservation (déjà compacte), le
tableau des missions, les rapports.
