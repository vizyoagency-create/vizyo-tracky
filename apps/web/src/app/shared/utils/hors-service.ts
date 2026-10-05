/**
 * Le hors service DÉCLARÉ sur la fiche d'un véhicule, vu par les cartes.
 *
 * Demande du propriétaire du 05/10/2026 : un véhicule marqué « Boîtier débranché » sur sa
 * fiche doit se voir BARRÉ — sur la page Carte (marqueur, liste flotte, card, légende) et sur
 * la mini-carte de sa fiche. Le 06/10 : « pareil pour immobilisé, avec la clé ». Seul
 * « accidenté » garde le marqueur ordinaire.
 */

/** Les motifs posés par le sélecteur « État d'exploitation » de la fiche. */
export const MOTIF_DEBRANCHE = 'TRACKER_UNPLUGGED';
export const MOTIF_IMMOBILISE = 'IMMOBILIZED';

interface PorteMotif {
  outOfServiceReason?: string | null;
}

/**
 * Le motif à retenir pour un véhicule.
 *
 * L'instantané temps réel FAIT FOI dès qu'il porte le champ, `null` compris (= remis en
 * service) ; la liste des véhicules n'est qu'un repli, pour une API d'avant le 05/10 qui ne
 * l'envoie pas (`undefined`).
 *
 * ⚠️ Surtout pas `snap?.outOfServiceReason ?? meta?.outOfServiceReason` : `??` lirait le `null`
 * d'un véhicule REMIS en service comme « inconnu », et ressusciterait le « débranché » périmé
 * de la liste chargée à l'ouverture de la carte.
 */
export function motifHorsService(
  snap: PorteMotif | undefined,
  meta: PorteMotif | undefined,
): string | null {
  if (snap && snap.outOfServiceReason !== undefined) return snap.outOfServiceReason;
  return meta?.outOfServiceReason ?? null;
}

export function estDebranche(motif: string | null | undefined): boolean {
  return motif === MOTIF_DEBRANCHE;
}

/** Immobilisé (au garage, à l'atelier) — 06/10/2026 : marqueur grisé à badge « clé ». */
export function estImmobilise(motif: string | null | undefined): boolean {
  return motif === MOTIF_IMMOBILISE;
}

interface LigneInstantane extends PorteMotif {
  trackerId?: string | null;
  lastLat?: number | null;
  lastLng?: number | null;
}

/**
 * Combien de marqueurs BARRÉS la carte peut montrer : les débranchés qui ont une position.
 *
 * Relevé en production le 05/10 au soir : FT-463-TW (société Ahmed) est déclaré débranché mais
 * n'a jamais eu de boîtier — aucun marqueur. Compter tous les débranchés faisait annoncer
 * « Boîtier débranché (4) » à côté de trois pastilles barrées : une légende décrit ce que la
 * carte montre.
 */
export function nbDebranchesSurLaCarte(vehicules: readonly LigneInstantane[]): number {
  return nbSurLaCarte(vehicules, MOTIF_DEBRANCHE);
}

/** Même règle pour la clé « Immobilisé (n) » de la légende. */
export function nbImmobilisesSurLaCarte(vehicules: readonly LigneInstantane[]): number {
  return nbSurLaCarte(vehicules, MOTIF_IMMOBILISE);
}

function nbSurLaCarte(vehicules: readonly LigneInstantane[], motif: string): number {
  return vehicules.filter(
    (v) => v.outOfServiceReason === motif && !!v.trackerId && v.lastLat != null && v.lastLng != null,
  ).length;
}
