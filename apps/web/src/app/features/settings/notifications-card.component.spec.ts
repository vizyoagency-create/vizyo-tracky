import type { AlertType } from '@vizyo/tracky-shared';
import { DEFAULT_MUTED_TYPES, PUSH_MAX_PER_HOUR, shouldPushAlert } from '@vizyo/tracky-shared';
import type { PushSubscriptionDto } from '../../core/services/notifications.service';
import {
  ALERT_TYPE_GROUPS,
  SEVERITY_OPTIONS,
  activeDeliveryHint,
  buildDeliveryForecast,
  buildGroupViews,
  dailyVolumeLabel,
  derivePushDeviceState,
  forecastNotes,
  forecastSentence,
  frequencyLabel,
  isCurrentDeviceEndpoint,
  ownDevices,
  setGroupMuted,
  toggleMutedType,
  type PushPreferenceCore,
} from './notifications-card.component';

/**
 * Reglages courants d'un utilisateur, forme minimale.
 *
 * Defaut du harnais = le DEFAUT SERVEUR (seuil `warning`, POWER_CUT et OVERSPEED coupes),
 * pour que les tests raisonnent sur la situation reelle d'un compte qui n'a jamais rien
 * regle — c'est-a-dire celle de tout le monde aujourd'hui.
 */
const prefOf = (over: Partial<PushPreferenceCore> = {}): PushPreferenceCore => ({
  pushEnabled: true,
  minSeverity: 'warning',
  mutedTypes: [...DEFAULT_MUTED_TYPES],
  ...over,
});

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
    const views = buildGroupViews(ALERT_TYPE_GROUPS, prefOf({ mutedTypes: ['OVERSPEED'] }));
    const driving = views.find((v) => v.key === 'driving')!;
    expect(driving.activeCount).toBe(driving.total - 1);
    expect(driving.allMuted).toBeFalse();
    expect(driving.items.find((i) => i.type === 'OVERSPEED')!.enabled).toBeFalse();
    expect(driving.items.find((i) => i.type === 'HARSH_TURN')!.enabled).toBeTrue();
  });

  it('marque une famille entièrement coupée', () => {
    const driving = ALERT_TYPE_GROUPS.find((g) => g.key === 'driving')!;
    const views = buildGroupViews(
      ALERT_TYPE_GROUPS,
      prefOf({ mutedTypes: driving.types.map((t) => t.type) }),
    );
    const view = views.find((v) => v.key === 'driving')!;
    expect(view.allMuted).toBeTrue();
    expect(view.activeCount).toBe(0);
    // Les autres familles ne bougent pas : pas de fuite d'un groupe à l'autre.
    expect(views.find((v) => v.key === 'safety')!.allMuted).toBeFalse();
  });

  it('chaque type porte une gravité et une fréquence — sans quoi le réglage est un piège', () => {
    for (const g of ALERT_TYPE_GROUPS) {
      for (const t of g.types) {
        expect(['info', 'warning', 'critical']).toContain(t.severity);
        expect(t.frequency.perDay).toBeGreaterThanOrEqual(0);
        expect(['measured', 'none-observed']).toContain(t.frequency.basis);
      }
    }
  });

  it('les deux sources de bruit MESUREES sont bien celles coupees par defaut', () => {
    // Le lien entre le chiffre et la decision doit rester verifiable : si un type
    // depasse 100/jour sans etre coupe par defaut, c'est que l'un des deux a bouge.
    const loud = ALERT_TYPE_GROUPS.flatMap((g) => g.types).filter((t) => t.frequency.perDay >= 100);
    expect(loud.map((t) => t.type).sort()).toEqual([...DEFAULT_MUTED_TYPES].sort());
    // Et ils expliquent POURQUOI ils sont coupés : une coupure muette serait un silence.
    for (const t of loud) expect(t.noiseNote).toBeTruthy();
  });
});

describe('notifications-card — fréquences affichées', () => {
  it('traduit un volume en ordre de grandeur lisible, jamais en décimales', () => {
    expect(frequencyLabel({ perDay: 330, basis: 'measured' })).toBe('≈ 330 / jour');
    expect(frequencyLabel({ perDay: 14 / 30, basis: 'measured' })).toBe('≈ 3 / semaine');
    expect(frequencyLabel({ perDay: 3 / 365, basis: 'measured' })).toContain('exceptionnelle');
    expect(frequencyLabel({ perDay: 0, basis: 'none-observed' })).toBe('aucune en 30 jours');
  });

  it('SOS et batterie faible sont annoncés comme exceptionnels, pas comme « aucune »', () => {
    // La nuance compte : « aucune en 30 jours » invite à couper, « exceptionnelle » non.
    const all = ALERT_TYPE_GROUPS.flatMap((g) => g.types);
    const sos = all.find((t) => t.type === 'SOS')!;
    const battery = all.find((t) => t.type === 'LOW_BATTERY')!;
    expect(frequencyLabel(sos.frequency)).toContain('exceptionnelle');
    expect(frequencyLabel(battery.frequency)).toContain('exceptionnelle');
  });

  it('les deux bruyants sont annoncés en « par jour » — visible avant le clic', () => {
    const all = ALERT_TYPE_GROUPS.flatMap((g) => g.types);
    expect(frequencyLabel(all.find((t) => t.type === 'OVERSPEED')!.frequency)).toBe('≈ 164 / jour');
    expect(frequencyLabel(all.find((t) => t.type === 'POWER_CUT')!.frequency)).toBe('≈ 330 / jour');
  });

  it('formule le volume attendu sans jamais annoncer « 0 par jour »', () => {
    expect(dailyVolumeLabel(2.3)).toBe('environ 2 notifications par jour');
    expect(dailyVolumeLabel(1)).toBe('environ 1 notification par jour');
    expect(dailyVolumeLabel(0.5)).toBe('environ 4 notifications par semaine');
    expect(dailyVolumeLabel(0.01)).toContain('moins d\'une');
    expect(dailyVolumeLabel(0)).toContain('aucune');
  });

  it('accorde le singulier a la semaine — un « 1 notifications » decredibiliserait le chiffre', () => {
    // La borne basse de la branche hebdomadaire (1/7 par jour) s'arrondit pile a 1.
    expect(dailyVolumeLabel(1 / 7)).toBe('environ 1 notification par semaine');
    expect(dailyVolumeLabel(2 / 7)).toBe('environ 2 notifications par semaine');
  });
});

describe('notifications-card — ce qui sera réellement reçu', () => {
  it('LE DEFAUT SERVEUR donne quelques notifications par jour, pas des dizaines', () => {
    // Le calcul qui justifie le défaut : POWER_CUT (330/j) et OVERSPEED (164/j) coupés,
    // il ne reste que les zones (~1,8/j) et le GPS perdu (~0,5/j).
    const f = buildDeliveryForecast(ALERT_TYPE_GROUPS, prefOf());
    expect(f.perDay).toBeLessThan(5);
    expect(f.perDay).toBeGreaterThan(1);
    expect(f.tone).toBe('quiet');
    expect(f.hitsHourlyCap).toBeFalse();
  });

  it('LE CAS DE L UTILISATEUR : batterie faible et SOS passent le défaut', () => {
    // Il veut vérifier que « batterie faible » fonctionne. Avec l'ancien défaut
    // (`critical`), il n'aurait rien reçu et aurait conclu que c'était cassé.
    const items = buildGroupViews(ALERT_TYPE_GROUPS, prefOf()).flatMap((g) => g.items);
    expect(items.find((i) => i.type === 'LOW_BATTERY')!.willReceive).toBeTrue();
    expect(items.find((i) => i.type === 'SOS')!.willReceive).toBeTrue();
    expect(items.find((i) => i.type === 'POWER_CUT')!.willReceive).toBeFalse();
    expect(items.find((i) => i.type === 'OVERSPEED')!.willReceive).toBeFalse();
  });

  it('L AUTRE PIEGE : un type allumé mais sous le seuil est NOMMÉ, pas passé sous silence', () => {
    // Le scénario exact : l'utilisateur veut tester « batterie faible », ne garde qu'elle,
    // mais son seuil est resté sur « critiques uniquement ». L'interrupteur est vert et
    // pourtant rien n'arrivera. Sans cette mention, il conclut à une panne.
    const everythingElse = ALERT_TYPE_GROUPS.flatMap((g) => g.types.map((t) => t.type)).filter(
      (t) => t !== 'LOW_BATTERY',
    );
    const pref = prefOf({ minSeverity: 'critical', mutedTypes: everythingElse });
    const items = buildGroupViews(ALERT_TYPE_GROUPS, pref).flatMap((g) => g.items);
    const battery = items.find((i) => i.type === 'LOW_BATTERY')!;

    expect(battery.enabled).toBeTrue();
    expect(battery.willReceive).toBeFalse();
    expect(battery.blockedBySeverity).toBeTrue();

    const notes = forecastNotes(buildDeliveryForecast(ALERT_TYPE_GROUPS, pref));
    expect(notes[0]).toContain('Batterie faible');
    expect(notes[0]).toContain('seuil');
  });

  it('beaucoup de types retenus : on compte au lieu d\'aligner dix-huit noms illisibles', () => {
    const pref = prefOf({ minSeverity: 'critical', mutedTypes: [] });
    const f = buildDeliveryForecast(ALERT_TYPE_GROUPS, pref);
    expect(f.blockedBySeverity.length).toBeGreaterThan(4);

    const note = forecastNotes(f)[0];
    expect(note).toContain(`${f.blockedBySeverity.length} types`);
    expect(note).toContain('autres');
    // Le détail reste visible ligne par ligne, à côté de chaque interrupteur.
    const items = buildGroupViews(ALERT_TYPE_GROUPS, pref).flatMap((g) => g.items);
    expect(items.find((i) => i.type === 'LOW_BATTERY')!.blockedBySeverity).toBeTrue();
  });

  it('un type COUPE n est pas presente comme « retenu par le seuil » (l interrupteur suffit)', () => {
    const items = buildGroupViews(ALERT_TYPE_GROUPS, prefOf()).flatMap((g) => g.items);
    const overspeed = items.find((i) => i.type === 'OVERSPEED')!;
    expect(overspeed.enabled).toBeFalse();
    expect(overspeed.blockedBySeverity).toBeFalse();
  });

  it('interrupteur maître coupé : aucun type n\'est marqué « retenu par le seuil »', () => {
    // Sinon l'écran accuserait le seuil d'un silence que le maître explique déjà.
    const pref = prefOf({ pushEnabled: false, mutedTypes: [] });
    const items = buildGroupViews(ALERT_TYPE_GROUPS, pref).flatMap((g) => g.items);
    expect(items.every((i) => !i.blockedBySeverity)).toBeTrue();
    expect(items.every((i) => !i.willReceive)).toBeTrue();

    const f = buildDeliveryForecast(ALERT_TYPE_GROUPS, pref);
    expect(f.tone).toBe('off');
    expect(forecastSentence(f)).toContain('coupé');
    expect(forecastNotes(f)).toEqual([]);
  });

  it('tout rallumé : l\'écran ANNONCE l\'avalanche au lieu de la laisser découvrir', () => {
    const pref = prefOf({ minSeverity: 'info', mutedTypes: [] });
    const f = buildDeliveryForecast(ALERT_TYPE_GROUPS, pref);

    expect(f.perDay).toBeGreaterThan(400); // 330 + 164 + le reste
    expect(f.tone).toBe('flood');
    expect(forecastSentence(f)).toContain('par jour');
    expect(f.loudest[0]).toBe('Alimentation coupée');
    expect(f.loudest[1]).toBe('Excès de vitesse');

    const notes = forecastNotes(f);
    expect(notes.some((n) => n.includes('Alimentation coupée'))).toBeTrue();
    expect(notes.some((n) => n.includes(String(PUSH_MAX_PER_HOUR)))).toBeTrue();
  });

  it('tout coupé : on le dit franchement au lieu d\'afficher un volume de zéro', () => {
    const pref = prefOf({ mutedTypes: ALERT_TYPE_GROUPS.flatMap((g) => g.types.map((t) => t.type)) });
    const f = buildDeliveryForecast(ALERT_TYPE_GROUPS, pref);
    expect(f.keptCount).toBe(0);
    expect(f.tone).toBe('silent');
    expect(forecastSentence(f)).toContain('aucune notification');
  });

  it('la prévision utilise la RÈGLE DU SERVEUR, pas une copie locale', () => {
    // Garde-fou anti-divergence : si `shouldPushAlert` change côté contrat partagé, la
    // prévision doit changer avec — sinon l'écran se remet à mentir.
    const pref = prefOf({ minSeverity: 'critical', mutedTypes: ['SOS'] });
    for (const g of buildGroupViews(ALERT_TYPE_GROUPS, pref)) {
      for (const i of g.items) {
        expect(i.willReceive).toBe(shouldPushAlert(pref, { type: i.type, severity: i.severity }));
      }
    }
  });

  it('le volume d\'une famille ne compte que ses types réellement reçus', () => {
    const views = buildGroupViews(ALERT_TYPE_GROUPS, prefOf());
    const safety = views.find((v) => v.key === 'safety')!;
    // POWER_CUT (330/j) est coupé : la famille « Sécurité » doit rester quasi muette.
    expect(safety.perDay).toBeLessThan(1);
    expect(safety.receivedCount).toBe(safety.total - 1);
  });

  it('HORS PERIMETRE : on n annonce AUCUN volume — c est le bug d origine a l envers', () => {
    // En production `PUSH_ROLLOUT=SUPER_ADMIN_ONLY` : pour un compte client, le serveur
    // ecarte l'envoi au motif `rollout` AVANT de lire la moindre preference. Promettre
    // « environ 2 notifications par jour » a ce compte, c'est refaire exactement ce que
    // faisait l'ecran cassé — affirmer pendant que rien ne part.
    const f = buildDeliveryForecast(ALERT_TYPE_GROUPS, prefOf(), false);
    expect(f.tone).toBe('ineligible');
    expect(forecastSentence(f)).toContain('rôle');
    expect(forecastSentence(f)).not.toContain('par jour');
    // Aucune precision secondaire : envoyer l'utilisateur regler son seuil alors que le
    // perimetre bloque tout, c'est le faire chercher une panne qui n'existe pas.
    expect(forecastNotes(f)).toEqual([]);
  });

  it('hors périmètre, même tout rallumé, aucun écrêtage horaire n\'est annoncé', () => {
    const pref = prefOf({ minSeverity: 'info', mutedTypes: [] });
    const f = buildDeliveryForecast(ALERT_TYPE_GROUPS, pref, false);
    expect(f.perDay).toBeGreaterThan(400); // le filtre laisserait tout passer…
    expect(f.hitsHourlyCap).toBeFalse(); // …mais rien n'atteindra jamais le plafond.
    expect(f.tone).toBe('ineligible');
  });

  it('le périmètre prime sur l\'interrupteur maître : on nomme la cause qu\'on ne peut pas corriger', () => {
    const f = buildDeliveryForecast(ALERT_TYPE_GROUPS, prefOf({ pushEnabled: false }), false);
    expect(f.tone).toBe('ineligible');
  });

  it('éligible : le comportement d\'origine est intact (défaut du paramètre)', () => {
    const withFlag = buildDeliveryForecast(ALERT_TYPE_GROUPS, prefOf(), true);
    const withoutFlag = buildDeliveryForecast(ALERT_TYPE_GROUPS, prefOf());
    expect(withFlag).toEqual(withoutFlag);
    expect(withFlag.tone).toBe('quiet');
  });
});

describe('notifications-card — libellés du seuil de gravité', () => {
  it('chaque option annonce son piège, pas seulement son bénéfice', () => {
    const critical = SEVERITY_OPTIONS.find((o) => o.value === 'critical')!;
    // « Critiques uniquement » a l'air prudent : il faut dire qu'il coupe la batterie faible.
    expect(critical.hint).toContain('batterie faible');
    const warning = SEVERITY_OPTIONS.find((o) => o.value === 'warning')!;
    expect(warning.hint).toContain('Recommandé');
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
