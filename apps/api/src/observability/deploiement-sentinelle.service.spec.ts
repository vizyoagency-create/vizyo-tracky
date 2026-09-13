/**
 * ── LE SCRIPT DE DÉPLOIEMENT EST INCONTOURNABLE — parce qu'un contournement SE VOIT ──────
 *
 * Décision D1 du propriétaire (2026-09-13, depuis le poste de commande) : `deploy/vps/deploy.sh`
 * est le seul chemin vers la production. On ne peut pas empêcher un `docker compose up` tapé à
 * la main ; on peut faire qu'il ne passe jamais inaperçu. Le script inscrit dans un journal
 * l'identifiant du conteneur qu'il a créé ; ce service compare, au démarrage, l'identifiant du
 * conteneur qui l'exécute (son hostname) au dernier journalisé.
 *
 * Ces tests jouent le journal sur disque, dans un fichier temporaire, et lisent ce que le
 * service écrit au centre d'alerte.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeploiementSentinelleService, SOURCE_DEPLOIEMENT } from './deploiement-sentinelle.service';

const ID_MOI = 'd144f11ee90f4169978e5e8b2ad133722c5ddbaf44a863ab302aac2cc2eace17';
const ID_AUTRE = '3f2c1a0b9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b';
const HOSTNAME_MOI = ID_MOI.slice(0, 12);

const ligne = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    at: '2026-09-13T11:30:53Z', sha: 'a8f9575e', branche: 'main',
    apiContainerId: ID_MOI, webContainerId: '66dc3d93049a0000',
    force: false, attente: false, repli: null, par: 'root@1.2.3.4', dureeS: 312,
    ...patch,
  });

function construire(contenu: string | null, opts: { emet?: boolean } = {}) {
  const dossier = mkdtempSync(join(tmpdir(), 'deploiements-'));
  const chemin = join(dossier, 'journal.jsonl');
  if (contenu != null) writeFileSync(chemin, contenu, 'utf8');
  const errorLogger = { record: jest.fn().mockResolvedValue('id') };
  const refroidissement = { tenterEmission: jest.fn().mockResolvedValue(opts.emet ?? true) };
  const svc = new DeploiementSentinelleService(errorLogger as never, refroidissement as never);
  return {
    svc, errorLogger, refroidissement, chemin,
    nettoyer: () => rmSync(dossier, { recursive: true, force: true }),
  };
}

describe('Sentinelle du déploiement — ce conteneur a-t-il été créé par deploy.sh ?', () => {
  it('sans journal (montage absent : local, démo), aucun avis et aucune ligne', async () => {
    const t = construire(null);
    try {
      expect(await t.svc.verifier(t.chemin, HOSTNAME_MOI)).toBe('sans-journal');
      expect(t.errorLogger.record).not.toHaveBeenCalled();
    } finally { t.nettoyer(); }
  });

  it('la dernière ligne porte MON identifiant : créé par le script, rien à dire', async () => {
    const t = construire(ligne({ apiContainerId: ID_AUTRE }) + '\n' + ligne() + '\n');
    try {
      expect(await t.svc.verifier(t.chemin, HOSTNAME_MOI)).toBe('par-script');
      expect(t.errorLogger.record).not.toHaveBeenCalled();
    } finally { t.nettoyer(); }
  });

  it('⚠️ la dernière ligne porte un AUTRE identifiant : ce conteneur vient d’ailleurs → ERROR « déploiement hors script »', async () => {
    const t = construire(ligne({ apiContainerId: ID_AUTRE, sha: '7531c18e', par: 'root@5.6.7.8' }) + '\n');
    try {
      expect(await t.svc.verifier(t.chemin, HOSTNAME_MOI)).toBe('hors-script');

      expect(t.errorLogger.record).toHaveBeenCalledTimes(1);
      const [err, source, contexte, niveau] = t.errorLogger.record.mock.calls[0];
      expect(source).toBe(SOURCE_DEPLOIEMENT);
      expect(niveau).toBe('ERROR');
      const message = (err as Error).message;
      expect(message).toContain('Déploiement hors script');
      expect(message).toContain(HOSTNAME_MOI);
      // Le dernier déploiement légitime est nommé : sha, heure de Paris, auteur.
      expect(message).toContain('7531c18e');
      expect(message).toContain('13/09/2026 13:30');
      expect(message).toContain('root@5.6.7.8');
      // Et la règle qu'il enfreint, avec son remède.
      expect(message).toContain('deploy/vps/deploy.sh');
      expect(contexte).toMatchObject({
        conteneur: HOSTNAME_MOI,
        dernierDeploiement: expect.objectContaining({ sha: '7531c18e', apiContainerId: ID_AUTRE }),
      });
    } finally { t.nettoyer(); }
  });

  it('une seule ligne par conteneur, même si l’API redémarre en boucle : refroidissement sur l’identifiant', async () => {
    const t = construire(ligne({ apiContainerId: ID_AUTRE }) + '\n', { emet: false });
    try {
      expect(await t.svc.verifier(t.chemin, HOSTNAME_MOI)).toBe('hors-script');
      expect(t.refroidissement.tenterEmission).toHaveBeenCalledWith(`deploiement-hors-script:${HOSTNAME_MOI}`, expect.any(Number));
      expect(t.errorLogger.record).not.toHaveBeenCalled();
    } finally { t.nettoyer(); }
  });

  it('les lignes vides en fin de fichier ne comptent pas — c’est la dernière ligne PLEINE qui fait foi', async () => {
    const t = construire(ligne() + '\n\n\n');
    try {
      expect(await t.svc.verifier(t.chemin, HOSTNAME_MOI)).toBe('par-script');
    } finally { t.nettoyer(); }
  });

  it('⚠️ un journal illisible (dernière ligne cassée) est un défaut du SCRIPT, dit comme tel — jamais un « hors script »', async () => {
    const t = construire(ligne() + '\n{"at":"2026-09-13T12:00:00Z","sha":"cass');
    try {
      expect(await t.svc.verifier(t.chemin, HOSTNAME_MOI)).toBe('illisible');
      const [err, , , niveau] = t.errorLogger.record.mock.calls[0];
      expect(niveau).toBe('ERROR');
      expect((err as Error).message).toContain('Journal des déploiements illisible');
      expect((err as Error).message).not.toContain('hors script');
    } finally { t.nettoyer(); }
  });

  it('un journal vide (dossier monté, script jamais passé) vaut « sans journal »', async () => {
    const t = construire('');
    try {
      expect(await t.svc.verifier(t.chemin, HOSTNAME_MOI)).toBe('sans-journal');
      expect(t.errorLogger.record).not.toHaveBeenCalled();
    } finally { t.nettoyer(); }
  });

  it('le centre d’alerte qui refuse d’écrire ne fait pas tomber le démarrage', async () => {
    const t = construire(ligne({ apiContainerId: ID_AUTRE }) + '\n');
    t.errorLogger.record.mockRejectedValue(new Error('base injoignable'));
    try {
      await expect(t.svc.verifier(t.chemin, HOSTNAME_MOI)).resolves.toBe('hors-script');
    } finally { t.nettoyer(); }
  });

  it('au démarrage, la vérification est DIFFÉRÉE : le script écrit le journal juste après le `up`, l’API ne doit pas lire avant', () => {
    jest.useFakeTimers();
    const t = construire(null);
    try {
      const espion = jest.spyOn(t.svc, 'verifier').mockResolvedValue('sans-journal');
      t.svc.onApplicationBootstrap();
      expect(espion).not.toHaveBeenCalled();
      jest.advanceTimersByTime(DeploiementSentinelleService.DELAI_VERIFICATION_MS);
      expect(espion).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
      t.nettoyer();
    }
  });
});
