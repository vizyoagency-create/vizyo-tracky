# Audit critique du module Agenda — avant la mise en service cdef31

**Date :** 2026-09-22 · **Méthode :** lecture du code (front + API) + **lecture seule** de `tracky_prod`
(aucune écriture) · **Échéance :** mise en service chez cdef31 le lundi 2026-09-28.

Inventaire descriptif complémentaire : [`INVENTAIRE-FONCTIONNALITES-AGENDA-2026-09-22.md`](./INVENTAIRE-FONCTIONNALITES-AGENDA-2026-09-22.md).
Version visuelle (tableau de bord, cases à cocher) : <https://claude.ai/artifact/3pEq4crDmu3G1SrQ5eihuM>

> ## ⚠️ CE DOCUMENT DÉCRIT LE 22/09, PAS L'ÉTAT ACTUEL
> **Les trois P0 sont levés depuis le 23/09.** Ce rapport reste la trace de ce qui était vrai ce
> jour-là — il n'est pas mis à jour, exprès : un audit qu'on réécrit ne prouve plus rien.
>
> **Pour l'état courant, lire [`SUIVI-REVUE-AGENDA-2026-09-24.md`](./SUIVI-REVUE-AGENDA-2026-09-24.md)**,
> qui dit ce qui a été corrigé, ce qui reste, et les **sept défauts supplémentaires** que la recette
> à l'écran a trouvés — aucun n'étant visible dans le code.

---

## Verdict

**Le module tient. C'est la société cdef31 qui n'est pas prête.**

Les trois défauts bloquants ne sont **pas dans le code** : deux sont de la configuration, le
troisième est une chaîne d'agents locaux à l'arrêt depuis cinq jours. Les douze autres sont réels
mais tiennent une semaine.

| Mesure (prod, 22/09) | Valeur |
|---|---|
| Comptes cdef31 qui ne verront **rien** dans l'agenda | **5 sur 6** |
| Travaux d'agent local bloqués depuis le 17/09 | **6** (+1 rapport) |
| Réservations créées par la machine | **430 sur 435** |
| Véhicules déjà pré-réservés par l'agent jusqu'au 05/10 | **21 sur 30** |
| Coût IA total sur 30 jours | **0,4244 $** (et rien depuis le 03/09) |

---

## 🔴 P0 — bloque lundi

### P0-1 — Quatre comptes sur six ouvriront un agenda vide, le cinquième sera refusé à la porte

Les cinq comptes non-admin de cdef31 ont `agenda_view`, `reservations_view`,
`reservations_request`, `reservations_manage` et `ai_optimize` **tous à `false`**, explicitement
écrits en base. Ce n'est pas un défaut par omission : quelqu'un les a fermés.

```
role           | email                 | agenda_view | resa_view | resa_req | resa_manage
FLEET_ADMIN    | admin@cdef31.org      | (defaut)    | (defaut)  | (defaut) | (defaut)
FLEET_MANAGER  | astreinte@cdef31.org  | false       | false     | false    | false
FLEET_MANAGER  | r.garrigue@cdef31.org | false       | false     | false    | false
FLEET_MANAGER  | standard@cdef31.org   | false       | false     | false    | false
FLEET_MANAGER  | t.boulay@cdef31.org   | false       | false     | false    | false
NIGHT_WATCHMAN | emu@cdef31.org        | false       | false     | false    | false
```

- Les **4 FLEET_MANAGER** gardent `missions_view` à sa valeur par défaut (`true`) : la garde de
  route les laisse entrer, et la page leur montre **uniquement l'onglet Missions**. Or **cdef31 n'a
  aucune mission**. Ils liront « Aucune mission créée pour l'instant ». Pas une erreur, pas un 403 :
  une page vide, cohérente, et inutile.
- Le **NIGHT_WATCHMAN** a `missions_view` à `false` par défaut de rôle → `anyPermissionGuard` le
  **refuse**. Il ne peut pas ouvrir `/agenda`.
- Seul `admin@cdef31.org` (permissions `{}` → défauts FLEET_ADMIN) verra l'agenda réel.

**Correctif** — configuration depuis `/users`, selon [D3](#d3) et [D5](#d5). Aucun code, aucun
déploiement. **À faire avant tout le reste** : sans ça, les autres correctifs ne se voient pas.

Vérifié : `users.permissions` (prod) · `packages/shared/src/permissions/permissions.ts:238` ·
`apps/web/src/app/app.routes.ts:272`

---

### P0-2 — Les agents locaux sont morts depuis le 17/09, et c'est eux qui portent la politique de coût

```
type             | statut  | count | plus_ancien             | dernier_fini
jugement-agenda  | a-faire |     6 | 2026-09-17 00:01:37.83  | (jamais)
rapport-activite | a-faire |     1 | 2026-09-18 09:20:01.54  | (jamais)

erreur du plus ancien : « session Claude Code non authentifiee : 401 »
```

Conséquences **dans l'agenda** : les six derniers passages nocturnes portent `aiUsed = false` (le
dernier à `true` date du 16/09), et **221 des 263 propositions en attente n'ont aucun avis IA** —
elles n'ont que leur phrase mécanique.

Hors agenda : les récits de trajets sont à l'arrêt (8 611 sur les 30 jours précédents), et
**c'est la cause commune de TRK-094**, le rapport hebdomadaire jamais remis.

La sentinelle a bien parlé — c'est **TRK-069**, ouvert depuis cinq jours — et les agents ont été mis
en pause automatiquement après cinq heures d'échecs. Rien n'est cassé dans le code : la session doit
être rouverte sur le poste.

**Correctif** — ré-authentifier la CLI, lever la pause, vérifier la consommation au passage suivant
(06:30 ou 14:30 Paris). Puis [D7](#d7) : une panne de cinq jours de la file n'a produit aucune
alerte sur **la file elle-même**.

Vérifié : `travaux_ia_locaux`, `agenda_agent_runs` (prod) · fiche `TRK-069`

---

### P0-3 — L'agenda que le client va découvrir est rempli à 99 % par la machine

```
source | count | du                  | au
SYSTEM |   430 | 2026-07-07 11:32:00 | 2026-10-05 12:10:00
MANUAL |     5 | 2026-07-15 08:00:00 | 2026-08-01 07:00:00

a venir (CONFIRMED, SYSTEM) : 108 sur 21 vehicules
jour le plus charge      : 2026-09-25 -> 14 evenements (MAX_PILLS = 3)
```

L'agent tourne en `auto_high_confidence`, seuil 80 % : au-dessus, il ne propose pas, **il réserve
fermement**. Un exploitant qui voudra réserver lundi trouvera **70 % du parc déjà pris** — par
personne.

Et la grille n'est pas dimensionnée : **trois pastilles par jour** pour un pic à **quatorze
événements**. Le client verra « +11 », et ses propres réservations seront noyées.

**Correctif** — décision, pas bug : [D1](#d1), [D2](#d2), [D4](#d4).

Vérifié : `vehicle_events`, `agenda_agent_settings` (prod) ·
`apps/web/src/app/features/agenda/agenda-calendar.component.ts:37`

---

## 🟠 P1 — se verra cette semaine

| # | Constat | Conséquence | Où |
|---|---|---|---|
| **P1-1** | « À venir & en retard » ne regarde que le mois affiché | Le compteur *En retard* est global (`/agenda/summary`), la liste est dérivée de la fenêtre de 6 semaines. En septembre, une échéance d'octobre n'apparaît pas. cdef31 : 435 réservations en base, 297 dans la fenêtre — l'écart se verra. | `agenda.component.ts:1563` |
| **P1-2** | Le bouton « Demandes » peut rester invisible alors qu'une demande attend | `pendingCount` filtre la fenêtre du calendrier, et le bouton n'apparaît que si > 0. **Le lien public de cdef31 est actif et ouvert 55 fois** : la première demande visant un créneau hors du mois courant passera inaperçue. | `agenda.component.ts:1289` |
| **P1-3** | La file « À valider » mélange les sociétés pour un super-admin | `GET /api/reservations` n'accepte pas de `fleetId` et le front ne lui en envoie pas → la file affiche les demandes de **toutes** les sociétés, et on peut en valider une sur la mauvaise. FLEET_ADMIN non concerné. | `reservations.controller.ts:76` · `reservations.service.ts:704` |
| **P1-4** | La feuille Optimisation a son propre sélecteur de société | Signal local au lieu du `FleetFilterService` global : l'en-tête peut dire cdef31 pendant que la feuille agit sur mh cars — y compris pour le **changement de métier**. Un garde `loadedOnce` empêche en plus le rechargement aux ouvertures suivantes. | `optimization-sheet.component.ts:289` |
| **P1-5** | Une analyse de capacité perdue est une analyse repayée | `AiJobService` vit en mémoire du navigateur. Pour l'agent c'est rattrapable (propositions en base) ; pour la capacité, **le résultat n'existe nulle part** → relancer, donc repayer. | `core/services/ai-job.service.ts` |

---

## 🟡 P2 — réels, dormants cette semaine

Les trois premiers concernent les missions, que cdef31 n'utilise pas — mais **mh cars en a sept**.

| # | Constat | Conséquence | Où |
|---|---|---|---|
| **P2-1** | Un événement `MISSION` se supprime depuis l'agenda, et la mission survit | Le serveur bloque l'édition d'une `RESERVATION` mais **pas** d'une `MISSION`, et le panneau jour offre « En cours / Terminé / Supprimer » sur tout ce qui n'est pas une réservation. Supprimer, ou passer à « Terminé », **libère le véhicule pendant une mission qui existe toujours** — exactement la désynchronisation que la transaction de création empêche. | `vehicle-events.service.ts:215, 255` · `agenda.component.ts:483` |
| **P2-2** | Un événement `MISSION` s'affiche mal | `eventTypeLabel` renvoie la chaîne brute « MISSION », `eventColor` le gris « type inconnu », l'icône du panneau jour est **une clé à molette**, et la légende n'a pas d'entrée Mission. | `agenda.utils.ts:43, 72` |
| **P2-3** | La liste d'événements tronque à 1 000 lignes sans le dire | Tri par date croissante puis `take: 1000` : au-delà, **la fin du mois disparaît** silencieusement. cdef31 est à 297 — marge confortable, mais rien n'avertira. | `vehicle-events.service.ts:125` |
| **P2-4** | Les trois compteurs ne suivent pas les filtres | Filtrer par groupe ou véhicule ne change pas « En retard / À venir / Incidents ouverts ». L'écran suggère un périmètre qu'il n'applique pas. | `agenda.component.ts:1612` |
| **P2-5** | 2 049 propositions expirées et 172 refusées jamais purgées | Aucune rétention sur `agenda_agent_proposals`. Sans conséquence fonctionnelle, mais ~30 lignes par nuit et par société. | `agenda-agent-runner.service.ts` |
| **P2-6** | `GET /api/reservations/suggest` n'a aucun appelant | Endpoint complet et testé, mort côté front : la suggestion IA a pris sa place. | `core/services/agenda.service.ts:169` |
| **P2-7** | Le « Voir » d'une pastille `report` ne fait rien | `case 'report': break;` — « à brancher quand la génération passera en async ». Aucun code ne produit ce type aujourd'hui. | `agenda.component.ts:2021` |

---

## ✅ Ce qu'il ne faut pas défaire

**La politique « instantané = API, récurrent = local » est déjà en place, et mesurée.**

Sur 30 jours, toute l'activité IA récurrente est passée par les agents locaux **à 0,00 $** :

```
action          | executor | count |  usd
agenda_agent    | api      |    10 | 0.4244   ← tout antérieur au 03/09 (avant bascule)
trip_analysis   | local    |  8611 | 0.0000
agenda_agent    | local    |    11 | 0.0000
place_analysis  | local    |    32 | 0.0000
activity_report | local    |     3 | 0.0000
```

Le récit par cron est coupé **deux fois** : interrupteur global `tripAnalysis = false` **et**
`narrateEnabled = false` dans les réglages d'automatisation.

Les quatre fonctions restées sur l'API sont exactement les gestes instantanés :

| Fonction | Déclencheur | Verdict |
|---|---|---|
| `placement` | un humain demande un véhicule | ✅ garder sur l'API |
| `capacity` | clic « Analyser » | ✅ garder sur l'API |
| `bookingParse` | une demande publique arrive | ✅ garder sur l'API |
| `placeAnalysis` | clic sur un lieu clé | ✅ garder sur l'API |
| `agendaAgent` | chaque nuit | ✅ déjà local |
| `activityReport` | chaque semaine | ✅ déjà local |
| `tripAnalysis` | chaque heure | ✅ déjà local + coupé |

**Rien à migrer. Le seul problème, c'est que la moitié gratuite est à l'arrêt** (P0-2).

**Deux autres mécanismes contrôlés :**
- Le conflit de réservation est protégé par une contrainte `EXCLUDE` **en base**, pas seulement par
  un pré-check applicatif : deux validations simultanées ne peuvent pas passer toutes les deux.
- La disponibilité affichée est calculée par `effectiveBlockingEndMs`, **la même fonction partagée**
  que celle du serveur : ce qui s'affiche « libre » est ce que la réservation acceptera.

---

## Décisions à trancher

<a id="d1"></a>
### D1 — L'agent garde-t-il le droit de réserver tout seul chez cdef31 ?
Réglage actuel : `auto_high_confidence`, seuil 80 %, auto-complétion active, 4 déclencheurs sur 4.
C'est ce qui a produit 430 réservations machine pour 5 humaines.

> **Avis** — repasser en `suggest` pour la mise en service. Le client découvre l'outil : il doit
> voir son parc libre et décider lui-même, pas hériter d'un planning qu'il n'a pas demandé. On
> remet l'auto quand il aura dit que les propositions sont justes.

<a id="d2"></a>
### D2 — Que fait-on des 108 réservations automatiques déjà posées ?
Elles bloquent 21 véhicules sur 30 jusqu'au 05/10.

> **Avis** — les passer en `CANCELLED` (pas de suppression : on garde la trace) et laisser les 263
> propositions en attente faire leur travail. À décider **avec le client** : si ces créneaux
> correspondent à de vraies tournées, les perdre lui coûterait du temps.

<a id="d3"></a>
### D3 — Qui voit quoi chez cdef31 ?
Six comptes : 1 FLEET_ADMIN, 4 FLEET_MANAGER, 1 NIGHT_WATCHMAN. Cinq sont fermés (P0-1).

> **Avis** — les 4 FLEET_MANAGER : `agenda_view` + `reservations_view` + `reservations_request`.
> Un seul d'entre eux (ou l'admin) reçoit `reservations_manage` pour valider. `agenda_manage` à
> l'admin seul.

<a id="d4"></a>
### D4 — Comment rendre la grille lisible à 14 événements par jour ?
> **Avis** — si D1 passe en `suggest`, le problème se règle presque seul. Sinon : `MAX_PILLS` à 5
> sur écran large (la cellule fait déjà 88 px) **et** un filtre « masquer les réservations
> automatiques ». Le filtre est plus utile que la hauteur.

<a id="d5"></a>
### D5 — Le veilleur de nuit doit-il voir l'agenda ?
> **Avis** — oui, en lecture seule (`agenda_view` seul) : un veilleur qui voit une réservation à 5 h
> ne confondra pas un départ prévu avec un vol. Si le client préfère fermer, **il faut le lui dire**
> — `/agenda` lui sera refusé, autant qu'il le sache.

<a id="d6"></a>
### D6 — Le lien public de réservation reste-t-il actif lundi ?
Actif, ouvert 55 fois, zéro demande. Il alimente la file que P1-2 peut rendre invisible.

> **Avis** — le désactiver le temps de corriger P1-2, ou corriger P1-2 d'abord. Un lien public qui
> accepte des demandes que personne ne voit est pire qu'un lien fermé.

<a id="d7"></a>
### D7 — Quel seuil d'alerte sur la file des agents locaux ?
La sentinelle a signalé les passages manqués (TRK-069), mais **personne n'a regardé la file** : six
travaux empilés cinq jours sans qu'une ligne dise « la file grossit ».

> **Avis** — alerte sur l'âge du plus vieux travail `a-faire` : `WARNING` à 12 h, `CRITICAL` à 36 h.
> Ce signal aurait parlé le 18/09 au matin.

<a id="d8"></a>
### D8 — Corrige-t-on les missions avant lundi ?
> **Avis** — non. Mais P2-1 mérite une correction rapide après : c'est une perte d'intégrité
> silencieuse, et la garde manquante est **une ligne** à côté de celle qui existe pour les
> réservations.

---

## L'ordre des opérations

1. **Ré-authentifier les agents locaux et vider la file** — P0-2, sans déploiement.
   Contrôle : `SELECT statut, count(*) FROM travaux_ia_locaux GROUP BY 1`.
2. **Trancher D1, D2, D3, D5 avec le client** — quatre questions, dix minutes. Elles déterminent ce
   que le client verra en ouvrant la page.
3. **Appliquer les permissions depuis `/users`** — P0-1, sans déploiement. Puis **se connecter avec
   un compte FLEET_MANAGER réel** et vérifier que la grille, les compteurs et le panneau jour
   s'affichent. La vérification compte autant que le geste.
4. **Appliquer D1 et D2 sur l'agent** — autonomie depuis ⚙️ Paramètres ; pour les 108 réservations,
   une mise à jour en base, **hors des heures d'automatisation** (jamais entre HH:42 et HH:46).
5. **Corriger P1-2 et P1-3, puis déployer** — deux corrections courtes, même déploiement.
   `pnpm verify` puis `deploy.sh` — **jamais entre 05:30 et 09:00 Paris**.
6. **Après lundi** — P1-1, P1-4, P1-5, puis P2-1.

---

## Annexe — état de cdef31 au 22/09/2026

| | |
|---|---|
| Société | `2ad69ac1-3ffb-4fb6-aa4e-cfbba800b75f` · métier **CHILDREN_TRANSPORT** · `aiEnabled = true` (abonnement `COMP` depuis le 20/07) |
| Véhicules | **30**, dont 1 sans places renseignées |
| Comptes | 1 FLEET_ADMIN · 4 FLEET_MANAGER · 1 NIGHT_WATCHMAN |
| Agent d'agenda | activé · 02:00 · quotidien · `auto_high_confidence` · seuil 80 % · auto-complétion ON · 4 déclencheurs ON |
| Dernier passage | 22/09 00:00 — 192 motifs, 15 créées, 26 proposées, **390 ignorées**, `aiUsed = false`, 31 s |
| Propositions | 263 `pending` (221 sans avis IA, 14 déjà passées) · 429 `auto_applied` · 2 049 `expired` · 172 `dismissed` |
| Événements d'agenda | 431 `RESERVATION` CONFIRMED · 4 CANCELLED · 2 MAINTENANCE · **0 mission** · **0 demande en attente** |
| Plans d'entretien | **aucun** (le seul de la base est chez mh cars) |
| Lien public | 1, actif, ouvert 55 fois, 0 demande |
