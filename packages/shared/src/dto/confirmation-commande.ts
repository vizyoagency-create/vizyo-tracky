/**
 * ══ TRK-051 / TRK-055 — CE QUI A CONFIRMÉ UNE COMMANDE, ET PAR QUEL MOYEN ═════════════
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
 * ── POURQUOI CE FICHIER VIT DANS `shared` DEPUIS LE 2026-09-01 (TRK-055) ──────────────
 *
 * Il a d'abord été écrit côté API seule. Le 01/09, la vérification à l'écran a montré que le
 * correctif n'avait couvert que **trois surfaces sur cinq** : l'écran du mode fix affichait bien
 * un badge ambre, mais la fiche du tracker — et celle du véhicule, et l'écran d'administration
 * des commandes — peignaient toujours `ACKNOWLEDGED` en **VERT** sous le libellé « Confirmée ».
 * Mesure du jour : **394 commandes peintes en vert sur 7 jours, dont 0 avec réponse de boîtier.**
 *
 * 🔑 **La cause n'était pas l'oubli, c'était le PLACEMENT.** Une règle rangée dans `apps/api`
 * est inatteignable depuis le web : le seul moyen de l'y appliquer était de la réécrire, donc de
 * créer une deuxième définition — exactement ce que TRK-051 existait pour empêcher. En la
 * remontant ici, les deux consommateurs partagent la MÊME fonction, et un troisième écran ne
 * pourra plus diverger sans le faire exprès.
 *
 * ⚠️ **NE PAS confondre avec `EngineControlCommand`.** Là-bas, `ACKNOWLEDGED` signifie une
 * confirmation RÉELLE (chute d'ignition observée) : la sémantique y est saine et ce module ne la
 * concerne pas.
 *
 * ⚠️ **On ne corrige pas la donnée, on corrige sa LECTURE.** `ackedAt` / `ackResponse` restent
 * réservés à une vraie réponse du boîtier — c'est TRK-014 qui mesure leur absence, et un faux
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
 * TRK-055 — LE LIBELLÉ D'UN STATUT DE COMMANDE, POUR TOUT ÉCRAN QUI EN AFFICHE UN.
 *
 * Prend la commande entière, jamais le seul statut : c'est précisément parce que les écrans
 * n'avaient que `status` sous la main qu'ils ont tous écrit « Confirmée ».
 *
 * ⚠️ Le mot « **Confirmée** » ne réapparaît nulle part. Il était l'exact équivalent visuel du
 * vert : il affirme une confirmation sans dire par quoi.
 */
export function libelleStatutCommande(commande: {
  status: string;
  ackResponse?: string | null;
}): string {
  const confirmation = confirmationDeCommande(commande);
  if (confirmation === 'BOITIER') return 'Acquittée (boîtier)';
  if (confirmation === 'MESURE') return 'Cible atteinte (mesurée)';
  return (
    {
      PENDING: 'En attente',
      SCHEDULED: 'Planifiée',
      SENT: 'Envoyée',
      FAILED: 'Échouée',
      CANCELLED: 'Annulée',
    }[commande.status] ?? commande.status
  );
}

/**
 * TRK-055 — LE TON D'AFFICHAGE, dérivé de la même règle que le libellé.
 *
 * 🔑 **`succes` est RÉSERVÉ à une réponse matérielle.** C'est tout l'objet de la fiche : peindre
 * en vert une commande que rien n'a confirmée est ce qui faisait lire « 120 acquittements » là où
 * il y en avait 2. Le cas mesuré prend le ton `mesure` — à rendre en AMBRE, comme sur l'écran du
 * mode fix, corrigé le 26/08.
 *
 * Rend un ton abstrait et non une classe CSS : la palette appartient à chaque application.
 */
export type TonStatutCommande = 'succes' | 'mesure' | 'echec' | 'attente' | 'planifie' | 'neutre';

export function tonStatutCommande(commande: {
  status: string;
  ackResponse?: string | null;
}): TonStatutCommande {
  const confirmation = confirmationDeCommande(commande);
  if (confirmation === 'BOITIER') return 'succes';
  if (confirmation === 'MESURE') return 'mesure';
  if (commande.status === 'FAILED') return 'echec';
  if (commande.status === 'SENT' || commande.status === 'PENDING') return 'attente';
  if (commande.status === 'SCHEDULED') return 'planifie';
  return 'neutre';
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
