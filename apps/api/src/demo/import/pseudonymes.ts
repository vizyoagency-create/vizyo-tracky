import { createHmac } from 'node:crypto';

/**
 * ═══ PSEUDONYMES DÉTERMINISTES ═════════════════════════════════════════════════════════════
 *
 * Tout est dérivé d'un HMAC-SHA256 (sel secret, valeur source). Deux propriétés, et c'est pour
 * elles que ce fichier existe :
 *   · STABLE   — le même véhicule reçoit la même plaque à chaque rafraîchissement hebdomadaire ;
 *                un prospect qui a noté « AB-123-CD » la retrouve dimanche soir.
 *   · OPAQUE   — sans le sel, rien ne remonte de la plaque de démo à la plaque réelle.
 *
 * Les collisions sont possibles (rares) : chaque fonction accepte un numéro de `tentative` que
 * l'importeur incrémente jusqu'à obtenir une valeur libre.
 */
export function empreinte(sel: string, ...morceaux: string[]): Buffer {
  return createHmac('sha256', sel).update(morceaux.join('\x00')).digest();
}

/** L'alphabet du SIV : sans I, O ni U (confusion avec 1, 0 et V), comme à l'ANTS. */
const LETTRES_SIV = 'ABCDEFGHJKLMNPQRSTVWXYZ';

/** Une plaque au format SIV « AB-123-CD ». `SS` est interdit, `WW` réservé aux provisoires. */
export function plaqueDemo(sel: string, plaqueSource: string, tentative = 0): string {
  const h = empreinte(sel, 'plaque', plaqueSource.trim().toUpperCase(), String(tentative));
  const lettre = (i: number): string => LETTRES_SIV[h[i]! % LETTRES_SIV.length]!;
  const nombre = 1 + (((h[4]! << 8) | h[5]!) % 999);
  let gauche = lettre(0) + lettre(1);
  let droite = lettre(2) + lettre(3);
  if (gauche === 'SS' || gauche === 'WW') gauche = 'D' + lettre(1);
  if (droite === 'SS') droite = 'D' + lettre(3);
  return `${gauche}-${String(nombre).padStart(3, '0')}-${droite}`;
}

/** Clé de Luhn d'une suite de chiffres (celle des IMEI réels). */
function cleLuhn(chiffres: string): string {
  let somme = 0;
  let doubler = true; // en partant de la droite, le premier chiffre est doublé (position 14 sur 15)
  for (let i = chiffres.length - 1; i >= 0; i--) {
    let d = Number(chiffres[i]);
    if (doubler) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    somme += d;
    doubler = !doubler;
  }
  return String((10 - (somme % 10)) % 10);
}

/**
 * Un IMEI de 15 chiffres, clé de Luhn comprise : les gardes du produit (`/imei:\d{15},J/`,
 * validations de saisie) voient un identifiant aussi vrai qu'un vrai. Préfixe TAC fictif « 35 ».
 */
export function imeiDemo(sel: string, imeiSource: string, tentative = 0): string {
  const h = empreinte(sel, 'imei', imeiSource.trim(), String(tentative));
  let corps = '35';
  for (let i = 0; corps.length < 14; i++) corps += String(h[i]! % 10);
  return corps + cleLuhn(corps);
}

/**
 * ICCID de démonstration — 19 chiffres, clé de Luhn valide.
 *
 * `89` est le préfixe télécom de l'ISO/IEC 7812 et `33` le code pays France. Les SIM de la
 * source sont espagnoles (`8934`) ; on francise, la société de démonstration étant française
 * et son parc censé rouler en France.
 */
export function iccidDemo(sel: string, iccidSource: string, tentative = 0): string {
  const h = empreinte(sel, 'iccid', iccidSource.trim(), String(tentative));
  let corps = '8933';
  for (let i = 0; corps.length < 18; i++) corps += String(h[i]! % 10);
  return corps + cleLuhn(corps);
}

/**
 * Numéro d'appel de démonstration, pris dans la PLAGE DE FICTION RÉSERVÉE PAR L'ARCEP.
 *
 * ⚠️ Ce n'est pas un raffinement. Un numéro mobile tiré au hasard dans `06` appartient à
 * quelqu'un : le jour où un prospect clique « appeler le conducteur » depuis la démo, il
 * fait sonner le téléphone d'un inconnu. L'ARCEP réserve `06 39 98 00 00` à `06 39 98 99 99`
 * pour la fiction — dix mille numéros attribués à personne, et qui ne le seront jamais.
 * On y puise, et on n'en sort pas : les quatre derniers chiffres seuls varient.
 */
export function msisdnDemo(sel: string, idSource: string): string {
  const h = empreinte(sel, 'msisdn', idSource.trim());
  const n = String(((h[0]! << 8) | h[1]!) % 10_000).padStart(4, '0');
  return `+3363998${n}`;
}

/**
 * IMSI de démonstration — 15 chiffres : MCC 208 (France), MNC 01, puis dix chiffres.
 * L'IMSI identifie l'abonné chez l'opérateur ; celui de la source ne doit jamais ressortir.
 */
export function imsiDemo(sel: string, idSource: string): string {
  const h = empreinte(sel, 'imsi', idSource.trim());
  let s = '20801';
  for (let i = 0; s.length < 15; i++) s += String(h[i]! % 10);
  return s;
}

const PRENOMS = [
  'Camille', 'Julien', 'Sophie', 'Nicolas', 'Léa', 'Thomas', 'Manon', 'Antoine', 'Chloé', 'Maxime',
  'Inès', 'Hugo', 'Sarah', 'Lucas', 'Emma', 'Mehdi', 'Nadia', 'Karim', 'Yasmine', 'Romain',
  'Clara', 'Adrien', 'Lina', 'Bastien', 'Amina', 'Théo', 'Louise', 'Samir', 'Élodie', 'Mathieu',
  'Jade', 'Rayan', 'Océane', 'Florian', 'Anaïs', 'Kevin', 'Farah', 'Alexandre', 'Marine', 'Yanis',
];
const NOMS = [
  'Martin', 'Bernard', 'Dubois', 'Robert', 'Richard', 'Petit', 'Durand', 'Leroy', 'Moreau', 'Simon',
  'Laurent', 'Lefebvre', 'Michel', 'Garcia', 'David', 'Bertrand', 'Roux', 'Vincent', 'Fournier', 'Morel',
  'Girard', 'André', 'Mercier', 'Dupont', 'Lambert', 'Bonnet', 'François', 'Martinez', 'Legrand', 'Garnier',
  'Faure', 'Rousseau', 'Blanc', 'Guérin', 'Muller', 'Henry', 'Roussel', 'Perrin', 'Fontaine', 'Chevalier',
];

/** Une identité de conducteur tirée de deux listes françaises courantes (1 600 combinaisons). */
export function identiteDemo(sel: string, idSource: string, tentative = 0): { firstName: string; lastName: string } {
  const h = empreinte(sel, 'conducteur', idSource, String(tentative));
  return {
    firstName: PRENOMS[((h[0]! << 8) | h[1]!) % PRENOMS.length]!,
    lastName: NOMS[((h[2]! << 8) | h[3]!) % NOMS.length]!,
  };
}

const LIBELLES_LIEU: Record<string, string> = {
  FUEL_STATION: 'Station',
  PARKING: 'Parking',
  DEPOT: 'Dépôt',
  OTHER: 'Site',
};

/**
 * Le nom d'un lieu de la flotte : « Dépôt 1 », « Parking 3 ». Un nom de dépôt identifie le
 * client (« Dépôt CDEF Fenouillet ») ; le genre et un numéro suffisent à la démo.
 */
export function nomLieuDemo(kind: string, index: number): string {
  return `${LIBELLES_LIEU[kind] ?? 'Site'} ${index}`;
}

/** Le nom d'une géofence : « Zone 1 », « Zone 2 »… même raison que les lieux. */
export function nomZoneDemo(index: number): string {
  return `Zone ${index}`;
}

/**
 * Noms de groupes de véhicules INVENTÉS, plausibles pour une société de transport.
 *
 * ⚠️ UN NOM DE GROUPE EST UN NOM DE CLIENT, et c'est passé près de partir en démo. Mesuré le
 * 2026-09-07 sur la société source : ses dix-sept groupes s'appellent « ARC EN CIEL », « ESCALE »,
 * « HAVRE », « ÉDEN », « BORÉAL »… — ce sont les FOYERS de l'établissement, pas des libellés
 * d'exploitation. Quelqu'un du secteur les reconnaît immédiatement, et aucune règle de
 * remplacement ne pouvait les attraper : ils ne ressemblent ni à une plaque, ni à un nom de
 * personne, ni à la raison sociale.
 *
 * On ne cherche donc pas à distinguer les noms « inoffensifs » des autres — cette distinction
 * n'est pas tenable — on les remplace TOUS. Le prospect voit une organisation crédible, et rien
 * du client.
 */
const NOMS_GROUPES = [
  'Secteur Nord', 'Secteur Sud', 'Secteur Est', 'Secteur Ouest', 'Navettes',
  'Atelier', 'Astreinte', 'Longue distance', 'Livraisons', 'Réserve',
  'Équipe de nuit', 'Équipe de jour', 'Week-end', 'Direction', 'Interventions',
  'Remplacement', 'Saisonniers', 'Périurbain', 'Centre-ville', 'Grand export',
];

/** Le nom d'un groupe de véhicules, par rang d'ancienneté. Unique par construction. */
export function nomGroupeDemo(index: number): string {
  return NOMS_GROUPES[index] ?? `Groupe ${index + 1}`;
}

export interface ModeleDemo {
  brand: string;
  model: string;
}

/**
 * ══ MARQUES ET MODÈLES DE REMPLACEMENT ═══════════════════════════════════════════════════════
 *
 * Décision du propriétaire (2026-09-07) : son accord avec les sociétés source porte sur « les
 * trajets seuls, sans les plaques ni autre info ». La marque et le modèle réels sortent donc,
 * même s'ils ne désignent pas le client.
 *
 * On ne les efface pas pour autant : un parc sans marque ni modèle est un parc qui a l'air cassé.
 * On les REMPLACE par des véhicules crédibles — des modèles réels du marché, qui ne disent rien
 * de personne — choisis dans la famille du TYPE et de l'ÉNERGIE du véhicule. Un utilitaire
 * électrique reçoit un utilitaire électrique : sinon la consommation affichée, calculée à partir
 * de l'énergie, contredirait la fiche sous les yeux du prospect.
 */
const MODELES: Record<string, { thermique: ModeleDemo[]; electrique: ModeleDemo[] }> = {
  CAR: {
    thermique: [
      { brand: 'Peugeot', model: '208' }, { brand: 'Renault', model: 'Clio V' },
      { brand: 'Citroën', model: 'C3' }, { brand: 'Opel', model: 'Corsa' },
      { brand: 'Toyota', model: 'Yaris' }, { brand: 'Volkswagen', model: 'Polo' },
      { brand: 'Dacia', model: 'Sandero' }, { brand: 'Ford', model: 'Fiesta' },
      { brand: 'Seat', model: 'Ibiza' }, { brand: 'Škoda', model: 'Fabia' },
    ],
    electrique: [
      { brand: 'Renault', model: 'Zoe' }, { brand: 'Peugeot', model: 'e-208' },
      { brand: 'Dacia', model: 'Spring' }, { brand: 'Opel', model: 'Corsa-e' },
      { brand: 'Fiat', model: '500e' }, { brand: 'MG', model: 'MG4' },
    ],
  },
  VAN: {
    thermique: [
      { brand: 'Renault', model: 'Trafic' }, { brand: 'Peugeot', model: 'Expert' },
      { brand: 'Citroën', model: 'Jumpy' }, { brand: 'Ford', model: 'Transit Custom' },
      { brand: 'Opel', model: 'Vivaro' }, { brand: 'Toyota', model: 'Proace' },
      { brand: 'Mercedes-Benz', model: 'Vito' }, { brand: 'Volkswagen', model: 'Transporter' },
    ],
    electrique: [
      { brand: 'Renault', model: 'Kangoo E-Tech' }, { brand: 'Peugeot', model: 'e-Expert' },
      { brand: 'Opel', model: 'Vivaro-e' }, { brand: 'Ford', model: 'E-Transit Custom' },
      { brand: 'Mercedes-Benz', model: 'eVito' }, { brand: 'Toyota', model: 'Proace Electric' },
    ],
  },
  TRUCK: {
    thermique: [
      { brand: 'Renault Trucks', model: 'Master' }, { brand: 'Iveco', model: 'Daily' },
      { brand: 'Fiat Professional', model: 'Ducato' }, { brand: 'Peugeot', model: 'Boxer' },
      { brand: 'Citroën', model: 'Jumper' }, { brand: 'Mercedes-Benz', model: 'Sprinter' },
      { brand: 'Ford', model: 'Transit' }, { brand: 'Volkswagen', model: 'Crafter' },
    ],
    electrique: [
      { brand: 'Mercedes-Benz', model: 'eSprinter' }, { brand: 'Fiat Professional', model: 'E-Ducato' },
      { brand: 'Renault Trucks', model: 'Master E-Tech' }, { brand: 'Iveco', model: 'eDaily' },
    ],
  },
  BUS: {
    thermique: [
      { brand: 'Iveco Bus', model: 'Crossway' }, { brand: 'Mercedes-Benz', model: 'Sprinter City' },
      { brand: 'Otokar', model: 'Vectio' },
    ],
    electrique: [{ brand: 'Bluebus', model: '6m' }, { brand: 'Heuliez', model: 'GX 137 E' }],
  },
  MOTORCYCLE: {
    thermique: [
      { brand: 'Yamaha', model: 'Tricity' }, { brand: 'Honda', model: 'Forza' },
      { brand: 'Piaggio', model: 'MP3' },
    ],
    electrique: [{ brand: 'Silence', model: 'S01' }, { brand: 'NIU', model: 'MQi GT' }],
  },
  BICYCLE: {
    thermique: [{ brand: 'Douze Cycles', model: 'G4' }, { brand: 'Urban Arrow', model: 'Cargo' }],
    electrique: [{ brand: 'Urban Arrow', model: 'Cargo L' }, { brand: 'Riese & Müller', model: 'Load 75' }],
  },
  CONSTRUCTION: {
    thermique: [{ brand: 'Manitou', model: 'MT 625' }, { brand: 'JCB', model: '3CX' }],
    electrique: [{ brand: 'Manitou', model: 'MT 625 e' }],
  },
  OTHER: {
    thermique: [{ brand: 'Renault', model: 'Kangoo' }, { brand: 'Peugeot', model: 'Partner' }],
    electrique: [{ brand: 'Renault', model: 'Kangoo E-Tech' }],
  },
};

/** Marque et modèle de remplacement, stables pour un véhicule donné. */
export function modeleDemo(sel: string, idSource: string, type: string, energie: string | null): ModeleDemo {
  const famille = MODELES[type] ?? MODELES['OTHER']!;
  const liste = energie === 'ELECTRIQUE' && famille.electrique.length > 0 ? famille.electrique : famille.thermique;
  const h = empreinte(sel, 'modele', idSource);
  return liste[(((h[0]! << 8) | h[1]!) % liste.length)]!;
}
