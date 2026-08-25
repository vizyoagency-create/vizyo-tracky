import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import type { CobanPositionFrame } from '@vizyo/tracky-shared';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { AlertsService } from './alerts.service';

const FLEET_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_FLEET = '00000000-0000-0000-0000-000000000099';
const VEHICLE_ID = '00000000-0000-0000-0000-000000000020';
const TRACKER_ID = '00000000-0000-0000-0000-000000000010';
const ALERT_ID = '00000000-0000-0000-0000-000000000060';
const USER_ID = '00000000-0000-0000-0000-000000000030';

const tracker = {
  id: TRACKER_ID,
  imei: '111111111111111',
  // TRK-040 — Prisma rend TOUJOURS ces colonnes (leçon du 17/08 : un mock qui les omet
  // décrit un comportement qui n'existe nulle part). `null` = jamais vu d'ignition.
  lastKnownIgnition: null as boolean | null,
  powerLossSuspectAt: null as Date | null,
  powerLossSuspectBattery: null as number | null,
  vehicle: { id: VEHICLE_ID, plate: 'AB-123', fleetId: FLEET_ID, fleet: { id: FLEET_ID } },
};

const trackerNoVehicle = { ...tracker, vehicle: null };

function makeFrame(alarm: string, extra: Partial<CobanPositionFrame> = {}): CobanPositionFrame {
  return {
    type: 'position',
    imei: '111111111111111',
    alarm: alarm as any,
    deviceTime: new Date(),
    valid: true,
    latitude: 33.5,
    longitude: -7.5,
    speedKph: 10,
    raw: '[test]',
    ...extra,
  };
}

const alertRecord = (overrides: Record<string, unknown> = {}) => ({
  id: ALERT_ID,
  fleetId: FLEET_ID,
  vehicleId: VEHICLE_ID,
  trackerId: TRACKER_ID,
  type: 'SOS',
  severity: 'CRITICAL',
  title: 'Appel SOS conducteur',
  message: 'Vehicule AB-123',
  acknowledgedAt: null,
  acknowledgedBy: null,
  createdAt: new Date(),
  ...overrides,
});

const admin = { userId: USER_ID, role: UserRole.FLEET_ADMIN, fleetId: FLEET_ID };
const superAdmin = { userId: USER_ID, role: UserRole.SUPER_ADMIN, fleetId: FLEET_ID };
const otherAdmin = { userId: USER_ID, role: UserRole.FLEET_ADMIN, fleetId: OTHER_FLEET };

describe('AlertsService', () => {
  let service: AlertsService;
  let prisma: {
    // V1.10 (Sprint 6) — findFirst pour le filtre tenant integre au where.
    alert: { create: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock; findFirst: jest.Mock; update: jest.Mock; updateMany: jest.Mock; count: jest.Mock };
    surveillanceProfile: { findUnique: jest.Mock };
    tracker: { update: jest.Mock };
    engineControlCommand: { findFirst: jest.Mock };
    surveillanceEvent: { create: jest.Mock };
  };
  let gateway: { broadcastAlert: jest.Mock; broadcastAlertAcknowledged: jest.Mock };
  let dispatch: { dispatchAlert: jest.Mock };

  beforeEach(async () => {
    prisma = {
      alert: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve(alertRecord(data))),
        findMany: jest.fn().mockResolvedValue([alertRecord()]),
        findUnique: jest.fn().mockResolvedValue(alertRecord()),
        // ⚠️ `null` par defaut : c'est l'etat d'un vehicule sans alerte en cours, et
        // c'est ce que la deduplication interroge. Rendre une alerte par defaut ferait
        // croire a chaque test qu'un episode est deja ouvert — donc aucune creation.
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve(alertRecord(data))),
        updateMany: jest.fn().mockResolvedValue({ count: 3 }),
        count: jest.fn().mockResolvedValue(5),
      },
      // V1.6 — Surveillance Max : AlertsService consulte le profile pour
      // éventuellement élever la severity. Par défaut, pas de profil = pas
      // d'élévation (comportement legacy).
      surveillanceProfile: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      tracker: { update: jest.fn().mockResolvedValue({}) },
      // ⚠️ `null` par defaut = aucune coupure moteur commandee. C'est l'etat normal ;
      // rendre un CUT ferait croire a chaque test que nous avons coupe nous-memes,
      // et plus aucune alerte d'alimentation ne serait creee.
      engineControlCommand: { findFirst: jest.fn().mockResolvedValue(null) },
      surveillanceEvent: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'evt-1', ...data })),
      },
    };
    gateway = { broadcastAlert: jest.fn(), broadcastAlertAcknowledged: jest.fn() };
    dispatch = { dispatchAlert: jest.fn().mockResolvedValue({ channels: [] }) };

    const module = await Test.createTestingModule({
      providers: [
        AlertsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeGateway, useValue: gateway },
        { provide: NotificationDispatchService, useValue: dispatch },
      ],
    }).compile();

    service = module.get(AlertsService);
  });

  // 1. alarm 'none' → null
  it('should return null for alarm none', async () => {
    const result = await service.createFromCobanFrame(makeFrame('none'), tracker as any);
    expect(result).toBeNull();
    expect(prisma.alert.create).not.toHaveBeenCalled();
  });

  // 2. tracker sans vehicle → null
  it('should return null when tracker has no vehicle', async () => {
    const result = await service.createFromCobanFrame(makeFrame('sos'), trackerNoVehicle as any);
    expect(result).toBeNull();
  });

  // 3. sos → CRITICAL SOS + broadcast
  it('should create CRITICAL SOS alert and broadcast', async () => {
    const result = await service.createFromCobanFrame(makeFrame('sos'), tracker as any);
    expect(result).not.toBeNull();
    expect(prisma.alert.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'SOS', severity: 'CRITICAL' }),
      }),
    );
    expect(gateway.broadcastAlert).toHaveBeenCalled();
  });

  // 4. low_battery → WARNING LOW_BATTERY
  it('should create WARNING LOW_BATTERY alert', async () => {
    await service.createFromCobanFrame(makeFrame('low_battery'), tracker as any);
    expect(prisma.alert.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'LOW_BATTERY', severity: 'WARNING' }),
      }),
    );
  });

  // 5. list: multi-tenant
  it('should filter by fleetId for non-SUPER_ADMIN', async () => {
    await service.list(admin, {});
    expect(prisma.alert.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ fleetId: FLEET_ID }) }),
    );
  });

  // 6. list: SUPER_ADMIN sees all
  it('should not filter by fleetId for SUPER_ADMIN', async () => {
    await service.list(superAdmin, {});
    const call = prisma.alert.findMany.mock.calls[0][0];
    expect(call.where.fleetId).toBeUndefined();
  });

  // 7. acknowledge: marks + broadcast
  it('should acknowledge and broadcast', async () => {
    prisma.alert.findFirst.mockResolvedValue(alertRecord());
    const result = await service.acknowledge(ALERT_ID, admin);
    expect(prisma.alert.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ acknowledgedBy: USER_ID }) }),
    );
    expect(gateway.broadcastAlertAcknowledged).toHaveBeenCalled();
  });

  // 8. acknowledge: idempotent
  it('should be idempotent on already acknowledged alert', async () => {
    prisma.alert.findFirst.mockResolvedValue(alertRecord({ acknowledgedAt: new Date() }));
    const result = await service.acknowledge(ALERT_ID, admin);
    expect(prisma.alert.update).not.toHaveBeenCalled();
  });

  // 9. acknowledge: cross-fleet refused → NotFoundException
  // V1.10 (Sprint 6) — le filtre fleetId integre au where via findFirst renvoie
  // null pour les non-SUPER d'une autre flotte. Changement volontaire de 403
  // vers 404 pour ne pas leak l'existence des ressources cross-fleet.
  it('should refuse cross-fleet acknowledge', async () => {
    prisma.alert.findFirst.mockResolvedValue(null);
    await expect(service.acknowledge(ALERT_ID, otherAdmin)).rejects.toThrow(NotFoundException);
  });

  // 10. countUnacknowledged
  it('should count total and critical', async () => {
    prisma.alert.count.mockResolvedValueOnce(10).mockResolvedValueOnce(2);
    const result = await service.countUnacknowledged(admin);
    expect(result).toEqual({ total: 10, critical: 2 });
  });

  // 11. #6 — surveillanceEvent.create échoue → l'alerte CRITICAL est quand même diffusée
  it('should still broadcast a CRITICAL surveillance alert when the audit event write fails', async () => {
    prisma.surveillanceProfile.findUnique.mockResolvedValue({
      id: 'profile-1',
      vehicleId: VEHICLE_ID,
      fleetId: FLEET_ID,
      currentlyArmed: true,
      triggerVibration: true,
      triggerMovement: false,
      triggerDoor: false,
    });
    // L'event d'audit échoue (timeout DB, FK...) : ne doit PAS bloquer le broadcast.
    prisma.surveillanceEvent.create.mockRejectedValue(new Error('DB timeout'));

    const result = await service.createFromCobanFrame(makeFrame('vibration'), tracker as any);

    expect(result).not.toBeNull();
    expect(prisma.alert.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ severity: 'CRITICAL', type: 'SURVEILLANCE_TRIGGERED' }),
      }),
    );
    // Point clé : malgré l'échec de l'audit, l'alerte de vol a bien été diffusée.
    expect(gateway.broadcastAlert).toHaveBeenCalled();
  });

  // 12. GPS_LOST (incident FS-253) — aucune alerte récente → crée WARNING GPS_LOST + broadcast
  it('createGpsLostAlert creates a WARNING GPS_LOST alert when none is recent', async () => {
    prisma.alert.findFirst.mockResolvedValue(null);
    const result = await service.createGpsLostAlert(
      { id: TRACKER_ID, imei: '111111111111111', lastLat: 43.6, lastLng: 1.45, lastPositionAt: new Date() },
      { id: VEHICLE_ID, plate: 'FS-253-HR', fleetId: FLEET_ID },
      '29 h',
    );
    expect(result).not.toBeNull();
    expect(prisma.alert.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'GPS_LOST', severity: 'WARNING', vehicleId: VEHICLE_ID }),
      }),
    );
    expect(gateway.broadcastAlert).toHaveBeenCalled();
  });

  // 13. GPS_LOST — dédup : une alerte GPS_LOST récente OUVERTE → null, aucun doublon
  it('createGpsLostAlert dedups against a recent OPEN alert', async () => {
    prisma.alert.findFirst.mockResolvedValue(alertRecord({ type: 'GPS_LOST' }));
    const result = await service.createGpsLostAlert(
      { id: TRACKER_ID, imei: '111111111111111', lastLat: null, lastLng: null, lastPositionAt: null },
      { id: VEHICLE_ID, plate: 'FS-253-HR', fleetId: FLEET_ID },
      '29 h',
    );
    expect(result).toBeNull();
    expect(prisma.alert.create).not.toHaveBeenCalled();
  });

  /**
   * TRK-046 — « Sortie hors horaire » : le filet de la présomption de stationnement.
   * Même régime de dédup que GPS_LOST (avec ou sans acquittement), CRITICAL, et le message
   * dit ce qui s'est passé ET quoi faire (couper à la main depuis la fiche boîtier).
   */
  it('createSortieHorsHoraireAlert creates a CRITICAL OFF_SCHEDULE_MOVEMENT alert with an actionable message', async () => {
    prisma.alert.findFirst.mockResolvedValue(null);
    const result = await service.createSortieHorsHoraireAlert(
      { id: TRACKER_ID, imei: '111111111111111' },
      { id: VEHICLE_ID, plate: 'FZ-862-VY', fleetId: FLEET_ID },
      { sombreMin: 480, speedKmh: 32, lat: 43.6, lng: 1.45, lieuValide: true, windowDesc: '08:00–22:00' },
    );
    expect(result).not.toBeNull();
    expect(prisma.alert.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'OFF_SCHEDULE_MOVEMENT',
          severity: 'CRITICAL',
          vehicleId: VEHICLE_ID,
          message: expect.stringContaining('hors horaire autorisé'),
        }),
      }),
    );
    const data = prisma.alert.create.mock.calls[0][0].data;
    expect(data.message).toContain('480 min');
    expect(data.message).toContain('considéré stationné');
    expect(gateway.broadcastAlert).toHaveBeenCalled();
  });

  it('createSortieHorsHoraireAlert dedups within the window, acknowledged or not', async () => {
    prisma.alert.findFirst.mockResolvedValue(alertRecord({ type: 'OFF_SCHEDULE_MOVEMENT', acknowledgedAt: new Date() }));
    const result = await service.createSortieHorsHoraireAlert(
      { id: TRACKER_ID, imei: '111111111111111' },
      { id: VEHICLE_ID, plate: 'FZ-862-VY', fleetId: FLEET_ID },
      { sombreMin: 480, speedKmh: 32, lat: null, lng: null, lieuValide: false, windowDesc: null },
    );
    expect(result).toBeNull();
    expect(prisma.alert.create).not.toHaveBeenCalled();
    const where = prisma.alert.findFirst.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('acknowledgedAt');
    expect(where).toMatchObject({ vehicleId: VEHICLE_ID, type: 'OFF_SCHEDULE_MOVEMENT' });
  });

  // 14. GPS_LOST — anti-régression (revue 2026-07-09) : une alerte ACQUITTÉE récente
  // dédup AUSSI. Sinon acquitter recréerait une alerte au tick suivant (re-spam).
  it('createGpsLostAlert dedups even against an ACKNOWLEDGED recent alert (no re-spawn on ack)', async () => {
    prisma.alert.findFirst.mockResolvedValue(alertRecord({ type: 'GPS_LOST', acknowledgedAt: new Date() }));
    const result = await service.createGpsLostAlert(
      { id: TRACKER_ID, imei: '111111111111111', lastLat: null, lastLng: null, lastPositionAt: null },
      { id: VEHICLE_ID, plate: 'FS-253-HR', fleetId: FLEET_ID },
      '30 h',
    );
    expect(result).toBeNull();
    expect(prisma.alert.create).not.toHaveBeenCalled();
    // Le filtre de dédup NE DOIT PAS restreindre à acknowledgedAt: null (sinon ré-spawn).
    const where = prisma.alert.findFirst.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('acknowledgedAt');
    expect(where).toMatchObject({ vehicleId: VEHICLE_ID, type: 'GPS_LOST' });
  });

  /**
   * A6 arbitrage J — « grille absente = alerte au centre d'alertes, PAS de blocage ».
   *
   * La seule alerte de ce catalogue qui ne vienne pas d'un boitier : elle decrit un
   * REGLAGE de la societe, pas un evenement du terrain.
   */
  describe('createPricingGridMissingAlert — la grille tarifaire manquante', () => {
    beforeEach(() => {
      // Aucune alerte recente : la fenetre de dedup est libre.
      prisma.alert.findFirst.mockResolvedValue(null);
    });

    it('cree une alerte WARNING, de flotte, SANS vehicule', async () => {
      const result = await service.createPricingGridMissingAlert(FLEET_ID, 'Aucune grille.');
      expect(result).not.toBeNull();
      const data = prisma.alert.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        fleetId: FLEET_ID,
        type: 'PRICING_GRID_MISSING',
        severity: 'WARNING',
      });
      // Toutes les autres alertes portent une plaque. Celle-ci n'en a pas, et le
      // centre d'alertes sait deja ne rien afficher dans ce cas.
      expect(data.vehicleId).toBeUndefined();
      expect(data.trackerId).toBeUndefined();
    });

    it('reprend le motif du service de tarification et dit quoi faire', async () => {
      await service.createPricingGridMissingAlert(FLEET_ID, 'La grille est désactivée.');
      const data = prisma.alert.create.mock.calls[0][0].data;
      expect(data.message).toContain('La grille est désactivée.');
      expect(data.message).toContain('Paramètres');
    });

    it('diffuse en direct pour que le compteur du centre bouge sans rechargement', async () => {
      await service.createPricingGridMissingAlert(FLEET_ID, 'Aucune grille.');
      expect(gateway.broadcastAlert).toHaveBeenCalled();
    });

    it('déduplique sur la flotte, ACQUITTÉE OU NON', async () => {
      prisma.alert.findFirst.mockResolvedValue(
        alertRecord({ type: 'PRICING_GRID_MISSING', acknowledgedAt: new Date() }),
      );
      const result = await service.createPricingGridMissingAlert(FLEET_ID, 'Aucune grille.');
      expect(result).toBeNull();
      expect(prisma.alert.create).not.toHaveBeenCalled();
      // La cause persiste tant que personne n'a publié de grille, et chaque calcul de
      // devis repasse ici : acquitter doit faire taire pour la fenêtre, pas relancer.
      const where = prisma.alert.findFirst.mock.calls[0][0].where;
      expect(where).not.toHaveProperty('acknowledgedAt');
      expect(where).toMatchObject({ fleetId: FLEET_ID, type: 'PRICING_GRID_MISSING' });
      expect(where).not.toHaveProperty('vehicleId');
    });

    it('ne réveille AUCUN téléphone : pas de dispatch externe', async () => {
      await service.createPricingGridMissingAlert(FLEET_ID, 'Aucune grille.');
      // Légitime pour un SOS, absurde pour un tarif non publié — qui attend très bien
      // l'ouverture du navigateur.
      expect(dispatch.dispatchAlert).not.toHaveBeenCalled();
    });
  });

  /**
   * ── LE DELUGE D'ALERTES D'ALIMENTATION (2026-08-19) ────────────────────────────────
   *
   * 202 alertes CRITIQUES « Alimentation coupée » en 24 h, pour DEUX véhicules garés la
   * nuit. Deux causes cumulées, et ces tests verrouillent les deux corrections.
   */
  describe('alimentation : ne plus crier pour un contact coupé', () => {
    it('⚠️ batterie pleine : AUCUNE alerte creee — c est le cas des 202', async () => {
      const r = await service.createFromCobanFrame(
        makeFrame('power_cut', { batteryPercent: 100, speedKph: 0 }),
        tracker as any,
      );
      expect(r).toBeNull();
      expect(prisma.alert.create).not.toHaveBeenCalled();
    });

    it('mais l information est GARDEE sur le boitier — pas de cecite', async () => {
      // Se taire sans laisser de trace remplacerait un bruit par un angle mort.
      await service.createFromCobanFrame(
        makeFrame('power_cut', { batteryPercent: 100 }),
        tracker as any,
      );
      expect(prisma.tracker.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ lastPowerNotice: expect.any(String) }) }),
      );
    });

    it('batterie sous le seuil : l alerte part, avec un message NON VIDE', async () => {
      // Les 202 alertes portaient un message vide : impossible de juger.
      await service.createFromCobanFrame(
        makeFrame('power_cut', { batteryPercent: 40 }),
        tracker as any,
      );
      const appel = prisma.alert.create.mock.calls[0]?.[0] as { data: { message: string } };
      expect(appel.data.message).toContain('40 %');
    });

    it('batterie inconnue : on alerte — le doute ne doit pas faire taire', async () => {
      await service.createFromCobanFrame(makeFrame('power_cut'), tracker as any);
      expect(prisma.alert.create).toHaveBeenCalled();
    });
  });


  /**
   * ── LA COUPURE COMMANDEE DOIT ETRE RECENTE (2026-08-20) ────────────────────────────
   *
   * Le correctif du 19/08 se taisait des lors que la DERNIERE commande moteur du boitier
   * etait un CUT, sans regarder sa date. Or l'automatisation horaire coupe la flotte le
   * soir et la retablit a 06:00 : entre les deux, la condition etait vraie pour 33
   * boitiers sur 42 — dix heures de silence par nuit, sur l'alarme d'alimentation.
   *
   * Ces tests verrouillent la borne de temps. Les deux « CUT ancien » ECHOUENT sur le
   * code d'avant : ils sont la raison d'etre du lot.
   */
  describe('alimentation : la coupure commandee doit etre RECENTE', () => {
    /** Une commande moteur telle que la rend Prisma, avec son age en minutes. */
    const commande = (action: 'CUT' | 'RESTORE', ageMinutes: number) => ({
      action,
      createdAt: new Date(Date.now() - ageMinutes * 60 * 1000),
    });

    it('⚠️ coupure commandee a l instant : AUCUNE alerte', async () => {
      // Le cas reel de DZ-034-CA : l'automatisation coupe, le boitier signale la perte
      // du +12V dans la foulee, et l'application s'alarmait de sa propre action.
      prisma.engineControlCommand.findFirst.mockResolvedValueOnce(commande('CUT', 2) as never);
      const r = await service.createFromCobanFrame(
        makeFrame('power_cut', { batteryPercent: 35 }),
        tracker as any,
      );
      expect(r).toBeNull();
      expect(prisma.alert.create).not.toHaveBeenCalled();
    });

    it('🔴 coupure commandee il y a SIX HEURES : l alerte PART', async () => {
      // LE test du correctif. Une perte d'alimentation causee par notre relais arrive en
      // secondes ; six heures plus tard, la coupe du soir n'explique plus rien. C'est
      // exactement ce qui est arrive le 19/08 a 02:26:23 — une alarme silenciee 6 h 26
      // apres la coupe de 20:00, sur un vehicule qui alarmait depuis la veille.
      prisma.engineControlCommand.findFirst.mockResolvedValueOnce(commande('CUT', 6 * 60) as never);
      await service.createFromCobanFrame(
        makeFrame('power_cut', { batteryPercent: 35 }),
        tracker as any,
      );
      expect(prisma.alert.create).toHaveBeenCalled();
    });

    it('🔴 coupure restee SENT depuis trois jours : l alerte PART', async () => {
      // Sans borne, une commande jamais acquittee silenciait le boitier A VIE. Un
      // RESTORE bloque dans cet etat depuis 559 h existe deja en production.
      prisma.engineControlCommand.findFirst.mockResolvedValueOnce(
        commande('CUT', 3 * 24 * 60) as never,
      );
      await service.createFromCobanFrame(
        makeFrame('power_cut', { batteryPercent: 35 }),
        tracker as any,
      );
      expect(prisma.alert.create).toHaveBeenCalled();
    });

    it('la borne lit la DATE, pas le statut : un CUT recent non acquitte fait toujours taire', async () => {
      // Le repli SMS laisse la commande en `SENT` definitivement. L'exclure rendrait
      // l'application aveugle a ses propres coupes sur le chemin le moins fiable ; c'est
      // la date qui tranche, pas le statut.
      prisma.engineControlCommand.findFirst.mockResolvedValueOnce(commande('CUT', 1) as never);
      const r = await service.createFromCobanFrame(
        makeFrame('power_cut', { batteryPercent: 35 }),
        tracker as any,
      );
      expect(r).toBeNull();
    });

    it('moteur RETABLI puis vraie coupure : l alerte part', async () => {
      prisma.engineControlCommand.findFirst.mockResolvedValueOnce(commande('RESTORE', 2) as never);
      await service.createFromCobanFrame(
        makeFrame('power_cut', { batteryPercent: 35 }),
        tracker as any,
      );
      expect(prisma.alert.create).toHaveBeenCalled();
    });

    it('aucune commande moteur du tout : comportement inchange, l alerte part', async () => {
      prisma.engineControlCommand.findFirst.mockResolvedValueOnce(null as never);
      await service.createFromCobanFrame(
        makeFrame('power_cut', { batteryPercent: 35 }),
        tracker as any,
      );
      expect(prisma.alert.create).toHaveBeenCalled();
    });
  });

  describe('deduplication : une alerte par episode, pas par trame', () => {
    it('⚠️ une alerte deja ouverte bloque le doublon', async () => {
      // Le boitier repete son alarme a chaque trame : sans ceci, une alerte toutes
      // les vingt secondes.
      prisma.alert.findFirst.mockResolvedValueOnce({ id: 'deja-ouverte' } as never);
      const r = await service.createFromCobanFrame(makeFrame('sos'), tracker as any);
      expect(r).toBeNull();
      expect(prisma.alert.create).not.toHaveBeenCalled();
    });

    it('une alerte ACQUITTEE ne bloque pas : l exploitant a traite l episode', async () => {
      // La recherche filtre sur acknowledgedAt: null — donc rien trouve ici.
      prisma.alert.findFirst.mockResolvedValueOnce(null as never);
      const r = await service.createFromCobanFrame(makeFrame('sos'), tracker as any);
      expect(r).not.toBeNull();
    });
  });

  /** TRK-040 — contact allumé = on ne croit plus la batterie pleine. */
  describe("TRK-040 : le contact départage, le soupçon s'arme", () => {
    it('🔑 le verrou anti-DZ-034-CA : lastKnownIgnition=true + batterie 100 → ALERTE', async () => {
      await service.createFromCobanFrame(
        makeFrame('power_cut', { batteryPercent: 100, speedKph: 0 }),
        { ...tracker, lastKnownIgnition: true } as never,
      );
      expect(prisma.alert.create).toHaveBeenCalled();
    });

    it('la trame elle-même prouve le contact : frame.ignition=true + lastKnownIgnition=null → alerte', async () => {
      await service.createFromCobanFrame(
        makeFrame('power_cut', { batteryPercent: 100, ignition: true }),
        { ...tracker, lastKnownIgnition: null } as never,
      );
      expect(prisma.alert.create).toHaveBeenCalled();
    });

    it("⚠️ un false de trame n'éteint JAMAIS un true connu — le fil ACC meurt pendant une vraie coupure", async () => {
      await service.createFromCobanFrame(
        makeFrame('power_cut', { batteryPercent: 100, ignition: false }),
        { ...tracker, lastKnownIgnition: true } as never,
      );
      expect(prisma.alert.create).toHaveBeenCalled();
    });

    it("contact coupé + batterie pleine : pas d'alerte, mais le SOUPÇON s'arme", async () => {
      const res = await service.createFromCobanFrame(
        makeFrame('power_cut', { batteryPercent: 100 }),
        { ...tracker, lastKnownIgnition: false } as never,
      );
      expect(res).toBeNull();
      expect(prisma.tracker.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lastPowerNotice: expect.any(String),
            powerLossSuspectAt: expect.any(Date),
            powerLossSuspectBattery: 100,
          }),
        }),
      );
    });

    it("soupçon déjà ouvert : l'heure de la PREMIÈRE trame ne bouge pas au fil de la salve", async () => {
      const premiere = new Date('2026-08-21T06:23:46Z');
      await service.createFromCobanFrame(
        makeFrame('power_cut', { batteryPercent: 100 }),
        { ...tracker, lastKnownIgnition: false, powerLossSuspectAt: premiere, powerLossSuspectBattery: 100 } as never,
      );
      expect(prisma.tracker.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ powerLossSuspectAt: premiere }),
        }),
      );
    });

    it('correctif 3 : le verdict qui ALERTE remplace la note « pas en péril » et referme le soupçon', async () => {
      await service.createFromCobanFrame(
        makeFrame('power_cut', { batteryPercent: 100 }),
        { ...tracker, lastKnownIgnition: true, powerLossSuspectAt: new Date(), powerLossSuspectBattery: 100 } as never,
      );
      expect(prisma.tracker.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lastPowerNotice: expect.stringContaining('ALLUMÉ'),
            powerLossSuspectAt: null,
            powerLossSuspectBattery: null,
          }),
        }),
      );
    });

    it('⚠️ la fenêtre TRK-032 passe AVANT le croisement contact : CUT récent → silence total', async () => {
      prisma.engineControlCommand.findFirst.mockResolvedValueOnce({
        action: 'CUT',
        createdAt: new Date(Date.now() - 2 * 60_000),
      } as never);
      const res = await service.createFromCobanFrame(
        makeFrame('power_cut', { batteryPercent: 35 }),
        { ...tracker, lastKnownIgnition: true } as never,
      );
      expect(res).toBeNull();
      expect(prisma.alert.create).not.toHaveBeenCalled();
    });
  });
});
