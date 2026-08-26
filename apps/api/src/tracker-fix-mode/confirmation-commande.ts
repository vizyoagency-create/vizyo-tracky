/**
 * ══ TRK-051 — CE QUI A CONFIRMÉ UNE COMMANDE, ET PAR QUEL MOYEN ═══════════════════════
 *
 * `TrackerCommandStatus.ACKNOWLEDGED` porte DEUX faits très différents, et son nom n'en
 * annonce qu'un :
 *
 *   1. le boîtier a réellement répondu             → `ackResponse` est renseigné ;
 *   2. la cadence MESURÉE a rejoint la cadence demandée, **sans aucune confirmation du
 *      matériel** → clôture par échéance (TRK-013, PR #111 du 23/08).
 *
 * Mesuré le 2026-08-26 : sur **120** commandes `ACKNOWLEDGED` en 7 jours, **2** portaient une
 * vraie réponse de boîtier — deux commandes `raw`, un seul IMEI. Les 118 autres étaient des
 * `fix_continuous` dont le propre `observedResult` dit « sans accusé de réception du boîtier ».
 *
 * 🔑 **Pourquoi une fonction plutôt qu'un test en ligne.** Le défaut de TRK-051 n'est pas qu'un
 * écran affiche mal : c'est que la règle « qu'est-ce qui a confirmé ? » n'existait NULLE PART,
 * donc chaque lecteur la réinventait — et l'audit du centre d'alerte, deux passages d'affilée,
 * a failli en conclure que les boîtiers répondaient enfin et refermer TRK-014. Une règle écrite
 * une fois, exportée et testée, est la seule forme qui ne se re-perd pas.
 *
 * ⚠️ **NE PAS confondre avec `EngineControlCommand`.** Là-bas, `ACKNOWLEDGED` signifie une
 * confirmation RÉELLE (chute d'ignition observée, `DEVICE_OBSERVED`) : la sémantique y est
 * saine et ce module ne la concerne pas.
 *
 * ⚠️ **On ne corrige pas la donnée, on corrige sa LECTURE.** `ackedAt` / `ackResponse` restent
 * réservés à une vraie réponse du boîtier — c'est [TRK-014] qui mesure leur absence, et un faux
 * accusé truquerait cette mesure. Aucune migration, aucune réécriture : uniquement une dérivation.
 */

/** Ce qui a confirmé une commande — jamais deviné, toujours dérivé de la preuve présente. */
export type ConfirmationCommande =
  /** Le boîtier a répondu : preuve matérielle (`ackResponse` non vide). */
  | 'BOITIER'
  /** Effet constaté par la mesure, sans réponse du boîtier (clôture par échéance). */
  | 'MESURE'
  /** Ni l'un ni l'autre : la commande n'est pas confirmée (PENDING, SENT, FAILED…). */
  | null;

/** Libellés destinés à l'affichage — le mot « acquittée » est RÉSERVÉ au cas matériel. */
export const LIBELLE_CONFIRMATION: Record<'BOITIER' | 'MESURE', string> = {
  BOITIER: 'Acquittée par le boîtier',
  MESURE: 'Cible atteinte (mesurée, sans accusé)',
};

/**
 * Qu'est-ce qui a confirmé cette commande ?
 *
 * ⚠️ Le test porte sur `ackResponse` et NON sur `ackedAt` : `ackedAt` est un horodatage, et un
 * horodatage peut être posé par un futur chemin sans qu'aucun contenu ne soit revenu du boîtier.
 * `ackResponse` porte la trame réellement reçue — c'est la seule preuve de contenu.
 * Une chaîne vide ou blanche ne prouve rien : elle est traitée comme une absence.
 */
export function confirmationDeCommande(commande: {
  status: string;
  ackResponse?: string | null;
}): ConfirmationCommande {
  const reponse = commande.ackResponse?.trim();
  if (reponse) return 'BOITIER';
  if (commande.status === 'ACKNOWLEDGED') return 'MESURE';
  return null;
}

/**
 * Ventilation d'un lot de commandes — c'est CETTE fonction que doit appeler tout écran ou tout
 * rapport qui agrège, à la place d'un `count(status = 'ACKNOWLEDGED')`.
 *
 * `acquitteesBoitier` répond à la question « combien de boîtiers ont répondu ? ». C'est la seule
 * qui autorise à parler d'acquittement.
 */
export function ventilerConfirmations(
  commandes: { status: string; ackResponse?: string | null }[],
): {
  total: number;
  acquitteesBoitier: number;
  cibleAtteinteMesuree: number;
  nonConfirmees: number;
} {
  let acquitteesBoitier = 0;
  let cibleAtteinteMesuree = 0;
  let nonConfirmees = 0;
  for (const c of commandes) {
    const q = confirmationDeCommande(c);
    if (q === 'BOITIER') acquitteesBoitier += 1;
    else if (q === 'MESURE') cibleAtteinteMesuree += 1;
    else nonConfirmees += 1;
  }
  return { total: commandes.length, acquitteesBoitier, cibleAtteinteMesuree, nonConfirmees };
}
