/**
 * Le hors service DÉCLARÉ sur la fiche d'un véhicule, vu par les cartes.
 *
 * Demande du propriétaire du 05/10/2026 : un véhicule marqué « Boîtier débranché » sur sa
 * fiche doit se voir BARRÉ — sur la page Carte (marqueur, liste flotte, card, légende) et sur
 * la mini-carte de sa fiche. Les autres motifs (accident, immobilisé) gardent pour l'instant
 * le marqueur ordinaire.
 */

/** Le motif posé par le sélecteur « État d'exploitation » de la fiche. */
export const MOTIF_DEBRANCHE = 'TRACKER_UNPLUGGED';

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
