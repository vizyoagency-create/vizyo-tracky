# A6 — Demandes de mission, devis et négociation

> Fonctionnalité en construction sur `feat/depot-partage`. Ce fichier est le **plan
> de référence** : on le suit, on coche, et on y consigne les décisions au fur et à
> mesure. Toute session qui reprend le chantier commence ici.
>
> **État au 2026-08-13** — tranche 1 (modèle de domaine) écrite, à réviser suite aux
> arbitrages du 2026-08-13 ci-dessous. Aucune migration générée, aucun code branché.

---

## 1. Ce que la fonctionnalité doit faire

Un **dépôt** — jusqu'ici tiers en lecture seule — peut **demander** une mission. Il
saisit un enlèvement, une ou plusieurs livraisons, un créneau, la marchandise. Le
système propose **immédiatement un devis** calculé sur la grille tarifaire du
transporteur. La demande part au **fleet admin**, qui accepte, refuse ou
**contre-propose**. Le dépôt peut contre-proposer à son tour, autant de fois qu'il
le faut. **Quand les deux parties valident**, le fleet admin **affecte un camion et
un conducteur** — et la mission réelle naît à cet instant.

### Ce qui n'est pas la fonctionnalité

Une demande **n'est pas une mission**. Elle n'immobilise aucun véhicule, ne pose
aucun événement d'agenda, n'ouvre aucun accès à une position. C'est l'invariant qui
tient tout le reste : tant que les deux parties n'ont pas signé, rien n'existe côté
exploitation.

---

## 2. Les arbitrages du client — 2026-08-13

Ils priment sur toute décision antérieure, y compris celles inscrites dans le
schéma lors de la tranche 1.

| # | Décision | Conséquence |
|---|---|---|
| **A** | **Les arrêts multiples existent PARTOUT**, pas seulement sur les demandes. « C'est rare, les missions avec une seule adresse. » | Le modèle `Mission` gagne des arrêts. La création de mission dans `/agenda` doit permettre plusieurs points de livraison. |
| **B** | **L'adresse de chargement est fixe** ; le **retour au dépôt n'est pas obligatoire**. | Un enlèvement, N livraisons, retour optionnel. Modulable, jamais strict. |
| **C** | **Sans grille tarifaire, les demandes ET la création de mission sont désactivées.** | Le verrou est structurel, pas déclaratif. ⚠️ Voir le risque en § 7. |
| **D** | Le devis est proposé **dès la demande**, puis la demande part au fleet admin qui accepte ou contre-propose. | Le tour 0 est automatique et figé ; l'e-mail au transporteur part à l'envoi. |
| **E** | Les kilomètres sont **saisis par le dépôt ET estimés depuis les adresses**. | On garde les deux, plus celui retenu pour le devis. Cf. § 5. |
| **F** | **Bien expliquer les étapes dans les modales.** | La modale de demande est un parcours en étapes nommées, pas un formulaire à vingt champs. |

---

## 3. La grille tarifaire réelle

Fournie par le client le 2026-08-13. **Ce n'est pas un prix au kilomètre** — c'est
une grille par **tranches de distance**, à prix forfaitaire HT.

### 2. Courses Express

| Distance | Tarif HT |
|---|---|
| 0 à 50 km | 79 € |
| 51 à 100 km | 169 € |
| 101 à 150 km | 259 € |
| 151 à 200 km | 349 € |
| 201 à 250 km | 449 € |
| 251 à 300 km | 539 € |
| 301 à 350 km | 629 € |
| 351 à 400 km | 719 € |
| **Plus de 400 km** | **Sur devis** |

### Ce que cette grille impose au modèle

1. **Des tranches, pas un tarif unitaire.** Le modèle de la tranche 1
   (`pricePerKmCents`, `baseFeeCents`…) ne convient pas et doit être remplacé.
2. **« Sur devis » est un état, pas un prix.** Au-delà de 400 km, aucun montant
   n'est calculé : la demande part au transporteur **sans** tour 0 automatique, et
   c'est lui qui chiffre. L'écran doit le dire au dépôt au moment de la saisie —
   pas après l'envoi.
3. **La numérotation « 2. » annonce d'autres prestations.** Le modèle porte donc
   des **catégories** de prestation, chacune avec ses tranches. « Courses Express »
   est la première. ➜ *À demander au client : les sections 1 et 3+.*

---

## 4. Le modèle de données — cible révisée

### 4.1 Les arrêts, partout (arbitrage A)

```
MissionStop
  missionId | requestId   (l'un ou l'autre, jamais les deux)
  position   Int          rang de passage, à partir de 0
  kind       PICKUP | DROPOFF
  label      String
  placeId    FleetPlace?  quand c'est un lieu clé connu
  lat, lng   Float?       quand le géocodage a abouti
  wantedAt   DateTime?    créneau sur cet arrêt
  note       String?
```

> ⚠️ **`Mission.originLabel` et `Mission.destLabel` RESTENT.** Ils deviennent des
> champs **dérivés** : premier et dernier arrêt. Les conserver évite de toucher
> `MissionListeDto`, `MissionEnCoursDto`, l'espace dépôt, les liens publics et
> l'agenda — soit tout ce que le client teste en ce moment. La règle : les arrêts
> sont la source de vérité, les deux libellés en sont le résumé, recalculé à chaque
> écriture.

**Règles de composition** (arbitrage B) :
- Exactement **un** arrêt `PICKUP`, en position 0. C'est l'adresse de chargement.
- **Au moins un** `DROPOFF`. Pas de maximum.
- Le retour au dépôt est un `DROPOFF` **comme un autre** — jamais ajouté d'office.

### 4.2 La tarification

```
MissionPricingSettings          (1 par flotte)
  enabled           Boolean
  vatPct            Int         20 = 20 %
  quoteValidityHours Int        48 par défaut
  quoteFooterNote   String?
  extraStopCents    Int  = 0    supplément par livraison au-delà de la première
  waitingHourCents  Int  = 0    attente sur site, heure entamée
  tiers             MissionPricingTier[]

MissionPricingTier
  settingsId
  category    String            « Courses Express » — libellé libre
  position    Int
  fromKm      Int               borne basse, incluse
  toKm        Int?              borne haute incluse ; NULL = pas de limite
  priceCents  Int?              NULL = « sur devis », aucun calcul automatique
```

Les suppléments sont à **0 par défaut** : modulable, jamais imposé (arbitrage B).

### 4.3 La demande et la négociation

Conservés de la tranche 1, avec ces corrections :
- `MissionRequestStop` **disparaît** au profit de `MissionStop`, partagé.
- `MissionRequest` garde ses trois distances, sa fenêtre souhaitée, son statut, ses
  tours, son montant convenu et son lien vers la mission née.

### 4.4 Les invariants à ne pas perdre

1. **La négociation est un fil.** Chaque proposition est une ligne immuable de
   `MissionQuoteRound`. Le montant courant est le **dernier tour**, jamais un champ
   tenu en parallèle qui divergerait de son historique.
2. **Distances en mètres, montants en centimes**, entiers. Un devis est un calcul
   d'argent ; les flottants dérivent et finissent en facture contestée.
3. **Le devis d'un tour est figé** avec son détail (`breakdown`). Une grille
   modifiée demain ne réécrit pas une offre déjà lue.

---

## 5. Les distances (arbitrage E)

Trois valeurs, et c'est délibéré :

| Champ | Origine |
|---|---|
| `declaredDistanceM` | saisi par le dépôt |
| `estimatedDistanceM` | calculé par le serveur depuis les adresses géocodées |
| `usedDistanceM` | **celui retenu pour le devis**, choisi par le transporteur |

Aucune des deux premières n'a raison d'office : le dépôt connaît ses contraintes de
tournée, le calcul ignore les interdictions de tonnage. Les garder toutes permet de
dire « vous annonciez 40 km, nous en comptons 47 » plutôt que d'imposer un chiffre.

➜ *À vérifier avant de coder : le projet a-t-il déjà un service de géocodage
utilisable (`apps/api/src/geocode/`, `apps/api/src/geocoding/`) ? Si oui, le
réutiliser ; sinon, `estimatedDistanceM` reste nul et l'écran le dit.*

---

## 6. La machine à états

```
DRAFT ──envoi──► SUBMITTED ──┬─► NEGOTIATING ◄──┐
                             │        │         │
                             │        └─contre──┘  (n tours, alternés)
                             │
                             ├─────► ACCEPTED ──affectation──► CONVERTED
                             │
                             ├─────► REJECTED   (motif obligatoire)
                             └─────► EXPIRED    (échéance du devis)
```

- Le **tour 0** est automatique (auteur `SYSTEM`) sauf en « sur devis ».
- **Qui doit répondre** se lit sur l'auteur du dernier tour.
- `ACCEPTED` fige `agreedAmountCents`. Seule l'affectation mène à `CONVERTED`.
- Une demande `CONVERTED` est **immuable**.

---

## 7. Le risque de l'arbitrage C, à traiter avant de livrer

> **Couper la création de mission quand la grille est absente CASSERAIT l'existant.**
>
> Aujourd'hui les missions se créent sans aucune tarification, et **mh cars n'a
> aucune grille**. Déployer la règle telle quelle rendrait `/agenda` inopérant pour
> le client en pleine recette.
>
> **Mitigation retenue** : la règle ne s'applique qu'après qu'une grille par défaut
> a été **écrite pour chaque flotte existante** par la migration (données du § 3).
> À défaut, prévoir un état « grille absente » qui bloque la **demande** mais laisse
> la **création directe** au transporteur, et faire trancher le client.
>
> ➜ *Point ouvert. Ne pas livrer l'arbitrage C sans l'avoir posé au client.*

---

## 8. Le plan d'exécution

Chaque tranche est **livrable et testable seule**. On ne passe à la suivante
qu'après contrôles verts.

### T1 — Modèle de domaine ✅ *(commits `63e1749` puis révision du 2026-08-13)*
- [x] `MissionRequest`, `MissionQuoteRound`, `MissionPricingSettings`
- [x] Tranches tarifaires (`MissionPricingTier`) au lieu du prix/km — § 3
- [x] `MissionStop` PARTAGÉ demande + mission — § 4.1
- [x] `Mission.stops` posé ; `originLabel`/`destLabel` conservés, deviennent dérivés
- [x] `prisma validate` vert
- [ ] Reste à T2 : la contrainte CHECK « requestId XOR missionId »

### T2 — Migration et grille par défaut
- [ ] Migration additive (aucune colonne existante modifiée)
- [ ] Amorce : la grille « Courses Express » du § 3 pour chaque flotte existante
- [ ] Vérifier sur une copie de la base de production **avant** tout déploiement

### T3 — Tarification : API + onglet Paramètres
- [ ] `MissionPricingService` : lecture, écriture, validation des tranches
      (pas de trou, pas de recouvrement, bornes croissantes)
- [ ] Endpoints `GET`/`PUT /missions/pricing`, portée `requiredFleetScope`
      → le super-admin passe par le sélecteur de la barre (déjà en place)
- [ ] Page `/missions`, onglet **Paramètres** : éditeur de tranches
- [ ] Tests : calcul de tranche, bornes, « sur devis », TVA

### T4 — Moteur de devis
- [ ] `QuoteEngine` : distance → tranche → montant HT → suppléments → TVA
- [ ] Détail (`breakdown`) ligne à ligne, figé dans le tour
- [ ] « Sur devis » : aucun tour 0, la demande part sans montant
- [ ] Tests : chaque borne du § 3, les deux côtés de 400 km, grille désactivée

### T5 — Demande côté dépôt
- [ ] Permission `missions_request`, ouverte au rôle **DEPOT** — rôle **fermé par
      construction** : `permissionsForTargetRole` réécrit les défauts, `DepotScopeGuard`
      refuse. Ouvrir proprement, ne pas contourner.
- [ ] Endpoints : créer, modifier un brouillon, envoyer, contre-proposer, accepter,
      refuser, lister
- [ ] Périmètre : un dépôt ne voit **que ses** demandes
- [ ] Modale en **étapes expliquées** (arbitrage F) : trajet → marchandise →
      créneau → devis → envoi
- [ ] Saisie multi-arrêts : ajouter, retirer, réordonner
- [ ] Tests d'isolation, sur le modèle de `verif-depot.ts`

### T6 — Négociation côté transporteur
- [ ] Onglet **Demandes** de `/missions` : file d'attente, tri par ancienneté
- [ ] Fil de négociation : tours, auteurs, montants, messages
- [ ] Accepter / contre-proposer / refuser avec motif
- [ ] Correction de `usedDistanceM` avant de deviser
- [ ] Expiration automatique à l'échéance (tâche planifiée, cf. `MissionStatusService`)

### T7 — Affectation et conversion
- [ ] Choix camion + conducteur, en réutilisant `disponibiliteVehicules`
- [ ] Création de la mission par `MissionsService.creer` — le chemin existant
- [ ] Report des arrêts sur la mission ; libellés composés
- [ ] `CONVERTED`, demande immuable

### T8 — Multi-arrêts dans l'agenda (arbitrage A)
- [ ] `mission-dialog` : plusieurs points de livraison
- [ ] Affichage des arrêts sur la fiche mission et l'espace dépôt
- [ ] Non-régression : liens publics, suivi live, agenda

### T9 — E-mails
- [ ] Demande envoyée → fleet admin
- [ ] Devis / contre-proposition → l'autre partie
- [ ] Accord conclu → les deux
- [ ] Mission affectée → dépôt (l'e-mail existant suffit peut-être)

### T10 — Recette
- [ ] Parcours complet, deux comptes réels
- [ ] Mobile 375 px, modales fermables (le piège de la coque non partagée)
- [ ] Contrastes 4,5:1
- [ ] `pnpm verify` + totaux de tests affichés

---

## 9. Questions ouvertes

| # | Question | Bloque |
|---|---|---|
| Q1 | Les sections **1 et 3+** de la grille tarifaire — quelles prestations ? | T3 |
| Q2 | Arbitrage C : couper aussi la **création directe** de mission sans grille ? Cf. § 7. | T3 |
| Q3 | Un service de **géocodage** existe-t-il et est-il utilisable pour estimer les distances ? | T4 |
| Q4 | Le **supplément par arrêt** existe-t-il chez le client, ou les tranches couvrent-elles tout ? | T4 |

---

## 10. Pièges de ce dépôt, à ne pas repayer

- **Aucun accent grave dans un commentaire de `template:` ou `styles:`** — il termine
  le littéral et casse le build. Payé quatre fois sur ce chantier.
- Les variables déclarées dans `@theme inline` ne sont **pas** émises dans `:root`.
- Feuilles mobiles : toujours `max-height: Xvh; max-height: Xdvh;`.
- Enfants de grille et de flex : `min-width: 0`, sinon défilement horizontal.
- Les sept modales du dépôt partagent la coque `depot-modal`, **déjà conforme**.
  Toute nouvelle modale doit l'utiliser plutôt que porter ses propres styles — c'est
  la duplication qui avait cassé `mission-dialog`.
- Le super-admin a `fleetId = null` : toute lecture passe par `requiredFleetScope`,
  toute écriture exige une société choisie.
