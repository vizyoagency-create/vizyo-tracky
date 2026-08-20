import { reporterNotes } from './gps-diagnostics.component';

/**
 * Cas réel (2026-08-20), vu dans le navigateur et non déduit du code.
 *
 * Le serveur avait été corrigé pour NE PAS effacer la note lors d'une réouverture. Il la
 * conservait bien — la base le confirmait. Mais l'écran, lui, ne la ré-affichait pas : une zone
 * rouverte troque son bloc de relecture contre un champ de saisie, et ce champ revenait vide.
 *
 * Du point de vue du relecteur, la note était donc perdue. Il en aurait tapé une autre, et
 * écrasé la première sans jamais avoir su qu'elle existait. Une donnée conservée mais invisible
 * est une donnée perdue.
 */
describe('reporterNotes', () => {
  it('remplit le brouillon vide avec la note deja enregistree', () => {
    expect(reporterNotes({}, [{ id: 'z1', note: 'parking couvert' }])).toEqual({
      z1: 'parking couvert',
    });
  });

  it('ne touche PAS a un brouillon en cours de frappe', () => {
    const brouillons = { z1: 'en train d ecrire' };
    reporterNotes(brouillons, [{ id: 'z1', note: 'ancienne note' }]);
    expect(brouillons.z1).toBe('en train d ecrire');
  });

  it('ignore les zones sans note plutot que d inscrire une chaine vide', () => {
    expect(reporterNotes({}, [{ id: 'z1', note: null }])).toEqual({});
  });

  it('traite chaque zone independamment', () => {
    expect(
      reporterNotes({ z2: 'saisie locale' }, [
        { id: 'z1', note: 'note serveur' },
        { id: 'z2', note: 'note serveur ecrasee ? non' },
        { id: 'z3', note: null },
      ]),
    ).toEqual({ z1: 'note serveur', z2: 'saisie locale' });
  });

  it('accepte une liste vide sans rien changer', () => {
    expect(reporterNotes({ z1: 'garde' }, [])).toEqual({ z1: 'garde' });
  });
});
