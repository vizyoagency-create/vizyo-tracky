import { reprendreApresContexte, type ActionsReprise, type CarteReprise } from './reprise-contexte-webgl';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LA CARTE SE RECONSTRUIT APRÈS UNE PERTE DE CONTEXTE WEBGL — ET LE DIT TANT QUE CE N'EST PAS FAIT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Mesuré sur le banc local le 2026-09-07 avec `WEBGL_lose_context` :
 *
 *   · cas nominal — le style revient un `requestAnimationFrame` après `webglcontextrestored`.
 *     Entre les deux, l'ancien code avait déjà retiré le bandeau : carte noire « réparée »
 *     sans l'être, et pour toujours dans un onglet en arrière-plan (les rAF n'y tirent pas) ;
 *   · perte pendant un changement de fond — MapLibre n'a rien sauvegardé, `map.style` reste
 *     nul, aucun `styledata` ne vient. L'ancien code attendait ce `styledata` sans fin, bandeau
 *     retiré : carte noire, marqueurs orphelins, aucun message, définitivement.
 */
interface Fausse {
  carte: CarteReprise;
  actions: ActionsReprise;
  /** Les écouteurs posés par `once('styledata')`, à déclencher à la main. */
  styledata: Array<() => void>;
  /** L'ordre exact des actions appelées. */
  journal: string[];
}

function fausseCarte(style: unknown, chargee: boolean): Fausse {
  const journal: string[] = [];
  const styledata: Array<() => void> = [];
  return {
    journal,
    styledata,
    carte: {
      style,
      isStyleLoaded: () => (style ? chargee : undefined),
      once: (_type, ecouteur) => styledata.push(ecouteur),
    },
    actions: {
      reappliquerFond: () => journal.push('fond'),
      leverInterruption: () => journal.push('lever'),
      reconstruire: () => journal.push('reconstruire'),
    },
  };
}

describe('Reprise après retour du contexte WebGL', () => {
  it('🔴 style présent mais pas encore chargé : RIEN ne bouge avant styledata, puis tout, une fois', () => {
    const f = fausseCarte({}, false);

    const issue = reprendreApresContexte(f.carte, f.actions);

    // Le bandeau doit TENIR tant que les sources n'existent pas : c'est exactement la fenêtre
    // où la carte est noire.
    expect(issue).toBe('apres-styledata');
    expect(f.journal).toEqual([]);
    expect(f.styledata.length).toBe(1);

    f.styledata[0]();
    expect(f.journal).toEqual(['lever', 'reconstruire']);
  });

  it('🔴 style nul (MapLibre n a rien sauvegardé) : on réapplique le fond, et on reconstruit à son chargement', () => {
    const f = fausseCarte(null, false);

    const issue = reprendreApresContexte(f.carte, f.actions);

    expect(issue).toBe('fond-reapplique');
    // L'écouteur est posé AVANT de relancer le fond : un styledata synchrone ne serait pas perdu.
    expect(f.journal).toEqual(['fond']);
    expect(f.styledata.length).toBe(1);

    f.styledata[0]();
    expect(f.journal).toEqual(['fond', 'lever', 'reconstruire']);
  });

  it('style déjà chargé : reconstruction immédiate, sans attendre', () => {
    const f = fausseCarte({}, true);

    const issue = reprendreApresContexte(f.carte, f.actions);

    expect(issue).toBe('immediate');
    expect(f.journal).toEqual(['lever', 'reconstruire']);
    expect(f.styledata.length).toBe(0);
  });

  /**
   * ⚠️ L'ORDRE N'EST PAS UN DÉTAIL. `recreerCouches()` passe par `carteUtilisable()`, qui
   * rend faux tant que le drapeau est levé : reconstruire AVANT de le baisser ne ferait rien,
   * en silence. C'est la deuxième cause probable listée dans le dossier de reprise.
   */
  it('l interruption est levée juste avant la reconstruction, jamais après', () => {
    const f = fausseCarte({}, false);
    reprendreApresContexte(f.carte, f.actions);
    f.styledata[0]();

    expect(f.journal.indexOf('lever')).toBeLessThan(f.journal.indexOf('reconstruire'));
    expect(f.journal.filter((a) => a === 'reconstruire').length).toBe(1);
  });
});
