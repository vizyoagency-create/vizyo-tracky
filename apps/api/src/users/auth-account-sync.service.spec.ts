import { AuthAccountSyncService } from './auth-account-sync.service';

/**
 * SYNCHRONISATION DU STATUT — Tracky ↔ Vizyo Auth.
 *
 * ── Ce que ces tests verrouillent ────────────────────────────────────────────────────
 * Tracky porte `User.isActive`, Vizyo Auth porte `UserApp.status`. Les deux décident du
 * même fait — « cette personne peut-elle entrer ? » — et rien ne les tenait ensemble :
 *
 *   - archiver appelait `suspendUser()` dans un `catch {}` VIDE ;
 *   - désarchiver n'appelait RIEN (`activateUser` n'était invoqué nulle part) ;
 *   - le tout masqué par un 403 systématique (corrigé par la PR #51).
 *
 * Réparer l'appel a rendu l'archivage EFFECTIF, donc l'absence de réactivation
 * BLOQUANTE : un compte désarchivé serait resté verrouillé au login en s'affichant actif.
 */
function build(over: { suspendThrows?: Error; activateThrows?: Error } = {}) {
  const suspendUser = over.suspendThrows
    ? jest.fn().mockRejectedValue(over.suspendThrows)
    : jest.fn().mockResolvedValue(undefined);
  const activateUser = over.activateThrows
    ? jest.fn().mockRejectedValue(over.activateThrows)
    : jest.fn().mockResolvedValue(undefined);
  const recordBackground = jest.fn();
  const svc = new AuthAccountSyncService(
    { suspendUser, activateUser } as never,
    { recordBackground } as never,
  );
  return { svc, suspendUser, activateUser, recordBackground };
}

describe('AuthAccountSyncService', () => {
  it('archiver suspend le compte dans Vizyo Auth', async () => {
    const t = build();
    await expect(t.svc.applyStatus('auth-1', false, 'archive:a@b.c')).resolves.toBe(true);
    expect(t.suspendUser).toHaveBeenCalledWith('auth-1');
    expect(t.activateUser).not.toHaveBeenCalled();
  });

  it('⚠️ désarchiver RÉACTIVE le compte — l’appel qui n’existait nulle part', async () => {
    // LE test du correctif. `activateUser` était défini dans le client et invoqué par
    // personne : désarchiver laissait la personne bloquée au login.
    const t = build();
    await expect(t.svc.applyStatus('auth-1', true, 'update:a@b.c')).resolves.toBe(true);
    expect(t.activateUser).toHaveBeenCalledWith('auth-1');
    expect(t.suspendUser).not.toHaveBeenCalled();
  });

  it('un compte sans identifiant Vizyo Auth n’est pas une erreur', async () => {
    // Certains comptes de service n'existent que côté Tracky. Rien à synchroniser n'est
    // un succès, pas un échec — le contraire ferait remonter du bruit permanent.
    const t = build();
    await expect(t.svc.applyStatus(null, false, 'archive:x')).resolves.toBe(true);
    await expect(t.svc.applyStatus(undefined, true, 'update:x')).resolves.toBe(true);
    expect(t.suspendUser).not.toHaveBeenCalled();
    expect(t.activateUser).not.toHaveBeenCalled();
  });

  describe('en cas d’échec', () => {
    it('⚠️ ne jette PAS — une panne Vizyo Auth ne doit pas empêcher d’archiver', async () => {
      const t = build({ suspendThrows: new Error('403 Access denied') });
      await expect(t.svc.applyStatus('auth-1', false, 'archive:a@b.c')).resolves.toBe(false);
    });

    it('⚠️ mais n’est JAMAIS muet — l’échec part au centre d’alerte', async () => {
      // C'est un `catch {}` vide qui a laissé quatre appels échouer en 403 pendant des
      // mois sans que personne ne le voie. Le repli reste, le silence non.
      const t = build({ suspendThrows: new Error('403 Access denied') });
      await t.svc.applyStatus('auth-1', false, 'archive:a@b.c');
      expect(t.recordBackground).toHaveBeenCalledTimes(1);
      const [err, source, meta] = t.recordBackground.mock.calls[0];
      expect((err as Error).message).toContain('403');
      expect(source).toBe('auth-sync');
      // Le contexte doit dire QUI et QUOI : un identifiant tronqué seul ne permet pas
      // de retrouver le compte concerné.
      expect(meta).toMatchObject({ context: 'archive:a@b.c', intended: 'suspended' });
    });

    it('l’échec de RÉACTIVATION est tracé avec l’intention inverse', async () => {
      const t = build({ activateThrows: new Error('502 Bad Gateway') });
      await expect(t.svc.applyStatus('auth-1', true, 'update:a@b.c')).resolves.toBe(false);
      expect(t.recordBackground.mock.calls[0][2]).toMatchObject({ intended: 'active' });
    });

    it('une valeur jetée qui n’est pas une Error reste exploitable', async () => {
      const t = build({ suspendThrows: 'panne réseau' as unknown as Error });
      await expect(t.svc.applyStatus('auth-1', false, 'archive:x')).resolves.toBe(false);
      expect(t.recordBackground).toHaveBeenCalledTimes(1);
    });
  });
});
