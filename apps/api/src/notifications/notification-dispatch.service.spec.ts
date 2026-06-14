import { Test } from '@nestjs/testing';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsGatewayService } from '../sms/sms-gateway.service';
import { NotificationDispatchService } from './notification-dispatch.service';
import { WebPushService } from './web-push.service';

/**
 * V1.15 — Canal SMS du dispatch d'alertes. Teste le chemin SMS via le point
 * d'entree public dispatchAlert() : une regle avec channel 'SMS' + un
 * destinataire avec phone => SmsGatewayService.send() avec context
 * source='alert-notification', plus le throttle anti-flood et le skip sans phone.
 */
describe('NotificationDispatchService — canal SMS (V1.15)', () => {
  let dispatch: NotificationDispatchService;
  let send: jest.Mock;
  let smsLogFindFirst: jest.Mock;
  let ruleFindMany: jest.Mock;
  let userFindMany: jest.Mock;

  const alert = {
    id: 'a1',
    fleetId: 'f1',
    vehicleId: 'v1',
    type: 'OVERSPEED',
    severity: 'CRITICAL',
    title: 'Exces de vitesse',
    message: 'V > 130 km/h',
    createdAt: new Date('2026-06-07T12:23:00Z'),
    acknowledgedAt: null,
    escalatedAt: null,
    vehicle: { plate: 'TE002ST' },
  };

  const recipient = {
    id: 'u1',
    email: 'admin@fleet.test',
    phone: '+33656691615',
    fleetId: 'f1',
    isActive: true,
  };

  beforeEach(async () => {
    send = jest.fn().mockResolvedValue({ ok: true });
    smsLogFindFirst = jest.fn().mockResolvedValue(null);
    ruleFindMany = jest.fn().mockResolvedValue([
      { id: 'r1', fleetId: 'f1', vehicleId: null, alertType: '*', enabled: true, channels: ['SMS'] },
    ]);
    userFindMany = jest.fn().mockResolvedValue([recipient]);

    const prisma = {
      alertRule: { findMany: ruleFindMany },
      user: { findMany: userFindMany },
      smsLog: { findFirst: smsLogFindFirst },
      surveillanceProfile: { findUnique: jest.fn().mockResolvedValue(null) },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationDispatchService,
        { provide: PrismaService, useValue: prisma },
        { provide: WebPushService, useValue: { sendToUser: jest.fn() } },
        { provide: EmailService, useValue: { send: jest.fn() } },
        { provide: SmsGatewayService, useValue: { send } },
      ],
    }).compile();
    dispatch = moduleRef.get(NotificationDispatchService);
  });

  it('sends one SMS to a recipient with a phone, context source=alert-notification', async () => {
    await dispatch.dispatchAlert(alert as never);

    expect(send).toHaveBeenCalledTimes(1);
    const [to, body, ctx] = send.mock.calls[0];
    expect(to).toBe('+33656691615');
    expect(body).toContain('[Vizyo Tracky]');
    expect(body).toContain('CRITICAL');
    expect(body).toContain('TE002ST');
    expect(body.length).toBeLessThanOrEqual(160);
    expect(ctx).toMatchObject({
      source: 'alert-notification',
      userId: 'u1',
      alertId: 'a1',
      alertType: 'OVERSPEED',
    });
  });

  it('throttles: no SMS if a recent alert-notification SMS exists for (user, type)', async () => {
    smsLogFindFirst.mockResolvedValue({ id: 'recent' });
    await dispatch.dispatchAlert(alert as never);
    expect(send).not.toHaveBeenCalled();
  });

  it('skips SMS when the recipient has no phone', async () => {
    userFindMany.mockResolvedValue([{ ...recipient, phone: null }]);
    await dispatch.dispatchAlert(alert as never);
    expect(send).not.toHaveBeenCalled();
  });

  it('escalation: ne notifie PAS une cible d escalade hors flotte (#14/#17)', async () => {
    // L'admin a un contact d'escalade, mais ce contact a ete reassigne a une AUTRE
    // flotte : le findFirst scope par fleetId ne le trouve donc pas -> 0 cible.
    userFindMany.mockResolvedValue([
      { id: 'admin1', fleetId: 'f1', role: 'FLEET_ADMIN', isActive: true, escalationContactUserId: 'contact-x' },
    ]);
    const userFindFirst = jest.fn().mockResolvedValue(null);
    (dispatch as unknown as { prisma: { user: { findFirst: jest.Mock } } }).prisma.user.findFirst = userFindFirst;

    await dispatch.dispatchEscalation(alert as never);

    // La cible d'escalade doit etre cherchee SCOPEE a la flotte de l'alerte.
    expect(userFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ fleetId: 'f1', id: 'contact-x', isActive: true }) }),
    );
    // Cible hors flotte => aucune notification envoyee.
    expect(send).not.toHaveBeenCalled();
  });
});
