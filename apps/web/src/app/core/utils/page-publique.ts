/**
 * Espace dépôt (2026-08), lot A4 — « la page publique ne pose rien sur l'appareil ».
 *
 * ┌─ POURQUOI CETTE FONCTION EXISTE ──────────────────────────────────────────┐
 * │ `/s/:token` s'ouvre chez quelqu'un qui n'a pas de compte, n'a rien demandé  │
 * │ et n'a consenti à rien : il a reçu un SMS. A4 § 6 est explicite —           │
 * │ « pas de compte, pas de cookie, pas d'analytics tiers. La page ne pose rien │
 * │ sur l'appareil du destinataire. »                                          │
 * │                                                                            │
 * │ Or l'application démarre son socle AVANT de savoir quelle route s'affiche : │
 * │ identifiant d'appareil sur chaque requête, compteur de visites PWA,         │
 * │ persistance du thème. Sur un écran authentifié c'est normal ; chez un tiers │
 * │ anonyme, l'identifiant d'appareil est exactement le pistage que la spec     │
 * │ refuse.                                                                    │
 * │                                                                            │
 * │ ⚠️ Testé sur `location.pathname`, PAS sur le routeur Angular : l'intercepteur │
 * │ HTTP et le démarrage de l'application s'exécutent AVANT que la première      │
 * │ navigation soit résolue. Une lecture du routeur y renverrait « aucune route ».│
 * └────────────────────────────────────────────────────────────────────────────┘
 */

/** Le préfixe des routes ouvertes. Une seule aujourd'hui : le suivi public d'A4. */
const PREFIXES_PUBLICS = ['/s/'] as const;

export function estPagePublique(chemin: string = typeof location !== 'undefined' ? location.pathname : ''): boolean {
  return PREFIXES_PUBLICS.some((p) => chemin.startsWith(p));
}
