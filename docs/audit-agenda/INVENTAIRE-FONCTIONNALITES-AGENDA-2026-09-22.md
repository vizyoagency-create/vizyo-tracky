# Inventaire des fonctionnalités de la page **Agenda** — 2026-09-22

Audit de lecture du code, pas de la maquette. Chaque fonctionnalité ci-dessous est reliée au
fichier qui la porte, pour qu'on puisse la vérifier sans me croire sur parole.

> ⚠️ **Une réponse d'emblée sur ta question** : **les plannings d'installation ne sont PAS dans
> l'agenda.** Ils vivent sur quatre écrans à part (`/admin/installations`, `/admin/installations/:id`,
> `/installations`, `/admin/installation-bookings`) plus une page publique `/book/:token`. Aucun lien
> de code entre eux et `/agenda`. Détail au § 17.

---

## 0. Ce qu'est la page

| | |
|---|---|
| **Route** | `/agenda` — [app.routes.ts:271](../../apps/web/src/app/app.routes.ts#L271) |
| **Garde de route** | `anyPermissionGuard('agenda_view', 'reservations_view', 'reservations_request', 'ai_optimize', 'missions_view')` — **large exprès** : chacun entre pour *sa* partie |
| **Redirections héritées** | `/optimisation`, `/reservations`, `/ia` → `/agenda` (trois anciennes pages fondues ici au Sprint 9) |
| **Plan commercial** | fonction `agenda` = palier **PRO** ([plan.service.ts:16](../../apps/web/src/app/core/services/plan.service.ts#L16)) ; un bandeau `app-plan-upsell` s'affiche en tête si le plan ne couvre pas |
| **Composant racine** | [agenda.component.ts](../../apps/web/src/app/features/agenda/agenda.component.ts) — 2 050 lignes |
| **Module serveur** | [apps/api/src/agenda/](../../apps/api/src/agenda/) — 5 contrôleurs, 11 services |

**Point structurant** : la route est ouverte large, mais **la grille du calendrier n'appartient
qu'à `agenda_view`**. Un `FLEET_MANAGER` (qui a `missions_manage: true` et `agenda_view: false`
par défaut) entre sur la page et n'y voit **que l'onglet Missions** — ni grille, ni compteurs, ni
échéances, et l'app **n'appelle même pas** les endpoints qu'il n'a pas le droit d'appeler.

---

## 1. En-tête — la barre d'actions (7 entrées, toutes conditionnelles)

| Bouton | Condition d'affichage | Ce qu'il fait |
|---|---|---|
| **Réserver** | `reservations_request` | Ouvre la feuille Réservations en mode « Demander » (§ 9) |
| **Demandes** + pastille de compte | `reservations_manage` **et** ≥ 1 demande `REQUESTED` | Ouvre la feuille Réservations en mode « À valider ». Le compteur est dérivé des événements déjà chargés — aucun appel supplémentaire |
| **Optimisation** | `reservations_view` **et** fonction IA `capacity` ouverte | Ouvre la feuille Optimisation (§ 10) |
| **Propositions IA** + pastille | `reservations_view` **et** (propositions en attente **ou** fonction `agendaAgent` + admin) | Ouvre la revue des propositions de l'agent (§ 12) |
| **Événement** | `agenda_manage` | Ouvre la modale de création maintenance/incident (§ 8) |
| **⚙️ Paramètres de l'agenda** | rôle `SUPER_ADMIN` ou `FLEET_ADMIN` | Ouvre les réglages de l'agent IA (§ 11) |
| **Sous-titre adaptatif** | — | « Entretiens planifiés et incidents de votre flotte » si `agenda_view`, sinon « Les missions de votre flotte, et leurs tournées » |

Détail non trivial sur **Propositions IA** : couper l'IA **n'enferme pas** les propositions déjà
produites — elles se valident et se refusent sans aucun appel moteur. Ce bouton en était la seule
porte ; **779 propositions étaient enfermées** le jour du correctif.

---

## 2. Le strip de 3 compteurs

`GET /api/agenda/summary` — masqué sans `agenda_view` (trois zéros seraient un mensonge : la flotte
en a peut-être trente).

| Compteur | Contenu |
|---|---|
| **En retard** | Événements non clôturés dont l'échéance est passée |
| **À venir (30 j)** | Échéances des 30 prochains jours |
| **Incidents ouverts** | Incidents au statut `OPEN` |

---

## 3. Pastille de suivi des travaux IA (`app-ai-job-pill`)

[ai-job-pill.component.ts](../../apps/web/src/app/features/agenda/ai-job-pill.component.ts)

Bandeau en haut de page qui suit les opérations IA **lancées en arrière-plan**, avec trois états
explicites : **en cours** (animation « scan », phrase qui dit ce que l'IA fait, barre de progression
indéterminée), **prêt** (résumé du résultat + bouton « Voir »), **échec** (message lisible).

- « Voir » **ré-ouvre la bonne feuille avec le résultat pré-chargé** : `agent-run` → propositions ;
  `optimization`/`capacity` → feuille Optimisation avec les capacités à valider déjà là.
- La pastille est **toujours effaçable, même en cours** : sinon une requête qui ne répond jamais
  (socket pendu) laisse « IA en cours… » bloqué à vie.

---

## 4. Barre de filtres (4 contrôles, masqués sans `agenda_view`)

1. **Groupe** — menu déroulant, construit à partir des groupes réellement présents sur les
   véhicules de la société courante (dédup + tri alpha). Changer de groupe **réinitialise** le
   véhicule s'il n'en fait plus partie.
2. **Véhicule** — menu déroulant, restreint au groupe sélectionné, avec plaque + marque/modèle.
3. **Type** — segment `Tous · Maintenance · Incident · Réservation · Mission`. **Filtrage
   client instantané, sans aller-retour serveur.** Choisir « Mission » **fait office d'onglet** et
   remplace la grille par le tableau des missions (§ 13).
4. **Navigation de mois** — `‹ mois ›` + libellé `septembre 2026` + bouton **Aujourd'hui**
   (désactivé si on y est déjà). Chaque changement recharge les trois couches : événements,
   activité réelle, prévision.

Sur mobile (≤ 768 px) toutes ces cibles sont forcées à **44 × 44 px** : sur un calendrier, changer
de mois est le geste le plus répété de la page.

Le **filtre société global** (sélecteur `SUPER_ADMIN` en haut de l'app) est câblé : en changer
recharge toute la page.

---

## 5. La grille calendrier mensuelle

[agenda-calendar.component.ts](../../apps/web/src/app/features/agenda/agenda-calendar.component.ts)
— écrite à la main sur `Date` natif, aucune librairie.

- **42 cellules** (6 semaines × 7 colonnes, lundi → dimanche). Jours hors-mois atténués, jour
  courant surligné.
- **Fenêtre de chargement = la grille entière**, pas le mois : les événements des jours hors-mois
  sont bien là.
- Par cellule : jusqu'à **3 pilules** colorées (couleur = type, sévérité pour les incidents),
  puis `+N` en débordement. Tri : non clôturés d'abord, puis par heure.
- Un événement `DONE`/`CANCELLED` est rendu **muet et barré**, pas supprimé.
- **Deux couches d'analyse superposées** (badge coin haut-droit) :
  - `● N` **bleu** = nombre de véhicules **distincts ayant réellement roulé** ce jour ;
  - `~N` **violet pointillé** = nombre de véhicules dont l'**usage est prévu** ce jour.
- **Mobile** : les pilules texte deviennent des pastilles colorées et les badges chiffrés des
  points de coin — pas de défilement horizontal.
- **Légende** sous la grille : Maintenance / Incident / Réservation / Activité réelle / Usage prévu.

---

## 6. Le panneau du jour (clic sur une cellule)

Bottom-sheet sur mobile, panneau centré sur desktop. **Son contenu change selon que le jour est
passé, aujourd'hui, ou à venir** — un bandeau de contexte le dit explicitement.

### 6.1 Disponibilité (aujourd'hui + à venir) — `reservations_view`
Jauge « **X / Y véhicules disponibles** » + barre de progression + **liste nominative des
indisponibles** avec leur motif : `Immobilisé — <titre de l'événement>` ou `Réservé — 08:00 → 12:00`.
Un véhicule immobilisé **et** réservé n'apparaît qu'une fois (l'immobilisation est la raison la
plus forte).

> Le calcul de fin effective de blocage passe par `effectiveBlockingEndMs`, **la même fonction
> partagée que le back** : ce qui s'affiche « libre » ici est exactement ce que la réservation
> acceptera. Pas de « libre » suivi d'un 409.

### 6.2 Usage prévu (aujourd'hui + à venir) — `reservations_view`
Pour chaque véhicule : plaque, **créneau habituel** (`07:40 → 09:15`), **barre de confiance**
colorée et **la base observée** (« les lundis, 6 semaines sur 10 »). Annoncé comme **indicatif** :
*« n'empêche pas de réserver »*.

### 6.3 Utilisation réelle (jours passés) — `reservations_view`
Par véhicule : **nombre de trajets** + **kilomètres**, triés par distance décroissante. Si une
prévision existait pour ce jour, un chip compare : **`prévu 4 · réel 3`**.

### 6.4 Réservations & événements (tous les jours)
Une carte par événement chevauchant le jour, tous types confondus (le filtre de type de la barre
**ne s'applique pas ici** — une réservation ne doit pas disparaître parce qu'on filtre « Incident »).
Chaque carte porte : type, badge **Immobilisé** le cas échéant, statut, titre, plaque cliquable vers
la fiche véhicule, horaires, kilométrage, description, motif de réservation.

**Actions en ligne**, selon le droit et le type :
- maintenance/incident (`agenda_manage`) : **En cours**, **Terminé**, **Supprimer** ;
- réservation (`agenda_manage`) : **Éditer**, **Annuler** ;
- sinon : « Réservation gérée par un gestionnaire ».

**Pied de panneau** : bouton **« Réserver ce jour »** (`reservations_request`) qui ouvre la feuille
de réservation **pré-datée sur ce jour à 09:00**.

---

## 7. Liste « À venir & en retard »

Sous le calendrier. Les événements `PLANNED`/`OPEN`/`IN_PROGRESS` du périmètre filtré, triés par
échéance, **plafonnés à 25**. Chaque ligne : barre de couleur d'**urgence** (en retard / < 7 j /
normal), icône de type, titre, plaque cliquable, type, sévérité, date courte et **badge d'urgence**.
Cliquer ouvre le panneau du jour concerné.

---

## 8. Modale « Nouvel événement » — maintenance & incident (`agenda_manage`)

`POST /api/agenda/events`. Champs :

| Champ | Détail |
|---|---|
| **Type** | segment Maintenance / Incident |
| **Véhicule** | liste du parc accessible |
| **Titre** | placeholder adapté au type (« Vidange + filtres » / « Pare-brise fissuré ») |
| **Catégorie** | texte libre (« Révision », « Carrosserie ») |
| **Sévérité** | *incidents seulement* — Faible / Moyenne / Critique |
| **Date + heure** | avec case **« Toute la journée »** qui masque l'heure |
| **Immobilise le véhicule** | ☑️ **le champ le plus lourd de la modale** : tant que l'événement n'est pas terminé, le véhicule **sort des réservations et des suggestions IA**. La note sous la case le dit en toutes lettres |
| **Kilométrage** | **pré-rempli par estimation** : dernier relevé + distance GPS parcourue depuis (`GET /agenda/vehicles/:id/odometer`), avec un libellé qui dit d'où vient le chiffre |
| **Description** | texte libre |

Il existe aussi un endpoint **`POST /api/agenda/incidents`** (signalement rapide, statut `OPEN`)
accessible dès `agenda_view` — c'est-à-dire **qu'un simple lecteur peut signaler un incident sans
pouvoir gérer l'agenda**.

---

## 9. Feuille « Réservations » — 3 modes dans un seul écran

[reservation-sheet.component.ts](../../apps/web/src/app/features/agenda/sheets/reservation-sheet.component.ts)

### 9.1 Mode **Demander**
- **Créneau** via un sélecteur date+heure de début et de fin dédié.
- **Case « Réservation déjà effectuée (non enregistrée) »** — consignation **rétroactive** : elle
  débloque les dates passées pour enregistrer une sortie qui a déjà eu lieu. Sans elle, le passé
  est refusé côté client **et** revalidé côté serveur.
- **Critères** : places minimum, sièges-enfant minimum.
- **Motif** (texte libre, ex. « Ramassage scolaire secteur nord »).
- **Véhicule** : `Auto (le 1er disponible conforme)` ou choix explicite.
  - **Gestion de la dormance** : un véhicule dont le boîtier est **muet depuis > 7 jours** reste
    **listé** (le masquer laisserait croire à une sortie de parc) mais est **grisé**, avec son
    silence **daté** (« boîtier muet depuis 12 j »). Une phrase explique qu'ils *« redeviennent
    sélectionnables d'eux-mêmes dès la première trame reçue »*. Deux exceptions volontaires : le
    véhicule déjà sélectionné en édition, et le mode rétroactif.
- **« Suggérer avec l'IA »** (`ai_optimize` + fonction `placement`) :
  - loader explicatif chiffré (« Analyse en cours… 10–30 s ») qui dit **ce que l'IA compare**
    (places, énergie, coût au km) ;
  - **classement de propositions** : rang, plaque, **score en %** coloré, **raisonnement en clair**,
    places / sièges-enfant / énergie / **≈ €/km** ;
  - la n°1 est **pré-sélectionnée** ;
  - **transparence sur les écartés d'office** : « N immobilisé(s) · N sans capacité renseignée » ;
  - **coût € de l'analyse affiché** après coup.
- Bouton final qui change de mot selon le droit : **« Réserver »** (gestionnaire, `CONFIRMED` direct)
  ou **« Déposer la demande »** (`REQUESTED`).
- **Garde super-admin** : sans société choisie dans le sélecteur global, réserver mélangerait les
  flottes → la feuille le dit et bloque.

### 9.2 Mode **À valider** (`reservations_manage`)
File des demandes `REQUESTED` : plaque, créneau, titre, et — si la demande vient d'un **lien public**
— **le nom du demandeur, son contact et le nombre de places demandées**. Deux boutons : **Valider**
(`CONFIRMED`) / **Refuser** (`CANCELLED`).

### 9.3 Mode **Éditer**
Ouvert depuis une carte du panneau jour. Re-hydrate créneau, véhicule, motif, critères et l'état
rétroactif depuis les métadonnées de la réservation. Deux actions : **Enregistrer** /
**Annuler la réservation**.

---

## 10. Feuille « Optimisation »

[optimization-sheet.component.ts](../../apps/web/src/app/features/agenda/sheets/optimization-sheet.component.ts)

1. **Hero agent IA** — masqué si l'IA est coupée pour la flotte ; remplacé alors par une note qui
   précise que **les mutualisations déterministes, elles, restent disponibles**.
2. **Sélecteur de flotte** (super-admin).
3. **Métier de la flotte** — `Transport d'enfants · Colis · Location · Générique`, modifiable par
   un admin. Une ligne dit à quoi ça sert : *« enfants → places/sièges-enfant · colis → charge ·
   location → disponibilité »*.
4. **Compléter les capacités (IA)** — l'IA déduit **places et sièges-enfant par modèle** de
   véhicule (« Jumpy/Expert : 9 ou 2 »). Résultats en cartes avec **indice de confiance** et
   raisonnement, **sélection multiple** (« tout sélectionner », compteur `3/12`) puis
   **« Appliquer (3) »** qui écrit sur les véhicules. Sans `vehicles_edit` : **consultation seule**,
   annoncée comme telle. **L'analyse tourne en arrière-plan** (la feuille se ferme, la pastille du
   § 3 prend le relais) avec **garde anti-double-lancement**.
5. **Opportunités de mutualisation** — *déterministe, jamais masqué par l'IA*. Les véhicules dont
   l'utilisation est **< 12 % des heures sur 28 jours**, avec leurs **créneaux libres récurrents**
   (« Libre Mardi après-midi »), 12 au maximum.
6. **« Comment ça marche »** en 3 étapes, avec la promesse écrite : **« Jamais d'action automatique. »**

---

## 11. Feuille « ⚙️ Paramètres de l'agenda » (agent IA) — `SUPER_ADMIN` / `FLEET_ADMIN`

[agenda-agent-settings-sheet.component.ts](../../apps/web/src/app/features/agenda/sheets/agenda-agent-settings-sheet.component.ts)

| Réglage | Détail |
|---|---|
| **Interrupteur maître « Assistance IA »** | Toute l'IA de la société. Un **super-admin** peut l'**offrir** (bascule → `COMP` via `/api/billing/comp`) ; un fleet-admin voit à la place un lien **« Gérer / Activer »** vers sa facturation. Texte honnête : *« l'app fonctionne parfaitement sans IA »* |
| **Activer l'agent IA** | Sous-ensemble du maître. L'agent détecte les habitudes, **l'IA les relit ensuite depuis le poste (06:30 / 14:30)** |
| **Métier de la flotte** | Même réglage qu'au § 10 |
| **Heure d'analyse nocturne** | 0–23 |
| **Fréquence** | Quotidienne / Hebdomadaire |
| **Niveau d'autonomie** | **Suggestions seules** *ou* **Auto si confiance haute** — avec, dans ce cas, un **curseur de seuil 50→100 %** : au-dessus, l'agent **réserve fermement** ; en dessous, il propose |
| **Auto-complétion après réservation** | Quand quelqu'un réserve, l'IA optimise autour |
| **Déclencheurs de (re)analyse** | 4 cases : **nocturne**, **à un incident**, **à une maintenance**, **à une réservation** |
| **Coûts IA du mois** | `≈ X,XX €` + **répartition par action** (top 4) + lien vers `/admin/ai-usage` |
| **Liens publics de réservation** | **Créer** un lien (URL copiée automatiquement), **copier**, **activer/désactiver**, avec le **compteur d'ouvertures**. Un tiers décrit son besoin sur une page publique (`/reserve/:token`), l'app propose des véhicules, la demande **atterrit dans « Demandes »** |
| **Derniers passages** | Historique de l'agent : date, **manuel/auto**, badge **IA**, durée, et le bilan `N habitudes · N réservées · N proposées · N ignorées`. Cas d'échec et cas « aucune habitude détectée » sont **écrits en clair** — c'est ce qui explique un « il ne fait rien » |
| **Lancer l'analyse** | Passage manuel. **Grisé sur la valeur enregistrée** de l'interrupteur (le serveur répond 409 si l'agent est coupé — *« un interrupteur qu'un bouton contourne n'est pas un interrupteur »*), garde anti-double-tap, et **résumé honnête** dans la pastille : distingue « déjà en cours », « rien à proposer » et « aucun avis IA attendu » |

---

## 12. Feuille « Propositions de l'agent »

[agenda-agent-proposals-sheet.component.ts](../../apps/web/src/app/features/agenda/sheets/agenda-agent-proposals-sheet.component.ts)

Une carte par proposition en attente : **plaque**, **confiance en %**, **créneau en toutes lettres**
(`lundi 8 sept · 08:00 → 12:00`), **destination géocodée**, et **le pourquoi vulgarisé**
(« observé 6 lundis sur les 10 dernières semaines »).

**Avis de l'IA** : affiché **seulement quand il a été rendu** (`Avis IA du 08/09 14:32 : conservée`).
La carte ne dit **rien** sinon — délibérément : 339 propositions antérieures à la bascule n'auront
jamais d'avis, et promettre un avis qui ne viendra pas ferait passer un stock ancien pour une chaîne
en panne.

Actions (`reservations_manage`) : **Réserver** (crée la réservation ferme) / **Refuser**.

---

## 13. L'onglet **Missions** (segment « Mission », ou vue par défaut sans `agenda_view`)

[missions-panel.component.ts](../../apps/web/src/app/features/agenda/missions-panel.component.ts)
— décision client : **la mission vit dans l'agenda**, pas dans une page à part, *« sinon on
dupliquerait le calendrier, les filtres et la gestion des conflits »*.

### 13.1 Les 5 compteurs (calculés **côté serveur**, pas sur la page filtrée)
`En cours` · `Planifiées` · `En retard` (encadré rouge si > 0) · **`Véhicules indisponibles`** ·
`Dépôts destinataires`.

> Le 4ᵉ est le lien visible avec la disponibilité de la flotte : *« sans lui, un gestionnaire ne
> comprend pas pourquoi il ne lui reste plus rien à réserver »*.

### 13.2 Filtres et liste
- Filtres : `Toutes · En cours · Planifiées · Terminées`.
- **Desktop** : tableau 7 colonnes (Réf., Trajet + conducteur, Créneau, Véhicule, Dépôt
  destinataire, Statut, action) qui **défile dans son conteneur**, jamais la page.
- **Mobile** : **cartes**, pas un tableau — même donnée, empilée, hauteur minimale à la densité de
  la plateforme.
- Le trajet s'écrit `Fenouillet → Muret` et, s'il y a des étapes, **`… (3 livraisons)`** — la tournée
  n'est pas déroulée dans la liste, qui sert à *retrouver* une mission.
- **Mission interne** (sans dépôt) : dit explicitement, jamais une case vide.
- **Une panne se DIT** et se distingue d'une liste vide : le message du serveur passe en premier
  (« Aucune flotte associée » ≠ « Vous n'avez pas l'autorisation »), avec un bouton **Réessayer**.

### 13.3 Modale « Nouvelle mission »
[mission-dialog.component.ts](../../apps/web/src/app/features/agenda/mission-dialog/mission-dialog.component.ts)

- **Point de départ**, **Destination**.
- **Livraisons intermédiaires** — bloc replié par défaut, avec **ajout, réordonnancement ↑ ↓ et
  suppression** ; une aide dit l'ordre de passage réel et que *« le dépôt destinataire verra la
  tournée complète »*.
- **Date, heure de début, heure de fin** — les deux heures portent un **liseré accent** : ce sont
  elles qui bornent l'accès du tiers.
- **Véhicule** — les occupés sont **affichés et grisés avec leur motif**, jamais masqués.
- **Gestion du conflit à deux niveaux** :
  - *niveau 1* : le véhicule choisi est déjà pris → « **X porte déjà la mission M-123, de 08:00 à
    12:00** » ;
  - *niveau 2* : **toute la flotte est prise** → liste des véhicules bloqués avec leur motif, **+ le
    prochain créneau réellement calculé** et un bouton **« Décaler à 14:30 »**. Si rien ne se dégage
    sous 14 jours, c'est dit.
- **Dépôt destinataire** (facultatif) et, dès qu'il est choisi, **la ligne de périmètre** : *« le
  dépôt verra la position du camion de 08:00 à 12:00 uniquement, puis le trajet passera dans son
  historique »*.
- **Notes internes** (explicitement *non transmises au dépôt*).
- **Le bloc de conséquence**, avant de valider — trois effets invisibles rendus visibles :
  un événement `Mission` se pose dans l'agenda · le véhicule **sort des créneaux réservables** ·
  le dépôt **reçoit un e-mail** (ou : « aucun tiers n'est notifié »).

### 13.4 Modale « Modifier la tournée »
[mission-stops-modal.component.ts](../../apps/web/src/app/features/agenda/mission-stops-modal.component.ts)

- **Chargement** (1ᵉʳ arrêt) + **livraisons numérotées**, avec réordonnancement et suppression.
- **Distance retenue** et **prix recalculé** : *« trois livraisons de plus et la mission vaut 169 €
  au lieu de 79 € »* — l'écart est affiché **avant** d'enregistrer.
- **Motif OBLIGATOIRE** (il ne l'est pas à la création : il n'y a rien à justifier ; il l'est ici).
- **Journal des révisions** : auteur, rôle, motif, arrêts, distance, montant **et montant
  précédent**, horodaté — *« ce qui permet de répondre six mois plus tard à "pourquoi cette
  facture" »*.
- Le bouton disparaît sur une mission `DONE`/`CANCELLED` : le serveur refuse de réécrire un trajet
  qui a eu lieu, l'écran ne propose donc pas le geste.

---

## 14. Les moteurs serveur — ce qui tourne **derrière** l'agenda

| Service | Rôle |
|---|---|
| [`VehicleEventsService`](../../apps/api/src/agenda/vehicle-events.service.ts) | CRUD des événements, compteurs, **estimation d'odomètre** (relevé + GPS), scoping tenant strict anti-IDOR. Émet le déclencheur `agenda-agent.trigger` sur incident/maintenance |
| [`MaintenancePlansService`](../../apps/api/src/agenda/maintenance-plans.service.ts) | **Plans d'entretien récurrents** (« CT tous les 12 mois », « vidange tous les 15 000 km »). Chaque plan **matérialise** un événement `PLANNED` idempotent dans l'agenda. ⚠️ **Ces plans se créent depuis l'onglet Maintenance de la fiche véhicule**, pas depuis `/agenda` — mais leurs échéances **s'affichent dans l'agenda** |
| [`MaintenanceReminderService`](../../apps/api/src/agenda/maintenance-reminder.service.ts) | **Cron quotidien 07:00** : re-matérialise les échéances et **notifie les fleet-admins en web-push** quand une échéance entre dans son préavis — **une seule fois par échéance**. Verrou anti-chevauchement |
| [`ReservationsService`](../../apps/api/src/agenda/reservations.service.ts) | Flux demande → validation, **détection de conflits** (pré-check 409 **+ contrainte `EXCLUDE` en base, race-proof**). Un **trajet ouvert** (sans fin connue) bloque les créneaux **proches** (≤ 8 h) mais pas ceux de la semaine prochaine |
| [`ForecastService`](../../apps/api/src/agenda/forecast.service.ts) | **Moteur de prévision d'usage** : sur **10 semaines** d'historique, par véhicule × jour de la semaine, retient un créneau observé **≥ 4 semaines** et le projette. Micro-trajets (< 300 m ou < 2 min) exclus. **Aucune écriture, jamais bloquant** |
| [`FleetInsightsService`](../../apps/api/src/agenda/fleet-insights.service.ts) | **Activité réelle** et **heatmap d'utilisation** sur 28 j, détection des **sous-utilisés** (< 12 %) et de leurs **créneaux libres récurrents** (≤ 5 % d'occupation, ≥ 2 occurrences) |
| [`RecurrenceDetectorService`](../../apps/api/src/agenda/recurrence-detector.service.ts) | Détecte les **trajets récurrents** véhicule × jour × destination, **géocode** le lieu (Nominatim), dérive le **vrai itinéraire** et les **géofences traversées**. **Récence 3 semaines** : une tournée arrêtée ne ressuscite pas |
| [`TripStopDetectorService`](../../apps/api/src/agenda/trip-stop-detector.service.ts) | Dérive les **arrêts significatifs** d'un trajet (rayon 130 m, ≥ 4 min, < 4 km/h) — parce que le point d'arrivée d'une flotte qui rentre au dépôt est **toujours le dépôt**, ce qui n'apprend rien |
| [`AgendaAgentRunnerService`](../../apps/api/src/agenda/agenda-agent-runner.service.ts) | **L'agent lui-même**. **Cron horaire** : chaque flotte activée part à **son** heure. Projette sur **14 jours**, jamais dans l'heure qui vient. Selon l'autonomie : propositions `pending` **ou réservations fermes** au-dessus du seuil. **Aucun appel LLM ici** — le jugement de l'IA est **enfilé dans la file du poste** et rendu au passage de 06:30 / 14:30 (coût API automatique = **0 €**, décision après l'incident TRK-061). Le même cron **expire** les propositions dont le créneau est passé |

---

## 15. Comportements transverses de la page

- **Touche `Échap`** en cascade : ferme d'abord la modale de création, puis le panneau jour, puis
  les menus déroulants.
- **Verrou de défilement** du corps quand une feuille est ouverte.
- **Changement de société** (sélecteur global) : rechargement complet, mais **pas au premier rendu**
  (garde `initialised`) pour ne pas doubler les appels.
- **Échecs silencieux assumés** sur les couches d'analyse : l'agenda reste utilisable si l'activité
  ou la prévision ne répond pas.
- **Aucune couleur en dur** pour le texte : jetons `--texte-*` qui basculent clair/sombre (les
  hexadécimaux vifs rendaient 2,1:1 en thème clair).

---

## 16. Matrice des permissions

| Permission | Ce qu'elle ouvre dans l'agenda |
|---|---|
| `agenda_view` | **La grille du calendrier**, les 3 compteurs, la liste « à venir », la barre de filtres, le panneau jour, **et le signalement d'incident** |
| `agenda_manage` | Créer/modifier/supprimer un événement, changer un statut, éditer/annuler une réservation depuis le panneau jour, gérer les plans d'entretien |
| `reservations_view` | Les **couches d'analyse** (disponibilité, usage prévu, utilisation réelle), la feuille Optimisation, **lire** les propositions et l'historique de l'agent |
| `reservations_request` | Bouton **Réserver**, « Réserver ce jour », déposer une demande |
| `reservations_manage` | Mode **À valider**, valider/refuser une demande, valider/refuser une proposition, **lancer l'agent** |
| `missions_view` | **Entrer sur la page** et voir l'onglet Missions |
| `missions_manage` | Créer une mission, modifier une tournée |
| `ai_optimize` | Bouton « Suggérer avec l'IA » (combiné à la fonction `placement`) |
| `vehicles_edit` | **Appliquer** les capacités proposées par l'IA |
| rôle `SUPER_ADMIN` / `FLEET_ADMIN` | ⚙️ Paramètres de l'agenda, interrupteur maître IA, métier de la flotte |

À quoi s'ajoutent les **kill-switches IA par fonction** (`capacity`, `placement`, `agendaAgent`) :
couper l'IA masque les entrées correspondantes **sans enfermer** ce qui a déjà été produit.

---

## 17. ❌ Ce qui n'est **pas** dans la page Agenda

| Fonctionnalité | Où elle est réellement |
|---|---|
| **Plannings d'installation** | `/admin/installations` (liste), `/admin/installations/:id` (éditeur), `/installations` (vue client : consultation + réordonnancement du sens d'installation), `/admin/installation-bookings` (réservations de créneaux), `/book/:token` (prise de RDV publique). **Feature `installations/` distincte, zéro référence à l'agenda dans le code** |
| **Création des plans d'entretien récurrents** | Fiche véhicule → onglet **Maintenance** ([vehicle-maintenance-tab.component.ts](../../apps/web/src/app/features/vehicles/vehicle-maintenance-tab.component.ts)). Leurs **échéances**, elles, apparaissent bien dans l'agenda |
| **Page Missions `/missions`** | Écran séparé qui porte la **grille tarifaire** et les **demandes/devis** des transporteurs. L'onglet Missions de l'agenda est l'**exploitation** des missions, pas leur commerce |
| **Demande de réservation publique** | `/reserve/:token` — page publique hors auth, alimentée par les liens créés au § 11 ; ses demandes **reviennent** dans « Demandes » |
| **Centre Coûts IA** | `/admin/ai-usage` — lié depuis les paramètres de l'agenda |

---

## 18. Compte rendu chiffré (mesuré, pas estimé)

| Mesure | Valeur | Comment elle est obtenue |
|---|---|---|
| Code front de la page | **6 518 lignes** | 10 composants + `agenda.utils.ts`, hors specs (`wc -l` sur `features/agenda/`) |
| Clients HTTP dédiés | **273 lignes** | `agenda.service.ts` (213) + `agenda-agent.service.ts` (60) |
| Code serveur du module agenda | **4 482 lignes** | 5 contrôleurs + 11 services, hors `.spec.ts` |
| Endpoints du module agenda | **28** | 12 `/agenda/*` + 6 `/reservations/*` + 3 (availability, utilization, forecast) + 5 agent + 2 agent-settings |
| Endpoints missions consommés par l'onglet | **6** | liste, création, dépôts, disponibilité véhicule, `PATCH :id/stops`, `GET :id/stop-revisions` |
| Surfaces d'interface | **8** | en-tête · grille · panneau jour · 4 feuilles · onglet missions (+ ses 2 modales) |
| Crons qui alimentent la page | **2** | rappels de maintenance (07:00 quotidien) ; agent d'agenda (horaire) |
