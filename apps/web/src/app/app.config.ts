import { ApplicationConfig, ErrorHandler, isDevMode, LOCALE_ID, provideBrowserGlobalErrorListeners, provideZoneChangeDetection } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter, withPreloading, PreloadAllModules, withViewTransitions, TitleStrategy } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';

import { routes } from './app.routes';
import { GlobalErrorHandler } from './core/error/global-error-handler';
import { authInterceptor } from './core/interceptors/auth.interceptor';
import { errorReportInterceptor } from './core/interceptors/error-report.interceptor';
import { AppTitleStrategy } from './core/title.strategy';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    /**
     * Format FRANÇAIS par défaut pour les nombres et les dates.
     *
     * ⚠️ Sans cela, Angular formate en `en-US` : la distance totale des rapports
     * s'affichait « 27,944.4 km ». Un francophone lit cela comme vingt-sept virgule neuf
     * cent quarante-quatre — mille fois moins. Un chiffre de pilotage n'a pas le droit
     * d'être ambigu.
     *
     * ⚠️ Dépend de `registerLocaleData(localeFr)` dans `main.ts` : sans lui, tout pipe
     * numérique lèverait NG02100 au lieu d'afficher une valeur. Les deux vont ensemble.
     */
    { provide: LOCALE_ID, useValue: 'fr' },
    provideZoneChangeDetection({ eventCoalescing: true }),
    // V1.10 (Sprint 5 stabilite) — ErrorHandler global qui toast les erreurs
    // uncaught (sync, async, promises) avec dedup. Empeche le silence "ca bug
    // mais on voit rien" remonte par les clients.
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
    provideRouter(
      routes,
      // Precharge tous les bundles lazy en idle apres le boot initial -> 1er clic instantane
      withPreloading(PreloadAllModules),
      // Cross-fade natif entre routes (Chromium full, Safari 18+)
      withViewTransitions(),
    ),
    { provide: TitleStrategy, useClass: AppTitleStrategy },
    // errorReportInterceptor en 1er = le plus externe : voit l'erreur finale de toute la
    // chaîne (réseau/infra) et la remonte au centre d'alerte. authInterceptor gère le token/401.
    provideHttpClient(withInterceptors([errorReportInterceptor, authInterceptor])),
    // Service Worker : on registre `/sw.js` (notre SW custom) qui charge
    // ngsw-worker.js via importScripts en interne. Ca evite le bug "double SW
    // race" en standalone PWA iOS qui empechait le badge "1" de fonctionner
    // en background. Voir public/sw.js pour le detail.
    //
    // registrationStrategy: 'registerImmediately' au lieu de 'registerWhenStable:30000'
    // pour que le SW soit dispo des l'arrivee sur le dashboard — important pour
    // que les push subscriptions s'ancrent sur notre SW combine plutot que sur
    // un ancien ngsw separe encore en cache.
    provideServiceWorker('sw.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerImmediately',
    }),
  ]
};
