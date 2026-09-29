import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AuthService, type AuthUser } from './auth.service';
import { FleetFilterService } from './fleet-filter.service';

/**
 * ── LE FILTRE SOCIÉTÉ D'UN SUPER-ADMIN NE PASSE PAS AU COMPTE SUIVANT (défaut latent du 29/09) ──
 *
 * Le choix vit dans le localStorage du NAVIGATEUR, qui survit à la déconnexion, et il était rendu tel
 * quel à tout compte. Un gestionnaire qui se connectait après une session super-admin envoyait donc à
 * l'API la société d'un AUTRE client : l'agent d'agenda répondait 403, l'écran l'avalait, et plus
 * aucune proposition ne s'affichait — sans un mot.
 *
 * ⚠️ LE VRAI `FleetFilterService`, un double pour le compte seulement : c'est le service qui décide ce
 * qu'un compte lit, et quand le stockage s'efface.
 */
describe('FleetFilterService — le filtre société n’existe que pour un super-admin', () => {
  const CLE = 'vizyo-fleet-filter';
  const SOCIETE_A = 'aaaaaaaa-1111-4111-8111-111111111111';
  const SOCIETE_B = 'bbbbbbbb-2222-4222-8222-222222222222';
  const compte = (role: AuthUser['role'], fleetId: string | null = null): AuthUser => ({
    sub: `u-${role}`,
    email: 'compte@exemple.fr',
    role,
    fleetId,
    permissions: null,
  });

  /** ⚠️ Le stockage est posé AVANT la construction : le service le lit à sa naissance (un rechargement). */
  function monter(utilisateur: AuthUser | null, stockage: string | null) {
    if (stockage) localStorage.setItem(CLE, stockage);
    else localStorage.removeItem(CLE);
    const user = signal<AuthUser | null>(utilisateur);
    TestBed.configureTestingModule({ providers: [{ provide: AuthService, useValue: { user } }] });
    return { filtre: TestBed.inject(FleetFilterService), user };
  }

  afterEach(() => localStorage.removeItem(CLE));

  it('🔴 LE DÉFAUT : un gestionnaire arrivé après une session super-admin ne lit AUCUNE société — dès la première lecture', () => {
    const { filtre } = monter(compte('FLEET_MANAGER', 'f-client'), SOCIETE_A);

    // Aucun effet n'a tourné : c'est la lecture que fait l'agenda à son premier chargement.
    expect(filtre.selectedFleetId()).toBeNull();
    expect(filtre.isActive()).toBeFalse();
  });

  it('la société restée est effacée du navigateur', () => {
    const { filtre } = monter(compte('FLEET_ADMIN', 'f-client'), SOCIETE_A);

    TestBed.tick();

    expect(localStorage.getItem(CLE)).toBeNull();
    expect(filtre.selectedFleetId()).toBeNull();
  });

  it('un gestionnaire ne pose pas de société — et peut toujours l’ôter', () => {
    const { filtre } = monter(compte('FLEET_MANAGER', 'f-client'), null);

    filtre.set(SOCIETE_A);
    expect(filtre.selectedFleetId()).toBeNull();
    expect(localStorage.getItem(CLE)).toBeNull();

    filtre.set(null);
    expect(filtre.selectedFleetId()).toBeNull();
  });

  it('un super-admin retrouve sa société après un rechargement, et en change', () => {
    const { filtre } = monter(compte('SUPER_ADMIN'), SOCIETE_A);
    TestBed.tick();

    expect(filtre.selectedFleetId()).toBe(SOCIETE_A);
    expect(localStorage.getItem(CLE)).toBe(SOCIETE_A);

    filtre.set(SOCIETE_B);
    expect(filtre.selectedFleetId()).toBe(SOCIETE_B);
    expect(localStorage.getItem(CLE)).toBe(SOCIETE_B);
  });

  it('même onglet : la déconnexion ne bouge rien ; la connexion d’un gestionnaire efface tout, pour lui ET le suivant', () => {
    const { filtre, user } = monter(compte('SUPER_ADMIN'), SOCIETE_A);
    TestBed.tick();

    // Déconnexion : une page encore ouverte n'a pas à se recharger pour une société que plus personne
    // ne regarde (le filtre ne change pas).
    user.set(null);
    TestBed.tick();
    expect(filtre.selectedFleetId()).toBe(SOCIETE_A);

    user.set(compte('FLEET_MANAGER', 'f-client'));
    expect(filtre.selectedFleetId()).toBeNull(); // sans attendre l'effet
    TestBed.tick();
    expect(localStorage.getItem(CLE)).toBeNull();

    // Le super-admin qui revient ensuite ne retrouve pas une société que le gestionnaire a vu effacer.
    user.set(compte('SUPER_ADMIN'));
    expect(filtre.selectedFleetId()).toBeNull();
  });
});
