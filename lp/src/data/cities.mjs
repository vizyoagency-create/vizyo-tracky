// Villes / départements ciblés pour le SEO local Occitanie.
// Ajouter une ville = ajouter un objet ici, puis `node build.mjs`.
// `generate:true` => une page gps-flotte-<slug>.html est produite.
// `inDept`/`ofDept` => formulation grammaticale correcte (« en Haute-Garonne », « du Tarn »…).
// `context` => contenu LOCAL UNIQUE (ton humain, concret — pas de remplissage marketing).
export const cities = [
  {
    slug: 'toulouse', name: 'Toulouse', dept: 'Haute-Garonne', deptNum: '31',
    inDept: 'en Haute-Garonne', ofDept: 'de la Haute-Garonne',
    lat: 43.6047, lng: 1.4442, generate: true,
    zones: ['Blagnac', 'Colomiers', 'Tournefeuille', 'Balma', 'Muret', 'Cugnaux', 'Labège', "L'Union", 'Ramonville', 'Plaisance-du-Touch'],
    context: "À Toulouse, entre le périph saturé et des chantiers qui bougent chaque semaine, on perd vite un véhicule de vue. Vous voyez chaque camion en direct, le moteur reste coupé en dehors des heures de service, et l'historique des trajets fait office de justificatif quand on vous le demande.",
  },
  {
    slug: 'montpellier', name: 'Montpellier', dept: 'Hérault', deptNum: '34',
    inDept: "dans l'Hérault", ofDept: "de l'Hérault",
    lat: 43.6108, lng: 3.8767, generate: true,
    zones: ['Lattes', 'Castelnau-le-Lez', 'Pérols', 'Juvignac', 'Lunel', 'Sète'],
    context: "Montpellier grandit vite, et avec elle les tournées de livraison et les équipes qui sillonnent la ville. Le suivi en direct vous évite les « t'es où ? » au téléphone, et la coupure moteur protège les véhicules garés en centre-ville.",
  },
  {
    slug: 'nimes', name: 'Nîmes', dept: 'Gard', deptNum: '30',
    inDept: 'dans le Gard', ofDept: 'du Gard',
    lat: 43.8367, lng: 4.3601, generate: true,
    zones: ['Alès', 'Bagnols-sur-Cèze', 'Beaucaire', 'Vauvert', 'Uzès'],
    context: "Beaucoup de flottes BTP et de négoce passent par Nîmes et l'A9. Sur un chantier, vous repérez l'engin en deux secondes ; le soir venu, le moteur se coupe seul et le matériel ne bouge plus.",
  },
  {
    slug: 'perpignan', name: 'Perpignan', dept: 'Pyrénées-Orientales', deptNum: '66',
    inDept: 'dans les Pyrénées-Orientales', ofDept: 'des Pyrénées-Orientales',
    lat: 42.6887, lng: 2.8948, generate: true,
    zones: ['Canet-en-Roussillon', 'Saint-Estève', 'Cabestany', 'Argelès-sur-Mer', 'Rivesaltes'],
    context: "Avec Saint-Charles et la frontière espagnole toute proche, le transport ne s'arrête jamais à Perpignan. Vous fiabilisez les tournées, vous prouvez les passages, et vous gardez un œil sur les véhicules même de l'autre côté de la frontière.",
  },
  {
    slug: 'albi', name: 'Albi', dept: 'Tarn', deptNum: '81',
    inDept: 'dans le Tarn', ofDept: 'du Tarn',
    lat: 43.9298, lng: 2.1480, generate: true,
    zones: ['Castres', 'Gaillac', 'Graulhet', 'Lavaur', 'Carmaux'],
    context: "Dans le Tarn, vos véhicules font de la route entre Albi, Castres et les villages alentour. Plutôt que d'appeler chaque conducteur, vous ouvrez l'appli et vous savez où en est chacun.",
  },
  {
    slug: 'montauban', name: 'Montauban', dept: 'Tarn-et-Garonne', deptNum: '82',
    inDept: 'dans le Tarn-et-Garonne', ofDept: 'du Tarn-et-Garonne',
    lat: 44.0181, lng: 1.3550, generate: true,
    zones: ['Castelsarrasin', 'Moissac', 'Caussade', 'Grisolles'],
    context: "Montauban est posée sur l'A20 et l'A62 : ça roule beaucoup. Vous suivez les livraisons en temps réel et vous donnez à vos clients l'heure exacte de passage, sans discussion.",
  },
  {
    slug: 'tarbes', name: 'Tarbes', dept: 'Hautes-Pyrénées', deptNum: '65',
    inDept: 'dans les Hautes-Pyrénées', ofDept: 'des Hautes-Pyrénées',
    lat: 43.2328, lng: 0.0782, generate: true,
    zones: ['Lourdes', 'Aureilhan', 'Bagnères-de-Bigorre', 'Lannemezan'],
    context: "De la plaine de Tarbes aux vallées et à Lourdes, vos véhicules passent de l'autoroute à la montagne. Le suivi tient partout, et vous gardez l'historique de chaque déplacement.",
  },
  {
    slug: 'carcassonne', name: 'Carcassonne', dept: 'Aude', deptNum: '11',
    inDept: "dans l'Aude", ofDept: "de l'Aude",
    lat: 43.2130, lng: 2.3491, generate: true,
    zones: ['Narbonne', 'Castelnaudary', 'Limoux', 'Lézignan-Corbières'],
    context: "Entre la Cité, le vignoble et le littoral narbonnais, l'Aude c'est de grandes distances et des pics d'activité. Vous planifiez mieux les tournées et vous sécurisez le matériel laissé sur les exploitations.",
  },
  {
    slug: 'rodez', name: 'Rodez', dept: 'Aveyron', deptNum: '12',
    inDept: "dans l'Aveyron", ofDept: "de l'Aveyron",
    lat: 44.3506, lng: 2.5730, generate: true,
    zones: ['Millau', 'Villefranche-de-Rouergue', 'Onet-le-Château', 'Decazeville'],
    context: "L'Aveyron, c'est vaste : entre Rodez, Millau et les plateaux, les kilomètres s'accumulent. Vous coupez les trajets inutiles et vous retrouvez n'importe quel véhicule, même au bout d'une route de campagne.",
  },
  {
    slug: 'auch', name: 'Auch', dept: 'Gers', deptNum: '32',
    inDept: 'dans le Gers', ofDept: 'du Gers',
    lat: 43.6463, lng: 0.5862, generate: true,
    zones: ['Condom', "L'Isle-Jourdain", 'Fleurance', 'Mirande'],
    context: "Dans le Gers, on roule beaucoup entre des villages éloignés. Le GPS aide à grouper les tournées et à justifier les déplacements des véhicules de service, jusqu'au dernier hameau.",
  },
  {
    slug: 'foix', name: 'Foix', dept: 'Ariège', deptNum: '09',
    inDept: 'en Ariège', ofDept: "de l'Ariège",
    lat: 42.9655, lng: 1.6045, generate: true,
    zones: ['Pamiers', 'Saint-Girons', 'Lavelanet', 'Tarascon-sur-Ariège'],
    context: "L'Ariège, c'est la montagne : routes étroites, vallées, accès parfois compliqués. Le suivi reste fiable en zone reculée et aide les équipes à se coordonner sur un territoire très étalé.",
  },
  {
    slug: 'cahors', name: 'Cahors', dept: 'Lot', deptNum: '46',
    inDept: 'dans le Lot', ofDept: 'du Lot',
    lat: 44.4475, lng: 1.4413, generate: true,
    zones: ['Figeac', 'Gourdon', 'Souillac', 'Prayssac'],
    context: "Le Lot mêle vignoble, tourisme et habitat dispersé : vos véhicules tournent sur de longues distances. Vous optimisez les trajets et vous savez en permanence où se trouve le matériel.",
  },
  {
    slug: 'mende', name: 'Mende', dept: 'Lozère', deptNum: '48',
    inDept: 'en Lozère', ofDept: 'de la Lozère',
    lat: 44.5180, lng: 3.5000, generate: true,
    zones: ['Marvejols', 'Florac', "Saint-Chély-d'Apcher", 'Langogne'],
    context: "En Lozère, la distance et le relief font des véhicules de service un vrai sujet, surtout pour le médico-social. Le suivi fonctionne même en zone isolée, et chaque déplacement se justifie d'un coup d'œil.",
  },
];

// Page chapeau région
export const region = {
  slug: 'occitanie', name: 'Occitanie',
  intro: "Vizyo Tracky équipe les flottes professionnelles et les véhicules de service publics dans les 13 départements d'Occitanie.",
};
