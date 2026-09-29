/**
 * ── « AUCUN VÉHICULE » QUI DIT POURQUOI (29/09, « 12 places ») ────────────────────────────────
 *
 * Le 29/09 à 05:10, sur Client test (3 véhicules de 9 places, 4 de 5, 1 de 4), une demande de
 * 12 places a reçu trois fois « Aucun véhicule libre ne correspond aux critères sur ce créneau. »
 * pendant que le panneau du jour affichait « 7 / 8 véhicules disponibles ». Le refus était juste —
 * aucun véhicule n'a 12 places — mais le message parlait d'un créneau, pas d'une taille : on cherche
 * un conflit d'horaire qui n'existe pas.
 *
 * Un seul constructeur, partagé par la demande (`request`), la réaffectation et l'IA de placement :
 * trois surfaces qui disaient la même chose de trois façons. Chemins AUTHENTIFIÉS seulement — le
 * lien public ne reçoit jamais ces chiffres (état du parc).
 */
export interface AucunVehiculeContexte {
  /** Places demandées (conducteur compris), si un plancher a été saisi. */
  minSeats?: number | null;
  /** Véhicules écartés parce qu'ils ont moins de places que `minSeats`. */
  excludedTooSmall?: number;
  /** Plus grand nombre de places du périmètre en service (null = aucun renseigné). */
  largestSeats?: number | null;
  /** Véhicules écartés faute de nombre de places renseigné. */
  excludedUnknownCapacity?: number;
  /** Véhicules écartés : sièges auto insuffisants (à bord + stock). */
  excludedChildSeats?: number;
  /** Véhicules écartés : boîtier muet depuis plus de 7 jours. */
  excludedDormant?: number;
  /**
   * Véhicules libres sur le créneau QUELLE QUE SOIT leur taille (vivier relu sans `minSeats`), avec
   * leur fourchette de places. Absent = pas relu (on ne l'invente pas).
   */
  libresToutesTailles?: { n: number; min: number | null; max: number | null } | null;
  /** Début de phrase quand il s'agit d'un REMPLAÇANT (réaffectation) plutôt que d'un premier véhicule. */
  autre?: boolean;
}

const pluriel = (n: number, un: string, plusieurs: string) => (n > 1 ? plusieurs : un);

/** « , de 4 à 9 places » ou « (9 places) » ; vide sans places connues. Exporté pour la demande (C6). */
export function fourchettePlaces(min: number | null, max: number | null): string {
  if (min == null || max == null) return '';
  return min === max ? ` (${max} places)` : `, de ${min} à ${max} places`;
}

/**
 * « CT-008 a 4 places, moins que les 8 demandées (conducteur compris). » — un véhicule CHOISI dont le
 * nombre de places est CONNU (> 0) et inférieur au plancher saisi. Null s'il n'y a rien à refuser :
 * pas de plancher, places inconnues ou nulles (on ne refuse pas sur une donnée absente), ou assez de
 * places. UNE phrase pour deux temps (relecture du 29/09, C8) : `assertAssezDePlaces` la lève à
 * l'écriture, et « Réorganiser → Réaffecter vers un véhicule choisi » l'annonce dès la simulation.
 */
export function motifPlacesInsuffisantes(
  plate: string | null | undefined,
  places: number | null | undefined,
  minSeats: number | null | undefined,
): string | null {
  if (!minSeats || typeof places !== 'number' || places <= 0 || places >= minSeats) return null;
  return (
    `${plate ?? 'Ce véhicule'} a ${places} ${pluriel(places, 'place', 'places')}, moins que les ${minSeats} demandées (conducteur compris). ` +
    'Choisissez un véhicule plus grand, ou répartissez le groupe : une réservation par véhicule, sans « Places min. ».'
  );
}

export function messageAucunVehicule(c: AucunVehiculeContexte): string {
  const min = c.minSeats && c.minSeats > 0 ? c.minSeats : null;
  // Les SIÈGES AUTO passent avant la taille (relecture du 29/09). Le vivier juge les sièges APRÈS le
  // plancher de places et l'occupation : un véhicule écarté pour ses sièges était libre ET assez
  // grand. Les petits véhicules du parc ne sont alors pas la cause — sauf si le parc n'a VRAIMENT
  // aucun véhicule assez grand. La règle vit ici pour les trois surfaces (les appelants qui
  // l'appliquaient déjà restent justes : elle est idempotente).
  const parcTropPetit = !!min && c.largestSeats != null && c.largestSeats < min;
  const tropPetits = (c.excludedChildSeats ?? 0) > 0 && !parcTropPetit ? 0 : (c.excludedTooSmall ?? 0);
  const inconnus = c.excludedUnknownCapacity ?? 0;
  const libres = c.libresToutesTailles ?? null;
  const notes: string[] = [];
  if (inconnus > 0) {
    notes.push(
      `${inconnus} ${pluriel(inconnus, 'véhicule sans nombre de places renseigné n\'a pas été compté', 'véhicules sans nombre de places renseigné n\'ont pas été comptés')} : complétez-le dans la vue Parc`,
    );
  }
  if ((c.excludedDormant ?? 0) > 0) {
    notes.push(`${c.excludedDormant} écarté(s) : boîtier muet depuis plus de 7 jours`);
  }
  const suffixe = notes.length > 0 ? ` (${notes.join(' ; ')}.)` : '';

  // Les sièges auto d'abord : quand ce sont eux qui ont vidé le vivier, c'est la seule chose à dire.
  if ((c.excludedChildSeats ?? 0) > 0 && tropPetits === 0) {
    return (
      `Aucun ${c.autre ? 'autre ' : ''}véhicule libre ne peut recevoir les sièges auto demandés sur ce créneau ` +
      `(${c.excludedChildSeats} véhicule(s) écarté(s) : pas assez de sièges à bord, et le stock ne complète pas ou ne suffit plus). ` +
      `Choisissez un véhicule équipé, installez un siège, ou changez le réglage dans la vue Parc.` +
      suffixe
    );
  }

  if (min && tropPetits > 0) {
    const phraseLibres = libres
      ? libres.n > 0
        ? ` Sur ce créneau, ${libres.n} ${pluriel(libres.n, 'véhicule est libre', 'véhicules sont libres')}${fourchettePlaces(libres.min, libres.max)} : répartissez le groupe sur plusieurs véhicules (une réservation par véhicule).`
        : ` Aucun véhicule n'est libre sur ce créneau, quelle que soit sa taille.`
      : '';
    // Le parc n'a PAS de véhicule assez grand : c'est une question de taille, pas de créneau.
    if (c.largestSeats == null || c.largestSeats < min) {
      const plusGrand = c.largestSeats != null ? ` : le plus grand en a ${c.largestSeats}` : '';
      return `Aucun véhicule de ${min} places ou plus (conducteur compris)${plusGrand}.${phraseLibres}${suffixe}`;
    }
    // Des véhicules assez grands existent, mais aucun n'est libre (ou conforme) sur ce créneau.
    return `Aucun ${c.autre ? 'autre ' : ''}véhicule d'au moins ${min} places n'est libre sur ce créneau.${phraseLibres}${suffixe}`;
  }

  const places = min ? ` (au moins ${min} places)` : '';
  return `Aucun ${c.autre ? 'autre ' : ''}véhicule libre ne correspond aux critères sur ce créneau${places}.${suffixe}`;
}
