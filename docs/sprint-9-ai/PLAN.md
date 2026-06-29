# Sprint 9 — Copilote IA (PLAN d'implémentation)

> Méthode : préparer ici, **tester en Console** (tokens client), câbler après. Aucun merge/deploy
> prod sans OK explicite + validation Console. Branche `feat/sprint-9-ai-optimisation`.

## Paliers

### S9·0 — Docs (ce dossier)
`ANALYSE.md` + `PLAN.md`.

### S9·1 — Prompt pack Console (`prompts/`)
- `prompts/capacity.md` — Capacité 1 (enrichissement capacité).
- `prompts/placement.md` — Capacité 2 (optimiseur de placement).
Chaque fichier = **system prompt** + **schéma de sortie JSON** + **payload d'exemple** réaliste
(parc CDEF / créneau CDEF) + **sortie attendue** indicative. Le system prompt et le schéma sont la
**source unique** réutilisée par le backend (`apps/api/src/ai/prompts.ts`).

### S9·2 — Shared (`packages/shared`)
- `FleetMetier` (type) — exporté.
- `dto/ai-optimization.dto.ts` :
  - Capacité : `AiCapacityVehicleInput`, `AiCapacityInputDto`, `AiCapacityProposalDto`,
    `AiCapacityResultDto`, `AiCapacityApplyDto`.
  - Placement : `AiPlacementCandidateInput`, `AiPlacementInputDto`, `AiPlacementProposalDto`,
    `AiPlacementResultDto`.
- Perm `ai_optimize` : interface + 4 défauts (super/fleet admin = true, autres = false) + label
  (groupe « Optimisation IA ») + ordre des groupes.

### S9·3 — Schéma + migration
`enum FleetMetier` + `Fleet.metier FleetMetier @default(GENERIC)` + migration SQL
(`ADD COLUMN ... DEFAULT 'GENERIC'`).

### S9·4 — Backend IA (`apps/api/src/ai`)
- `prompts.ts` : system prompts + schémas JSON (identiques au prompt pack).
- `anthropic.client.ts` : wrapper fin — `claude-opus-4-8`, `output_config.format`,
  `thinking:{type:'adaptive'}`, prompt caching, lit `ANTHROPIC_API_KEY` ; **pas de clé → erreur
  typée** (503 côté controller) ; gère `stop_reason:'refusal'` + JSON invalide.
- `ai-optimization.service.ts` : 
  - `suggestCapacity(user, fleetId?)` — lit véhicules scopés + énergie (via `InstallationTask`
    liée) + métier → payload → Claude → `AiCapacityResultDto` (**dry-run**).
  - `applyCapacity(user, dto)` — écrit `seats/childSeats/features` (scopé, `vehicles_edit`).
  - `suggestPlacement(user, dto)` — `suggest()` + `getUtilization()` + `getForecast()` +
    `findOverlaps`/`hasTripOverlap` (validation visible) → payload → Claude → `AiPlacementResultDto`
    (**dry-run**, ne crée aucune réservation). L'application = flux S8 `request()`→`confirm()`.
- `ai-optimization.controller.ts` : `POST /ai/capacity/suggest`, `POST /ai/capacity/apply`,
  `POST /ai/placement/suggest`. Gardes `JwtAuthGuard + RolesGuard + PermissionsGuard`,
  `@Roles(SUPER_ADMIN, FLEET_ADMIN)`, `@RequirePermissions('ai_optimize')` (apply capacité :
  `vehicles_edit` en plus).
- `ai.module.ts` (importe `AgendaModule` pour réutiliser les services) + enregistrement.
- dépendance `@anthropic-ai/sdk`.

### S9·5 — Tests backend (Anthropic **mocké**)
Construction payload · scoping anti-IDOR (un véhicule hors périmètre n'entre jamais dans le
payload) · dry-run (aucune écriture sur suggest) · parse/refusal/no-key gérés · `applyCapacity`
écrit bien (et seulement) dans le périmètre.

### S9·6 — Frontend (`apps/web`)
- `core/services/ai.service.ts`.
- Capacité : écran « Compléter le parc avec l'IA » (liste véhicules + proposition places/places-enfant
  + confiance + raison ; sélection + bouton « Appliquer »).
- Placement : bouton « Suggérer avec l'IA » dans la modale de demande `/reservations` → classement
  raisonné (score + raison) ; clic = pré-remplit la demande (flux S8 inchangé).
- Setter `Fleet.metier` (super-admin).
- Nav + route + `permissionGuard('ai_optimize')`.

### S9·7 — Vérif
`pnpm -w typecheck` · jest api · `ng build` web · karma. Tout vert.

### S9·8 — Relecture adversariale + corrections
Angles : sécu IDOR · l'IA ne peut ni écrire ni contourner les gardes · dry-run réel · parse/refusal/no-key
· front. Corrections.

### S9·9 — Récap
Prompt pack à tester en Console ; intégration prête derrière la clé env. **Pas de prod sans OK.**

## Invariants à NE pas casser
- Réservations mutées uniquement via `ReservationsService` (l'IA ne crée jamais directement).
- `fleetId` dérivé du véhicule, jamais du client (anti-IDOR).
- `Vehicle.seats/childSeats` écrits seulement après acceptation humaine.
- Clé API jamais en dur / jamais loggée ; testée par le client en Console.
