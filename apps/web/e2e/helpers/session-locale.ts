import type { Page } from '@playwright/test';

/**
 * Lot A6 — ouverture de session SANS mot de passe, pour la recette automatisée.
 *
 * ┌─ POURQUOI CE SECOND CHEMIN À CÔTÉ DE `login()` ───────────────────────────┐
 * │ `helpers/auth.ts` remplit le formulaire avec `E2E_TEST_EMAIL/PASSWORD`.    │
 * │ Il suppose donc des identifiants valides côté Vizyo Auth — un service      │
 * │ EXTERNE, que la recette locale n'a aucune raison d'appeler et qui n'est    │
 * │ pas joignable depuis un poste de développement hors ligne.                 │
 * │                                                                            │
 * │ Ici on pose directement le jeton d'accès, signé localement avec le secret  │
 * │ du `.env`. C'est le « bypass via JWT généré localement » que TEST_PLAN T04 │
 * │ décrit déjà, et c'est aussi ce que fait n'importe quelle suite E2E qui ne  │
 * │ veut pas rejouer l'écran de connexion à chaque test : ce qu'on vient       │
 * │ éprouver, ce sont les écrans A6, pas l'authentification — qui a ses        │
 * │ propres tests.                                                             │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ LE JETON EST POSÉ AVANT LE PREMIER RENDU (`addInitScript`), et pas après un
 * `goto`. Le garde de route lit `localStorage` à l'activation : poser le jeton après
 * la navigation ferait passer par `/login`, avec une redirection qui fausse tout ce
 * qui suit — et un test qui « échoue au hasard » selon la vitesse de la machine.
 *
 * ⚠️ ON PURGE AUSSI LE COOKIE DE SESSION. `JwtAuthGuard` lit `tracky_at` EN PRIORITÉ
 * et ne retombe sur l'en-tête `Authorization` qu'à défaut. Un cookie laissé par un
 * test précédent ferait donc travailler tout le scénario sous le compte de l'autre
 * camp, en silence, avec des assertions qui passent pour de mauvaises raisons.
 */
export type CampRecette = 'CARRIER' | 'DEPOT';

const JETONS: Record<CampRecette, string | undefined> = {
  CARRIER: process.env['A6_TOKEN_CARRIER'],
  DEPOT: process.env['A6_TOKEN_DEPOT'],
};

export function jetonPresent(camp: CampRecette): boolean {
  return !!JETONS[camp];
}

export async function ouvrirSession(page: Page, camp: CampRecette): Promise<void> {
  const jeton = JETONS[camp];
  if (!jeton) throw new Error(`Jeton A6_TOKEN_${camp} manquant`);

  // Le cookie d'abord : il prime sur l'en-tête, cf. l'avertissement ci-dessus.
  await page.context().clearCookies();

  const profil = await recupererProfil(page, jeton);
  await page.addInitScript(
    ([t, u]) => {
      localStorage.setItem('vizyo-tracky-token', t as string);
      localStorage.setItem('vizyo-tracky-user', u as string);
      localStorage.setItem('vizyo-tracky-remember', '1');

      // ⚠️ LES PORTAILS DE PREMIER LANCEMENT SONT MARQUÉS COMME DÉJÀ VUS.
      //
      // `<app-permissions-gate>` s'affiche en plein écran tant que
      // `tracky.perms.onboarded` est absent — c'est-à-dire toujours, dans un
      // profil de navigateur neuf comme celui d'un test. Il INTERCEPTE LES CLICS
      // sur tout l'écran derrière lui : sans cette ligne, la recette échoue au
      // premier bouton, avec un message qui parle d'un élément « qui intercepte
      // les événements de pointeur » et ne nomme jamais le portail.
      //
      // Ces portails ont leurs propres tests. Ce qu'on éprouve ici, ce sont les
      // écrans A6 — un utilisateur réel les a franchis depuis longtemps.
      localStorage.setItem('tracky.perms.onboarded', '1');
      localStorage.setItem('tracky.pwa.dismissed', '1');
      localStorage.setItem('tracky.pwa.visits', '99');
    },
    [jeton, JSON.stringify(profil)],
  );
}

/**
 * Le profil vient du SERVEUR, jamais d'un objet écrit à la main dans le test.
 *
 * Le front lit `user.permissions?.[cle] === true` pour décider ce qu'il affiche. Un
 * profil fabriqué dans le test finirait par diverger du vrai — et la recette
 * vérifierait alors un écran que personne ne voit en production.
 */
async function recupererProfil(page: Page, jeton: string): Promise<unknown> {
  const base = process.env['E2E_BASE_URL'] ?? 'http://localhost:4211';
  const reponse = await page.request.get(`${base}/api/users/me`, {
    headers: { Authorization: `Bearer ${jeton}` },
  });
  if (!reponse.ok()) {
    throw new Error(`/api/users/me a répondu ${reponse.status()} — l'API est-elle lancée ?`);
  }
  return reponse.json();
}

/** Le téléphone de référence du chantier : 375 px, la règle non négociable n° 3. */
export const TELEPHONE = { width: 375, height: 812 } as const;

/**
 * Attend que l'écran de démarrage se soit retiré, puis photographie.
 *
 * ⚠️ `#app-splash` vit dans `index.html` et se dissipe APRÈS le premier rendu. Une
 * capture prise sans l'attendre montre le logo Vizyo sur fond clair — et pas l'écran.
 * Les assertions, elles, passent : Playwright attend l'élément qu'on lui nomme, pas
 * la fin de l'animation. On obtenait donc une recette verte accompagnée de preuves
 * illisibles, ce qui est la pire combinaison — on croit avoir regardé.
 */
export async function capture(page: Page, chemin: string, pleinePage = false): Promise<void> {
  await page
    .locator('#app-splash')
    .waitFor({ state: 'detached', timeout: 10_000 })
    .catch(() => undefined); // déjà parti : rien à attendre
  // Les transitions de vue durent ~300 ms ; on laisse le rendu se stabiliser.
  await page.waitForTimeout(450);
  await page.screenshot({ path: chemin, fullPage: pleinePage });
}

/**
 * Le rapport de contraste RÉELLEMENT rendu, mesuré dans le DOM.
 *
 * `verif-contraste.mjs` calcule sur les JETONS, ce qui est reproductible mais aveugle
 * à un cas précis : une variable CSS qui n'existe pas dans le contexte où le composant
 * est rendu. La couleur retombe alors sur l'héritage, et le script continue de mesurer
 * un jeton que l'écran n'applique pas. C'est exactement le piège `--depot-*` hors de
 * `.layout--depot`. Ici on lit ce que le navigateur affiche.
 */
export async function contrasteRendu(page: Page, selecteur: string): Promise<number | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;

    /**
     * ⚠️ ON PASSE PAR UN CANVAS, ET C'EST OBLIGATOIRE ICI.
     *
     * Les jetons de ce produit sont des `color-mix(in srgb, …)`. Chrome ne les
     * resout plus en `rgb()` dans `getComputedStyle` : il rend `color(srgb …)` ou
     * `oklab(…)` selon les cas. Une expression reguliere sur `rgba?\(` renvoie donc
     * `null` — et un controle de contraste qui renvoie `null` ne mesure rien du tout,
     * en ayant l'air de fonctionner.
     *
     * `ctx.fillStyle` accepte N'IMPORTE QUELLE couleur CSS et la peint : on lit le
     * pixel, on obtient du RGBA reel. C'est le navigateur qui fait la conversion,
     * exactement celle qu'il applique a l'ecran.
     */
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return null;
    const rgba = (css: string): [number, number, number, number] | null => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#123456'; // temoin : une couleur illisible le laisserait en place
      ctx.fillStyle = css;
      if (ctx.fillStyle === '#123456' && css !== '#123456') return null;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };

    /** Une couche semi-transparente posee sur ce qu'il y a derriere. */
    const composer = (
      dessus: [number, number, number, number],
      dessous: [number, number, number],
    ): [number, number, number] => [
      dessus[0] * dessus[3] + dessous[0] * (1 - dessus[3]),
      dessus[1] * dessus[3] + dessous[1] * (1 - dessus[3]),
      dessus[2] * dessus[3] + dessous[2] * (1 - dessus[3]),
    ];

    /**
     * Le fond REELLEMENT vu : on empile les fonds des ancetres, du plus profond au
     * plus proche. Les encarts de ce lot sont des lavis a 10-16 % — s'arreter au
     * premier fond non transparent donnerait un rapport qui n'existe pas a l'ecran.
     */
    const couches: Array<[number, number, number, number]> = [];
    for (let n: Element | null = el; n; n = n.parentElement) {
      const c = rgba(getComputedStyle(n).backgroundColor);
      if (c && c[3] > 0) couches.push(c);
      if (c && c[3] >= 0.999) break;
    }
    let fond: [number, number, number] = [255, 255, 255];
    for (const c of couches.reverse()) fond = composer(c, fond);

    const t = rgba(getComputedStyle(el).color);
    if (!t) return null;
    const texte = composer(t, fond);

    const lum = (c: [number, number, number]) => {
      const f = (v: number) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const [a, b] = [lum(texte), lum(fond)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }, selecteur);
}

/**
 * La page déborde-t-elle horizontalement ?
 *
 * Le défilement latéral sur téléphone est le symptôme n° 1 d'un enfant de grille ou de
 * flex sans `min-width: 0` — un piège explicitement listé au § 10 du plan. Il ne se
 * voit pas sur une capture, seulement à la mesure.
 */
export async function deborde(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
}
