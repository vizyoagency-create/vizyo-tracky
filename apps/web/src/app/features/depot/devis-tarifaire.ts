/**
 * Espace dépôt, lot A6 — l'aperçu de devis pendant la saisie. Cf. § 7bis.
 *
 * ┌─ CE FICHIER EST UN MIROIR, PAS UNE SOURCE ────────────────────────────────┐
 * │ La vérité du prix est `MissionPricingService.tarifPour`, côté serveur :    │
 * │ c'est lui qui fige le tour 0 et qui engage. Ce calcul-ci n'existe que pour │
 * │ répondre EN DIRECT, à chaque frappe, sans un aller-retour par kilomètre    │
 * │ saisi.                                                                     │
 * │                                                                            │
 * │ Il DOIT donc rester identique au serveur, règle pour règle. Les deux       │
 * │ écarts qui coûteraient cher, et qui sont reproduits ici à l'identique :    │
 * │                                                                            │
 * │  1. La tranche retenue est la PREMIÈRE dont `toKm` couvre la distance —    │
 * │     jamais un encadrement [fromKm, toKm]. La grille du client saute de     │
 * │     « 0 à 50 » à « 51 à 100 » : un encadrement littéral laisserait 50,4 km │
 * │     sans tranche. `fromKm` sert l'affichage, `toKm` la décision.           │
 * │  2. Les kilomètres sont arrondis au SUPÉRIEUR. 50 001 m sont 51 km à       │
 * │     facturer ; arrondir au plus proche ferait basculer 50 400 m dans la    │
 * │     tranche basse, un cadeau que personne n'a décidé.                      │
 * │                                                                            │
 * │ Les suppléments (`extraStopCents`, `waitingHourCents`) sont volontairement │
 * │ ABSENTS du calcul : le serveur ne les applique pas non plus. Les ajouter   │
 * │ ici afficherait un montant que le devis reçu ne confirmerait pas — un      │
 * │ écran qui promet un prix que le serveur dément est pire qu'un écran sans   │
 * │ prix.                                                                      │
 * └────────────────────────────────────────────────────────────────────────────┘
 */

export interface TrancheTarifaire {
  position: number;
  fromKm: number;
  /** Borne haute INCLUSE. `null` = dernière tranche, sans limite. */
  toKm: number | null;
  /** Forfait HT en centimes. `null` = « sur devis ». */
  priceCents: number | null;
}

export interface GrilleTarifaire {
  fleetId: string;
  enabled: boolean;
  vatPct: number;
  quoteValidityHours: number;
  extraStopCents: number;
  waitingHourCents: number;
  quoteFooterNote: string | null;
  category: string;
  tiers: TrancheTarifaire[];
  updatedAt: string;
}

/**
 * L'avertissement de borne — la raison d'être de tout cet écran.
 *
 * « 3 km de plus font passer à 169 € au lieu de 79 » : c'est CE message qui évite
 * l'appel « pourquoi ai-je payé le double pour deux kilomètres ». Une grille par
 * tranches forfaitaires est brutale à ses bornes, et le dépôt ne la connaît pas.
 */
export interface AvertissementBorne {
  /** Combien de kilomètres de plus feraient basculer. Toujours ≥ 1. */
  kmAvant: number;
  /** Le forfait actuel, en centimes. */
  actuelCents: number;
  /** Ce qu'on paierait après la bascule. `null` = la tranche suivante est « sur devis ». */
  suivantCents: number | null;
}

export type Devis =
  | {
      statut: 'TARIF';
      distanceKm: number;
      trancheLibelle: string;
      htCents: number;
      tvaCents: number;
      ttcCents: number;
      /** Présent seulement quand la bascule est proche. */
      borne: AvertissementBorne | null;
    }
  | { statut: 'SUR_DEVIS'; distanceKm: number; motif: string }
  | { statut: 'PAS_DE_GRILLE'; motif: string };

/**
 * À partir de combien de kilomètres restants on prévient.
 *
 * Cinq, pas un : à un kilomètre près l'avertissement arrive trop tard pour changer
 * quoi que ce soit à une tournée. Trop large, il s'affiche en permanence et devient
 * un décor qu'on ne lit plus.
 */
const MARGE_AVERTISSEMENT_KM = 5;

/** Le libellé d'une tranche, tel que le serveur le compose. */
export function libelleTranche(t: { fromKm: number; toKm: number | null }): string {
  return t.toKm === null ? `au-delà de ${t.fromKm} km` : `${t.fromKm} à ${t.toKm} km`;
}

/**
 * Le devis pour une distance, depuis la grille lue au serveur.
 *
 * `distanceKm` est la SOMME des segments saisis par le dépôt — le retour n'en fait
 * partie que s'il a ajouté l'adresse de chargement en dernière livraison (arbitrage H).
 */
export function calculerDevis(distanceKm: number, grille: GrilleTarifaire | null): Devis {
  if (!grille || !grille.enabled || grille.tiers.length === 0) {
    return {
      statut: 'PAS_DE_GRILLE',
      motif: 'Votre transporteur n\'a pas encore publié ses tarifs.',
    };
  }
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
    return { statut: 'PAS_DE_GRILLE', motif: 'Renseignez les distances pour voir le devis.' };
  }

  // Le serveur reçoit des mètres entiers puis arrondit au kilomètre supérieur. On
  // refait EXACTEMENT le même chemin, sans quoi 43,4 km s'afficherait à 43 ici et
  // se facturerait à 44 là-bas.
  const km = Math.ceil(Math.round(distanceKm * 1000) / 1000);

  const tranches = [...grille.tiers].sort((a, b) => a.position - b.position);
  const index = tranches.findIndex((t) => t.toKm === null || km <= t.toKm);
  const tranche = index === -1 ? undefined : tranches[index];

  if (!tranche) {
    return {
      statut: 'SUR_DEVIS',
      distanceKm: km,
      motif: `Aucune tranche ne couvre ${km} km. Votre transporteur établira un prix.`,
    };
  }
  if (tranche.priceCents === null) {
    return {
      statut: 'SUR_DEVIS',
      distanceKm: km,
      motif: `Au-delà de ${tranche.fromKm} km, le tarif est établi sur devis.`,
    };
  }

  const htCents = tranche.priceCents;
  // Arrondi UNIQUE, à la fin, comme le serveur.
  const tvaCents = Math.round((htCents * grille.vatPct) / 100);

  return {
    statut: 'TARIF',
    distanceKm: km,
    trancheLibelle: libelleTranche(tranche),
    htCents,
    tvaCents,
    ttcCents: htCents + tvaCents,
    borne: avertissementDeBorne(km, tranche, tranches[index + 1]),
  };
}

/**
 * La bascule est-elle assez proche pour qu'on en parle ?
 *
 * `kmAvant` compte le premier kilomètre QUI BASCULE, pas la marge restante : à 48 km
 * sur une tranche qui s'arrête à 50, ce sont bien 3 km de plus qui font passer à la
 * suivante (49, 50, 51 — et 51 est dans la tranche d'après). C'est l'exemple du § 7bis,
 * et il doit tomber juste : un avertissement faux d'un kilomètre décrédibilise les
 * autres.
 */
function avertissementDeBorne(
  km: number,
  tranche: TrancheTarifaire,
  suivante: TrancheTarifaire | undefined,
): AvertissementBorne | null {
  // Dernière tranche, ou tranche sans borne haute : rien ne bascule après.
  if (tranche.toKm === null || !suivante || tranche.priceCents === null) return null;
  // Une tranche suivante MOINS CHÈRE ne mérite pas un avertissement : la phrase
  // « ça vous coûterait moins cher d'aller plus loin » est vraie mais inutilisable.
  if (suivante.priceCents !== null && suivante.priceCents <= tranche.priceCents) return null;

  const kmAvant = tranche.toKm - km + 1;
  if (kmAvant < 1 || kmAvant > MARGE_AVERTISSEMENT_KM) return null;

  return { kmAvant, actuelCents: tranche.priceCents, suivantCents: suivante.priceCents };
}

/** Centimes → « 79,00 € », en français. */
export function euros(cents: number): string {
  return `${(cents / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}
