# A0 — Espace dépôt : vue d'ensemble

## Le besoin

Une entreprise de transport équipée de Tracky livre pour des dépôts tiers. Le dépôt, aujourd'hui, n'a aucun moyen de savoir où en est une livraison : il appelle l'exploitation, qui rappelle plus tard.

L'entreprise veut ouvrir un accès en lecture à ses donneurs d'ordre. Pas un accès à sa flotte — un accès **aux camions engagés sur les missions de ce dépôt, pendant ces missions**.

C'est un argument commercial pour le transporteur : il prouve sa fiabilité, et le dépôt n'a rien à installer ni à payer.

**Cas de référence** : un client, 7 camions, livre plusieurs dépôts. Un dépôt donné doit voir 4 camions le matin, aucun le soir, et jamais les 3 autres.

---

## Le principe directeur

> Le dépôt n'est pas un utilisateur de la flotte. C'est un tiers en lecture seule, dont le périmètre est **borné par la mission**.

Trois conséquences, qui structurent tout le bloc A :

1. **Sans mission, le dépôt ne voit rien.** Il n'y a pas de « liste des véhicules » pour un dépôt. Sa page d'accueil est vide s'il n'a pas de mission en cours — et c'est un état normal, à dessiner.
2. **La mission porte une fenêtre horaire.** Hors de `[startAt, endAt]`, la position du véhicule n'est plus servie. Ce n'est pas un filtre d'affichage : l'API répond `403`.
3. **Le transporteur reste maître.** Il crée la mission, il désigne le dépôt, il peut retirer l'accès. Rien ne s'ouvre automatiquement.

---

## Les 5 lots et leurs dépendances

```
A1 · Rôle DEPOT ─────────┬──────────────► A5 · Comptes & invitation
   permissions,          │
   isolation             │
                         ▼
                    A2 · Missions ────────► A3 · Espace dépôt ───► A4 · Partage
                    modèle, agenda,          carte live,            lien public
                    indisponibilité          historique, docs       15 min
```

| Lot | Ce qu'il livre | Bloquant pour |
|---|---|---|
| **A1** | Le slug `DEPOT` dans `permissions.ts`, les gardes API, la résolution de périmètre | A2, A3, A5 |
| **A2** | Le modèle `Mission`, l'onglet Missions dans `/agenda`, l'indisponibilité véhicule | A3, A4 |
| **A3** | La route `/depot` et ses 4 onglets, en 3 déclinaisons | A4 |
| **A4** | Le lien public `/s/:token`, sa révocation, son expiration | — |
| **A5** | L'invitation depuis `/users`, le rôle dans la matrice | — |

**A1 est un prérequis absolu.** Aucun écran ne se construit avant que l'isolation backend soit écrite et testée. Un espace dépôt joli qui fuit des données est pire que pas d'espace dépôt.

---

## Ce qui n'existe pas encore dans l'application

À créer intégralement. Rien de ceci n'a de code aujourd'hui.

| Élément | Où | Lot |
|---|---|---|
| Rôle `DEPOT` | `packages/shared/src/permissions/permissions.ts` | A1 |
| Permissions `missions_*`, `depot_*` | idem | A1 |
| Modèle `Mission` | `apps/api/prisma/schema.prisma` | A2 |
| Module `missions` | `apps/api/src/missions/` | A2 |
| Module `depot` | `apps/api/src/depot/` | A3 |
| Modèle `MissionShareLink` | `apps/api/prisma/schema.prisma` | A4 |
| Route `/depot` | `apps/web/src/app/app.routes.ts` | A3 |
| Route publique `/s/:token` | idem | A4 |
| Onglet Missions dans `/agenda` | `features/agenda/` | A2 |

---

## Ce qui existe et se réutilise

Ne rien réinventer. Ces mécanismes sont éprouvés en production.

| Besoin | Réutiliser | Fichier |
|---|---|---|
| Lien public à token | `ReservationBookingLink` | `schema.prisma:2011` |
| Contrôleur public sans auth | `PublicReservationBookingController` | `reservation-booking/` |
| Débit borné par méthode | `@Throttle({ default: { ttl, limit } })` | idem |
| Invitation par e-mail | module `invitations` | `apps/api/src/invitations/` |
| Résolution de permissions par véhicule | `PermissionsResolverService` | `apps/api/src/permissions/` |
| Indisponibilité d'un véhicule sur un créneau | logique des réservations | `reservation-booking.service.ts` |
| E-mail transactionnel | `email.service.ts` → `shell()` | `apps/api/src/email/` |
| Position temps réel | module `realtime`, rooms socket | `apps/api/src/realtime/` |

---

## Le vocabulaire, fixé une fois

À employer tel quel dans le code, les libellés et les e-mails. Le flottement de vocabulaire est la première cause d'incompréhension sur une fonctionnalité à trois acteurs.

| Terme | Signification | À ne pas confondre avec |
|---|---|---|
| **Dépôt** | Le compte tiers, destinataire d'une mission | Un lieu clé de type dépôt (`FleetPlace`) |
| **Mission** | Un trajet planifié, avec créneau, véhicule et dépôt destinataire | Un trajet (`Trip`, détecté a posteriori) |
| **Transporteur** | La flotte équipée de Tracky | La société au sens `Fleet` — c'est la même chose, mais le dépôt dit « transporteur » |
| **Fenêtre de mission** | `[startAt, endAt]` — la seule période où la position est servie | Les horaires de flotte (`fleet-schedules`) |
| **Suivi partagé** | Le lien public temporaire vers un client final | Le compte dépôt |

⚠️ Dans l'interface du dépôt, on ne dit jamais « flotte », « véhicule de la flotte », ni « société ». On dit « le camion », « votre transporteur », « votre mission ».

---

## Marque : qui voit quoi

Décision client : **l'espace appartient visuellement au transporteur, Tracky signe discrètement.**

- En-tête et menu latéral : nom et monogramme du transporteur (`Fleet.name`)
- Pied du menu : « Propulsé par Vizyo Tracky », 12 px, gris tertiaire
- Onboarding et page LP : lien vers `decouvrir-depot.html` (acquisition)

Aucun logo Tracky en tête d'écran. Le dépôt est le client de son transporteur, pas de Tracky.

---

## Ordre de travail recommandé

| # | Étape | Vérification avant de passer à la suite |
|---|---|---|
| 1 | A1 — rôle et isolation | Tests d'isolation verts : un `DEPOT` reçoit `403` sur un véhicule hors mission |
| 2 | A2 — modèle Mission + agenda | Créer une mission bloque le véhicule sur son créneau |
| 3 | A5 — invitation | Un dépôt invité peut se connecter et voit une page vide cohérente |
| 4 | A3 — espace dépôt | Les 4 onglets sur les 3 plateformes |
| 5 | A4 — partage | Le lien expire réellement, la révocation est immédiate |

A5 avant A3 : on a besoin d'un vrai compte dépôt pour développer et tester les écrans.

---

## Le risque principal, nommé

**Une fuite de données entre transporteur et dépôt tue la fonctionnalité et la confiance.**

Le transporteur ouvre son outil à un tiers qui est aussi son client — parfois son client commun avec un concurrent. Si un dépôt voit un camion qui livre ailleurs, le transporteur retire la fonctionnalité le jour même.

D'où, dans A1 : les tests d'isolation sont écrits **avant** le premier écran, et ils sont la condition de passage à A2.
