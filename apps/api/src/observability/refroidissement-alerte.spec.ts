import { RefroidissementAlerteService, CLES_REFROIDISSEMENT } from './refroidissement-alerte.service';

/**
 * TRK-038 — le refroidissement d'alerte, en base plutot qu'en memoire de processus.
 *
 * Ce qui est verrouille ici, et pourquoi chaque test existe :
 *
 *  - LA PANNE FAIT EMETTRE. Un doublon d'alerte se voit et s'ignore ; une alerte manquee ne se
 *    voit pas. C'est le meme arbitrage que celui deja ecrit pour l'alarme d'alimentation.
 *  - L'ECRITURE NE FAIT JAMAIS ECHOUER L'ACTION METIER. Un compteur qui casse un envoi de SMS
 *    serait pire que le defaut qu'il corrige.
 *  - LE DELAI EST EVALUE PAR LA BASE, pas par le client. Deux repliques n'ont pas la meme
 *    horloge ; la table, si.
 */
describe('RefroidissementAlerteService', () => {
  const monter = (prisma: Record<string, unknown>) =>
    new RefroidissementAlerteService(prisma as never);

  describe('tenterEmission', () => {
    it('laisse passer quand la base rend une ligne', async () => {
      const svc = monter({ $queryRaw: jest.fn().mockResolvedValue([{ cle: 'x' }]) });
      await expect(svc.tenterEmission('x', 60_000)).resolves.toBe(true);
    });

    it('refuse quand la base ne rend rien — le delai n est pas ecoule', async () => {
      const svc = monter({ $queryRaw: jest.fn().mockResolvedValue([]) });
      await expect(svc.tenterEmission('x', 60_000)).resolves.toBe(false);
    });

    it('🔑 EMET si la base est injoignable — le silence est le mauvais defaut', async () => {
      const svc = monter({ $queryRaw: jest.fn().mockRejectedValue(new Error('DB down')) });
      await expect(svc.tenterEmission('x', 60_000)).resolves.toBe(true);
    });

    it('⚠️ le delai est evalue PAR LA BASE, jamais par le client', async () => {
      const $queryRaw = jest.fn().mockResolvedValue([]);
      await monter({ $queryRaw }).tenterEmission('x', 3_600_000);
      // La requete porte `now()` et `make_interval` : aucune date n'est calculee ici. Deux
      // repliques n'ont pas la meme horloge ; la table, si.
      const fragments = ($queryRaw.mock.calls[0]![0] as { join?: unknown } & string[]).join('');
      expect(fragments).toContain('now()');
      expect(fragments).toContain('make_interval');
      // Et la fenetre passe en SECONDES, pas en millisecondes.
      expect($queryRaw.mock.calls[0]!.slice(1)).toContain(3600);
    });
  });

  describe('derniereEmission', () => {
    it('rend la date connue', async () => {
      const d = new Date('2026-08-22T06:00:00Z');
      const svc = monter({ refroidissementAlerte: { findUnique: jest.fn().mockResolvedValue({ derniereEmissionAt: d }) } });
      await expect(svc.derniereEmission('x')).resolves.toEqual(d);
    });

    it('rend null quand le garde n a jamais emis', async () => {
      const svc = monter({ refroidissementAlerte: { findUnique: jest.fn().mockResolvedValue(null) } });
      await expect(svc.derniereEmission('x')).resolves.toBeNull();
    });

    it('🔑 rend null si la base est injoignable — donc on emet', async () => {
      const svc = monter({ refroidissementAlerte: { findUnique: jest.fn().mockRejectedValue(new Error('DB down')) } });
      await expect(svc.derniereEmission('x')).resolves.toBeNull();
    });
  });

  describe('marquerEmission', () => {
    it("⚠️ ecrit l'instant TRANSMIS, pas l'heure du serveur", async () => {
      // Sans ca, un appelant qui raisonne sur un `now` explicite compare deux horloges
      // differentes — celle du raisonnement et celle de l'ecriture.
      const upsert = jest.fn().mockResolvedValue({});
      const quand = new Date('2026-08-22T06:00:00Z');
      await monter({ refroidissementAlerte: { upsert } }).marquerEmission('x', quand);
      expect(upsert.mock.calls[0]![0].create.derniereEmissionAt).toEqual(quand);
      expect(upsert.mock.calls[0]![0].update.derniereEmissionAt).toEqual(quand);
    });

    it("🔑 ne fait JAMAIS echouer l'action metier", async () => {
      const svc = monter({ refroidissementAlerte: { upsert: jest.fn().mockRejectedValue(new Error('DB down')) } });
      await expect(svc.marquerEmission('x')).resolves.toBeUndefined();
    });
  });

  describe('oublier', () => {
    it("efface le refroidissement — l'episode suivant est un fait NEUF", async () => {
      const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
      await monter({ refroidissementAlerte: { deleteMany } }).oublier('x');
      expect(deleteMany).toHaveBeenCalledWith({ where: { cle: 'x' } });
    });

    it('ne jette pas si la base est injoignable', async () => {
      const svc = monter({ refroidissementAlerte: { deleteMany: jest.fn().mockRejectedValue(new Error('DB down')) } });
      await expect(svc.oublier('x')).resolves.toBeUndefined();
    });
  });

  it('⚠️ les cles sont DISTINCTES — deux gardes qui partagent une cle se font taire mutuellement', () => {
    const cles = Object.values(CLES_REFROIDISSEMENT);
    expect(new Set(cles).size).toBe(cles.length);
  });
});
