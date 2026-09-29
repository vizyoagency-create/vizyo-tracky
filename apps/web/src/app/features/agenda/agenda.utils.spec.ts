import type { VehicleEventType } from '@vizyo/tracky-shared';
import {
  dureeEnJours,
  estUneEcheance,
  eventTypeLabel,
  fenetreAReorganiser,
  fenetreImmobilisation,
  fenetresAjoutees,
  HORIZON_SANS_FIN_MS,
  joursDansFenetre,
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
