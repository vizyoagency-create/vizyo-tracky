import {
  PARTNER_SCOPES,
  PARTNER_SCOPES_DEFAULT_ON,
  PARTNER_SCOPES_SENSITIVE,
  PARTNER_SCOPE_LABELS,
  hasPartnerScope,
  isPartnerScope,
  parsePartnerScopes,
  revokedPartnerScopes,
  type PartnerScope,
} from './scopes';

/**
 * LITTÉRAL FIGÉ — copie INDÉPENDANTE du registre, tenue à la main.
 *
 * Elle doit être STRICTEMENT identique à celle du jumeau Maestroo
 * (`packages/shared/src/enums/partner-scope.ts`, testée par
 * `apps/api/src/integrations/partner-scopes.spec.ts` côté Maestroo).
 *
 * ⚠️ Si ce test échoue, NE PAS le « réparer » en recopiant la source : c'est le signal
 * qu'un scope a été ajouté/renommé d'un seul côté. Les deux repos et les deux tests
 * doivent bouger ensemble, sinon un scope existe chez l'un et pas chez l'autre — et une
 * révocation partielle ne purge alors rien du tout.
 */
const FROZEN_SCOPES = [
  'VEHICLE_IDENTITY',
  'DRIVER_IDENTITY',
  'MILEAGE_TRIPS',
  'FUEL',
  'MAINTENANCE',
  'DRIVER_HOURS',
  'ALERTS',
  'LIVE_POSITION',
  'DRIVING_BEHAVIOR',
];

const FROZEN_SENSITIVE = ['LIVE_POSITION', 'DRIVING_BEHAVIOR'];

describe('scopes partenaires — parité avec le registre figé', () => {
  it('la liste est EXACTEMENT le littéral figé, ordre compris', () => {
    // L'ordre fait partie du contrat : `parsePartnerScopes` renvoie dans l'ordre du
    // registre, et ces listes sont sérialisées en base des deux côtés. Un réordonnancement
    // produirait des diffs JSON gratuits sur toutes les lignes existantes.
    expect([...PARTNER_SCOPES]).toEqual(FROZEN_SCOPES);
  });

  it('la liste des scopes sensibles est exactement celle attendue', () => {
    expect([...PARTNER_SCOPES_SENSITIVE]).toEqual(FROZEN_SENSITIVE);
  });

  it('aucun doublon', () => {
    expect(new Set(PARTNER_SCOPES).size).toBe(PARTNER_SCOPES.length);
  });

  it('toutes les clés sont en UPPER_SNAKE_CASE', () => {
    for (const scope of PARTNER_SCOPES) {
      expect(scope).toMatch(/^[A-Z]+(_[A-Z]+)*$/);
    }
  });
});

describe('scopes partenaires — invariants de sécurité', () => {
  it('les scopes sensibles font partie du registre', () => {
    for (const scope of PARTNER_SCOPES_SENSITIVE) {
      expect(PARTNER_SCOPES).toContain(scope);
    }
  });

  it('les défauts font partie du registre', () => {
    for (const scope of PARTNER_SCOPES_DEFAULT_ON) {
      expect(PARTNER_SCOPES).toContain(scope);
    }
  });

  // ⚠️ INVARIANT CENTRAL (décision D3) : la position temps réel et le comportement de
  // conduite NOMINATIF ne s'activent JAMAIS tout seuls. Ce test rend la règle vérifiée
  // par la CI au lieu de reposer sur la discipline de celui qui ajoutera un scope.
  it('AUCUN scope sensible n\'est actif par défaut', () => {
    for (const scope of PARTNER_SCOPES_SENSITIVE) {
      expect(PARTNER_SCOPES_DEFAULT_ON).not.toContain(scope);
    }
  });

  it('les défauts = tous les scopes SAUF les sensibles (aucun oubli possible)', () => {
    const expected = PARTNER_SCOPES.filter((s) => !PARTNER_SCOPES_SENSITIVE.includes(s));
    expect([...PARTNER_SCOPES_DEFAULT_ON]).toEqual(expected);
  });
});

describe('scopes partenaires — libellés', () => {
  it('chaque scope a un libellé et une description non vides', () => {
    for (const scope of PARTNER_SCOPES) {
      const entry = PARTNER_SCOPE_LABELS[scope];
      expect(entry).toBeDefined();
      expect(entry.label.trim().length).toBeGreaterThan(0);
      expect(entry.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('aucun libellé en trop (le Record ne couvre que des scopes connus)', () => {
    expect(Object.keys(PARTNER_SCOPE_LABELS).sort()).toEqual([...PARTNER_SCOPES].sort());
  });
});

describe('isPartnerScope', () => {
  it('accepte les scopes connus', () => {
    for (const scope of PARTNER_SCOPES) {
      expect(isPartnerScope(scope)).toBe(true);
    }
  });

  it('refuse tout le reste', () => {
    for (const value of ['', 'live_position', 'UNKNOWN_SCOPE', 42, null, undefined, {}, []]) {
      expect(isPartnerScope(value)).toBe(false);
    }
  });
});

describe('parsePartnerScopes — fail-closed', () => {
  it('renvoie [] pour tout ce qui n\'est pas un tableau', () => {
    for (const value of [null, undefined, 'VEHICLE_IDENTITY', 42, {}]) {
      expect(parsePartnerScopes(value)).toEqual([]);
    }
  });

  it('écarte SILENCIEUSEMENT les valeurs inconnues (compatibilité ascendante)', () => {
    // Cas réel : le pair a ajouté un scope que cette version ne connaît pas encore.
    // On l'ignore — on ne saurait de toute façon pas quoi en faire — au lieu de casser
    // le lien entier.
    expect(parsePartnerScopes(['VEHICLE_IDENTITY', 'SCOPE_DU_FUTUR', 'FUEL'])).toEqual([
      'VEHICLE_IDENTITY',
      'FUEL',
    ]);
  });

  it('écarte les valeurs non-string', () => {
    expect(parsePartnerScopes(['FUEL', 42, null, { scope: 'ALERTS' }])).toEqual(['FUEL']);
  });

  it('déduplique', () => {
    expect(parsePartnerScopes(['FUEL', 'FUEL', 'FUEL'])).toEqual(['FUEL']);
  });

  it('renvoie toujours dans l\'ordre du registre, quel que soit l\'ordre d\'entrée', () => {
    const shuffled = ['DRIVING_BEHAVIOR', 'FUEL', 'VEHICLE_IDENTITY'];
    expect(parsePartnerScopes(shuffled)).toEqual(['VEHICLE_IDENTITY', 'FUEL', 'DRIVING_BEHAVIOR']);
  });

  it('un tableau vide reste vide (aucun défaut implicite)', () => {
    // Important : une liste vide veut dire « plus rien n'est partagé », JAMAIS
    // « applique les défauts ». Un lien dont tous les scopes sont éteints ne doit
    // pas se remettre à partager tout seul.
    expect(parsePartnerScopes([])).toEqual([]);
  });
});

describe('hasPartnerScope', () => {
  it('vrai uniquement si le scope est présent', () => {
    const scopes = ['VEHICLE_IDENTITY', 'FUEL'];
    expect(hasPartnerScope(scopes, 'FUEL')).toBe(true);
    expect(hasPartnerScope(scopes, 'LIVE_POSITION')).toBe(false);
  });

  it('faux sur une entrée corrompue plutôt que de lever (fail-closed)', () => {
    for (const value of [null, undefined, 'FUEL', 42, { FUEL: true }]) {
      expect(hasPartnerScope(value, 'FUEL')).toBe(false);
    }
  });
});

describe('revokedPartnerScopes — 2ᵉ chemin de la révocation partielle', () => {
  it('liste ce qui a disparu entre deux états', () => {
    const before: PartnerScope[] = ['VEHICLE_IDENTITY', 'FUEL', 'LIVE_POSITION'];
    const after: PartnerScope[] = ['VEHICLE_IDENTITY'];
    expect(revokedPartnerScopes(before, after)).toEqual(['FUEL', 'LIVE_POSITION']);
  });

  it('vide si rien n\'a été retiré', () => {
    expect(revokedPartnerScopes(['FUEL'], ['FUEL', 'ALERTS'])).toEqual([]);
  });

  it('un état suivant vide révoque TOUT (cas de la révocation totale)', () => {
    expect(revokedPartnerScopes([...PARTNER_SCOPES], [])).toEqual([...PARTNER_SCOPES]);
  });

  it('un état suivant illisible révoque TOUT plutôt que de ne rien purger', () => {
    // Si la réponse du pair est corrompue, on préfère purger que continuer à servir
    // des données dont on ne sait plus si on a le droit.
    expect(revokedPartnerScopes(['FUEL', 'ALERTS'], null)).toEqual(['FUEL', 'ALERTS']);
  });
});
