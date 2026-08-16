/**
 * Détection de plateforme — socle des déclinaisons iOS / Android.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ LES ÉCARTS iOS/ANDROID SONT VOLONTAIRES, PAS DES OUBLIS.                   │
 * │   poignée 36 × 5  vs  32 × 4                                               │
 * │   rayon    22 px  vs  28 px                                                │
 * │   densité  44 px  vs  56 px                                                │
 * │ « Les aplatir donne une application étrangère sur les deux plateformes. »  │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Cf. design/B1-PAGES.md § « Le système de référence ».
 *
 * La détection pose une classe sur `<body>` ; les valeurs vivent en variables CSS
 * (`styles.css`). Aucun composant ne teste la plateforme dans son template : il
 * consomme `var(--feuille-rayon)` et suit. C'est ce qui évite que chaque écran
 * réinvente sa propre condition — et se trompe.
 */

export type Plateforme = 'ios' | 'android' | 'bureau';

/**
 * iPadOS 13+ se déclare « MacIntel » avec un écran tactile : sans le second test,
 * une tablette Apple recevrait la géométrie de bureau.
 */
export function detecterPlateforme(nav: Navigator = navigator): Plateforme {
  const ua = nav.userAgent || '';
  if (/iPhone|iPod/.test(ua)) return 'ios';
  if (/iPad/.test(ua)) return 'ios';
  if (ua.includes('MacIntel') && (nav.maxTouchPoints ?? 0) > 1) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'bureau';
}

/** Pose `plat-ios` / `plat-android` / `plat-bureau` sur `<body>`, une fois au démarrage. */
export function appliquerPlateforme(doc: Document = document, nav: Navigator = navigator): Plateforme {
  const p = detecterPlateforme(nav);
  doc.body.classList.remove('plat-ios', 'plat-android', 'plat-bureau');
  doc.body.classList.add(`plat-${p}`);
  return p;
}
