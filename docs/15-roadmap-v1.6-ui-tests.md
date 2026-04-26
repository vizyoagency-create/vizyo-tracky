# 15 — Roadmap V1.6 UI compléments + tests

> **Statut :** ✅ Livré — 2026-04-26
> **Périmètre :** finition des UI manquantes pour les sprints I-O (V1.5) +
> setup tests qualité Supertest + bump coverage. Pas de nouveau backend
> majeur — les fonctionnalités sont déjà toutes en place côté API.

---

## 0. Synthèse

| # | Chantier | Statut | Effort |
| - | --- | --- | --- |
| P1 | Éditeur scheduling V2 multi-plages dans `/vehicles/:id` | ✅ | ~3h |
| P2 | Éditeur AlertRules dans `/settings/alert-rules` | ✅ | ~4h |
| P3 | Import GeoJSON dans `/geofences` (au lieu du dessin corridor interactif) | ✅ | ~2h |
| P4 | 4 user-flows Playwright (create-vehicle, engine-cut, trip-replay, fix-mode-override) | ✅ | ~3h |
| P5 | Setup tests Supertest intégration + 1 spec exemple | ✅ | ~2h |
| P6 | Tests schedule-evaluator (10 cas) → coverage 96%/85% | ✅ | ~1h |
| P7 | Doc + commit | ✅ | ~30min |

**Total livré : ~15h** (vs ~29h estimé initialement — économisé sur le dessin
corridor interactif et tests intégration complets, reportés en V1.7).

---

## 1. P1 — Éditeur scheduling V2

Étend le composant existant `VehicleScheduleComponent` avec une section
**"Options avancées"** repliable, contenant :

### Multi-plages par jour
Pour chaque jour activé, possibilité d'ajouter jusqu'à 2 plages
supplémentaires (en plus de la plage start/end principale). Permet
typiquement le pattern "matin + après-midi avec pause déjeuner".

### Pays jours fériés
Sélecteur `countryCode` parmi : Aucun / FR / MA / BE / LU / CH. Quand un
pays est choisi, les jours fériés correspondants déclenchent un
`OUT_OF_WINDOW HOLIDAY` automatiquement (logique côté backend Sprint K).

### Dates spéciales
Liste éditable avec date-picker, toggle "Ferme toute la journée", et
plages horaires personnalisées si non fermé.

**Backend** : aucun changement, les endpoints Sprint K acceptent déjà ces
champs (`mondaySlots[]`, `countryCode`, `customDates[]`).

---

## 2. P2 — Éditeur AlertRules

Nouvelle page `/settings/alert-rules` accessible à tous (lecture pour
non-admins, édition pour FLEET_ADMIN+ et SUPER_ADMIN). Permet de :

- **Lister** les règles avec colonnes : statut, type d'alerte, canaux,
  escalade, date création.
- **Créer/Éditer** via modal :
  - Sélecteur type d'alerte (16 types Coban + `*` catch-all)
  - Cases à cocher pour les channels (Push / Email / WhatsApp ; in-app
    toujours actif)
  - Optionnel : escalateAfterMin (1-120 min)
- **Supprimer** avec confirmation native.

**Backend** : aucun changement, endpoints Sprint M déjà exposés
(`GET / POST / PUT / DELETE /api/notifications/rules`).

---

## 3. P3 — Import GeoJSON

Plutôt qu'un éditeur de dessin corridor interactif (très lourd à
implémenter en MapLibre, ~6h+), j'ai préféré un **import GeoJSON**
pragmatique qui couvre 99% des cas réels (un user qui a une route à
suivre l'a déjà sous forme GeoJSON exporté de Google Maps / OpenStreetMap).

### Fonctionnement
Bouton **"Importer GeoJSON"** dans `/geofences`. Ouvre un file picker,
parse le JSON côté client, envoie à `POST /api/geofences/import-geojson`.

Le backend (déjà livré Sprint N) mappe :
- `Polygon` → POLYGON
- `LineString` → CORRIDOR (largeur via `properties.widthM`, défaut 100m)
- `Point` → CIRCLE (rayon via `properties.radius`, défaut 200m)

Avec un toast indiquant le nombre de zones créées + ignorées.

### Reporté V1.7
Dessin corridor interactif sur carte MapLibre (clic-to-add points + slider
largeur live + preview buffer). Estimé ~6h, basse priorité tant que
l'import GeoJSON suffit aux clients.

---

## 4. P4 — Playwright user-flows

4 nouvelles specs ajoutées dans `apps/web/e2e/` (en plus des 2 existantes
de Sprint O) :

| Spec | Couverture |
| --- | --- |
| `create-vehicle.spec.ts` | Wizard d'ajout véhicule (plaque + tracker) |
| `engine-cut.spec.ts` | CUT moteur avec double confirmation + RESTORE auto |
| `trip-replay.spec.ts` | Ouverture replay + play/pause |
| `fix-mode-override.spec.ts` | Override SUPER_ADMIN avec set + clear |

Helper partagé `e2e/helpers/auth.ts` pour le login.

### Variables env de test requises
```env
E2E_TEST_EMAIL=admin@tracky.local
E2E_TEST_PASSWORD=changeme
# Pour engine-cut.spec.ts :
E2E_TEST_VEHICLE_ID=<uuid d'un vehicule a l'arret>
# Pour fix-mode-override.spec.ts :
E2E_SUPERADMIN_EMAIL=superadmin@tracky.local
E2E_SUPERADMIN_PASSWORD=changeme
E2E_TEST_TRACKER_ID=<uuid d'un tracker>
```

Les specs **skippent** automatiquement si une var requise est absente —
permet de lancer la suite localement sans tout configurer.

---

## 5. P5 — Tests Supertest intégration

Setup minimal dans `apps/api/test/integration/` :

- **Config Jest dédiée** `test/jest-integration.json` avec testRegex
  `*.e2e-spec.ts` (séparé du Jest unitaire qui couvre `*.spec.ts` dans
  `src/`).
- **Script** `pnpm test:integration` dans package.json.
- **Spec exemple** `health.e2e-spec.ts` : 2 tests qui bootstrap le
  HealthController via `Test.createTestingModule` + `Supertest`, avec
  PrismaService mocké (DB up vs DB down).

### Pattern à étendre pour les autres endpoints
```typescript
const moduleRef = await Test.createTestingModule({
  imports: [ThrottlerModule.forRoot([{...}])],
  controllers: [MyController],
  providers: [
    { provide: PrismaService, useValue: prismaMock },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
}).compile();
const app = moduleRef.createNestApplication();
await app.init();
await request(app.getHttpServer()).get('/my-route').expect(200);
```

### Reporté V1.7
Tests d'intégration **avec une vraie DB Postgres** (Docker port 5434 +
`prisma migrate reset` entre tests). Utile pour valider les requêtes
Prisma complexes mais nécessite Docker en local — pas bloquant pour V1.6.

---

## 6. P6 — Coverage bump schedule-evaluator

Le fichier `schedule-evaluator.ts` (Sprint K) était à **6%** de coverage
statements (gravement non-couvert). 10 nouveaux tests unitaires couvrant :

- Plages hebdo simples (in/out)
- Jour désactivé
- Multi-slots (in d'un slot, out entre 2 slots)
- customDates closed=true (priorité max)
- customDates avec slots specifiques
- countryCode FR + jour férié réel (1er mai)
- countryCode invalide (fallback gracieux)
- Jour activé sans plages (toute la journée)

→ Coverage passe à **96% statements / 85% branches**. Seuil bumpé en
conséquence dans `package.json#jest.coverageThreshold`.

---

## 7. Stats post-V1.6

| Mesure | Avant V1.6 | Après V1.6 |
| --- | --- | --- |
| Tests unitaires API | 175 | **185** |
| Tests intégration API | 0 | **2** |
| Tests E2E web | 4 cas (2 specs) | **9 cas (6 specs)** |
| Coverage `schedule-evaluator` | 6% | **96%** |
| Pages admin/UI | 18 | **20** (+ alert-rules + scheduling V2) |
| Endpoints API | ~80 | ~80 (stable, juste UI) |

---

## 8. Reporté V1.7

| Item | Pourquoi reporté | Estim |
| --- | --- | --- |
| Dessin corridor interactif sur MapLibre | Lourd à implémenter, import GeoJSON suffit | ~6h |
| Tests Supertest avec vraie DB Postgres (Docker) | Demande infra Docker locale, pattern documenté | ~5h |
| Augmenter seuils coverage à 70%/60% global | Demande tests prisma sur les services non-couverts | ~3h |
| RGPD suppression compte | Dépend de Vizyo Auth (out of scope) | ~3h |

---

## 9. Journal

| Date | Auteur | Changement |
| --- | --- | --- |
| 2026-04-26 | Younesshs + Claude | Création V1.6 + livraison complète des 7 chantiers en une session. |
