import { Test } from '@nestjs/testing';
import { TrackerCommandStatus } from '@prisma/client';
import { CobanWireLogger } from '../observability/coban-wire-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { SmsGatewayService } from '../sms/sms-gateway.service';
import { SocketRegistryService } from '../socket-registry/socket-registry.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { AckWaiterService } from './ack-waiter.service';
import { TRACKER_COMMAND_SMS_EXPIRY_MS, TrackerCommandsService } from './tracker-commands.service';

/**
 * ── TRK-062 / T5 (2026-09-13) — UNE COMMANDE PARTIE EN SMS A ENFIN UN ÉTAT TERMINAL ────────
 *
 * Deux commandes `shock_on` / `shock_off` du 1er septembre sont restées `SENT` pendant 298 h :
 * +24,0 h par jour, jamais fermées, résidentes permanentes de l'écran des commandes en attente.
 * Le choix de ne PAS guetter d'accusé sur le canal SMS est juste (une réponse réelle mesurée à
 * presque quatre heures le 19/08) ; ce qui manquait est une BORNE SUPÉRIEURE. Jumeau exact de
 * TRK-018 sur les commandes moteur (`SENT_UNCONFIRMED`, 30 min), avec la référence propre au
 * canal SMS : quatre heures.
 *
 * ⚠️ « Non confirmée » n'est pas « échouée » : la commande est bel et bien partie, et nul ne sait.
 */
describe('TRK-062 — clôture des commandes de boîtier parties en SMS sans réponse', () => {
  let service: TrackerCommandsService;
  let updateMany: jest.Mock;

  beforeEach(async () => {
    updateMany = jest.fn().mockResolvedValue({ count: 2 });
    const module = await Test.createTestingModule({
      providers: [
        TrackerCommandsService,
        { provide: PrismaService, useValue: { trackerCommand: { updateMany }, tracker: {} } },
        { provide: SocketRegistryService, useValue: { send: jest.fn() } },
        { provide: AckWaiterService, useValue: { waitForAck: jest.fn() } },
        { provide: CobanWireLogger, useValue: { out: jest.fn(), ackMatch: jest.fn(), ackTimeout: jest.fn() } },
        { provide: RealtimeGateway, useValue: { server: { to: jest.fn().mockReturnThis(), emit: jest.fn() } } },
        { provide: SystemActivityService, useValue: { record: jest.fn() } },
        { provide: SmsGatewayService, useValue: { isEnabled: jest.fn().mockReturnValue(true), send: jest.fn() } },
      ],
    }).compile();
    service = module.get(TrackerCommandsService);
  });

  it('la borne est de quatre heures — la référence mesurée du canal SMS, jamais quinze secondes', () => {
    expect(TRACKER_COMMAND_SMS_EXPIRY_MS).toBe(4 * 3_600_000);
  });

  it('⚠️ ne ferme QUE les commandes SENT parties par SMS et plus vieilles que la borne, en SENT_UNCONFIRMED daté', async () => {
    const now = Date.UTC(2026, 8, 13, 20, 0);
    const n = await service.cloturerCommandesSmsSansReponse(now);
    expect(n).toBe(2);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        status: TrackerCommandStatus.SENT,
        channel: 'SMS',
        ackedAt: null,
        sentAt: { lt: new Date(now - TRACKER_COMMAND_SMS_EXPIRY_MS) },
      },
      data: { status: TrackerCommandStatus.SENT_UNCONFIRMED, expiredAt: new Date(now) },
    });
  });

  it('une base qui refuse ne tue pas le cron : 0, et rien ne remonte', async () => {
    updateMany.mockRejectedValueOnce(new Error('connection lost'));
    await expect(service.cloturerCommandesSmsSansReponse()).resolves.toBe(0);
  });
});
