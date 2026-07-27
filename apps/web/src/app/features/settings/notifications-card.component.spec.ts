import type { AlertType } from '@vizyo/tracky-shared';
import type { PushSubscriptionDto } from '../../core/services/notifications.service';
import {
  ALERT_TYPE_GROUPS,
  activeDeliveryHint,
  buildGroupViews,
  derivePushDeviceState,
  isCurrentDeviceEndpoint,
  ownDevices,
  setGroupMuted,
  toggleMutedType,
} from './notifications-card.component';

/**
 * Tests de la LOGIQUE de la carte de réglages, sans DOM.
 *
 * Ce qui est vérifié ici, c'est ce qui a réellement causé « le push ne marche pas » :
 * un écran qui affiche un bouton là où il ne peut rien se passer, et un état d'appareil
 * qui ment sur ce que l'utilisateur va recevoir.
 */
describe('notifications-card — regroupement des types', () => {
  it('expose chaque type dans une famille et une seule (aucun type orphelin ni dupliqué)', () => {
    const all = ALERT_TYPE_GROUPS.flatMap((g) => g.types.map((t) => t.type));
    expect(new Set(all).size).toBe(all.length);
    // UNKNOWN est un repli de typage, pas une case à cocher : il ne doit pas apparaître.
    expect(all).not.toContain('UNKNOWN' as AlertType);
  });

  it('donne des libellés français, jamais l\'identifiant brut', () => {
    const labels = ALERT_TYPE_GROUPS.flatMap((g) => g.types.map((t) => t.label));
    for (const label of labels) {
      expect(label).not.toMatch(/^[A-Z_]+$/);
    }
  });

  it('compte les types actifs par famille : un type coupé sort du compte', () => {
    const views = buildGroupViews(ALERT_TYPE_GROUPS, ['OVERSPEED']);
    const driving = views.find((v) => v.key === 'driving')!;
    expect(driving.activeCount).toBe(driving.total - 1);
    expect(driving.allMuted).toBeFalse();
    expect(driving.items.find((i) => i.type === 'OVERSPEED')!.enabled).toBeFalse();
    expect(driving.items.find((i) => i.type === 'HARSH_TURN')!.enabled).toBeTrue();
  });

  it('marque une famille entièrement coupée', () => {
    const driving = ALERT_TYPE_GROUPS.find((g) => g.key === 'driving')!;
    const views = buildGroupViews(ALERT_TYPE_GROUPS, driving.types.map((t) => t.type));
    const view = views.find((v) => v.key === 'driving')!;
    expect(view.allMuted).toBeTrue();
    expect(view.activeCount).toBe(0);
    // Les autres familles ne bougent pas : pas de fuite d'un groupe à l'autre.
    expect(views.find((v) => v.key === 'safety')!.allMuted).toBeFalse();
  });
});

describe('notifications-card — bascule des types coupés', () => {
  it('couper puis recouper le même type ne crée pas de doublon', () => {
    let muted = toggleMutedType([], 'SOS', false);
    muted = toggleMutedType(muted, 'SOS', false);
    expect(muted).toEqual(['SOS']);
  });

  it('réactiver retire le type de la liste des coupés', () => {
    expect(toggleMutedType(['SOS', 'OVERSPEED'], 'SOS', true)).toEqual(['OVERSPEED']);
  });

  it('ne mute pas le tableau d\'entrée (état optimiste réversible)', () => {
    const source: AlertType[] = ['SOS'];
    toggleMutedType(source, 'OVERSPEED', false);
    expect(source).toEqual(['SOS']);
  });

  it('coupe une famille entière sans toucher aux autres', () => {
    const driving = ALERT_TYPE_GROUPS.find((g) => g.key === 'driving')!;
    const muted = setGroupMuted(['SOS'], driving, false);
    expect(muted).toContain('SOS');
    for (const t of driving.types) expect(muted).toContain(t.type);
    const back = setGroupMuted(muted, driving, true);
    expect(back).toEqual(['SOS']);
  });
});

describe('notifications-card — état de l\'appareil', () => {
  const base = {
    supported: true,
    serverEnabled: true as boolean | null,
    permission: 'granted' as NotificationPermission | 'unsupported',
    subscribed: true,
    isIOS: false,
    isStandalone: false,
  };

  it('iOS Safari non installé : on explique, on ne propose pas un bouton qui échouera', () => {
    const s = derivePushDeviceState({ ...base, supported: false, isIOS: true, isStandalone: false, subscribed: false });
    expect(s.banner).toBe('unsupported');
    expect(s.iosNeedsInstall).toBeTrue();
    expect(s.canSubscribe).toBeFalse();
  });

  it('iOS en PWA installée redevient un cas normal', () => {
    const s = derivePushDeviceState({ ...base, isIOS: true, isStandalone: true, subscribed: false });
    expect(s.banner).toBe('not-subscribed');
    expect(s.iosNeedsInstall).toBeFalse();
    expect(s.canSubscribe).toBeTrue();
  });

  it('VAPID absent côté serveur : on n\'invite pas à demander une autorisation inutile', () => {
    const s = derivePushDeviceState({ ...base, serverEnabled: false, subscribed: false });
    expect(s.banner).toBe('server-off');
    expect(s.canSubscribe).toBeFalse();
  });

  it('statut serveur encore inconnu : on ne conclut pas à une panne', () => {
    const s = derivePushDeviceState({ ...base, serverEnabled: null, subscribed: false });
    expect(s.banner).toBe('not-subscribed');
  });

  it('autorisation refusée : plus de bouton, le navigateur ne redemandera pas', () => {
    const s = derivePushDeviceState({ ...base, permission: 'denied', subscribed: false });
    expect(s.banner).toBe('denied');
    expect(s.canSubscribe).toBeFalse();
  });

  it('autorisation jamais demandée : le bouton a un sens', () => {
    const s = derivePushDeviceState({ ...base, permission: 'default', subscribed: false });
    expect(s.banner).toBe('not-subscribed');
    expect(s.canSubscribe).toBeTrue();
  });

  it('abonné : état actif, pas de bouton d\'activation', () => {
    const s = derivePushDeviceState({ ...base });
    expect(s.banner).toBe('active');
    expect(s.canSubscribe).toBeFalse();
  });
});

describe('notifications-card — reconnaissance de l\'appareil courant', () => {
  const full = 'https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bF-xyz-token-tres-long-1234567890';
  const truncated = full.slice(0, 60) + '...';

  it('reconnaît l\'appareil courant malgré l\'endpoint tronqué par l\'API', () => {
    expect(isCurrentDeviceEndpoint(truncated, full)).toBeTrue();
  });

  it('ne confond pas deux appareils du même service push', () => {
    const other = 'https://fcm.googleapis.com/fcm/send/AUTRE:APA91b-un-tout-autre-token-987654321';
    expect(isCurrentDeviceEndpoint(truncated, other)).toBeFalse();
  });

  it('refuse un préfixe trop court pour être discriminant', () => {
    expect(isCurrentDeviceEndpoint('https://fcm.google...', full)).toBeFalse();
  });

  it('sans abonnement local, aucun appareil n\'est « le mien »', () => {
    expect(isCurrentDeviceEndpoint(truncated, null)).toBeFalse();
    expect(isCurrentDeviceEndpoint(null, full)).toBeFalse();
  });
});

describe('notifications-card — liste des appareils', () => {
  /**
   * Le signal `devices` du service est partagé avec l'écran Observabilité, qui le remplit
   * parfois avec TOUS les comptes (`scope=all`). Cette carte propose un bouton
   * « Révoquer » à côté de chaque ligne, et le backend l'accepte pour un SUPER_ADMIN :
   * afficher l'appareil d'un client, ne serait-ce qu'une seconde, c'est un clic de trop.
   */
  const device = (id: string, isMine: boolean): PushSubscriptionDto => ({
    id,
    endpoint: 'https://fcm.googleapis.com/fcm/send/' + id + '...',
    endpointHost: 'fcm.googleapis.com',
    userId: isMine ? 'moi' : 'quelqu-un-d-autre',
    userEmail: null,
    userName: null,
    userRole: null,
    userAgent: null,
    lastSeenAt: '2026-07-27T10:00:00.000Z',
    createdAt: '2026-07-01T10:00:00.000Z',
    isMine,
  });

  it('n\'affiche jamais l\'appareil d\'un autre compte, même chargé par un autre écran', () => {
    const kept = ownDevices([device('a', true), device('b', false), device('c', true)]);
    expect(kept.map((d) => d.id)).toEqual(['a', 'c']);
  });

  it('une liste entièrement étrangère devient vide, pas partiellement filtrée', () => {
    expect(ownDevices([device('x', false), device('y', false)])).toEqual([]);
  });
});

describe('notifications-card — ce que « actif » promet vraiment', () => {
  const eligible = { pushEnabled: true, eligible: true };

  it('abonné, éligible, interrupteur allumé : on promet la livraison', () => {
    expect(activeDeliveryHint(eligible, false)).toContain('arriveront ici');
  });

  it('interrupteur maître coupé : on ne promet plus rien', () => {
    const hint = activeDeliveryHint({ ...eligible, pushEnabled: false }, false);
    expect(hint).toContain('rien n\'arrivera');
    expect(hint).not.toContain('arriveront ici');
  });

  it('rôle hors périmètre de déploiement : on le dit au lieu d\'annoncer « actif »', () => {
    const hint = activeDeliveryHint({ ...eligible, eligible: false }, false);
    expect(hint).toContain('votre rôle');
    expect(hint).not.toContain('arriveront ici');
  });

  it('serveur muet : le repli local (eligible=false) ne vaut pas verdict sur le rôle', () => {
    // Sinon l'écran accuserait le déploiement d'une restriction qu'il n'a pas pu vérifier.
    const hint = activeDeliveryHint({ pushEnabled: true, eligible: false }, true);
    expect(hint).toContain('arriveront ici');
    expect(hint).not.toContain('votre rôle');
  });

  it('préférences pas encore chargées : phrase neutre, aucune accusation', () => {
    expect(activeDeliveryHint(null, false)).toContain('arriveront ici');
  });
});
