# Sprint 0.1 — PLAN

Basé sur `DIAGNOSTIC.md`. Principe directeur du brief : **ne pas corriger « en dur »
côté front un problème d'infra (0.2)**. On sépare donc strictement :
- **Durcissement applicatif légitime** (améliore la robustesse, ne masque rien) → on applique.
- **Cause racine infra (0.2)** → on renvoie, avec procédure de vérification.
- **Bugs applicatifs indépendants de 0.2** (comptage, modèle offline) → on corrige proprement.

---

## Lot A — Live : durcissement transport WS (applicatif, faible risque)

**Objectif** : restaurer le repli **polling** quand l'upgrade WebSocket échoue
(redémarrages/à-coups proxy), pour que le live survive en mode dégradé au lieu de
tomber totalement.

**Fichier** : `apps/web/src/app/core/services/realtime.service.ts:131-135`
**Changement** : ajouter `tryAllTransports: true` à l'appel `io('/realtime', …)`.
Conserve `['websocket','polling']` (connexion rapide quand WS marche) mais autorise la
bascule polling si le handshake WS échoue. Une ligne, comportement standard Socket.IO.

**Risque** : très faible. En pire cas, certains clients passent en polling (plus de
charge HTTP) le temps que l'upgrade WS repasse — exactement le compromis voulu.

**Test** : `realtime.service.spec.ts` (nouveau) — vérifier que `io()` est appelé avec
`tryAllTransports: true` (mock de `socket.io-client`).

**NON fait ici (renvoyé 0.2)** : la cause racine (CPU saturé → handshake/auth DB qui
échouent). Ce lot ne *masque* pas l'infra : si l'API est injoignable, le bandeau
s'affiche toujours ; on évite seulement la déconnexion *totale* quand seul l'upgrade WS
est en cause.

---

## Lot B — Comptage + statut offline : liveness par fraîcheur (applicatif, risque moyen)

**Constat** (DIAGNOSTIC §2/§3) : `Tracker.status` est **collant** (jamais remis
OFFLINE) ; la carte compte « a une dernière position » ; rien n'est basé sur la
**fraîcheur**. Résultat : trois nombres incohérents et des faux-offline/faux-online.

**Décision d'architecture** : introduire **une seule** définition de liveness basée sur
`lastSeenAt`, dans `packages/shared`, et l'utiliser sur **toutes** les surfaces
d'affichage. Calcul **au read-time, non destructif** (aucune écriture DB, aucune
migration, aucun cron). Réversible, et neutre vis-à-vis de 0.2 (sous backlog, un tracker
réellement périmé sera *correctement* marqué offline — ce que l'on veut).

### B1 — Helper partagé
**Nouveau** : `packages/shared/src/utils/tracker-liveness.ts`
```ts
export const TRACKER_ONLINE_THRESHOLD_MS = 15 * 60 * 1000; // 15 min
export function isTrackerOnline(lastSeenAt, now?, thresholdMs?): boolean
```
Seuil **15 min** justifié : un véhicule à l'arrêt émet jusqu'à toutes les ~300 s
(intervalle adaptatif max, cf. commentaires sampling). 15 min tolère ~2 trames manquées
→ pas de faux-offline pour un véhicule légitimement stoppé. Constante unique, ajustable.
Exporté via `packages/shared/src/index.ts`.

### B2 — Admin Trackers (web, affichage)
**Fichier** : `apps/web/src/app/features/observability/admin-trackers.component.ts`
- `summary().online/offline` : calculés via `isTrackerOnline(t.lastSeenAt)` au lieu de
  `t.status === 'ONLINE'`.
- Badge par ligne (ON/OFF) et filtre `filterStatus` : même helper.
`lastSeenAt` est déjà renvoyé par l'API (colonne affichée « Dernier signal »). **Aucun
changement API.**

### B3 — Carte « actif(s) » (web, affichage)
**Fichier** : `apps/web/src/app/features/map/map.component.ts:2056-2061`
- `filteredPositionCount` ne compte que les positions **fraîches**
  (`isTrackerOnline(p.timestamp)`), en plus du filtre d'accès existant.
- Effet voulu : pendant une coupure realtime, les positions hydratées sont périmées →
  le compteur descend → **cohérent** avec le bandeau « interrompue ». « actif » veut
  enfin dire « live ».

**Risque B** : moyen — change des **nombres affichés** (admin online/offline, « actif »).
C'est l'objectif (les anciens étaient faux), mais c'est visible : à valider en revue.
Le seuil est central et trivial à ajuster.

**Tests** : `tracker-liveness.spec.ts` (helper, bornes du seuil) + spec admin
(online/offline calculés) + spec sur `filteredPositionCount` si l'harness le permet, sinon
test ciblé du prédicat.

---

## Lot C — Faux-offline « boîtier communique mais fix invalide » (applicatif, faible-moyen)

**Constat** (DIAGNOSTIC §3) : `isValidLatLng` rejette **avant** toute mise à jour de
liveness (`positions.service.ts:88-94`), alors que la garde anti-replay, elle, met à
jour la liveness avant de sortir. Un boîtier qui n'émet que des fixes invalides
(démarrage à froid, indoor) n'est jamais « vu ».

**Fichier** : `apps/api/src/positions/positions.service.ts` (branche `!isValidLatLng`).
**Changement** : avant le `return` ligne 93, mettre à jour la liveness
(`lastSeenAt: now`, `status: 'ONLINE'`) + émettre `TRACKER_STATUS` si le tracker était
offline — exactement comme la branche anti-replay (`:124-137`). Pas de denorm position
(le fix est invalide), pas de broadcast position.

**Risque** : faible-moyen. Sémantique : « online » = « le boîtier nous parle » (même
sans fix GPS). Cohérent avec le besoin utilisateur (distinguer « communique sans fix »
de « ne communique pas »).

**Test** : nouveau cas dans `positions.service.spec.ts` — trame `isValidLatLng=false`
→ `tracker.update` appelé avec `{ lastSeenAt, status:'ONLINE' }`, **sans** `lastLat`,
**sans** `batchBuffer.enqueue`, **sans** `broadcastPosition`.

---

## Lot D — Config Traefik WS (infra/config, faible) — optionnel

**Fichier** : `deploy/vps/docker-compose.prod.yml`
**Constat** : middleware `tracky-api-ws` **défini** (`:97`) mais **non attaché** au
routeur. **Changement** : ajouter
`traefik.http.routers.tracky-api.middlewares=tracky-api-ws@docker`.
**Risque** : faible, mais **non vérifiable en local** (pas de Traefik ici) → à valider
au déploiement. Renvoyé/coordonné avec 0.2.

---

## Renvoyé explicitement au Sprint 0.2 (infra) — NON corrigé ici
- **Cause racine du bandeau** : CPU VPS à 100 %, redémarrages conteneurs → handshake WS
  et auth-DB à la connexion qui échouent. Le live doit revenir seul une fois le CPU sain
  (logique de reconnexion déjà correcte).
- **Backlog d'ingestion** = vrais faux-offline d'origine infra (trames en retard).
- **Vérification croisée** : après assainissement CPU (0.2), confirmer que le bandeau
  disparaît **sans** redéploiement front.

## Hors-scope 0.1 (suivi)
- Cloche 50+ : auto-résolution/dédup des alertes récurrentes.
- Modèle `status` DB collant : à terme, soit le calculer au read-time partout (ce lot B
  le fait pour l'affichage), soit ajouter un sweep — décision produit séparée.

---

## Notes de cohérence (découvertes pendant l'implémentation — pour la revue)
- **Seuils de fraîcheur déjà divergents** dans le code (aucune constante canonique
  « tracker online » n'existait) : Baanool overlay **5 min**
  (`baanool-map-overlay.component.ts:390`), fix-mode **5 min**
  (`tracker-fix-mode.service.ts:92`), alertes offline du hub **1 h**
  (`admin-alerts.controller.ts:21`). `TRACKER_ONLINE_THRESHOLD_MS = 15 min` est un
  compromis (tolère un véhicule arrêté qui émet jusqu'à ~300 s sans flicker, tout en
  restant réactif). **Un seul endroit à régler** — à aligner/valider en revue.
- **Autres surfaces au statut collant** (hors 3 chiffres du brief, NON modifiées pour
  contenir le périmètre 0.1, à basculer ensuite sur le helper) :
  - `vehicles-list.component.ts:686-690` `isTrackerOnline()` : live WS d'abord, sinon
    fallback `httpStatus === 'ONLINE'` (collant).
  - `admin-fix-mode.component.ts:75` : badge `s.status === 'ONLINE'`.

## Ordre des commits (atomiques)
1. `docs(sprint-0.1)` : DIAGNOSTIC.md + PLAN.md.
2. `fix(web)` Lot A : repli transport WS + test.
3. `feat(shared)` B1 : helper liveness + test.
4. `fix(web)` B2+B3 : admin + carte utilisent la liveness + tests.
5. `fix(api)` Lot C : liveness sur trame invalide + test.
6. `fix(deploy)` Lot D : middleware Traefik (optionnel, séparé).

## Stratégie de test globale
- `pnpm -w typecheck` (pas d'ESLint dans le repo) ; `apps/api` : `jest` ; `apps/web` :
  spécifications Jasmine/Karma ciblées ou tests purs de prédicat (le helper est
  framework-agnostique → testable sans DOM).
- Baseline avant correctifs : **22/22** verts (positions + trackers).

## Procédure de vérification en PROD (post-déploiement)
1. **Live** : ouvrir la carte ; DevTools → Network → WS. Vérifier l'établissement
   `/socket.io/`. Couper/redémarrer l'API (ou attendre un restart 0.2) : confirmer la
   **reconnexion auto** (bandeau qui disparaît) et, si l'upgrade WS échoue, la **bascule
   polling** (transport=polling dans les requêtes) au lieu d'une coupure totale.
2. **Comptage** : comparer admin Trackers (online/offline) et chip « actif » carte —
   doivent être **cohérents** (même définition de fraîcheur, à la tolérance de scope
   près).
3. **Offline (preuve)** : requête SQL sur la base prod (read-only) —
   ```sql
   SELECT t.imei, t.status, t."lastSeenAt", t."lastPositionAt",
          (SELECT count(*) FROM positions p
            WHERE p."trackerId" = t.id AND p."timestamp" > now() - interval '1 hour') AS pos_1h
   FROM trackers t
   ORDER BY t."lastSeenAt" DESC NULLS LAST;
   ```
   - `lastSeenAt` récent + `pos_1h > 0` mais affiché offline → **faux-offline** (corrigé
     par lot B/C côté affichage ; si backlog réel → 0.2).
   - `lastSeenAt = null` → **offline réel** (ex. FL, KSR370, FV).
4. **CDEF** : vérifier que les trackers CDEF ont `lastSeenAt` récent → doivent
   apparaître **online** après lot B.
