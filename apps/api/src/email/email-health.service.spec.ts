import { EmailHealthService } from './email-health.service';

type LigneBloquee = { toAddress: string; template: string; providerId: string; createdAt: Date };
type FiltreOu = { where: { createdAt: { lt: Date; gte: Date }; providerId: unknown; status: string } };

/**
 * Sentinelle des courriels bloqués. Ce qu'elle doit protéger, dans l'ordre d'importance :
 *
 *  1. elle VOIT le cas réel — un message accepté par Resend, jamais confirmé, sans rebond ni
 *     code d'erreur, parce que l'adresse est sur la liste de suppression ;
 *  2. elle en fait UNE ligne par adresse, pas une par message : sept rapports vers la même
 *     boîte décrivent un seul problème ;
 *  3. elle dit ce que le FOURNISSEUR en pense, seule source de vérité quand le webhook n'arrive
 *     jamais, et elle survit à son silence ;
 *  4. `suppressed` est un verdict, donc CRITICAL — le destinataire ne recevra rien tant que
 *     personne n'agira chez le fournisseur ;
 *  5. elle ne regarde ni trop tôt (un retard légitime) ni trop loin (l'archéologie de juillet).
 */
describe('EmailHealthService — la panne silencieuse du 2026-09-08', () => {
  const MAINTENANT = new Date('2026-09-08T07:00:00Z');
  const jours = (n: number) => new Date(MAINTENANT.getTime() - n * 86_400_000);

  function bati(
    lignes: LigneBloquee[],
    options: { statutFournisseur?: string | null; demo?: boolean } = {},
  ) {
    const prisma = {
      emailLog: { findMany: jest.fn(async (_args: FiltreOu): Promise<LigneBloquee[]> => lignes) },
    };
    const email = {
      statutFournisseur: jest.fn(async (_id: string): Promise<string | null> =>
        options.statutFournisseur === undefined ? 'suppressed' : options.statutFournisseur,
      ),
    };
    const errorLogger = {
      record: jest.fn(
        async (
          _message: string,
          _source: string,
          _contexte?: Record<string, unknown>,
          _niveau?: string,
        ): Promise<string> => 'id',
      ),
    };
    const demoMode = options.demo === undefined ? undefined : { enabled: options.demo };
    const service = new EmailHealthService(
      prisma as never,
      email as never,
      errorLogger as never,
      demoMode as never,
    );
    return { service, prisma, email, errorLogger };
  }

  const rapport = (adresse: string, ilYAJours: number, id = `msg-${ilYAJours}`): LigneBloquee => ({
    toAddress: adresse,
    template: 'weekly_report',
    providerId: id,
    createdAt: jours(ilYAJours),
  });

  it('une adresse supprimée : UNE alerte CRITICAL, qui compte les messages et cite le fournisseur', async () => {
    // Le cas réel : sept rapports hebdomadaires vers admin@cdef31.org, du 27/07 au 07/09.
    // Sept lignes d'alerte rendraient le problème plus difficile à voir, pas moins.
    const sept = [1, 8, 15, 22, 29, 36, 43].map((d) => rapport('admin@cdef31.org', d));
    const { service, errorLogger } = bati(sept);

    await service.verifierCourrielsBloques(MAINTENANT);

    expect(errorLogger.record).toHaveBeenCalledTimes(1);
    const [message, source, contexte, niveau] = errorLogger.record.mock.calls[0]!;
    expect(message).toContain('7 courriel(s)');
    expect(message).toContain('admin@cdef31.org');
    expect(message).toContain('suppressed');
    expect(message).toContain('43 jour(s)');
    expect(source).toBe('email-bloque');
    expect(contexte).toEqual(
      expect.objectContaining({ toAddress: 'admin@cdef31.org', nombre: 7, statutFournisseur: 'suppressed' }),
    );
    // Un verdict du fournisseur, pas un retard : rien ne changera sans intervention.
    expect(niveau).toBe('CRITICAL');
  });

  it('deux adresses fautives : deux alertes, chacune la sienne', async () => {
    const { service, errorLogger } = bati([
      rapport('admin@cdef31.org', 2, 'a1'),
      rapport('admin@vizyoagency.com', 3, 'b1'),
    ]);

    await service.verifierCourrielsBloques(MAINTENANT);

    expect(errorLogger.record).toHaveBeenCalledTimes(2);
    const adresses = errorLogger.record.mock.calls
      .map((appel) => (appel[2] as { toAddress: string }).toAddress)
      .sort();
    expect(adresses).toEqual(['admin@cdef31.org', 'admin@vizyoagency.com']);
  });

  it('le fournisseur ne répond pas : on alerte quand même, en le disant', async () => {
    // Une panne de l'API Resend ne doit pas rendre la surveillance muette — ce serait
    // reproduire exactement le défaut qu'elle existe pour corriger.
    const { service, errorLogger } = bati([rapport('admin@cdef31.org', 2)], { statutFournisseur: null });

    await service.verifierCourrielsBloques(MAINTENANT);

    expect(errorLogger.record).toHaveBeenCalledTimes(1);
    const [message, , , niveau] = errorLogger.record.mock.calls[0]!;
    expect(message).toContain('sans réponse');
    // Sans verdict du fournisseur, on ne conclut pas au définitif.
    expect(niveau).toBe('ERROR');
  });

  it('rien de bloqué : aucune alerte, mais le passage laisse une trace', async () => {
    // La trace compte autant que l'alerte. Sans elle, un passage propre est indistinguable d'une
    // sentinelle morte — et c'est précisément la panne qu'elle existe pour empêcher.
    const { service, errorLogger } = bati([]);
    const journal = jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);

    await service.verifierCourrielsBloques(MAINTENANT);

    expect(errorLogger.record).not.toHaveBeenCalled();
    expect(journal).toHaveBeenCalledTimes(1);
    journal.mockRestore();
  });

  it('en démonstration : ne regarde même pas la base', async () => {
    // Les invitations de la démo restent en file par conception ; personne n'a à en être alerté.
    const { service, prisma, errorLogger } = bati([rapport('demo@exemple.org', 5)], { demo: true });

    await service.verifierCourrielsBloques(MAINTENANT);

    expect(prisma.emailLog.findMany).not.toHaveBeenCalled();
    expect(errorLogger.record).not.toHaveBeenCalled();
  });

  it('la fenêtre est bornée des DEUX côtés : ni trop tôt, ni archéologie', async () => {
    const { service, prisma } = bati([]);
    await service.verifierCourrielsBloques(MAINTENANT);

    const { where } = prisma.emailLog.findMany.mock.calls[0]![0];
    // Trop tôt : un `delivery_delayed` légitime se résout en quelques heures.
    expect(where.createdAt.lt).toEqual(new Date('2026-09-07T07:00:00Z'));
    // Trop loin : rouvrir chaque matin des messages de juillet que personne ne renverra.
    expect(where.createdAt.gte).toEqual(new Date('2026-08-09T07:00:00Z'));
    // Sans identifiant fournisseur, il n'y a rien eu à confirmer (envoi en mode no-op).
    expect(where.providerId).toEqual({ not: null });
    expect(where.status).toBe('QUEUED');
  });
});
