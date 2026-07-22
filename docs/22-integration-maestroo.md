# 22 — Intégration Tracky × Maestroo — analyse préalable

> **Statut : ANALYSE VALIDÉE — les 8 décisions structurantes sont tranchées (§12), aucune ligne de
> code écrite.** La phase 0 est spécifiée dans
> [`23-integration-maestroo-phase0-spec.md`](./23-integration-maestroo-phase0-spec.md).
> Rédigé le 2026-07-22 après lecture des deux schémas Prisma
> (`vizyo-tracky/apps/api/prisma/schema.prisma`, 2778 l. — `maestroo/apps/api/prisma/schema.prisma`,
> 1853 l.), des modules API des deux apps, du `/internal` Tracky et du receveur webhooks Maestroo.

---

## 0. Résumé exécutif — les 6 choses à retenir

1. **Les deux apps sont complémentaires, pas redondantes.** Tracky mesure le **réel physique**
   (où, quand, combien de km, comment on conduit). Maestroo modélise le **contractuel et le
   financier** (ce que ça coûte, ce qu'on a vendu, ce qu'on facture). Le point de jonction est
   le **véhicule** et le **conducteur** ; la valeur créée est l'écart **réel vs. théorique**.

2. **Tracky donne ~4× plus que Maestroo** — mais ce que Maestroo rend est loin d'être négligeable
   (identité légale, coûts €, missions planifiées, documents conducteur qui expirent). Détail §4.

3. **Le killer feature n'est pas la carte, c'est `Vehicle.monthlyKm` et `Mission.actualKm`.**
   Le PRK v2 de Maestroo (`cout_fixe_km = ΣchargesFixes / monthlyKm`) repose aujourd'hui sur un
   kilométrage mensuel **saisi à la main**, et le module « réel vs théorique » (`Mission.actualKm`,
   `actualHours`, `costVarianceCents`) est **vide tant que personne ne le remplit**. Tracky peut
   remplir les deux automatiquement. C'est là que le client voit la valeur en 24 h.

4. **Le kill-switch dicte toute l'architecture — il doit être conçu en premier, pas après.**
   Si Maestroo *copie* les données Tracky dans ses tables métier, « tout faire disparaître » devient
   un DELETE destructeur, racé, et récupérable par un restore de backup. La règle doit être :
   **les données Tracky ne sont jamais *possédées* par Maestroo, elles sont *louées*.** Modèle en
   3 classes détaillé §5.

5. **Le piège qui tuerait le kill-switch : confondre « révoqué » et « injoignable ».** On a déjà
   vécu 3 jours d'auth injoignable en silence (cf. `vizyo_auth_integration`). Si la règle est
   « pas de heartbeat ⇒ purge », une panne Tracky efface les données de tous les clients Maestroo.
   Il faut deux chemins distincts : **révocation signée ⇒ purge immédiate** / **injoignable ⇒ mode
   dégradé, jamais de purge avant N heures + alerte**.

6. **L'interrupteur n'est pas binaire, il est par catégorie et il est vivant** *(décision D3)*.
   « Je ne veux plus que Maestroo voie les scores conducteurs » ou « je coupe la position et la
   vitesse » doivent être **un clic, à tout moment, sans casser le reste**. Conséquence structurante :
   la purge doit être **partielle par scope** dès le socle — d'où `TrackyMirror.scope` (§8) et la
   règle « un `kind` appartient à exactement un scope ». Rajouter ça après coup serait une refonte.

---

## 1. Ce que chaque app est vraiment

|  | **Tracky** | **Maestroo** |
|---|---|---|
| Nature | Télématique temps réel + terrain | TMS / gestion transport B2B |
| Tenant | `Fleet` (société) | `Organization` (société) |
| Rôles | `UserRole` global (SUPER_ADMIN…DRIVER) + `UserVehicleAccess` scopé (ALL/GROUP/VEHICLE) + `User.permissions` JSON granulaire | `PlatformRole` (équipe) + `Membership(OrgRole)` par org + `permissions` JSON |
| Source de vérité | **Capteur** (boîtier Coban → TCP → `Position`) | **Saisie humaine** + calcul (PRK, devis, facture) |
| Volumétrie | Énorme (positions, trajets, logs) — rétention 60 j / 12 mois | Faible (devis, factures, missions) — conservation légale 10 ans |
| Auth | Vizyo Auth (`User.authUserId @unique`) | Vizyo Auth (`User.authUserId @unique`) ✅ **même identité** |
| Machine-to-machine existant | `POST /internal/*` avec header `x-internal-secret` (appelé par vizyo-manager) | Receveur webhooks HMAC `timestamp.rawBody` + drift 300 s (`vizyo-webhooks/`) |

**Point structurant** : les deux apps partagent déjà **la même identité utilisateur** (`authUserId`
issu du même Vizyo Auth). C'est l'ancrage du handshake — aucun secret à échanger à la main (§6).

**Attention** : un compte Maestroo ne crée pas de compte Tracky (et inversement) — c'est voulu et
ça reste vrai. `Fleet` et `Organization` sont deux entités indépendantes ; le lien est **explicite,
opt-in, et révocable**.

---

## 2. Clés de rapprochement (comment on relie les objets)

| Objet | Tracky | Maestroo | Clé de rapprochement | Fiabilité |
|---|---|---|---|---|
| Société | `Fleet.id` (uuid), `name`, `clientId?` | `Organization.id` (uuid), `slug`, `siret @unique` | **Aucune clé commune aujourd'hui** → créée par le handshake (`PartnerLink`) | — |
| Véhicule | `Vehicle.plate` — `@@unique([fleetId, plate])` | `Vehicle.registration` — `@@unique([organizationId, registration])` | **Plaque normalisée** (`UPPER`, retrait des `-`/espaces) | ★★★★☆ |
| Conducteur | `Driver` (firstName, lastName, phone?, email?, licenseNumber?) | `Driver` (firstName, lastName, email?, phone?, birthDate?) | `email` > `phone` E.164 > nom normalisé | ★★☆☆☆ **revue humaine obligatoire** |
| Utilisateur | `User.authUserId` | `User.authUserId` | Identique (même Vizyo Auth) | ★★★★★ |
| Boîtier | `Tracker.imei` | *(n'existe pas)* | — | — |

### Écarts d'énumération à mapper explicitement

**Type de véhicule** — aucune valeur commune :

| Tracky `VehicleType` | Maestroo `VehicleType` |
|---|---|
| `CAR`, `TRUCK`, `VAN`, `MOTORCYCLE`, `BICYCLE`, `BUS`, `CONSTRUCTION`, `OTHER` | `TRUCK_HEAVY`, `TRUCK_MEDIUM`, `VAN`, `TRACTOR`, `TRAILER`, `OTHER` |

Maestroo est **transport routier** (PTAC), Tracky est **générique**. `TRUCK` (Tracky) → ambigu :
`TRUCK_HEAVY` ou `TRUCK_MEDIUM` ? Il n'y a pas de PTAC dans Tracky (`Vehicle` n'a ni poids ni
`maxPayloadKg`). → **La table de correspondance doit dégrader vers `OTHER` plutôt que deviner**, et
le champ reste éditable côté Maestroo. Inversement `TRACTOR`/`TRAILER` → `TRUCK` côté Tracky.

**Carburant** — Tracky réutilise `InstallationEnergy` :

| Tracky | Maestroo `FuelType` |
|---|---|
| `DIESEL` → | `DIESEL` |
| `ESSENCE` → | `PETROL` |
| `ELECTRIQUE` → | `ELECTRIC` |
| `HYBRIDE` → | `HYBRID` |
| `AUTRE` → | `OTHER` |
| *(absent)* ← | `HVO`, `GAS_CNG` → `AUTRE` côté Tracky (**perte d'information**) |

Recommandation : élargir `InstallationEnergy` côté Tracky (ou ajouter un `Vehicle.energyDetail`
texte) pour ne pas perdre HVO/GNC au retour — ce sont des carburants courants en transport lourd,
donc chez la cible Maestroo.

---

## 3. Ce que Tracky apporte à Maestroo

Classement par **valeur business décroissante**, pas par facilité technique.
La colonne « classe » renvoie au modèle de propriété du §5 (A = projeté jamais stocké, B = cache
verrouillé, C = adopté).

### 3.1 — Tier 1 : ça change la vie du client dès la semaine 1

| # | Donnée Tracky | Cible Maestroo | Pourquoi c'est énorme | Classe |
|---|---|---|---|---|
| 1 | Σ `Trip.distanceKm` sur 30 j glissants par véhicule | `Vehicle.monthlyKm` | Champ **obligatoire** du PRK v2 (`cout_fixe_km = ΣchargesFixes / monthlyKm`). Aujourd'hui saisi au doigt mouillé → **tout le prix de revient est faux**. Avec Tracky il devient exact et s'auto-corrige chaque mois. | B |
| 2 | `Trip` de la fenêtre de la mission | `Mission.actualKm`, `Mission.actualHours` | Le module « audit réel vs théorique » (M14) est **structurellement vide** aujourd'hui : personne ne ressaisit les km à la main. Tracky le remplit tout seul → `actualCostCents`, `costVarianceCents`, `costVariancePct` deviennent vivants, et l'alerte `PRK_OVERRUN` (déjà codée) se déclenche enfin sur du réel. | B |
| 3 | `Vehicle.calibratedConsumptionL100km` (méthode du plein) | `Vehicle.avgConsumption` | Conso **mesurée** (litres/distance entre 2 pleins complets, `calibratedTanks` = indice de confiance) au lieu d'une conso constructeur. Impacte directement le coût variable au km. | B |
| 4 | `Vehicle.lastOdometerKm` + Σ trajets depuis | `Vehicle.currentMileage` | Compteur toujours juste, zéro saisie. Déclenche les entretiens au bon moment. | B |
| 5 | `FuelFillUp` (litres + € payés, agrégé /mois/véhicule) | `VehicleCost{category: FUEL, frequency: MONTHLY}` | Charge carburant **réelle** au lieu d'une estimation `€/L × conso × km`. | B→C |

### 3.2 — Tier 2 : différenciant commercial

| # | Donnée Tracky | Cible Maestroo | Apport | Classe |
|---|---|---|---|---|
| 6 | Positions live (`Tracker.lastLat/lastLng/lastSpeedKmh/lastIgnition/lastPositionAt`) | **Widget carte** dashboard/overview | Voir sa flotte sans changer d'app. C'est la demande explicite. | **A — jamais persisté** |
| 7 | `Trip.startedAt` / `endedAt` | `Mission.startedAt` / `completedAt` | Horodatage automatique du départ/arrivée réels → statut mission qui s'auto-avance. | B |
| 8 | `Geofence` sur l'adresse client + arrêt détecté | Preuve de passage / heure de livraison | Litige client tranché en 2 clics. Adossé aux `Geofence` (CIRCLE/POLYGON/CORRIDOR) et aux arrêts de `TripAnalysis.detail`. | A/B |
| 9 | `VehicleEvent{MAINTENANCE\|INCIDENT}` + `MaintenancePlan` | `PlanningEvent{MAINTENANCE}` + `Alert` | Les immobilisations apparaissent dans le planning Maestroo → on ne vend pas une mission sur un camion au garage. `VehicleEvent.blocksVehicle` est **déjà** le signal exact. | B |
| 10 | `TripAnalysis.ecoScore`, `harshAccel/Brake`, `speedingCount/Sec`, `maxOverKmh` | Nouveau bloc « conduite » (fiche conducteur / véhicule) | Sinistralité, négociation d'assurance, coaching, prime. Rien d'équivalent dans Maestroo. | B |
| 11 | `TripAnalysis.fuelLiters`, `co2Kg` | Bilan RSE par mission / par client | Argument commercial pour les appels d'offres (obligation CO2 transport FR). | B |
| 12 | `WorkTimeEntry` (agrégat journalier : `drivingSeconds`, `firstTripStart`, `lastTripEnd`, `tripsCount`) | Fiche conducteur / préparation paie | **Construit exprès sans aucune position** (RGPD 4.5) → c'est la donnée conducteur la plus « exportable » du système. Heures de conduite réelles pour la paie et le contrôle du temps de travail. | B |

### 3.3 — Tier 3 : confort

| # | Donnée Tracky | Cible Maestroo | Apport | Classe |
|---|---|---|---|---|
| 13 | `Vehicle` (plate, brand, model, year, type, energy, seats) | `Vehicle` | **Import initial** : le client ne ressaisit pas sa flotte. C'est la promesse « je crée mon compte Maestroo et tout est déjà là ». | **C** |
| 14 | `Driver` (identité) | `Driver` | Import initial des conducteurs. | **C** |
| 15 | `Alert` Tracky (OVERSPEED, SOS, GEOFENCE, GPS_LOST…) | `Alert` (nouveau `sourceType='TRACKY'`) | Centre d'alertes unique. Le modèle Maestroo est **déjà polymorphe** (`sourceType`/`sourceId` sans FK) → purge triviale. ⚠️ `AlertType` est un enum Prisma à 3 valeurs → migration nécessaire. | B |
| 16 | `Tracker.status`, état `GPS_LOST`, `Vehicle.privacyModeEnabled` | Indicateur « santé flotte » | Transparence, et explique pourquoi une donnée manque. | A |
| 17 | `VehicleGroup` | Regroupement véhicules | Maestroo n'a **aucune** notion de groupe. | C |

---

## 4. Ce que Maestroo apporte à Tracky

Moins volumineux, mais deux lignes ici valent très cher (n°3 et n°4).

| # | Donnée Maestroo | Cible Tracky | Apport | Classe |
|---|---|---|---|---|
| 1 | `Organization.legalName`, `siret`, `vatNumber`, adresse, `logoDataUrl`, `transportLicense`, `bankIban/Bic/Name` | `Fleet` (**champs à créer**) | Aujourd'hui `Fleet` n'a **que** `name` + `clientId`. Avec ça : PDF de rapport à l'en-tête du client, facturation propre, identification légale. | C |
| 2 | `Vehicle.purchasePriceCents`, `amortizationMonths`, `monthlyRevenueCents`, `maxPayloadKg` + `VehicleCost[]` | Coût €/km réel côté Tracky | L'optimiseur IA Tracky raisonne aujourd'hui sur un prix carburant fixe (`Fleet.fuelPriceEurL = 1.85`). Avec les charges réelles il optimise en **euros**, pas en litres. Change la nature des recommandations. | B |
| 3 | **`DriverDocument.expiresAt`** (permis, FIMO, FCO, visite médicale, ADR, carte chrono) | `Alert` Tracky + gate `driver_unlock` | ⭐️ **Empêcher le démarrage d'un véhicule par un conducteur au permis/FCO expiré.** Tracky a déjà le déverrouillage moteur par conducteur (`driver-unlock/`, `EngineControlCommand`) mais **aucune notion de validité de permis**. C'est un cas d'usage sécurité + responsabilité employeur qu'aucune des deux apps ne peut faire seule. | B |
| 4 | **`Mission`** planifiée (client, `scheduledAt`, véhicule, chauffeur, `estimatedKm/Hours`) | `VehicleEvent{RESERVATION}` / agenda Tracky | ⭐️ Tracky sait enfin ce que le véhicule est **censé** faire → écart plan/réel, alerte « n'est pas parti », ETA client, et l'agent d'agenda IA a un vrai plan de charge à optimiser au lieu de deviner. | B |
| 5 | `Driver.status` (ACTIVE/ON_LEAVE/SUSPENDED/ARCHIVED), `contractType`, `hireDate`, `contractEndDate` | `Driver` (champs à créer) | N'attribue pas un trajet (`driverSource='AUTO'`) à quelqu'un en congé. Fiabilise `Vehicle.currentDriverId`. | B |
| 6 | `Driver.monthlySalaryCents` + `employerChargesRatePct` | Coût horaire conducteur | Chiffre le coût d'une immobilisation, d'un détour, d'un excès de ralenti (`TripAnalysis.idleSec`). | B |
| 7 | `Vehicle.status = MAINTENANCE / ARCHIVED`, `archivedAt` | État véhicule Tracky | Cohérence : un véhicule archivé côté gestion ne doit plus polluer les vues Tracky. | B |
| 8 | Adresses clients (`Quote.clientAddress`, missions récurrentes) | `Geofence` / `FleetPlace` auto-créées | ⭐️ Géofences créées automatiquement sur les adresses clients → preuve de livraison **sans aucune configuration manuelle**. Aujourd'hui chaque géofence est dessinée à la main. | C |
| 9 | `Invoice` / CA par véhicule | Rentabilité €/km dans les rapports Tracky | Le rapport hebdomadaire Tracky passe de « km parcourus » à « € gagnés par km ». | B |

---

## 5. ⚠️ Le cœur du sujet — modèle de propriété et kill-switch

> **Exigence client (mot pour mot) : « si depuis Tracky je coupe l'accès d'un compte, alors sur
> Maestroo toutes les données disparaissent — c'est ma sécu si un client ne paye pas. »**

### 5.1 — Pourquoi une simple copie + DELETE ne marche pas

Si Maestroo écrit les données Tracky dans ses tables métier :

- **La suppression casse la comptabilité.** Une facture émise dont une ligne dit « 1 240 km réels »
  référence un trajet Tracky. En France une facture est **immuable et conservée 10 ans**. On ne peut
  pas la vider rétroactivement — et on ne le veut pas : ce serait *notre* problème juridique.
- **Le DELETE est racé.** Il suppose que Maestroo est joignable et coopératif au moment exact où on
  coupe. API Maestroo down = données conservées.
- **Le backup défait la purge.** Un restore Maestroo ressuscite tout. *(Point souvent oublié — voir
  §5.5.)*
- **Les FK explosent.** Supprimer un `Vehicle` importé casse `Quote`, `Mission`, `Invoice`,
  `PlanningEvent`, `VehicleDocument` qui pointent dessus.

### 5.2 — La règle : **les données Tracky sont louées, pas données**

Trois classes de stockage, et **une seule** est vraiment supprimable — c'est voulu :

| Classe | Contenu | Où ça vit dans Maestroo | À la révocation |
|---|---|---|---|
| **A — Projeté (live)** | Positions, statut boîtier, carte live, alertes temps réel, dernier trajet en cours | **Nulle part.** Read-through à la demande via le lien Tracky, cache **mémoire/Redis TTL ≤ 60 s**. Jamais en base. | Disparaît **tout seul en ≤ 60 s**, sans que Maestroo ait quoi que ce soit à faire. Fail-safe par construction. |
| **B — Cache verrouillé** | Agrégats trop coûteux à recalculer en live : km/mois, heures conducteur, conso calibrée, scores de conduite, entretiens, CO2 | **Une seule table de quarantaine** `tracky_mirror(linkId, kind, refId, payload JSONB, fetchedAt, expiresAt)`. **Aucune FK vers les tables métier.** Les écrans lisent via une jointure applicative. | `DELETE FROM tracky_mirror WHERE link_id = ?` — **une instruction, zéro orphelin, zéro cascade**. |
| **C — Adopté** | Véhicules et conducteurs **créés** depuis Tracky à l'import initial | Vraies lignes `vehicles` / `drivers`, marquées `origin='TRACKY'` + `originRef` | **Conservées** (ce sont devenus des objets métier Maestroo : des factures pointent dessus) mais **dé-enrichies** : tous les champs de classe A/B redeviennent vides, badge « données Tracky révoquées », et `origin` passe à `TRACKY_REVOKED`. |

> **✅ Décision D1 tranchée : la classe C est CONSERVÉE et dé-enrichie.**
> Le levier commercial n'est pas la liste des plaques (le client les aurait tapées de toute façon) —
> c'est **l'enrichissement continu** : la carte live, les km réels, le PRK juste, les heures, les
> scores. Ça, ça s'éteint instantanément. Détruire en plus les véhicules casserait la facturation du
> client et rendrait *Maestroo* inutilisable, ce qui n'est pas le but recherché.

**Ces 3 classes valent aussi pour une révocation PARTIELLE** (extinction d'un seul scope, §6.3) :
même mécanique, filtrée sur le scope. C'est pour ça que `TrackyMirror` porte une colonne `scope`
en plus de `kind` (§8) — sans elle, on ne saurait purger que tout ou rien.

> **Exception légale non négociable** : un snapshot figé à l'intérieur d'un devis/facture **déjà
> émis** (le PDF, `Quote.prkSnapshot`, `Mission.actualKm` d'une mission facturée) n'est plus une
> donnée Tracky — c'est une pièce comptable. Elle survit à la révocation. Tout le reste s'éteint.

### 5.3 — Révoqué ≠ injoignable (le piège qui coûterait cher)

On a déjà eu **3 jours d'auth injoignable en silence** (cf. mémoire `vizyo_auth_integration`,
incident du 2026-07-21). Une règle naïve « pas de heartbeat ⇒ purge » aurait effacé les données de
tous les clients Maestroo pendant cette panne.

Deux chemins **strictement distincts** :

| Signal reçu par Maestroo | Interprétation | Action |
|---|---|---|
| `403 LINK_REVOKED` (réponse **signée** de Tracky) ou webhook `link.revoked` vérifié HMAC | Révocation **explicite** | **Purge immédiate** classe A+B, dé-enrichissement classe C, bannière « lien Tracky révoqué » |
| `403 LINK_SUSPENDED` | Suspension plateforme (impayé) | Purge classe A+B, classe C **gelée en lecture seule**, bannière « accès suspendu — contactez Tracky ». Réversible : réactivation = resync complet |
| Timeout / DNS / 5xx / erreur réseau | **Panne, pas révocation** | **Mode dégradé** : on continue d'afficher le cache B avec « données non rafraîchies depuis Xh ». **Aucune purge.** Alerte e-mail à l'owner dès 2 échecs consécutifs |
| Aucun renouvellement réussi depuis `graceHours` (72 h par défaut) | Silence prolongé | Purge **fail-closed** de la classe B + log CRITICAL + e-mail. La classe C reste. |

⚠️ **Le `403` de révocation doit être signé** (HMAC dans le corps de réponse) et pas un simple code
HTTP — sinon un proxy mal configuré ou un Traefik sans route (exactement le symptôme de l'incident
du 21/07 : un `404 page not found` de Traefik pris pour un 404 applicatif) déclencherait une purge.

### 5.4 — Trois chemins de révocation, redondants par conception

1. **Push** — Tracky POST un webhook `link.revoked` signé HMAC (`timestamp.rawBody`, drift 300 s) →
   purge en quelques secondes. *Table d'outbox avec retry côté Tracky, sinon un webhook perdu = une
   révocation perdue.*
2. **Pull** — le bail (token 10 min) ne se renouvelle plus : Maestroo reçoit `403 LINK_REVOKED` au
   plus tard 10 min après. Couvre le webhook perdu.
3. **Gate de lecture** — chaque endpoint Maestroo qui sert de la donnée Tracky vérifie
   `TrackyLink.status === 'ACTIVE'` **avant** de répondre. Couvre le cas « purge partielle en cours ».

Trois mécanismes indépendants pour une seule garantie : c'est ce qui rend la promesse tenable.

### 5.5 — Ce qui peut encore défaire la purge (à traiter explicitement)

- **Backups Maestroo.** Un restore ressuscite `tracky_mirror`. → soit la table est **exclue du dump**
  (`pg_dump --exclude-table`), soit on documente que tout restore déclenche un re-check du lien au
  boot avec purge si révoqué. **Je recommande les deux.**
- **Logs applicatifs.** Si une position transite par un `logger.debug`, elle est dans les logs. →
  interdiction de logger les payloads Tracky en clair ; masquage lat/lng au niveau du logger Pino.
- **PDF déjà générés** (`Quote.pdfPath`, `Invoice`). → couverts par l'exception légale §5.2.
- **Cache navigateur / PWA.** Le service worker Maestroo pourrait avoir mis en cache une réponse
  carte. → `Cache-Control: no-store` sur toutes les routes proxy Tracky, non-négociable.
- **Exports Excel/CSV déjà téléchargés par le client.** Irrécupérables — c'est une limite
  **inhérente**, à assumer et à écrire dans le contrat, pas à faire semblant de résoudre.

### 5.6 — Comment on *prouve* que ça marche

L'exigence n°1 doit être **testée automatiquement**, pas affirmée :

- Test e2e : lier → importer → révoquer → asserter que
  (a) `SELECT count(*) FROM tracky_mirror WHERE link_id = ?` = 0,
  (b) chaque route Maestroo consommant du Tracky répond 403/vide,
  (c) **un scan de toutes les colonnes JSONB de Maestroo ne contient plus aucune clé `lat`/`lng`**.
- Un bouton **« simulation de coupure »** dans l'admin super-admin Tracky : dry-run qui affiche ce
  qui disparaîtrait côté Maestroo (comptage par catégorie) **avant** d'appuyer pour de vrai. Même
  esprit que le DRY-RUN de la rétention (Sprint 6).
- Journalisation dans `SystemActivityLog` (catégorie `INTERNAL` existante) : qui a coupé, quand,
  quelle flotte, quel org — c'est un acte à conséquence financière pour le client.

---

## 6. Le handshake (le fameux bouton)

### 6.1 — Principe : double consentement, zéro secret manuel

Les deux apps partagent la même identité Vizyo Auth (`User.authUserId`). On s'en sert comme preuve
de contrôle commun.

```
Maestroo (admin org)                       Tracky (FLEET_ADMIN)
─────────────────────                      ────────────────────
[Connecter Tracky]
   │
   ├─ crée PartnerLink PENDING
   ├─ génère un code TRK-XXXX-XXXX (TTL 15 min)
   │  + une requête signée { authUserId, orgId, orgName, siret }
   │
   └────────── le client va dans Tracky ──────────►
                                            « Intégrations → Maestroo »
                                            colle le code
                                              │
                                              ├─ Tracky vérifie la signature
                                              ├─ ÉCRAN DE CONSENTEMENT :
                                              │   liste EXACTE de ce qui sera partagé,
                                              │   par catégorie, cases à cocher
                                              ├─ [J'autorise]
                                              │
                                              └─ PartnerLink ACTIVE (autoritaire)
                                                 + refresh secret renvoyé
                                                   SERVEUR-À-SERVEUR uniquement
   ◄────────────────────────────────────────────┘
Maestroo échange le refresh secret
contre des access tokens de 10 min
```

- **Si la même personne est admin des deux côtés** (même `authUserId`) → parcours 1 clic, pas de code
  à recopier.
- **Si ce sont deux personnes différentes** → le code force un double consentement humain. C'est
  plus sûr, pas moins. Les deux parcours doivent exister.
- Le refresh secret **ne touche jamais le navigateur**. Stocké chiffré côté Maestroo API.

### 6.2 — Qui tient l'interrupteur

| Acteur | Peut couper | Peut rétablir | Où |
|---|---|---|---|
| `FLEET_ADMIN` du client (Tracky) | ✅ son propre lien | ✅ | Tracky → Réglages → Intégrations |
| Admin org (Maestroo) | ✅ son propre lien | ❌ (doit repasser par le consentement Tracky) | Maestroo → Admin → Intégrations |
| **`SUPER_ADMIN` / owner Tracky** | ✅ **suspension plateforme** | ✅ **exclusivement** | Tracky → Admin → Abonnements |

⚠️ **`PartnerLink.suspendedByPlatform` est un flag distinct de `status`** : quand il est levé par la
plateforme, **le client ne peut pas le remettre lui-même**, même en refaisant tout le handshake.
C'est exactement le levier « le client ne paye pas » demandé. Sans ce flag séparé, le client
reconnecte en 30 secondes et le levier ne vaut rien.

### 6.3 — Scopes VIVANTS : le kill-switch granulaire *(décision D3)*

> **Ce ne sont pas des cases de consentement cochées une fois à la signature. C'est un tableau de
> bord permanent : chaque catégorie s'éteint et se rallume à tout moment, indépendamment des
> autres.** Éteindre une catégorie déclenche **exactement la même machinerie de purge** qu'une
> révocation totale, mais limitée à cette catégorie.

Écran « Intégrations → Maestroo » côté Tracky, toujours accessible :

| Scope | Ce que Maestroo voit | Défaut |
|---|---|---|
| `VEHICLE_IDENTITY` | Plaque, marque, modèle, année, énergie, places | ON |
| `MILEAGE_TRIPS` | km/mois, compteur, distances et durées de trajets | ON |
| `LIVE_POSITION` | **Position et vitesse temps réel** (widget carte) | OFF |
| `DRIVING_BEHAVIOR` | **Éco-score, excès de vitesse, freinages — nominatifs** | OFF |
| `DRIVER_IDENTITY` | Identité des conducteurs | ON |
| `DRIVER_HOURS` | Heures de conduite journalières (`WorkTimeEntry`, sans aucune position) | ON |
| `MAINTENANCE` | Entretiens, incidents, immobilisations | ON |
| `FUEL` | Pleins, conso réelle calibrée | ON |
| `ALERTS` | Alertes Tracky remontées dans Maestroo | ON |

**Conséquences de conception — non négociables :**

1. **Le scope est vérifié à chaque requête**, jamais seulement à l'affichage. Un scope OFF ⇒
   `403 SCOPE_REVOKED` sur les endpoints partenaires concernés.
2. **Éteindre un scope = révocation partielle**, avec les 3 chemins du §5.4 :
   webhook `scope.revoked` → purge ciblée, + le pull 10 min qui rattrape, + le gate de lecture.
3. **`TrackyMirror.kind` doit être dérivable du scope** (§8) — sinon une purge partielle est
   impossible et on retombe sur du tout-ou-rien. C'est une contrainte forte sur la taxonomie des
   `kind` : chaque `kind` appartient à **exactement un** scope.
4. **Dégradation par bloc côté Maestroo**, jamais d'écran cassé : le bloc concerné affiche
   « non partagé par Tracky », le reste continue de fonctionner.
5. **Deux niveaux d'extinction, distincts :**
   - le `FLEET_ADMIN` du client éteint un scope → **choix de confidentialité légitime**, réversible
     par lui-même ;
   - le `SUPER_ADMIN` Tracky éteint (`suspendedByPlatform`) → **levier commercial**, le client ne
     peut pas le rallumer.
6. **Rallumer un scope = resynchronisation complète** de sa catégorie (pas de reprise incrémentale
   depuis un `lastSyncAt` périmé, sinon on ressuscite des données obsolètes).

Chaque bascule de scope est écrite dans `PartnerLinkEvent` (qui, quand, quel scope, sens) — c'est
un acte à conséquence pour le client et pour la conformité.

---

## 7. Transport & sécurité

| Sujet | Choix | Justification |
|---|---|---|
| Topologie | **Direct API↔API** (Maestroo API ↔ Tracky API). Pas de passage par vizyo-manager. | vizyo-manager est orienté Vizyo Leads ; ajouter un hop ajoute une dépendance et un point de panne sur une feature P2P. |
| Auth machine | Bail : refresh secret longue durée → **access token 10 min**, en Bearer | Un token court **est** le kill-switch : au pire 10 min de survie après coupure. |
| Signature | HMAC-SHA256 sur `timestamp.rawBody`, drift 300 s, comparaison `timingSafeEqual` | **Pattern déjà en prod** dans `maestroo/apps/api/src/vizyo-webhooks/vizyo-webhook-signature.service.ts` → à réutiliser tel quel, pas à réinventer. |
| ⚠️ Ne **pas** réutiliser | `INTERNAL_API_SECRET` + header `x-internal-secret` (Tracky `/internal`) | Secret **statique**, sans timestamp ni anti-rejeu, et il donne accès à `fleet/suspend` et à la création de comptes. Le partager avec Maestroo étendrait massivement le rayon d'explosion. Nouveau secret dédié, scopé au partenariat. |
| Le navigateur ne parle **jamais** à Tracky | Tout passe par le proxy Maestroo API | (a) le token reste côté serveur, (b) le gate de révocation est appliqué à chaque requête, (c) pas de CORS/CSP à ouvrir entre les deux domaines. |
| Temps réel | **Polling 15-30 s** en v1, WS partenaire plus tard | Le VPS Tracky est à 2 vCPU et déjà tendu (cf. `tracky_status_model`). Les rooms WS actuelles sont scopées par `fleetId` + rôle Tracky — les rouvrir à Maestroo créerait des utilisateurs fantômes côté Tracky. |
| Charge | Servir la carte depuis `Tracker.lastLat/lastLng/...` (**colonnes dénormalisées déjà existantes**) + cache Redis 15 s par flotte | **Aucune requête sur `positions`.** Un client qui rafraîchit sa carte ne doit pas coûter un scan de la table la plus grosse du système. |
| Anti-boucle | Chaque écriture synchronisée porte `origin` ; le receveur **ne ré-émet jamais** un changement dont `origin` = le pair | Sans ça, Tracky écrit → Maestroo écrit → Tracky écrit… à l'infini. |

### Propriété des champs — une seule règle

> **L'app qui *observe* la donnée en est propriétaire. L'autre l'affiche, ne l'écrase jamais.**

| Nature | Propriétaire | Exemples |
|---|---|---|
| Physique / observé | **Tracky** | km, conso réelle, heures de conduite, position, entretien réalisé, scores |
| Contractuel / financier | **Maestroo** | coûts, salaire, contrat, statut RH, client, prix, facture |
| Identité | **Premier écrivain**, puis arbitrage manuel | plaque, marque, modèle, année, nom du conducteur |

Un champ a **exactement un** propriétaire. En cas de divergence sur un champ d'identité : on garde
les deux valeurs, on affiche une pastille « conflit », l'humain tranche. Jamais d'écrasement
silencieux bidirectionnel.

---

## 8. Modèles à créer (esquisse, à affiner)

### Côté Tracky (autoritaire)

```prisma
model PartnerLink {
  id                  String   @id @default(uuid()) @db.Uuid
  fleetId             String   @db.Uuid
  partner             String   // 'MAESTROO' (extensible)
  externalOrgId       String
  externalOrgName     String
  status              PartnerLinkStatus @default(PENDING) // PENDING|ACTIVE|SUSPENDED|REVOKED
  /// Suspension PLATEFORME (impayé) — le client ne peut PAS la lever lui-même.
  suspendedByPlatform Boolean  @default(false)
  scopes              Json     // catégories consenties
  secretHash          String   // refresh secret (hashé)
  createdByUserId     String?  @db.Uuid
  approvedByUserId    String?  @db.Uuid
  approvedAt          DateTime?
  lastSeenAt          DateTime?
  revokedAt           DateTime?
  revokedReason       String?
  @@unique([fleetId, partner])
}

model PartnerLinkEvent    { id, linkId, action, actor, detail, createdAt }   // audit immuable
model PartnerEntityMap    { id, linkId, kind, localId, externalId, confidence, confirmedByUserId }
model PartnerOutboxEvent  { id, linkId, type, payload, attempts, nextAttemptAt, deliveredAt }
```

### Côté Maestroo (consommateur)

```prisma
model TrackyLink {
  organizationId String  @unique @db.Uuid
  status         String  // ACTIVE|SUSPENDED|REVOKED|DEGRADED
  scopes         Json
  secretCipher   String  // refresh secret chiffré au repos
  lastSyncAt     DateTime?
  lastErrorAt    DateTime?
  degradedSince  DateTime?
  revokedAt      DateTime?
}

/// Classe B — quarantaine. AUCUNE FK vers les tables métier : purge = 1 DELETE.
model TrackyMirror {
  id        String   @id @default(uuid()) @db.Uuid
  linkId    String   @db.Uuid
  /// ⚠️ D3 — DOIT être dérivable du scope : c'est ce qui rend la purge PARTIELLE possible.
  scope     String   // 'MILEAGE_TRIPS' | 'DRIVING_BEHAVIOR' | 'DRIVER_HOURS' | …
  kind      String   // 'VEHICLE_STATS'|'DRIVER_HOURS'|'MISSION_ACTUALS'|'MAINTENANCE'|…
  refId     String   // id de l'objet Maestroo concerné (string libre, pas de FK)
  payload   Json
  fetchedAt DateTime @default(now())
  expiresAt DateTime
  @@index([linkId, scope])          // purge partielle : DELETE WHERE link_id=? AND scope=?
  @@index([linkId, kind, refId])    // lecture applicative
}
```

**Correspondance scope → `kind` (un `kind` appartient à exactement un scope)** :

| Scope | `kind` couverts | Purge à l'extinction |
|---|---|---|
| `MILEAGE_TRIPS` | `VEHICLE_STATS` (km/mois, compteur), `MISSION_ACTUALS` | `Vehicle.monthlyKm`/`currentMileage` et `Mission.actualKm/actualHours` redeviennent vides ⇒ le PRK retombe en mode saisie manuelle |
| `DRIVING_BEHAVIOR` | `DRIVER_SCORES`, `TRIP_SCORES` | Le bloc « conduite » disparaît des fiches conducteur et véhicule |
| `DRIVER_HOURS` | `DRIVER_HOURS` | Bloc heures de conduite masqué |
| `MAINTENANCE` | `MAINTENANCE`, `VEHICLE_BLOCKING` | Les `PlanningEvent` d'origine Tracky sont retirés du planning |
| `FUEL` | `FUEL_STATS` | `Vehicle.avgConsumption` revient à la valeur saisie ; les `VehicleCost{FUEL}` d'origine Tracky sont retirés |
| `ALERTS` | — *(classe B via `Alert.sourceType='TRACKY'`)* | `DELETE FROM alerts WHERE source_type='TRACKY'` |
| `LIVE_POSITION` | — *(classe A, rien en base)* | S'éteint seul en ≤ 60 s |
| `VEHICLE_IDENTITY` / `DRIVER_IDENTITY` | — *(classe C)* | Dé-enrichissement seul, les lignes restent (décision D1) |

```prisma

// Classe C — marquage de provenance
// Vehicle.origin / Vehicle.originRef
// Driver.origin  / Driver.originRef      ('MANUAL' | 'TRACKY' | 'TRACKY_REVOKED')
```

Côté Maestroo, `Alert.sourceType`/`sourceId` (polymorphe, **sans FK**) est déjà parfait pour les
alertes Tracky. ⚠️ `AlertType` est un enum Prisma à 3 valeurs → migration à prévoir.

---

## 9. Les features utilisateur qui en découlent

### Dans Maestroo

1. **Widget carte live** (dashboard/overview) — véhicules positionnés, statut, dernier point.
   Composant Maestroo natif (design system : `var(--color-*)`, jamais d'inline style, jamais de hex).
   ⚠️ Maestroo n'a **aucune** dépendance carto aujourd'hui → choix MapLibre/Leaflet à faire.
2. **Fiche véhicule enrichie** — bloc « Terrain » : compteur réel, km/mois, conso calibrée,
   prochain entretien, dernier trajet.
3. **PRK réel** — badge « calculé sur données réelles Tracky » vs « estimation saisie ». C'est *le*
   moment où le client comprend la valeur du couplage.
4. **Mission auto-auditée** — `actualKm`/`actualHours`/écart PRK remplis tout seuls, alerte
   `PRK_OVERRUN` sur du réel.
5. **Fiche conducteur** — heures de conduite réelles (`WorkTimeEntry`), éco-score, historique.
6. **Preuve de livraison** — timeline mission avec heure d'arrivée réelle sur l'adresse client.

### Dans Tracky

7. **Missions du jour sur l'agenda** — le plan de charge Maestroo devient visible sur la timeline
   véhicule, et l'agent d'agenda IA optimise contre un vrai plan.
8. **Blocage conducteur non conforme** — permis/FCO expiré (source Maestroo) ⇒ pas de
   `driver_unlock`, alerte au gestionnaire.
9. **Coût réel dans les rapports** — €/km au lieu de L/100km ; le rapport hebdo devient financier.
10. **Géofences auto** sur les adresses clients Maestroo.
11. **Identité légale du client** sur les PDF de rapport (logo, SIRET, licence transport).

### Transverse

12. **Écran « Intégrations »** des deux côtés : état du lien, dernière synchro, catégories
    partagées, journal des échanges, bouton de révocation.

---

## 10. RGPD — ce qui doit être tranché avant de coder

Tracky a une machinerie RGPD lourde et récente : mode vie privée par véhicule, calendrier de temps
de travail (hors plage = **rien n'est collecté**), purges réelles (positions 60 j, trajets 12 mois),
`WorkTimeEntry` construit **exprès sans aucune position**.

Envoyer des données à Maestroo, c'est **une nouvelle finalité et un nouveau destinataire**.

1. **Le partenaire ne doit jamais voir plus que l'app.** L'API partenaire Tracky doit réutiliser
   **les mêmes services** que l'UI Tracky (mode vie privée, calendrier de travail, scopes véhicule),
   pas taper Prisma directement. C'est une exigence d'implémentation, pas une recommandation :
   un véhicule en mode privé doit apparaître **sans position**, exactement comme dans Tracky.
2. **Par défaut, on n'exporte pas de positions brutes.** Les agrégats (km/jour, heures, distance par
   mission) portent ~95 % de la valeur Maestroo (PRK, facturation, paie) avec une intrusivité très
   inférieure. La position live est l'exception assumée — d'où sa **classe A (jamais persistée)** et
   sa **case décochée par défaut**.
3. **Conducteurs = données personnelles de salariés — et c'est DANS le périmètre v1 (décision D3).**
   Éco-score et excès de vitesse **nominatifs** dans un outil de gestion RH, c'est le point le plus
   sensible de tout le chantier (évaluation des salariés au sens CNIL). Trois garde-fous, tous
   **bloquants avant la première mise en service** :
   - le scope `DRIVING_BEHAVIOR` est **OFF par défaut** — c'est le client qui l'allume, en
     connaissance de cause, et il peut l'éteindre à tout instant (§6.3) ;
   - l'écran d'activation affiche un **avertissement explicite** rappelant l'obligation d'informer
     les salariés et de tenir le registre des traitements — pas une case enterrée dans des CGU ;
   - le **DPA et le registre des traitements des deux apps sont mis à jour avant** l'ouverture du
     scope, pas après. C'est un prérequis de livraison, pas une tâche de finition.
4. **Le lien doit apparaître dans le registre des traitements** et dans les CGU/DPA des deux apps.
   Le système de consentement Tracky (`UserConsent`, `CONSENT_VERSION`) existe déjà → un bump de
   version au déploiement.
5. **Rétention croisée.** Maestroo conserve 10 ans (comptable), Tracky purge à 60 j / 12 mois. Une
   donnée Tracky recopiée dans Maestroo **survivrait à la purge Tracky** → violation du principe de
   limitation. La classe B avec `expiresAt` aligné sur la rétention Tracky règle ça ; la classe C
   (identité véhicule) n'est pas concernée.

---

## 11. Risques identifiés

| # | Risque | Gravité | Parade |
|---|---|---|---|
| R1 | Purge déclenchée par une **panne** et non une révocation | 🔴 Critique | §5.3 — deux chemins distincts, révocation **signée**, grâce 72 h |
| R2 | Charge sur le VPS Tracky (2 vCPU) par le polling live | 🟠 Élevé | Servir depuis `Tracker.last*` + Redis 15 s ; jamais de requête `positions` ; rate-limit par lien |
| R3 | Rapprochement conducteur erroné (homonymes, pas de clé fiable) | 🟠 Élevé | Revue humaine **obligatoire** avant activation ; `PartnerEntityMap.confidence` ; jamais d'auto-match sous un seuil |
| R4 | Plaque réattribuée après revente d'un véhicule | 🟡 Moyen | Rapprochement daté ; alerte si la plaque change de marque/modèle |
| R5 | Attribution trajet↔mission ambiguë (4 missions/jour sur le même camion) | 🟠 Élevé | Fenêtre temporelle **+ géofence sur l'adresse client** ; proposition revue par l'humain, jamais silencieuse |
| R6 | Boucle de synchronisation infinie | 🟡 Moyen | Propriété par champ (§7) + marqueur `origin` non ré-émis |
| R7 | Backup Maestroo qui ressuscite le mirror | 🟠 Élevé | Table exclue du dump **+** re-check du lien au boot |
| R8 | Le client reconnecte le lien après une suspension pour impayé | 🔴 Critique (métier) | `suspendedByPlatform` = flag distinct, levable **uniquement** par le super-admin Tracky |
| R9 | Migration enum `AlertType` / `VehicleType` mal mappée | 🟢 Faible | Table de correspondance explicite, dégradation vers `OTHER`, jamais de devinette |
| R10 | Webhook de révocation perdu | 🟠 Élevé | Outbox + retry côté Tracky, **et** le pull 10 min couvre déjà le cas |

---

## 12. Décisions — toutes tranchées (2026-07-22)

| # | Question | ✅ Décision |
|---|---|---|
| **D1** | À la révocation, les **véhicules et conducteurs importés** (classe C) sont-ils supprimés ou conservés-dé-enrichis ? | **Conservés dé-enrichis.** Les supprimer casserait factures et missions Maestroo sans ajouter de levier commercial réel. |
| **D2** | Ordre de construction après le socle ? | **Le réel d'abord, la carte ensuite.** Phase 1 identité → phase 2 le réel (PRK, `actualKm`) → phase 3 carte live. |
| **D3** | Les données conducteur **nominatives** partent-elles vers Maestroo en v1 ? | **Oui, en v1** — mais **derrière des scopes vivants et extinguibles à tout moment** (§6.3). `DRIVING_BEHAVIOR` et `LIVE_POSITION` sont **OFF par défaut** ; le client peut couper « les scores » ou « la position & vitesse » indépendamment, sans casser le reste. Prérequis RGPD bloquants au §10.3. |

**Impact de D3 sur l'architecture** — c'est la décision qui a le plus de conséquences techniques :
le consentement n'est plus un instantané figé mais un **état vivant vérifié à chaque requête**, ce
qui impose la purge partielle par scope (`TrackyMirror.scope`, §8), la dégradation par bloc côté
Maestroo, et la resynchronisation complète au rallumage.

| **D4** | Un lien **1 Fleet ↔ 1 Organization**, ou N↔N ? | **1↔1 strict** — `@@unique([fleetId, partner])` **et** `TrackyLink.organizationId @unique`. Un groupe multi-sociétés est un cas réel mais rare : ne pas payer sa complexité maintenant. |
| **D5** | Direction **Maestroo → Tracky** dans le même chantier, ou après ? | **Après** (phase 4). Phases 0-3 = Tracky→Maestroo, là où est la valeur. Le socle §5-7 est symétrique par conception, donc rien ne sera à refaire. |
| **D6** | Le lien se pilote-t-il aussi depuis **vizyo-manager** ? | **Non.** L'interrupteur vit exclusivement dans l'admin Tracky. Exposable dans Manager plus tard si le besoin apparaît. |
| **D7** | Durée de **grâce** avant purge fail-closed sur silence prolongé ? | **72 h.** Couvre un week-end complet + une panne longue. |
| **D8** | Le connecteur est-il **inclus** dans l'abonnement, ou une option payante ? | **Pas de facturation pour le moment ; option payante plus tard.** Conséquence obligatoire ci-dessous. |

**Impact de D4 sur l'architecture** — l'unicité doit être posée **des deux côtés** dès la première
migration. Une flotte liée à deux orgs (ou l'inverse) rendrait la révocation ambiguë : purger « le »
lien ne voudrait plus rien dire. C'est une contrainte de base, pas une règle de service.

**Impact de D8 sur l'architecture — le point de vigilance.** Livrer le connecteur gratuitement puis
le rendre payant est le scénario le plus douloureux qui soit : on ne retire pas une fonctionnalité
déjà offerte à des clients sans conflit. Deux garde-fous, à poser **dès la phase 0** alors même
qu'on ne facture rien :

1. **Le point de contrôle existe dès le départ, désactivé.** Réutiliser le patron déjà en prod dans
   Tracky : `AiSubscription.status = COMP` (« offert par l'owner/super-admin, sans paiement »).
   Un `PartnerSubscription` calqué dessus — ou un simple `FleetSubscription.optIntegrations` — part
   à `COMP` pour tout le monde. Passer au payant devient **un changement d'état**, pas une refonte
   qui traverse tout le code.
2. **Le mot « offert » est affiché dès le premier jour.** L'écran Intégrations dit « inclus pendant
   la phase de lancement », pas rien du tout. La bascule est alors attendue au lieu d'être subie —
   et rien n'interdit de laisser les premiers clients en `COMP` à vie (grandfathering) si c'est le
   choix commercial.

⚠️ Ne **pas** confondre ce commutateur avec `PartnerLink.status` : la facturation et la révocation
sont deux axes indépendants. Un client peut être `COMP` (offert) **et** `SUSPENDED` (impayé sur son
abonnement Tracky principal).

---

## 13. Découpage proposé

> **Phase 0 avant tout le reste, et on ne code aucune donnée métier tant qu'elle n'est pas prouvée.**

| Phase | Contenu | Pourquoi cet ordre |
|---|---|---|
| **0 — Socle & interrupteur** | `PartnerLink` des deux côtés (**unicité D4 des deux côtés**), handshake, **tableau de bord des scopes vivants (§6.3)**, bail 10 min, révocation **totale ET partielle** (webhook + pull + gate), `TrackyMirror.scope`, audit `PartnerLinkEvent`, `suspendedByPlatform`, **point de facturation posé en `COMP` (D8)**, **tests e2e du kill-switch**, bouton dry-run | On **prouve la sécu avant de déplacer la moindre donnée**. Si le switch ne marche pas, rien d'autre ne doit exister. Purge **partielle** (D3), unicité (D4) et point de facturation (D8) sont **structurels** : les rajouter après serait une refonte, pas un ajout. |
| **1 — Identité** | Import véhicules + conducteurs, écran de rapprochement, marquage `origin`, tables de correspondance des enums | Peu risqué, effet « waouh » immédiat à la création du compte. Scopes `VEHICLE_IDENTITY` / `DRIVER_IDENTITY`. |
| **2 — Le réel (💰)** | `monthlyKm` → PRK, `Mission.actualKm/actualHours`, compteur, conso calibrée, carburant | **La vraie valeur business** *(décision D2)*. Scopes `MILEAGE_TRIPS` / `FUEL`. |
| **3 — Carte live** | Proxy Maestroo, cache Redis 15 s, widget carte (classe A stricte) | La démo. Ne coûte rien de plus une fois le socle posé. Scope `LIVE_POSITION` (OFF par défaut). |
| **3bis — Conduite nominative** | Éco-score, excès, freinages par conducteur | *(D3)* — **conditionnée à la mise à jour du DPA et du registre des traitements** (§10.3). Scope `DRIVING_BEHAVIOR` (OFF par défaut). |
| **4 — Retour Maestroo → Tracky** | Missions → agenda, documents conducteur → blocage moteur, identité légale, géofences auto sur adresses clients | Réutilise intégralement le socle phase 0 |
| **5 — Finitions** | Alertes unifiées, RSE/CO2, heures conducteur → paie, rapports croisés | — |

---

## 14. Ce que ce document ne tranche pas encore

- Choix de la lib carto côté Maestroo (MapLibre vs Leaflet) et son intégration au design system.
- Format exact de l'API partenaire (REST versionnée `/partner/v1/*` — à spécifier endpoint par
  endpoint).
- Que se passe-t-il si un véhicule est **supprimé** dans Tracky alors qu'il est référencé par une
  facture Maestroo (probablement : `origin` → `TRACKY_ORPHANED`, à confirmer).
- Wording exact de l'avertissement RGPD à l'activation du scope `DRIVING_BEHAVIOR` (§10.3) — à
  faire relire avant mise en service.
- Faut-il **notifier le client** (e-mail / bandeau) quand un scope est éteint côté plateforme, et
  avec quel message ? Un client qui voit ses données disparaître sans explication ouvre un ticket.
