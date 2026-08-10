# Reprise — lot B-pages

> Écrit le 2026-08-11, à la fin de la séance qui a livré les maquettes, **B0′**, **B-kit** et
> les 23 premières lignes de **B-pages**.
> Branche `feat/refonte-tracky-v2`, **40 commits**, poussée sur `origin`, rien en attente.
> Feuille de route unique : `REFONTE-TRACKY-V2.md` — **496 / 604**.

---

## Le prompt à coller en première demande

> Reprends le lot **B-pages** de la refonte Tracky, sur la branche `feat/refonte-tracky-v2`.
> Lis d'abord `REPRISE-B-PAGES.md` à la racine, puis `REFONTE-TRACKY-V2.md` § « Bloc B ».
>
> **Trois règles non négociables :**
>
> 1. **Une maquette est une référence de conception, pas du code.** Les 28 planches sont dans
>    `design/maquettes/`. On traduit la décision en classes Tailwind existantes et en
>    composants du kit — jamais un style en ligne recopié.
> 2. **On reprend la décision de la planche, pas sa valeur, dès qu'elle tombe sous 4,5:1 sur
>    du texte.** Les planches sont tenues en thème sombre et plus lâches en clair ; trois
>    écarts sont déjà mesurés et tranchés dans `design/TOKENS.md`.
> 3. **Vérifie chaque page DANS LE NAVIGATEUR, à 375 px.** La sonde de recette est décrite
>    plus bas : elle a trouvé un bouton de navigation à 18 px de large, un menu stylé pour le
>    mobile seulement, et une carte de chaleur illisible au doigt. Aucun des trois ne se voit
>    en relisant le code.
>
> Ne modifie aucun DTO ni contrat d'API existant sans me demander.

---

## Où en est le travail

| Lot | État | |
|---|:-:|---:|
| Étape 0 · A1 · A2 · A5 · A3 · A4 | 🟢 livrés | — |
| **B0′** — reliquat du socle | 🟢 livré | 27/28 |
| **B-kit** — kit partagé | 🟢 livré | 26/28 |
| **B-pages** | 🟡 **en cours** | **23/57** |
| **B-mails** | ⬜ à faire | 0/12 |
| **PROD** | ⬜ à faire | 0/28 |

### Ce qui est fait dans B-pages

- `/vehicles/:id` — **10 onglets en 4 familles** (Suivi · Analyse · Sécurité · Exploitation).
  Le classement est une fonction pure, `features/vehicles/onglets-familles.ts`, et **9 tests**
  vérifient que l'union des familles redonne la liste d'entrée, pour tous les profils.
- **Mode simplifié** — le menu garde tout (il promettait « toutes les pages restent
  accessibles » et n'en montrait que 5 sur 13). Paramètres détaché, en violet, sous-titré
  « Revenir en interface complète ».
- **Carte de chaleur de `/reports`** — drill-down par jour. Ses 168 cellules ne se lisaient
  qu'au survol, inexistant au doigt.
- **Passe de cibles tactiles sur 15 pages**, mesurée avant/après à 375 px.

### Ce qui reste — 34 lignes

**Bloc F — surfaces bloquantes (12).** Le gros morceau. Coupure moteur (compte à rebours
pendant les 90 s, la raison du refus sort du `title`), consentement RGPD, vérification
d'appareil (6 cases séparées, collage depuis l'e-mail), QR véhicule, rejeu de trajet et de
période, création/édition de véhicule (« le boîtier devient facultatif »), éditeur d'horaires
(« bloc imbriqué derrière un filet vert »).

**Bloc A restant (3).** `/book/:token`, `/reserve/:token` (la dictée devient le chemin
principal — bouton 112 px), `/driver/unlock`. Elles demandent un jeton pour être ouvertes.

**Bloc B (1).** `/driver` — usage 100 % téléphone.

**Contenu propre de D et E.** `/fleet-admin/activity` (« le résultat avant l'événement »),
`/admin/ai-usage`, `/settings` (navigation à deux niveaux avec recherche), `/integrations`,
`/privacy-coverage`.

**Bloc G — le shell, EN DERNIER.** Ordre non négociable de `B1-PAGES.md`.

---

## La sonde de recette — à reposer au début de chaque séance

Les critères de recette de `B1-PAGES.md` se **mesurent**, ils ne se jugent pas. Coller ceci
dans la console du navigateur (`javascript_tool`), puis appeler `__recette('nom de la page')`
sur chaque route :

```js
window.__recette = function (nom) {
  const res = { page: nom, largeur: innerWidth, coupes: [], tronques: [], ciblesPetites: [], debordement: null };
  const decoratif = (el) => {
    if (el.closest('[aria-hidden="true"]')) return true;
    if (el.classList.contains('sr-only') || el.querySelector(':scope > .sr-only')) return true;
    const cs = getComputedStyle(el);
    return cs.pointerEvents === 'none' || cs.position === 'fixed';
  };
  for (const el of document.querySelectorAll('*')) {
    if (decoratif(el)) continue;
    const cs = getComputedStyle(el);
    if ((cs.overflow === 'hidden' || cs.overflowY === 'hidden') && el.clientHeight > 40) {
      const srh = [...el.children].filter(c => c.classList.contains('sr-only')).reduce((n, c) => n + c.scrollHeight, 0);
      const perdu = el.scrollHeight - el.clientHeight - srh;
      if (perdu > 8) res.coupes.push({ sel: (el.className || el.tagName).toString().slice(0, 45), perdu });
    }
    if (cs.textOverflow === 'ellipsis' && el.scrollWidth - el.clientWidth > 2 && (el.innerText || '').trim()) {
      res.tronques.push({ txt: (el.innerText || '').trim().slice(0, 34), titre: el.getAttribute('title') || el.closest('[title]')?.getAttribute('title') || null });
    }
  }
  if (innerWidth <= 430) {
    for (const el of document.querySelectorAll('button, a[href], [role="button"]')) {
      const r = el.getBoundingClientRect();
      if (r.width && r.height && (r.height < 44 || r.width < 44)) {
        res.ciblesPetites.push((el.innerText || el.getAttribute('aria-label') || '?').trim().slice(0, 22) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
      }
    }
  }
  res.debordement = document.documentElement.scrollWidth > innerWidth + 2 ? document.documentElement.scrollWidth - innerWidth : null;
  return res;
};
```

**Deux limites connues, à ne pas « corriger » :**

- elle compte une case à cocher isolément, alors que c'est son **étiquette** qui porte la
  cible (mesurée 44 × 128 sur `/login`) ;
- elle signale les **liens en ligne dans une phrase** (« Coûts IA », « Se connecter »). Les
  élargir casserait le texte. Le critère vise les commandes, pas la typographie.

Six cibles restent signalées pour ces deux raisons. Aucune n'appelle une correction.

---

## Les cinq contrôles qui tournent

```bash
pnpm verif:litteraux && pnpm verif:contraste && pnpm verif:accents && pnpm verif:confirmations && pnpm verif:couleurs-kit
```

| | |
|---|---|
| `verif:litteraux` | un accent grave dans un commentaire de `template:`/`styles:` **ferme le littéral** — `tsc` passe, Angular échoue sans nommer le fichier, et le serveur sert un bundle périmé. M'a rattrapé 4 fois cette séance |
| `verif:contraste` | 46 couples dans les deux thèmes |
| `verif:accents` | mots français sans accent dans les chaînes affichées, bornes Unicode (le `\b` ASCII casse sur « paramètres ») |
| `verif:confirmations` | une modale de danger sans `[consequences]` |
| `verif:couleurs-kit` | hex, classes de palette Tailwind **et `rgba()` teintés** dans `shared/ui` et `shared/components` |

**`pnpm verify` se termine maintenant** (~40 s) : typecheck · smoke · 277 partagés · 328 web ·
1900 API. Le P1 de la feuille de route est corrigé.

---

## Les pièges de cette base, déjà payés

1. **Backtick dans un commentaire de `template:`/`styles:`** — cf. ci-dessus. `pnpm verif:litteraux`.
2. **Une règle CSS correcte qui ne s'applique pas.** Trois fois cette séance : enfermée dans
   un `@media (max-width: 768px)` alors que le mode simplifié navigue au bouton à toute
   largeur · écrasée par une seconde règle plus bas dans la même feuille · écrite dans un
   composant alors que l'écran mesuré est **son jumeau** (`installation-editor` vs
   `installations-client`, mêmes classes, feuilles séparées par l'encapsulation).
   **Toujours corriger la source, jamais empiler une règle de plus.**
3. **Le cookie de session prime sur le jeton Bearer.** Pour tester un rôle :
   `await fetch('/api/auth/logout', {method:'POST', credentials:'include'})` **avant**
   d'injecter le jeton dans `localStorage` (`vizyo-tracky-token`).
4. **Prisma échoue sur `localhost` après une veille** — Node résout en IPv6 et le proxy Docker
   tombe. Forcer `127.0.0.1`. Ne pas modifier le `.env` de l'utilisateur.
5. **`ng test` du web** : Karma/Jasmine, **pas Jest**. `it.each` et `jest.fn()` ne compilent
   pas — et cassent **toute** la suite, pas seulement leur fichier.

### Remonter l'environnement

```bash
docker compose up -d
```

Puis `preview_start` sur `web-refonte` (4205) et `api-refonte` (3000). Jeton admin :

```bash
pnpm --filter @vizyo/tracky-api exec ts-node prisma/gen-test-token.ts
```

---

## ⚠️ Deux choses à ne pas rater

**1. Du travail en cours qui n'est pas le nôtre.** `apps/api/src/tracker-fix-mode/` porte des
modifications **non commitées** : un `AckWaiterService` ajouté au constructeur du service sans
être fourni au module de test → **30 tests en échec**. Les commits de cette séance stagent
`apps/web` uniquement. **Ne pas committer ces fichiers, ne pas les corriger sans demander.**
Même chose pour `docs/centre-alerte/` et `docs/vps-audit/`, modifiés hors de ce chantier.

**2. Une décision en attente.** La **variante critique** de `confirm-modal` existe — liseré
rouge, état de l'objet rappelé, plaque à retaper — mais elle **n'est branchée nulle part**.
`B1-PAGES.md` § F la spécifie pour la coupure moteur. Ajouter une saisie à un geste d'urgence
est une décision d'écran, pas de kit : **demander avant de la brancher**.

---

## Ce que le kit met à disposition, et qu'il faut utiliser

- **`<app-zone>`** (`shared/ui/zone/`) — les **6 états** rendus une fois : `chargement`
  (squelette, et une sortie au-delà de 8 s) · `rempli` · `vide` · `erreur` (toujours un
  recours) · `partiel` (le contenu reste, un bandeau nomme ce qui manque) · `interdit`
  (**nomme la permission**, libellé tiré de `PERMISSION_LABELS`).
  **Le brancher dans les écrans qui gèrent encore leurs états à la main est le vrai travail
  de fond de B-pages.**
- **`<app-confirm-modal>`** — `consequences` chiffrées obligatoires sur un danger,
  `irreversible`, `critique`, feuille sous 640 px.
- **`<app-bottom-sheet>`** — géométrie de plateforme (jetons `--feuille-*`), hauteur
  annonçable, variante `sansVoile` pour les feuilles posées sur la carte.
- **Jetons `--texte-*`** — le petit texte lisible dans les deux thèmes. `--danger` reste le
  rouge des liserés ; `--texte-alerte` est celui des caractères.
- **`--surface-quaternary`** — ce qui se pose SUR une carte (chips, squelettes).

---

## Le journal de bord

`REFONTE-TRACKY-V2.md` se termine par un tableau « Journal de bord », une ligne par séance.
**Le tenir à jour** : c'est lui qui porte les décisions et les points ouverts d'une séance à
l'autre.
