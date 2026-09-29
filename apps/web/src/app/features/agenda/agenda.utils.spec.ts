import type { VehicleEventType } from '@vizyo/tracky-shared';
import {
  dansFenetreReorganisation,
  demandeNonReaffectable,
  dureeEnJours,
  estUneEcheance,
  eventTypeLabel,
  fenetreAReorganiser,
  fenetreImmobilisation,
  fenetresAjoutees,
  horsFenetrePreset,
  HORIZON_SANS_FIN_MS,
  joursDansFenetre,
  libelleVehiculesLibres,
  lotExactDeSimulation,
  placesMaxLibres,
  raisonsVideRefusees,
  rangDuJour,
  repliDefinitif,
  startOfMonth,
  startOfWeekMonday,
} from './agenda.utils';

/**
 * L'AGENDA AFFICHAIT « MISSION » EN CAPITALES, AU MILIEU DE « MAINTENANCE » ET « RÉSERVATION ».
 *
 * Relevé le 2026-09-23. `eventTypeLabel` ne connaissait pas `MISSION` : son `default` renvoyait
 * l'énumération telle quelle. Les missions vivent pourtant dans la MÊME grille que le reste depuis
 * 2026-08 (A2 § 3.1, « un gestionnaire qui ne voit pas les missions double-réserve ») — elles
 * doivent donc se nommer comme le reste.
 *
 * Ce test vaut surtout pour LE PROCHAIN TYPE : il échouera le jour où l'on en ajoutera un sans lui
 * donner de libellé, au lieu de le découvrir sur l'écran d'un client.
 */
describe('eventTypeLabel', () => {
  const TOUS: VehicleEventType[] = ['MAINTENANCE', 'INCIDENT', 'RESERVATION', 'MISSION'];

  it('nomme chaque type en français', () => {
    expect(eventTypeLabel('MAINTENANCE')).toBe('Maintenance');
    expect(eventTypeLabel('INCIDENT')).toBe('Incident');
    expect(eventTypeLabel('RESERVATION')).toBe('Réservation');
    expect(eventTypeLabel('MISSION')).toBe('Mission');
  });

  it('ne laisse AUCUN type retomber sur son énumération brute', () => {
    for (const t of TOUS) {
      const libelle = eventTypeLabel(t);
      expect(libelle).not.toBe(t);
      // Un libellé destiné à l'écran n'est jamais tout en capitales.
      expect(libelle).not.toBe(libelle.toUpperCase());
    }
  });
});

/**
 * « COMPTEUR ≠ LISTE » (audit du 24/09). Le compteur « En retard » ne comptait que les PLANNED,
 * la liste dessous affichait aussi OPEN et IN_PROGRESS : « 1 en retard » au-dessus de trois lignes
 * rouges. `estUneEcheance` est désormais LA règle des deux côtés — ces tests la fixent, et le
 * serveur (`summary`) compte exactement la même chose.
 *
 * Recette du 28/09 (démo) : la règle « OPEN à échéance passée = en retard » faisait passer un
 * incident déclaré à l'instant pour « EN RETARD ». Un OPEN est OUVERT, pas en retard — seul un
 * PLANNED est une échéance, et sa date ne décide que du tri et du badge.
 */
describe('estUneEcheance — la règle unique de la liste « À venir & en retard »', () => {
  const HIER = '2026-09-27T08:00:00Z';
  const DEMAIN = '2026-09-29T08:00:00Z';

  it('un PLANNED est une échéance, passée (en retard) comme future (à venir)', () => {
    expect(estUneEcheance({ status: 'PLANNED', startAt: HIER })).toBe(true);
    expect(estUneEcheance({ status: 'PLANNED', startAt: DEMAIN })).toBe(true);
  });

  it('⚠️ un OPEN n’est pas en retard, même à échéance passée : il est OUVERT (compteur « Incidents ouverts »)', () => {
    expect(estUneEcheance({ status: 'OPEN', startAt: HIER })).toBe(false);
    expect(estUneEcheance({ status: 'OPEN', startAt: DEMAIN })).toBe(false);
  });

  it('⚠️ un IN_PROGRESS n’est ni à venir ni en retard : il est EN COURS, ailleurs', () => {
    expect(estUneEcheance({ status: 'IN_PROGRESS', startAt: HIER })).toBe(false);
    expect(estUneEcheance({ status: 'IN_PROGRESS', startAt: DEMAIN })).toBe(false);
  });

  it('les états clos et les réservations ne sont pas des échéances', () => {
    for (const status of ['DONE', 'CANCELLED', 'REQUESTED', 'CONFIRMED'] as const) {
      expect(estUneEcheance({ status, startAt: HIER })).toBe(false);
      expect(estUneEcheance({ status, startAt: DEMAIN })).toBe(false);
    }
  });
});

/**
 * « 62 j » SUR LA PILULE, « 91 jours » DANS LE PANNEAU DU JOUR (revue du 29/09).
 *
 * La grille comptait la longueur d'une liste de jours bornée à 62, la page comptait les jours
 * civils. `dureeEnJours` est désormais LA règle des deux écrans, sans borne.
 */
describe('dureeEnJours — la durée en jours civils, la même partout', () => {
  it('sans fin, ou une fin le même jour : une journée', () => {
    expect(dureeEnJours({ startAt: '2026-10-05T08:00:00', endAt: null })).toBe(1);
    expect(dureeEnJours({ startAt: '2026-10-05T08:00:00', endAt: '2026-10-05T18:00:00' })).toBe(1);
  });

  it('du 5 au 12 : huit jours, le premier et le dernier compris', () => {
    expect(dureeEnJours({ startAt: '2026-10-05T08:00:00', endAt: '2026-10-12T18:00:00' })).toBe(8);
  });

  it('une fin à minuit pile le lendemain compte le lendemain', () => {
    expect(dureeEnJours({ startAt: '2026-10-05T08:00:00', endAt: '2026-10-06T00:00:00' })).toBe(2);
  });

  it('une fin avant le début, ou illisible : on ne raconte rien de plus qu’une journée', () => {
    expect(dureeEnJours({ startAt: '2026-10-05T08:00:00', endAt: '2026-10-04T18:00:00' })).toBe(1);
    expect(dureeEnJours({ startAt: '2026-10-05T08:00:00', endAt: 'pas une date' })).toBe(1);
    expect(dureeEnJours({ startAt: 'pas une date', endAt: '2026-10-12T18:00:00' })).toBe(1);
  });

  it('⚠️ aucune borne : du 1er sept. au 30 nov., c’est 91 jours (la grille disait 62)', () => {
    expect(dureeEnJours({ startAt: '2026-09-01T08:00:00', endAt: '2026-11-30T18:00:00' })).toBe(91);
  });

  it('le rang d’un jour suit la même règle : le 9 nov. est le 70e jour', () => {
    const ev = { startAt: '2026-09-01T08:00:00' };
    expect(rangDuJour(ev, new Date(2026, 8, 1))).toBe(1);
    expect(rangDuJour(ev, new Date(2026, 10, 9))).toBe(70);
  });
});

/**
 * La grille du mois n'énumère plus que les jours qu'elle AFFICHE, avec le vrai rang et la vraie
 * durée : un évènement commencé deux mois plus tôt garde sa pilule jusqu'à son dernier jour.
 */
describe('joursDansFenetre — les jours d’un évènement dans la grille affichée', () => {
  const grille = (annee: number, mois: number) => startOfWeekMonday(startOfMonth(new Date(annee, mois, 1)));

  it('un évènement tenu dans la grille : chaque jour, du premier (1/8) au dernier (8/8)', () => {
    const jours = joursDansFenetre({ startAt: '2026-10-05T08:00:00', endAt: '2026-10-12T18:00:00' }, grille(2026, 9), 42);
    expect(jours.length).toBe(8);
    expect(jours[0]).toEqual({ iso: '2026-10-05', jour: 1, total: 8 });
    expect(jours[7]).toEqual({ iso: '2026-10-12', jour: 8, total: 8 });
  });

  it('sans fin : le seul jour de début, rang 1 sur 1', () => {
    expect(joursDansFenetre({ startAt: '2026-10-05T08:00:00', endAt: null }, grille(2026, 9), 42))
      .toEqual([{ iso: '2026-10-05', jour: 1, total: 1 }]);
  });

  it('⚠️ du 1er sept. au 30 nov., vu en novembre : « 70/91 » le 9 nov., et une pilule jusqu’au 30', () => {
    const jours = joursDansFenetre({ startAt: '2026-09-01T08:00:00', endAt: '2026-11-30T18:00:00' }, grille(2026, 10), 42);
    // La grille de novembre 2026 commence le lundi 26 octobre (56e jour).
    expect(jours[0]).toEqual({ iso: '2026-10-26', jour: 56, total: 91 });
    expect(jours.find((j) => j.iso === '2026-11-09')).toEqual({ iso: '2026-11-09', jour: 70, total: 91 });
    expect(jours[jours.length - 1]).toEqual({ iso: '2026-11-30', jour: 91, total: 91 });
  });

  it('jamais plus de jours que la grille n’en montre, même pour un an d’immobilisation', () => {
    // Commencé avant la grille d'octobre (lundi 28 sept.), fini un an plus tard : les 42 jours, pas un de plus.
    const jours = joursDansFenetre({ startAt: '2026-09-01T08:00:00', endAt: '2027-09-01T08:00:00' }, grille(2026, 9), 42);
    expect(jours.length).toBe(42);
    expect(jours[0]).toEqual({ iso: '2026-09-28', jour: 28, total: 366 });
  });

  it('un évènement entièrement hors de la grille, ou au début illisible : rien', () => {
    expect(joursDansFenetre({ startAt: '2026-06-01T08:00:00', endAt: '2026-06-03T08:00:00' }, grille(2026, 9), 42)).toEqual([]);
    expect(joursDansFenetre({ startAt: '2027-06-01T08:00:00', endAt: null }, grille(2026, 9), 42)).toEqual([]);
    expect(joursDansFenetre({ startAt: 'pas une date', endAt: '2026-10-12T18:00:00' }, grille(2026, 9), 42)).toEqual([]);
  });
});

/**
 * PROLONGER UNE IMMOBILISATION LAISSAIT LES RÉSERVATIONS DES JOURS AJOUTÉS SANS UN MOT (revue du 29/09).
 * On ne regarde que ce qui S'AJOUTE : l'ancienne fenêtre a été décidée à la création.
 */
describe('fenetresAjoutees — ce qu’une modification ajoute à l’immobilisation', () => {
  const MAINTENANT = new Date('2026-10-01T08:00:00').getTime();
  const ms = (iso: string) => new Date(iso).getTime();
  const maintenance = (startAt: string, endAt: string | null, blocksVehicle = true) =>
    ({ type: 'MAINTENANCE' as const, status: 'PLANNED' as const, blocksVehicle, startAt, endAt });

  it('fin repoussée du 8 au 12 : seulement [8, 12]', () => {
    const avant = maintenance('2026-10-05T00:00:00', '2026-10-08T23:59:59');
    const apres = maintenance('2026-10-05T00:00:00', '2026-10-12T23:59:59');
    expect(fenetresAjoutees(avant, apres, MAINTENANT)).toEqual([{ from: ms('2026-10-08T23:59:59'), to: ms('2026-10-12T23:59:59') }]);
  });

  it('glissée de deux jours plus tard : seulement la queue ajoutée', () => {
    const avant = maintenance('2026-10-05T00:00:00', '2026-10-08T23:59:59');
    const apres = maintenance('2026-10-07T00:00:00', '2026-10-10T23:59:59');
    expect(fenetresAjoutees(avant, apres, MAINTENANT)).toEqual([{ from: ms('2026-10-08T23:59:59'), to: ms('2026-10-10T23:59:59') }]);
  });

  it('début avancé ET fin repoussée : les deux morceaux', () => {
    const avant = maintenance('2026-10-05T00:00:00', '2026-10-08T23:59:59');
    const apres = maintenance('2026-10-03T00:00:00', '2026-10-09T23:59:59');
    expect(fenetresAjoutees(avant, apres, MAINTENANT)).toEqual([
      { from: ms('2026-10-03T00:00:00'), to: ms('2026-10-05T00:00:00') },
      { from: ms('2026-10-08T23:59:59'), to: ms('2026-10-09T23:59:59') },
    ]);
  });

  it('fenêtre raccourcie : rien à vérifier', () => {
    const avant = maintenance('2026-10-05T00:00:00', '2026-10-12T23:59:59');
    const apres = maintenance('2026-10-05T00:00:00', '2026-10-08T23:59:59');
    expect(fenetresAjoutees(avant, apres, MAINTENANT)).toEqual([]);
  });

  it('« Immobilise » coché en modification : toute la nouvelle fenêtre', () => {
    const avant = maintenance('2026-10-05T00:00:00', '2026-10-08T23:59:59', false);
    const apres = maintenance('2026-10-05T00:00:00', '2026-10-08T23:59:59', true);
    expect(fenetresAjoutees(avant, apres, MAINTENANT)).toEqual([{ from: ms('2026-10-05T00:00:00'), to: ms('2026-10-08T23:59:59') }]);
  });

  it('un évènement qui n’immobilise pas, ou plus : rien', () => {
    const avant = maintenance('2026-10-05T00:00:00', '2026-10-08T23:59:59');
    expect(fenetresAjoutees(avant, maintenance('2026-10-05T00:00:00', '2026-10-12T23:59:59', false), MAINTENANT)).toEqual([]);
    expect(fenetresAjoutees(avant, { ...maintenance('2026-10-05T00:00:00', '2026-10-12T23:59:59'), status: 'DONE' as const }, MAINTENANT)).toEqual([]);
  });

  it('le passé ne se reprend pas : la fenêtre part de maintenant', () => {
    const avant = maintenance('2026-09-25T00:00:00', '2026-09-30T23:59:59');
    const apres = maintenance('2026-09-25T00:00:00', '2026-10-03T23:59:59');
    expect(fenetresAjoutees(avant, apres, MAINTENANT)).toEqual([{ from: MAINTENANT, to: ms('2026-10-03T23:59:59') }]);
  });

  it('un incident à qui l’on retire sa fin : l’horizon du formulaire (30 j), pas l’infini', () => {
    const avant = { type: 'INCIDENT' as const, status: 'OPEN' as const, blocksVehicle: true, startAt: '2026-10-02T00:00:00', endAt: '2026-10-04T00:00:00' as string | null };
    const apres = { ...avant, endAt: null };
    expect(fenetresAjoutees(avant, apres, MAINTENANT)).toEqual([{ from: ms('2026-10-04T00:00:00'), to: ms('2026-10-04T00:00:00') + HORIZON_SANS_FIN_MS }]);
  });

  it('un incident sans fin à qui l’on donne une fin : la fenêtre rétrécit, rien à vérifier', () => {
    const avant = { type: 'INCIDENT' as const, status: 'OPEN' as const, blocksVehicle: true, startAt: '2026-10-02T00:00:00', endAt: null as string | null };
    const apres = { ...avant, endAt: '2026-10-09T00:00:00' };
    expect(fenetresAjoutees(avant, apres, MAINTENANT)).toEqual([]);
  });
});

/**
 * LA CRÉATION FIGEAIT LA FENÊTRE BRUTE (contre-revue du 29/09, S1) : fin vide pour une vidange d'une
 * journée, et Réorganiser s'ouvrait sur les 30 prochains jours du véhicule. La fenêtre lue et la
 * fenêtre figée sont désormais la même, toujours bornée.
 */
describe('fenetreImmobilisation — la fenêtre EFFECTIVE, toujours bornée', () => {
  const ms = (iso: string) => new Date(iso).getTime();
  /** Avant tous les débuts ci-dessous, sauf pour les cas antidatés. */
  const MAINTENANT = ms('2026-09-29T10:00:00');

  it('une maintenance sans fin : sa journée (24 h), pas « sans fin »', () => {
    expect(fenetreImmobilisation('MAINTENANCE', ms('2026-10-06T00:00:00'), null, MAINTENANT))
      .toEqual({ from: ms('2026-10-06T00:00:00'), to: ms('2026-10-06T00:00:00') + 86400000 });
  });

  it('un incident sans fin qui commence plus tard : l’horizon du formulaire (30 j) depuis son début, jamais l’infini', () => {
    expect(fenetreImmobilisation('INCIDENT', ms('2026-10-06T08:00:00'), null, MAINTENANT))
      .toEqual({ from: ms('2026-10-06T08:00:00'), to: ms('2026-10-06T08:00:00') + HORIZON_SANS_FIN_MS });
  });

  it('une fin donnée : telle quelle, quel que soit le type', () => {
    for (const type of ['MAINTENANCE', 'INCIDENT'] as const) {
      expect(fenetreImmobilisation(type, ms('2026-10-06T00:00:00'), ms('2026-10-09T23:59:59'), MAINTENANT))
        .toEqual({ from: ms('2026-10-06T00:00:00'), to: ms('2026-10-09T23:59:59') });
    }
  });

  /**
   * TROISIÈME PASSE (T17) — « DEPUIS LE 20/08 », LU LE 29/09 : [20/08, 19/09], UNE FENÊTRE PASSÉE.
   * Le bloc des réservations disait « rien à reprendre » alors que l'incident immobilise le véhicule
   * jusqu'à résolution. L'horizon part désormais de maintenant ; le début reste celui de l'incident.
   */
  it('⚠️ un incident sans fin antidaté de 40 jours : 30 jours devant À PARTIR DE MAINTENANT', () => {
    const debut = MAINTENANT - 40 * 86400000;
    const fen = fenetreImmobilisation('INCIDENT', debut, null, MAINTENANT);
    expect(fen).toEqual({ from: debut, to: MAINTENANT + HORIZON_SANS_FIN_MS });
    expect(fen.to).toBeGreaterThan(MAINTENANT); // la fenêtre lue n'est jamais déjà passée
  });

  it('un incident sans fin antidaté de 10 jours : encore 30 jours devant, pas 20', () => {
    const debut = MAINTENANT - 10 * 86400000;
    expect(fenetreImmobilisation('INCIDENT', debut, null, MAINTENANT).to - MAINTENANT).toBe(HORIZON_SANS_FIN_MS);
  });

  it('une maintenance sans fin antidatée garde sa journée : le serveur ne la bloque que 24 h', () => {
    const debut = MAINTENANT - 40 * 86400000;
    expect(fenetreImmobilisation('MAINTENANCE', debut, null, MAINTENANT)).toEqual({ from: debut, to: debut + 86400000 });
  });
});

/**
 * DÉBUT AVANCÉ ET FIN REPOUSSÉE (contre-revue du 29/09, R18) : Réorganiser s'ouvrait sur [min, max],
 * donc aussi sur l'ANCIENNE fenêtre, déjà tranchée à la création (parfois par « Laisser »).
 */
describe('fenetreAReorganiser — une seule fenêtre ajoutée, jamais le trou entre les deux', () => {
  const tete = { from: 3, to: 5 };
  const queue = { from: 8, to: 10 };
  const r = (id: string) => ({ id });

  it('aucune réservation trouvée : rien à ouvrir', () => {
    expect(fenetreAReorganiser([tete, queue], [[], []])).toBeNull();
    expect(fenetreAReorganiser([], [])).toBeNull();
  });

  it('une seule fenêtre en porte : celle-là, et rien ailleurs', () => {
    expect(fenetreAReorganiser([tete, queue], [[], [r('q1')]])).toEqual({ fenetre: queue, dedans: [r('q1')], ailleurs: [] });
    expect(fenetreAReorganiser([tete, queue], [[r('t1')], []])).toEqual({ fenetre: tete, dedans: [r('t1')], ailleurs: [] });
  });

  it('les deux en portent : la plus chargée, et l’autre est RENDUE pour être nommée', () => {
    const choix = fenetreAReorganiser([tete, queue], [[r('t1')], [r('q1'), r('q2')]]);
    expect(choix).toEqual({ fenetre: queue, dedans: [r('q1'), r('q2')], ailleurs: [r('t1')] });
  });

  it('à égalité : la plus proche (la première)', () => {
    expect(fenetreAReorganiser([tete, queue], [[r('t1')], [r('q1')]])?.fenetre).toEqual(tete);
  });

  it('la fenêtre choisie n’est jamais [min, max] : l’ancienne fenêtre reste hors du lot', () => {
    const choix = fenetreAReorganiser([tete, queue], [[r('t1'), r('t2')], [r('q1')]]);
    expect(choix?.fenetre).toEqual(tete);
    expect(choix!.fenetre.to <= queue.from).toBe(true);
  });

  it('une réservation à cheval sur les deux fenêtres n’est pas citée deux fois', () => {
    const choix = fenetreAReorganiser([tete, queue], [[r('x'), r('t1')], [r('x'), r('q1')]]);
    expect(choix).toEqual({ fenetre: tete, dedans: [r('x'), r('t1')], ailleurs: [r('q1')] });
  });
});

/**
 * UN REPLI TRANSITOIRE N'EST PAS UN REPLI DÉFINITIF (contre-revue du 29/09, S2). Gardée pour
 * toujours, la vue demandée « ia » rebasculait seule la page sur l'Assistant IA au retour sur une
 * société équipée — onglet Calendrier allumé, sans un clic. Mais figée trop tôt, elle cassait un
 * ?vue=ia ou un « Voir » arrivés avant le statut IA.
 */
describe('repliDefinitif — quand la vue demandée devient la vue affichée', () => {
  it('rien à faire quand la vue demandée est affichée', () => {
    expect(repliDefinitif('ia', 'ia', true, 'ia')).toBe(false);
    expect(repliDefinitif('calendrier', 'calendrier', true, null)).toBe(false);
  });

  it('Assistant IA en chargement (?vue=ia au démarrage, « Voir » après un changement de société) : on attend', () => {
    expect(repliDefinitif('ia', 'calendrier', false, null)).toBe(false);
    expect(repliDefinitif('ia', 'calendrier', false, 'ia')).toBe(false);
  });

  it('Assistant IA non ouvert, statut et propositions chargés : la demande retombe pour de bon', () => {
    expect(repliDefinitif('ia', 'calendrier', true, null)).toBe(true);
    expect(repliDefinitif('ia', 'missions', true, 'ia')).toBe(true);
  });

  it('une autre vue jamais montrée (droits encore en lecture) : on attend', () => {
    expect(repliDefinitif('calendrier', 'missions', true, null)).toBe(false);
  });

  it('une autre vue montrée puis privée de son onglet (droit retiré) : définitif', () => {
    expect(repliDefinitif('parc', 'calendrier', false, 'parc')).toBe(true);
  });
});

/**
 * « 12 PLACES » (29/09) : « 7 / 8 véhicule(s) disponible(s) aujourd'hui » a fait chercher un
 * véhicule de 12 places dans un parc dont le plus grand en a 9. Le compte reste ; la capacité du
 * plus grand véhicule LIBRE le suit.
 */
describe('placesMaxLibres / libelleVehiculesLibres — la taille de ce qui est libre', () => {
  const parc = [
    { id: 'a', seats: 5 },
    { id: 'b', seats: 9 },
    { id: 'c', seats: 7 },
    { id: 'd', seats: null },
  ];

  it('le plus grand parmi les libres, pas parmi tout le parc', () => {
    expect(placesMaxLibres(parc, new Set(['d'])).max).toBe(9);
    expect(placesMaxLibres(parc, new Set(['b', 'd']))).toEqual({ max: 7, inconnus: 0 }); // le 9 places est pris : on ne l'annonce pas
  });

  it('un libre SANS places renseignées est compté à part, pas sauté en silence', () => {
    // Revue du correctif (29/09) : 'd' (seats null) est libre — c'est peut-être le minibus. La borne
    // 9 ne le couvre pas, et la fonction doit le dire.
    expect(placesMaxLibres(parc, new Set())).toEqual({ max: 9, inconnus: 1 });
    expect(placesMaxLibres([{ id: 'x', seats: 0 }, { id: 'y' }, { id: 'z', seats: Number.NaN }], new Set())).toEqual({
      max: null,
      inconnus: 3,
    });
    // Un non renseigné PRIS n'entre pas dans le compte : seuls les libres comptent.
    expect(placesMaxLibres(parc, new Set(['d'])).inconnus).toBe(0);
  });

  it('aucun libre : ni borne ni inconnu', () => {
    expect(placesMaxLibres(parc, new Set(['a', 'b', 'c', 'd']))).toEqual({ max: null, inconnus: 0 });
    expect(placesMaxLibres([], new Set())).toEqual({ max: null, inconnus: 0 });
  });

  it('« 7 / 8 véhicules libres aujourd’hui · jusqu’à 9 places par véhicule » quand tous les libres sont renseignés', () => {
    expect(libelleVehiculesLibres(7, { max: 9, inconnus: 0 }, true)).toBe(
      "véhicules libres aujourd'hui · jusqu'à 9 places par véhicule",
    );
    expect(libelleVehiculesLibres(1, { max: 5, inconnus: 0 }, false)).toBe(
      "véhicule libre ce jour · jusqu'à 5 places par véhicule",
    );
  });

  it('un libre sans places renseignées : la borne est QUALIFIÉE, jamais présentée comme sûre', () => {
    // Le scénario de la revue : 7 libres dont le minibus sans places — celui qui cherche 12 places
    // ne doit pas conclure qu'aucun libre ne convient.
    expect(libelleVehiculesLibres(7, placesMaxLibres(parc, new Set()), true)).toBe(
      "véhicules libres aujourd'hui · jusqu'à 9 places par véhicule, hors 1 sans nombre de places renseigné",
    );
    expect(libelleVehiculesLibres(4, { max: 7, inconnus: 2 }, true)).toBe(
      "véhicules libres aujourd'hui · jusqu'à 7 places par véhicule, hors 2 sans nombre de places renseigné",
    );
    // Aucun libre n'a ses places : on le dit, sans chiffre inventé.
    expect(libelleVehiculesLibres(2, { max: null, inconnus: 2 }, true)).toBe(
      "véhicules libres aujourd'hui · nombre de places non renseigné",
    );
  });

  it('sans véhicule libre, ou sans capacité calculée : le compte seul', () => {
    expect(libelleVehiculesLibres(0, { max: 9, inconnus: 1 }, true)).toBe("véhicule libre aujourd'hui");
    expect(libelleVehiculesLibres(3, null, true)).toBe("véhicules libres aujourd'hui");
    expect(libelleVehiculesLibres(3, { max: null, inconnus: 0 }, true)).toBe("véhicules libres aujourd'hui");
  });
});

/**
 * UNE DEMANDE EN ATTENTE QUE « RÉAFFECTER » REFUSERA À COUP SÛR (quatrième revue du 29/09, C6).
 * Même règle que `motifDemandeNonReaffectable` du serveur — les deux cas de sa spec sont rejoués ici :
 * « lundi → vendredi, immobilisation dès jeudi » (reservations.service.spec « une demande EN ATTENTE
 * qui déborde ») et la simulation T4.
 */
describe('demandeNonReaffectable — le calque web de la règle du serveur', () => {
  const H = 3600_000;
  const MAINTENANT = new Date('2026-09-29T10:00:30').getTime();

  it('une demande en attente qui commence AVANT l’immobilisation et déborde dessus : refusée d’office', () => {
    // Spec serveur : demande à +24 h, immobilisation (aPartirDe) jeudi à +72 h.
    expect(demandeNonReaffectable('REQUESTED', MAINTENANT + 24 * H, MAINTENANT, MAINTENANT + 72 * H)).toBe(true);
  });

  it('une demande en attente déjà commencée : refusée, même si l’immobilisation est déjà en cours', () => {
    expect(demandeNonReaffectable('REQUESTED', MAINTENANT - 2 * H, MAINTENANT, MAINTENANT - 48 * H)).toBe(true);
  });

  it('une demande en attente qui commence APRÈS le début de l’immobilisation : elle se réaffecte en entier', () => {
    expect(demandeNonReaffectable('REQUESTED', MAINTENANT + 80 * H, MAINTENANT, MAINTENANT + 72 * H)).toBe(false);
  });

  it('la coupe est à la minute, comme au serveur : une demande qui commence dans la minute de la coupe passe', () => {
    const coupe = new Date('2026-10-01T08:00:00').getTime();
    expect(demandeNonReaffectable('REQUESTED', coupe + 20_000, MAINTENANT, coupe + 45_000)).toBe(false);
    expect(demandeNonReaffectable('REQUESTED', coupe - 1, MAINTENANT, coupe + 45_000)).toBe(true);
  });

  it('une réservation ferme n’est jamais concernée : elle se scinde', () => {
    for (const status of ['CONFIRMED', 'IN_PROGRESS']) {
      expect(demandeNonReaffectable(status, MAINTENANT + 24 * H, MAINTENANT, MAINTENANT + 72 * H)).toBe(false);
      expect(demandeNonReaffectable(status, MAINTENANT - 2 * H, MAINTENANT, MAINTENANT + 72 * H)).toBe(false);
    }
  });
});

/**
 * LOT LIMITÉ AUX REFUSÉES PUIS DURÉE CHANGÉE (quatrième revue du 29/09, C7) : la réservation refusée,
 * à J+10, sortait de la fenêtre « 7 jours », et le vide disait seulement « reprise ou annulée depuis ».
 */
describe('raisonsVideRefusees / horsFenetrePreset — pourquoi le lot des refusées est vide', () => {
  const PRESET = { from: '2026-10-09T00:00:00.000Z', to: '2026-10-12T21:59:59.000Z' };
  const corps = (over: Partial<{ from: string; to: string; ids: string[]; origine: string; action: string }> = {}) => ({
    ...PRESET, ids: ['r1'], origine: 'toutes', action: 'reaffecter', ...over,
  });

  it('lu sur la période de l’immobilisation : la seule cause est une reprise ou une annulation depuis', () => {
    expect(horsFenetrePreset(corps(), PRESET)).toBe(false);
    expect(raisonsVideRefusees(corps(), PRESET)).toBe('elle a pu être reprise ou annulée depuis.');
  });

  it('⚠️ « 7 jours » cliqué : « hors de la fenêtre choisie » vient EN TÊTE', () => {
    const sept = corps({ from: '2026-09-29T10:00:00.000Z', to: '2026-10-06T10:00:00.000Z' });
    expect(horsFenetrePreset(sept, PRESET)).toBe(true);
    expect(raisonsVideRefusees(sept, PRESET)).toBe(
      "elle est hors de la fenêtre choisie (la période de l'immobilisation la contenait), ou elle a pu être reprise ou annulée depuis.",
    );
  });

  it('au pluriel, et avec les causes propres à l’origine et à l’action', () => {
    const texte = raisonsVideRefusees(
      corps({ from: 'autre', ids: ['r1', 'r2'], origine: 'auto', action: 'annuler' }),
      PRESET,
    );
    expect(texte.startsWith('elles sont hors de la fenêtre choisie (la période de l\'immobilisation les contenait), ou elles ont pu être reprises ou annulées depuis')).toBe(true);
    expect(texte.includes("le filtre « Posées par l'agent » les écarte")).toBe(true);
    expect(texte.includes('commencer avant la fenêtre')).toBe(true);
  });

  it('sans période imposée : la fenêtre peut être en cause, sans parler d’une immobilisation', () => {
    expect(horsFenetrePreset(corps(), null)).toBe(true);
    expect(raisonsVideRefusees(corps(), null)).toBe('elle est hors de la fenêtre choisie, ou elle a pu être reprise ou annulée depuis.');
  });

  /**
   * Cinquième revue du 29/09 (C13) : décidé sur l'égalité des chaînes, « hors de la fenêtre » tombait
   * dès que la fenêtre n'était plus le pré-réglage — « 30 jours » qui CONTIENT la réservation du 10/10
   * la citait en tête, et « Revenir à la période » ramenait au même vide. Désormais sur les DATES des
   * refusées, appariées par id, avec le prédicat du serveur. « Maintenant » est FIXÉ : jamais l'horloge.
   */
  describe('C13 — sur les dates des refusées, pas sur l’égalité des chaînes', () => {
    const MAINTENANT = Date.parse('2026-09-29T10:00:00.000Z');
    const JOUR = 86_400_000;
    const apres = (jours: number) => new Date(MAINTENANT + jours * JOUR).toISOString();
    const R1 = { id: 'r1', startAt: '2026-10-10T08:00:00.000Z', endAt: '2026-10-10T18:00:00.000Z' };
    const trente = corps({ from: apres(0), to: apres(30) });
    const sept = corps({ from: apres(0), to: apres(7) });

    it('⚠️ « 30 jours » qui contient la réservation refusée du 10/10 : pas de clause « hors fenêtre », pas de retour', () => {
      expect(horsFenetrePreset(trente, PRESET, [R1], MAINTENANT)).toBe(false);
      expect(raisonsVideRefusees(trente, PRESET, [R1], MAINTENANT)).toBe('elle a pu être reprise ou annulée depuis.');
    });

    it('« 30 jours » sans aucune date connue : repli par inclusion — la fenêtre couvre la période, pas de clause', () => {
      expect(horsFenetrePreset(trente, PRESET, [], MAINTENANT)).toBe(false);
    });

    it('« 7 jours » qui exclut la réservation du 10/10 : la clause reste en tête (non-régression C7)', () => {
      expect(horsFenetrePreset(sept, PRESET, [R1], MAINTENANT)).toBe(true);
      expect(raisonsVideRefusees(sept, PRESET, [R1], MAINTENANT).startsWith('elle est hors de la fenêtre choisie')).toBe(true);
    });

    it('« 7 jours » qui CONTIENT la refusée du 02/10 (immobilisation 01/10 → 12/10) : pas de clause — l’inclusion seule se tromperait', () => {
      const preset = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-12T21:59:59.000Z' };
      const r = { id: 'r1', startAt: '2026-10-02T08:00:00.000Z', endAt: '2026-10-02T18:00:00.000Z' };
      expect(horsFenetrePreset(sept, preset, [r], MAINTENANT)).toBe(false);
      // Sans la date, la cause reste possible : 7 jours ne couvrent pas toute la période.
      expect(horsFenetrePreset(sept, preset, [], MAINTENANT)).toBe(true);
    });

    it('appariement PAR ID : une refusée sans date (réservation introuvable) ne prend pas les dates d’une autre', () => {
      const deux = corps({ from: apres(0), to: apres(7), ids: ['r0', 'r1'] });
      const r1Dans7 = { id: 'r1', startAt: apres(2), endAt: apres(2.5) };
      // r0 n'a pas de date : repli par inclusion — 7 jours ne couvrent pas la période → possible.
      expect(horsFenetrePreset(deux, PRESET, [r1Dans7], MAINTENANT)).toBe(true);
      // Sixième revue : les deux assertions suivantes DÉPARTAGENT id et position — un appariement par
      // position (`refusees[i]`) les fait échouer, l'assertion d'avant passait avec lui.
      // Une date sans id n'est appariée à rien : r1 reste sans date → repli par inclusion, 7 jours ne
      // couvrent pas la période → possible. Par position, cette date (dans les 7 jours) passerait pour r1.
      expect(horsFenetrePreset(sept, PRESET, [{ startAt: apres(2), endAt: apres(2.5) }], MAINTENANT)).toBe(true);
      // La date d'une AUTRE refusée (r9, hors des 7 jours, dans la période) n'est pas celle de r1 :
      // r1, datée dans les 7 jours, n'est pas écartée par la fenêtre. Par position, r1 prendrait les dates de r9.
      const r9 = { id: 'r9', startAt: R1.startAt, endAt: R1.endAt };
      expect(horsFenetrePreset(sept, PRESET, [r9, r1Dans7], MAINTENANT)).toBe(false);
    });

    it('une refusée qu’aucune des deux fenêtres ne prend (déjà commencée, sous « Annuler ») : pas une affaire de fenêtre', () => {
      const enCours = { id: 'r1', startAt: apres(-1), endAt: apres(1) };
      const annulerSept = corps({ from: apres(0), to: apres(7), action: 'annuler' });
      const preset = { from: apres(-2), to: apres(5) };
      expect(horsFenetrePreset(annulerSept, preset, [enCours], MAINTENANT)).toBe(false);
      // Sous « Réaffecter », elle chevauche les deux fenêtres (scindée) : rien à dire non plus.
      expect(horsFenetrePreset(corps({ from: apres(0), to: apres(7) }), preset, [enCours], MAINTENANT)).toBe(false);
    });

    it('« Annuler » : la refusée commence dans la période mais pas dans la fenêtre lue → clause', () => {
      const r = { id: 'r1', startAt: apres(10), endAt: apres(11) };
      expect(horsFenetrePreset(corps({ from: apres(0), to: apres(7), action: 'annuler' }), { from: apres(9), to: apres(12) }, [r], MAINTENANT)).toBe(true);
    });

    it('sans période imposée mais dates connues : la fenêtre n’est citée que si elle écarte la refusée', () => {
      expect(horsFenetrePreset(trente, null, [R1], MAINTENANT)).toBe(false);
      expect(horsFenetrePreset(sept, null, [R1], MAINTENANT)).toBe(true);
    });
  });

  /**
   * Sixième revue du 29/09 (suite de C13) : « commencer avant la fenêtre » tombait sous Annuler et
   * Décaler SANS condition — même quand les dates de la refusée, connues de la feuille, l'excluent.
   */
  describe('« commencer avant la fenêtre » — seulement si les dates des refusées le permettent', () => {
    const MAINTENANT = Date.parse('2026-09-29T10:00:00.000Z');
    const JOUR = 86_400_000;
    const apres = (jours: number) => new Date(MAINTENANT + jours * JOUR).toISOString();
    const P2 = { from: apres(9), to: apres(12) };
    const CLAUSE = 'commencer avant la fenêtre';

    it('⚠️ « Annuler » sur la période elle-même, la refusée y commence : la reprise ou l’annulation depuis, seule', () => {
      const lu = corps({ ...P2, action: 'annuler' });
      const r1 = { id: 'r1', startAt: apres(10), endAt: apres(11) };
      expect(raisonsVideRefusees(lu, P2, [r1], MAINTENANT)).toBe('elle a pu être reprise ou annulée depuis.');
      // Idem sous « Décaler ».
      expect(raisonsVideRefusees(corps({ ...P2, action: 'decaler' }), P2, [r1], MAINTENANT)).toBe('elle a pu être reprise ou annulée depuis.');
    });

    it('la refusée commence AVANT la fenêtre lue (ou a déjà commencé) : la clause reste', () => {
      const lu = corps({ ...P2, action: 'annuler' });
      expect(raisonsVideRefusees(lu, P2, [{ id: 'r1', startAt: apres(8), endAt: apres(10) }], MAINTENANT).includes(CLAUSE)).toBe(true);
      // Fenêtre dont le début est passé : ramenée à maintenant — une refusée commencée hier en sort.
      const depuisHier = corps({ from: apres(-2), to: apres(3), action: 'annuler' });
      expect(raisonsVideRefusees(depuisHier, depuisHier, [{ id: 'r1', startAt: apres(-1), endAt: apres(1) }], MAINTENANT).includes(CLAUSE)).toBe(true);
    });

    it('sans date connue pour une refusée du lot (ou date illisible, ou date sans id) : la clause reste', () => {
      const lu = corps({ ...P2, action: 'annuler' });
      expect(raisonsVideRefusees(lu, P2, [], MAINTENANT).includes(CLAUSE)).toBe(true);
      expect(raisonsVideRefusees(lu, P2, [{ id: 'r1', startAt: 'illisible', endAt: null }], MAINTENANT).includes(CLAUSE)).toBe(true);
      // Appariement PAR ID : une date sans id, même dans la fenêtre, ne date pas r1.
      expect(raisonsVideRefusees(lu, P2, [{ startAt: apres(10), endAt: apres(11) }], MAINTENANT).includes(CLAUSE)).toBe(true);
      // Deux refusées, une seule datée (dedans) : l'autre peut encore commencer avant.
      const deux = corps({ ...P2, ids: ['r0', 'r1'], action: 'annuler' });
      expect(raisonsVideRefusees(deux, P2, [{ id: 'r1', startAt: apres(10), endAt: apres(11) }], MAINTENANT).includes(CLAUSE)).toBe(true);
    });

    it('jamais sous « Réaffecter » (qui prend ce qui chevauche)', () => {
      expect(raisonsVideRefusees(corps(P2), P2, [{ id: 'r1', startAt: apres(8), endAt: apres(10) }], MAINTENANT).includes(CLAUSE)).toBe(false);
    });
  });
});

describe('dansFenetreReorganisation — le prédicat de lot du serveur (reorganiser)', () => {
  const MAINTENANT = Date.parse('2026-09-29T10:00:00.000Z');
  const H = 3_600_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const fenetre = { from: iso(MAINTENANT - 24 * H), to: iso(MAINTENANT + 48 * H) };

  it('réaffecter : ce qui CHEVAUCHE [max(from, maintenant), to) — une réservation en cours y est', () => {
    expect(dansFenetreReorganisation({ startAt: iso(MAINTENANT - H), endAt: iso(MAINTENANT + H) }, 'reaffecter', fenetre, MAINTENANT)).toBe(true);
    expect(dansFenetreReorganisation({ startAt: iso(MAINTENANT - 3 * H), endAt: iso(MAINTENANT - H) }, 'reaffecter', fenetre, MAINTENANT)).toBe(false);
    expect(dansFenetreReorganisation({ startAt: iso(MAINTENANT + 48 * H), endAt: iso(MAINTENANT + 50 * H) }, 'reaffecter', fenetre, MAINTENANT)).toBe(false);
    // Le serveur écarte une réservation sans fin.
    expect(dansFenetreReorganisation({ startAt: iso(MAINTENANT + H), endAt: null }, 'reaffecter', fenetre, MAINTENANT)).toBe(false);
  });

  it('annuler / décaler : ce qui COMMENCE dedans — une réservation en cours n’y est pas', () => {
    for (const action of ['annuler', 'decaler']) {
      expect(dansFenetreReorganisation({ startAt: iso(MAINTENANT - H), endAt: iso(MAINTENANT + H) }, action, fenetre, MAINTENANT)).toBe(false);
      expect(dansFenetreReorganisation({ startAt: iso(MAINTENANT + H), endAt: iso(MAINTENANT + 2 * H) }, action, fenetre, MAINTENANT)).toBe(true);
    }
  });

  it('indécidable : date illisible, action inconnue ; fenêtre entièrement passée : rien', () => {
    expect(dansFenetreReorganisation({ startAt: 'x', endAt: null }, 'annuler', fenetre, MAINTENANT)).toBe(null);
    expect(dansFenetreReorganisation({ startAt: iso(MAINTENANT + H), endAt: 'x' }, 'reaffecter', fenetre, MAINTENANT)).toBe(null);
    expect(dansFenetreReorganisation({ startAt: iso(MAINTENANT + H), endAt: null }, undefined, fenetre, MAINTENANT)).toBe(null);
    const passee = { from: iso(MAINTENANT - 48 * H), to: iso(MAINTENANT - H) };
    expect(dansFenetreReorganisation({ startAt: iso(MAINTENANT - 2 * H), endAt: iso(MAINTENANT + H) }, 'reaffecter', passee, MAINTENANT)).toBe(false);
  });
});

/**
 * LE NOMBRE NE SUFFIT PAS (quatrième revue du 29/09, C0) : une réservation commencée sortait du lot,
 * une demande du lien public y entrait, 3 = 3 — et la demande était annulée sans avoir été vue.
 * L'application renvoie le lot EXACT de la simulation ; sans lui (ancienne API), le nombre seul.
 */
describe('lotExactDeSimulation — le lot vu, renvoyé tel quel à l’application', () => {
  it('le lot rendu par la simulation, en copie', () => {
    const lotIds = ['r1', 'r2', 'r3'];
    const lot = lotExactDeSimulation({ concernees: 3, lotIds });
    expect(lot).toEqual(['r1', 'r2', 'r3']);
    expect(lot === lotIds).toBe(false); // une copie : le corps envoyé ne partage rien avec la réponse
  });

  it('ancienne API (pas de lotIds) : null — on garde le contrôle par le nombre', () => {
    expect(lotExactDeSimulation({ concernees: 3 })).toBeNull();
    expect(lotExactDeSimulation({ concernees: 3, lotIds: null })).toBeNull();
  });

  it('une liste qui ne décrit pas le lot compté : null, plutôt qu’un 409 à chaque application', () => {
    expect(lotExactDeSimulation({ concernees: 3, lotIds: ['r1', 'r2'] })).toBeNull();
    expect(lotExactDeSimulation({ concernees: 2, lotIds: ['r1', ''] })).toBeNull();
    expect(lotExactDeSimulation({ concernees: 2, lotIds: ['r1', 42] })).toBeNull();
  });

  it('un lot vide reste un lot vide (l’écran n’applique de toute façon rien sans réservation)', () => {
    expect(lotExactDeSimulation({ concernees: 0, lotIds: [] })).toEqual([]);
  });
});
