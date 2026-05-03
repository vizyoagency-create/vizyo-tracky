import { bootstrapApplication } from '@angular/platform-browser';
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
