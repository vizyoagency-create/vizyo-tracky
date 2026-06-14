# Sprint 1 — Fondation Groupes · RÉCAP (pour relecture)

> Branche `feat/sprint-1-fondation-groupes` (worktree isolé) · base `main` @ `827f8ec`.
> **Ne pas merger** : branche prête pour relecture.

## Ce qui a été fait (4 objectifs)

1. **Vue Véhicules groupée** — 3ᵉ mode de vue sur `/vehicles` (toggle `cartes / tableau / groupé`), persisté dans `PreferencesService`. Regroupement **100 % client-side** par groupe, sections **pliables**, **« Sans groupe » en premier** (cas majoritaire : 10/14 en prod), compteur par section. Réutilise les véhicules déjà chargés → aucun endpoint dédié.
2. **Navigation groupe → détail + retour rapide** — depuis la vue groupée, le lien détail transporte le contexte (`?from=grouped&group=<id>`). Le bouton retour du détail (avant **hardcodé `/dashboard`**) revient désormais vers `/vehicles` en **conservant le mode groupé** (persisté). Fallbacks d'erreur/no-id → `/vehicles`.
3. **Assignation d'un groupe depuis le Détail** — bloc groupe (badge + bouton *Changer/Assigner*, visible si `groups_manage`), sélecteur modal (recherche si >6 groupes, option **« Aucun (retirer) »**), **mise à jour optimiste + toast + rollback** sur erreur.
4. **Nom du groupe partout** — DTO véhicule enrichi (`group: {id,name} | null`) + composant **`app-group-badge`** réutilisable, posé sur : liste (cartes **et** tableau), en-tête du détail, **popup carte** (bottom card), **sélecteur de rapports**.

## Décisions de modélisation

- **Cardinalité = 1 groupe / véhicule (UX).** Le schéma reste **many-to-many** (`VehicleGroupAssignment`), **aucune migration**. L'endpoint d'assignation normalise vers une seule assignation (replace). Justif : métier (« un groupe ») + 100 % des données prod (0 véhicule dans ≥2 groupes) + zéro risque migratoire. Robustesse legacy : si >1 assignation, on affiche **la première** (`take:1` trié par nom).
- **Vue groupée = toggle sur `/vehicles`** (pas de nouvelle route). `/groups` reste la page d'**administration** des groupes (inchangée).

## Backend — sécurité & scoping (critère d'acceptation)

- `PATCH /vehicles/:id/group` (`{ groupId: <uuid> | null }`) :
  - **Même autorité** que l'assignation côté admin groupes : `@Roles(FLEET_ADMIN, SUPER_ADMIN)`.
  - Scoping tenant + **IDOR** délégués à `findOne` (404 cross-fleet, pas de leak).
  - **Défense même-flotte** : le groupe cible doit appartenir à la flotte du véhicule.
  - Replace **transactionnel** (`deleteMany` + `create`).
- Exposition du groupe (`findAll`/`findOne`/`snapshot`) **additive**, via un select borné (`take:1`) + flatten — n'altère pas les autres champs.
- **Tests (6 nouveaux)** : flatten/null, replace, retrait, **anti cross-fleet**, **IDOR véhicule**.

## Vérification

- `pnpm --filter @vizyo/tracky-shared --filter @vizyo/tracky-api typecheck` → **OK**.
- Suite API complète : **36 suites / 377 tests OK** (dont le spec véhicules 14/14).
- `apps/web` : **`ng build` OK** (aucun nouveau warning ; le `NG8113 DecimalPipe/AdminActivity` est préexistant). Pas de typecheck web séparé dans ce repo (cf. convention projet).
- VPS : consultation **lecture seule** uniquement (données live pour caler les formats) — aucune écriture/déploiement.

## Points d'attention pour la relecture

- **Chemin chaud `snapshot` (carte)** : +1 jointure groupe (borne `take:1`, volumes faibles) — surveiller le payload si la flotte grossit beaucoup.
- **Cohérence M2M ↔ mono-groupe** : l'admin `/groups` peut toujours techniquement mettre un véhicule dans plusieurs groupes ; la vue groupée et le badge affichent **le premier**. L'assignation depuis le détail, elle, normalise vers un seul.
- **Retour « scroll exact »** : le contexte (groupe d'origine, mode groupé) est conservé ; la restauration fine de scroll s'appuie sur le comportement par défaut du routeur (non forcée).

## Hors-scope (assumé)

- Badge groupe sur les surfaces admin/edge (installations, SIM, surveillance, géofences, KPIs dashboard).
- Rôle veilleur de nuit / filtres rapports par groupe / réservation (Sprint 2+). La vue groupée est conçue **réutilisable** pour les accueillir.

## Commits (atomiques)

```
docs(sprint-1): analyse + plan fondation groupes
feat(shared): expose le groupe (single) sur VehicleSnapshotDto
feat(api): groupe (single) sur les vehicules — DTO + PATCH /:id/group + tests
feat(web): badge groupe reutilisable + DTO front + setGroup()
feat(web): vue groupee (toggle /vehicles) + section « Sans groupe » + badges
feat(web): assignation de groupe + retour contextuel depuis la fiche detail
feat(web): nom du groupe sur la carte (popup) + selecteur rapports
```
