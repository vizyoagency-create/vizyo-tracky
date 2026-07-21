// ──────────────────────────────────────────────────────────────────────────
//  GRILLE TARIFAIRE — ÉDITE ICI ET NULLE PART AILLEURS.
//  Ces valeurs alimentent à la fois le HTML (cartes tarifs) et le simulateur JS.
//  Prix HT, par véhicule et par mois sauf mention contraire.
//  Modèle "façon Claude" : un socle inclus + les ressources lourdes
//  (Live temps réel, rétention longue) facturées en plus pour protéger la marge VPS.
// ──────────────────────────────────────────────────────────────────────────
export const pricing = {
  currency: '€',
  vat: 'HT',

  // Gammes. annual = tarif mis en avant (engagement 12 mois, reconductible, bloqué
  // à la souscription). monthly = option sans engagement, volontairement plus chère.
  plans: {
    lite: {
      key: 'lite',
      name: 'Tracky Lite',
      tagline: 'Géolocalisation simple — sans coupe-circuit',
      annual: 22.90,
      monthly: 32.90,
      hardware: 99,
      freq: 'Suivi standard (30–60 s / sur événement)',
      retentionIncluded: '90 jours',
    },
    pro: {
      key: 'pro',
      name: 'Tracky Pro',
      tagline: 'Contrôle total — coupure moteur incluse',
      annual: 29.90,
      monthly: 42.90,
      hardware: 189,
      freq: 'Suivi standard (30–60 s / sur événement)',
      retentionIncluded: '90 jours',
      popular: true,
    },
    fleet: {
      key: 'fleet',
      name: 'Tracky Fleet',
      tagline: 'Sur-mesure pour flottes structurées (10+ véhicules)',
      annual: null, // sur devis
      monthly: null,
      hardware: null,
    },
  },

  // Options facturées en plus (la partie "usage").
  addons: {
    // Temps réel 10 s : multiplie le volume de données stocké → surtaxe assumée.
    live: { key: 'live', label: 'Live temps réel (20 s)', perVehMonth: 9.90 },
    // Micro d'assistance embarqué (légal, cas d'accident) et Agent IA d'optimisation.
    micro: { key: 'micro', label: "Micro d'assistance", perVehMonth: 6.90 },
    agent: { key: 'agent', label: 'Agent IA (optimisation)', perVehMonth: 14.90 },
    // Rétention longue : plus de stockage = palier facturé. 90 j inclus partout.
    retention: [
      { key: '90j', years: 0.25, label: '90 jours', perVehMonth: 0, included: true },
      { key: '1an', years: 1, label: '1 an', perVehMonth: 3.90 },
      { key: '2ans', years: 2, label: '2 ans', perVehMonth: 6.90 },
      { key: '3ans', years: 3, label: '3 ans', perVehMonth: 9.90 },
    ],
  },

  // Installation (one-shot, par véhicule).
  install: { base: 49, from5: 29, freeFrom: 10 },

  // Estimation des économies annuelles par véhicule (carburant + usage maîtrisé),
  // utilisée pour la barre ROI du simulateur.
  savingsPerVehYear: { low: 200, high: 400 },

  // Offre de lancement datée + prix bloqué à la souscription.
  // until = date de fin (YYYY-MM-DD). slotsLeft = places restantes affichées.
  launch: {
    active: true,
    label: 'Tarif de lancement',
    until: '2026-09-30',
    slotsLeft: 12,
    guarantee: 'Tarif garanti à vie pour toute souscription avant cette date.',
  },
};
