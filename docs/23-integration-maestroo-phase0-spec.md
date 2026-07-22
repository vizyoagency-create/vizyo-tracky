# 23 — Intégration Tracky × Maestroo — SPEC PHASE 0 : socle & interrupteur

> Prérequis : [`22-integration-maestroo.md`](./22-integration-maestroo.md) (analyse, 8 décisions
> tranchées). Ce document est la spec d'implémentation de la **phase 0 uniquement**.
>
> **Règle d'or de cette phase : on livre et on PROUVE l'interrupteur avant de déplacer la moindre
> donnée métier.** Si le kill-switch n'est pas démontré par des tests, rien d'autre ne part.

---

## 1. Périmètre

### Dans la phase 0

| | |
|---|---|
| ✅ | `PartnerLink` (Tracky, autoritaire) + `TrackyLink` (Maestroo, consommateur) |
| ✅ | Handshake complet : code d'appairage, écran de consentement, remise du secret serveur-à-serveur |
| ✅ | Bail : jetons opaques 10 min, révocables en millisecondes via Redis |
| ✅ | **Révocation totale** (3 chemins : webhook signé + pull + gate de lecture) |
| ✅ | **Révocation partielle par scope** (§9.2) — structurelle, cf. décision D3 |
| ✅ | `suspendedByPlatform` (levier impayé, non levable par le client) |
| ✅ | Table de quarantaine `TrackyMirror` avec colonne `scope` |
| ✅ | Mode dégradé sur panne + grâce 72 h (décision D7) |
| ✅ | Point de facturation posé en `COMP` (décision D8) — aucun paiement branché |
| ✅ | Audit `PartnerLinkEvent` + `SystemActivityLog` catégorie `PARTNER` |
| ✅ | 3 écrans UI (Tracky client, Tracky super-admin, Maestroo) |
| ✅ | **Plan de test du kill-switch (§15)** — la livraison en dépend |
| ✅ | **Deux endpoints de données minimaux** (`ping` + `vehicles/count`) — le strict nécessaire pour prouver la chaîne fetch → mirror → purge |

### Hors phase 0 (explicitement)

Import de véhicules/conducteurs, `monthlyKm`, `Mission.actualKm`, carte live, scores de conduite,
sens Maestroo → Tracky, facturation réelle. **Aucun de ces sujets ne doit apparaître dans le code
de la phase 0**, même « en préparation ».

---

## 2. Registre des scopes — source unique

9 scopes, valeurs figées, **jamais renommées** (elles sont persistées en base des deux côtés).

| Clé | Libellé UI (FR) | Défaut | Phase qui l'exploite |
|---|---|---|---|
| `VEHICLE_IDENTITY` | Identité des véhicules | ON | 1 |
| `DRIVER_IDENTITY` | Identité des conducteurs | ON | 1 |
| `MILEAGE_TRIPS` | Kilométrage et trajets | ON | 2 |
| `FUEL` | Carburant et consommation réelle | ON | 2 |
| `MAINTENANCE` | Entretien, incidents, immobilisations | ON | 2 |
| `DRIVER_HOURS` | Heures de conduite (sans position) | ON | 5 |
| `ALERTS` | Alertes Tracky | ON | 5 |
| `LIVE_POSITION` | **Position et vitesse en temps réel** | **OFF** | 3 |
| `DRIVING_BEHAVIOR` | **Comportement de conduite (nominatif)** | **OFF** | 3bis |

**Où le déclarer :**
- Tracky → `packages/shared/src/partner/scopes.ts` (+ `export * from './partner'` dans `index.ts`)
- Maestroo → `packages/shared/src/enums/partner-scopes.ts`

Les deux repos sont indépendants : **la parité est garantie par un test** de chaque côté qui compare
la liste à un littéral figé. Toute divergence casse la CI. Ajouter un scope = modifier les deux
listes **et** les deux tests, dans la même PR fonctionnelle.

```ts
// packages/shared/src/partner/scopes.ts  (identique des deux côtés, aux noms de fichiers près)
export const PARTNER_SCOPES = [
  'VEHICLE_IDENTITY', 'DRIVER_IDENTITY', 'MILEAGE_TRIPS', 'FUEL', 'MAINTENANCE',
  'DRIVER_HOURS', 'ALERTS', 'LIVE_POSITION', 'DRIVING_BEHAVIOR',
] as const;
export type PartnerScope = (typeof PARTNER_SCOPES)[number];

/** Scopes activés à la création d'un lien (LIVE_POSITION et DRIVING_BEHAVIOR restent OFF). */
export const PARTNER_SCOPES_DEFAULT_ON: readonly PartnerScope[] = [
  'VEHICLE_IDENTITY', 'DRIVER_IDENTITY', 'MILEAGE_TRIPS', 'FUEL', 'MAINTENANCE',
  'DRIVER_HOURS', 'ALERTS',
];
```

---

## 3. Modèle de données

### 3.1 — Tracky (autoritaire)

```prisma
enum PartnerLinkStatus {
  ACTIVE
  SUSPENDED // coupé (client OU plateforme) — réversible
  REVOKED   // TERMINAL : on ne réactive pas, on refait un handshake
}
// ⚠️ CORRECTION apportée à l'implémentation (incr. 0.2) : PENDING a été RETIRÉ de
// l'énum Tracky. Le lien n'est créé qu'à `approve`, donc directement ACTIVE — une
// valeur PENDING n'aurait jamais été écrite. PENDING reste côté Maestroo, où il est
// réel (un code d'appairage est en attente). Ajouter une valeur à un enum Postgres
// est trivial (`ALTER TYPE ... ADD VALUE`), en retirer une est douloureux : on
// n'anticipe pas.

/// Lien de partage de données entre une flotte Tracky et une organisation partenaire.
/// AUTORITAIRE : la copie côté partenaire n'est qu'un cache de « ai-je encore le droit ».
model PartnerLink {
  id                  String            @id @default(uuid()) @db.Uuid
  fleetId             String            @db.Uuid
  fleet               Fleet             @relation(fields: [fleetId], references: [id], onDelete: Cascade)
  /// 'MAESTROO' — extensible à d'autres partenaires sans migration.
  partner             String
  externalOrgId       String
  externalOrgName     String
  externalOrgSiret    String?

  status              PartnerLinkStatus @default(ACTIVE)
  /// Créneau d'unicité — vaut `partner` tant que le lien est VIVANT, NULL une fois
  /// révoqué. Voir l'encadré « unicité » ci-dessous.
  liveKey             String?
  /// D8 — 'COMP' (offert) | 'ACTIVE' (payant) | 'NONE'. Aucun paiement branché en phase 0.
  /// Patron repris de AiSubscription.status : passer au payant = un changement d'état.
  billingStatus       String            @default("COMP")

  /// ⚠️ Suspension PLATEFORME (impayé) — DISTINCTE de `status`. Quand true, le client ne peut
  /// NI réactiver, NI refaire un handshake. Seul un SUPER_ADMIN Tracky peut la lever.
  suspendedByPlatform Boolean           @default(false)
  suspendedReason     String?

  /// Scopes ACTIFS (PartnerScope[]). État VIVANT, vérifié à chaque requête — pas un instantané.
  scopes              Json

  /// Secret de lien (remis une seule fois au partenaire). Stocké HASHÉ, jamais en clair.
  secretHash          String
  secretRotatedAt     DateTime?

  createdByUserId     String?           @db.Uuid
  approvedByUserId    String?           @db.Uuid
  approvedAt          DateTime?
  lastSeenAt          DateTime?
  revokedAt           DateTime?
  revokedReason       String?
  createdAt           DateTime          @default(now())
  updatedAt           DateTime          @updatedAt

  events              PartnerLinkEvent[]
  tokens              PartnerAccessToken[]
  outbox              PartnerOutboxEvent[]

  /// D4 — au plus UN lien VIVANT par (flotte, partenaire) et par (org, partenaire).
  @@unique([fleetId, liveKey])
  @@unique([externalOrgId, liveKey])
  @@index([fleetId])
  @@index([status])
  @@map("partner_links")
}

/// Journal IMMUABLE du lien (jamais purgé : c'est la preuve de qui a coupé quoi et quand).
model PartnerLinkEvent {
  id        String      @id @default(uuid()) @db.Uuid
  linkId    String      @db.Uuid
  link      PartnerLink @relation(fields: [linkId], references: [id], onDelete: Cascade)
  /// 'created'|'approved'|'scope_enabled'|'scope_disabled'|'suspended'|'resumed'
  /// |'platform_suspended'|'platform_resumed'|'revoked'|'secret_rotated'
  action    String
  /// 'USER'|'PLATFORM'|'PARTNER'|'SYSTEM'
  actorType String
  actorId   String?     @db.Uuid
  scope     String?
  detail    String?
  createdAt DateTime    @default(now())

  @@index([linkId, createdAt(sort: Desc)])
  @@map("partner_link_events")
}

/// Jeton d'accès opaque (bail). Redis est le chemin chaud ; cette table est la source de vérité.
model PartnerAccessToken {
  id        String      @id @default(uuid()) @db.Uuid
  linkId    String      @db.Uuid
  link      PartnerLink @relation(fields: [linkId], references: [id], onDelete: Cascade)
  tokenHash String      @unique
  expiresAt DateTime
  revokedAt DateTime?
  createdAt DateTime    @default(now())

  @@index([linkId, expiresAt])
  @@map("partner_access_tokens")
}

/// Outbox des webhooks sortants — un webhook de révocation PERDU est une révocation perdue.
model PartnerOutboxEvent {
  id            String      @id @default(uuid()) @db.Uuid
  linkId        String      @db.Uuid
  link          PartnerLink @relation(fields: [linkId], references: [id], onDelete: Cascade)
  /// 'link.revoked' | 'link.suspended' | 'link.resumed' | 'scope.revoked' | 'scope.granted'
  type          String
  payload       Json
  attempts      Int         @default(0)
  nextAttemptAt DateTime    @default(now())
  deliveredAt   DateTime?
  lastError     String?
  createdAt     DateTime    @default(now())

  @@index([deliveredAt, nextAttemptAt])
  @@map("partner_outbox_events")
}
```

**À ajouter aussi côté Tracky** : `Fleet.partnerLinks PartnerLink[]`, et
`SystemActivityLog.category` accepte `'PARTNER'` (champ String libre → aucune migration).

### 3.2 — Maestroo (consommateur)

```prisma
enum TrackyLinkStatus {
  PENDING
  ACTIVE
  DEGRADED  // ⚠️ état LOCAL : Tracky injoignable. N'existe PAS côté Tracky. Jamais de purge ici.
  SUSPENDED
  REVOKED
}

model TrackyLink {
  id             String           @id @default(uuid()) @db.Uuid
  organizationId String           @unique @db.Uuid   // D4 — 1↔1
  organization   Organization     @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  /// Id du PartnerLink côté Tracky (autoritaire).
  remoteLinkId   String?
  fleetName      String?

  status         TrackyLinkStatus @default(PENDING)
  /// Miroir des scopes annoncés par Tracky. JAMAIS édité localement.
  scopes         Json             @default("[]")

  /// Secret de lien CHIFFRÉ au repos (AES-256-GCM, clé = TRACKY_LINK_SECRET_KEY).
  secretCipher   String?
  secretIv       String?
  secretTag      String?

  /// Code d'appairage en attente (handshake), effacé à l'activation.
  pairingCode      String?        @unique
  pairingExpiresAt DateTime?
  requestedByUserId String?       @db.Uuid

  lastSyncAt     DateTime?
  lastErrorAt    DateTime?
  lastErrorKind  String?          // 'NETWORK'|'HTTP_5XX'|'HTTP_4XX'|'SIGNATURE'
  degradedSince  DateTime?
  revokedAt      DateTime?
  createdAt      DateTime         @default(now())
  updatedAt      DateTime         @updatedAt

  @@index([status])
  @@map("tracky_links")
}

/// CLASSE B — quarantaine. AUCUNE FK vers les tables métier : la purge est un seul DELETE.
/// ⚠️ `scope` est ce qui rend la purge PARTIELLE possible (décision D3).
model TrackyMirror {
  id        String   @id @default(uuid()) @db.Uuid
  linkId    String   @db.Uuid
  scope     String   // PartnerScope — un `kind` appartient à EXACTEMENT un scope
  kind      String
  refId     String   // id de l'objet Maestroo concerné — string libre, PAS de FK
  payload   Json
  fetchedAt DateTime @default(now())
  expiresAt DateTime

  @@unique([linkId, kind, refId])
  @@index([linkId, scope])   // purge partielle
  @@index([expiresAt])       // expiration passive
  @@map("tracky_mirror")
}
```

⚠️ **Aucune modification des tables métier Maestroo en phase 0.** `Vehicle.origin` / `Driver.origin`
(classe C) arrivent en **phase 1**, avec l'import.

### 3.2bis — ⚠️ Unicité : le piège du `@@unique([fleetId, partner])` naïf

**Découvert à l'implémentation (incr. 0.2).** La version naïve interdirait
**définitivement** de se reconnecter après une révocation : on conserve la ligne
révoquée (c'est la preuve de qui a coupé quoi), donc elle occuperait le créneau à vie.
Le client qui révoque par erreur ne pourrait plus jamais se reconnecter.

D'où **`liveKey`** : il vaut `partner` tant que le lien est vivant, et passe à `NULL` à
la révocation. Postgres ne fait pas conflit sur les `NULL` dans un index unique — on
obtient donc « au plus UN lien vivant » **tout en gardant un historique illimité**.

Vérifié en SQL réel sur base jetable (6 cas) :

| Cas | Attendu | Résultat |
|---|---|---|
| 1er lien vivant sur la flotte A | passe | ✅ |
| 2ᵉ lien vivant sur la **même flotte** | rejeté par la base | ✅ `partner_links_fleetId_liveKey_key` |
| Autre flotte vers la **même org Maestroo** | rejeté par la base | ✅ `partner_links_externalOrgId_liveKey_key` |
| Révocation (`liveKey → NULL`) puis **re-appairage** | passe | ✅ |
| 2 lignes révoquées sur la même flotte | passent (historique) | ✅ |
| État final | 1 ACTIVE + 2 REVOKED | ✅ |

> **Pourquoi pas un index partiel** (`WHERE revoked_at IS NULL`) ? Parce que Prisma ne
> sait pas le représenter dans `schema.prisma` : il faudrait l'écrire à la main dans la
> migration, et *chaque* `migrate dev` ultérieur croirait l'index manquant et tenterait
> de le recréer. **C'est exactement ce qui bloque `prisma migrate dev` côté Maestroo
> aujourd'hui** (cf. §14.4). Le créneau nullable obtient la même garantie en Prisma pur.

### 3.3 — Contraintes de migration

1. `partner_links` : les deux `@@unique` sont posés **dès la première migration** (D4).
2. `tracky_mirror` **doit être exclue des dumps** — cf. §14.3.
3. Aucune FK depuis `tracky_mirror`. Un reviewer qui voit une FK partir de cette table doit refuser
   la PR : elle défait toute la garantie de purge.

---

## 4. Machine à états du lien

```
                 approve (Tracky)
   PENDING ──────────────────────────► ACTIVE ◄──────────┐
      │                                  │               │
      │ expiration 15 min                │ suspend       │ resume
      │ ou refus                         ▼               │
      ▼                              SUSPENDED ──────────┘
   (supprimé)                            │
                                         │ revoke
                        revoke           ▼
   ACTIVE / SUSPENDED ─────────────► REVOKED  (TERMINAL)
```

- `REVOKED` est **terminal**. On ne « réactive » pas : on refait un handshake complet, ce qui
  reconstruit le consentement — sauf si `suspendedByPlatform = true`, auquel cas le nouveau
  handshake est **refusé** (§9.4).
- `DEGRADED` n'existe **que côté Maestroo** et **ne déclenche jamais de purge** (§10).
- `suspendedByPlatform` est **orthogonal** : il peut être levé/posé quel que soit `status`.

---

## 5. Amorçage de la confiance — secret de plateforme

**Problème** : au moment du handshake, les deux apps ne partagent aucun secret. Impossible de
vérifier quoi que ce soit.

**Solution** : un **secret de plateforme** (pas par client), partagé entre les deux déploiements —
ce sont nos deux apps, déployées par nous. Il ne sert **qu'au handshake** et aux webhooks.

| | Tracky | Maestroo |
|---|---|---|
| Variable | `PARTNER_PLATFORM_SECRET` | `TRACKY_PARTNER_PLATFORM_SECRET` |
| Même valeur | ✅ | ✅ |
| Rotation | manuelle, coordonnée (les liens existants ne sont pas affectés : ils ont leur propre `linkSecret`) | |

Ensuite, **chaque lien a son propre secret** (`linkSecret`, 32 octets), remis une seule fois. C'est
lui qui signe les demandes de jeton. Compromission d'un lien ≠ compromission de la plateforme.

**Signature** (implémentée à l'incr. 0.3) :

```
canonique = `${timestamp}.${METHOD}.${op}.${rawBody}`   // rawBody = '' pour un GET
signature = HMAC-SHA256(secret, canonique) en hex minuscule (64 car.)
headers   = X-Partner-Timestamp, X-Partner-Signature
drift max = 300 s   |   comparaison timingSafeEqual sur les OCTETS
```

#### ⚠️ Écart délibéré par rapport au schéma Vizyo Auth (`timestamp.rawBody`)

La spec initiale prévoyait de réutiliser le schéma maison tel quel. **L'implémentation a
montré qu'il ne convient pas ici**, pour deux raisons :

1. **Une signature Vizyo Auth est valide sur N'IMPORTE QUEL endpoint.** Le cas le plus
   net : tous les GET ont un corps vide, donc `GET /partner/v1/ping` et
   `GET /partner/v1/vehicles/count` produisent **la même signature à la même seconde**.
   Une signature capturée sur l'un ouvre l'autre. Lier la méthode et l'opération ferme
   la classe entière du rejeu inter-endpoints. *(Prouvé par test : les deux GET donnent
   désormais des empreintes différentes.)*

2. **`op` est un identifiant STABLE, pas le chemin d'URL.** Signer le chemin serait plus
   naturel mais rendrait la crypto dépendante du routage : un préfixe ajouté ou retiré
   par Traefik (ou par `API_BASE_PATH` côté Maestroo) ferait échouer **toutes** les
   signatures — panne totale, silencieuse, très difficile à diagnostiquer. On a déjà vu
   ce type de surprise en prod (incident Traefik du 2026-07-21). Émetteur et récepteur
   codent en dur la même constante `op` par route ; **le récepteur n'accepte jamais un
   `op` fourni par l'appelant**, il utilise le sien — l'attaquant n'a aucune prise.

Le schéma Vizyo Auth reste inchangé là où il est imposé
(`maestroo/apps/api/src/vizyo-webhooks/`) : les deux coexistent volontairement.

**Parité entre les deux repos** : garantie par des **vecteurs de test figés** identiques
des deux côtés (ils épinglent le format du fil), + une preuve d'interopérabilité croisée
exécutée à l'incr. 0.3 — Tracky signe / Maestroo vérifie **et l'inverse**, altérations
détectées d'une implémentation à l'autre.

> ⚠️ **Ne PAS réutiliser `INTERNAL_API_SECRET`** (Tracky `/internal`) : secret statique sans
> timestamp ni anti-rejeu, qui donne accès à `fleet/suspend` et à la création de comptes. Le
> partager avec Maestroo étendrait massivement le rayon d'explosion.

---

## 6. Handshake — séquence complète

```
  Maestroo (navigateur)      Maestroo API              Tracky API           Tracky (navigateur)
         │                        │                        │                        │
  [Connecter Tracky]              │                        │                        │
         ├───────────────────────►│                        │                        │
         │   POST /integrations/tracky/link                │                        │
         │                        ├─ TrackyLink(PENDING)   │                        │
         │                        ├─ code TRK-XXXX-XXXX (15 min)                    │
         │◄───────────────────────┤  { code, trackyUrl }   │                        │
         │  affiche le code + bouton « Ouvrir Tracky »     │                        │
         │                        │                        │                        │
         │                    (le client passe dans Tracky, colle le code)          │
         │                        │                        │◄───────────────────────┤
         │                        │                        │  POST /integrations/partner/claim
         │                        │◄───────────────────────┤   (signé secret plateforme)
         │                        │  GET /partner/v1/pairing/{code}                 │
         │                        ├───────────────────────►│  { orgId, orgName, siret,
         │                        │                        │    requestedBy, expiresAt }
         │                        │                        ├───────────────────────►│
         │                        │                        │  ÉCRAN DE CONSENTEMENT │
         │                        │                        │◄───────────────────────┤
         │                        │                        │  POST .../approve { code, scopes }
         │                        │                        ├─ PartnerLink(ACTIVE)
         │                        │                        ├─ linkSecret (32o), stocké hashé
         │                        │◄───────────────────────┤
         │                        │  POST /partner/v1/pairing/{code}/complete
         │                        │  { remoteLinkId, fleetName, linkSecret, scopes }
         │                        ├─ chiffre + stocke, TrackyLink(ACTIVE)
         │                        ├───────────────────────►│  200
         │◄───────────────────────┴────────────────────────┴───────────────────────►│
                          les deux écrans affichent « connecté »
```

**Points non négociables :**

1. **Le `linkSecret` ne transite jamais par un navigateur.** Uniquement serveur-à-serveur, sur une
   requête signée du secret de plateforme, en HTTPS.
2. **Le code d'appairage est un handle opaque, pas un porteur de données.** Tracky va chercher les
   détails chez Maestroo. Conséquence : le code peut être court et lisible (12 caractères,
   alphabet sans ambiguïté `ABCDEFGHJKMNPQRSTUVWXYZ23456789`), et il est **rate-limité** (§11).
3. **`claim` n'active rien.** Il ne fait que résoudre le code et afficher l'écran de consentement.
   L'activation, c'est `approve`, et c'est un acte explicite du `FLEET_ADMIN`.
4. **Parcours 1 clic** : Maestroo affiche un bouton vers
   `${TRACKY_WEB_URL}/integrations?code=TRK-XXXX-XXXX` qui pré-remplit le champ. Aucun endpoint
   supplémentaire, et le consentement reste explicite.
5. **Le code expire en 15 min** et est **à usage unique** (consommé par `complete`).

---

## 7. Le bail (jetons)

| | |
|---|---|
| Type | **Opaque** (32 octets aléatoires, base64url) — pas un JWT |
| TTL | 600 s (`PARTNER_TOKEN_TTL_SECONDS`) |
| Émission | `POST /partner/v1/token`, en-têtes `X-Partner-Link` + `X-Partner-Secret` |
| Validation | Lecture DB (`PartnerAccessToken`) — jeton **et** état du lien, à chaque appel |
| Révocation | `revokedAt` sur les jetons **+** statut du lien ⇒ **deux barrières indépendantes** |

#### ⚠️ Deux corrections apportées à l'implémentation (incr. 0.5)

1. **La demande de jeton n'est pas signée en HMAC.** La spec disait à la fois « le
   `linkSecret` signe les demandes de bail » **et** « `secretHash` — stocké hashé, jamais
   en clair ». C'est **incompatible** : on ne peut pas vérifier un HMAC avec une
   empreinte. On conserve le stockage à **sens unique** (propriété la plus forte : un
   dump de la base ne donne aucun secret utilisable) et le secret est présenté comme une
   **crédence** sur TLS, comparée en temps constant. C'est le fonctionnement de toute clé
   d'API ; le secret ne circule que sur cet unique endpoint.

2. **Pas de cache Redis pour la validation.** Un cache introduit une **fenêtre** pendant
   laquelle un jeton révoqué reste valide — précisément ce que le lot 0 supprime. Le
   trafic partenaire est minuscule ici (un jeton toutes les 10 min) : on lit la base,
   sans fenêtre. Redis redeviendra pertinent en **phase 3** (sondage de la carte live),
   avec un TTL borné par le délai de révocation acceptable. *(Redis n'est de toute façon
   pas encore câblé dans Nest — seulement dans l'adaptateur socket.io.)*

**Deux barrières indépendantes à la validation** : le jeton (existe / non révoqué / non
expiré) **et** l'état du lien, vérifiés à chaque appel. Révoquer le lien suffit donc à
couper l'accès même si la purge des jetons échouait.

> **Pourquoi opaque et pas JWT** : un JWT reste valide jusqu'à son expiration, donc jusqu'à 10 min
> **après** la coupure. Avec un jeton opaque adossé à Redis, la révocation est immédiate. Le TTL de
> 10 min devient le **filet de sécurité** (si la purge Redis échoue), plus le chemin normal.

**La réponse de `token` porte les scopes autoritaires** :

```json
{ "accessToken": "…", "expiresIn": 600,
  "scopes": ["VEHICLE_IDENTITY","MILEAGE_TRIPS"],
  "linkStatus": "ACTIVE" }
```

Maestroo **compare à son état local à chaque renouvellement** : tout scope disparu ⇒ purge de ce
scope. C'est le second chemin de la révocation partielle, indépendant du webhook.

---

## 8. Contrat d'API

### 8.1 — Tracky, API partenaire (`/partner/v1/*`) — Bearer = jeton de bail

| Méthode | Route | Scope requis | Réponse |
|---|---|---|---|
| `POST` | `/partner/v1/token` | — (signé `linkSecret`) | `{ accessToken, expiresIn, scopes, linkStatus }` |
| `GET` | `/partner/v1/ping` | — | `{ linkId, fleetName, status, scopes, serverTime }` |
| `GET` | `/partner/v1/vehicles/count` | `VEHICLE_IDENTITY` | `{ total, active }` |

Les deux endpoints de données existent **uniquement pour prouver la chaîne** fetch → mirror →
purge. Rien d'autre n'est exposé en phase 0.

### 8.2 — Tracky, API client (JWT Tracky) — `/integrations/*`

| Méthode | Route | Rôle / permission | Effet |
|---|---|---|---|
| `GET` | `/integrations/partner` | `integrations_manage` | État du lien, scopes, 20 derniers événements |
| `POST` | `/integrations/partner/claim` | `integrations_manage` | Résout un code → aperçu. **N'active rien** |
| `POST` | `/integrations/partner/approve` | `integrations_manage` | Crée le lien `ACTIVE`, remet le secret |
| `PATCH` | `/integrations/partner/scopes` | `integrations_manage` | `{ scope, enabled }` → révocation/octroi partiel |
| `POST` | `/integrations/partner/suspend` | `integrations_manage` | Coupe (réversible par le client) |
| `POST` | `/integrations/partner/resume` | `integrations_manage` | Rétablit — **refusé si `suspendedByPlatform`** |
| `DELETE` | `/integrations/partner` | `integrations_manage` | Révocation définitive |

### 8.3 — Tracky, super-admin — `/admin/partner-links/*`

| Méthode | Route | Effet |
|---|---|---|
| `GET` | `/admin/partner-links` | Tous les liens, toutes flottes |
| `GET` | `/admin/partner-links/:id/revocation-preview` | **DRY-RUN** : ce qui disparaîtrait, par scope et par catégorie (interroge Maestroo, n'écrit rien) |
| `POST` | `/admin/partner-links/:id/platform-suspend` | `suspendedByPlatform = true` + raison |
| `POST` | `/admin/partner-links/:id/platform-resume` | Lève le drapeau |
| `PATCH` | `/admin/partner-links/:id/billing` | `billingStatus` : `COMP` ↔ `ACTIVE` (D8) |

Gardes : `@Roles(UserRole.SUPER_ADMIN)`. Ces routes sont journalisées dans `SystemActivityLog`
catégorie `PARTNER` — ce sont des actes à conséquence financière pour le client.

### 8.4 — Maestroo, API partenaire (`/partner/v1/*`) — signé secret de plateforme

| Méthode | Route | Effet |
|---|---|---|
| `GET` | `/partner/v1/pairing/:code` | Détails de la demande (org, demandeur, expiration) |
| `POST` | `/partner/v1/pairing/:code/complete` | Reçoit `linkSecret` + scopes, active le `TrackyLink` |
| `POST` | `/partner/v1/webhooks` | Reçoit `link.*` / `scope.*` |

### 8.5 — Maestroo, API client (JWT Maestroo) — `/integrations/tracky/*`

| Méthode | Route | Rôle |
|---|---|---|
| `GET` | `/integrations/tracky` | `OWNER`, `ADMIN` |
| `POST` | `/integrations/tracky/link` | `OWNER`, `ADMIN` — crée le code |
| `DELETE` | `/integrations/tracky` | `OWNER`, `ADMIN` — révoque de son côté |

---

## 9. Révocation

### 9.1 — Totale

Trois chemins **indépendants**, tous obligatoires :

| # | Chemin | Latence | Couvre |
|---|---|---|---|
| 1 | **Push** — webhook `link.revoked` signé, via l'outbox avec retry exponentiel (0 s, 30 s, 2 min, 10 min, 1 h ×5) | ~1 s | Le cas nominal |
| 2 | **Pull** — le renouvellement de jeton répond `403 LINK_REVOKED` signé | ≤ 10 min | Webhook perdu, Maestroo redémarré |
| 3 | **Gate de lecture** — chaque route Maestroo servant du Tracky vérifie `status === 'ACTIVE'` avant de répondre | immédiat | Purge en cours, incohérence transitoire |

Côté Tracky, `revoke()` est **atomique** : `status = REVOKED` + `DEL` des jetons Redis +
`revokedAt` sur les `PartnerAccessToken` + `PartnerLinkEvent` + insertion outbox — **dans une seule
transaction**, l'outbox étant vidée après commit.

Côté Maestroo, `purge(linkId)` :
1. `DELETE FROM tracky_mirror WHERE link_id = ?`
2. `DELETE FROM alerts WHERE organization_id = ? AND source_type = 'TRACKY'`
3. `TrackyLink.status = REVOKED`, `secretCipher = null`, `scopes = []`
4. Vide le cache Redis/mémoire des projections (classe A)
5. Journalise

### 9.2 — Partielle (extinction d'un scope) — décision D3

Même machinerie, filtrée :

```sql
DELETE FROM tracky_mirror WHERE link_id = ? AND scope = ?;
```

- Webhook `scope.revoked` `{ linkId, scope, revokedAt, signature }` → purge ciblée.
- **Et** la comparaison des scopes au renouvellement du jeton (§7) rattrape un webhook perdu.
- L'UI Maestroo dégrade **le bloc concerné uniquement** (« non partagé par Tracky »), jamais la page.
- **Rallumer = resynchronisation complète de la catégorie.** Pas de reprise incrémentale depuis un
  `lastSyncAt` périmé : on ressusciterait des données obsolètes.

### 9.3 — La réponse de révocation doit être SIGNÉE

Un simple code HTTP ne suffit pas : le `404 page not found` de Traefik pendant l'incident du
2026-07-21 ressemblait à un 404 applicatif. Un code non signé **ne doit jamais** déclencher de purge.

```json
{
  "error": "LINK_REVOKED",
  "linkId": "…",
  "revokedAt": "2026-07-22T10:00:00.000Z",
  "nonce": "…",
  "signature": "hmac_sha256(PLATFORM_SECRET, `${linkId}.${revokedAt}.${nonce}.LINK_REVOKED`)"
}
```

Maestroo **vérifie la signature avant toute purge**. Signature absente ou invalide ⇒ traité comme
une **panne** (§10), pas comme une révocation.

### 9.4 — `suspendedByPlatform` — le levier impayé

- Posé par un `SUPER_ADMIN` Tracky uniquement.
- Tant qu'il est levé : `/integrations/partner/resume` ⇒ `403`, et **un nouveau handshake sur la
  même flotte est refusé** (`POST /claim` ⇒ `403 PARTNER_LINK_PLATFORM_SUSPENDED`).
- Sans ce refus au niveau du handshake, le client révoque, recommence, et le levier ne vaut rien.
- Message client explicite : « Votre accès à l'intégration a été suspendu. Contactez Tracky. »

---

## 10. Panne ≠ révocation

| Signal reçu par Maestroo | Interprétation | Action |
|---|---|---|
| `403` **signature valide** `LINK_REVOKED` | Révocation | **Purge immédiate** |
| `403` **signature valide** `LINK_SUSPENDED` | Suspension | Purge classe A+B, statut `SUSPENDED`, bannière |
| `403`/`404`/`5xx` **sans signature valide** | **Suspect — panne probable** | **Aucune purge.** `DEGRADED` |
| Timeout, DNS, ECONNREFUSED | Panne | **Aucune purge.** `DEGRADED` |
| Aucun renouvellement réussi depuis **72 h** (D7) | Silence prolongé | Purge **classe B** fail-closed + log `CRITICAL` + e-mail owner. Le lien reste `DEGRADED`, pas `REVOKED` |

**Alerte** : dès **2 échecs consécutifs** de renouvellement (anti-flapping), on écrit une erreur
`CRITICAL` et on laisse la vigie e-mail existante l'envoyer — même patron que
`DependencyHeartbeatService`. Ne pas dupliquer la plomberie d'envoi.

En mode `DEGRADED`, l'UI Maestroo affiche « Données Tracky non rafraîchies depuis {durée} » sur les
blocs concernés, **et continue de les afficher**. C'est volontaire : une panne de notre côté ne doit
pas ressembler à une sanction commerciale pour le client.

---

## 11. Sécurité

| Sujet | Règle |
|---|---|
| Secret de plateforme | Handshake + webhooks uniquement. Jamais dans un navigateur, jamais loggé |
| Secret de lien | 32 octets, remis **une seule fois**, stocké **hashé** côté Tracky, **chiffré AES-256-GCM** côté Maestroo. Rotation possible sans refaire le handshake |
| Anti-rejeu | Drift 300 s + `timingSafeEqual`. Les webhooks portent un `eventId` idempotent |
| Rate limit | `POST /claim` : **5 tentatives / 15 min / utilisateur** (le code est court, il doit être inbruteforçable). `POST /token` : 30/min/lien. `/partner/v1/*` : 120/min/lien |
| Fuite cross-tenant | Tout accès partenaire est scopé par `link.fleetId`. Aucune route ne prend un `fleetId` du client |
| Cache navigateur | `Cache-Control: no-store` sur **toutes** les routes proxy Maestroo servant du Tracky |
| Logs | Interdiction de logger les payloads partenaires en clair. Masquage `lat`/`lng`/`speed` au niveau du logger |
| Ce qu'on ne fait **pas** | Pas de JWT Tracky émis à Maestroo. Pas d'accès WS. Pas de réutilisation d'`INTERNAL_API_SECRET`. Le navigateur ne parle jamais à Tracky |

---

## 12. Erreurs

**Tracky** — exceptions Nest classiques (pas de catalogue centralisé dans ce repo) :

| Code | HTTP | Message FR |
|---|---|---|
| `PARTNER_CODE_INVALID` | 404 | « Code d'appairage introuvable ou expiré » |
| `PARTNER_CODE_CONSUMED` | 409 | « Ce code a déjà été utilisé » |
| `PARTNER_LINK_EXISTS` | 409 | « Cette flotte est déjà connectée à Maestroo » |
| `PARTNER_LINK_PLATFORM_SUSPENDED` | 403 | « Votre accès à l'intégration a été suspendu. Contactez Tracky. » |
| `PARTNER_SCOPE_DENIED` | 403 | « Cette catégorie de données n'est pas partagée » |
| `PARTNER_TOKEN_INVALID` | 401 | « Jeton partenaire invalide ou expiré » |
| `PARTNER_SIGNATURE_INVALID` | 401 | « Signature invalide » |

**Maestroo** — à ajouter dans `apps/api/src/common/errors/error-catalog.ts` + l'enum `ErrorCode`
de `@maestroo/shared` (les deux, sinon TS refuse) :

| Code | HTTP | Message FR |
|---|---|---|
| `TRACKY_LINK_NOT_FOUND` | 404 | « Aucune intégration Tracky configurée » |
| `TRACKY_LINK_REVOKED` | 403 | « L'accès Tracky a été révoqué » |
| `TRACKY_LINK_SUSPENDED` | 403 | « L'accès Tracky est suspendu » |
| `TRACKY_LINK_DEGRADED` | 503 | « Tracky est momentanément injoignable » |
| `TRACKY_PAIRING_EXPIRED` | 410 | « Le code d'appairage a expiré » |
| `TRACKY_SCOPE_UNAVAILABLE` | 403 | « Cette donnée n'est pas partagée par Tracky » |

---

## 13. UI

### 13.1 — Tracky : `/integrations` (client, `integrations_manage`)

- **Non connecté** : explication + champ « Coller le code Maestroo » + bouton *Vérifier*.
- **Écran de consentement** (après `claim`) : nom de l'organisation, SIRET, **qui a fait la
  demande**, puis les 9 scopes en interrupteurs. `LIVE_POSITION` et `DRIVING_BEHAVIOR` sont **OFF**
  et portent un avertissement explicite (§10.3 du doc 22 pour `DRIVING_BEHAVIOR`).
- **Connecté** : statut, date de connexion, dernière activité, **les 9 interrupteurs modifiables à
  tout moment**, journal des 20 derniers événements, bouton rouge *Révoquer* avec confirmation
  saisie (taper le nom de l'organisation).

### 13.2 — Tracky : `/admin/partner-links` (super-admin)

Tableau de tous les liens (flotte, org, statut, scopes actifs, `billingStatus`, dernière activité).
Actions par ligne : **Aperçu de coupure (dry-run)**, *Suspendre (plateforme)*, *Rétablir*,
*Basculer COMP ↔ payant*. La suspension exige une raison — elle est affichée au client.

### 13.3 — Maestroo : `/integrations/tracky` (OWNER/ADMIN)

État, code d'appairage avec bouton *Ouvrir Tracky*, catégories reçues (lecture seule — **les
interrupteurs sont chez Tracky**, avec un lien explicite), dernière synchro, bandeau `DEGRADED` le
cas échéant, bouton *Déconnecter*.

> ⚠️ Design system Maestroo : classes utility uniquement, **aucun style inline, aucune couleur hex**,
> `var(--color-*)`, tokens de durée et de z-index. `pnpm --filter @maestroo/web lint:all` doit
> passer — une violation bloque le commit.

---

## 14. Câblage & exploitation

### 14.1 — Permission Tracky `integrations_manage`

Nouvelle clé dans `UserPermissions`. Défauts : `FLEET_ADMIN` ✅, `SUPER_ADMIN` ✅ (bypass),
`FLEET_MANAGER` ❌, `VIEWER` ❌, `NIGHT_WATCHMAN` ❌, `DRIVER` ❌.

Points de câblage (relevés sur le précédent `schedules_manage`) — **les 6 sont obligatoires**,
les tests de complétude de `permissions.spec.ts` échouent bruyamment sinon :

1. `packages/shared/src/permissions/permissions.ts` — interface + `PERMISSION_KEYS`
2. idem — `PERMISSION_LABELS` (libellé FR)
3. idem — défauts de **chacun** des rôles
4. **rebuild de `packages/shared`** (piège connu, cf. mémoire `tracky_lieux_cles`)
5. `apps/web/src/app/features/users/access-matrix-editor.component.ts` — la matrice d'invitation
6. `apps/web/src/app/app.routes.ts` — garde de la route `/integrations`

### 14.2 — Variables d'environnement

**Tracky** (`apps/api/src/config/env.validation.ts`) :

| Variable | Défaut | Rôle |
|---|---|---|
| `PARTNER_MAESTROO_ENABLED` | `false` | **Kill-switch de déploiement** — tout est inerte tant qu'il est à `false` |
| `PARTNER_MAESTROO_API_URL` | — | Base de l'API Maestroo |
| `PARTNER_PLATFORM_SECRET` | — | Secret d'amorçage (≥ 32 octets) |
| `PARTNER_TOKEN_TTL_SECONDS` | `600` | TTL du bail |

**Maestroo** (`apps/api/src/config/env.schema.ts`) :

| Variable | Défaut | Rôle |
|---|---|---|
| `TRACKY_INTEGRATION_ENABLED` | `false` | Idem |
| `TRACKY_API_URL` | — | Base de l'API Tracky |
| `TRACKY_PARTNER_PLATFORM_SECRET` | — | Même valeur que côté Tracky |
| `TRACKY_LINK_SECRET_KEY` | — | Clé AES-256-GCM (32 octets) du chiffrement au repos |
| `TRACKY_GRACE_HOURS` | `72` | Grâce avant purge fail-closed (D7) |

### 14.3 — Exploitation

- **`tracky_mirror` exclue des dumps** : `pg_dump --exclude-table=tracky_mirror` dans le script de
  sauvegarde Maestroo. **ET** re-vérification du lien au démarrage de l'API : si `REVOKED`, purge
  immédiate. Les deux, parce qu'un dump peut être pris à la main.
- **Cron d'expiration passive** : `DELETE FROM tracky_mirror WHERE expires_at < now()` (horaire).
  Filet si un webhook et un pull échouent tous les deux.
- **Cron outbox** : rejeu des `PartnerOutboxEvent` non délivrés, toutes les minutes.
- ⚠️ Ne **jamais** créer de migration à la main : `prisma migrate dev --name …` des deux côtés
  (piège connu, cf. mémoire).

---

### 14.4 — Constats d'environnement (relevés à l'incr. 0.2, HORS périmètre)

Trois choses découvertes en générant les migrations. **Aucune n'est causée par ce
chantier** ; toutes le gênent, et deux sont de vrais risques.

1. **🔴 L'historique de migrations Tracky ne reproduit pas `schema.prisma`.**
   Une base construite depuis les seules migrations diverge de 30 statements :
   5 valeurs de `AlertType` (`TOW`, `TAMPER`, `FATIGUE`, `ILLEGAL_IGNITION`,
   `IDLE_TIME`) **présentes dans `schema.prisma`, dans zéro migration, et référencées
   dans le code**, plus 28 `ALTER TABLE` (defaults, un changement de type sur
   `trackers.lastIgnitionChangeAt`). Conséquence : **tout nouvel environnement créé par
   `migrate deploy`** (nouveau VPS, base de CI, base de test e2e) planterait à la
   première alerte de type `TOW`. À corriger par une migration de synchronisation
   dédiée — surtout pas en la noyant dans une migration fonctionnelle.

2. **🟠 `prisma migrate dev` est inutilisable côté Maestroo.** La migration
   `20260703_add_bank_transactions` crée un **index partiel** écrit à la main
   (`... WHERE "externalId" IS NOT NULL`) que `schema.prisma` déclare en
   `@@unique` simple. Prisma le croit donc manquant à chaque diff, tente de le recréer,
   et collisionne sur le nom. En mode non-interactif, `migrate dev` abandonne.
   **Contournement utilisé ici** : `prisma migrate diff --from-schema-datamodel
   <schéma HEAD> --to-schema-datamodel <schéma courant> --script`, qui est le même
   moteur, 100 % hors-ligne, et ne produit que le delta voulu.

3. **🟡 `pnpm typecheck` est déjà rouge sur `dev` côté Maestroo** — 12 erreurs dans
   `prisma/seed.ts` et `src/prk/prk.service.spec.ts`, identiques avant et après cet
   incrément. Le `CLAUDE.md` de Maestroo dit pourtant « une violation = pas de
   commit » : la barrière ne tient plus.

4. **🔴 `z.coerce.boolean()` ne sait pas lire `false`** (Maestroo, relevé à l'incr. 0.4a).
   Zod applique `Boolean()` de JS : **toute chaîne non vide vaut `true`**, y compris
   `'false'`, `'0'`, `'no'`, `'off'`. Seule la chaîne vide donne `false`. Le défaut
   fonctionne (variable absente) — le bug ne frappe que si la variable est POSÉE.
   `TRACKY_INTEGRATION_ENABLED=false` **allumait donc l'intégration** : pour un
   kill-switch, le pire mode de défaillance possible. Corrigé ici par un helper
   `envBoolean()` dans `env.schema.ts`. **5 autres flags restent affectés**, dont
   `COOKIE_SECURE=false` — aujourd'hui lu `true`, donc cookies marqués `Secure` en dev
   sur `http://localhost`, que le navigateur jette — et `INVOICING_UX_V2`, documenté
   comme « passer à false pour rollback sans revert Git », ce qui **ne fonctionnerait
   pas**. Ticket dédié : le correctif change des comportements effectifs, il ne doit pas
   être noyé dans une PR d'intégration.

> **Le smoke-boot n'est pas une formalité.** C'est lui qui a attrapé ce bug : le
> typecheck, les 53 tests unitaires et la revue de code étaient tous verts. Seul le
> démarrage réel de l'application, en lisant le vrai `.env`, a montré que le
> kill-switch était à l'envers.

> **Méthode retenue pour tout le chantier** : les migrations se génèrent et se
> valident sur une **base jetable** (`*_migrgen`, créée puis détruite), jamais sur la
> base de dev. Les bases de dev locales des deux projets ont de la dérive ; y lancer
> `migrate dev` proposerait un *reset* et détruirait des données.

---

## 15. Plan de test — la livraison en dépend

> **Aucune des 12 assertions ci-dessous ne peut être « vérifiée à la main ». Elles sont automatisées
> ou la phase 0 n'est pas livrée.** Jest des deux côtés (Tracky : `apps/api` ; Maestroo : `apps/api`).

| # | Cas | Assertion |
|---|---|---|
| **T1** | Révocation totale | Après `revoke` : `tracky_mirror` **vide** pour le lien, toutes les routes Maestroo consommant du Tracky répondent 403, `TrackyLink.secretCipher = null` |
| **T2** | Révocation **partielle** | Éteindre `VEHICLE_IDENTITY` : les lignes de **ce seul** scope disparaissent, **les autres restent intactes** |
| **T3** | **Panne ≠ révocation** | Timeout / `500` / `404` type Traefik : **0 ligne supprimée**, statut `DEGRADED`, erreur `CRITICAL` écrite |
| **T4** | `403` **non signé** | **0 ligne supprimée** — traité comme une panne |
| **T5** | `403` **mal signé** | **0 ligne supprimée** |
| **T6** | Webhook perdu | Sans webhook, après expiration du jeton : purge déclenchée par le pull |
| **T7** | Grâce 72 h (D7) | À 71 h de silence : mirror intact. À 73 h : classe B purgée, log `CRITICAL`, lien toujours `DEGRADED` (pas `REVOKED`) |
| **T8** | `suspendedByPlatform` | Le client tente `resume` **puis** un nouveau handshake complet : les deux répondent `403 PARTNER_LINK_PLATFORM_SUSPENDED` |
| **T9** | **Scan résiduel** | Après purge : requête balayant **toutes** les colonnes `jsonb` de Maestroo — **aucune** clé `lat`, `lng`, `speed`, `heading` |
| **T10** | Rejeu de webhook | Un webhook capté et rejoué (drift > 300 s ou `eventId` déjà vu) est **rejeté** |
| **T11** | Étanchéité | Jeton expiré ⇒ 401. Jeton d'un autre lien ⇒ 403. Aucune donnée d'une autre flotte n'est jamais servie |
| **T12** | **Restauration de dump** | Restaurer un dump contenant `tracky_mirror` sur un lien révoqué, démarrer l'API ⇒ purge au boot |

**T13 — invariant d'unicité `liveKey`** (ajouté à l'incr. 0.2) : les 6 cas du §3.2bis ont
été prouvés manuellement en SQL, mais **pas encore figés en test automatique** — les tests
actuels des deux repos mockent Prisma et n'ont pas de base. À câbler en **incr. 0.7**, qui
aura de toute façon besoin d'une base réelle pour T1/T2/T9/T12. D'ici là, l'invariant est
garanti par la base (index uniques posés) mais pas protégé contre une régression de schéma.

**T3, T4, T5 et T9 sont les plus importants.** T3–T5 empêchent qu'une panne détruise les données de
tous les clients ; T9 est la seule preuve *matérielle* qu'il ne reste rien.

Ajouter aussi : tests unitaires de la signature (émission ↔ vérification), de la machine à états
(transitions interdites), de la parité du registre des scopes (§2), et un **smoke-boot** de l'API
Tracky après ajout du module — un crash-loop DI ne se voit pas au build (piège connu, cf. mémoire
`tracky_observability_visibility`).

---

## 16. Definition of Done

- [ ] Les 12 tests du §15 passent, en CI, des deux côtés
- [ ] `pnpm -w typecheck` + `ng build` OK côté Tracky ; `pnpm typecheck && pnpm lint && pnpm --filter @maestroo/web lint:all` OK côté Maestroo
- [ ] Smoke-boot des deux API (pas de crash-loop DI)
- [ ] `PARTNER_MAESTROO_ENABLED=false` et `TRACKY_INTEGRATION_ENABLED=false` en production : **le code est déployé, inerte, et vérifiable**
- [ ] Démo enregistrée : connexion → donnée visible → coupure → **disparition constatée à l'écran**
- [ ] `tracky_mirror` exclue du script de sauvegarde Maestroo
- [ ] Aucune FK ne part de `tracky_mirror` (relecture explicite en review)
- [ ] Les 6 points de câblage de `integrations_manage` sont faits, `packages/shared` rebuildé

---

## 17. Ordre d'implémentation (incréments livrables séparément)

| Inc. | Contenu | Prouvé par |
|---|---|---|
| ~~**0.1**~~ ✅ | ~~Registres de scopes des deux côtés + tests de parité~~ **FAIT** — Tracky `packages/shared/src/partner/scopes.ts` (24 tests), Maestroo `packages/shared/src/enums/partner-scope.ts` + `apps/api/src/integrations/partner-scopes.spec.ts` (23 tests) | Parité prouvée par mutation (ajout d'un scope d'un seul côté ⇒ TS **et** test échouent) |
| ~~**0.2**~~ ✅ | ~~Modèles Prisma + migrations + contraintes d'unicité (D4)~~ **FAIT** — `partner_links`/`_events`/`_access_tokens`/`_outbox_events` côté Tracky, `tracky_links`/`tracky_mirror` côté Maestroo | Migrations appliquées sur base **jetable** ; unicité `liveKey` prouvée en SQL réel (6 cas) ; `tracky_mirror` a **0 clé étrangère** (vérifié via `information_schema`) |
| ~~**0.3**~~ ✅ | ~~Service de signature partagé (émission + vérification) des deux côtés~~ **FAIT** — fonctions pures `partner-signature.ts` (Tracky `src/partner/`, Maestroo `src/integrations/`), 32 tests chacune | Vecteurs figés identiques ; **interop croisée prouvée** (13/13 : chaque repo signe, l'autre vérifie, altérations détectées) ; format canonique corrigé (§5) |
| ~~**0.4a**~~ ✅ | ~~Config, module Nest, garde de signature~~ **FAIT** — env des deux côtés (+ secret de plateforme), `PartnerModule`/`IntegrationsModule`, `@PartnerOp` + garde, 53 tests | **Smoke-boot des deux API** (sur base conforme) ; kill-switch prouvé OFF ; module inerte = **404, pas 403** |
| ~~**0.4b-1**~~ ✅ | ~~Permission `integrations_manage`~~ **FAIT** — défauts par rôle, groupe UI « Integrations », `shared` rebuildé | 199 tests `shared` verts (garde-fous de complétude) ; matrice d'accès câblée automatiquement (data-driven) |
| ~~**0.4b-2**~~ ✅ | ~~Handshake complet~~ **FAIT** — AES-GCM du secret, code à usage unique, `claim`/`approve`/`complete`/`abort`, client HTTP signé, 64 tests | **Ordre retenu : le partenaire est prévenu AVANT la création du lien local** ; compensation `abort` sur le cas résiduel ; `suspendedByPlatform` bloque un handshake NEUF ; smoke-boot des deux API, 8 routes mappées |
| ~~**0.5**~~ ✅ | ~~Bail : `token`, Redis, `ping`~~ **FAIT** — jetons opaques hashés, garde Bearer + `@RequirePartnerScope`, `token`/`ping`/`vehicles/count`, 15 tests | T11 ✅ (jeton expiré/révoqué/lien coupé) ; **deux barrières indépendantes** ; HMAC et Redis écartés, voir §7 |
| ~~**0.6**~~ ✅ | ~~`vehicles/count` + écriture `TrackyMirror`~~ **FAIT** — `TrackyApiClient` (bail en mémoire, erreurs classées), `TrackyMirrorService`, `TrackySyncService`, 2 routes, 11 tests | `MIRROR_KINDS` : le scope est **déduit du kind**, jamais fourni par l'appelant ; expiration obligatoire ; lecture d'une entrée expirée = absente |
| ~~**0.7**~~ ✅ | ~~**Révocation totale**~~ **FAIT** — énoncé signé, révocation atomique, outbox avec rejeu, receveur idempotent, purge ordonnée | **T4/T5 ✅** (403 nu, 404 Traefik, corps HTML/vide/null ⇒ aucune purge) · **T10 ✅** (rejeu ignoré) · T1/T6 restent à prouver sur une vraie base |
| ~~**0.8**~~ ✅ | ~~**Révocation partielle par scope**~~ **FAIT** — énoncé de scope signé (chaîne canonique distincte), PATCH /scopes, les DEUX chemins de purge | **T2 ✅** — la catégorie éteinte est purgée, les autres intactes ; webhook perdu rattrapé par la comparaison au bail |
| ~~**0.9**~~ ✅ | ~~**Mode dégradé + grâce 72 h + alerte**~~ **FAIT** — aiguillage panne/révocation, anti-flapping au 2ᵉ échec, purge fail-closed à 72 h, 16 tests | **T3 ✅ T4 ✅ T5 ✅ T7 ✅** — après la grâce le lien reste `DEGRADED`, jamais `REVOKED` |
| ~~**0.10**~~ ✅ | ~~`suspendedByPlatform` + `billingStatus` en `COMP`~~ **FAIT** — 5 routes super-admin, webhook `link.suspended` signé, dry-run par catégorie, 16 tests | **T8 ✅** (déjà couvert à l'incr. 4b-2 : handshake neuf refusé) · le dry-run n'écrit rien, des deux côtés |
| **0.11** | Les 3 écrans UI | Démo de bout en bout |
| **0.12** | Exploitation : exclusion du dump, re-check au boot, crons | T12, T9 |

> Ne pas fusionner 0.7 → 0.9 en un seul incrément. Ce sont **trois garanties distinctes** (couper
> marche / couper partiellement marche / une panne ne coupe pas), et elles se cassent
> indépendamment.
