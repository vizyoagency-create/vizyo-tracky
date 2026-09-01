/**
 * ══ TRK-056 — MESURER UNE CADENCE, PLUTÔT QUE TIRER UN ÉCHANTILLON ═══════════════════
 *
 * `currentFixIntervalS` valait l'écart entre les DEUX DERNIÈRES trames. Un seul échantillon,
 * ni médiane ni fenêtre. Sur un boîtier qui émet par salves, ce nombre est un tirage.
 *
 * ── Ce que la production a montré, le 2026-09-01 ─────────────────────────────────────
 *
 * FM-772-JH, cible 99 s, **garé**, `currentFixIntervalS` affiché à **2 s**. Ses treize derniers
 * écarts entre trames `position` :
 *
 *     1,53 · 3,00 · 9,39 · 98,91 · 20,15 · 1,92 · 37,43 · 35,20 · 4,30 · 4,06 · 1,62
 *
 * Ce n'est pas « 2 s ». C'est une alternance de longues attentes et de salves rapprochées — et
 * elle porte bien sur des positions, pas sur des heartbeats (64 positions contre 10 heartbeats
 * sur trente minutes). Sur deux heures : **114 écarts sous 10 s, 122 au-dessus**, médiane des
 * longs à **47 s**. Sur tout le parc en une heure : **24,5 %** des écarts sont sous 10 s, sur
 * 32 boîtiers — *une chance sur quatre que l'échantillon tombe dans une salve.*
 *
 * ── Pourquoi la MÉDIANE, et pas la moyenne ───────────────────────────────────────────
 *
 * La moyenne d'une distribution bimodale tombe entre les deux modes, là où le boîtier n'émet
 * précisément jamais : 1,5 s et 99 s donnent 50 s, une valeur que rien n'a produite. La médiane
 * choisit un écart RÉELLEMENT observé, et une salve ne la déplace qu'en proportion du nombre
 * de trames qu'elle contient.
 *
 * ⚠️ **Ce module ne prétend pas dire si le boîtier obéit.** Il rend une mesure honnête. Sur
 * FM-772-JH, cette mesure vaut 47 s pour une cible de 99 s : le boîtier n'est donc pas
 * disculpé — il devient simplement possible de l'accuser sur autre chose qu'un tirage.
 */

/**
 * Taille de la fenêtre.
 *
 * Douze : c'est le lot que les canaris de [TRK-045] relevaient à la main pour trancher un
 * comportement, et il couvre plusieurs cycles salve + attente. Plus court, une seule salve
 * dominerait la médiane ; plus long, la mesure mettrait trop de temps à refléter un changement
 * de cadence réellement appliqué.
 */
export const TAILLE_FENETRE_CADENCE = 12;

/**
 * Ajoute un écart à la fenêtre glissante et rend la nouvelle fenêtre.
 *
 * Les écarts sont conservés dans l'ordre d'arrivée, le plus ancien étant évincé. Aucune
 * mutation du tableau reçu : la fonction est pure, ce qui la rend testable sans base.
 */
export function pousserEcart(
  fenetre: readonly number[] | null | undefined,
  ecartS: number,
  taille = TAILLE_FENETRE_CADENCE,
): number[] {
  if (!Number.isFinite(ecartS) || ecartS <= 0) return [...(fenetre ?? [])];
  const suivante = [...(fenetre ?? []), Math.round(ecartS)];
  return suivante.length > taille ? suivante.slice(suivante.length - taille) : suivante;
}

/**
 * Médiane des écarts de la fenêtre, arrondie à la seconde. `null` si la fenêtre est vide.
 *
 * ⚠️ Pour un nombre PAIR d'échantillons, on retient l'élément **inférieur** du couple central
 * plutôt que leur moyenne. La moyenne fabriquerait une valeur que le boîtier n'a jamais
 * produite — exactement le défaut qu'on corrige ; la médiane doit rester un écart observé.
 */
export function medianeCadence(fenetre: readonly number[] | null | undefined): number | null {
  if (!fenetre || fenetre.length === 0) return null;
  const tries = [...fenetre].sort((a, b) => a - b);
  return tries[Math.floor((tries.length - 1) / 2)] ?? null;
}

/**
 * La fenêtre porte-t-elle assez d'échantillons pour qu'une DÉCISION s'y appuie ?
 *
 * Le seuil est plus exigeant que pour l'affichage : montrer une mesure partielle est honnête,
 * agir dessus ne l'est pas. Sous ce seuil, l'auto-alignement continue de se rabattre sur
 * l'échantillon courant — le comportement d'avant, donc aucune régression possible.
 */
export const MIN_ECHANTILLONS_DECISION = 6;

export function fenetreExploitable(fenetre: readonly number[] | null | undefined): boolean {
  return (fenetre?.length ?? 0) >= MIN_ECHANTILLONS_DECISION;
}

/**
 * Part des écarts « de salve » (sous le seuil) — la DISPERSION, à rendre lisible à côté de la
 * médiane.
 *
 * Un boîtier bimodal doit se voir comme bimodal. Une médiane seule redit le défaut d'origine
 * sous une forme plus propre : un nombre unique pour une émission qui n'en a pas.
 */
export const SEUIL_SALVE_S = 10;

export function partEcartsCourts(fenetre: readonly number[] | null | undefined): number | null {
  if (!fenetre || fenetre.length === 0) return null;
  const courts = fenetre.filter((e) => e < SEUIL_SALVE_S).length;
  return Math.round((courts / fenetre.length) * 100);
}
