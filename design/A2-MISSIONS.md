# A2 — Les missions

## Le besoin

Aujourd'hui l'application connaît des **trajets** (`Trip`), détectés a posteriori depuis les positions. Elle ne connaît pas d'intention : personne ne déclare « ce camion part à 8h15 livrer Muret pour le dépôt de Fenouillet ».

La mission est cette déclaration. Elle est le pivot de tout le bloc A : c'est elle qui ouvre l'accès au dépôt, et sa fenêtre horaire qui le referme.

**Décision client : la mission vit dans l'agenda, pas dans une page à part.** Un troisième onglet à côté de Mois et Échéances. Créer une page « Missions » séparée dupliquerait le calendrier, les filtres et la gestion des conflits.

---

## Pages concernées

| Élément | Fichier | Action |
|---|---|---|
| Modèle | `apps/api/prisma/schema.prisma` | Créer `Mission` |
| Module API | `apps/api/src/missions/` | Créer |
| DTO partagés | `packages/shared/src/dto/mission.dto.ts` | Créer |
| Page agenda | `apps/web/src/app/features/agenda/agenda.component.ts` | Modifier — 3ᵉ onglet |
| Modale création | `features/agenda/mission-dialog/` | Créer |
| Disponibilité véhicule | `reservation-booking.service.ts` | Étendre |

Maquettes : `Agenda Refonte.dc.html` § 05 (liste), § 06 (création, conflit, iOS, Android).

---

## 1. Le modèle

```prisma
model Mission {
  id              String        @id @default(uuid()) @db.Uuid
  /// Référence lisible, séquence par flotte : "M-2481"
  ref             String
  fleetId         String        @db.Uuid
  fleet           Fleet         @relation(fields: [fleetId], references: [id], onDelete: Cascade)

  /// Origine et destination : soit un lieu clé, soit une adresse libre.
  originPlaceId   String?       @db.Uuid
  originLabel     String
  destPlaceId     String?       @db.Uuid
  destLabel       String

  /// La fenêtre. C'est elle qui borne l'accès du dépôt.
  startAt         DateTime
  endAt           DateTime

  vehicleId       String        @db.Uuid
  vehicle         Vehicle       @relation(fields: [vehicleId], references: [id], onDelete: Restrict)
  driverId        String?       @db.Uuid
  driver          Driver?       @relation(fields: [driverId], references: [id], onDelete: SetNull)

  /// Le compte DEPOT destinataire. Null = mission interne, invisible d'un dépôt.
  depotUserId     String?       @db.Uuid
  depotUser       User?         @relation("MissionDepot", fields: [depotUserId], references: [id], onDelete: SetNull)

  status          MissionStatus @default(PLANNED)
  /// Horodatages réels, alimentés par la détection de position.
  actualStartAt   DateTime?
  actualEndAt     DateTime?
  /// Trajet(s) rattachés une fois la mission terminée.
  trips           Trip[]        @relation("TripMission")
  shareLinks      MissionShareLink[]

  notes           String?
  createdByUserId String?       @db.Uuid
  cancelledAt     DateTime?
  cancelReason    String?
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt

  @@unique([fleetId, ref])
  @@index([fleetId, startAt])
  @@index([depotUserId, startAt])
  @@index([vehicleId, startAt, endAt])
  @@map("missions")
}

enum MissionStatus {
  PLANNED
  IN_PROGRESS
  LATE
  DONE
  CANCELLED
}
```

Ajouter sur `Trip` : `missionId String? @db.Uuid` + relation `"TripMission"`.

### La référence `ref`

Séquence par flotte, format `M-NNNN`. Générée en transaction (`SELECT max ... FOR UPDATE` ou séquence dédiée) — deux missions créées simultanément ne doivent pas recevoir la même référence. La contrainte `@@unique([fleetId, ref])` est le filet.

---

## 2. Le statut est dérivé, jamais saisi

Aucun bouton « passer en cours ». Le statut est calculé, ce qui évite les états menteurs.

| Statut | Condition de bascule | Qui l'écrit |
|---|---|---|
| `PLANNED` | À la création | Service |
| `IN_PROGRESS` | Première position détectée après `startAt - 15 min` | Tâche de fond / listener de position |
| `LATE` | `now > endAt` **et** véhicule pas encore arrivé à destination | Tâche de fond (toutes les minutes) |
| `DONE` | Arrivée détectée à destination, **ou** clôture manuelle | Détection / gestionnaire |
| `CANCELLED` | Annulation explicite avec motif | Gestionnaire |

**Retard : deux nuances à distinguer.** `LATE` signifie « dépassé l'heure de fin prévue ». Le champ `delayMinutes` du DTO se calcule à la volée : `now - endAt` si en cours, `actualEndAt - endAt` si terminée. Ne pas stocker le retard — il change à chaque minute.

**`LATE` n'interrompt pas le suivi.** Une mission en retard est précisément le moment où le dépôt a le plus besoin de voir le camion. La fenêtre d'accès s'étend jusqu'à `DONE` ou clôture.

---

## 3. Les 4 effets de bord à la création

C'est le cœur de la fonctionnalité. Créer une mission n'écrit pas seulement une ligne.

### 3.1 — Un événement dans l'agenda

Un événement de type `MISSION` posé sur `startAt`, visible dans la grille du mois avec sa pastille de couleur. Cliquer dessus ouvre la mission, pas un formulaire d'événement.

Réutiliser le modèle d'événements d'agenda existant plutôt que d'afficher les missions en parallèle : le gestionnaire doit voir maintenance, incidents, réservations et missions sur le même calendrier, sinon il double-réserve.

### 3.2 — Le véhicule devient indisponible

Sur `[startAt, endAt]`, le véhicule sort :

- des créneaux réservables dans `/agenda` → Réserver
- des véhicules proposés par `/reserve/:token` (« Demander un véhicule »)
- des suggestions de l'agent IA d'agenda

**Réutiliser le mécanisme d'indisponibilité des réservations**, ne pas en créer un second. Concrètement : la fonction qui liste les véhicules disponibles sur un créneau interroge désormais aussi `Mission` (`status NOT IN (DONE, CANCELLED)`).

Deux sources d'indisponibilité, une seule logique de lecture. Si deux mécanismes coexistent, un véhicule sera un jour réservé pendant une mission.

### 3.3 — Le dépôt est notifié

E-mail transactionnel + notification push si le dépôt en a. Réutiliser `email.service.ts` et les préférences de `notification-preference.dto.ts`.

Nouveau gabarit `mission_assigned` : référence, trajet, créneau, plaque, et le lien vers `/depot`. Le sujet porte l'information — « Livraison prévue jeudi 08:15 → 11:40 », pas « Nouvelle mission ».

### 3.4 — Le conducteur voit sa mission

Dans `/driver`, la mission apparaît sur la fiche du véhicule : destination, créneau, et la mention « ce dépôt suit votre position pendant la mission ».

⚠️ **Obligation d'information.** Le conducteur doit savoir qu'un tiers voit sa position. Ce n'est pas une politesse, c'est la condition de conformité du dispositif. À traiter dans le même lot, pas plus tard.

---

## 4. Le conflit de créneau

### La règle

Un véhicule ne peut porter deux missions qui se chevauchent. Refus côté API, avec le détail du conflit.

```ts
// 409 Conflict
{
  code: 'MISSION_SLOT_CONFLICT',
  vehiclePlate: 'FR-119-TD',
  conflictingMission: { ref: 'M-2482', startAt: '...', endAt: '...' }
}
```

### Les deux niveaux d'interface

**Niveau 1 — un véhicule occupé, d'autres libres.** Dans la modale de création, le véhicule apparaît grisé avec son motif : « Déjà en mission M-2482 · 09:00 → 12:20 ». Le gestionnaire en choisit un autre. Pas d'erreur, pas de modale.

**Niveau 2 — aucun véhicule libre.** Modale « Créneau indisponible » (maquette `Agenda Refonte` § 06) : la liste des véhicules bloqués avec leur mission, puis **le prochain créneau libre calculé** sur le même véhicule et la même durée, avec un bouton « Décaler à 12:30 ».

Proposer une sortie plutôt qu'annoncer un échec. Un gestionnaire qui reçoit « aucun véhicule disponible » sans alternative rouvre le formulaire cinq fois.

### Autres validations à la création

| Règle | Message |
|---|---|
| `endAt > startAt` | « L'heure de fin doit suivre l'heure de départ » |
| Durée ≥ 15 min | « Une mission dure au moins 15 minutes » |
| Durée ≤ 24 h | « Au-delà de 24 h, créez plusieurs missions » |
| `startAt` pas plus de 90 j dans le futur | « Trop loin dans le temps » |
| Le véhicule appartient à la flotte | `403` |
| Le `depotUserId` est un `DEPOT` de la même flotte | `400` |
| Le véhicule a un boîtier installé | Avertissement non bloquant : « Ce véhicule n'a pas encore de boîtier : le dépôt ne verra pas sa position » |

Ce dernier cas mérite l'avertissement plutôt que le refus : on peut planifier une mission avant l'installation.

---

## 5. La modale de création

Maquette : `Agenda Refonte.dc.html` § 06.

| Champ | Type | Défaut | Note |
|---|---|---|---|
| Point de départ | Lieu clé ou adresse | Dernier utilisé | Autocomplete sur `FleetPlace` |
| Destination | Lieu clé ou adresse | — | idem |
| Date | Date | Aujourd'hui | |
| Heure de départ | Heure | 08:00 | Liseré accent — c'est le champ qui borne l'accès |
| Heure de fin | Heure | +3 h | idem |
| Véhicule | Liste filtrée | — | Les occupés sont **visibles et grisés**, avec leur motif |
| Conducteur | Liste | Affecté au véhicule | Facultatif |
| Dépôt destinataire | Liste des `DEPOT` de la flotte | — | Facultatif : sans lui, mission interne |
| Notes | Texte | — | Non transmis au dépôt |

**Le bloc de conséquence, sous les champs.** Avant de valider, on écrit ce qui va se passer :

> À l'enregistrement : un événement **Mission** est posé le 14 mai dans l'agenda, `FR-482-BX` devient indisponible de 08:15 à 11:40, et Claire Vasseur reçoit une notification.

Trois effets invisibles rendus visibles. C'est ce qui évite le « je ne savais pas que ça bloquait le véhicule ».

**Sous le champ dépôt**, une ligne qui dit le périmètre :

> Le dépôt verra la position du camion de 08:15 à 11:40 uniquement, puis le trajet passera dans son historique.

---

## 6. La liste des missions

Onglet Missions de `/agenda`. Maquette § 05.

**Colonnes** : Réf. · Trajet · Créneau · Véhicule · Dépôt destinataire · Statut · actions.

**Filtres** : Toutes / En cours / Planifiées / Terminées, plus un sélecteur de dépôt.

**5 compteurs en tête** : En cours · Planifiées · En retard · Véhicules indisponibles · Dépôts destinataires.

Le compteur « Véhicules indisponibles » est le lien avec la 3.2 : il rend visible le coût des missions sur la disponibilité de la flotte.

**Modification.** Une mission `PLANNED` est entièrement modifiable. Une mission `IN_PROGRESS` : seuls `endAt`, le conducteur et les notes. Une mission `DONE` : rien, sauf les notes.

Changer `endAt` d'une mission en cours **étend ou réduit la fenêtre d'accès du dépôt** — le dire dans la confirmation.

**Annulation.** Motif obligatoire. Le dépôt est notifié. La mission reste dans son historique avec la mention « Annulée par le transporteur ».

---

## 7. Modèles de tournée

Une mission récurrente (même trajet, même créneau, tous les jours ouvrés) se saisit une fois.

Bouton « Modèles de tournée » dans la barre d'outils, et « Enregistrer comme modèle » dans la modale.

Un modèle porte : origine, destination, durée, véhicule préféré, dépôt destinataire, récurrence (jours de la semaine). Il **génère des missions**, il n'en est pas une : chaque occurrence est une `Mission` autonome, modifiable et annulable individuellement.

Génération glissante sur 14 jours, par tâche de fond quotidienne. Un modèle désactivé cesse de générer, sans toucher aux missions déjà créées.

*Ce point peut être livré après A4 si le calendrier presse — il n'est bloquant pour rien.*

---

## 8. États et cas particuliers

| Cas | Comportement |
|---|---|
| Mission créée sans dépôt | Valide. Mission interne, aucun tiers ne la voit |
| Dépôt supprimé après création | `onDelete: SetNull` → la mission devient interne. Signalé au gestionnaire |
| Véhicule supprimé | `onDelete: Restrict` → refus tant qu'une mission non terminée existe |
| Conducteur retiré du véhicule | La mission garde le conducteur historique |
| Mission jamais démarrée (aucune position) | Reste `PLANNED`. À `endAt + 4 h`, bascule `DONE` avec `actualStartAt = null` et la mention « Aucun déplacement détecté » |
| Véhicule en panne de boîtier pendant la mission | `IN_PROGRESS` maintenu, position « indisponible depuis N min » |
| Mission qui déborde sur le lendemain | Autorisé (≤ 24 h). Affichée sur les deux jours de l'agenda |
| Deux dépôts sur une même mission | Non supporté. Un seul `depotUserId`. Si le besoin apparaît : deux missions |
| Modification du créneau pendant la mission | Autorisée sur `endAt` seulement, avec confirmation explicite de l'impact sur le suivi |

---

## 9. Impacts

### Backend

- Migration Prisma : `Mission`, `MissionStatus`, `Trip.missionId`, `UserRole.DEPOT`
- Module `missions` : contrôleur, service, DTO, tests
- Tâche de fond : bascule des statuts (toutes les minutes)
- Listener de position : détection de départ et d'arrivée
- Extension de la disponibilité véhicule (réservations + agenda IA)
- Nouveau gabarit e-mail `mission_assigned`

### Frontend

- 3ᵉ onglet dans `/agenda`, avec sa liste, ses filtres et ses compteurs
- Modale de création + modale de conflit
- Déclinaisons iOS (feuille) et Android (liste M3 + FAB)
- Fiche véhicule : bandeau « en mission » quand `IN_PROGRESS`
- `/driver` : la mission du jour et la mention d'information

---

## 10. Critères de recette

| # | Scénario | Attendu |
|---|---|---|
| 1 | Créer une mission | Événement d'agenda visible le bon jour |
| 2 | Créer une mission | Le véhicule n'apparaît plus dans « Réserver » sur ce créneau |
| 3 | Créer une mission | Le véhicule n'apparaît plus dans `/reserve/:token` |
| 4 | Créer une mission avec dépôt | Le dépôt reçoit l'e-mail, la mission apparaît dans `/depot` |
| 5 | Créer une mission en conflit | `409` + détail de la mission bloquante |
| 6 | Aucun véhicule libre | Modale avec le prochain créneau proposé |
| 7 | Première position après `startAt` | Statut → `IN_PROGRESS` |
| 8 | `now > endAt` sans arrivée | Statut → `LATE`, suivi maintenu |
| 9 | Arrivée détectée | Statut → `DONE`, position plus servie au dépôt |
| 10 | Annuler une mission | Véhicule libéré, dépôt notifié |
| 11 | Deux missions simultanées, même flotte | Références distinctes |
| 12 | Supprimer un véhicule avec mission active | Refus explicite |
