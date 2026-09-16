# Réservations d'installation & plannings — analyse et propositions (16/09/2026)

> **PROPOSITION — rien n'est codé.** Le propriétaire a demandé le 16/09 une relecture complète du système
> de réservation (liens publics `/book/:token`) et des plannings d'installation, avec carte blanche pour
> proposer — et l'interdiction de faire quoi que ce soit sans plan validé. Ce document est ce plan.
> Chaque point est un **constat lu dans le code** (fichier cité), suivi d'une proposition et d'un effort.

Lecture faite sur `main` `50826b77` (= production le 16/09 07:24, image `87ae29c9`).

---

## 0. Ménage fait ce matin, et ce qui reste

| | |
|---|---|
| ✅ Supprimés par l'API (chemin audité) | les 3 liens de RDV de prod — tous sur « Client test », zéro demande : *Installation (Sprinter, RS4)* 29/08, *Installation RS3* 09/09, *TEST* 14/09 |
| ⚠️ Reste, **à votre accord** | le planning **« TEST »** (créé le 06/07 par une validation de demande, flotte « Client test », description « Prises de RDV en ligne », 1 tâche `AD-458-DC` datée 07/07, jamais posée) — un débris d'essai |
| ✋ Conservé, en usage | le lien de **réservation de véhicule** de CDEF31 (`/reserve/:token`, 55 ouvertures) — autre fonctionnalité, pas un lien d'installation |

---

## 1. Votre demande : un lien pour un client **sans compte flotte**, et le nom de qui l'a créé

### 1.1 Ce que le code impose aujourd'hui

- `InstallationBookingLink.fleetId` est **obligatoire** (`schema.prisma`, `fleet Fleet @relation(... onDelete: Cascade)`), tout comme
  `InstallationBooking.fleetId` (dénormalisé) et `InstallationPlan.fleetId`. La page publique affiche `link.fleet.name` comme
  nom de société (`installation-booking.service.ts`, `getPublicLink`). Sans flotte, rien ne se crée : ni lien, ni demande, ni planning.
- `createdBy` existe sur le lien (`String? @db.Uuid`, **sans relation** vers `users`) : il est écrit à la création, **jamais lu**
  ni affiché. Même chose pour `confirmedBy` sur la demande.
- Le formulaire admin exige la flotte en premier champ (« Société / flotte * »).

### 1.2 Proposition A1 — le « lien prospect »

1. **`fleetId` devient facultatif** sur le lien et sur la demande ; le lien gagne **`companyName`** (nom de la société du prospect,
   obligatoire quand il n'y a pas de flotte). La page publique affiche `companyName ?? fleet.name`. Migration additive (colonnes
   nullables), sans réécriture — compatible repli d'image.
2. Formulaire admin : « Société » devient un sélecteur avec **« — Pas encore de compte flotte (prospect) — »** en tête ; ce choix
   révèle « Nom de la société * ». Le reste (client direct, horaires, J+N…) ne change pas.
3. **À la validation d'une demande sans flotte**, l'écran « Valider » demande de **rattacher** : *une flotte existante* **ou**
   *« Créer la société »* (une `Fleet` créée à la volée depuis `companyName` + adresse de la demande). Puis planning + pose exactement
   comme aujourd'hui. Le lien reçoit la flotte : les demandes suivantes du même lien en héritent.
4. Option (à trancher, § 5) : au même moment, **inviter le client** comme administrateur de sa flotte — le mécanisme d'invitation
   par e-mail existe déjà (`/accept-invite`). Le lien de RDV devient ainsi la porte d'entrée d'un nouveau client :
   *lien → demande → validation (société créée) → pose (véhicule + boîtier provisionnés) → accès*.
5. **Qui a créé le lien** : relation `createdBy → users` (ou jointure) exposée dans le DTO (`createdByName`), affichée sur la carte
   du lien (« créé par Youness H. le 14/09 ») et dans le mail opérateur ; `confirmedByName` sur la demande (« validée par … »).

Effort : ~½ journée (schéma, service, écran, tests) + ½ journée si « Créer la société » et l'invitation.

---

## 2. Incohérences trouvées — réservations

| # | Gravité | Constat (où) | Proposition |
|---|:--:|---|---|
| **R1** | 🔴 | **L'e-mail de refus est illisible.** `rejectBooking` construit son corps à la main avec la **palette sombre** d'avant la refonte (`color:#EAEFED` pour le titre, `#9BA5A1` pour le texte) dans le gabarit **blanc** actuel (`shell()` → `background:#FFFFFF`) : titre blanc sur blanc. Et il est envoyé sous l'identifiant `installation_slot_confirmed` : dans le centre e-mails, un **refus apparaît comme « Créneau confirmé »**. (`installation-booking.service.ts`, `rejectBooking`) | Un vrai modèle **`installation_slot_rejected`** au catalogue (builder + aperçu + les deux specs), palette du gabarit, bouton « Choisir un autre créneau » qui renvoie sur le lien s'il est encore ouvert. |
| **R2** | 🔴 | **Une demande confirmée ne peut jamais être annulée.** Le statut `CANCELLED` existe dans l'enum mais **aucun code ne le pose**. Refuser une demande CONFIRMED répond « annulez la pose » ; or supprimer la pose (`removeTask`) met `taskId` à null et **laisse la demande CONFIRMED** — et `busyIntervals()` compte les CONFIRMED : **le créneau reste bloqué pour toujours**. Idem si l'on supprime tout le planning. | Action **« Annuler »** sur une demande (PENDING ou CONFIRMED) : statut `CANCELLED`, créneau libéré, tâche supprimée si non posée (refus si `DONE`), e-mail client optionnel, trace d'activité. Et quand une tâche liée est supprimée depuis le planning, **annuler la demande** dans le même mouvement. |
| **R3** | 🔴 | **Supprimer un lien efface ses demandes** (`InstallationBooking.link … onDelete: Cascade`) alors que la confirmation à l'écran dit « les demandes déjà reçues sont conservées ». Les poses survivent (SetNull côté tâche), mais l'historique client (qui, quand, quel créneau) disparaît. | `onDelete: SetNull` (`linkId` nullable) + libellé du lien dénormalisé sur la demande, **ou** refuser de supprimer un lien qui porte des demandes actives (« désactivez-le »). Recommandé : SetNull + désactivation proposée en premier. |
| **R4** | 🟠 | **Le calendrier ne voit que les réservations en ligne.** `busyIntervals()` lit `installation_bookings` ; un **planning manuel** (ex. CDEF31, 3 poses/jour) ne bloque pas les créneaux publics du même jour → double réservation de l'équipe. Et **aucune notion de jour fermé** : un vendredi 25 décembre ou une semaine de congés est proposée. | (a) **Fériés français** exclus automatiquement — le helper existe déjà (`vehicle-schedules/schedule-evaluator.ts`, `computeUpcomingHolidays`) ; (b) **congés / jours fermés** saisis par l'opérateur (petite table `installation_closures` : date, motif) ; (c) un jour portant ≥ N tâches planifiées dans un planning manuel est considéré **plein** (N paramétrable, défaut 3). |
| **R5** | 🟠 | **Deux vérités pour la date de pose.** La demande porte le créneau (`startAt`/`endAt`), la tâche ne porte que le **jour** (`scheduledDate`) : le planning **perd l'heure** (10:00–12:00 n'apparaît nulle part côté installateur). Pire : le FLEET_ADMIN peut **déplacer la tâche de jour** (`reorder`, ouvert au client) → le planning dit mardi, la demande bloque toujours jeudi. | La tâche issue d'une réservation **affiche l'heure** (relation `task.booking` déjà en base, jamais exposée) ; **verrou** : une tâche liée à une demande ne se déplace pas depuis l'écran client (ou déplacer = replanifier la demande, avec contrôle de disponibilité et e-mail). |
| **R6** | 🟠 | **L'adresse et les notes du client n'arrivent pas sur la tâche.** L'adresse n'est copiée que dans le planning à sa **création** (1ʳᵉ demande) ; la 2ᵉ demande d'un client multi-sites n'a pas d'adresse visible ; `booking.notes` (« la voiture est au dépôt B ») **ne va nulle part**. | À la validation : `notes → task.fieldNotes`, adresse **par tâche** (nouveau champ) ou encart « demande liée » dans l'éditeur (adresse, téléphone, notes, créneau). |
| **R7** | 🟠 | **Le planning auto porte le nom de la personne.** `clientName: booking.clientName` → dans la liste des plannings, « Marc Legrand » côtoie « CDEF 31 — Centre Dép… ». | `companyName` du lien (§ 1) ; la personne devient le contact du planning. |
| **R8** | 🟡 | **Le client n'a pas d'accusé de réception** (seul l'opérateur reçoit un mail à la demande) ; **pas de rappel J-1** ; **pas de moyen d'annuler ou déplacer** lui-même ; la confirmation **n'a pas de pièce `.ics`**. | Accusé immédiat (récap du créneau, « on vous confirme sous 24 h ») ; rappel J-1 par e-mail + SMS si téléphone (passerelle existante) ; lien « modifier / annuler » à jeton dans les e-mails ; `.ics` joint à la confirmation. |
| **R9** | 🟡 | **Le téléphone est facultatif** sur un lien générique — pour un installateur qui se déplace, c'est la donnée la plus utile. Et **la plaque est obligatoire à la validation** (`Renseignez la plaque…`) alors qu'un prospect ne la connaît pas toujours à ce stade. | Téléphone **obligatoire** (à trancher) ; plaque **« à confirmer à la pose »** (`task.plate` nullable, exigée au `completeTask`). |
| **R10** | 🟡 | **Usage unique** : le lien se ferme à la **validation**, l'écran dit « après la 1ʳᵉ réservation » ; entre la demande et la validation, une 2ᵉ demande peut passer. | Fermer à la **demande** (statut PENDING) — rouvrir automatiquement si elle est refusée ou annulée. |
| **R11** | 🟡 | **Notification opérateur** : e-mail vers `contact@vizyoagency.com` **codé en dur** (`CONTACT_EMAIL`), rien d'autre. | Push aux super-admins par le socle existant (`notifications/coupe-circuit-push.service.ts` en modèle) + adresse configurable (`INSTALLATION_NOTIFY_EMAIL`). |
| **R12** | 🟡 | L'API accepte `planId` à la création d'un lien (rattacher à un planning existant) ; **l'écran ne le propose pas**, et le rattachement tardif est impossible. | Sélecteur « Rattacher à un planning existant » (filtré par flotte) dans le formulaire ; modifiable ensuite. |
| **R13** | 🟡 | **Une réservation = un véhicule.** Un prospect avec cinq véhicules doit réserver cinq créneaux. | Champ « Nombre de véhicules » sur la page publique (borné par lien) : créneau étiré × n **ou** n tâches créées à la validation (à trancher). |
| **R14** | 🟢 | **Capacité = une équipe pour tout le monde** : deux clients ne peuvent pas être servis à la même heure, même par deux techniciens ou dans deux villes. Voulu pour l'instant, mais **non paramétrable**. | `INSTALLATION_TEAMS` (défaut 1) ou une notion d'équipe/zone par lien, plus tard. |

---

## 3. Incohérences trouvées — plannings d'installation

| # | Gravité | Constat (où) | Proposition |
|---|:--:|---|---|
| **P1** | 🟠 | **Planning « TEST » orphelin en prod** (§ 0). | Supprimer, avec votre accord. |
| **P2** | 🟠 | **Pas de « journée de l'installateur »** : les plannings manuels (par client, par jour) et l'agenda des réservations (par créneau) sont **deux écrans** qui ne se voient pas ; le planning n'a pas d'heure. | Une **vue Agenda unique** (jour → poses manuelles + créneaux réservés, adresse, téléphone), dans `/admin/installation-bookings` ou en tête de `/admin/installations`. Même donnée que R4/R5. |
| **P3** | 🟡 | Le FLEET_ADMIN peut **réordonner et déplacer** toute tâche de ses plannings publiés, y compris une pose issue d'une réservation confirmée (cf. R5). | Verrou ou propagation (R5). |
| **P4** | 🟡 | **La pose ne remonte rien à la demande** : `completeTask` ne touche pas `installation_bookings` ; l'onglet Demandes ne dit jamais « installée ». Et c'est le bon moment pour dire au client « votre boîtier est posé, voici votre accès ». | Statut/horodatage « posée » visible sur la demande ; e-mail de fin de pose (avec l'invitation du prospect, § 1.2 point 4). |
| **P5** | 🟡 | **Supprimer un planning** cascade ses tâches ; les demandes liées gardent `taskId = null` et **restent CONFIRMED** (créneau bloqué, cf. R2). | Annuler les demandes liées dans le même mouvement (R2). |
| **P6** | 🟢 | Le planning auto-créé passe **directement `PUBLISHED`** (visible du client), sans passer par DRAFT ; documenté nulle part. | Garder, mais le dire dans la description du planning et dans la doc. |

---

## 4. Ordre proposé

| Lot | Contenu | Effort |
|---|---|---|
| **A — votre demande + les 🔴** | A1 lien prospect + créateur ; R1 e-mail de refus ; R2 annulation ; R3 cascade des liens | ~1 j |
| **B — un calendrier juste** | R4 fériés / congés / jours pleins ; R5 heure sur la tâche + verrou ; R6 adresse et notes → tâche ; R7 nom de société ; P2 agenda unique | ~1 j |
| **C — le client** | R8 accusé, rappel J-1, modifier/annuler, `.ics` ; R11 push opérateur ; P4 fin de pose | ~1 j |
| **D — ergonomie** | R9, R10, R12, R13, R14, P6 | selon besoin |

Chaque lot = une branche, tests, recette sur la base de dev, puis `deploy.sh` (en respectant la procédure du chantier
coupe-circuit désormais en prod : rien pendant une fenêtre de preuve).

---

## 5. Décisions à trancher avant de coder

| # | Question | Mon conseil |
|---|---|---|
| Q1 | Pour un prospect, **créer la société à la validation** de la demande, ou seulement à la pose ? | À la validation : le planning a besoin d'une flotte, et l'opérateur est devant l'écran. |
| Q2 | **Inviter automatiquement** le client comme administrateur de sa flotte ? Si oui, à la validation ou à la fin de pose ? | À la **fin de pose** (P4) : l'accès n'a de sens qu'avec un boîtier qui remonte. |
| Q3 | **Téléphone obligatoire** sur les liens génériques ? | Oui. |
| Q4 | Jours fermés : **fériés automatiques** + congés saisis ? Un jour de planning manuel avec ≥ 3 poses est-il **plein** ? | Oui aux trois, seuil réglable. |
| Q5 | Le client peut **annuler / déplacer** lui-même jusqu'à quand ? | Jusqu'à J-1 12:00 ; après, « appelez-nous ». |
| Q6 | Réservation **multi-véhicules** : créneau étiré ou n tâches ? | n tâches sur un créneau étiré (× n, plafonné par lien à 3). |
| Q7 | Supprimer le planning **« TEST »** orphelin ? | Oui. |
| Q8 | Supprimer un lien qui porte des demandes : **interdire** (désactiver seulement) ou **garder les demandes** (SetNull) ? | Garder les demandes (SetNull), et proposer « désactiver » en premier. |

---

## 6. Repères de code

| Sujet | Où |
|---|---|
| Liens, demandes, disponibilité, validation, refus | `apps/api/src/installation-booking/installation-booking.service.ts` |
| Générateur de créneaux (J+N, week-end) | `apps/api/src/installation-booking/installation-booking.slots.ts` |
| Écran admin réservations | `apps/web/src/app/features/observability/admin-installation-bookings.component.ts` |
| Page publique | `apps/web/src/app/features/booking/public-booking.component.ts` |
| Plannings (service, rôles, provisioning) | `apps/api/src/installations/installations.service.ts`, `installations.controller.ts` |
| Écrans plannings (opérateur, client) | `apps/web/src/app/features/installations/*` |
| Modèles | `apps/api/prisma/schema.prisma` : `InstallationBookingLink`, `InstallationBooking`, `InstallationPlan`, `InstallationTask` |
| Fériés (réutilisable) | `apps/api/src/vehicle-schedules/schedule-evaluator.ts` (`computeUpcomingHolidays`) |
| Push super-admins (modèle) | `apps/api/src/notifications/coupe-circuit-push.service.ts` |
| Chantier précédent (week-end, visites, J+1) | `2026-09-14-WEEK-END-VISITES-DECOUVERTE.md` |
