# Intégration Vizyo Verify — vérification d'identité des conducteurs

**Pour** : Mahmoud · **Zone** : `apps/api` + `apps/web` + `packages/shared`

---

## Pourquoi

`Driver.licenseNumber` est aujourd'hui une **chaîne libre**. Le schéma le dit lui-même :

```prisma
/// Numero de permis (libre, usage interne — pas de validation officielle).
licenseNumber   String?
```

Personne ne vérifie que le conducteur à qui on confie un véhicule est bien celui qu'il
prétend, ni que son permis est valide. Vizyo Verify sait déjà lire une pièce d'identité et
un titre d'identite avec lecture de la bande MRZ et controle des cles. La **carte
nationale d'identite marocaine** et les **passeports** sont en cours d'ajout de mon cote.

L'objectif : qu'un gestionnaire de flotte puisse demander une vérification depuis la fiche
conducteur, que le conducteur la fasse depuis son téléphone, et que Tracky affiche un
verdict fiable — au lieu d'un champ texte que n'importe qui remplit.

---

## ⚠️ À lire avant de commencer : ce qui n'existe pas encore

**Vizyo Verify n'expose aujourd'hui AUCUNE interface pour un système tiers.** J'ai vérifié
son code :

- ses seules routes sont le **parcours public par jeton** (`/api/public/:token/…`) et un
  **back-office à session + MFA** (`/api/admin/…`) ;
- il n'a ni clé d'API, ni jeton de service : son `.env` ne contient que `SESSION_SECRET`
  et `SIGNED_URL_SECRET` ;
- le rappel vers l'application hôte est un **TODO non écrit** —
  `src/server/statusSync.ts:73` : `// TODO intégration (P3) : webhook signé vers l'app hôte`.

**Conséquence : ne code pas contre une API réelle, elle n'existe pas.** Le côté Verify est
en cours de préparation de mon côté. Tes tâches sont donc construites pour que **tout le
côté Tracky soit livrable et testable sans lui**, derrière un client remplaçable. Quand
Verify livrera, le branchement sera d'un seul fichier.

Le contrat ci-dessous est ce que Verify DEVRA fournir. Code contre lui.

---

## Le contrat (cible)

### 1. Ouvrir une vérification — Tracky → Verify

```http
POST {VIZYO_VERIFY_BASE_URL}/api/integration/requests
X-Vizyo-Key: <VIZYO_VERIFY_API_KEY>
Content-Type: application/json

{
  "externalId": "<driverId Tracky>",
  "firstName": "Karim",
  "lastName": "Bennani",
  "phone": "+212612345678",
  "docCategories": ["IDENTITE"]
}
```

**Périmètre v1 : l'identité seule** — carte nationale d'identité marocaine ou passeport.
La vérification du **permis de conduire** viendra ensuite ; le champ `docCategories` est un
tableau précisément pour qu'ajouter `"PERMIS"` plus tard ne casse rien.

```json
{
  "requestId": "…",
  "personId": "…",
  "linkUrl": "https://verify.vizyoagency.com/v/<token>",
  "expiresAt": "2026-08-18T10:00:00.000Z"
}
```

### 2. Consulter l'état — Tracky → Verify

```http
GET {VIZYO_VERIFY_BASE_URL}/api/integration/persons/{personId}
X-Vizyo-Key: <VIZYO_VERIFY_API_KEY>
```

```json
{
  "status": "EN_ATTENTE | A_VALIDER | VERIFIE | REFUSE",
  "documents": [
    { "docType": "PERMIS_CARTE", "expiresAt": "2031-04-02", "verifiedAt": "2026-08-12T…" }
  ]
}
```

### 3. Rappel signé — Verify → Tracky

```http
POST {TRACKY}/api/integrations/verify/callback
X-Vizyo-Timestamp: <epoch secondes>
X-Vizyo-Signature: <HMAC-SHA256 base64url>

{ "event": "person.status_changed", "personId": "…", "externalId": "<driverId>", "status": "VERIFIE" }
```

**La signature suit EXACTEMENT le format déjà en place côté partenaire** —
`apps/api/src/partner/partner-signature.ts`, avec `op = 'verify.callback'`. Ne réinvente
rien : ce fichier est pur, testé, et a un jumeau côté Maestroo. Réutilise-le.

---

## Incrément 1 — Le modèle (indépendant, commence par là)

Rien de réseau ici : tu peux le livrer aujourd'hui.

Ajoute sur `Driver` :

| champ | type | rôle |
| --- | --- | --- |
| `identityStatus` | enum `NON_VERIFIE \| EN_COURS \| VERIFIE \| REFUSE` | défaut `NON_VERIFIE` |
| `identityPersonId` | `String?` | identifiant côté Verify |
| `identityRequestId` | `String?` | dernière demande ouverte |
| `identityVerifiedAt` | `DateTime?` | |
| `identityDocType` | `String?` | `CIN_MA` ou `PASSEPORT`, tel que rendu par Verify |
| `identityExpiresAt` | `DateTime?` | **lu sur le document**, pas saisi |
| `identityCheckedAt` | `DateTime?` | dernière synchronisation |

⚠️ **Ne touche pas à `licenseNumber`.** Il reste la saisie interne libre. Le champ vérifié
est distinct : on doit pouvoir comparer ce que le gestionnaire a saisi avec ce que le
document dit, et cet écart est une information utile.

Migration Prisma + `npx prisma generate`.

**Attendu** : `pnpm --filter @vizyo/api test` vert, `pnpm verify` vert.

---

## Incrément 2 — Le client Verify, simulable

`apps/api/src/driver-verification/` (nouveau module).

- `verify-client.interface.ts` — `openRequest()`, `getPerson()`.
- `verify-http.client.ts` — l'implémentation réelle, calquée sur
  `apps/api/src/partner/partner-client.service.ts`.
- `verify-mock.client.ts` — **rend un lien factice et bascule en `VERIFIE` après un
  appel**. C'est lui qui te permet de tout construire avant que Verify existe.

Le choix se fait sur la configuration : `VIZYO_VERIFY_BASE_URL` et `VIZYO_VERIFY_API_KEY`
absentes → client simulé. Ajoute-les à `apps/api/src/config/env.validation.ts` en
**optionnelles**, sinon l'API refusera de démarrer partout où elles ne sont pas posées.

⚠️ Vérifie ton câblage avec le **smoke-boot** (`app.module.smoke.spec.ts`) : un module mal
déclaré ne casse pas les tests unitaires, il casse le démarrage en production.

---

## Incrément 3 — Recevoir le verdict

`POST /api/integrations/verify/callback`, public au sens routeur mais **gardé par la
signature HMAC**.

- Réutilise `partner-signature.ts` (fenêtre de tolérance sur l'horodatage comprise).
- **Idempotent** : le même événement rejoué ne doit pas rouvrir un dossier ni réécrire
  `identityVerifiedAt`. Une intégration qui n'est pas rejouable finit toujours par l'être.
- Corps inconnu ou signature invalide → `401`, et **rien en base**.

**Tests attendus** : signature valide → statut mis à jour ; signature invalide → 401 ;
horodatage hors fenêtre → 401 ; même événement deux fois → une seule écriture.

---

## Incrément 4 — La permission

Nouvelle permission `drivers_verify` (ouvrir une vérification ≠ voir la fiche).

⚠️ **Une permission se câble en plusieurs endroits, pas un seul** — registre
`packages/shared/src/permissions/permissions.ts`, garde côté API, matrice d'invitation,
écran d'administration des droits. Passe-les tous en revue, et **reconstruis `shared`**
avant de tester le front, sinon tu débugueras une permission qui existe côté serveur et
pas côté navigateur.

---

## Incrément 5 — L'écran

`apps/web/src/app/features/drivers/`.

- Sur la fiche conducteur : une **pastille d'état** (non vérifié / en cours / vérifié /
  refusé) et la date d'expiration de la piece quand elle est connue.
- Bouton **« Vérifier l'identité »** → ouvre la demande, affiche le lien, et propose de
  **l'envoyer par SMS** au conducteur (le module `apps/api/src/sms/` existe déjà, ne monte
  pas un second chemin d'envoi).
- Sur la liste des conducteurs : un filtre « non vérifiés ».
- Quand la piece d'identite expire dans moins de 30 jours, dis-le sur la fiche.

⚠️ Le lien Verify donne accès au parcours d'envoi de pièces d'identité : **ne l'affiche
jamais dans un journal, une alerte ou un e-mail non ciblé.**

---

## Ce qui n'est PAS dans ton périmètre

- L'API d'intégration côté Verify et son webhook — je m'en occupe.
- La lecture de la CIN marocaine et des passeports cote Verify — en cours.
- Toute décision d'ordre RGPD sur la conservation des documents : les pièces restent
  **chez Verify**, Tracky ne stocke qu'un verdict et des dates. Ne rapatrie aucune image.

---

## Ordre conseillé

1 → 2 → 3 avec le client simulé, puis 4 → 5. Tu auras alors un parcours complet et
démontrable sans qu'une seule ligne de Verify n'existe. Le jour où l'API arrive, seul
`verify-http.client.ts` change.

**Process** : une branche par incrément depuis `main`, PR, je relis avant de merger.
`pnpm verify` vert avant de pousser.

⚠️ Attention à la branche sur laquelle tu pars : le dépôt a beaucoup de branches
`feat/…` en cours et du travail non commité peut traîner. Vérifie
`git branch --show-current` et `git status` avant de commencer, et **jamais de
`git add -A`** — tu embarquerais le travail en cours de quelqu'un d'autre.
