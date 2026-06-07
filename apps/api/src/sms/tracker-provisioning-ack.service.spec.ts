import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { AllowlistService } from './allowlist.service';
import type { SmsInboundEvent } from './sms-gateway.service';
import { SmsGatewayService } from './sms-gateway.service';
import { TrackerProvisioningService } from './tracker-provisioning.service';

/**
 * Couvre le coeur "attente d'ACK" : matching tolerant, normalisation des numeros,
 * et le waiter (resolution sur reponse / timeout / annulation). Les helpers prives
 * sont testes via un cast — c'est la logique critique de la sequence.
 */
describe('TrackerProvisioningService — attente d\'ACK', () => {
  let service: TrackerProvisioningService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        TrackerProvisioningService,
        { provide: PrismaService, useValue: {} },
        { provide: SmsGatewayService, useValue: { send: jest.fn(), isEnabled: jest.fn(() => true) } },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: ErrorLogger, useValue: { record: jest.fn() } },
        { provide: AllowlistService, useValue: { add: jest.fn() } },
      ],
    }).compile();
    service = module.get(TrackerProvisioningService);
  });

  const inbound = (fromNumber: string, body: string): SmsInboundEvent => ({
    smsLogId: 'log-1',
    fromNumber,
    toNumber: '+33000000000',
    body,
    receivedAt: '2026-06-07T00:00:00.000Z',
  });

  // Acces aux helpers prives (logique coeur ACK).
  const svc = () =>
    service as unknown as {
      ackMatches(body: string, expect: string): boolean;
      normalizePhone(phone: string): string;
      armReplyWaiter(
        phone: string,
        timeoutMs: number,
      ): { promise: Promise<SmsInboundEvent | null>; cancel: () => void };
    };

  describe('ackMatches', () => {
    it('reconnait le mot-cle attendu, insensible a la casse', () => {
      expect(svc().ackMatches('begin ok!', 'begin')).toBe(true);
      expect(svc().ackMatches('GPRS OK!', 'gprs')).toBe(true);
      expect(svc().ackMatches('adminip ok!', 'adminip')).toBe(true);
    });
    it('accepte un simple "ok" meme sans le mot-cle', () => {
      expect(svc().ackMatches('OK', 'fix')).toBe(true);
    });
    it('refuse une reponse sans rapport', () => {
      expect(svc().ackMatches('low battery 20%', 'fix')).toBe(false);
    });
  });

  describe('normalizePhone', () => {
    it('réduit aux 9 derniers chiffres quel que soit le prefixe', () => {
      const ref = svc().normalizePhone('+33612345678');
      expect(svc().normalizePhone('0033612345678')).toBe(ref);
      expect(svc().normalizePhone('0612345678')).toBe(ref);
      expect(ref).toHaveLength(9);
    });
  });

  describe('waiter de reponse', () => {
    it('se resout avec le SMS entrant quand l\'expediteur correspond (prefixe different)', async () => {
      const waiter = svc().armReplyWaiter('+33612345678', 1000);
      service.onSmsInbound(inbound('0033612345678', 'begin ok!'));
      await expect(waiter.promise).resolves.toMatchObject({ body: 'begin ok!' });
    });

    it('ignore un entrant venant d\'un autre numero (=> timeout null)', async () => {
      const waiter = svc().armReplyWaiter('+33612345678', 40);
      service.onSmsInbound(inbound('+33699999999', 'begin ok!'));
      await expect(waiter.promise).resolves.toBeNull();
    });

    it('se resout a null au timeout', async () => {
      const waiter = svc().armReplyWaiter('+33612345678', 30);
      await expect(waiter.promise).resolves.toBeNull();
    });

    it('se resout a null quand on annule', async () => {
      const waiter = svc().armReplyWaiter('+33612345678', 5000);
      waiter.cancel();
      await expect(waiter.promise).resolves.toBeNull();
    });
  });
});
