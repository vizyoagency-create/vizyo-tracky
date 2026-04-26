import { ApplicationConfig, isDevMode, provideBrowserGlobalErrorListeners, provideZoneChangeDetection } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter, withPreloading, PreloadAllModules, withViewTransitions } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';

import { routes } from './app.routes';
import { authInterceptor } from './core/interceptors/auth.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(
      routes,
      // Precharge tous les bundles lazy en idle apres le boot initial -> 1er clic instantane
      withPreloading(PreloadAllModules),
      // Cross-fade natif entre routes (Chromium full, Safari 18+)
      withViewTransitions(),
    ),
    provideHttpClient(withInterceptors([authInterceptor])),
    // Service worker : actif en prod uniquement, attente 30s d'idle pour ne pas concurrencer le boot
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ]
};
