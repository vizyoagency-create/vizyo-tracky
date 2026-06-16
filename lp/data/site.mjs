// Configuration globale du site — 1 seule source de vérité.
export const site = {
  name: 'Vizyo Tracky',
  tagline: 'Traçage GPS & gestion de flotte',
  baseUrl: 'https://vizyo-tracky.vizyoagency.com',
  appUrl: 'https://app-tracky.vizyoagency.com',
  leadApi: 'https://app-tracky.vizyoagency.com/api/leads/contact',
  email: 'contact@vizyoagency.com',
  phoneE164: '+33652077038',
  phoneDisplay: '06 52 07 70 38',
  whatsapp: '33652077038',
  agencyUrl: 'https://www.vizyoagency.com',
  region: 'Occitanie',
  baseCity: 'Toulouse',
  // Image OG (aperçu de partage) — 1200×630.
  ogImage: '/og-cover.jpg',
  locale: 'fr_FR',
};

// Navigation principale (header vitrine). `children` = sous-menu déroulant.
export const nav = [
  { label: 'Fonctionnalités', href: 'fonctionnalites.html' },
  { label: 'Secteur public', href: 'secteur-public.html' },
  { label: 'Tarifs', href: 'tarifs.html' },
  {
    label: 'Zones desservies',
    href: 'gps-flotte-occitanie.html',
    children: [
      { label: 'GPS flotte Toulouse', href: 'gps-flotte-toulouse.html' },
      { label: 'GPS flotte Occitanie', href: 'gps-flotte-occitanie.html' },
    ],
  },
  { label: 'Sécurité', href: 'securite.html' },
];
