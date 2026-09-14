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
  let update: jest.Mock;
  let recipientsEnv: string;
  /** T45 — destinataire de la preuve quotidienne (SMS_DAILY_PROOF_RECIPIENT). */
  let dailyRecipientEnv: string;

  beforeEach(async () => {
    recipientsEnv = '';
    dailyRecipientEnv = '';
    update = jest.fn().mockResolvedValue({});
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
        { provide: PrismaService, useValue: { smsLog: { findMany, update } } },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => (key === 'SMS_DAILY_PROOF_RECIPIENT' ? dailyRecipientEnv : recipientsEnv) },
        },
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

  /**
   * ── T45 (contre-expertise du 13/09, P1-3) — la preuve QUOTIDIENNE ──────────────────────────
   * L'interlock exige une remise prouvée de moins de 24 h ; la seule source était la preuve de vie
   * du lundi : coupes refusées six jours sur sept. Deux passages par jour, T-30 des fenêtres.
   */
  describe('preuve quotidienne — T45', () => {
    const at = (min: number) => new Date(Date.now() - min * 60_000);
    const PREFIX = '[Vizyo Tracky] Preuve quotidienne de la chaine SMS';

    it('sans SMS_DAILY_PROOF_RECIPIENT : no-op safe, rien envoyé, rien écrit', async () => {
      recipientsEnv = '+33656691615'; // la preuve HEBDO est configurée, pas la quotidienne
      const result = await service.runHeartbeat('quotidien');
      expect(result.skipped).toBe(true);
      expect(send).not.toHaveBeenCalled();
      const v = await service.verifyHeartbeat(new Date(), 'quotidien');
      expect(v).toMatchObject({ kind: 'quotidien', verdict: 'SANS_OBJET', echo: 0 });
      expect(record).not.toHaveBeenCalled();
    });

    it('envoie UN SMS au numéro neutre, avec le modèle gateway_daily_proof et la source sms-daily-proof — jamais aux admins', async () => {
      recipientsEnv = '+33656691615,+33687654321';
      dailyRecipientEnv = ' +33700000000 ';
      const result = await service.runHeartbeat('quotidien');
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(
        '+33700000000',
        expect.stringContaining(PREFIX),
        { template: 'gateway_daily_proof', source: 'sms-daily-proof' },
      );
      expect(send.mock.calls[0][1]).toContain('ne pas repondre');
      expect(result).toMatchObject({ recipients: 1, sent: 1, failed: 0, skipped: false });
    });

    it('la preuve hebdo garde son modèle et ses destinataires — deux sondes, un code', async () => {
      recipientsEnv = '+33656691615';
      dailyRecipientEnv = '+33700000000';
      await service.runHeartbeat();
      expect(send).toHaveBeenCalledWith('+33656691615', expect.stringContaining('Test de chaine SMS'), { template: 'gateway_heartbeat', source: 'sms-heartbeat' });
    });

    it('un refus de soumission de la preuve quotidienne dit la conséquence : coupes refusées ce soir', async () => {
      dailyRecipientEnv = '+33700000000';
      send.mockResolvedValue({ ok: false, outcome: 'failed', error: 'relais 503' });
      const result = await service.runHeartbeat('quotidien');
      expect(result.failed).toBe(1);
      expect(record).toHaveBeenCalledWith(
        expect.stringContaining('coupes automatiques du soir seront refusees'),
        'sms-daily-proof',
        expect.objectContaining({ phase: 'submit', kind: 'quotidien', error: 'relais 503' }),
        'CRITICAL',
      );
    });

    it('la vérification relit gateway_daily_proof sur 30 min (pas 3 h) et rend OK, muette, sur remise prouvée', async () => {
      dailyRecipientEnv = '+33700000000';
      findMany
        .mockResolvedValueOnce([{ id: 'log-1', status: 'queued', toNumber: '+337', createdAt: at(15), body: `${PREFIX} x` }])
        .mockResolvedValueOnce([]); // aucun écho entrant
      reconcile.mockResolvedValue({ outcome: 'delivered', status: 'delivered' });
      const now = new Date();

      const v = await service.verifyHeartbeat(now, 'quotidien');

      expect(v).toMatchObject({ kind: 'quotidien', verdict: 'OK', delivered: 1, echo: 0 });
      const where = findMany.mock.calls[0][0].where;
      expect(where.template).toBe('gateway_daily_proof');
      expect(now.getTime() - (where.createdAt.gte as Date).getTime()).toBe(30 * 60_000);
      expect(record).not.toHaveBeenCalled();
    });

    it('🔑 l ÉCHO entrant prouve la remise : le sortant resté « accepté » est marqué received et compte comme remis', async () => {
      dailyRecipientEnv = '+33700000000';
      const body = `${PREFIX} 2026-09-14T02:30:00.000Z via vizyo-texto — ne pas repondre.`;
      findMany
        .mockResolvedValueOnce([{ id: 'log-1', status: 'queued', toNumber: '+337', createdAt: at(15), body }])
        .mockResolvedValueOnce([{ body }]); // le téléphone passerelle a reçu son propre SMS
      const now = new Date();

      const v = await service.verifyHeartbeat(now, 'quotidien');

      expect(findMany.mock.calls[1][0].where).toMatchObject({ direction: 'IN', body: { startsWith: PREFIX } });
      expect(update).toHaveBeenCalledWith({ where: { id: 'log-1' }, data: { status: 'received', statusUpdatedAt: now } });
      expect(v).toMatchObject({ verdict: 'OK', delivered: 1, echo: 1, indeterminate: 0 });
      expect(record).not.toHaveBeenCalled();
    });

    it('un écho dont le corps ne correspond à aucun sortant ne prouve rien', async () => {
      dailyRecipientEnv = '+33700000000';
      findMany
        .mockResolvedValueOnce([{ id: 'log-1', status: 'queued', toNumber: '+337', createdAt: at(15), body: `${PREFIX} A` }])
        .mockResolvedValueOnce([{ body: `${PREFIX} B` }]);
      const v = await service.verifyHeartbeat(new Date(), 'quotidien');
      expect(update).not.toHaveBeenCalled();
      expect(v).toMatchObject({ verdict: 'INDETERMINE', echo: 0, indeterminate: 1 });
    });

    it('INDETERMINE quotidien : une ligne ERROR sous sms-daily-proof qui dit la conséquence pour le soir', async () => {
      dailyRecipientEnv = '+33700000000';
      findMany.mockResolvedValueOnce([{ id: 'log-1', status: 'queued', toNumber: '+337', createdAt: at(15), body: `${PREFIX} x` }]).mockResolvedValueOnce([]);
      const v = await service.verifyHeartbeat(new Date(), 'quotidien');
      expect(v.verdict).toBe('INDETERMINE');
      expect(record).toHaveBeenCalledWith(
        expect.stringMatching(/Preuve SMS quotidienne INDETERMINEE.*coupes automatiques de ce soir/s),
        'sms-daily-proof',
        expect.objectContaining({ phase: 'verify', kind: 'quotidien', indeterminate: 1, echo: 0 }),
        'ERROR',
      );
    });

    it('NON_EMIS quotidien : le cron d envoi n a pas tourné — CRITICAL sous sms-daily-proof', async () => {
      dailyRecipientEnv = '+33700000000';
      findMany.mockResolvedValue([]);
      const v = await service.verifyHeartbeat(new Date(), 'quotidien');
      expect(v.verdict).toBe('NON_EMIS');
      expect(record).toHaveBeenCalledWith(
        expect.stringContaining('Preuve SMS quotidienne NON EMISE'),
        'sms-daily-proof',
        expect.objectContaining({ phase: 'verify', kind: 'quotidien', windowMinutes: 30 }),
        'CRITICAL',
      );
    });

    it('les crons quotidiens appellent bien la sonde quotidienne (envoi puis verdict)', async () => {
      dailyRecipientEnv = '+33700000000';
      const run = jest.spyOn(service, 'runHeartbeat');
      const verify = jest.spyOn(service, 'verifyHeartbeat');
      await service.runDailyProofScheduled();
      await service.verifyDailyProofScheduled();
      expect(run).toHaveBeenCalledWith('quotidien');
      expect(verify).toHaveBeenCalledWith(expect.any(Date), 'quotidien');
    });
  });
});
