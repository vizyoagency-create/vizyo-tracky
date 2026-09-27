# Incident CDEF31 — nuit du 23 au 24/09/2026 : « l'application n'a pas fonctionné de 1h52 à 3h02 »

> Enquête menée le 24/09/2026 à partir du courrier de Patricia POUVREAU (CDEF31, 03:07:41) à
> Joost HENDRIKS. Sources : `engine_control_commands`, `user_activities`, `user_sessions`,
> `login_events`, `positions`, `error_logs` de `tracky_prod` ; journal du conteneur `tracky-api` ;
> `/opt/tracky-deploiements/journal.jsonl`. **Toutes les heures ci-dessous sont en heure de Paris.**

---

## Verdict en trois lignes

**Elle n'exagère pas sur les heures : 01h52 et 03h02 sont corroborés à la minute près.**
**Elle se trompe sur la cause : l'application n'est jamais tombée.** L'API a servi 1 812 lignes de
journal sur le créneau, **71 minutes sur 71**, zéro erreur applicative, et les **15 commandes
envoyées ont toutes été acquittées par le boîtier en 0,3 à 5,8 s**.
**Ce qui a échoué est chez nous** : son rôle de *veilleur* la rend structurellement aveugle à l'état
du bouton, et **nous avons déployé quatre fois en production entre 00h56 et 01h40** — précisément
pendant qu'elle essayait.

---

## 1. Ce que la cliente affirme

| Affirmation | Vérification | Verdict |
|---|---|---|
| « à partir de 1h52 » | 23 clics sur « rallumer » entre 01:51:08 et 01:51:14, puis abandon | ✅ **exact** |
| « à 3h02, toujours pas » | session ouverte 02:46:10 → 02:49:58 puis 02:54:11 → 02:58:51, **0 commande** | ✅ **exact** |
| « l'application n'a pas fonctionné » | API `healthy`, `restarts=0`, 71 min/71 servies, 0 erreur | ❌ **faux au sens littéral** |
| « déverrouiller à distance » ne marchait pas | 15 commandes envoyées, **15 acquittées en TCP** | ❌ **faux — le moteur a bien répondu** |
| pas de numéro de dépannage hors horaires | aucun n'est publié ; `astreinte@cdef31.org` rebondit (TRK-094) | ✅ **exact — trou produit réel** |

Elle a raison sur les faits qu'elle pouvait observer, et tort sur ceux qu'elle ne pouvait pas voir.
**C'est exactement le symptôme d'un défaut d'affichage, pas d'un défaut de service.**

---

## 2. La chronologie réelle

| Heure Paris | Fait | Source |
|---|---|---|
| **00:56:34 → 01:04:18** | 🚀 **Déploiement `2239076e`** (464 s) — API + web recréées | `journal.jsonl` |
| **01:18:37 → 01:24:45** | 🚀 **Déploiement `ccfef141`** (368 s) | idem |
| **01:29:56 → 01:35:10** | 🚀 **Déploiement `40103d61`** (314 s) | idem |
| **01:35:31 → 01:40:31** | 🚀 **Déploiement `908d20a0`** (300 s) — **API recréée à 01:39:51** | idem + `docker inspect` |
| 01:38:38 · 01:38:50 · 01:43:57 · 01:44:09 · 01:48:26 | **5 connexions** de `emu@cdef31.org` en 10 min (Android, IP 92.184.98.x) | `login_events` |
| **01:39:16** | **9 clics** « Veilleur GR-294-VW — rallumer » | `user_activities` |
| 01:39:19 | → **1 seule** commande `RESTORE`, **acquittée TCP en 5,2 s** | `engine_control_commands` |
| 01:44 → 01:50 | alternance `CUT` / `RESTORE` / `CUT` / `RESTORE` sur GR-294-VW puis GS-187-NY, **toutes acquittées** | idem |
| **01:51:08 → 01:51:14** | **23 clics** « Veilleur GS-187-NY — rallumer » en **6 secondes** | `user_activities` |
| 01:51:10 | → **1 seule** commande `RESTORE`, **acquittée TCP en 2,0 s** | `engine_control_commands` |
| 01:57:23 / 01:57:44 | derniers gestes : `CUT` GS-187-NY, `RESTORE` GR-294-VW — acquittés | idem |
| **01:58 → 07:00** | **plus aucune commande moteur sur toute la flotte CDEF31** | idem |
| 02:46:10 → 02:49:58 | session ouverte, **défilement 0 % → 62 %**, aucun clic de commande | `user_activities` |
| **02:54:11 → 02:58:51** | session ouverte, 2 clics sur la fiche **HD-443-QY**, **défilement 0 % → 100 %**, 0 commande | idem |
| 03:02 | « elle ne fonctionnait toujours pas » | courrier |
| 03:07:41 | envoi du courrier | courrier |
| 06:40:56 | connexion de `j.hendriks@cdef31.org` → `/fleet-admin/activity` | `login_events` |
| **07:00:07** | le **planning** rallume HD-443-QY tout seul, acquitté TCP | `engine_control_commands` |

**Bilan des gestes : 50 clics de commande → 15 commandes → 15 acquittements. 0 échec, 0 SMS,
0 erreur.**

---

## 3. Preuve que l'API n'est jamais tombée

Fenêtre mesurée : **01:52:00 → 03:02:00** (= 23:52 → 01:02 UTC), journal du conteneur
`912db9151173` créé à 01:39:51.

| Mesure | Valeur |
|---|---|
| Lignes de journal | **1 812** |
| Minutes couvertes | **71 sur 71** — pas une minute de silence |
| Erreurs applicatives (`level ≥ 50`) | **0** |
| Lignes `error_logs` en base (01h → 04h) | **0** |
| Conteneur | `restarts=0`, `healthy`, démarré 01:39:51 |
| Codes HTTP | 434 × `200` · 340 × `304` · **232 × `403`** · 212 × `201` · 12 × `401` · **6 × `429`** |

Les 232 `403` et les 6 `429` ne sont pas du bruit : **ce sont eux, l'incident.**

---

## 4. Les six défauts, dans l'ordre où ils ont mordu

### D1 — Le veilleur est aveugle par conception

`GET /api/engine-control/commands` est refusé au rôle `NIGHT_WATCHMAN` : **19 + 16 + 13 + 4 = 232
réponses `403`** sur le créneau, une par véhicule et par rafraîchissement. Conséquence assumée dans
le code (`engine-control-button.component.ts:370-385`) : `recentCommands()` **reste toujours vide**
pour elle, et l'état « coupé / rallumé » du bouton ne peut venir **que** de l'*overlay* temps réel
`cutActiveTrackerIds`, alimenté par le WebSocket.

**Son bouton n'a donc qu'une seule source de vérité : le WebSocket.**

### D2 — Le correctif du 17/09 n'est pas câblé sur la page qu'elle utilisait

`seedCutState()` (`realtime.service.ts:517-543`) a été écrit **exactement pour ce cas** : « réaligne
l'état coupe sur une liste REST fraîche… une reprise reçue pendant que l'onglet était déconnecté lui
échappait ». Il est appelé depuis **un seul endroit dans toute l'application** :
`fleet-schedules.component.ts:260` — la page **Horaires**.

**Elle était sur `/vehicles` toute la nuit.** Sur cette page, rien ne réaligne jamais l'overlay.

### D3 — La reconnexion automatique ne ré-hydrate pas

`hydrate()` n'est appelé que dans `connect()` (`realtime.service.ts:310`) et au retour d'onglet après
60 s (`:221`). Quand socket.io se reconnecte seul après une coupure serveur, le gestionnaire
`'connect'` (`:317-338`) **ne rappelle pas `hydrate()`** — il ne fait que `loadInitialAlerts()`.
Tout `CUT`/`RESTORE` survenu pendant la coupure est **définitivement perdu** pour l'affichage.

### D4 — Le seul chemin de réparation a été bloqué

Les **6 réponses `429`** du créneau portent **toutes** sur `GET /api/vehicles/snapshot` — c'est-à-dire
**la seule requête capable de recorriger l'état de son bouton**. Elle cliquait trop vite, donc la
limite de débit s'est déclenchée, donc l'état ne pouvait plus se réparer : la protection a fermé la
porte de secours.

### D5 — Un interrupteur destructif, au même endroit, sans libellé d'état

Le bouton est une bascule : après un rallumage réussi il devient « Couper », **au même pixel**. Sur
un téléphone, à 2 h du matin, quand le véhicule ne démarre pas (le conducteur doit encore tourner la
clé), le geste naturel est de **réappuyer** — et l'on recoupe. D'où l'alternance mesurée
`RESTORE → CUT → RESTORE → CUT` sur GR-294-VW puis GS-187-NY. **Elle a passé vingt minutes à se
battre contre sa propre main.**

Et 23 clics n'ont produit qu'une commande : le verrou d'envoi (`EngineCommandLockService`) avale les
suivants **sans rien afficher**.

### D6 — Quatre déploiements en production, pile pendant l'incident

`deploy.sh` interdit les déploiements **entre 05:30 et 09:00** (reprises du coupe-circuit). **La
tranche 00:00–05:00 n'est protégée par rien** — alors que c'est exactement la plage où le veilleur de
nuit travaille et où toute la flotte CDEF31 est coupée par le planning (22:00 → 07:00).

Quatre recréations de conteneur en 44 minutes = quatre coupures du WebSocket = quatre pertes
d'overlay, sur le seul rôle qui n'a pas de filet REST.

---

## 5. Le véhicule qu'elle voulait vraiment : HD-443-QY

À 02:54 elle ouvre la fiche **HD-443-QY**, la consulte deux fois, fait défiler la page de 0 % à
100 %… et **aucune commande ne part**.

Ce véhicule a été **coupé par le planning à 22:03:30**, et rallumé par le planning à **07:00:07** —
il est donc resté immobilisé toute la nuit. Il est `ONLINE`, boîtier 403C, `accConnected = true`,
position fraîche : **rien côté serveur ne s'opposait à un rallumage**. Aucune règle veilleur ne
bloque un `RESTORE` (les gardes de `engine-control.service.ts:982-1012` ne portent que sur le `CUT`).

**Ce qui est MESURÉ : le rallumage était possible, et il n'a jamais été demandé** — douze minutes
de page ouverte, la fiche consultée deux fois, la liste parcourue de bout en bout, zéro commande.

**Ce qui est DÉDUIT, et qu'il faut distinguer :** que le bouton ne l'ait pas proposé. Les clics
journalisés portent l'étiquette de la fiche (`HD-443-QY`), pas celle d'un bouton de commande — or
seuls les boutons portent une étiquette de traçage. L'absence de clic tracé est donc compatible
avec deux lectures : le bouton n'était pas là, ou il était là et elle ne l'a pas actionné. La
première est la plus probable compte tenu du rôle (état issu du seul WebSocket, coupé quatre fois
cette nuit-là) et du défilement de bout en bout — mais elle n'est pas prouvée par le journal.
*À trancher en rejouant le cas avec un compte veilleur de recette, quand il en existera un.*

---

## 6. Ce qu'il faut lui répondre

1. **Lui donner raison sur les heures**, sans réserve. Elle a bien essayé de 01h38 à 01h58, puis de
   02h46 à 02h58.
2. **Lui dire ce qui s'est réellement passé** : le service n'est pas tombé, ses ordres sont bien
   partis et ont bien été exécutés — c'est l'**affichage de l'état** qui l'a trompée, et une
   maintenance de notre côté pendant la nuit qui a aggravé les choses.
3. **Ne pas lui reprocher les 23 clics** : c'est la mesure exacte de notre défaut, pas du sien.
4. **Ouvrir un vrai canal de nuit** — c'est sa demande de fond (« Peut-on formaliser quelque chose à
   ce sujet ? ») et elle est légitime. Rappel : `astreinte@cdef31.org` **rebondit** (TRK-094), donc
   même les avis automatiques ne lui parviennent pas.

### ⚠️ Un point de sécurité à traiter séparément

Le courrier diffuse en clair **la commande SMS de déverrouillage** (`resume123456`, mot de passe par
défaut du protocole Coban/403C) **et l'emplacement du numéro de SIM** (« à l'intérieur du traceur »).
Autrement dit : **toute personne qui lit ce courrier et ouvre un boîtier peut rallumer un véhicule
sans passer par Tracky, sans trace et sans droit.** À signaler à Joost HENDRIKS, et à corriger
(changement du mot de passe des boîtiers).

---

## 7. Correctifs

### ✅ EN PRODUCTION depuis le 27/09/2026 à 20:16 Paris — `a3a8be21`

> Déployé par `deploy.sh --attendre` (le script a patienté 25 min qu'un passage d'automatisation
> finisse, puis a recréé). API saine en **15 s**, 0 redémarrage, démo saine, `dureeS` 832 s.
> Repère de repli : `avant-20260927-1810-908d20a0`.
>
> **Déployé APRÈS la coupe MH Cars de 20:00** (4 / 4 acquittées en TCP en 0,2 à 3,0 s), et
> 25 min avant le passage de 20:45 : aucun événement planifié n'a été touché. C'est la leçon de
> l'incident appliquée à son propre correctif — on ne recrée pas l'API juste avant une coupe.
>
> **Artefacts vérifiés dans les conteneurs**, pas `docker ps` : `etatCoupeParTracker` ×3 et
> `Throttle` ×1 côté véhicules, `NIGHT_WATCHMAN` ×2 et `accessibleVehicleIds` ×2 côté
> engine-control, `commande-utilisateur-en-difficulte` ×1 ; côté web, la classe `ec-etat` dans le
> fichier servi `chunk-6JNH6KI2.js` et l'écran de mise à jour dans le bundle d'amorçage.
> **0 ligne `error_logs` et 0 journal de niveau erreur** depuis la recréation ; `ScheduleCronService`
> actif ; CDEF31 **30 horaires armés, 0 override en cours**.

### Ce qui a été livré

| # | Correctif | Où | Preuve |
|---|---|---|---|
| **C1** | `engineCutState` voyage avec la liste `/vehicles`, qui appelle `seedCutState()` comme Horaires. Calcul tri-état extrait en `etatCoupeParTracker()` — partagé avec le snapshot, jamais dupliqué | `vehicles.service.ts`, `vehicles-list.component.ts` | tests API `vehicles` 56/56 |
| **C2** | Ré-hydratation sur l'événement `'connect'` du socket. Une reconnexion ne repassait jamais par `connect()` : les `CUT`/`RESTORE` manqués étaient perdus définitivement | `realtime.service.ts` | 2 tests neufs, dont les 4 reconnexions de la nuit rejouées |
| **C3** | `/api/vehicles/snapshot` passe à 300 req/min. Borne **relevée, pas supprimée** : la réponse peut porter 2 000 véhicules | `vehicles.controller.ts` | — |
| **C4** | **Deux boutons distincts à places fixes** + l'état écrit (« Moteur coupé » / « Coupure non confirmée » / « Moteur actif »). Chaque bouton n'est actif que pour l'action qui a un sens : un clic de trop ne peut plus défaire le geste précédent. La raison d'un refus sort de l'infobulle **dans les deux sens** | `engine-control-button.component.ts` | **7 tests neufs** — le composant n'en avait aucun |
| **C5** | `openAction` **n'attend plus le réseau** avant d'ouvrir la confirmation — c'était la cause directe des 23 clics : le bouton ne faisait rien de visible pendant que l'API redémarrait. Et un clic avalé par le verrou d'envoi est désormais **dit** | `engine-control-button.component.ts` | couvert par les tests du composant |
| **C6** *(révisé)* | Le refus nocturne a été **écarté** (décision du propriétaire, 24/09) : interdire neuf heures par jour coûtait plus que l'incident. Remplacé par **`avertir_nuit`** — le script dit combien de véhicules sont coupés et ce que l'opérateur va voir, sans jamais bloquer | `deploy/vps/deploy.sh` | **16 contrôles neufs** (153 au total, verts) |
| **C6′** | 🆕 **L'écran « Mise à jour en cours »** : quand l'API cesse de répondre plus de 6 s, l'application l'affiche en plein écran et **se recharge seule** au retour. Le rechargement ramène le code neuf ET une hydratation fraîche — donc un état de coupe juste | `mise-a-jour-en-cours.service.ts`, `mise-a-jour-overlay.component.ts`, `error-report.interceptor.ts` | **8 tests neufs** |
| **C7** | Le veilleur est **admis sur `GET /engine-control/commands`** — la cause de fond. Périmètre par véhicule réellement transmis (il ne l'était pas), motif libre caviardé pour ce rôle | `engine-control.controller.ts`, `engine-control.service.ts` | **7 tests neufs** + frontière de sécurité redéclarée |
| **A1** | 🆕 **Alerte super-admin « acharnement »** — 4 commandes manuelles du même utilisateur sur le même véhicule en 10 min ⇒ ligne `CRITICAL` + push. Sur la nuit du 24/09 elle serait partie à **01:48:40**, dix-neuf minutes avant l'abandon | `engine-control.service.ts`, `coupe-circuit-push.events.ts` | **6 tests neufs**, dont la nuit rejouée |

> **Pourquoi A1 et pas « alerter sur l'échec »** : cette nuit-là il n'y a eu **aucun échec**. Les 15
> commandes ont été acquittées. Toutes les alertes existantes surveillent l'échec ; aucune ne
> pouvait voir celle-ci. Le seul signal lisible côté serveur était la **série**.

> **Une frontière de sécurité a été déplacée, et il faut le dire.** Un test du Sprint 3
> (`night-watchman.security.spec.ts`) affirmait explicitement que le veilleur ne devait PAS
> figurer sur `listCommands` — il a échoué, comme il était conçu pour le faire. L'exclusion était
> juste en intention et fausse en conséquence : elle privait de toute source d'état le seul rôle
> dont le métier est de savoir si un véhicule est immobilisé — alors qu'il peut déjà le couper et
> le rallumer. Le test a été redéclaré, pas contourné : il vérifie maintenant que le veilleur est
> sur `listCommands` **et nulle part ailleurs** dans `engine-control` (`getCommand` et
> `listUnconfirmed` restent fermés).

**Vérification** : `pnpm verify` — types ✅, smoke-boot DI ✅, tests ✅ (**API 4 308/4 308**,
web **777/777**), `deploy.test.sh` **153/153**, `ng build --configuration production` ✅.
Le rejeu des migrations est **NON VÉRIFIÉ** (Postgres de dev local éteint) — sans objet ici :
aucune migration n'a été touchée, et le contrôle statique des 150 dossiers est passé.

### Restant

Rien des sept correctifs identifiés. Deux suites possibles, hors périmètre de l'incident :
mot de passe des boîtiers 403C à changer (§ 6), et un compte veilleur de recette pour pouvoir
rejouer le cas HD-443-QY dans un navigateur (§ 5).

---

*Enquête du 24/09/2026. Aucune donnée de production modifiée : lectures seules.*
