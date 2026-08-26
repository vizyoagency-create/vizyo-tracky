import { HORS_DEGRADATION, NIVEAU_DEGRADATION, estDegradation } from './niveaux-erreur';

/**
 * TRK-037 — une dégradation assumée n'est pas un défaut.
 *
 * Le 2026-08-26, 14 des 18 lignes actives du centre d'alerte décrivaient la même chose :
 * Overpass (OpenStreetMap), miroir public et gratuit, momentanément injoignable. Le repli
 * fonctionne, la perte est bornée, le propriétaire a accepté la contrepartie — et pourtant un
 * exploitant lisait « 18 erreurs » sans pouvoir savoir que 14 ne demandaient rien.
 */
describe('TRK-037 — niveau DEGRADATION', () => {
  it('reconnaît une dégradation', () => {
    expect(estDegradation({ level: NIVEAU_DEGRADATION })).toBe(true);
  });

  it('ne confond JAMAIS une dégradation avec un défaut', () => {
    expect(estDegradation({ level: 'ERROR' })).toBe(false);
    expect(estDegradation({ level: 'CRITICAL' })).toBe(false);
  });

  /**
   * 🔴 Le choix qui compte : la clause EXCLUT ce qu'on connaît, elle n'inclut pas une liste
   * blanche. `level` est une chaîne libre en base — une liste blanche ferait disparaître en
   * silence tout niveau futur que personne n'aurait pensé à y ajouter.
   */
  it('exclut par « not », jamais par liste blanche', () => {
    expect(HORS_DEGRADATION).toEqual({ level: { not: NIVEAU_DEGRADATION } });
    expect(JSON.stringify(HORS_DEGRADATION)).not.toContain('in');
  });

  /** Un niveau inconnu doit rester COMPTÉ : dans le doute, on crie. */
  it('laisse passer un niveau inconnu — dans le doute, c est un défaut', () => {
    expect(estDegradation({ level: 'FATAL' })).toBe(false);
    expect(estDegradation({ level: '' })).toBe(false);
  });

  it('le libellé est stable — il est écrit en base et relu par la collecte', () => {
    expect(NIVEAU_DEGRADATION).toBe('DEGRADATION');
  });
});
