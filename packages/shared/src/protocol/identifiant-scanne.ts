/**
 * Ce que contient un code-barré scanné sur un boîtier — et ce qu'on peut en déduire.
 *
 * ── POURQUOI ON NE DEVINE PAS, ON PROPOSE DES CANDIDATS ──────────────────────────────
 *
 * Les étiquettes des boîtiers Baanool portent tantôt l'IMEI, tantôt l'ICCID de la puce,
 * parfois un numéro de série maison. Et les trois se ressemblent : ce sont des suites de
 * chiffres. Pire, sur ce parc l'IMEI et le MSISDN font tous deux QUINZE chiffres.
 *
 * Une heuristique qui trancherait seule se tromperait un jour, et un mauvais verdict ici
 * rattache un boîtier au mauvais véhicule — les positions d'une camionnette atterrissent
 * sur une autre. On rend donc une LISTE ORDONNÉE de candidats, et c'est l'inventaire qui
 * tranche : on interroge la base sur chaque candidat, et l'identifiant retenu est celui
 * qui existe vraiment. La forme ne sert qu'à choisir l'ordre des questions.
 *
 * ── CE QUE LUHN APPORTE, ET CE QU'IL N'APPORTE PAS ───────────────────────────────────
 *
 * Un IMEI porte une clé de Luhn ; les trois IMEI réels de ce parc la valident, et le
 * MSISDN espagnol ne la valide pas. Luhn est donc un bon signal pour dire « ceci EST un
 * IMEI plausible ».
 *
 * ⚠️ Il ne dit PAS l'inverse. Un numéro de téléphone peut valider Luhn par hasard — une
 * chance sur dix. Luhn hausse donc un candidat dans l'ordre, il n'en élimine aucun.
 */

export type TypeIdentifiant = 'imei' | 'iccid' | 'msisdn';

export interface CandidatIdentifiant {
  type: TypeIdentifiant;
  /** Chiffres seuls, sans espace ni signe — la forme stockée en base. */
  valeur: string;
  /** `sure` : forme ET clé de contrôle concordent. `possible` : forme seule. */
  confiance: 'sure' | 'possible';
}

/** Clé de Luhn — utilisée par les IMEI et les ICCID à 20 chiffres. */
export function luhnValide(chiffres: string): boolean {
  if (!/^\d{2,}$/.test(chiffres)) return false;
  let total = 0;
  let double = false;
  for (let i = chiffres.length - 1; i >= 0; i -= 1) {
    let n = chiffres.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    total += n;
    double = !double;
  }
  return total % 10 === 0;
}

/**
 * Extrait la suite de chiffres utile d'un code scanné.
 *
 * Les lecteurs rendent des choses très variées selon l'étiquette : « IMEI:8640… »,
 * « 8640 3505 4756 409 », « imei=8640…&sn=… », parfois une URL entière. On retient la
 * PLUS LONGUE suite de chiffres : sur toutes les étiquettes observées, l'identifiant est
 * le nombre le plus long de la chaîne, et les autres nombres (année, lot, version) sont
 * courts.
 */
export function normaliserScan(brut: string): string {
  if (!brut) return '';
  const suites = brut.match(/\d[\d\s.-]*\d|\d/g) ?? [];
  let meilleure = '';
  for (const s of suites) {
    const chiffres = s.replace(/[\s.-]/g, '');
    if (chiffres.length > meilleure.length) meilleure = chiffres;
  }
  return meilleure;
}

/**
 * Les identifiants possibles derrière un code scanné, du plus probable au moins probable.
 *
 * Renvoie une liste vide si rien d'exploitable — l'appelant doit alors proposer la saisie
 * manuelle plutôt que d'inventer.
 */
export function candidatsDepuisScan(brut: string): CandidatIdentifiant[] {
  const n = normaliserScan(brut);
  if (!n) return [];
  const candidats: CandidatIdentifiant[] = [];
  const luhn = luhnValide(n);

  // ICCID : 19 ou 20 chiffres, préfixe 89 (norme E.118 des cartes SIM télécom).
  if ((n.length === 19 || n.length === 20) && n.startsWith('89')) {
    candidats.push({ type: 'iccid', valeur: n, confiance: luhn ? 'sure' : 'possible' });
  }

  // IMEI : exactement 15 chiffres. Luhn valide => on le place en tête.
  if (n.length === 15) {
    candidats.push({ type: 'imei', valeur: n, confiance: luhn ? 'sure' : 'possible' });
  }

  /**
   * MSISDN : 8 à 15 chiffres. Toujours proposé quand la longueur s'y prête, MÊME si un
   * IMEI a déjà été proposé sur la même chaîne — c'est le cas des 15 chiffres, où seule
   * la base peut trancher. Un IMEI validé par Luhn passe devant ; sinon le numéro passe
   * en premier, parce qu'un IMEI qui échoue à sa propre clé de contrôle est douteux.
   */
  if (n.length >= 8 && n.length <= 15) {
    const msisdn: CandidatIdentifiant = { type: 'msisdn', valeur: n, confiance: 'possible' };
    if (n.length === 15 && !luhn) candidats.unshift(msisdn);
    else candidats.push(msisdn);
  }

  return candidats;
}
