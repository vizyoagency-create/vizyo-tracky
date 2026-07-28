import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import {
  NOTIFICATION_CHANNEL_LABELS,
  NOTIFICATION_SEVERITY_LABELS,
  NOTIFICATION_STATUS_LABELS,
  SUPPRESSION_LABELS,
  type NotificationDeliveryRowDto,
  type NotificationHealthDto,
  type NotificationSummaryDto,
} from '@vizyo/tracky-shared';
import {
  ALERT_TYPE_LABELS_FR,
  GAUGE_CIRCUMFERENCE,
  STALE_PUSH_MS,
  alertTypeLabel,
  channelLabel,
  deliveryDetail,
  gaugeDash,
  healthVerdict,
  isRoleInScope,
  mergePages,
  previewFrom,
  protectionNote,
  reasonLabel,
  reasonRows,
  recipientName,
  roleText,
  rolloutLabel,
  severityKey,
  severityLabel,
  statusLabel,
  statusTone,
  typeRows,
  windowRange,
  withheldPct,
  AdminNotificationsComponent,
} from './admin-notifications.component';
import { NotificationCenterApiService } from '../../core/services/notification-center-api.service';

/**
 * Tests de la LOGIQUE du centre de notifications, sans DOM (même motif que
 * `notifications-card.component.spec.ts`).
 *
 * Ce qui est vérifié ici, c'est ce que l'écran AFFIRME. Le bug d'origine n'était pas un
 * défaut d'affichage : c'était l'absence d'un endroit où constater que rien ne partait. Un
 * écran qui afficherait « tout va bien » sur une chaîne morte serait une régression pire que
 * le silence — d'où le poids donné aux faux verts.
 */

const health = (over: Partial<NotificationHealthDto> = {}): NotificationHealthDto => ({
  vapidConfigured: true,
  pushRollout: 'SUPER_ADMIN_ONLY',
  totalDevices: 14,
  usersWithDevice: 3,
  reachByRole: [{ role: 'SUPER_ADMIN', users: 3, usersWithDevice: 3, devices: 14 }],
  lastSuccessfulPushAt: new Date().toISOString(),
  lastAttemptAt: new Date().toISOString(),
  eligibleUsers: 3,
  eligibleWithoutDevice: 0,
  unreachableUsers: [],
  warnings: [],
  ...over,
});

const summary = (over: Partial<NotificationSummaryDto> = {}): NotificationSummaryDto => ({
  from: '2026-07-20T00:00:00.000Z',
  to: '2026-07-27T00:00:00.000Z',
  windowDays: 7,
  total: 0,
  sent: 0,
  failed: 0,
  suppressed: 0,
  grouped: 0,
  withheld: 0,
  suppressionRate: 0,
  byReason: [],
  byStatus: [],
  byChannel: [],
  bySeverity: [],
  byAlertType: [],
  topRecipients: [],
  headline: '',
  ...over,
});

const delivery = (over: Partial<NotificationDeliveryRowDto> = {}): NotificationDeliveryRowDto => ({
  id: 'd1',
  createdAt: '2026-07-27T10:00:00.000Z',
  alertId: 'a1',
  alertType: 'SOS',
  severity: 'critical',
  userId: 'u1',
  userEmail: 'y@example.com',
  userName: 'Younes H.',
  userRole: 'SUPER_ADMIN',
  fleetId: null,
  fleetName: null,
  channel: 'WEB_PUSH',
  status: 'SENT',
  statusLabel: 'Envoyée',
  reason: null,
  reasonLabel: null,
  title: 'SOS — Renault Kangoo',
  body: 'Bouton SOS déclenché à Toulouse.',
  deviceCount: 2,
  sentCount: 2,
  failedCount: 0,
  groupedCount: 0,
  ...over,
});

describe('centre de notifications — libellés FR', () => {
  it('traduit tous les types d\'alerte connus, sans laisser d\'identifiant brut', () => {
    for (const label of Object.values(ALERT_TYPE_LABELS_FR)) {
      // Un identifiant technique s'écrit MAJUSCULES_AVEC_UNDERSCORES : aucun libellé ne doit
      // ressembler à ça (« SOS » est un mot français, pas un identifiant : il est admis).
      expect(label === 'SOS' || !/^[A-Z][A-Z_]+$/.test(label)).toBeTrue();
    }
  });

  it('humanise un type inconnu au lieu d\'afficher HARSH_BRAKING_V2 à l\'écran', () => {
    // L'API renvoie volontairement les clés brutes pour `byAlertType` : la traduction est ici,
    // et un type ajouté côté serveur ne doit jamais fuir tel quel dans l'interface.
    expect(alertTypeLabel('HARSH_BRAKING_V2')).toBe('Harsh braking v2');
    expect(alertTypeLabel('POWER_CUT')).toBe('Coupure d\'alimentation');
    expect(alertTypeLabel('hors alerte')).toBe('Hors alerte');
  });

  it('sans type (envoi de test, notification hors alerte), reste lisible', () => {
    expect(alertTypeLabel(null)).toBe('Notification');
    expect(alertTypeLabel('')).toBe('Notification');
  });

  it('reprend les libellés d\'issue du contrat PARTAGÉ, sans table locale concurrente', () => {
    for (const [key, label] of Object.entries(NOTIFICATION_STATUS_LABELS)) {
      expect(statusLabel(key)).toBe(label);
    }
    expect(statusLabel('ETAT_INEDIT')).toBe('Etat inedit');
    expect(statusLabel(null)).toBe('Inconnue');
  });

  it('reprend aussi les libellés de motifs du contrat partagé', () => {
    // Deux formulations divergentes (API vs écran) feraient dépendre le diagnostic de
    // l'endroit où on le lit.
    for (const [key, label] of Object.entries(SUPPRESSION_LABELS)) {
      expect(reasonLabel(key)).toBe(label);
    }
    expect(reasonLabel('motif_inedit')).toBe('Motif inedit');
    expect(reasonLabel(null)).toBe('');
  });

  it('nomme les canaux avec la table du contrat PARTAGÉ, pas une copie locale', () => {
    // L'API sert déjà `byChannel[].label` depuis cette table : une seconde table côté écran
    // faisait dire « Push » ici et « Push navigateur » là, pour la même colonne.
    for (const [key, label] of Object.entries(NOTIFICATION_CHANNEL_LABELS)) {
      expect(channelLabel(key)).toBe(label);
    }
    expect(channelLabel('TELEGRAM')).toBe('Telegram');
    expect(channelLabel(null)).toBe('—');
  });

  it('nomme les rôles sans jamais laisser passer un identifiant brut', () => {
    expect(roleText('SUPER_ADMIN')).toBe('Super-Administrateur');
    // `roleLabel` renvoie la valeur telle quelle pour un rôle inconnu : c'est ce qui
    // afficherait INCONNU (le rôle posé par l'API sur un compte supprimé) en capitales.
    expect(roleText('INCONNU')).toBe('Inconnu');
    expect(roleText('ROLE_INEDIT')).toBe('Role inedit');
    expect(roleText(null)).toBe('');
  });

  it('dit le périmètre de déploiement en toutes lettres', () => {
    expect(rolloutLabel('SUPER_ADMIN_ONLY')).toBe('Super-administrateurs seulement');
    expect(rolloutLabel('ALL')).toBe('Tous les rôles');
    expect(rolloutLabel(null)).toBe('Inconnu');
  });

  it('nomme un destinataire, jamais son UUID', () => {
    expect(recipientName({ name: 'Younes H.', email: 'y@x.fr' })).toBe('Younes H.');
    expect(recipientName({ name: null, email: 'y@x.fr' })).toBe('y@x.fr');
    expect(recipientName(delivery())).toBe('Younes H.');
    expect(recipientName({ userName: null, userEmail: null })).toBe('Compte supprimé');
  });
});

describe('centre de notifications — sévérité (piège MAJUSCULES / minuscules)', () => {
  /**
   * Le contrat client est en minuscules, l'enum Prisma en MAJUSCULES, et la colonne du
   * journal est un texte libre. L'API normalise, mais une ligne écrite avant cette
   * normalisation reste en base : comparer sans normaliser afficherait « — » sur un SOS.
   */
  it('accepte les deux formes du contrat', () => {
    expect(severityKey('CRITICAL')).toBe('critical');
    expect(severityKey('critical')).toBe('critical');
    expect(severityKey('Warning')).toBe('warning');
    expect(severityLabel('CRITICAL')).toBe('Critique');
    expect(severityLabel('info')).toBe('Information');
  });

  it('ne devine pas une sévérité inconnue', () => {
    expect(severityKey('URGENT')).toBeNull();
    expect(severityKey(null)).toBeNull();
    expect(severityLabel('URGENT')).toBe('—');
  });

  it('reprend les libellés de sévérité du contrat partagé', () => {
    for (const [key, label] of Object.entries(NOTIFICATION_SEVERITY_LABELS)) {
      expect(severityLabel(key)).toBe(label);
    }
  });
});

describe('centre de notifications — ton des issues', () => {
  it('ne peint pas en rouge ce qui n\'est pas une erreur', () => {
    // SUPPRESSED et GROUPED sont les garde-fous qui fonctionnent. Les afficher comme des
    // pannes apprendrait à ignorer le rouge — et FAILED deviendrait invisible.
    expect(statusTone('SUPPRESSED')).toBe('suppressed');
    expect(statusTone('GROUPED')).toBe('grouped');
    expect(statusTone('FAILED')).toBe('failed');
    expect(statusTone('SENT')).toBe('sent');
    expect(statusTone(null)).toBe('unknown');
  });
});

describe('centre de notifications — verdict de santé', () => {
  it('sans données, n\'affirme rien', () => {
    expect(healthVerdict(null).level).toBe('unknown');
  });

  it('VAPID absent : rien ne peut partir, c\'est le seul message qui compte', () => {
    const v = healthVerdict(health({ vapidConfigured: false, totalDevices: 0, eligibleUsers: 0 }));
    expect(v.level).toBe('down');
    expect(v.title).toBe('Push hors service');
  });

  it('périmètre fermé sur du vide : aucun compte à notifier', () => {
    const v = healthVerdict(health({ eligibleUsers: 0, eligibleWithoutDevice: 0 }));
    expect(v.level).toBe('down');
    expect(v.title).toBe('Aucun compte dans le périmètre');
  });

  /**
   * Le cas vicieux, et la raison d'être du chiffre « éligibles sans appareil » : 12 appareils
   * abonnés, tous sur des rôles hors périmètre. Tous les indicateurs paraissent verts et
   * AUCUN push n'atteindra jamais un téléphone — exactement le scénario du bug d'origine.
   */
  it('des appareils abonnés HORS périmètre ne valent pas une chaîne saine', () => {
    const v = healthVerdict(health({
      pushRollout: 'SUPER_ADMIN_ONLY',
      totalDevices: 12,
      usersWithDevice: 4,
      reachByRole: [{ role: 'FLEET_ADMIN', users: 4, usersWithDevice: 4, devices: 12 }],
      eligibleUsers: 2,
      eligibleWithoutDevice: 2,
    }));
    expect(v.level).toBe('down');
    expect(v.title).toBe('Aucun destinataire joignable');
    expect(v.detail).toContain('12');
  });

  it('chaîne prête mais jamais confirmée : doute, pas panne', () => {
    const v = healthVerdict(health({ lastSuccessfulPushAt: null }));
    expect(v.level).toBe('warn');
    expect(v.title).toBe('Jamais confirmé');
  });

  it('silence prolongé : on lève un doute sans crier à la panne', () => {
    const now = Date.parse('2026-07-27T12:00:00.000Z');
    const old = new Date(now - STALE_PUSH_MS - 60_000).toISOString();
    const v = healthVerdict(health({ lastSuccessfulPushAt: old }), now);
    expect(v.level).toBe('warn');
    expect(v.title).toBe('Aucun envoi récent');
    // Les alertes utiles sont rarissimes (SOS : 3/an) : un silence n'est PAS une preuve de panne.
    expect(v.detail).toContain('pas forcément une panne');
  });

  it('un envoi réussi juste avant la limite reste vert', () => {
    const now = Date.parse('2026-07-27T12:00:00.000Z');
    const recent = new Date(now - STALE_PUSH_MS + 60_000).toISOString();
    expect(healthVerdict(health({ lastSuccessfulPushAt: recent }), now).level).toBe('ok');
  });

  it('une date illisible ne fabrique pas une fausse alerte', () => {
    expect(healthVerdict(health({ lastSuccessfulPushAt: 'pas-une-date' })).level).toBe('ok');
  });

  it('un trou PARTIEL de couverture n\'éteint pas le verdict vert', () => {
    // 1 compte sur 3 sans appareil : la chaîne marche, la tuile dédiée porte l'avertissement.
    expect(healthVerdict(health({ eligibleUsers: 3, eligibleWithoutDevice: 1 })).level).toBe('ok');
  });
});

describe('centre de notifications — périmètre par rôle', () => {
  it('en déploiement restreint, seuls les super-admins sont dans le périmètre', () => {
    expect(isRoleInScope('SUPER_ADMIN', 'SUPER_ADMIN_ONLY')).toBeTrue();
    expect(isRoleInScope('FLEET_ADMIN', 'SUPER_ADMIN_ONLY')).toBeFalse();
  });

  it('en déploiement ouvert, tous les rôles le sont', () => {
    expect(isRoleInScope('VIEWER', 'ALL')).toBeTrue();
  });
});

describe('centre de notifications — taux de filtrage présenté comme une protection', () => {
  it('convertit le taux de l\'API (0..1) sans le recalculer', () => {
    // Recalculer ici ferait diverger l'écran du chiffre servi à l'API — et les échecs
    // techniques, volontairement exclus du taux, y rentreraient par la petite porte.
    expect(withheldPct(summary({ total: 100, withheld: 94, suppressionRate: 0.94 }))).toBe(94);
    expect(withheldPct(summary())).toBe(0);
    expect(withheldPct(null)).toBe(0);
  });

  it('explique un taux élevé au lieu de le laisser passer pour une panne', () => {
    const note = protectionNote(summary({ total: 1000, sent: 60, withheld: 940, suppressionRate: 0.94 }));
    expect(note).toContain('94 %');
    expect(note).toContain('fonctionnement attendu');
    // Les deux sources de bruit MESURÉES doivent être nommées : sinon quelqu'un
    // « réparera » le garde-fou en croyant corriger un bug.
    expect(note).toContain('coupure d\'alimentation');
    expect(note).toContain('excès de vitesse');
  });

  it('ne parle pas de filtrage quand rien n\'a été retenu', () => {
    expect(protectionNote(summary({ total: 12, sent: 12 }))).toContain('Aucune notification retenue');
  });

  it('période vide : aucune conclusion', () => {
    expect(protectionNote(summary())).toBe('Aucune notification sur la période.');
  });

  /**
   * Le symétrique du piège précédent, et le plus dangereux des deux : « c'est le
   * fonctionnement attendu » affiché au-dessus d'un mur de `no_device` ferait passer pour
   * une protection le fait que PERSONNE n'est joignable — soit exactement le silence
   * invisible que cet écran existe pour supprimer.
   */
  it('n\'appelle pas « fonctionnement attendu » des destinataires injoignables', () => {
    const note = protectionNote(summary({
      total: 400, sent: 10, suppressed: 390, withheld: 390, suppressionRate: 0.975,
      byReason: [{ reason: 'no_device', label: SUPPRESSION_LABELS.no_device, count: 390, share: 1 }],
    }));
    expect(note).not.toContain('fonctionnement attendu');
    expect(note).toContain('injoignables');
    expect(note).toContain(SUPPRESSION_LABELS.no_device.toLowerCase());
  });

  it('un plafond horaire dominant est nommé comme tel, pas maquillé en réglage', () => {
    const note = protectionNote(summary({
      total: 200, sent: 12, suppressed: 188, withheld: 188, suppressionRate: 0.94,
      byReason: [{ reason: 'hourly_cap', label: SUPPRESSION_LABELS.hourly_cap, count: 188, share: 1 }],
    }));
    expect(note).toContain('plafond');
    expect(note).not.toContain('fonctionnement attendu');
  });

  it('quand le motif dominant EST la coupure par type, garde l\'explication anti-bruit', () => {
    const note = protectionNote(summary({
      total: 1000, sent: 60, suppressed: 940, withheld: 940, suppressionRate: 0.94,
      byReason: [
        { reason: 'preference_type_muted', label: SUPPRESSION_LABELS.preference_type_muted, count: 900, share: 0.957 },
        { reason: 'no_device', label: SUPPRESSION_LABELS.no_device, count: 40, share: 0.043 },
      ],
    }));
    expect(note).toContain('fonctionnement attendu');
    expect(note).toContain('coupure d\'alimentation');
  });
});

describe('centre de notifications — répartition des motifs', () => {
  it('trie du plus fréquent au moins fréquent et convertit la part en %', () => {
    const rows = reasonRows(summary({
      byReason: [
        { reason: 'cooldown', label: SUPPRESSION_LABELS.cooldown, count: 10, share: 0.1 },
        { reason: 'preference_type_muted', label: SUPPRESSION_LABELS.preference_type_muted, count: 70, share: 0.7 },
        { reason: 'hourly_cap', label: SUPPRESSION_LABELS.hourly_cap, count: 20, share: 0.2 },
      ],
    }));
    expect(rows.map((r) => r.key)).toEqual(['preference_type_muted', 'hourly_cap', 'cooldown']);
    expect(rows[0].pct).toBe(70);
    expect(rows[0].label).toBe(SUPPRESSION_LABELS.preference_type_muted);
  });

  it('traduit un motif dont l\'API n\'aurait pas renvoyé le libellé', () => {
    const rows = reasonRows(summary({ byReason: [{ reason: 'no_device', label: '', count: 3, share: 1 }] }));
    expect(rows[0].label).toBe(SUPPRESSION_LABELS.no_device);
  });

  it('ignore les motifs à zéro (barres et menus vides = bruit visuel)', () => {
    const rows = reasonRows(summary({
      byReason: [
        { reason: 'cooldown', label: 'x', count: 0, share: 0 },
        { reason: 'no_device', label: 'y', count: 3, share: 1 },
      ],
    }));
    expect(rows.map((r) => r.key)).toEqual(['no_device']);
  });

  it('sans synthèse, renvoie une liste vide plutôt qu\'une erreur', () => {
    expect(reasonRows(null)).toEqual([]);
  });

  /**
   * `inconnu` est une étiquette FABRIQUÉE par la synthèse pour les lignes dont la colonne
   * `reason` est nulle : aucune ligne ne porte cette valeur en base. Cliquable, elle
   * afficherait « aucune notification pour ces filtres » sous un compteur non nul — une
   * contradiction, sur le seul écran dont le métier est de ne pas mentir.
   */
  it('marque non filtrable l\'étiquette de synthèse des motifs absents', () => {
    const rows = reasonRows(summary({
      byReason: [
        { reason: 'inconnu', label: 'Motif non renseigné', count: 5, share: 0.5 },
        { reason: 'cooldown', label: SUPPRESSION_LABELS.cooldown, count: 5, share: 0.5 },
      ],
    }));
    expect(rows.find((r) => r.key === 'inconnu')?.filterable).toBeFalse();
    expect(rows.find((r) => r.key === 'cooldown')?.filterable).toBeTrue();
  });
});

describe('centre de notifications — volumétrie par type', () => {
  it('traduit les clés brutes et met le plus bruyant à 100 %', () => {
    const rows = typeRows(summary({
      byAlertType: [
        { key: 'OVERSPEED', label: 'OVERSPEED', count: 164 },
        { key: 'POWER_CUT', label: 'POWER_CUT', count: 330 },
        { key: 'SOS', label: 'SOS', count: 1 },
      ],
    }));
    expect(rows.map((r) => r.key)).toEqual(['POWER_CUT', 'OVERSPEED', 'SOS']);
    expect(rows[0].label).toBe('Coupure d\'alimentation');
    expect(rows[0].pct).toBe(100);
    expect(rows[1].pct).toBe(50);
    // Un type rarissime garde une barre visible : sinon SOS disparaît à côté du bruit.
    expect(rows[2].pct).toBe(2);
  });

  it('sans données, aucune barre', () => {
    expect(typeRows(summary())).toEqual([]);
    expect(typeRows(null)).toEqual([]);
  });

  it('marque non filtrable le regroupement « hors alerte » de la synthèse', () => {
    // Le contrat autorise `alertType: null` (envoi hors alerte) et la synthèse le compte
    // sous une étiquette lisible. Cette étiquette n'existe pas en base : la renvoyer comme
    // filtre donnerait toujours zéro ligne.
    const rows = typeRows(summary({
      byAlertType: [
        { key: 'hors alerte', label: 'hors alerte', count: 4 },
        { key: 'SOS', label: 'SOS', count: 2 },
      ],
    }));
    expect(rows.find((r) => r.key === 'hors alerte')?.filterable).toBeFalse();
    expect(rows.find((r) => r.key === 'SOS')?.filterable).toBeTrue();
  });
});

/**
 * Pagination : le journal est trié `createdAt desc` et paginé par OFFSET. Une ligne insérée
 * en tête entre deux pages décale tout et fait revenir une ligne déjà affichée — plusieurs
 * fois par heure sur une table qui grossit de ~500 alertes/jour × N destinataires. Or
 * `@for … track d.id` fait TOMBER la vue entière sur une clé dupliquée : l'écran de
 * supervision disparaîtrait au moment où l'on cherche quelque chose dedans.
 */
describe('centre de notifications — enchaînement des pages', () => {
  it('n\'affiche jamais deux fois la même ligne', () => {
    const page1 = [delivery({ id: 'a' }), delivery({ id: 'b' })];
    const page2 = [delivery({ id: 'b' }), delivery({ id: 'c' })];
    expect(mergePages(page1, page2).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('conserve l\'ordre d\'arrivée et ne perd rien', () => {
    expect(mergePages([], [delivery({ id: 'x' })]).map((r) => r.id)).toEqual(['x']);
    expect(mergePages([delivery({ id: 'x' })], []).map((r) => r.id)).toEqual(['x']);
  });
});

describe('centre de notifications — détail d\'une livraison', () => {
  it('dit combien d\'appareils ont réellement reçu', () => {
    expect(deliveryDetail(delivery({ deviceCount: 3, sentCount: 2, failedCount: 1 })))
      .toBe('2/3 appareil(s) · 1 en échec');
  });

  it('un échec total le dit sans ambiguïté', () => {
    expect(deliveryDetail(delivery({ status: 'FAILED', deviceCount: 2, sentCount: 0, failedCount: 2 })))
      .toBe('0/2 appareil(s)');
  });

  it('une notification regroupée annonce ce qu\'elle a absorbé', () => {
    // Les événements du cooldown ne sont pas jetés : ils sont comptés. Ne pas l'afficher
    // ferait croire à une perte.
    expect(deliveryDetail(delivery({ status: 'GROUPED', deviceCount: 0, sentCount: 0, groupedCount: 4 })))
      .toBe('4 événement(s) repliés');
  });

  it('une notification retenue n\'invente pas de compteur d\'appareils', () => {
    expect(deliveryDetail(delivery({ status: 'SUPPRESSED', deviceCount: 0, sentCount: 0, reason: 'cooldown' })))
      .toBe('');
  });
});

describe('centre de notifications — aperçu du téléphone', () => {
  it('reprend la dernière notification RÉELLEMENT envoyée', () => {
    const p = previewFrom([
      delivery({ id: 'a', status: 'SUPPRESSED', title: 'Retenue', reason: 'cooldown' }),
      delivery({ id: 'b', status: 'SENT', title: 'SOS — Kangoo', body: 'Bouton SOS déclenché.' }),
      delivery({ id: 'c', status: 'SENT', title: 'Plus ancienne' }),
    ]);
    expect(p.real).toBeTrue();
    expect(p.title).toBe('SOS — Kangoo');
    expect(p.body).toBe('Bouton SOS déclenché.');
  });

  it('sans envoi, annonce un exemple au lieu de faire croire à un push reçu', () => {
    const p = previewFrom([delivery({ status: 'SUPPRESSED', title: null, body: null })]);
    expect(p.real).toBeFalse();
    expect(p.at).toBeNull();
  });

  it('un envoi sans titre retombe sur le libellé FR du type, jamais sur l\'identifiant', () => {
    const p = previewFrom([delivery({ status: 'SENT', title: null, body: null, alertType: 'POWER_CUT' })]);
    expect(p.title).toBe('Coupure d\'alimentation');
    expect(p.real).toBeTrue();
  });
});

describe('centre de notifications — fenêtre de lecture', () => {
  it('construit des bornes ISO cohérentes avec le raccourci choisi', () => {
    const now = Date.parse('2026-07-27T12:00:00.000Z');
    const w = windowRange(7, now);
    expect(w.to).toBe('2026-07-27T12:00:00.000Z');
    expect(w.from).toBe('2026-07-20T12:00:00.000Z');
  });
});

/**
 * Le seul test qui a besoin du DOM, et il le mérite : un `<select>` dont les `<option>`
 * viennent d'un `@for` n'affiche PAS la valeur liée si on la pose avec `[value]` sur le
 * select — Angular l'applique avant que les options existent, le navigateur l'ignore, et la
 * liste retombe sur son premier choix.
 *
 * Conséquence ici : le journal reste filtré pendant que le menu annonce « Tous ». Sur un
 * écran dont tout le propos est « ce que vous voyez est ce qui s'est passé », c'est la pire
 * catégorie de bug — il ne plante pas, il ment. Le correctif (`[selected]` par option) est
 * invisible en relecture : il lui faut un garde-fou exécuté.
 */
describe('centre de notifications — le menu reflète le filtre actif', () => {
  const page = {
    rows: [] as NotificationDeliveryRowDto[],
    total: 0,
    page: 1,
    pageSize: 50,
    hasMore: false,
    from: '2026-07-20T00:00:00.000Z',
    to: '2026-07-27T00:00:00.000Z',
  };

  const apiStub = {
    health: () => of(health()),
    summary: () => of(summary({
      total: 100, sent: 4, suppressed: 96, withheld: 96, suppressionRate: 0.96,
      byReason: [{ reason: 'cooldown', label: SUPPRESSION_LABELS.cooldown, count: 96, share: 1 }],
      byAlertType: [{ key: 'POWER_CUT', label: 'POWER_CUT', count: 100 }],
    })),
    deliveries: () => of(page),
  };

  async function render() {
    await TestBed.configureTestingModule({
      imports: [AdminNotificationsComponent],
      providers: [provideRouter([]), { provide: NotificationCenterApiService, useValue: apiStub }],
    }).compileComponents();

    const fixture = TestBed.createComponent(AdminNotificationsComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  /** Menus dans l'ordre du gabarit : issue, type, sévérité, motif. */
  const selects = (fixture: ComponentFixture<AdminNotificationsComponent>): HTMLSelectElement[] =>
    fixture.debugElement.queryAll(By.css('.nc-field select')).map((d) => d.nativeElement as HTMLSelectElement);

  it('affiche le motif choisi depuis une barre, au lieu de « Tous »', async () => {
    const fixture = await render();
    // Équivalent d'un clic sur la barre « Regroupée — même alerte trop récente ».
    (fixture.componentInstance as unknown as { setReason(v: string): void }).setReason('cooldown');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(selects(fixture)[3].value).toBe('cooldown');
  });

  it('affiche le type choisi même quand la période ne le contient plus', async () => {
    // Cas réel du bug : le filtre survit à un changement de fenêtre, `typeOptions` réinjecte
    // l'option manquante — et c'est précisément là que `[value]` échouait, puisque l'option
    // est créée APRÈS l'affectation.
    const fixture = await render();
    (fixture.componentInstance as unknown as { setType(v: string): void }).setType('SOS');
    await fixture.whenStable();
    fixture.detectChanges();

    const menu = selects(fixture)[1];
    expect(menu.value).toBe('SOS');
    expect(menu.selectedOptions[0].textContent?.trim()).toBe('SOS');
  });

  it('revient à « Toutes » quand les filtres sont effacés', async () => {
    const fixture = await render();
    const comp = fixture.componentInstance as unknown as {
      setStatus(v: string): void; clearFilters(): void;
    };
    comp.setStatus('FAILED');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(selects(fixture)[0].value).toBe('FAILED');

    comp.clearFilters();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(selects(fixture)[0].value).toBe('');
  });
});

describe('centre de notifications — jauge', () => {
  it('remplit l\'anneau proportionnellement', () => {
    expect(gaugeDash(0).startsWith('0.00 ')).toBeTrue();
    expect(gaugeDash(100)).toBe(`${GAUGE_CIRCUMFERENCE.toFixed(2)} ${GAUGE_CIRCUMFERENCE.toFixed(2)}`);
    expect(parseFloat(gaugeDash(50))).toBeCloseTo(GAUGE_CIRCUMFERENCE / 2, 1);
  });

  it('borne les valeurs aberrantes plutôt que de dessiner n\'importe quoi', () => {
    expect(parseFloat(gaugeDash(-20))).toBe(0);
    expect(parseFloat(gaugeDash(320))).toBeCloseTo(GAUGE_CIRCUMFERENCE, 1);
    expect(parseFloat(gaugeDash(Number.NaN))).toBe(0);
  });
});
