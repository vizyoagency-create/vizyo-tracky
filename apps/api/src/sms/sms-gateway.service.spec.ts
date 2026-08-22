import { SmsGatewayService } from './sms-gateway.service';

/**
 * ── TRK-036 : DE QUEL BOÎTIER VIENT CE SMS ENTRANT ? ────────────────────────────────
 *
 * Le 2026-08-19 à 08:28:58, le boîtier de GS-014-NY répond « Resume engine Succeed »
 * depuis sa carte SIM. Le message est reçu, il est écrit dans `sms_logs`... avec `imei`
 * **NULL**, alors que le numéro émetteur EST le `simPhoneNumber` de ce boîtier.
 *
 * 🔑 La preuve de remise n'était pas absente : elle arrivait, elle était rangée, et
 * personne n'allait la chercher.
 *
 * ⚠️ Portée volontairement étroite : ce fichier ne teste QUE le rattachement de l'émetteur.
 * L'envoi, la passerelle et le repli Twilio ont leurs propres chemins et leurs propres
 * conditions ; les mélanger ici donnerait une suite qui casse pour des raisons sans rapport.
 */
describe('SmsGatewayService — rattachement du SMS entrant (TRK-036)', () => {
  const SIM = '+345901030609501';

  const build = () => {
    const prisma = {
      smsLog: { create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'log-1', ...data })) },
      tracker: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const emitter = { emit: jest.fn() };
    const service = new SmsGatewayService(
      prisma as never,
      { record: jest.fn() } as never,
      emitter as never,
      { record: jest.fn() } as never,
    );
    return { service, prisma, emitter };
  };

  const recevoir = (service: SmsGatewayService, fromNumber: string, body = 'Resume engine Succeed') =>
    service.recordInbound({ fromNumber, toNumber: '+33656691615', body });

  it('🔴 renseigne l’IMEI du boîtier dont c’est la carte SIM', async () => {
    // LE test du correctif : sur le code d'avant, `imei` restait indéfini.
    const { service, prisma } = build();
    prisma.tracker.findMany.mockResolvedValue([{ imei: '864035054756169' }]);

    await recevoir(service, SIM);

    expect(prisma.smsLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ imei: '864035054756169' }) }),
    );
  });

  it('tolère les variations d’écriture du numéro — 9 derniers chiffres', async () => {
    // Le même numéro circule en `+33…`, `0033…` ou `0…` selon l'opérateur qui le relaie.
    // Une comparaison stricte échouerait sur une simple variation de forme.
    const { service, prisma } = build();
    prisma.tracker.findMany.mockResolvedValue([{ imei: '864035054756169' }]);

    await recevoir(service, '00 345 901 030 609 501');

    expect(prisma.tracker.findMany.mock.calls[0][0].where.simPhoneNumber.endsWith).toBe('030609501');
  });

  it('🔴 DEUX boîtiers pour ce numéro : on ne rattache RIEN', async () => {
    // Un accusé collé au mauvais véhicule serait pire que pas d'accusé : il ferait croire
    // qu'une coupure moteur a été confirmée sur un véhicule qui n'a rien reçu.
    const { service, prisma } = build();
    prisma.tracker.findMany.mockResolvedValue([{ imei: 'a' }, { imei: 'b' }]);

    await recevoir(service, SIM);

    expect(prisma.smsLog.create.mock.calls[0][0].data.imei).toBeUndefined();
  });

  it('numéro inconnu : le SMS est enregistré quand même, sans IMEI', async () => {
    const { service, prisma } = build();
    await recevoir(service, '+33600000000');
    expect(prisma.smsLog.create).toHaveBeenCalled();
    expect(prisma.smsLog.create.mock.calls[0][0].data.imei).toBeUndefined();
  });

  it('🔴 une panne de la résolution NE FAIT PAS perdre le SMS', async () => {
    // ⚠️ Perdre le message pour cause de rattachement raté remplacerait un angle mort par
    // une perte de donnée — strictement pire que le défaut d'origine.
    const { service, prisma } = build();
    prisma.tracker.findMany.mockRejectedValue(new Error('DB down'));

    await expect(recevoir(service, SIM)).resolves.toEqual(expect.objectContaining({ id: 'log-1' }));
    expect(prisma.smsLog.create).toHaveBeenCalled();
  });

  it('un IMEI fourni par l’appelant fait autorité — on ne le devine pas', async () => {
    // Le provisionnement connaît déjà son boîtier ; le redeviner serait une occasion de
    // se tromper sans aucun gain.
    const { service, prisma } = build();
    await service.recordInbound({ fromNumber: SIM, toNumber: '+33', body: 'ok', imei: 'fourni' });
    expect(prisma.tracker.findMany).not.toHaveBeenCalled();
    expect(prisma.smsLog.create.mock.calls[0][0].data.imei).toBe('fourni');
  });

  it('l’événement entrant est toujours émis — les autres abonnés ne dépendent pas du rattachement', async () => {
    const { service, emitter } = build();
    await recevoir(service, '+33600000000');
    expect(emitter.emit).toHaveBeenCalled();
  });
});
