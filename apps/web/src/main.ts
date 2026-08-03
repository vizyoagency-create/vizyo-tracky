import { registerLocaleData } from '@angular/common';
import localeFr from '@angular/common/locales/fr';
import { bootstrapApplication } from '@angular/platform-browser';

/**
 * ── POURQUOI CET ENREGISTREMENT (incident du 2026-07-29) ─────────────────────────────
 *
 * Angular n'embarque QUE la locale « en-US ». Deux pipes de l'écran « Abonnements & tarifs »
 * demandent explicitement la locale française — `{{ x | number : '1.0-0' : 'fr' }}` — et
 * Angular ne trouvait pas les données correspondantes. `DecimalPipe` réemballe alors
 * l'erreur en **NG02100 (InvalidPipeArgument)**, qui remonte en erreur non rattrapée.
 *
 * Le premier de ces deux pipes affiche le REVENU ANNUEL TOTAL, en haut de page : l'écran
 * de pilotage commercial cassait donc à l'affichage. Deux occurrences remontées au centre
 * d'alerte le 29/07 depuis un iPhone, sans qu'aucun test ni aucun build ne le voie —
 * `ng build` ne charge pas les locales, et l'erreur ne survient qu'à l'exécution du pipe.
 *
 * ⚠️ On enregistre la locale SANS toucher à `LOCALE_ID`. C'est délibéré : changer la locale
 * par défaut modifierait le formatage de TOUS les nombres et de TOUTES les dates de
 * l'application d'un seul coup. Ici on se contente de rendre disponible ce que deux pipes
 * réclamaient déjà — le reste de l'application ne bouge pas d'un pixel.
 */
registerLocaleData(localeFr);
import { appConfig } from './app/app.config';
import { App } from './app/app';

// Doit etre >= duree de l'animation `splash-rise` (720ms) pour eviter de couper
// le logo en plein "rise". 800ms laisse aussi respirer visuellement.
const SPLASH_MIN_DURATION_MS = 800;
// Doit matcher la transition CSS `opacity 480ms` dans index.html.
const SPLASH_FADE_MS = 480;
const SPLASH_FALLBACK_MS = 8000;

const splashStartedAt = performance.now();

function hideSplash(): void {
  const el = document.getElementById('app-splash');
  if (!el) return;
  if (el.dataset['hiding'] === '1') return;
  el.dataset['hiding'] = '1';

  const elapsed = performance.now() - splashStartedAt;
  const wait = Math.max(0, SPLASH_MIN_DURATION_MS - elapsed);

  setTimeout(() => {
    el.classList.add('is-hidden');
    setTimeout(() => {
      el.remove();
      document.documentElement.classList.remove('app-splash-active');
    }, SPLASH_FADE_MS);
  }, wait);
}

// V1.10 (Sprint 6) — Cleanup defensif des registrations SW orphelines.
// V1.11 a fusionne ngsw + sw.js en un seul fichier `/sw.js` qui charge ngsw
// via importScripts. Les users qui ont une vieille version cachee avec une
// registration directe de `/ngsw-worker.js` se retrouvent avec 2 SWs au scope
// `/` (notre nouveau /sw.js + l'ancien ngsw-worker.js direct), race
// d'inscription qui faisait disparaitre setAppBadge et les push iOS PWA.
// On unregister tout SW qui n'a pas pour scriptURL `/sw.js`.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    for (const reg of regs) {
      const url = reg.active?.scriptURL ?? reg.installing?.scriptURL ?? reg.waiting?.scriptURL ?? '';
      // Si l'URL pointe vers ngsw-worker.js directement (sans passer par /sw.js),
      // c'est une registration orpheline. On la retire.
      if (url.includes('/ngsw-worker.js') && !url.endsWith('/sw.js')) {
        // eslint-disable-next-line no-console
        console.warn('[SW] cleanup orphan registration', url);
        reg.unregister().catch(() => undefined);
      }
    }
  }).catch(() => undefined);
}

// Fallback : meme si le bootstrap stalle, on n'emprisonne pas l'utilisateur.
const fallback = setTimeout(hideSplash, SPLASH_FALLBACK_MS);

bootstrapApplication(App, appConfig)
  .then(() => {
    clearTimeout(fallback);
    hideSplash();
  })
  .catch((err) => {
    console.error(err);
    clearTimeout(fallback);
    hideSplash();
  });
