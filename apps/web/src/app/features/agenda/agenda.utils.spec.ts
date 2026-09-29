import { registerLocaleData } from '@angular/common';
import localeFr from '@angular/common/locales/fr';
import type { VehicleEventType } from '@vizyo/tracky-shared';
import {
  compteAgentMemorise,
  compteDeLaListe,
  dansFenetreReorganisation,
  demandeNonReaffectable,
  dureeEnJours,
  estUneEcheance,
  type EtatIaAgenda,
  eventTypeLabel,
  fenetreAReorganiser,
  fenetreImmobilisation,
  fenetresAjoutees,
  horsFenetrePreset,
  HORIZON_SANS_FIN_MS,
  interrupteurSociete,
  joursDansFenetre,
  libellePeriode,
  libelleVehiculesLibres,
  lotExactDeSimulation,
  memeVisibiliteIa,
  menuReorganiser,
  memoriserCompteAgent,
  ongletPropositionsVisible,
  origineAgentVisible,
  placesMaxLibres,
  propositionsDuPerimetre,
  propositionsParJour,
  propositionsSurPeriode,
  quoiALOuverture,
  raisonsVideRefusees,
  rangDuJour,
  repliDefinitif,
  rienAReorganiser,
  startOfMonth,
  startOfWeekMonday,
  visibiliteIa,
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
 * IA DÉSACTIVÉE PAR LE CLIENT (29/09) — « c'est le client qui désactive, donc on enlève les
 * suggestions ». L'agenda lisait et montrait les propositions de l'agent quel que soit l'état de
 * l'IA (pointillés, légende, panneau du jour, badge), et l'onglet « Assistant IA » restait tant
 * qu'il en restait. La règle : l'interrupteur de la SOCIÉTÉ (`interrupteurSociete`, pas la clé API
 * du serveur), pour un statut chargé ET de la société du bandeau.
 */
describe('visibiliteIa — ce que l’agenda montre de l’IA', () => {
  const TOUTES = { capacity: true, agendaAgent: true, placement: true };
  const AUCUNE = { capacity: false, agendaAgent: false, placement: false };
  const etat = (over: Partial<EtatIaAgenda> = {}): EtatIaAgenda => ({
    statutCharge: true,
    interrupteur: true,
    canOptimize: true,
    fonctions: TOUTES,
    nbPropositions: 0,
    propositionsChargees: true,
    ...over,
  });

  it('IA active : propositions et onglet, comme avant', () => {
    expect(visibiliteIa(etat())).toEqual({ iaActive: true, propositions: true, vueIa: true, decide: true });
  });

  it('⚠️ IA coupée par le client : ni propositions ni onglet — même avec 12 propositions de l’agent en mémoire', () => {
    const v = visibiliteIa(etat({ interrupteur: false, fonctions: AUCUNE, nbPropositions: 12 }));
    expect(v.iaActive).toBe(false);
    expect(v.propositions).toBe(false);
    expect(v.vueIa).toBe(false);
  });

  it('⚠️ IA chargée ET coupée : le repli d’une vue « ia » est définitif tout de suite, sans attendre de propositions', () => {
    // Les propositions ne sont plus lues quand l'IA est coupée : les attendre figerait la demande.
    expect(visibiliteIa(etat({ interrupteur: false, fonctions: AUCUNE, propositionsChargees: false })).decide).toBe(true);
  });

  it('statut pas encore chargé (démarrage, changement de société) : rien d’IA, et l’on attend', () => {
    // L'interrupteur lu à ce moment est celui de l'ANCIENNE société : il ne compte pas.
    expect(visibiliteIa(etat({ statutCharge: false, nbPropositions: 3 }))).toEqual({
      iaActive: false,
      propositions: false,
      vueIa: false,
      decide: false,
    });
  });

  it('IA active, propositions pas encore lues : elles peuvent encore ouvrir l’onglet — on attend (S2)', () => {
    const avant = visibiliteIa(etat({ fonctions: AUCUNE, propositionsChargees: false }));
    expect(avant.vueIa).toBe(false);
    expect(avant.decide).toBe(false);
    // … et, lues, elles l'ouvrent.
    expect(visibiliteIa(etat({ fonctions: AUCUNE, nbPropositions: 2 })).vueIa).toBe(true);
  });

  it('IA active sans fonction ouverte ni proposition : pas d’onglet, et c’est définitif', () => {
    expect(visibiliteIa(etat({ fonctions: AUCUNE }))).toEqual({ iaActive: true, propositions: true, vueIa: false, decide: true });
  });

  it('une seule fonction ouverte suffit à l’onglet', () => {
    expect(visibiliteIa(etat({ fonctions: { ...AUCUNE, placement: true } })).vueIa).toBe(true);
    expect(visibiliteIa(etat({ fonctions: { ...AUCUNE, capacity: true } })).vueIa).toBe(true);
    expect(visibiliteIa(etat({ fonctions: { ...AUCUNE, agendaAgent: true } })).vueIa).toBe(true);
  });

  it('sans le droit « Voir les réservations » : ni propositions ni onglet, IA active ou non (inchangé)', () => {
    const v = visibiliteIa(etat({ canOptimize: false, nbPropositions: 4, propositionsChargees: false }));
    expect(v.iaActive).toBe(true);
    expect(v.propositions).toBe(false);
    expect(v.vueIa).toBe(false);
    expect(v.decide).toBe(true);
  });

  it('⚠️ interrupteur de la société pas encore connu (serveur sans clé, réglage brut en lecture) : rien d’IA, et l’on attend', () => {
    expect(visibiliteIa(etat({ interrupteur: null, nbPropositions: 5 }))).toEqual({ iaActive: false, propositions: false, vueIa: false, decide: false });
  });

  it('⚠️ revue du 29/09 — la démo (aucune clé API, IA de la société ACTIVE) : les propositions se montrent, l’onglet aussi', () => {
    // Avant la revue, interrupteur = enabled() = faux sans clé : tout disparaissait, alors que le client
    // n'avait rien coupé (453 propositions déterministes préparées sans clé à la recette du 28/09).
    const interrupteur = interrupteurSociete({ configured: false, enabled: false }, true);
    expect(visibiliteIa(etat({ interrupteur, fonctions: AUCUNE, nbPropositions: 453 }))).toEqual({
      iaActive: true,
      propositions: true,
      vueIa: true,
      decide: true,
    });
    // … et la même démo, IA coupée par le client : rien.
    const coupee = interrupteurSociete({ configured: false, enabled: false }, false);
    expect(visibiliteIa(etat({ interrupteur: coupee, fonctions: AUCUNE, nbPropositions: 453 })).propositions).toBe(false);
  });

  /**
   * Revue du 29/09 : un super-admin sur l'Assistant IA de A (équipée) passe sur B (équipée aussi). Le
   * statut de A ne comptait plus, celui de B n'était pas arrivé, et « pas connu » valait « coupée » :
   * la vue se démontait, le Calendrier et son chargement s'affichaient, puis tout revenait.
   */
  describe('relecture de la société : une attente n’est pas une coupure', () => {
    const EQUIPEE = { iaActive: true, propositions: true, vueIa: true, decide: true };

    it('A équipée → B pas encore lue : onglet et pastille gardés ; propositions ni lues ni montrées ; rien de tranché', () => {
      expect(visibiliteIa(etat({ statutCharge: false }), EQUIPEE)).toEqual({ iaActive: true, propositions: false, vueIa: true, decide: false });
      // Serveur sans clé : le statut de B est là, son réglage brut encore en lecture — pareil.
      expect(visibiliteIa(etat({ interrupteur: null }), EQUIPEE)).toEqual({ iaActive: true, propositions: false, vueIa: true, decide: false });
    });

    it('… puis B arrive COUPÉE : tout part, et c’est tranché (le ?vue=ia retombe pour de bon)', () => {
      const pendant = visibiliteIa(etat({ statutCharge: false }), EQUIPEE);
      expect(visibiliteIa(etat({ interrupteur: false, fonctions: AUCUNE }), pendant)).toEqual({
        iaActive: false,
        propositions: false,
        vueIa: false,
        decide: true,
      });
    });

    it('… ou B arrive équipée sans fonction ouverte : l’onglet reste pendant la lecture de ses propositions', () => {
      const pendant = visibiliteIa(etat({ statutCharge: false }), EQUIPEE);
      const lecture = visibiliteIa(etat({ fonctions: AUCUNE, propositionsChargees: false }), pendant);
      expect(lecture).toEqual({ iaActive: true, propositions: true, vueIa: true, decide: false });
      // Lues : aucune → l'onglet part, pour de bon ; sinon il reste.
      expect(visibiliteIa(etat({ fonctions: AUCUNE }), lecture)).toEqual({ iaActive: true, propositions: true, vueIa: false, decide: true });
      expect(visibiliteIa(etat({ fonctions: AUCUNE, nbPropositions: 7 }), lecture).vueIa).toBe(true);
    });

    it('A sans IA → B pas encore lue : rien d’IA ne s’allume pendant l’attente', () => {
      const a = visibiliteIa(etat({ interrupteur: false, fonctions: AUCUNE }));
      expect(visibiliteIa(etat({ statutCharge: false }), a)).toEqual({ iaActive: false, propositions: false, vueIa: false, decide: false });
    });

    it('l’attente garde, elle ne retarde jamais : une fonction ouverte montre l’onglet tout de suite', () => {
      const sansOnglet = visibiliteIa(etat({ interrupteur: false, fonctions: AUCUNE }));
      expect(visibiliteIa(etat({ propositionsChargees: false }), sansOnglet).vueIa).toBe(true);
    });

    it('au démarrage (aucune visibilité d’avant) : rien d’IA avant confirmation — opt-in inchangé', () => {
      expect(visibiliteIa(etat({ statutCharge: false }), null)).toEqual({ iaActive: false, propositions: false, vueIa: false, decide: false });
    });
  });

  it('memeVisibiliteIa : les quatre drapeaux, et rien d’autre', () => {
    const v = { iaActive: true, propositions: false, vueIa: true, decide: false };
    expect(memeVisibiliteIa(v, { ...v })).toBe(true);
    expect(memeVisibiliteIa(v, { ...v, decide: true })).toBe(false);
    expect(memeVisibiliteIa(v, { ...v, iaActive: false })).toBe(false);
    expect(memeVisibiliteIa(v, { ...v, propositions: true })).toBe(false);
    expect(memeVisibiliteIa(v, { ...v, vueIa: false })).toBe(false);
  });
});

/**
 * REVUE DU 29/09 — `AiStatusDto.enabled` exige AUSSI une clé API au serveur (`isEnabledForFleet`) :
 * sur la démo (clés vides, `aiEnabled: true`), il vaut faux alors que le client n'a rien coupé.
 */
describe('interrupteurSociete — l’interrupteur de la société, pas « une clé API et l’interrupteur »', () => {
  it('serveur AVEC clé : enabled EST l’interrupteur — le réglage brut ne compte pas', () => {
    expect(interrupteurSociete({ configured: true, enabled: true }, null)).toBe(true);
    expect(interrupteurSociete({ configured: true, enabled: false }, null)).toBe(false);
    expect(interrupteurSociete({ configured: true, enabled: false }, true)).toBe(false);
    expect(interrupteurSociete({ configured: true, enabled: true }, 'illisible')).toBe(true);
  });

  it('⚠️ serveur SANS clé : enabled vaut faux quoi qu’ait choisi le client — le réglage brut décide', () => {
    expect(interrupteurSociete({ configured: false, enabled: false }, true)).toBe(true);
    expect(interrupteurSociete({ configured: false, enabled: false }, false)).toBe(false);
  });

  it('serveur sans clé, réglage en lecture : inconnu — on attend', () => {
    expect(interrupteurSociete({ configured: false, enabled: false }, null)).toBeNull();
  });

  it('serveur sans clé, réglage illisible (rôle sans accès, super-admin sans société, échec) : coupée — opt-in', () => {
    expect(interrupteurSociete({ configured: false, enabled: false }, 'illisible')).toBe(false);
  });

  // 29/09 — le statut porte le choix du client (`fleetEnabled`) : il décide, avec ou sans clé, et
  // quoi que dise un réglage brut relu (qui n'est plus nécessaire).
  it('`fleetEnabled` présent : c’est lui qui décide, avec ou sans clé', () => {
    expect(interrupteurSociete({ configured: false, enabled: false, fleetEnabled: true }, null)).toBe(true);
    expect(interrupteurSociete({ configured: true, enabled: true, fleetEnabled: false }, true)).toBe(false);
    expect(interrupteurSociete({ configured: true, enabled: false, fleetEnabled: true }, 'illisible')).toBe(true);
  });
});

/**
 * LES PILULES POINTILLÉES DE LA GRILLE (29/09) : le câblage que la page passe au calendrier —
 * `proposalsByDay` = `propositionsParJour(propositionsDuPerimetre(...))`. IA coupée, la carte est
 * vide : ni pilule « N proposés », ni point creux sur téléphone.
 */
describe('propositionsDuPerimetre / propositionsParJour — les propositions que la page montre', () => {
  const P = [
    { id: 'p1', vehicleId: 'v1', startAt: '2026-10-05T07:00:00' },
    { id: 'p2', vehicleId: 'v1', startAt: '2026-10-05T16:30:00' },
    { id: 'p3', vehicleId: 'v2', startAt: '2026-10-06T07:00:00' },
    { id: 'p4', vehicleId: 'v3', startAt: '2026-10-06T08:00:00' },
  ];
  const TOUT = { vehicleId: '', vehiculesDuGroupe: null };

  it('⚠️ propositions non visibles (IA coupée) : aucune, donc aucune pilule — même si la liste n’est pas encore vidée', () => {
    expect(propositionsDuPerimetre(P, false, TOUT)).toEqual([]);
    expect(propositionsParJour(propositionsDuPerimetre(P, false, TOUT)).size).toBe(0);
    expect(propositionsDuPerimetre(P, false, { vehicleId: 'v1', vehiculesDuGroupe: new Set(['v1']) })).toEqual([]);
  });

  it('visibles : toutes sans filtre, puis le périmètre de la grille (véhicule, groupe)', () => {
    expect(propositionsDuPerimetre(P, true, TOUT).map((p) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(propositionsDuPerimetre(P, true, { vehicleId: 'v1', vehiculesDuGroupe: null }).map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(propositionsDuPerimetre(P, true, { vehicleId: '', vehiculesDuGroupe: new Set(['v2', 'v3']) }).map((p) => p.id)).toEqual(['p3', 'p4']);
  });

  it('compte les propositions, pas les véhicules : deux tournées du même véhicule le même jour font 2', () => {
    const parJour = propositionsParJour(propositionsDuPerimetre(P, true, TOUT));
    expect(parJour.get('2026-10-05')).toBe(2);
    expect(parJour.get('2026-10-06')).toBe(2);
    expect(parJour.size).toBe(2);
  });

  it('une date illisible ne pose rien', () => {
    expect(propositionsParJour([{ startAt: 'pas une date' }, { startAt: '2026-10-07T09:00:00' }])).toEqual(new Map([['2026-10-07', 1]]));
  });
});

/**
 * RÉORGANISER, IA COUPÉE (29/09) : « Posées par l'agent » n'est plus un geste de l'agent mais un
 * filtre sur de vraies réservations — il reste s'il en compte, disparaît à 0.
 */
describe('origineAgentVisible — le bouton « Posées par l’agent » de Réorganiser', () => {
  it('IA active : toujours là, compte connu ou non (inchangé)', () => {
    expect(origineAgentVisible({ iaActive: true, compteAgent: 0, selectionnee: false })).toBe(true);
    expect(origineAgentVisible({ iaActive: true, compteAgent: null, selectionnee: false })).toBe(true);
  });

  it('⚠️ IA coupée et aucune réservation de l’agent : masqué', () => {
    expect(origineAgentVisible({ iaActive: false, compteAgent: 0, selectionnee: false })).toBe(false);
  });

  it('IA coupée, compte jamais connu pour cette société (première simulation en vol) : masqué', () => {
    expect(origineAgentVisible({ iaActive: false, compteAgent: null, selectionnee: false })).toBe(false);
  });

  it('IA coupée mais des réservations posées par l’agent : gardé — c’est un filtre sur de vraies réservations', () => {
    expect(origineAgentVisible({ iaActive: false, compteAgent: 3, selectionnee: false })).toBe(true);
  });

  it('sélectionné : jamais retiré sous le doigt, même à 0', () => {
    expect(origineAgentVisible({ iaActive: false, compteAgent: 0, selectionnee: true })).toBe(true);
    expect(origineAgentVisible({ iaActive: false, compteAgent: null, selectionnee: true })).toBe(true);
  });
});

/**
 * REVUE DU 29/09 — le compte qui décide de « Posées par l'agent » (IA coupée) était celui de la
 * simulation AFFICHÉE : inconnu à chaque ouverture et après une erreur, celui du véhicule sinon. Le
 * bouton surgissait au retour de la première simulation et disparaissait sur une erreur.
 */
describe('memoriserCompteAgent / compteAgentMemorise — le compte de la société, gardé', () => {
  const totaux = (agent: number) => ({ totaux: { agent, public: 1, manuelle: 2 } });

  it('une simulation réussie le pose pour SA société ; la suivante le remplace, 0 compris', () => {
    const m = memoriserCompteAgent(null, 'cdef31', totaux(430));
    expect(m).toEqual({ societe: 'cdef31', n: 430 });
    expect(memoriserCompteAgent(m, 'cdef31', totaux(0))).toEqual({ societe: 'cdef31', n: 0 });
  });

  it('⚠️ une réponse sans totaux (API antérieure) ne l’efface pas', () => {
    const m = { societe: 'cdef31', n: 430 };
    expect(memoriserCompteAgent(m, 'cdef31', {})).toBe(m);
    expect(memoriserCompteAgent(m, 'cdef31', { totaux: null })).toBe(m);
  });

  it('lu pour la société du bandeau seulement : celui d’une autre est inconnu', () => {
    expect(compteAgentMemorise({ societe: 'cdef31', n: 4 }, 'cdef31')).toBe(4);
    expect(compteAgentMemorise({ societe: 'cdef31', n: 4 }, 'client-test')).toBeNull();
    expect(compteAgentMemorise(null, 'cdef31')).toBeNull();
    expect(compteAgentMemorise({ societe: null, n: 2 }, null)).toBe(2);
  });

  it('⚠️ réouverture, IA coupée : le bouton est là DÈS l’ouverture — la feuille n’a encore rien relu, la mémoire sait', () => {
    const memo = memoriserCompteAgent(null, 'cdef31', totaux(430));
    expect(origineAgentVisible({ iaActive: false, compteAgent: compteAgentMemorise(memo, 'cdef31'), selectionnee: false })).toBe(true);
    // Une société sans aucune réservation de l'agent : jamais de bouton, pas même un instant.
    const vide = memoriserCompteAgent(null, 'client-test', totaux(0));
    expect(origineAgentVisible({ iaActive: false, compteAgent: compteAgentMemorise(vide, 'client-test'), selectionnee: false })).toBe(false);
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

/**
 * « RIEN À RÉORGANISER » (29/09, piste 1 du propriétaire). Chez cdef31 : 0 réservation à venir, 317
 * propositions de l'agent — la feuille alignait 30 véhicules à « (0) » et ne le disait qu'en bas.
 */
describe('rienAReorganiser — la feuille dit d’emblée qu’il n’y a rien', () => {
  const simulation = (over: Partial<NonNullable<Parameters<typeof rienAReorganiser>[0]['lecture']>> = {}) => ({
    simulation: true,
    origine: 'toutes',
    avecVehicule: false,
    avecListeBlanche: false,
    jours: 30,
    chevauchantes: 0,
    ...over,
  });

  it('avant toute simulation : le compte du menu décide (0 → l’explication tout de suite, sans clignoter)', () => {
    expect(rienAReorganiser({ ouverteDepuisUnGeste: false, lecture: null, compteMenu: 0 })).toBe(true);
    expect(rienAReorganiser({ ouverteDepuisUnGeste: false, lecture: null, compteMenu: 3 })).toBe(false);
    expect(rienAReorganiser({ ouverteDepuisUnGeste: false, lecture: null, compteMenu: null })).toBe(false);
  });

  it('simulation « Toutes » sur 30 jours sans rien qui chevauche : rien — même si le compte du menu était périmé', () => {
    expect(rienAReorganiser({ ouverteDepuisUnGeste: false, lecture: simulation(), compteMenu: null })).toBe(true);
    expect(rienAReorganiser({ ouverteDepuisUnGeste: false, lecture: simulation(), compteMenu: 2 })).toBe(true);
  });

  it('une réservation qui chevauche (même en cours) : il y a quelque chose — le compte périmé du menu ne l’efface pas', () => {
    expect(rienAReorganiser({ ouverteDepuisUnGeste: false, lecture: simulation({ chevauchantes: 1 }), compteMenu: 0 })).toBe(false);
  });

  it('fenêtre plus courte vide : « rien » seulement si les 30 jours le sont aussi (compte du menu)', () => {
    expect(rienAReorganiser({ ouverteDepuisUnGeste: false, lecture: simulation({ jours: 7 }), compteMenu: 4 })).toBe(false);
    expect(rienAReorganiser({ ouverteDepuisUnGeste: false, lecture: simulation({ jours: 7 }), compteMenu: 0 })).toBe(true);
    expect(rienAReorganiser({ ouverteDepuisUnGeste: false, lecture: simulation({ jours: 7 }), compteMenu: null })).toBe(false);
  });

  it('une lecture filtrée (agent seul, un véhicule, liste blanche) ne dit rien de toute la société', () => {
    for (const over of [{ origine: 'auto' }, { avecVehicule: true }, { avecListeBlanche: true }]) {
      expect(rienAReorganiser({ ouverteDepuisUnGeste: false, lecture: simulation(over), compteMenu: 0 })).toBe(false);
    }
  });

  it('ouverte depuis un geste (véhicule, période, refusées) : jamais — son vide a ses propres mots', () => {
    expect(rienAReorganiser({ ouverteDepuisUnGeste: true, lecture: null, compteMenu: 0 })).toBe(false);
    expect(rienAReorganiser({ ouverteDepuisUnGeste: true, lecture: simulation(), compteMenu: 0 })).toBe(false);
  });

  it('le compte-rendu d’une application n’est jamais remplacé par « rien »', () => {
    expect(rienAReorganiser({ ouverteDepuisUnGeste: false, lecture: simulation({ simulation: false }), compteMenu: 0 })).toBe(false);
  });
});

describe('Réorganiser agit aussi sur les propositions de l’agent (29/09, piste 3)', () => {
  describe('menuReorganiser — l’entrée du menu « ⋯ »', () => {
    const menu = (over: Partial<Parameters<typeof menuReorganiser>[0]> = {}) =>
      menuReorganiser({ reservations: 0, jours: 30, iaActive: true, propositions: 0, ...over });

    it('cdef31 le 29/09 : aucune réservation, 307 propositions → ACTIVE, et elle dit ce qu’elle trouvera', () => {
      expect(menu({ propositions: 307 })).toEqual({ grisee: false, ligne: "Aucune réservation à venir · 307 propositions de l'agent" });
      expect(menu({ propositions: 1 }).ligne).toBe("Aucune réservation à venir · 1 proposition de l'agent");
    });

    it('ni réservation ni proposition : grisée, et la raison les nomme toutes les deux', () => {
      expect(menu()).toEqual({ grisee: true, ligne: "Aucune réservation à venir sur 30 jours, ni proposition de l'agent" });
    });

    it('IA coupée par le client : les propositions ne comptent pas, et l’agent n’est pas nommé', () => {
      expect(menu({ iaActive: false, propositions: 307 })).toEqual({ grisee: true, ligne: 'Aucune réservation à venir sur 30 jours' });
    });

    it('des réservations, ou un compte inconnu : active, sans ligne', () => {
      expect(menu({ reservations: 3, propositions: 307 })).toEqual({ grisee: false, ligne: null });
      expect(menu({ reservations: null })).toEqual({ grisee: false, ligne: null });
    });
  });

  describe('quoiALOuverture — la feuille s’ouvre sur ce qu’il y a', () => {
    const quoi = (over: Partial<Parameters<typeof quoiALOuverture>[0]> = {}) =>
      quoiALOuverture({ ouverteDepuisUnGeste: false, reservations: 0, iaActive: true, propositions: 307, ...over });

    it('rien que des propositions : sur les propositions', () => {
      expect(quoi()).toBe('propositions');
    });

    it('des réservations, un compte inconnu, IA coupée, aucune proposition : sur les réservations', () => {
      expect(quoi({ reservations: 2 })).toBe('reservations');
      expect(quoi({ reservations: null })).toBe('reservations');
      expect(quoi({ iaActive: false })).toBe('reservations');
      expect(quoi({ propositions: 0 })).toBe('reservations');
    });

    it('ouverte depuis un geste (réservations refusées à reprendre) : sur les réservations', () => {
      expect(quoi({ ouverteDepuisUnGeste: true })).toBe('reservations');
    });
  });

  describe('ongletPropositionsVisible — l’onglet « Propositions de l’agent »', () => {
    const onglet = (over: Partial<Parameters<typeof ongletPropositionsVisible>[0]> = {}) =>
      ongletPropositionsVisible({ iaActive: true, sansSociete: false, quoi: 'reservations', propositionsPage: 0, propositionsListe: null, ...over });

    it('IA coupée, ou super-admin sans société : jamais', () => {
      expect(onglet({ iaActive: false, propositionsPage: 5, quoi: 'propositions' })).toBe(false);
      expect(onglet({ sansSociete: true, propositionsPage: 5 })).toBe(false);
    });

    it('des propositions dans la page ou dans la liste de la feuille : visible', () => {
      expect(onglet({ propositionsPage: 5 })).toBe(true);
      expect(onglet({ propositionsListe: 2 })).toBe(true);
    });

    it('aucune proposition nulle part : caché — sauf si l’on y est (la page vient de les écarter toutes)', () => {
      expect(onglet({ propositionsListe: 0 })).toBe(false);
      expect(onglet({ quoi: 'propositions', propositionsListe: 0 })).toBe(true);
    });
  });

  it('compteDeLaListe : le véhicule choisi (0 s’il n’y est pas), sinon le total ; inconnu = null', () => {
    const liste = [{ vehicleId: 'v1', n: 2 }, { vehicleId: 'v2', n: 5 }];
    expect(compteDeLaListe(liste, '')).toBe(7);
    expect(compteDeLaListe(liste, 'v2')).toBe(5);
    expect(compteDeLaListe(liste, 'v9')).toBe(0);
    expect(compteDeLaListe(null, 'v1')).toBeNull();
  });

  describe('propositionsSurPeriode — un véhicule part au garage', () => {
    const H = 3_600_000;
    const maintenant = Date.UTC(2026, 9, 1, 8, 0);
    const prop = (vehicleId: string, hDebut: number, hFin: number) => ({
      vehicleId, startAt: new Date(maintenant + hDebut * H).toISOString(), endAt: new Date(maintenant + hFin * H).toISOString(),
    });
    const periode = { from: maintenant + 48 * H, to: maintenant + 72 * H };

    it('celles du véhicule qui chevauchent la période — y compris celle qui déborde sur son début', () => {
      const liste = [prop('v1', 50, 53), prop('v1', 46, 50), prop('v1', 70, 75), prop('v2', 50, 53)];
      expect(propositionsSurPeriode(liste, 'v1', periode, maintenant)).toBe(3);
    });

    it('ni avant, ni après, ni un autre véhicule', () => {
      const liste = [prop('v1', 40, 48), prop('v1', 72, 75), prop('v2', 50, 53)];
      expect(propositionsSurPeriode(liste, 'v1', periode, maintenant)).toBe(0);
    });

    it('une proposition déjà commencée ne compte pas (elle ne se réserve plus) — comme le serveur', () => {
      const enCours = { from: maintenant - 2 * H, to: maintenant + 5 * H };
      expect(propositionsSurPeriode([prop('v1', -1, 2), prop('v1', 1, 3)], 'v1', enCours, maintenant)).toBe(1);
    });
  });
});

describe('libellePeriode — la période d’un pré-réglage en toutes lettres (recette démo du 29/09)', () => {
  beforeAll(() => registerLocaleData(localeFr));
  const iso = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).toISOString();
  const maintenant = new Date(2026, 8, 29, 19, 50).getTime(); // mar. 29 sept., 19:50 (heure locale)

  it('une journée entière (00:00 → 00:00 le lendemain) : « le mer. 30 sept. », pas « du 30 au 1er »', () => {
    expect(libellePeriode({ from: iso(2026, 9, 30), to: iso(2026, 10, 1), sansFin: false }, maintenant, 30)).toBe('le mer. 30 sept.');
  });

  it('plusieurs journées entières : la fin à minuit compte pour la veille', () => {
    expect(libellePeriode({ from: iso(2026, 9, 30), to: iso(2026, 10, 2), sansFin: false }, maintenant, 30)).toBe('du mer. 30 sept. au jeu. 1 oct.');
  });

  it('dans une journée : les heures ; déjà commencée, le début est ramené à maintenant (et minuit se dit 24:00)', () => {
    expect(libellePeriode({ from: iso(2026, 9, 30, 8), to: iso(2026, 9, 30, 12, 30), sansFin: false }, maintenant, 30)).toBe('le mer. 30 sept. de 08:00 à 12:30');
    expect(libellePeriode({ from: iso(2026, 9, 29), to: iso(2026, 9, 30), sansFin: false }, maintenant, 30)).toBe('le mar. 29 sept. de 19:50 à 24:00');
  });

  it('une fin qui n’est pas à minuit (retour le 2, 23:59:59) : telle quelle', () => {
    expect(
      libellePeriode({ from: iso(2026, 9, 30), to: new Date(2026, 9, 2, 23, 59, 59).toISOString(), sansFin: false }, maintenant, 30),
    ).toBe('du mer. 30 sept. au ven. 2 oct.');
  });

  it('sans date de fin : « à partir du …, HH:mm (30 jours) »', () => {
    expect(libellePeriode({ from: iso(2026, 10, 2, 9), to: iso(2026, 11, 1, 9), sansFin: true }, maintenant, 30)).toBe('à partir du ven. 2 oct., 09:00 (30 jours)');
  });
});
