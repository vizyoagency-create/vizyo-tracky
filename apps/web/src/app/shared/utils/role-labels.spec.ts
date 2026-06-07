import { roleLabel } from './role-labels';

describe('roleLabel', () => {
  it('maps the 4 app roles to consistent FR labels', () => {
    expect(roleLabel('SUPER_ADMIN')).toBe('Super-Administrateur');
    expect(roleLabel('FLEET_ADMIN')).toBe('Administrateur');
    expect(roleLabel('FLEET_MANAGER')).toBe('Gestionnaire');
    expect(roleLabel('VIEWER')).toBe('Lecteur');
  });

  it('returns an empty string for null/undefined', () => {
    expect(roleLabel(null)).toBe('');
    expect(roleLabel(undefined)).toBe('');
  });

  it('returns the raw value for an unknown role (never lost silently)', () => {
    expect(roleLabel('WHATEVER')).toBe('WHATEVER');
  });
});
