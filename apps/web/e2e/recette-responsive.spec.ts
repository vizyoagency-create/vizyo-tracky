import { expect, test, type Page } from '@playwright/test';

/**
 * ── RECETTE RESPONSIVE — TOUT L'APPLICATIF À 375 px ───────────────────────────────────
 *
 * Les recettes précédentes vérifiaient UN lot à la fois. Celle-ci balaie l'application
 * entière, écran par écran, avec la même sonde partout : c'est la seule façon d'attraper
 * ce qu'une revue de code ne voit jamais — une rangée flex qui se chevauche, un tableau
 * qui pousse la page, un bouton que le doigt rate.
 *
 * ⚠️ ELLE MESURE, ELLE NE REGARDE PAS. Une capture d'écran prouve qu'un écran est joli ;
 * elle ne dit pas qu'un bouton fait 19 px. Les quatre contrôles sont chiffrés :
 *
 *   1. DÉBORDEMENT — la page ne défile jamais latéralement. C'est le défaut le plus
 *      visible pour un utilisateur, et le plus facile à introduire sans le voir.
 *   2. CE QUI POUSSE — quand ça déborde, on veut le NOM du coupable, pas le symptôme.
 *   3. TABLEAUX — un tableau plus large que l'écran doit vivre dans un conteneur qui
 *      défile, sinon il emporte la page avec lui.
 *   4. CIBLES TACTILES — 44 px, la règle non négociable n° 2 du chantier.
 *
 * ⚠️ ET LA BARRE DU HAUT, qui n'appartient à aucun écran et les casse tous : ses deux
 * moitiés se chevauchaient de 39 px à 375 px, le sélecteur de société passant par-dessus
 * le logo. Mesuré ici une fois pour toutes.
 *
 * Lancement :
 *   $env:E2E_TOKEN_ADMIN = '<jwt super-admin>'
 *   $env:E2E_BASE_URL = 'http://localhost:4213'; $env:E2E_SKIP_DEV_SERVER = '1'
 *   pnpm --filter @vizyo/tracky-web exec playwright test recette-responsive
 */

const TELEPHONE = { width: 375, height: 812 } as const;
const JETON = process.env['E2E_TOKEN_ADMIN'];

/** Les écrans du transporteur et de l'administration, dans l'ordre de la navigation. */
const ECRANS: { route: string; nom: string; ancre?: string }[] = [
  { route: '/dashboard', nom: 'Tableau de bord' },
  { route: '/map', nom: 'Carte' },
  { route: '/vehicles', nom: 'Véhicules' },
  { route: '/alerts', nom: 'Alertes' },
  { route: '/agenda', nom: 'Agenda' },
  { route: '/missions', nom: 'Missions' },
  { route: '/geofences', nom: 'Géofences' },
  { route: '/places', nom: 'Lieux clés' },
  { route: '/groups', nom: 'Groupes' },
  { route: '/drivers', nom: 'Conducteurs' },
  { route: '/reports', nom: 'Rapports' },
  { route: '/scores', nom: 'Scores de conduite' },
  { route: '/users', nom: 'Utilisateurs' },
  { route: '/users/overview', nom: 'Panorama des droits' },
  { route: '/fleet-schedules', nom: 'Horaires de flotte' },
  { route: '/privacy-coverage', nom: 'Couverture vie privée' },
  { route: '/settings', nom: 'Réglages' },
  { route: '/account', nom: 'Mon compte' },
  { route: '/integrations', nom: 'Intégrations' },
  { route: '/installations', nom: 'Installations' },
  { route: '/admin', nom: 'Administration' },
  { route: '/admin/communications', nom: 'Communications' },
  { route: '/admin/emails', nom: 'E-mails' },
  { route: '/admin/sms', nom: 'SMS' },
  { route: '/admin/observability', nom: 'Observabilité' },
  { route: '/admin/system', nom: 'Système VPS' },
  { route: '/admin/trackers', nom: 'Boîtiers' },
  { route: '/admin/commands', nom: 'Commandes' },
  { route: '/admin/sims', nom: 'Cartes SIM' },
  { route: '/admin/subscriptions', nom: 'Abonnements' },
  { route: '/admin/activity', nom: 'Activité' },
  { route: '/admin/retention', nom: 'Rétention' },
];

interface Constat {
  deborde: boolean;
  largeurDoc: number;
  pousse: string[];
  tableaux: string[];
  cibles: string[];
  barreChevauchement: number;
}

/**
 * La sonde, injectée dans la page.
 *
 * ⚠️ `.sr-only` EST EXCLU, et c'est une correction. Ces tableaux existent pour les
 * lecteurs d'écran : ils mesurent 765 px, sont retirés du flux visuel, et ne poussent
 * rien. Les compter donnait un faux positif sur chaque page qui porte un graphique.
 */
async function sonder(page: Page): Promise<Constat> {
  return page.evaluate(() => {
    const vue = document.documentElement.clientWidth;
    const racine = document.querySelector('main') ?? document.body;
    const cache = (el: Element) =>
      !!el.closest('.sr-only, [aria-hidden="true"]') || el.classList.contains('sr-only');
    const nommer = (el: Element) => {
      const c = (el.className || '').toString().trim().split(/\s+/).slice(0, 2).join('.');
      return `${el.tagName.toLowerCase()}${c ? '.' + c : ''}`;
    };
    const defilant = (el: Element | null) => {
      let n = el;
      while (n && n !== racine) {
        const st = getComputedStyle(n);
        if (st.overflowX === 'auto' || st.overflowX === 'scroll') return true;
        n = n.parentElement;
      }
      return false;
    };

    const pousse = [...racine.querySelectorAll('*')]
      .filter((el) => {
        if (cache(el)) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= vue + 1 || r.height === 0) return false;
        const st = getComputedStyle(el);
        if (st.overflowX === 'auto' || st.overflowX === 'scroll') return false;
        // ⚠️ UNE DÉCORATION HORS FLUX NE POUSSE RIEN, et l'accuser fait chercher un
        // défaut qui n'existe pas. Le halo du tableau de bord fait 600 px de large,
        // mais il est en `position: absolute`, `pointer-events: none`, et son parent
        // le coupe : la page reste à 375. Ce qu'on traque, c'est ce qui ÉLARGIT le
        // document — pas ce qui dépasse d'un cadre qui le contient.
        if (st.position === 'absolute' || st.position === 'fixed') {
          if (st.pointerEvents === 'none') return false;
        }
        return !defilant(el.parentElement);
      })
      .slice(0, 6)
      .map((el) => `${nommer(el)} ${Math.round(el.getBoundingClientRect().width)}px`);

    const tableaux = [...racine.querySelectorAll('table')]
      .filter((t) => !cache(t) && t.getBoundingClientRect().width > vue + 1 && !defilant(t.parentElement))
      .map((t) => `${nommer(t)} ${Math.round(t.getBoundingClientRect().width)}px`);

    const cibles = [...racine.querySelectorAll(
      'button, a[href], select, input, textarea, [role="button"], [role="tab"]',
    )]
      .filter((el) => {
        if (cache(el)) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const t = (el as HTMLInputElement).type;
        if (t === 'checkbox' || t === 'radio') {
          const lab = el.closest('label');
          if (lab && lab.getBoundingClientRect().height >= 44) return false;
        }
        // ⚠️ LES MÊMES EXCEPTIONS QUE LA RÈGLE, sans quoi la sonde réclame ce que la
        // feuille de styles refuse volontairement — et on court après un seuil que
        // personne n'a l'intention de tenir. Cf. le commentaire de `styles.css`.
        //   — un lien DANS UNE PHRASE (WCAG 2.5.8 l'exempte) ;
        //   — une cellule de visualisation : c'est une donnée, pas une commande.
        if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') return false;
        if (el.closest('.hm-cell, .tracky-marker')) return false;
        return Math.round(r.height) < 44;
      })
      .slice(0, 8)
      .map((el) => {
        const r = el.getBoundingClientRect();
        const nom =
          el.getAttribute('aria-label') ||
          (el.textContent || '').trim().slice(0, 22) ||
          (el as HTMLInputElement).placeholder ||
          '(sans nom)';
        return `${Math.round(r.height)}px ${nommer(el)} « ${nom} »`;
      });

    const g = document.querySelector('.top-bar-left');
    const d = document.querySelector('.top-actions');
    const barreChevauchement =
      g && d ? Math.max(0, Math.round(g.getBoundingClientRect().right - d.getBoundingClientRect().left)) : 0;

    return {
      deborde: document.documentElement.scrollWidth > vue + 1,
      largeurDoc: document.documentElement.scrollWidth,
      pousse,
      tableaux,
      cibles,
      barreChevauchement,
    };
  });
}

test.describe('Recette responsive — toute l\'application à 375 px', () => {
  test.skip(!JETON, 'E2E_TOKEN_ADMIN manquant');
  test.use({ viewport: TELEPHONE });

  test.beforeEach(async ({ page, baseURL }) => {
    // ⚠️ LE COOKIE, PAS SEULEMENT `localStorage`. `JwtAuthGuard` lit `tracky_at` EN
    // PRIORITÉ : sans lui, la session retombait sur l'écran de connexion au bout de
    // quelques navigations, et le balayage mesurait la page de login trente fois.
    const origine = new URL(baseURL ?? 'http://localhost:4213');
    await page.context().addCookies([
      { name: 'tracky_at', value: JETON!, domain: origine.hostname, path: '/' },
    ]);
    const profil = await (await page.request.get(`${baseURL}/api/users/me`, {
      headers: { Authorization: `Bearer ${JETON}` },
    })).json();
    await page.addInitScript(
      ([t, u]) => {
        localStorage.setItem('vizyo-tracky-token', t as string);
        localStorage.setItem('vizyo-tracky-user', u as string);
        localStorage.setItem('vizyo-tracky-remember', '1');
        localStorage.setItem('tracky.pwa.dismissed', '1');
        localStorage.setItem('tracky.pwa.visits', '99');
      },
      [JETON!, JSON.stringify(profil)],
    );
  });

  for (const ecran of ECRANS) {
    test(`${ecran.nom} (${ecran.route})`, async ({ page }) => {
      await page.goto(ecran.route);
      // On attend que la coque soit montée : mesurer pendant le rendu donne des
      // largeurs qui n'ont jamais existé à l'écran.
      await page.locator('.top-bar').waitFor({ state: 'visible', timeout: 20_000 });
      await page.waitForTimeout(1800);

      expect(page.url(), `${ecran.nom} renvoie vers la connexion`).not.toContain('/login');

      const c = await sonder(page);

      expect(c.barreChevauchement, `barre du haut : ${c.barreChevauchement}px de chevauchement`).toBe(0);
      expect(
        c.pousse,
        `${ecran.nom} : ${c.largeurDoc}px de large — ce qui pousse : ${c.pousse.join(', ')}`,
      ).toEqual([]);
      expect(c.deborde, `${ecran.nom} déborde horizontalement (${c.largeurDoc}px)`).toBe(false);
      expect(c.tableaux, `${ecran.nom} : tableau sans conteneur défilant`).toEqual([]);
      expect(c.cibles, `${ecran.nom} : cibles sous 44 px`).toEqual([]);
    });
  }

  /**
   * ── LES MODALES ──────────────────────────────────────────────────────────────────
   *
   * ⚠️ UN BALAYAGE DE PAGES NE LES VOIT JAMAIS. Elles n'existent qu'après un clic, et
   * c'est précisément là que les défauts se cachent : une modale est plus étroite que la
   * page, ses champs sont plus serrés, et ses boutons d'action vivent dans un pied fixe.
   * Trois d'entre elles ont déjà coûté cher sur ce chantier — la modale de mission était
   * couverte par la barre du bas, sa croix faisait 26 px, ses deux listes n'avaient pas
   * de nom accessible.
   */
  const MODALES: { nom: string; route: string; ouvrir: string; avant?: string }[] = [
    // ⚠️ L'agenda s'ouvre sur le CALENDRIER : le bouton de création de mission n'existe
    // qu'après avoir choisi le segment « Mission ». Sans ce préalable, le scénario était
    // sauté — et un test sauté ressemble à s'y méprendre à un test qui passe.
    // Il éprouve au passage la barre de segments rendue défilante : « Mission » est le
    // cinquième, celui qui sortait de l'écran.
    { nom: 'Nouvelle mission', route: '/agenda', avant: 'Mission', ouvrir: 'Nouvelle mission' },
    { nom: 'Nouveau véhicule', route: '/vehicles', ouvrir: 'Ajouter' },
    { nom: 'Nouveau groupe', route: '/groups', ouvrir: 'Nouveau groupe' },
    { nom: 'Nouveau conducteur', route: '/drivers', ouvrir: 'Nouveau' },
  ];

  for (const m of MODALES) {
    test(`Modale — ${m.nom}`, async ({ page }) => {
      await page.goto(m.route);
      await page.locator('.top-bar').waitFor({ state: 'visible', timeout: 20_000 });
      await page.waitForTimeout(1500);

      if (m.avant) {
        const segment = page.getByRole('button', { name: m.avant, exact: true }).first();
        await expect(segment).toBeVisible({ timeout: 15_000 });
        await segment.click();
        await page.waitForTimeout(1200);
      }

      const declencheur = page.getByRole('button', { name: new RegExp(m.ouvrir, 'i') }).first();
      await expect(declencheur, `déclencheur « ${m.ouvrir} » introuvable sur ${m.route}`).toBeVisible({
        timeout: 15_000,
      });
      await declencheur.click();
      const modale = page.locator('[role="dialog"], .md-panel, .depot-modal-panel').first();
      await expect(modale).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(900);

      const c = await sonder(page);
      expect(c.deborde, `${m.nom} : la page déborde une fois la modale ouverte`).toBe(false);
      expect(c.cibles, `${m.nom} : cibles sous 44 px`).toEqual([]);

      // ⚠️ ON DEMANDE AU NAVIGATEUR QUI EST DESSUS, ON NE COMPARE PAS LES z-index.
      //
      // Première version de ce contrôle : lire le `z-index` du panneau et celui de la
      // barre du bas. Elle accusait à tort les deux tiroirs — leur panneau ne porte
      // aucun z-index, mais il vit DANS un conteneur en 9000, qui crée un contexte
      // d'empilement et emporte tout son contenu au-dessus de la barre en 7000. Un
      // z-index ne se lit pas isolément : il n'a de sens que dans son contexte.
      //
      // `elementFromPoint` tranche sans rien supposer : c'est la même question que se
      // pose le doigt, et la même que Playwright pose avant de refuser un clic. Le
      // défaut visé reste réel — la modale de mission était couverte par la barre du
      // bas, et on ne pouvait pas créer de mission depuis un téléphone.
      const couverte = await page.evaluate(() => {
        const p = document.querySelector(
          '[role="dialog"], .md-panel, .depot-modal-panel',
        ) as HTMLElement | null;
        const barre = document.querySelector('.bottom-bar') as HTMLElement | null;
        if (!p || !barre || getComputedStyle(barre).display === 'none') return false;
        const rp = p.getBoundingClientRect();
        const rb = barre.getBoundingClientRect();
        if (rp.bottom <= rb.top) return false; // la modale ne descend pas jusqu'à la barre
        // Un point au coeur de la zone commune : qui répond ?
        const y = Math.min(rp.bottom, rb.bottom) - 8;
        const x = rp.left + rp.width / 2;
        const dessus = document.elementFromPoint(x, y);
        return !!dessus && !p.contains(dessus) && dessus !== p;
      });
      expect(couverte, `${m.nom} : la barre du bas passe par-dessus le pied de la modale`).toBe(false);
    });
  }
});
