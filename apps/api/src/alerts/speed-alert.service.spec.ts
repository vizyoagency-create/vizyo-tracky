/**
 * Lot V5 — le maillon entre l'analyse et l'alerte : ce qui décide qu'un trajet analysé
 * prévient quelqu'un, et ce qui l'en empêche.
 */
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { AlertsService, messageExcesTrajet } from './alerts.service';
import { FRAICHEUR_MAX_MS, SpeedAlertService } from './speed-alert.service';

const MAINTENANT = new Date('2026-08-29T15:00:00.000Z').getTime();

const trajet = (fin = new Date('2026-08-29T13:03:00.000Z')) => ({
  id: 'trip-1', vehicleId: 'veh-1', trackerId: 'trk-1',
  startedAt: new Date('2026-08-29T12:12:00.000Z'), endedAt: fin,
});

const vehicule = (surcharge: { speedAlertEnabled: boolean | null; speedAlertOverKmh: number | null } = { speedAlertEnabled: null, speedAlertOverKmh: null }, flotte = { speedAlertEnabled: true, speedAlertOverKmh: 20, speedAlertAbsoluteKmh: 130 as number | null }) => ({
  id: 'veh-1', plate: 'AB-123-CD', fleetId: 'fleet-1', ...surcharge, fleet: flotte,
});

const segment = (over: number, limit = 90) => ({
  startAt: '2026-08-29T12:20:00.000Z', endAt: '2026-08-29T12:20:45.000Z', durationSec: 45,
  maxSpeedKmh: limit + over, limitKmh: limit, overKmh: over, lat: 43.6, lng: 1.4,
});

describe('SpeedAlertService — évaluer un trajet analysé', () => {
  let service: SpeedAlertService;
  let prisma: { vehicle: { findUnique: jest.Mock } };
  let alerts: { createSpeedingAlert: jest.Mock };

  beforeEach(async () => {
    prisma = { vehicle: { findUnique: jest.fn().mockResolvedValue(vehicule()) } };
    alerts = { createSpeedingAlert: jest.fn().mockResolvedValue({ id: 'alert-1' }) };
    const module = await Test.createTestingModule({
      providers: [
        SpeedAlertService,
        { provide: PrismaService, useValue: prisma },
        { provide: AlertsService, useValue: alerts },
      ],
    }).compile();
    service = module.get(SpeedAlertService);
  });

  it('alerte sur un excès au-dessus du seuil de la société', async () => {
    const issue = await service.evaluer(trajet(), { maxSpeedKmh: 125, speeding: [segment(35)] }, MAINTENANT);

    expect(issue.issue).toBe('alerte');
    expect(alerts.createSpeedingAlert).toHaveBeenCalledTimes(1);
    const appel = alerts.createSpeedingAlert.mock.calls[0][0];
    expect(appel.vehicle).toEqual({ id: 'veh-1', plate: 'AB-123-CD', fleetId: 'fleet-1' });
    expect(appel.decision).toMatchObject({ motif: 'limite', overKmh: 35, speedKmh: 125 });
    expect(appel.reglage).toEqual({ enabled: true, overKmh: 20, absoluteKmh: 130 });
  });

  it('ne réveille personne pour un trajet trop ancien — et ne lit même pas le véhicule', async () => {
    const vieux = trajet(new Date(MAINTENANT - FRAICHEUR_MAX_MS - 60_000));
    const issue = await service.evaluer(vieux, { maxSpeedKmh: 180, speeding: [segment(70)] }, MAINTENANT);

    expect(issue.issue).toBe('trop-ancien');
    expect(prisma.vehicle.findUnique).not.toHaveBeenCalled();
    expect(alerts.createSpeedingAlert).not.toHaveBeenCalled();
  });

  it('un trajet sans fin est daté de son début', async () => {
    const enCours = { ...trajet(), startedAt: new Date(MAINTENANT - FRAICHEUR_MAX_MS - 1), endedAt: null };
    expect((await service.evaluer(enCours, { maxSpeedKmh: 180, speeding: [segment(70)] }, MAINTENANT)).issue).toBe('trop-ancien');
  });

  it('reste muet quand la société n’a pas activé les alertes de vitesse', async () => {
    prisma.vehicle.findUnique.mockResolvedValue(vehicule(undefined, { speedAlertEnabled: false, speedAlertOverKmh: 20, speedAlertAbsoluteKmh: 130 }));
    const issue = await service.evaluer(trajet(), { maxSpeedKmh: 180, speeding: [segment(70)] }, MAINTENANT);

    expect(issue.issue).toBe('desactive');
    expect(alerts.createSpeedingAlert).not.toHaveBeenCalled();
  });

  it('un véhicule peut être surveillé seul, société coupée', async () => {
    prisma.vehicle.findUnique.mockResolvedValue(
      vehicule({ speedAlertEnabled: true, speedAlertOverKmh: 10 }, { speedAlertEnabled: false, speedAlertOverKmh: 20, speedAlertAbsoluteKmh: 130 }),
    );
    const issue = await service.evaluer(trajet(), { maxSpeedKmh: 102, speeding: [segment(12)] }, MAINTENANT);

    expect(issue.issue).toBe('alerte');
    expect(alerts.createSpeedingAlert.mock.calls[0][0].reglage).toEqual({ enabled: true, overKmh: 10, absoluteKmh: 130 });
  });

  it('rien à signaler sous le seuil', async () => {
    const issue = await service.evaluer(trajet(), { maxSpeedKmh: 100, speeding: [segment(10)] }, MAINTENANT);
    expect(issue.issue).toBe('rien-a-signaler');
    expect(alerts.createSpeedingAlert).not.toHaveBeenCalled();
  });

  it('une ré-analyse ne produit pas de seconde alerte', async () => {
    alerts.createSpeedingAlert.mockResolvedValue(null);
    const issue = await service.evaluer(trajet(), { maxSpeedKmh: 125, speeding: [segment(35)] }, MAINTENANT);
    expect(issue.issue).toBe('deja-alerte');
  });

  it('véhicule disparu : rien, sans erreur', async () => {
    prisma.vehicle.findUnique.mockResolvedValue(null);
    expect((await service.evaluer(trajet(), { maxSpeedKmh: 125, speeding: [segment(35)] }, MAINTENANT)).issue).toBe('vehicule-inconnu');
  });
});

describe('messageExcesTrajet — la phrase que le client lira', () => {
  const trip = { startedAt: new Date('2026-08-29T12:12:00.000Z'), endedAt: new Date('2026-08-29T13:03:00.000Z') };
  const reglage = { enabled: true, overKmh: 20, absoluteKmh: 130 };

  it('dit la vitesse, la limite, le dépassement, la durée et l’heure du trajet', () => {
    const m = messageExcesTrajet(
      { motif: 'limite', severity: 'CRITICAL', speedKmh: 168, limitKmh: 110, overKmh: 58, durationSec: 45, segmentCount: 3, lat: 0, lng: 0, startAt: null, endAt: null },
      trip, reglage,
    );
    expect(m).toBe('168 km/h relevés sur une voie limitée à 110 (+58 km/h) pendant 45 s — trajet du 29 août, 14:12 → 15:03. 3 excès confirmés sur ce trajet.');
  });

  it('pour le plafond absolu, nomme la règle du pays plutôt qu’une limite de voie', () => {
    const m = messageExcesTrajet(
      { motif: 'absolu', severity: 'WARNING', speedKmh: 168, limitKmh: null, overKmh: 38, durationSec: 0, segmentCount: 0, lat: null, lng: null, startAt: null, endAt: null },
      trip, reglage,
    );
    expect(m).toBe('168 km/h relevés — aucune route française n\'autorise plus de 130 km/h. Trajet du 29 août, 14:12 → 15:03.');
  });

  it('exprime les longs excès en minutes', () => {
    const m = messageExcesTrajet(
      { motif: 'limite', severity: 'WARNING', speedKmh: 120, limitKmh: 90, overKmh: 30, durationSec: 150, segmentCount: 1, lat: 0, lng: 0, startAt: null, endAt: null },
      { ...trip, endedAt: null }, reglage,
    );
    expect(m).toBe('120 km/h relevés sur une voie limitée à 90 (+30 km/h) pendant 3 min — trajet du 29 août, 14:12.');
  });
});
