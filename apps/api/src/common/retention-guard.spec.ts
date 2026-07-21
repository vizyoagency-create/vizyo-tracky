import {
  assertRetentionWindow,
  MIN_RETENTION_WINDOW_DAYS,
  resolvePurgeArmed,
  RetentionWindowTooShortError,
} from './retention-guard';

/** Lot 1 — garde-fou commun : aucune purge sous 30 jours, purge non désactivable en production. */
describe('retention-guard', () => {
  describe('assertRetentionWindow', () => {
    it('refuse toute fenêtre strictement positive < 30 j', () => {
      for (const days of [1, 6, 29]) {
        expect(() => assertRetentionWindow(days, 'test')).toThrow(RetentionWindowTooShortError);
      }
    });

    it('accepte exactement 30 j (borne incluse) et au-delà', () => {
      expect(() => assertRetentionWindow(MIN_RETENTION_WINDOW_DAYS, 'test')).not.toThrow();
      expect(() => assertRetentionWindow(60, 'test')).not.toThrow();
      expect(() => assertRetentionWindow(365, 'test')).not.toThrow();
    });

    it('accepte 0 = purge désactivée (arrêt d’urgence)', () => {
      expect(() => assertRetentionWindow(0, 'test')).not.toThrow();
    });

    it('refuse les valeurs aberrantes (négatif, NaN)', () => {
      expect(() => assertRetentionWindow(-1, 'test')).toThrow(RetentionWindowTooShortError);
      expect(() => assertRetentionWindow(Number.NaN, 'test')).toThrow(RetentionWindowTooShortError);
    });

    it('le message nomme la source et la valeur fautive (diagnostic centre d’alerte)', () => {
      expect(() => assertRetentionWindow(6, 'positions-retention')).toThrow(/positions-retention.*6 j.*30 j/s);
    });
  });

  describe('resolvePurgeArmed', () => {
    it('production : un drapeau false est IGNORÉ, la purge reste armée', () => {
      expect(resolvePurgeArmed('false', 'production')).toEqual({ armed: true, forced: true });
      expect(resolvePurgeArmed(undefined, 'production')).toEqual({ armed: true, forced: true });
    });

    it('production : un drapeau true arme normalement (sans forçage)', () => {
      expect(resolvePurgeArmed('true', 'production')).toEqual({ armed: true, forced: false });
    });

    it('développement / test : le drapeau désactive bien la purge', () => {
      expect(resolvePurgeArmed('false', 'development')).toEqual({ armed: false, forced: false });
      expect(resolvePurgeArmed(undefined, 'test')).toEqual({ armed: false, forced: false });
      expect(resolvePurgeArmed('true', 'development')).toEqual({ armed: true, forced: false });
    });
  });
});
