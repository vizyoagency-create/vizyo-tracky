/**
 * Helper de feedback haptique pour les actions critiques.
 *
 * - Android Chrome / Edge / Samsung Internet : `navigator.vibrate` est implemente.
 * - iOS Safari : `navigator.vibrate` est ignore (Apple ne l'expose pas) -> no-op silencieux.
 *
 * Pour iOS, le retour haptique n'est accessible qu'aux apps natives ou via Capacitor.
 * On garde ces appels meme sur iOS : ils ne coutent rien et fonctionneront sur Android.
 *
 * Usage :
 *   haptics.medium();          // acquittement, validation
 *   haptics.success();         // action reussie (commande envoyee, alerte ack)
 *   haptics.warning();         // action sensible (coupure moteur)
 *   haptics.error();           // erreur, toast d'erreur
 *   haptics.light();           // tap leger (selection marker)
 */
function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // SecurityError sur certains contextes (iframe sans gesture user) -> ignore
  }
}

export const haptics = {
  light:   () => vibrate(10),
  medium:  () => vibrate(20),
  success: () => vibrate([10, 30, 10]),
  warning: () => vibrate([20, 40, 20]),
  error:   () => vibrate([40, 60, 40]),
} as const;
