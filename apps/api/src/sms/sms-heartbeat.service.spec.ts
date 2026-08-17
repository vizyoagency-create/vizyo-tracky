import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsGatewayService } from './sms-gateway.service';
import { SmsHeartbeatService } from './sms-heartbeat.service';

describe('SmsHeartbeatService', () => {
  let service: SmsHeartbeatService;
  let send: jest.Mock;
  let reconcile: jest.Mock;
  let record: jest.Mock;
  let findMany: jest.Mock;
  let recipientsEnv: string;

  beforeEach(async () => {
    recipientsEnv = '';
    // La passerelle rend `queued` à la soumission : c'est le comportement RÉEL de production,
    // et c'est lui qui doit servir de défaut dans les tests — sinon on teste un monde qui
    // n'existe pas (TRK-026).
    send = jest.fn().mockResolvedValue({
      ok: true,
      outcome: 'accepted',
      submittedStatus: 'queued',
      smsLogId: 'log-1',
    });
    reconcile = jest.fn().mockImplementation((id: string) =>
      Promise.resolve({ outcome: 'accepted', status: 'queued', id }),
    );
    record = jest.fn().mockResolvedValue('error-log-id');
    findMany = jest.fn().mockResolvedValue([]);

    const module = await Test.createTestingModule({
      providers: [
        SmsHeartbeatService,
        {
          provide: SmsGatewayService,
          useValue: {
            send,
            reconcileOutboundStatus: reconcile,
            currentProvider: () => 'vizyo-texto',
          },
        },
        { provide: ErrorLogger, useValue: { record } },
        { provide: PrismaService, useValue: { smsLog: { findMany } } },
        { provide: ConfigService, useValue: { get: () => recipientsEnv } },
      ],
    }).compile();
    service = module.get(SmsHeartbeatService);
  });

  describe('envoi', () => {
    it('skips (no-op safe) when no recipient is configured', async () => {
      recipientsEnv = '';
      const result = await service.runHeartbeat();
      expect(result.skipped).toBe(true);
      expect(result.recipients).toBe(0);
      expect(send).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('parses a CSV of recipients, trimming blanks', () => {
      recipientsEnv = ' +33656691615 , ,+33687654321 ';
      expect(service.recipients()).toEqual(['+33656691615', '+33687654321']);
    });

    it('sends one heartbeat SMS per recipient, avec le modèle typé gateway_heartbeat', async () => {
      recipientsEnv = '+33656691615,+33687654321';
      const result = await service.runHeartbeat();

      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledWith(
        '+33656691615',
        expect.stringContaining('[Vizyo Tracky] Test de chaine SMS'),
        { template: 'gateway_heartbeat', source: 'sms-heartbeat' },
      );
      expect(result.skipped).toBe(false);
      expect(result.sent).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.smsLogIds).toEqual(['log-1', 'log-1']);
    });

    it("le corps n'AFFIRME plus que la chaîne est saine (TRK-026)", async () => {
      recipientsEnv = '+33656691615';
      await service.runHeartbeat();
      const body = send.mock.calls[0]![1] as string;
      // L'ancien texte « chaine SMS OK » se lisait comme un constat alors qu'il n'était
      // qu'un envoi tenté — transporté par la chaîne même qu'il prétendait valider.
      expect(body).not.toContain('chaine SMS OK');
      expect(body).toContain('si vous lisez ceci');
    });

    it("n'écrit AUCUN ErrorLog quand la passerelle accepte — accepté n'est pas remis", async () => {
      recipientsEnv = '+33656691615';
      const result = await service.runHeartbeat();
      // C'était le défaut : `ok: true` sur un `queued` était compté comme un succès prouvé.
      // L'envoi ne conclut plus rien du tout ; le verdict appartient à la vérification.
      expect(result.sent).toBe(1);
      expect(record).not.toHaveBeenCalled();
    });

    it('records a CRITICAL ErrorLog quand la soumission est REFUSÉE', async () => {
      recipientsEnv = '+33656691615';
      send.mockResolvedValueOnce({ ok: false, outcome: 'failed', error: 'relay 403' });

      const result = await service.runHeartbeat();

      expect(result.failed).toBe(1);
      expect(result.sent).toBe(0);
      expect(record).toHaveBeenCalledWith(
        expect.stringContaining('+33656691615'),
        'sms-heartbeat',
        expect.objectContaining({ toNumber: '+33656691615', error: 'relay 403', phase: 'submit' }),
        'CRITICAL',
      );
    });
  });

  describe('vérification différée — TRK-026', () => {
    const at = (min: number) => new Date(Date.now() - min * 60_000);

    it('rend SANS_OBJET quand aucun destinataire n’est configuré', async () => {
      recipientsEnv = '';
      const v = await service.verifyHeartbeat();
      expect(v.verdict).toBe('SANS_OBJET');
      expect(findMany).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it("rend INDETERMINE — et l'écrit — quand tout est resté en queued", async () => {
      recipientsEnv = '+33656691615';
      findMany.mockResolvedValue([{ id: 'log-1', status: 'queued', toNumber: '+336', createdAt: at(20) }]);

      const v = await service.verifyHeartbeat();

      expect(v.verdict).toBe('INDETERMINE');
      expect(v.indeterminate).toBe(1);
      expect(v.delivered).toBe(0);
      // Le point de la fiche : ne plus présenter comme acquis ce qu'on ne peut pas mesurer.
      expect(record).toHaveBeenCalledWith(
        expect.stringContaining('INDETERMINEE'),
        'sms-heartbeat',
        expect.objectContaining({ phase: 'verify', indeterminate: 1 }),
        'ERROR',
      );
    });

    it('rend OK et reste MUET quand un message est prouvé remis', async () => {
      recipientsEnv = '+33656691615';
      findMany.mockResolvedValue([{ id: 'log-1', status: 'queued', toNumber: '+336', createdAt: at(20) }]);
      reconcile.mockResolvedValue({ outcome: 'delivered', status: 'delivered' });

      const v = await service.verifyHeartbeat();

      expect(v.verdict).toBe('OK');
      expect(v.delivered).toBe(1);
      // Un canal sain ne doit rien écrire : le silence est la preuve.
      expect(record).not.toHaveBeenCalled();
    });

    it('rend ECHEC en CRITICAL quand un message est refusé', async () => {
      recipientsEnv = '+33656691615';
      findMany.mockResolvedValue([{ id: 'log-1', status: 'failed', toNumber: '+336', createdAt: at(20) }]);
      reconcile.mockResolvedValue({ outcome: 'failed', status: 'failed' });

      const v = await service.verifyHeartbeat();

      expect(v.verdict).toBe('ECHEC');
      expect(record).toHaveBeenCalledWith(
        expect.stringContaining('ECHEC'),
        'sms-heartbeat',
        expect.objectContaining({ phase: 'verify', failed: 1 }),
        'CRITICAL',
      );
    });

    it('🔑 rend NON_EMIS quand le cron d’envoi n’a pas tourné — cas que rien ne couvrait', async () => {
      recipientsEnv = '+33656691615';
      findMany.mockResolvedValue([]);

      const v = await service.verifyHeartbeat();

      // Un heartbeat ABSENT et un heartbeat NON REMIS se ressemblent quand on ne regarde
      // que les erreurs : c'est précisément pour ça qu'il faut le distinguer explicitement.
      expect(v.verdict).toBe('NON_EMIS');
      expect(record).toHaveBeenCalledWith(
        expect.stringContaining('NON EMISE'),
        'sms-heartbeat',
        expect.objectContaining({ phase: 'verify' }),
        'CRITICAL',
      );
    });

    it('ne réécrit jamais un statut déjà terminal (une preuve ne se dégrade pas)', async () => {
      recipientsEnv = '+33656691615';
      findMany.mockResolvedValue([
        { id: 'log-1', status: 'delivered', toNumber: '+336', createdAt: at(30) },
        { id: 'log-2', status: 'queued', toNumber: '+337', createdAt: at(25) },
      ]);
      reconcile.mockImplementation((id: string) =>
        Promise.resolve(
          id === 'log-1'
            ? { outcome: 'delivered', status: 'delivered' }
            : { outcome: 'accepted', status: 'queued' },
        ),
      );

      const v = await service.verifyHeartbeat();

      expect(v.checked).toBe(2);
      expect(v.delivered).toBe(1);
      expect(v.indeterminate).toBe(1);
      // Un seul message prouvé suffit à conclure OK : la chaîne a fonctionné.
      expect(v.verdict).toBe('OK');
    });
  });
});
