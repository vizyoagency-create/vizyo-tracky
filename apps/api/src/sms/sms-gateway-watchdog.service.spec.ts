import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { ErrorLogger } from '../observability/error-logger.service';
import { SmsGatewayService } from './sms-gateway.service';
import { SmsGatewayWatchdogService } from './sms-gateway-watchdog.service';

/**
 * T44 (contre-expertise du 13/09, P1-2) — la sentinelle a une HYSTÉRÉSIS : 2 contrôles mauvais
 * consécutifs pour ouvrir un épisode, 3 sains consécutifs pour le fermer, rappel toutes les 15 min.
 * Un téléphone qui ne contacte le serveur qu'à son pull de secours ne produit plus un CRITICAL
 * par pull.
 */
describe('SmsGatewayWatchdogService', () => {
  let service: SmsGatewayWatchdogService;
  let healthCheck: jest.Mock;
  let record: jest.Mock;
  let emit: jest.Mock;

  const stale = {
    reachable: true,
    error: 'téléphone Android absent ou périmé',
    gateway: {
      operational: false,
      device: { state: 'STALE', selectedId: 'phone-prod', fresh: false, freshestLastSeenAt: null, ageSeconds: 300 },
      queue: { pending: 2 },
    },
  };
  const healthy = { reachable: true, gateway: { operational: true, device: { state: 'ONLINE', fresh: true }, queue: { pending: 0 } } };
  const ticks = async (...states: Array<'bad' | 'good' | 'throw'>) => {
    for (const s of states) {
      if (s === 'throw') healthCheck.mockRejectedValueOnce(new Error('timeout'));
      else healthCheck.mockResolvedValueOnce(s === 'bad' ? stale : healthy);
      await service.inspect();
    }
  };

  beforeEach(async () => {
    healthCheck = jest.fn();
    record = jest.fn().mockResolvedValue('alert-id');
    emit = jest.fn();
    const module = await Test.createTestingModule({
      providers: [
        SmsGatewayWatchdogService,
        {
          provide: SmsGatewayService,
          useValue: { currentProvider: () => 'vizyo-texto', healthCheck },
        },
        { provide: ErrorLogger, useValue: { record } },
        { provide: EventEmitter2, useValue: { emit } },
      ],
    }).compile();
    service = module.get(SmsGatewayWatchdogService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('un seul contrôle mauvais n ouvre rien — un ping manqué n est pas une panne', async () => {
    await ticks('bad', 'good');
    expect(record).not.toHaveBeenCalled();
  });

  it('deux contrôles mauvais consécutifs ouvrent UN épisode ; les suivants ne répètent pas l alerte avant 15 min', async () => {
    await ticks('bad', 'bad', 'bad', 'bad');
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.stringContaining('coupes automatiques sont bloquées'),
      'sms-gateway-watchdog',
      expect.objectContaining({ androidFresh: false, androidState: 'STALE', androidDevice: 'phone-prod', relayQueueDepth: 2 }),
      'CRITICAL',
    );
  });

  it('🔴 sain/périmé alternés à chaque pull du téléphone : pas un CRITICAL par épisode', async () => {
    // Un téléphone qui ne pingue qu'à son pull de secours : 4 contrôles périmés, un sain, et ainsi de suite.
    await ticks('bad', 'bad', 'bad', 'bad', 'good', 'bad', 'bad', 'bad', 'bad', 'good', 'bad', 'bad');
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('une stricte alternance mauvais/sain n ouvre jamais d épisode', async () => {
    await ticks('bad', 'good', 'bad', 'good', 'bad', 'good');
    expect(record).not.toHaveBeenCalled();
  });

  it('un épisode se ferme après TROIS contrôles sains consécutifs, puis un nouvel épisode alerte à nouveau', async () => {
    await ticks('bad', 'bad'); // ouvert
    await ticks('good', 'good'); // pas encore fermé
    await ticks('bad'); // retombe : le compte de sains repart de zéro, pas de nouvelle alerte (< 15 min)
    await ticks('good', 'good', 'good'); // fermé
    expect(record).toHaveBeenCalledTimes(1);
    await ticks('bad', 'bad'); // nouvel épisode
    expect(record).toHaveBeenCalledTimes(2);
  });

  it('rappelle une panne prolongée toutes les 15 min, pas avant', async () => {
    const t0 = 1_800_000_000_000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
    await ticks('bad', 'bad');
    expect(record).toHaveBeenCalledTimes(1);
    now.mockReturnValue(t0 + 14 * 60_000);
    await ticks('bad');
    expect(record).toHaveBeenCalledTimes(1);
    now.mockReturnValue(t0 + 15 * 60_000 + 1);
    await ticks('bad');
    expect(record).toHaveBeenCalledTimes(2);
  });

  it('un contrôle qui LÈVE compte comme un contrôle mauvais, avec le même seuil', async () => {
    await ticks('throw');
    expect(record).not.toHaveBeenCalled();
    await ticks('throw');
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(expect.stringContaining('Contrôle de la passerelle SMS impossible'), 'sms-gateway-watchdog', undefined, 'CRITICAL');
  });

  it('🔴 une alerte non persistée par le centre d alerte est retentée au tick suivant, sans attendre 15 min', async () => {
    record.mockRejectedValueOnce(new Error('centre indisponible'));
    await expect(ticks('bad', 'bad')).resolves.toBeUndefined();
    expect(record).toHaveBeenCalledTimes(1);
    await ticks('bad');
    expect(record).toHaveBeenCalledTimes(2);
  });

  it('16/09 — l ouverture d un épisode POUSSE une notification aux super-admins, puis se tait pendant une heure', async () => {
    await ticks('bad', 'bad', 'bad', 'bad', 'bad');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      'coupe-circuit.push',
      expect.objectContaining({ kind: 'passerelle-sms', subjectKey: 'passerelle', title: expect.stringContaining('hors ligne') }),
    );
    // le rappel du centre d'alerte (15 min) ne pousse pas de nouveau : une heure entre deux push
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60_000);
    await ticks('bad');
    expect(record).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('ne fait rien quand le fournisseur SMS n est pas le relais', async () => {
    const module = await Test.createTestingModule({
      providers: [
        SmsGatewayWatchdogService,
        { provide: SmsGatewayService, useValue: { currentProvider: () => 'twilio', healthCheck } },
        { provide: ErrorLogger, useValue: { record } },
        { provide: EventEmitter2, useValue: { emit } },
      ],
    }).compile();
    await module.get(SmsGatewayWatchdogService).inspect();
    expect(healthCheck).not.toHaveBeenCalled();
  });
});
