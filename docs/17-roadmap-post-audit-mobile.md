# 17 — Roadmap post-audit mobile (V1.8+)

> Suivi des prochaines étapes après l'audit UX mobile complet livré dans
> les commits `4fadc2b` → `7f1633a` (10 commits poussés le 2026-05-01).

## ✅ Déjà livré

| Commit | Sujet | Détail |
|---|---|---|
| `4fadc2b` | Bug critique tracking | server WS silence (Namespace.adapter), trainée dédup, drift zoom |
| `3766cbf` | P0 mobile | accents, tabs `/account`, scroll buffer alertes, lien `/account` orphelin |
| `58fd945` | P1 mobile | pastille live vitesse cards, coords GPS, exports PDF/CSV, filtre alertes |
| `807ae4b` | P2 mobile | IMEI tap-to-copy, throttle toasts, cadenas email, sweep accents |
| `7f1633a` | P2 ambitieux | bottom-sheet mobile + datepicker custom riche |
| `9df75a8` | /map HUD | refonte HUD desktop + correctifs audit #5 #6 #7 |
| ba10e53 | /reports charts | Chart.js v4 + heatmap SVG, sparkline KPI, item #4 done |

## 🎯 Pistes suivantes (par ordre suggéré)

### 1. Audit format desktop (1280×800) ⏭ EN COURS
Équivalent de l'audit mobile mais en desktop. Vérifier :
- Layout sidebar (collapse, breakpoints)
- Densité d'info des KPIs (grille 4 col)
- Modals / drawers (au lieu du bottom-sheet)
- Tableaux d'invitations / drivers / users (responsive)
- Interactions hover (qui n'existent pas en touch)

→ Lister les erreurs trouvées, valider avec utilisateur, corriger.

### 2. Tests E2E sur les bugs corrigés
Playwright pour figer la régression sur les 3 bugs critiques de live tracking :
- POSITIONS_BATCH bien émis (mock + assert WS frame)
- Trainée non vide après N updates
- Pas de drift au zoom (mesure pixel + reverse-projection GPS)

### 3. Date range mobile-first → calendrier inline desktop
Actuellement 2 `<input type="date">` qui ouvrent le datepicker natif iOS/Android.
Sur desktop, ajouter un mini-calendrier inline (2 mois côte-à-côte) pour
l'aperçu visuel. Conserver les inputs natifs en mobile.

### 4. Refonte de /reports (graphes) ✅ DONE (commit ba10e53)
KPI cards plates → graphs lecture rapide. Livré : Chart.js v4 (tree-shaké),
3 wrappers standalone OnPush, theme dark/light dynamique, FLEET_ADMIN testé
en preview.
- Sparkline KPI cards (bars Trajets, line cumulée Distance, dot couleur Vitesse)
- Chart Activité full-width : combo bar (trajets/j) + line (km/j), tooltip
  riche {date · X trajets · Y km · Z h}
- Histogramme vitesses 6 bins (0-30…110+) avec gradient vert→rouge
- Heatmap 24h × 7j en SVG natif (~3 KB), tooltip hover + a11y screen reader
- Bundle reports-component : 564 kB raw (Chart.js ~+180 kB, gzip ~+70 kB)

### 5. Web Push notifications ✅ LIVRÉ (commit `58c4c5f`)
Finalisation Sprint M : VAPID configurées, SW enrichi, onboarding contextuel,
toast critical avec son. Cf. [docs/18-web-push-deployment.md](18-web-push-deployment.md)
pour la procédure prod.

Ce qui a été livré :
- VAPID keys générables via `npx web-push generate-vapid-keys` (placeholders dans
  `.env.example` racine + `apps/api/.env.example` + `deploy/vps/.env.prod.example`)
- SW enrichi : `vibrate` (pattern long-court-long-court-long pour CRITICAL),
  `actions: [Acquitter, Voir]`, `tag: alertId` (anti-doublon), `renotify` pour
  re-pushs CRITICAL
- Backend `PushPayload` étendu (`severity`, `tag`) + dispatch transmet l'`alertId`
  côté SW
- Pont SW ↔ client : action "Acquitter" sur la notif système déclenche
  `POST /api/alerts/:id/acknowledge` côté client (le SW n'a pas le JWT)
- Onboarding contextuel `app-push-prompt` : banner discret affiché sous la
  topbar **seulement** quand au moins 1 CRITICAL non acquittée existe + browser
  supporté + pas déjà subscribed + pas dismiss < 7 jours
- Toast in-app CRITICAL (`ToastService.critical`) : style halo rouge pulsant,
  son WAV (`/assets/sounds/alert-critical.wav`, 14 KB), vibration mobile,
  debounce 2 s pour éviter le spam audio si plusieurs CRITICAL en rafale
- Audio pré-chargé au moment où l'utilisateur active le push (geste
  utilisateur récent → bypass autoplay policy)

Tests E2E validés en local (preview MCP, port 4201) :
- `/api/notifications/push/public-key` retourne `enabled: true` + clé
- SW chargé contient bien vibrate, actions, ACK_ALERT, renotify
- Asset audio servi (200 OK, 14 156 bytes, durée 0.32 s)
- `PushPromptComponent` apparaît automatiquement dès qu'une CRITICAL existe
- Toggle "Activer les notifications push" présent dans `/account → Notifications`
- Toast critical s'affiche avec actions Acquitter / Voir + halo rouge
- Pont SW message → ack confirmé via logs API (POST acknowledge déclenché 186 ms
  avant le fetch direct du test)

Tests requérant un vrai browser avec permission accordée (hors scope CI headless) :
- Notif système OS-level visible app au foreground / background / fermée
- Vibration physique sur device mobile
- Clic "Acquitter" / "Voir" depuis la barre de notifications OS
- Re-subscription : nouvel endpoint généré, ancien purgé par auto-pruning 410

### 6. Performance bundle
- `vehicle-detail-component` : 313 kB
- `map-component` : 197 kB
- `vehicles-list-component` : 159 kB

Audit avec `ng build --stats-json` + webpack-bundle-analyzer pour identifier
les imports lourds (DatePipe, DecimalPipe, etc.) et tree-shake / lazy-load.

## 📌 Items volontairement reportés

- **#14 datepicker option C (bibliothèque)** : option B (custom) suffit pour V1.8.
  Si retours utilisateur demandent plus de fonctionnalités (heures, semaines
  glissantes, locales), envisager `flatpickr` ou `@angular/material`.
- **/install standalone** : page accessible via banner PWA uniquement.
  À documenter dans onboarding plutôt qu'ajouter au menu (pas pertinent
  pour l'utilisateur quotidien).

## 🗒️ Notes techniques

### Test JWT FLEET_ADMIN sans Vizyo Auth
Pour tester en preview live sans le portail Vizyo Auth :
```js
const jwt = require('jsonwebtoken');
jwt.sign({
  iss: 'https://api.auth.vizyoagency.com',
  aud: 'api',
  sub: 'cmnusapj5000f07s7ipjkdcf4', // tracky1@gmail.com
  appId: 'cmnu688d80000okkrkxtw46o7',
  typ: 'access', jti: 't' + Date.now(),
  exp: Math.floor(Date.now() / 1000) + 3600,
}, '0Uuc+rSKheIoFsCnUMV1s2TfevSo1KvxKN3l7c5Sa8A=', { algorithm: 'HS256' });
```
Puis `localStorage.setItem('vizyo-tracky-token', token)` + setItem
`vizyo-tracky-user` avec role + fleetId pour activer les bypass `perms.can()`.

### Workflow worktree pour features ambitieuses
Pattern utilisé pour le bottom-sheet + datepicker (commit `7f1633a`) :
```bash
git worktree add .claude/worktrees/<branch-name> -b feat/<branch-name> main
cd .claude/worktrees/<branch-name>
pnpm install --prefer-offline --frozen-lockfile
cd packages/shared && pnpm build
# ... develop ...
git add . && git commit
cd ../../../  # back to main
git merge feat/<branch-name> --ff-only
git worktree remove .claude/worktrees/<branch-name> --force
git branch -D feat/<branch-name>
```
Permet de tester en preview sur port séparé (4201) sans risque sur main.

---

*Dernière mise à jour : 2026-05-02 (item #5 livré dans `feat/web-push-finalize`).*
