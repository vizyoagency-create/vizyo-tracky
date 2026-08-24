import { Test } from '@nestjs/testing';
import { CobanWireLogger } from '../observability/coban-wire-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsGatewayService } from '../sms/sms-gateway.service';
import { SocketRegistryService } from '../socket-registry/socket-registry.service';
import { AckWaiterService } from '../tracker-commands/ack-waiter.service';
import { TrackerFixModeService } from './tracker-fix-mode.service';

describe('TrackerFixModeService.intervalLabel', () => {
  it('formats sub-minute intervals with `s` suffix and zero-padding', () => {
    expect(TrackerFixModeService.intervalLabel(30)).toBe('030s');
    expect(TrackerFixModeService.intervalLabel(45)).toBe('045s');
  });

  // TRK-045 — ce test exigeait `intervalLabel(60) === '001m'`. Passée dans
  // `formatFrequency`, cette forme donnait `,C,01m;` que le firmware lit **1 seconde** :
  // une cible d'une minute partait en demandant une seconde. Le seuil de bascule est
  // remonté à 100 s, donc tout ce qui est exprimable en TCP reste en secondes.
  it('TRK-045 — reste en secondes jusqu\'au plafond de 99 s (jamais `001m` pour 60 s)', () => {
    expect(TrackerFixModeService.intervalLabel(60)).toBe('060s');
    expect(TrackerFixModeService.intervalLabel(99)).toBe('099s');
  });

  it('formats minute-scale intervals with `m` suffix', () => {
    // Au-delà de 99 s la forme en minutes reste juste — mais elle n'est plus atteignable
    // par le pilotage adaptatif, qui est plafonné à HARD_CAP_S = 99 s.
    expect(TrackerFixModeService.intervalLabel(120)).toBe('002m');
    expect(TrackerFixModeService.intervalLabel(300)).toBe('005m');
  });
});

describe('TrackerFixModeService.buildDiagnosticHint', () => {
  const NOW = new Date('2026-04-26T12:00:00Z');

  it('returns null hint for normal first attempt', () => {
    const hint = TrackerFixModeService.buildDiagnosticHint({
      sentViaSocket: true,
      failureCount: 0,
      lastSeenAt: new Date(NOW.getTime() - 5_000),
      lastValidFrameAt: new Date(NOW.getTime() - 30_000),
      desiredIntervalS: 30,
      now: NOW,
    });
    expect(hint).toBeNull();
  });

  it('mentions GPRS coverage when offline > 1h', () => {
    const hint = TrackerFixModeService.buildDiagnosticHint({
      sentViaSocket: false,
      failureCount: 0,
      lastSeenAt: new Date(NOW.getTime() - 90 * 60_000),
      lastValidFrameAt: new Date(NOW.getTime() - 90 * 60_000),
      desiredIntervalS: 30,
      now: NOW,
    });
    expect(hint).toMatch(/offline/);
    expect(hint).toMatch(/GPRS/i);
  });

  it('escalates after 3 consecutive failures', () => {
    const hint = TrackerFixModeService.buildDiagnosticHint({
      sentViaSocket: true,
      failureCount: 3,
      lastSeenAt: new Date(NOW.getTime() - 1_000),
      lastValidFrameAt: new Date(NOW.getTime() - 1_000),
      desiredIntervalS: 30,
      now: NOW,
    });
    expect(hint).toMatch(/3 commandes/);
    expect(hint).toMatch(/RESET123456/);
  });

  it('warns about GPS occlusion when socket is healthy but no valid frame > 30min', () => {
    const hint = TrackerFixModeService.buildDiagnosticHint({
      sentViaSocket: true,
      failureCount: 0,
      lastSeenAt: new Date(NOW.getTime() - 1_000),
      lastValidFrameAt: new Date(NOW.getTime() - 45 * 60_000),
      desiredIntervalS: 30,
      now: NOW,
    });
    expect(hint).toMatch(/antenne GPS/);
  });

  it('flags first-time tracker (lastSeenAt null) when socket unavailable', () => {
    const hint = TrackerFixModeService.buildDiagnosticHint({
      sentViaSocket: false,
      failureCount: 0,
      lastSeenAt: null,
      lastValidFrameAt: null,
      desiredIntervalS: 30,
      now: NOW,
    });
    expect(hint).toMatch(/jamais vu/);
  });
});

describe('TrackerFixModeService.desiredIntervalFor', () => {
  let service: TrackerFixModeService;
  const NOW = new Date('2026-04-26T12:00:00Z');

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        TrackerFixModeService,
        { provide: PrismaService, useValue: {} },
        { provide: SocketRegistryService, useValue: {} },
        { provide: CobanWireLogger, useValue: {} },
        { provide: SmsGatewayService, useValue: { isEnabled: () => false, send: jest.fn() } },
        // TRK-014 — guetteur d'ACK. Un guetteur qui ne resout jamais : ces cas verifient
        // l'ENVOI, pas la reponse du boitier.
        {
          provide: AckWaiterService,
          useValue: { waitForAck: jest.fn().mockReturnValue(new Promise(() => undefined)) },
        },
      ],
    }).compile();
    service = module.get(TrackerFixModeService);
  });

  it('returns 20s for MOVING regardless of ignition history (V1.14 minimum hardware Coban)', () => {
    expect(service.desiredIntervalFor('MOVING', { lastIgnitionChangeAt: null, lastKnownIgnition: false }, NOW))
      .toBe(20);
  });

  it('returns 30s for IDLE_ENGINE_ON (contact ON immobile : pas de gain a 10s)', () => {
    expect(service.desiredIntervalFor('IDLE_ENGINE_ON', { lastIgnitionChangeAt: null, lastKnownIgnition: true }, NOW))
      .toBe(30);
  });

  it('keeps 30s for STOPPED when ignition was OFF less than 10 minutes ago', () => {
    const recentOff = new Date(NOW.getTime() - 5 * 60 * 1000);
    expect(service.desiredIntervalFor('STOPPED', { lastIgnitionChangeAt: recentOff, lastKnownIgnition: false }, NOW))
      .toBe(30);
  });

  // TRK-045 — la cadence d'économie passe de 300 s à 99 s : c'est le maximum que la trame
  // `,C,` sait exprimer sur ce firmware. Demander 300 s n'obtenait pas 300 s, ça obtenait
  // 5 s (`05m` lu « 05 ») — d'où 28 boîtiers à 4-6 s le 2026-08-24.
  it('TRK-045 — passe à 99 s (plafond matériel) pour STOPPED, contact coupé depuis > 10 min', () => {
    const oldOff = new Date(NOW.getTime() - 15 * 60 * 1000);
    expect(service.desiredIntervalFor('STOPPED', { lastIgnitionChangeAt: oldOff, lastKnownIgnition: false }, NOW))
      .toBe(99);
  });

  it('keeps 30s for STOPPED when ignition history is unknown', () => {
    expect(service.desiredIntervalFor('STOPPED', { lastIgnitionChangeAt: null, lastKnownIgnition: null }, NOW))
      .toBe(30);
  });
});

/**
 * Envoi réel : repli SMS + override admin.
 *
 * Deux défauts corrigés ici :
 *  1. le repli SMS (seule primitive FACTURÉE de ce service) partait vers des boîtiers
 *     muets depuis des semaines, où l'alimentation/la SIM ont disparu ;
 *  2. `setManualOverride` effaçait l'indicateur d'échec du boîtier AVANT de savoir si
 *     une commande était partie — l'alerte s'éteignait alors qu'aucun envoi n'avait eu
 *     lieu, et le boîtier muet redevenait invisible.
 */
describe('TrackerFixModeService — envoi réel (repli SMS + override)', () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const TRACKER_ID = '00000000-0000-0000-0000-0000000000aa';

  let service: TrackerFixModeService;
  let prisma: {
    tracker: { update: jest.Mock; findUnique: jest.Mock };
    trackerCommand: { create: jest.Mock; update: jest.Mock; findFirst: jest.Mock; count: jest.Mock };
  };
  let registry: { send: jest.Mock };
  let sms: { isEnabled: jest.Mock; send: jest.Mock };

  /** Tracker FAILING, désaligné (desired 30 ≠ target), avec SIM provisionnée. */
  const tracker = (overrides: { lastSeenAt?: Date | null; failing?: boolean } = {}) => ({
    id: TRACKER_ID,
    imei: '123456789012345',
    simPhoneNumber: '+33656691615',
    lastSeenAt: overrides.lastSeenAt === undefined ? new Date(Date.now() - 30 * 60_000) : overrides.lastSeenAt,
    lastValidFrameAt: null,
    desiredFixIntervalS: 30,
    currentFixIntervalS: 30,
    fixCommandFailureCount: 3,
    fixCommandFailing: overrides.failing ?? true,
    fixModeOverrideUntil: null,
    vehicle: { id: 'v-1', fleetId: 'f-1', plate: 'FV-941-LZ', fleet: { adaptiveFixModeEnabled: true } },
  });

  beforeEach(async () => {
    prisma = {
      tracker: { update: jest.fn().mockResolvedValue({}), findUnique: jest.fn() },
      trackerCommand: {
        create: jest.fn().mockResolvedValue({ id: 'cmd-1' }),
        update: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    registry = { send: jest.fn().mockReturnValue(false) };
    sms = { isEnabled: jest.fn().mockReturnValue(true), send: jest.fn().mockResolvedValue({ ok: true }) };

    const module = await Test.createTestingModule({
      providers: [
        TrackerFixModeService,
        { provide: PrismaService, useValue: prisma },
        { provide: SocketRegistryService, useValue: registry },
        { provide: CobanWireLogger, useValue: { out: jest.fn() } },
        { provide: SmsGatewayService, useValue: sms },
        // TRK-014 — guetteur d'ACK. Un guetteur qui ne resout jamais : ces cas verifient
        // l'ENVOI, pas la reponse du boitier.
        {
          provide: AckWaiterService,
          useValue: { waitForAck: jest.fn().mockReturnValue(new Promise(() => undefined)) },
        },
      ],
    }).compile();
    service = module.get(TrackerFixModeService);
  });

  describe('repli SMS — porte « boîtier muet » (72 h)', () => {
    // Le repli est déjà borné PAR LE BAS (silence > 5 min). On le borne PAR LE HAUT :
    // au-delà de 72 h, le SMS serait facturé pour rien (alimentation/SIM disparues).
    it('n\'envoie aucun SMS à un boîtier muet depuis 89 jours', async () => {
      const out = await service.requestChange(
        tracker({ lastSeenAt: new Date(Date.now() - 89 * DAY), failing: false }) as never,
        300,
        'TEST',
        {},
      );

      expect(sms.send).not.toHaveBeenCalled();
      expect(out?.sent).toBe(false);
    });

    // Entre les deux bornes, le boîtier est joignable : le repli garde tout son sens.
    it('envoie le repli SMS pour un boîtier hors-ligne depuis 30 min', async () => {
      const out = await service.requestChange(
        tracker({ failing: false }) as never,
        300,
        'TEST',
        {},
      );

      expect(sms.send).toHaveBeenCalledWith('+33656691615', expect.any(String), expect.any(Object));
      expect(out?.sent).toBe(true);
    });

    // « Jamais émis » (lastSeenAt null) n'est pas « s'est tu » : le repli reste tenté,
    // c'est même le seul moyen d'atteindre un boîtier jamais connecté en GPRS.
    it('tente quand même le repli pour un boîtier qui n\'a jamais émis', async () => {
      const out = await service.requestChange(
        tracker({ lastSeenAt: null, failing: false }) as never,
        300,
        'TEST',
        {},
      );

      expect(sms.send).toHaveBeenCalled();
      expect(out?.sent).toBe(true);
    });

    // Réintégration : dès que le boîtier reparle, le repli redevient disponible.
    it('réintègre le repli dès que lastSeenAt redevient frais', async () => {
      await service.requestChange(
        tracker({ lastSeenAt: new Date(Date.now() - 89 * DAY), failing: false }) as never,
        300, 'TEST', {},
      );
      expect(sms.send).not.toHaveBeenCalled();

      await service.requestChange(
        tracker({ lastSeenAt: new Date(Date.now() - 10 * 60_000), failing: false }) as never,
        300, 'TEST', {},
      );
      expect(sms.send).toHaveBeenCalledTimes(1);
    });
  });

  describe('setManualOverride — l\'indicateur d\'échec suit l\'envoi RÉEL', () => {
    beforeEach(() => {
      prisma.tracker.findUnique.mockResolvedValue(tracker({ lastSeenAt: new Date() }));
    });

    // LE défaut : le reset partait AVANT l'envoi. Socket fermée + repli impossible
    // (pas de SIM) ⇒ rien n'est parti, donc l'alerte doit RESTER.
    it('ne remet pas le compteur à zéro quand la commande n\'est jamais partie', async () => {
      prisma.tracker.findUnique.mockResolvedValue({
        ...tracker({ lastSeenAt: new Date() }),
        simPhoneNumber: null, // aucun repli SMS possible
      });
      registry.send.mockReturnValue(false);

      const res = await service.setManualOverride(TRACKER_ID, 60, 300, 'user-1');

      expect(res.failingCleared).toBe(false);
      const cleared = prisma.tracker.update.mock.calls.some(
        (c) => c[0]?.data?.fixCommandFailing === false,
      );
      expect(cleared).toBe(false);
    });

    // L'override lui-même reste posé : c'est la décision de l'admin, pas un effet de bord
    // de l'envoi. On ne retire aucune capacité existante.
    it('pose quand même l\'override même si rien n\'est parti', async () => {
      prisma.tracker.findUnique.mockResolvedValue({
        ...tracker({ lastSeenAt: new Date() }),
        simPhoneNumber: null,
      });
      registry.send.mockReturnValue(false);

      const res = await service.setManualOverride(TRACKER_ID, 60, 300, 'user-1');

      expect(res.overrideUntil).not.toBeNull();
      expect(prisma.tracker.update).toHaveBeenCalledWith({
        where: { id: TRACKER_ID },
        data: { fixModeOverrideUntil: expect.any(Date) },
      });
    });

    // Envoi réellement accepté (write TCP) ⇒ là, et seulement là, on acquitte.
    it('remet le compteur à zéro quand la commande est réellement partie', async () => {
      registry.send.mockReturnValue(true);

      const res = await service.setManualOverride(TRACKER_ID, 60, 300, 'user-1');

      expect(res.failingCleared).toBe(true);
      expect(prisma.tracker.update).toHaveBeenCalledWith({
        where: { id: TRACKER_ID },
        data: { fixCommandFailing: false, fixCommandFailureCount: 0 },
      });
    });

    // Poser un simple override, sans commande, ne prouve rien sur le boîtier :
    // l'acquittement explicite garde son chemin dédié (/clear-failing).
    it('n\'acquitte rien quand aucune commande n\'est demandée', async () => {
      const res = await service.setManualOverride(TRACKER_ID, 60, null, 'user-1');

      expect(res.failingCleared).toBe(false);
      expect(res.commandId).toBeNull();
      expect(prisma.tracker.update).toHaveBeenCalledTimes(1); // seul l'override est écrit
    });

    // `force` traverse la porte « boîtier muet » : un humain qui décide de sonder un
    // boîtier silencieux garde ce droit — la porte ne vise que les automates.
    it('laisse l\'override forcé atteindre un boîtier dormant', async () => {
      prisma.tracker.findUnique.mockResolvedValue(
        tracker({ lastSeenAt: new Date(Date.now() - 89 * DAY) }),
      );
      registry.send.mockReturnValue(false);

      const res = await service.setManualOverride(TRACKER_ID, 60, 300, 'user-1');

      expect(sms.send).toHaveBeenCalled();
      expect(res.failingCleared).toBe(true);
    });
  });

  describe("TRK-012 — l'enveloppe suit le canal", () => {
    // ⚠️ TRK-045 — CES DEUX TESTS ATTENDAIENT `,C,05m;` ET `fix005m`, POUR UNE DEMANDE DE
    // 300 s. Ils décrivaient fidèlement le code… et le code demandait 5 SECONDES au boîtier,
    // qui jette la lettre d'unité. `requestChange` plafonne désormais à HARD_CAP_S = 99 s,
    // le seul intervalle lent que la trame `,C,` sache exprimer.
    it('émet la trame TCP `**,imei:…,C,99s;` sur la socket — jamais la forme SMS, jamais de minutes', async () => {
      registry.send.mockReturnValue(true);
      const out = await service.requestChange(tracker({ failing: false }) as never, 300, 'TEST', {});
      expect(registry.send).toHaveBeenCalledWith('123456789012345', '**,imei:123456789012345,C,99s;');
      expect(prisma.trackerCommand.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ payload: '**,imei:123456789012345,C,99s;', channel: 'TCP' }),
        }),
      );
      expect(out?.sent).toBe(true);
    });

    it('TRK-045 — la trame émise ne porte JAMAIS de suffixe `m` ni `h`', async () => {
      // La garde structurelle sur le chemin réel : c'est l'unité jetée par le firmware qui
      // divisait l'intervalle par 60. On la vérifie sur toute la plage demandable.
      registry.send.mockReturnValue(true);
      // 30 s est exclu : c'est la cible COURANTE du boîtier de test, donc `requestChange`
      // n'émet rien (pas de changement à demander) — et un test qui n'émet pas ne prouve rien.
      for (const demande of [20, 60, 99, 120, 300, 3600]) {
        registry.send.mockClear();
        await service.requestChange(
          tracker({ failing: false }) as never, demande, 'TEST', {}, { force: true },
        );
        const trame = registry.send.mock.calls[0]?.[1] as string;
        expect(trame).toMatch(/^\*\*,imei:\d{15},C,\d{2}s;$/);
      }
    });

    it("le repli SMS garde la forme texte ET la consigne dans la ligne d'audit", async () => {
      // registry.send rend false par défaut : la commande bascule sur le SMS. La trame TCP
      // dans un SMS serait TRK-012 en miroir — le firmware ne lit que la forme texte.
      // TRK-045 : la consigne citée est celle réellement demandée (99 s), pas 300 s.
      const out = await service.requestChange(tracker({ failing: false }) as never, 300, 'TEST', {});
      expect(sms.send).toHaveBeenCalledWith('+33656691615', 'fix099s***n123456', expect.any(Object));
      expect(prisma.trackerCommand.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ channel: 'SMS', payload: 'fix099s***n123456' }),
        }),
      );
      expect(out?.sent).toBe(true);
    });
  });

});

/**
 * V1.19 (TRK-007) — une `fix_continuous` n'est jamais acquittée par le boîtier, et la seule
 * fermeture automatique existante dépendait d'une transition FAILING que la garde « véhicule
 * garé » peut empêcher à jamais. L'échéance est donc PUREMENT temporelle.
 */
describe('TrackerFixModeService.expireStaleFixCommands', () => {
  const build = () => {
    const prisma = {
      trackerCommand: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
      tracker: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    } as any;
    const svc = new TrackerFixModeService(
      prisma,
      {} as any,
      {} as any,
      { isEnabled: () => false, send: jest.fn() } as any,
      // TRK-014 — guetteur d'ACK. Ce bloc de tests ne passe jamais par l'envoi, donc
      // un guetteur qui ne résout rien suffit.
      { waitForAck: jest.fn().mockReturnValue(new Promise(() => undefined)) } as any,
    );
    return { svc, prisma };
  };

  const staleCommand = (over: Record<string, unknown> = {}) => ({
    id: 'c1',
    createdAt: new Date(Date.now() - 200 * 60_000), // 200 min
    // TRK-013 — `params.interval` porte la cible DEMANDÉE ; `desiredFixIntervalS` n'est
    // plus chargé par le select (la cible courante du boîtier ne doit plus être citée).
    params: { interval: '020s' },
    tracker: { imei: '864035052915643', currentFixIntervalS: 3600 },
    ...over,
  });

  it('ne cible QUE les commandes de cadence sans accusé, au-delà de l\'échéance', async () => {
    const { svc, prisma } = build();

    await svc.expireStaleFixCommands();

    const where = prisma.trackerCommand.findMany.mock.calls[0][0].where;
    expect(where.templateId).toBe('fix_continuous');
    expect(where.status).toEqual({ in: ['PENDING', 'SENT'] });
    expect(where.acknowledgedAt).toBeNull();
    expect(where.createdAt.lt).toBeInstanceOf(Date);
    // L'échéance ne dépend d'AUCUN état du boîtier : c'est tout l'intérêt du correctif.
    expect(Object.keys(where)).toEqual(['templateId', 'status', 'acknowledgedAt', 'createdAt']);
  });

  it('ferme en FAILED avec la cadence RÉELLEMENT observée', async () => {
    const { svc, prisma } = build();
    prisma.trackerCommand.findMany.mockResolvedValue([staleCommand()]);

    await svc.expireStaleFixCommands();

    expect(prisma.trackerCommand.update).toHaveBeenCalledTimes(1);
    const data = prisma.trackerCommand.update.mock.calls[0][0].data;
    // FAILED et non CANCELLED : la commande a bien été émise, elle n'a pas abouti.
    expect(data.status).toBe('FAILED');
    expect(data.observedResult).toContain('3600s');
    expect(data.observedResult).toContain('20s');
    expect(data.observedResult).toContain('200 min');
  });

  it('dit « inconnue » plutôt que d\'inventer une cadence', async () => {
    const { svc, prisma } = build();
    prisma.trackerCommand.findMany.mockResolvedValue([
      staleCommand({ tracker: { imei: 'x', currentFixIntervalS: null } }),
    ]);

    await svc.expireStaleFixCommands();

    expect(prisma.trackerCommand.update.mock.calls[0][0].data.observedResult).toContain('inconnue');
  });

  describe("TRK-013 — le verdict COMPARE avant d'affirmer", () => {
    it("clôt en ACKNOWLEDGED quand la cadence réelle égale la cible demandée — sans fabriquer d'accusé", async () => {
      const { svc, prisma } = build();
      prisma.trackerCommand.findMany.mockResolvedValue([
        staleCommand({ params: { interval: '020s' }, tracker: { imei: 'x', currentFixIntervalS: 20 } }),
      ]);
      await svc.expireStaleFixCommands();
      const data = prisma.trackerCommand.update.mock.calls[0][0].data;
      expect(data.status).toBe('ACKNOWLEDGED');
      expect(data.observedResult).toContain('Cible atteinte');
      expect(data.observedResult).toContain('20s');
      // ⚠️ TRK-014 mesure « 0 accusé depuis l'origine » via la nullité d'ackedAt : un faux
      // accusé synthétique détruirait cette mesure. La clôture n'écrit QUE status + verdict.
      expect(data.ackedAt).toBeUndefined();
      expect(data.ackResponse).toBeUndefined();
      expect(data.acknowledgedAt).toBeUndefined();
    });

    it("la bande ±20 % de reconcile, pas l'égalité stricte", async () => {
      const { svc, prisma } = build();
      // 21 s pour 20 s demandés : le boîtier honore sa consigne (cas FS-253-HR du 07/08).
      prisma.trackerCommand.findMany.mockResolvedValue([
        staleCommand({ params: { interval: '020s' }, tracker: { imei: 'x', currentFixIntervalS: 21 } }),
        staleCommand({ id: 'c2', params: { interval: '020s' }, tracker: { imei: 'x', currentFixIntervalS: 24 } }),
        staleCommand({ id: 'c3', params: { interval: '020s' }, tracker: { imei: 'x', currentFixIntervalS: 25 } }),
      ]);
      await svc.expireStaleFixCommands();
      const statuts = prisma.trackerCommand.update.mock.calls.map((c: never[]) => (c[0] as { data: { status: string } }).data.status);
      expect(statuts).toEqual(['ACKNOWLEDGED', 'ACKNOWLEDGED', 'FAILED']); // 24 = borne incluse, 25 dehors
    });

    it("cite l'intervalle demandé, jamais la cible courante du boîtier", async () => {
      const { svc, prisma } = build();
      // Cas FS-253-HR du 11:39 : demandé 30 s, le message d'époque disait « cible de 20 s ».
      prisma.trackerCommand.findMany.mockResolvedValue([
        staleCommand({ params: { interval: '030s' }, tracker: { imei: 'x', currentFixIntervalS: 17 } }),
      ]);
      await svc.expireStaleFixCommands();
      const data = prisma.trackerCommand.update.mock.calls[0][0].data;
      expect(data.status).toBe('FAILED');
      expect(data.observedResult).toContain('30s');
      expect(data.observedResult).not.toContain('20s');
    });

    it("une vraie non-conformité reste un échec — le balayage n'est pas supprimé, il est corrigé", async () => {
      const { svc, prisma } = build();
      // Cas EY-613-MF : 3600 s pour 300 s demandés. Un correctif qui ferait tout passer en
      // ACKNOWLEDGED aurait supprimé le balayage, pas le défaut.
      prisma.trackerCommand.findMany.mockResolvedValue([
        staleCommand({ params: { interval: '005m' }, tracker: { imei: 'x', currentFixIntervalS: 3600 } }),
      ]);
      await svc.expireStaleFixCommands();
      const data = prisma.trackerCommand.update.mock.calls[0][0].data;
      expect(data.status).toBe('FAILED');
      expect(data.observedResult).toContain('3600s');
      expect(data.observedResult).toContain('300s');
    });

    it('sans cible demandée lisible, pas de verdict de succès', async () => {
      const { svc, prisma } = build();
      prisma.trackerCommand.findMany.mockResolvedValue([
        staleCommand({ params: { interval: 'garbage' }, tracker: { imei: 'x', currentFixIntervalS: 20 } }),
      ]);
      await svc.expireStaleFixCommands();
      const data = prisma.trackerCommand.update.mock.calls[0][0].data;
      expect(data.status).toBe('FAILED');
      expect(data.observedResult).toContain('illisible');
    });

    it('le select charge params et ne charge plus la cible courante du boîtier', async () => {
      const { svc, prisma } = build();
      await svc.expireStaleFixCommands();
      const select = prisma.trackerCommand.findMany.mock.calls[0][0].select;
      expect(select.params).toBe(true);
      expect(select.tracker.select.desiredFixIntervalS).toBeUndefined();
    });
  });

  describe('intervalSeconds (TRK-013)', () => {
    const { TrackerFixModeService } = require('./tracker-fix-mode.service') as typeof import('./tracker-fix-mode.service');
    it('relit la forme du catalogue', () => {
      expect(TrackerFixModeService.intervalSeconds('020s')).toBe(20);
      expect(TrackerFixModeService.intervalSeconds('030s')).toBe(30);
      expect(TrackerFixModeService.intervalSeconds('005m')).toBe(300);
      expect(TrackerFixModeService.intervalSeconds('010m')).toBe(600);
      expect(TrackerFixModeService.intervalSeconds('060s')).toBe(60);
    });
    it("rend null sur tout ce qui n'est pas une cible — jamais de cible devinée", () => {
      for (const mauvais of [null, undefined, '', '20', 'abc', '000s', 42]) {
        expect(TrackerFixModeService.intervalSeconds(mauvais)).toBeNull();
      }
    });
    it('aller-retour avec intervalLabel', () => {
      for (const x of [20, 30, 300]) {
        expect(TrackerFixModeService.intervalSeconds(TrackerFixModeService.intervalLabel(x))).toBe(x);
      }
    });
  });

  it('respecte FIX_COMMAND_EXPIRY_MIN', async () => {
    const previous = process.env.FIX_COMMAND_EXPIRY_MIN;
    process.env.FIX_COMMAND_EXPIRY_MIN = '120';
    try {
      const { svc, prisma } = build();
      await svc.expireStaleFixCommands();
      const cutoff: Date = prisma.trackerCommand.findMany.mock.calls[0][0].where.createdAt.lt;
      const ageMin = (Date.now() - cutoff.getTime()) / 60_000;
      expect(ageMin).toBeGreaterThan(118);
      expect(ageMin).toBeLessThan(122);
    } finally {
      if (previous === undefined) delete process.env.FIX_COMMAND_EXPIRY_MIN;
      else process.env.FIX_COMMAND_EXPIRY_MIN = previous;
    }
  });

  it('un échec de base ne casse pas le balayage', async () => {
    const { svc, prisma } = build();
    prisma.trackerCommand.findMany.mockRejectedValue(new Error('DB down'));

    await expect(svc.expireStaleFixCommands()).resolves.toBeUndefined();
  });

  it('ramène les cibles héritées dans la plage tenable par le matériel', async () => {
    const { svc, prisma } = build();

    await svc.expireStaleFixCommands();

    // `reconcile` les clampe déjà à la lecture ; on nettoie aussi la valeur STOCKÉE, sinon
    // « cadence cible : 1 s » resterait affiché sur la fiche et recompté à chaque audit.
    expect(prisma.tracker.updateMany).toHaveBeenCalledWith({
      where: { desiredFixIntervalS: { lt: 20 } },
      data: { desiredFixIntervalS: 20 },
    });
    // TRK-045 — le plafond passe de 300 s à 99 s (maximum exprimable dans `,C,`). Ce
    // balayage est donc aussi ce qui RÉPARE le parc sans migration : les cibles héritées à
    // 300 s redescendent à 99 s au prochain passage.
    expect(prisma.tracker.updateMany).toHaveBeenCalledWith({
      where: { desiredFixIntervalS: { gt: 99 } },
      data: { desiredFixIntervalS: 99 },
    });
  });

  it('un échec de normalisation ne casse rien non plus', async () => {
    const { svc, prisma } = build();
    prisma.tracker.updateMany.mockRejectedValue(new Error('DB down'));

    await expect(svc.expireStaleFixCommands()).resolves.toBeUndefined();
  });
});

describe('TrackerFixModeService.reconcile', () => {
  let service: TrackerFixModeService;
  const baseTracker = {
    desiredFixIntervalS: 30,
    currentFixIntervalS: null as number | null,
    fixCommandFailureCount: 0,
    lastValidFrameAt: null as Date | null,
    lastFixIntervalSyncAt: null as Date | null,
  };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        TrackerFixModeService,
        { provide: PrismaService, useValue: {} },
        { provide: SocketRegistryService, useValue: {} },
        { provide: CobanWireLogger, useValue: {} },
        { provide: SmsGatewayService, useValue: { isEnabled: () => false, send: jest.fn() } },
        // TRK-014 — guetteur d'ACK. Un guetteur qui ne resout jamais : ces cas verifient
        // l'ENVOI, pas la reponse du boitier.
        {
          provide: AckWaiterService,
          useValue: { waitForAck: jest.fn().mockReturnValue(new Promise(() => undefined)) },
        },
      ],
    }).compile();
    service = module.get(TrackerFixModeService);
  });

  it('returns no-op when there is no previous frame', () => {
    const out = service.reconcile(baseTracker, {
      deviceTime: new Date(),
      speedKmh: 0,
      ignition: false,
      lat: 48, lng: 2,
    });
    expect(out.nextCurrentFixIntervalS).toBe(null);
    expect(out.nextFailureCount).toBe(0);
    expect(out.nextFailing).toBe(false);
  });

  it('confirms current interval when delta is within ±20% of desired', () => {
    const prev = new Date('2026-04-26T12:00:00Z');
    const next = new Date('2026-04-26T12:00:32Z'); // 32s delta vs target 30s -> within 20%
    const out = service.reconcile(
      { ...baseTracker, desiredFixIntervalS: 30, lastValidFrameAt: prev },
      { deviceTime: next, speedKmh: 5, ignition: true, lat: 48, lng: 2 },
    );
    expect(out.nextCurrentFixIntervalS).toBe(32);
    expect(out.nextFailureCount).toBe(0);
    expect(out.nextFailing).toBe(false);
  });

  it('increments failure count when delta is outside tolerance and no recent sync', () => {
    const prev = new Date('2026-04-26T12:00:00Z');
    const next = new Date('2026-04-26T12:00:30Z'); // 30s observed but desired is 300s
    const out = service.reconcile(
      {
        ...baseTracker,
        desiredFixIntervalS: 300,
        lastValidFrameAt: prev,
        // sync was 10 minutes ago, well past the 2x300s grace
        lastFixIntervalSyncAt: new Date(prev.getTime() - 10 * 60 * 1000),
        fixCommandFailureCount: 1,
      },
      { deviceTime: next, speedKmh: 0, ignition: false, lat: 48, lng: 2 },
    );
    expect(out.nextFailureCount).toBe(2);
    expect(out.nextFailing).toBe(false);
  });

  it('flips fixCommandFailing to true after 3 consecutive misses', () => {
    const prev = new Date('2026-04-26T12:00:00Z');
    const next = new Date('2026-04-26T12:00:30Z');
    const out = service.reconcile(
      {
        ...baseTracker,
        desiredFixIntervalS: 300,
        lastValidFrameAt: prev,
        lastFixIntervalSyncAt: new Date(prev.getTime() - 10 * 60 * 1000),
        fixCommandFailureCount: 2,
      },
      { deviceTime: next, speedKmh: 0, ignition: false, lat: 48, lng: 2 },
    );
    expect(out.nextFailureCount).toBe(3);
    expect(out.nextFailing).toBe(true);
  });

  it('does not increment failure count if a sync was recent (grace window)', () => {
    const prev = new Date('2026-04-26T12:00:00Z');
    const next = new Date('2026-04-26T12:00:30Z');
    const out = service.reconcile(
      {
        ...baseTracker,
        desiredFixIntervalS: 300,
        lastValidFrameAt: prev,
        // sync 1 minute ago — well within 2 * 300s grace
        lastFixIntervalSyncAt: new Date(Date.now() - 60_000),
        fixCommandFailureCount: 1,
      },
      { deviceTime: next, speedKmh: 0, ignition: false, lat: 48, lng: 2 },
    );
    expect(out.nextFailureCount).toBe(1);
    expect(out.nextFailing).toBe(false);
  });

  it('resets failure count to 0 when convergence is observed', () => {
    const prev = new Date('2026-04-26T12:00:00Z');
    const next = new Date('2026-04-26T12:05:05Z'); // 305s ~ target 300s
    const out = service.reconcile(
      {
        ...baseTracker,
        desiredFixIntervalS: 300,
        lastValidFrameAt: prev,
        fixCommandFailureCount: 2,
      },
      { deviceTime: next, speedKmh: 0, ignition: false, lat: 48, lng: 2 },
    );
    expect(out.nextCurrentFixIntervalS).toBe(305);
    expect(out.nextFailureCount).toBe(0);
    expect(out.nextFailing).toBe(false);
  });

  it('caps the failure counter at FAILING_THRESHOLD — no unbounded growth (V1.15)', () => {
    const prev = new Date('2026-04-26T12:00:00Z');
    const next = new Date('2026-04-26T12:06:40Z'); // 400s observé vs desired 30s
    const out = service.reconcile(
      {
        ...baseTracker,
        desiredFixIntervalS: 30,
        lastValidFrameAt: prev,
        lastFixIntervalSyncAt: new Date(prev.getTime() - 10 * 60 * 1000),
        fixCommandFailureCount: 316, // valeur "legacy" non bornée
      },
      // EN MOUVEMENT (contact ON) : l'exemption "véhicule garé" (V1.18) ne
      // s'applique pas, on atteint donc bien la logique de plafonnement.
      { deviceTime: next, speedKmh: 40, ignition: true, lat: 48, lng: 2 },
    );
    expect(out.nextFailureCount).toBe(3); // plafonné, pas 317
    expect(out.nextFailing).toBe(true);
    expect(out.autoAlignDesiredS).toBeNull(); // 400s hors plage [1, 300]
  });

  // --- V1.19 (TRK-008) : la boucle d'auto-alignement -------------------------------------
  //
  // Ce bloc REMPLACE le test « auto-aligns desired to a sub-20s observed interval (V1.15) ».
  // Ce test verrouillait le CONTOURNEMENT : un boîtier rapide était déclaré FAILING, puis on
  // abaissait la cible sur son intervalle réel pour le sortir de cet état. C'est ce
  // contournement qui a produit en prod des cibles à 1 s / 2 s / 8 s, sous le minimum matériel,
  // et 72 commandes en échec par jour pendant des mois. On traite désormais la cause : un
  // boîtier rapide EN MOUVEMENT n'est plus en échec du tout, donc il n'y a plus rien à aligner.

  it('ne déclare PLUS en échec un boîtier qui émet plus vite que la cible EN MOUVEMENT', () => {
    const prev = new Date('2026-04-26T12:00:00Z');
    const next = new Date('2026-04-26T12:00:10Z'); // 10 s observé pour une cible de 97 s
    const out = service.reconcile(
      {
        ...baseTracker,
        desiredFixIntervalS: 97,
        currentFixIntervalS: 10,
        lastValidFrameAt: prev,
        lastFixIntervalSyncAt: new Date(prev.getTime() - 10 * 60 * 1000),
        fixCommandFailureCount: 3, // déjà FAILING : il doit en sortir
      },
      { deviceTime: next, speedKmh: 40, ignition: true, lat: 48, lng: 2 },
    );
    expect(out.nextFailing).toBe(false);
    expect(out.nextFailureCount).toBe(0);
    expect(out.autoAlignDesiredS).toBeNull(); // plus rien à aligner : la cible reste intacte
    expect(out.nextCurrentFixIntervalS).toBe(10); // la cadence réelle reste visible
  });

  it('continue de signaler un boîtier trop rapide À L\'ARRÊT (l\'économie de batterie est réelle)', () => {
    const prev = new Date('2026-04-26T12:00:00Z');
    const next = new Date('2026-04-26T12:00:30Z'); // 30 s observé pour une cible d'économie de 300 s
    const out = service.reconcile(
      {
        ...baseTracker,
        desiredFixIntervalS: 300,
        lastValidFrameAt: prev,
        lastFixIntervalSyncAt: new Date(prev.getTime() - 10 * 60 * 1000),
        fixCommandFailureCount: 1,
      },
      { deviceTime: next, speedKmh: 0, ignition: false, lat: 48, lng: 2 },
    );
    // À l'arrêt la cible vise l'ÉCONOMIE : émettre dix fois trop vite y contrevient vraiment.
    // Une garde non restreinte au mouvement aurait silencieusement annulé cette économie.
    expect(out.nextFailureCount).toBe(2);
  });

  it('une cible héritée sous le minimum matériel ne condamne plus le boîtier', () => {
    const prev = new Date('2026-04-26T12:00:00Z');
    const next = new Date('2026-04-26T12:00:20Z'); // le boîtier émet à son minimum : 20 s
    const out = service.reconcile(
      {
        ...baseTracker,
        desiredFixIntervalS: 8, // valeur absurde laissée par l'ancien auto-alignement
        lastValidFrameAt: prev,
        lastFixIntervalSyncAt: new Date(prev.getTime() - 10 * 60 * 1000),
        fixCommandFailureCount: 2,
      },
      { deviceTime: next, speedKmh: 50, ignition: true, lat: 48, lng: 2 },
    );
    // La cible effective est clampée à 20 s : le boîtier est donc PILE dessus. C'est le cas
    // dominant en prod — 295 des 507 échecs portaient « intervalle observé : 20 s ».
    expect(out.nextFailureCount).toBe(0);
    expect(out.nextFailing).toBe(false);
  });

  it('l\'auto-alignement ne peut plus écrire une cible sous le minimum matériel', () => {
    const prev = new Date('2026-04-26T12:00:00Z');
    const next = new Date('2026-04-26T12:00:05Z'); // 5 s observé, à l'arrêt, cible 300 s
    const out = service.reconcile(
      {
        ...baseTracker,
        desiredFixIntervalS: 300,
        lastValidFrameAt: prev,
        lastFixIntervalSyncAt: new Date(prev.getTime() - 10 * 60 * 1000),
        fixCommandFailureCount: 2, // la 3e trame fait basculer en FAILING
      },
      { deviceTime: next, speedKmh: 0, ignition: false, lat: 48, lng: 2 },
    );
    expect(out.nextFailing).toBe(true);
    // 5 s est sous le plancher : on refuse d'en faire une cible. C'est la garde qui manquait.
    expect(out.autoAlignDesiredS).toBeNull();
  });

  it('l\'auto-alignement reste possible sur un intervalle tenable', () => {
    const prev = new Date('2026-04-26T12:00:00Z');
    const next = new Date('2026-04-26T12:01:30Z'); // 90 s observé pour une cible de 30 s
    const out = service.reconcile(
      {
        ...baseTracker,
        desiredFixIntervalS: 30,
        lastValidFrameAt: prev,
        lastFixIntervalSyncAt: new Date(prev.getTime() - 10 * 60 * 1000),
        fixCommandFailureCount: 2,
      },
      { deviceTime: next, speedKmh: 50, ignition: true, lat: 48, lng: 2 },
    );
    expect(out.nextFailing).toBe(true);
    // TRK-045 — la plage tenable est [20, 99] s, plus [20, 300] : au-delà de 99 s le
    // boîtier ne sait pas exprimer la cible, donc s'aligner dessus écrirait une consigne
    // inatteignable. Le cas « 250 s observé » était l'ancienne valeur de ce test.
    expect(out.autoAlignDesiredS).toBe(90); // dans [20, 99] : on accepte le comportement réel
  });

  // V1.18 — Exemption "véhicule garé" : un boîtier qui émet plus lentement que la
  // cible alors qu'il est à l'arrêt (contact coupé) est en veille ACC OFF, pas en
  // échec. Corrige le faux positif observé en prod (3 trackers garés, réel ~3600s).
  it('does not flag FAILING when a parked vehicle reports slower than target (ACC-OFF heartbeat)', () => {
    const prev = new Date('2026-04-26T12:00:00Z');
    const next = new Date('2026-04-26T13:00:01Z'); // ~3600s observé vs cible 300s
    const out = service.reconcile(
      {
        ...baseTracker,
        desiredFixIntervalS: 300,
        lastValidFrameAt: prev,
        lastFixIntervalSyncAt: new Date(prev.getTime() - 60 * 60 * 1000),
        fixCommandFailureCount: 2,
      },
      { deviceTime: next, speedKmh: 0, ignition: false, lat: 48, lng: 2 },
    );
    expect(out.nextCurrentFixIntervalS).toBe(3601); // on enregistre quand même le réel
    expect(out.nextFailureCount).toBe(0);
    expect(out.nextFailing).toBe(false);
    expect(out.autoAlignDesiredS).toBeNull();
  });

  it('auto-heals an already-FAILING parked tracker on the next frame (resets count + flag)', () => {
    const prev = new Date('2026-04-26T12:00:00Z');
    const next = new Date('2026-04-26T13:00:00Z'); // 3600s, cible périmée 10s
    const out = service.reconcile(
      {
        ...baseTracker,
        desiredFixIntervalS: 10, // valeur périmée (ancien auto-align en mouvement)
        lastValidFrameAt: prev,
        lastFixIntervalSyncAt: new Date(prev.getTime() - 60 * 60 * 1000),
        fixCommandFailureCount: 3, // déjà FAILING
      },
      { deviceTime: next, speedKmh: 0, ignition: false, lat: 48, lng: 2 },
    );
    expect(out.nextFailing).toBe(false);
    expect(out.nextFailureCount).toBe(0);
  });

  it('treats unknown-ignition + near-zero speed as parked (install sans fil ACC)', () => {
    const prev = new Date('2026-04-26T12:00:00Z');
    const next = new Date('2026-04-26T13:00:00Z');
    const out = service.reconcile(
      {
        ...baseTracker,
        desiredFixIntervalS: 300,
        lastValidFrameAt: prev,
        lastFixIntervalSyncAt: new Date(prev.getTime() - 60 * 60 * 1000),
        fixCommandFailureCount: 3,
      },
      { deviceTime: next, speedKmh: 0, ignition: undefined, lat: 48, lng: 2 },
    );
    expect(out.nextFailing).toBe(false);
  });

  it('still flags a MOVING vehicle reporting slower than target (exemption ne s\'applique pas)', () => {
    const prev = new Date('2026-04-26T12:00:00Z');
    const next = new Date('2026-04-26T12:06:40Z'); // 400s observé vs cible 30s, en mouvement
    const out = service.reconcile(
      {
        ...baseTracker,
        desiredFixIntervalS: 30,
        lastValidFrameAt: prev,
        lastFixIntervalSyncAt: new Date(prev.getTime() - 10 * 60 * 1000),
        fixCommandFailureCount: 2,
      },
      { deviceTime: next, speedKmh: 50, ignition: true, lat: 48, lng: 2 },
    );
    expect(out.nextFailureCount).toBe(3);
    expect(out.nextFailing).toBe(true);
  });
});

/**
 * TRK-014 (2026-08-10) — le chemin adaptatif n'a JAMAIS écouté la réponse du boîtier.
 *
 * Sur 4071 commandes émises depuis le 2026-04-27, `ackedAt` et `ackResponse` étaient NULL
 * sans une seule exception. On en concluait que « le Coban n'accuse pas réception » ; en
 * réalité personne n'avait jamais armé le guetteur. Le motif et le délai existaient déjà
 * au catalogue.
 *
 * ⚠️ Le test qui compte le plus est le dernier : l'ACK **informe**, il ne clôture rien.
 * Reconditionner la fin de vie d'une commande à une réponse du boîtier rouvrirait
 * exactement TRK-007 — un boîtier muet laisserait des commandes ouvertes à vie.
 */
describe('TrackerFixModeService — écoute de l’accusé de réception (TRK-014)', () => {
  const IMEI = '864035054757027';

  const build = (ack: { resolve?: string; reject?: boolean } = {}) => {
    const created = { id: 'cmd-1' };
    const updates: Record<string, unknown>[] = [];
    const prisma = {
      trackerCommand: {
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(created),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          return {};
        }),
      },
      tracker: { update: jest.fn().mockResolvedValue({}) },
    } as any;

    const waitForAck = jest.fn().mockImplementation(() => {
      if (ack.resolve !== undefined) return Promise.resolve(ack.resolve);
      if (ack.reject) return Promise.reject(new Error('ACK timeout after 15000ms'));
      return new Promise(() => undefined); // jamais résolu
    });
    const wireLogger = { out: jest.fn(), ackMatch: jest.fn(), ackTimeout: jest.fn() } as any;

    const svc = new TrackerFixModeService(
      prisma,
      { send: jest.fn().mockReturnValue(true) } as any, // socket TCP disponible
      wireLogger,
      { isEnabled: () => false, send: jest.fn() } as any,
      { waitForAck } as any,
    );
    return { svc, prisma, updates, waitForAck, wireLogger };
  };

  const tracker = () =>
    ({
      id: 't1',
      imei: IMEI,
      desiredFixIntervalS: 20,
      currentFixIntervalS: 20,
      fixCommandFailing: false,
      fixCommandFailureCount: 0,
      lastSeenAt: new Date(),
      lastValidFrameAt: new Date(),
      simPhoneNumber: null,
      vehicle: { fleet: { adaptiveFixModeEnabled: true } },
    }) as any;

  /** Laisse tourner les promesses d'arrière-plan du guetteur. */
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('arme le guetteur avec le motif et le délai du catalogue', async () => {
    const { svc, waitForAck } = build();
    await svc.requestChange(tracker(), 300, 'TEST', {});

    expect(waitForAck).toHaveBeenCalledTimes(1);
    const [imei, pattern, timeoutMs, commandId] = waitForAck.mock.calls[0];
    expect(imei).toBe(IMEI);
    expect(pattern.source).toBe('fix.*ok');
    expect(timeoutMs).toBe(15000);
    expect(commandId).toBe('cmd-1');
  });

  it('enregistre l’accusé quand le boîtier répond enfin', async () => {
    const { svc, updates, wireLogger } = build({ resolve: 'fix ok' });
    await svc.requestChange(tracker(), 300, 'TEST', {});
    await flush();

    const ackUpdate = updates.find((u) => u['ackResponse'] !== undefined);
    expect(ackUpdate).toBeDefined();
    expect(ackUpdate!['ackResponse']).toBe('fix ok');
    expect(ackUpdate!['ackedAt']).toBeInstanceOf(Date);
    expect(wireLogger.ackMatch).toHaveBeenCalledTimes(1);
  });

  it('trace le SILENCE du boîtier — une mesure, pas un incident', async () => {
    const { svc, updates, wireLogger } = build({ reject: true });
    await svc.requestChange(tracker(), 300, 'TEST', {});
    await flush();

    expect(wireLogger.ackTimeout).toHaveBeenCalledTimes(1);
    const hint = updates.find((u) => typeof u['diagnosticHint'] === 'string' && String(u['diagnosticHint']).includes('Aucune réponse'));
    expect(hint).toBeDefined();
  });

  it('🔑 NE CHANGE JAMAIS le statut de la commande — ni sur ACK, ni sur silence', async () => {
    // C'est la leçon de TRK-007. La fin de vie d'une commande reste PUREMENT temporelle :
    // si le boîtier se tait, l'échéance ferme ; s'il répond, l'information s'ajoute.
    for (const scenario of [{ resolve: 'fix ok' }, { reject: true }]) {
      const { svc, updates } = build(scenario);
      await svc.requestChange(tracker(), 300, 'TEST', {});
      const before = updates.length;
      await flush();

      const afterSend = updates.slice(before - 1 < 0 ? 0 : before);
      for (const u of afterSend) {
        expect(u['status']).toBeUndefined();
      }
    }
  });
});
