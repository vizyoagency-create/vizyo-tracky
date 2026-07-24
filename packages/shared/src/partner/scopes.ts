/**
 * Registre des SCOPES de partage partenaire (intégration Tracky × Maestroo).
 *
 * Un scope = une CATÉGORIE de données que la flotte accepte de partager avec une
 * application partenaire. Ce n'est PAS un consentement figé signé une fois : c'est un
 * ÉTAT VIVANT, modifiable à tout moment par le fleet-admin depuis « Intégrations », et
 * vérifié côté serveur à CHAQUE requête partenaire. Éteindre un scope déclenche la même
 * machinerie de purge qu'une révocation totale, limitée à ce scope.
 *
 * ⚠️ Les VALEURS sont figées : elles sont persistées en base des deux côtés
 * (`PartnerLink.scopes` ici, `TrackyLink.scopes` + `TrackyMirror.scope` chez le
 * partenaire). Ne JAMAIS renommer une clé — ajouter, éventuellement déprécier.
 *
 * ⚠️ Ce fichier a un JUMEAU côté Maestroo (`packages/shared/src/enums/partner-scope.ts`).
 * Les deux repos étant indépendants, la parité est garantie par un test de chaque côté
 * qui compare la liste à un littéral figé. Ajouter un scope = modifier les deux fichiers
 * ET les deux tests.
 *
 * Spec : docs/23-integration-maestroo-phase0-spec.md §2
 */

export const PARTNER_SCOPES = [
  'VEHICLE_IDENTITY',
  'DRIVER_IDENTITY',
  'MILEAGE_TRIPS',
  'FUEL',
  'MAINTENANCE',
  'DRIVER_HOURS',
  'ALERTS',
  'LIVE_POSITION',
  'DRIVING_BEHAVIOR',
  // ⚠️ Le seul scope qui autorise une ÉCRITURE entrante (étape 4, doc 25 §3.3).
  // Tous les autres partagent des données ; celui-ci permet au partenaire de
  // CORRIGER l'identité d'un véhicule (marque, modèle, année, énergie) quand le
  // client tranche un écart en faveur de Maestroo. Champs bornés par une
  // allowlist serveur — jamais la plaque, jamais le kilométrage, jamais
  // l'opérationnel.
  'VEHICLE_WRITEBACK',
] as const;

export type PartnerScope = (typeof PARTNER_SCOPES)[number];

/**
 * Scopes SENSIBLES : position temps réel et comportement de conduite NOMINATIF.
 *
 * Ils sont OFF par défaut et l'écran de consentement doit afficher un avertissement
 * explicite avant activation (`DRIVING_BEHAVIOR` = évaluation de salariés au sens CNIL :
 * information des salariés + registre des traitements à jour).
 *
 * Invariant vérifié en test : SENSIBLE ⇒ jamais dans les défauts.
 */
export const PARTNER_SCOPES_SENSITIVE: readonly PartnerScope[] = [
  'LIVE_POSITION',
  'DRIVING_BEHAVIOR',
  // Sensible par nature : ce n'est pas un partage, c'est un droit d'ÉCRITURE.
  // OFF par défaut (D11) — le consentement de partage n'emporte pas le droit
  // de modifier.
  'VEHICLE_WRITEBACK',
];

/** Scopes activés à la création d'un lien = tous SAUF les sensibles. */
export const PARTNER_SCOPES_DEFAULT_ON: readonly PartnerScope[] = PARTNER_SCOPES.filter(
  (s) => !PARTNER_SCOPES_SENSITIVE.includes(s),
);

export interface PartnerScopeLabel {
  /** Libellé court affiché sur l'interrupteur. */
  label: string;
  /** Une phrase : ce que le partenaire voit CONCRÈTEMENT si le scope est allumé. */
  description: string;
}

/** Libellés FR de l'écran de consentement. `Record` exhaustif : TS impose la complétude. */
export const PARTNER_SCOPE_LABELS: Record<PartnerScope, PartnerScopeLabel> = {
  VEHICLE_IDENTITY: {
    label: 'Identité des véhicules',
    description: 'Plaque, marque, modèle, année, énergie et nombre de places.',
  },
  DRIVER_IDENTITY: {
    label: 'Identité des conducteurs',
    description: 'Nom, prénom et coordonnées des conducteurs de la flotte.',
  },
  MILEAGE_TRIPS: {
    label: 'Kilométrage et trajets',
    description:
      'Distances parcourues, durées et horaires des trajets, relevé du compteur kilométrique.',
  },
  FUEL: {
    label: 'Carburant',
    description: 'Pleins renseignés et consommation réelle mesurée par véhicule.',
  },
  MAINTENANCE: {
    label: 'Entretien et incidents',
    description: 'Entretiens planifiés ou réalisés, incidents et immobilisations de véhicules.',
  },
  DRIVER_HOURS: {
    label: 'Heures de conduite',
    description: "Durées de conduite journalières par conducteur. Aucune position n'est transmise.",
  },
  ALERTS: {
    label: 'Alertes',
    description: 'Alertes Tracky (excès de vitesse, SOS, sortie de zone, perte GPS…).',
  },
  LIVE_POSITION: {
    label: 'Position en temps réel',
    description:
      'Position et vitesse instantanées des véhicules. Le partenaire peut afficher votre flotte sur une carte.',
  },
  DRIVING_BEHAVIOR: {
    label: 'Comportement de conduite',
    description:
      'Éco-score, excès de vitesse, accélérations et freinages brusques, RATTACHÉS À CHAQUE CONDUCTEUR.',
  },
  VEHICLE_WRITEBACK: {
    label: 'Corrections depuis Maestroo',
    description:
      "Maestroo peut CORRIGER l'identité de vos véhicules (marque, modèle, année, énergie) quand vous tranchez un écart en sa faveur. Jamais la plaque, jamais le kilométrage.",
  },
};

/** Garde de type : `value` est-il un scope connu de CETTE version du registre ? */
export function isPartnerScope(value: unknown): value is PartnerScope {
  return typeof value === 'string' && (PARTNER_SCOPES as readonly string[]).includes(value);
}

/**
 * Normalise une liste de scopes reçue de l'extérieur (corps HTTP, colonne JSON).
 *
 * Politique volontairement FAIL-CLOSED : toute valeur inconnue, dupliquée ou non-string
 * est SILENCIEUSEMENT ÉCARTÉE plutôt que de faire échouer l'appel. Deux raisons :
 *  - compatibilité ascendante — si un côté ajoute un scope avant l'autre, le plus ancien
 *    l'ignore (il ne saurait de toute façon pas quoi en faire) au lieu de casser le lien ;
 *  - sécurité — une valeur non reconnue n'accorde jamais rien.
 *
 * L'ordre de sortie est celui de `PARTNER_SCOPES` (stable), ce qui rend les comparaisons
 * de listes fiables sans tri préalable.
 */
export function parsePartnerScopes(value: unknown): PartnerScope[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<PartnerScope>();
  for (const entry of value) {
    if (isPartnerScope(entry)) seen.add(entry);
  }
  return PARTNER_SCOPES.filter((s) => seen.has(s));
}

/** Le scope est-il actif dans cette liste ? Unique point de décision « ai-je le droit ». */
export function hasPartnerScope(scopes: unknown, scope: PartnerScope): boolean {
  return parsePartnerScopes(scopes).includes(scope);
}

/**
 * Scopes retirés entre deux états — c'est-à-dire ce qu'il faut PURGER chez le partenaire.
 * Utilisé au renouvellement du bail : le partenaire compare les scopes annoncés par Tracky
 * à ceux qu'il détenait, et purge la différence (2ᵉ chemin de la révocation partielle,
 * indépendant du webhook).
 */
export function revokedPartnerScopes(previous: unknown, next: unknown): PartnerScope[] {
  const after = new Set(parsePartnerScopes(next));
  return parsePartnerScopes(previous).filter((s) => !after.has(s));
}
