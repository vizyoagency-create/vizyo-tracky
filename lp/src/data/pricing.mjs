// ──────────────────────────────────────────────────────────────────────────
//  GRILLE TARIFAIRE — ÉDITE ICI ET NULLE PART AILLEURS.
//  Repositionnement 2026 (source : Vizyo_Tracky_Plan_Action_INTERNE.xlsx, « Repositionnement ») :
//  modèle TOUT INCLUS — boîtier, SIM & data, pose et garantie COMPRIS dans l'abonnement
//  (on ne facture plus le matériel ni la pose à part). Prix HT, par véhicule et par AN.
//  Deux formules : Sérénité (tout inclus, engagement 36 mois) et Liberté (sans
//  engagement, 12 mois, matériel restitué en fin de contrat).
// ──────────────────────────────────────────────────────────────────────────
export const pricing = {
  currency: '€',
  vat: 'HT',

  /** Ce que « tout inclus » veut dire, partout où on l'affiche. */
  toutInclus: 'Boîtier, SIM & data, pose par nos équipes et garantie inclus',

  formules: {
    serenite: { key: 'serenite', name: 'Sérénité', sub: 'Tout inclus · engagement 36 mois', engagementMois: 36 },
    liberte: { key: 'liberte', name: 'Liberté', sub: 'Sans engagement · 12 mois · matériel restitué', engagementMois: 0 },
  },

  // Prix / véhicule / AN (HT) par formule.
  plans: {
    lite: {
      key: 'lite',
      name: 'Tracky Lite',
      tagline: 'Géolocalisation simple — sans coupe-circuit',
      serenite: 149,
      liberte: 199,
    },
    pro: {
      key: 'pro',
      name: 'Tracky Pro',
      tagline: 'Contrôle total — coupure moteur incluse',
      serenite: 199,
      liberte: 259,
      popular: true,
    },
    signature: {
      key: 'signature',
      name: 'Tracky Signature',
      tagline: 'Premium — tout compris, sans exception',
      serenite: 269,
      liberte: 349,
    },
  },

  // Options à la carte (€/véhicule/AN, HT) pour Lite & Pro.
  // ⚠️ TOUTES les options sont INCLUSES dans Tracky Signature.
  addons: {
    live: { key: 'live', label: 'Live temps réel (20 s)', perVehYear: 119 },
    micro: { key: 'micro', label: "Micro d'assistance", perVehYear: 83 },
    agent: { key: 'agent', label: 'Assistant IA (optimisation)', perVehYear: 179 },
    retention: [
      { key: '90j', years: 0.25, label: '90 jours', perVehYear: 0, included: true },
      { key: '1an', years: 1, label: '1 an', perVehYear: 47 },
      { key: '2ans', years: 2, label: '2 ans', perVehYear: 83 },
      { key: '3ans', years: 3, label: '3 ans', perVehYear: 119 },
    ],
  },

  // Estimation des économies annuelles par véhicule (carburant + usage maîtrisé) — barre ROI.
  savingsPerVehYear: { low: 200, high: 400 },

  // Offre de lancement datée + prix bloqué à la souscription.
  launch: {
    active: true,
    label: 'Tarif de lancement',
    until: '2026-09-30',
    slotsLeft: 12,
    guarantee: 'Tarif garanti à vie pour toute souscription avant cette date.',
  },
};
