/**
 * Lot V6 — LES SENTINELLES DE COHÉRENCE.
 *
 * Ce que ces tests protègent, et c'est le cœur du lot : une sentinelle doit crier quand le
 * compte n'y est pas, et se TAIRE le reste du temps. Les deux moitiés comptent autant. Un
 * instrument qui crie tous les jours ne se lit plus — et c'est exactement ainsi qu'on a laissé
 * passer, pendant des mois, une chaîne d'alerte qui n'existait pas.
 *
 * D'où le témoin systématique : chaque scénario « elle se tait » est doublé d'un scénario
 * « la MÊME fixture, un fait en plus, elle parle ». Sans ce couple, un test vert ne prouverait
 * rien — juste que la fixture ne déclenche jamais.
 */
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { ErrorLogger } from './error-logger.service';
import { RefroidissementAlerteService } from './refroidissement-alerte.service';
import { SentinellesCoherenceService } from './sentinelles-coherence.service';

const MAINTENANT = new Date('2026-09-04T06:30:00.000Z');
const ilYa = (heures: number) => new Date(MAINTENANT.getTime() - heures * 3_600_000);

const FLOTTE = { id: 'f1', name: 'MH Cars' };

const flotteReglee = (patch: Record<string, unknown> = {}) => ({
  ...FLOTTE,
  speedAlertEnabled: true,
  speedAlertOverKmh: 20,
  speedAlertAbsoluteKmh: 130,
  speedAlertUpdatedAt: ilYa(72),
  ...patch,
});

const segment = (over: number, limit = 90) => ({
  startAt: '2026-09-04T04:00:00.000Z', endAt: '2026-09-04T04:00:45.000Z', durationSec: 45,
  maxSpeedKmh: limit + over, limitKmh: limit, overKmh: over, lat: 43.6, lng: 1.4,
});

const analyse = (patch: Record<string, unknown> = {}) => ({
  tripId: 't1', fleetId: 'f1', vehicleId: 'v1', computedAt: ilYa(2),
  maxSpeedKmh: 125, speedingCount: 1, limitsCoverage: 0.9,
  detail: { speeding: [segment(35)] },
  ...patch,
});

const trajet = (patch: Record<string, unknown> = {}) => ({
  id: 't1', startedAt: ilYa(5), endedAt: ilYa(4), ...patch,
});

interface Monde {
  flottes?: Record<string, unknown>[];
  analyses?: Record<string, unknown>[];
  trajets?: Record<string, unknown>[];
  vehicules?: Record<string, unknown>[];
  alertesSurTrajets?: { tripId: string }[];
  livraisonsSansAppareil?: { userId: string; _count: { _all: number } }[];
  comptes?: { id: string; email: string }[];
  alertesNonAcquittees?: { fleetId: string; _count: { _all: number } }[];
  /**
   * TRK-064 — nombre de sociétés EXISTANTES, indépendamment de leur réglage d'alerte.
   * Par défaut 0 : une fixture qui ne parle pas de sociétés décrit une plateforme vide, où
   * il n'y a rien à armer — donc rien à signaler.
   */
  flottesExistantes?: number;
  /** Refroidissement : `false` = la garde refuse l'émission. */
  emissionAutorisee?: boolean;
}

function setup(monde: Monde = {}) {
  const prisma = {
    fleet: {
      findMany: jest.fn().mockResolvedValue(monde.flottes ?? []),
      findUnique: jest.fn().mockResolvedValue({ name: FLOTTE.name }),
      count: jest.fn().mockResolvedValue(monde.flottesExistantes ?? 0),
    },
    tripAnalysis: { findMany: jest.fn().mockResolvedValue(monde.analyses ?? []) },
    trip: { findMany: jest.fn().mockResolvedValue(monde.trajets ?? []) },
    vehicle: {
      findMany: jest.fn().mockResolvedValue(
        monde.vehicules ?? [{ id: 'v1', plate: 'AB-123-CD', speedAlertEnabled: null, speedAlertOverKmh: null }],
      ),
    },
    alert: {
      findMany: jest.fn().mockResolvedValue(monde.alertesSurTrajets ?? []),
      groupBy: jest.fn().mockResolvedValue(monde.alertesNonAcquittees ?? []),
    },
    notificationDelivery: { groupBy: jest.fn().mockResolvedValue(monde.livraisonsSansAppareil ?? []) },
    user: { findMany: jest.fn().mockResolvedValue(monde.comptes ?? []) },
  };
  const errorLogger = { record: jest.fn().mockResolvedValue('ok'), recordBackground: jest.fn() };
  const refroidissement = {
    tenterEmission: jest.fn().mockResolvedValue(monde.emissionAutorisee ?? true),
  };
  return { prisma, errorLogger, refroidissement };
}

async function service(monde: Monde = {}) {
  const t = setup(monde);
  const module = await Test.createTestingModule({
    providers: [
      SentinellesCoherenceService,
      { provide: PrismaService, useValue: t.prisma },
      { provide: ErrorLogger, useValue: t.errorLogger },
      { provide: RefroidissementAlerteService, useValue: t.refroidissement },
    ],
  }).compile();
  return { svc: module.get(SentinellesCoherenceService), ...t };
}

/** Les messages réellement écrits au centre d'alerte. */
function messages(errorLogger: { record: jest.Mock }): string[] {
  return errorLogger.record.mock.calls.map((c) => String(c[0]));
}

describe('Sentinelle — un excès sans son alerte', () => {
  const monde = (patch: Monde = {}): Monde => ({
    flottes: [flotteReglee()],
    analyses: [analyse()],
    trajets: [trajet()],
    ...patch,
  });

  it('crie quand un trajet aurait dû alerter et ne l’a pas', async () => {
    const t = await service(monde());
    await t.svc.passage(MAINTENANT);

    const [m] = messages(t.errorLogger);
    expect(m).toContain('MH Cars');
    expect(m).toContain('aurait dû produire une alerte');
    expect(t.errorLogger.record.mock.calls[0][3]).toBe('ERROR');
  });

  it('TÉMOIN — la MÊME fixture avec l’alerte présente ne dit rien', async () => {
    const t = await service(monde({ alertesSurTrajets: [{ tripId: 't1' }] }));
    await t.svc.passage(MAINTENANT);
    expect(t.errorLogger.record).not.toHaveBeenCalled();
  });

  it('ne reproche rien pour un trajet analysé AVANT l’activation du réglage', async () => {
    // Réglage activé il y a une heure, analyse écrite il y a deux : elle n'avait aucune raison
    // d'alerter. L'accuser reviendrait à inventer une faute.
    const t = await service(monde({ flottes: [flotteReglee({ speedAlertUpdatedAt: ilYa(1) })] }));
    await t.svc.passage(MAINTENANT);
    expect(t.errorLogger.record).not.toHaveBeenCalled();
  });

  it('ne reproche rien pour un trajet trop ancien au moment de l’analyse', async () => {
    // Le producteur ne notifie pas au-delà de 48 h : la sentinelle applique la MÊME borne,
    // sinon toute reprise d'analyses anciennes ferait hurler le centre.
    const t = await service(monde({ trajets: [trajet({ startedAt: ilYa(200), endedAt: ilYa(199) })] }));
    await t.svc.passage(MAINTENANT);
    expect(t.errorLogger.record).not.toHaveBeenCalled();
  });

  it('ne reproche rien quand le dépassement est sous le seuil réglé', async () => {
    const t = await service(monde({ analyses: [analyse({ maxSpeedKmh: 100, detail: { speeding: [segment(10)] } })] }));
    await t.svc.passage(MAINTENANT);
    expect(t.errorLogger.record).not.toHaveBeenCalled();
  });

  it('respecte une dérogation véhicule qui coupe les alertes', async () => {
    const t = await service(monde({
      vehicules: [{ id: 'v1', plate: 'AB-123-CD', speedAlertEnabled: false, speedAlertOverKmh: null }],
    }));
    await t.svc.passage(MAINTENANT);
    expect(t.errorLogger.record).not.toHaveBeenCalled();
  });

  it('ne lit RIEN quand aucune société n’a activé les alertes', async () => {
    const t = await service({ flottes: [] });
    await t.svc.passage(MAINTENANT);
    expect(t.prisma.tripAnalysis.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ fleetId: expect.anything() }) }),
    );
    expect(t.errorLogger.record).not.toHaveBeenCalled();
  });

  // ── TRK-064 — l'angle mort de cette sentinelle ────────────────────────────────────────
  //
  // Le test ci-dessus est désormais le TÉMOIN du couple : aucune société réglée ET aucun excès
  // mesuré, donc rien à dire. Le suivant est son contraire exact — la MÊME absence de réglage,
  // un fait en plus : des excès ont bien été relevés, et personne n'en est prévenu.
  //
  // Sans ce couple, le silence de la sentinelle prouverait seulement qu'elle sait se taire.
  it('TRK-064 — signale que la chaîne n’est armée NULLE PART quand des excès sont pourtant mesurés', async () => {
    const analyses = [analyse({ tripId: 't1' }), analyse({ tripId: 't2', vehicleId: 'v2' })];
    const t = await service({ flottes: [], flottesExistantes: 5, analyses });
    await t.svc.passage(MAINTENANT);

    const [m] = messages(t.errorLogger);
    expect(m).toContain('AUCUNE des 5 sociétés');
    expect(m).toContain('2 analyses');
    expect(m).toContain('2 véhicules');
    // DEGRADATION et non ERROR : rien n'est cassé, une capacité est inactive (raisonnement TRK-037).
    expect(t.errorLogger.record.mock.calls[0][3]).toBe('DEGRADATION');
  });

  it('TRK-064 — un rappel HEBDOMADAIRE, pas une ligne chaque matin', async () => {
    const t = await service({ flottes: [], flottesExistantes: 5, analyses: [analyse()] });
    await t.svc.passage(MAINTENANT);

    const [cle, fenetreMs] = t.refroidissement.tenterEmission.mock.calls[0];
    expect(cle).toBe('sentinelle-chaine-vitesse-jamais-armee');
    expect(fenetreMs).toBeGreaterThan(6 * 24 * 3_600_000);
  });

  it('groupe par société : une ligne, pas une par trajet', async () => {
    const analyses = Array.from({ length: 12 }, (_, i) => analyse({ tripId: `t${i}` }));
    const trajets = analyses.map((a) => trajet({ id: a.tripId }));
    const t = await service(monde({ analyses, trajets }));
    await t.svc.passage(MAINTENANT);

    expect(t.errorLogger.record).toHaveBeenCalledTimes(1);
    expect(messages(t.errorLogger)[0]).toContain('12 trajets');
  });
});

describe('Sentinelle — une vitesse que la trajectoire contredit', () => {
  const avecEcartes = (n: number, total: number) =>
    Array.from({ length: total }, (_, i) =>
      analyse({
        tripId: `t${i}`,
        speedingCount: 0,
        detail: i < n ? { vitesse: { pointeBruteKmh: 180, pointsEcartes: 2 } } : {},
      }),
    );

  it('crie quand les points écartés se répètent', async () => {
    const t = await service({ analyses: avecEcartes(5, 20) });
    await t.svc.passage(MAINTENANT);

    const m = messages(t.errorLogger).find((x) => x.includes('contredit'));
    expect(m).toContain('5 analyses sur 20');
    expect(m).toContain('AB-123-CD');
    // Le garde-fou a fait son travail : c'est une dégradation, pas un défaut de l'application.
    expect(t.errorLogger.record.mock.calls[0][3]).toBe('DEGRADATION');
  });

  it('se tait sur un cas isolé — le bruit GPS ordinaire', async () => {
    const t = await service({ analyses: avecEcartes(2, 20) });
    await t.svc.passage(MAINTENANT);
    expect(t.errorLogger.record).not.toHaveBeenCalled();
  });

  it('se tait quand la part reste faible, même avec beaucoup de cas', async () => {
    // 5 analyses touchées sur 200 : le plancher absolu est franchi, pas la part.
    const t = await service({ analyses: avecEcartes(5, 200) });
    await t.svc.passage(MAINTENANT);
    expect(t.errorLogger.record).not.toHaveBeenCalled();
  });
});

describe('Sentinelle — un excès bâti sur une limite invraisemblable', () => {
  const avecDoutes = (parAnalyse: number, total: number) =>
    Array.from({ length: total }, (_, i) =>
      analyse({
        tripId: `t${i}`, speedingCount: 0,
        detail: { aVerifier: Array.from({ length: parAnalyse }, () => ({ motif: 'limite-invraisemblable' })) },
      }),
    );

  it('crie quand les rattachements douteux se concentrent', async () => {
    const t = await service({ analyses: avecDoutes(2, 6) });
    await t.svc.passage(MAINTENANT);

    const m = messages(t.errorLogger).find((x) => x.includes('refusées comme excès'));
    expect(m).toContain('12 pointes');
    expect(m).toContain('zone à corriger');
  });

  it('se tait sous le seuil', async () => {
    const t = await service({ analyses: avecDoutes(1, 4) });
    await t.svc.passage(MAINTENANT);
    expect(t.errorLogger.record).not.toHaveBeenCalled();
  });

  it('ignore les pointes douteuses pour une AUTRE raison', async () => {
    // « point-unique » est un doute de durée, pas un défaut de carte : le compter ici
    // enverrait corriger OpenStreetMap pour un problème qui n'y est pas.
    const t = await service({
      analyses: Array.from({ length: 6 }, (_, i) =>
        analyse({ tripId: `t${i}`, speedingCount: 0, detail: { aVerifier: [{ motif: 'point-unique' }, { motif: 'point-unique' }] } }),
      ),
    });
    await t.svc.passage(MAINTENANT);
    expect(t.errorLogger.record).not.toHaveBeenCalled();
  });
});

describe('Sentinelle — une analyse qui ne sait presque rien des limites', () => {
  const couvertures = (valeurs: (number | null)[]) =>
    valeurs.map((c, i) => analyse({ tripId: `t${i}`, speedingCount: 0, limitsCoverage: c, detail: {} }));

  it('crie quand un tiers des analyses ne retrouve presque aucune limite', async () => {
    const t = await service({ analyses: couvertures([0.1, 0.2, 0.3, 0.9, 0.9, 0.95, 1, 1, 1, 1]) });
    await t.svc.passage(MAINTENANT);

    const m = messages(t.errorLogger).find((x) => x.includes('couverture cartographique'));
    expect(m).toContain('3 analyses sur 10');
    expect(m).toContain('30 %');
  });

  it('se tait quand la couverture est bonne', async () => {
    const t = await service({ analyses: couvertures([0.9, 0.9, 1, 1, 1, 1]) });
    await t.svc.passage(MAINTENANT);
    expect(t.errorLogger.record).not.toHaveBeenCalled();
  });

  it('se tait sur un échantillon trop petit pour conclure', async () => {
    const t = await service({ analyses: couvertures([0.1, 0.1]) });
    await t.svc.passage(MAINTENANT);
    expect(t.errorLogger.record).not.toHaveBeenCalled();
  });
});

describe('Sentinelle — quelqu’un qu’on croit prévenir et qui ne reçoit rien', () => {
  it('nomme les comptes et compte ce qu’ils ont manqué', async () => {
    const t = await service({
      livraisonsSansAppareil: [
        { userId: 'u1', _count: { _all: 21 } },
        { userId: 'u2', _count: { _all: 7 } },
      ],
      comptes: [{ id: 'u1', email: 'gerant@mhcars.fr' }, { id: 'u2', email: 'astreinte@cdef31.org' }],
    });
    await t.svc.passage(MAINTENANT);

    const m = messages(t.errorLogger).find((x) => x.includes('faute d’appareil') || x.includes("faute d'appareil"));
    expect(m).toContain('28 notifications');
    expect(m).toContain('gerant@mhcars.fr (21)');
    expect(m).toContain('se croient prévenues');
  });

  it('se tait sur un abonnement qui vient d’expirer', async () => {
    const t = await service({
      livraisonsSansAppareil: [{ userId: 'u1', _count: { _all: 2 } }],
      comptes: [{ id: 'u1', email: 'gerant@mhcars.fr' }],
    });
    await t.svc.passage(MAINTENANT);
    expect(t.errorLogger.record).not.toHaveBeenCalled();
  });

  it('ignore un compte désactivé — il n’attend plus rien', async () => {
    const t = await service({
      livraisonsSansAppareil: [{ userId: 'u1', _count: { _all: 30 } }],
      comptes: [], // `isActive: true` ne le rend pas
    });
    await t.svc.passage(MAINTENANT);
    expect(t.errorLogger.record).not.toHaveBeenCalled();
  });
});

describe('Sentinelle — des alertes que plus personne ne lit', () => {
  it('crie sur un tas d’alertes anciennes non acquittées', async () => {
    const t = await service({ alertesNonAcquittees: [{ fleetId: 'f1', _count: { _all: 34 } }] });
    await t.svc.passage(MAINTENANT);

    const m = messages(t.errorLogger).find((x) => x.includes('acquittées'));
    expect(m).toContain('34 alertes');
    expect(m).toContain('MH Cars');
  });

  it('se tait sur quelques alertes en attente — calibré sur la production', async () => {
    const t = await service({ alertesNonAcquittees: [{ fleetId: 'f1', _count: { _all: 3 } }] });
    await t.svc.passage(MAINTENANT);
    expect(t.errorLogger.record).not.toHaveBeenCalled();
  });
});

describe('Le passage lui-même', () => {
  it('n’écrit rien quand le refroidissement refuse — une ligne par jour, pas une par passage', async () => {
    const t = await service({
      flottes: [flotteReglee()], analyses: [analyse()], trajets: [trajet()],
      emissionAutorisee: false,
    });
    const r = await t.svc.passage(MAINTENANT);

    expect(r.constats).toBe(1);
    expect(r.emis).toBe(0);
    expect(t.errorLogger.record).not.toHaveBeenCalled();
    // ⚠️ Le constat reste VISIBLE dans la réponse : « rien d'écrit » ne doit jamais se
    // confondre avec « rien à dire ». C'est ce que lit le déclenchement manuel.
    expect(r.lignes).toHaveLength(1);
    expect(r.lignes[0]!.emis).toBe(false);
    expect(r.lignes[0]!.message).toContain('aurait dû produire une alerte');
  });

  it('cloisonne le refroidissement par société', async () => {
    const t = await service({
      flottes: [flotteReglee(), flotteReglee({ id: 'f2', name: 'CDEF 31' })],
      analyses: [analyse(), analyse({ tripId: 't2', fleetId: 'f2', vehicleId: 'v2' })],
      trajets: [trajet(), trajet({ id: 't2' })],
      vehicules: [
        { id: 'v1', plate: 'AB-123-CD', speedAlertEnabled: null, speedAlertOverKmh: null },
        { id: 'v2', plate: 'EF-456-GH', speedAlertEnabled: null, speedAlertOverKmh: null },
      ],
    });
    await t.svc.passage(MAINTENANT);

    const cles = t.refroidissement.tenterEmission.mock.calls.map((c) => String(c[0]));
    expect(cles).toContain('sentinelle-exces-sans-alerte:f1');
    expect(cles).toContain('sentinelle-exces-sans-alerte:f2');
  });

  it('⚠️ une sentinelle qui tombe n’emporte pas les autres', async () => {
    const t = await service({ alertesNonAcquittees: [{ fleetId: 'f1', _count: { _all: 34 } }] });
    t.prisma.tripAnalysis.findMany.mockRejectedValue(new Error('base injoignable'));

    const r = await t.svc.passage(MAINTENANT);

    // Les trois sentinelles qui lisent les analyses tombent ; celle des alertes parle quand même.
    expect(r.emis).toBe(1);
    expect(messages(t.errorLogger)[0]).toContain('34 alertes');
    expect(t.errorLogger.recordBackground).toHaveBeenCalled();
    expect(String(t.errorLogger.recordBackground.mock.calls[0][1])).toBe('sentinelles');
  });

  it('ne réveille jamais personne : rien ne part vers un téléphone', async () => {
    // Le service ne connaît NI le dispatch NI la passerelle : la garantie est structurelle.
    const t = await service({ flottes: [flotteReglee()], analyses: [analyse()], trajets: [trajet()] });
    await t.svc.passage(MAINTENANT);

    expect(t.errorLogger.record).toHaveBeenCalledTimes(1);
    // Toutes les écritures vont au centre d'alerte, sous une source unique et reconnaissable.
    for (const appel of t.errorLogger.record.mock.calls) expect(appel[1]).toBe('sentinelles');
  });
});
