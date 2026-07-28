import { Test } from '@nestjs/testing';
import { PUSH_MAX_PER_HOUR } from '@vizyo/tracky-shared';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationThrottleService } from './notification-throttle.service';

/**
 * GARDE-FOUS ANTI-SPAM — le service seul, au niveau de sa REQUÊTE et de sa décision.
 *
 * Ce qui est vérifié ici est le contrat que le dispatch ne peut pas observer :
 *   - la lecture est BORNÉE (fenêtre d'une heure, `take`), parce qu'elle tourne sur
 *     chacune des ~500 alertes quotidiennes ;
 *   - elle est GROUPÉE : une requête pour N destinataires, jamais N requêtes ;
 *   - elle ne compte que ce qui a réellement fait vibrer un téléphone (statut SENT) ;
 *   - en panne, elle LAISSE PASSER — un garde-fou ne doit pas devenir la nouvelle cause
 *     du silence qu'on est en train de réparer.
 */
describe('NotificationThrottleService', () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

  interface Row {
    userId: string;
    status: string;
    alertId: string | null;
    alertType: string;
    createdAt: Date;
  }

  async function build(opts: {
    rows?: Row[];
    /** Véhicule de chaque alerte citée par les lignes (le journal ne stocke pas le véhicule). */
    alertVehicles?: Record<string, string | null>;
    findManyImpl?: jest.Mock;
  } = {}) {
    const { rows = [], alertVehicles = {} } = opts;
    const deliveryFindMany = opts.findManyImpl ?? jest.fn().mockResolvedValue(rows);
    const alertFindMany = jest.fn(async (args: { where?: { id?: { in?: string[] }; vehicleId?: string | null } }) => {
      const ids = args?.where?.id?.in ?? [];
      const wanted = args?.where?.vehicleId ?? null;
      return ids.filter((id) => (alertVehicles[id] ?? null) === wanted).map((id) => ({ id }));
    });
    const recordBackground = jest.fn();

    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationThrottleService,
        {
          provide: PrismaService,
          useValue: {
            notificationDelivery: { findMany: deliveryFindMany },
            alert: { findMany: alertFindMany },
          },
        },
        { provide: ErrorLogger, useValue: { recordBackground, record: jest.fn() } },
      ],
    }).compile();

    return {
      service: moduleRef.get(NotificationThrottleService),
      deliveryFindMany,
      alertFindMany,
      recordBackground,
    };
  }

  it('sans destinataire — aucune requete (le dispatch ne doit rien payer pour rien)', async () => {
    const t = await build();
    const decisions = await t.service.evaluate([], { alertType: 'POWER_CUT', vehicleId: 'v1' });

    expect(decisions.size).toBe(0);
    expect(t.deliveryFindMany).not.toHaveBeenCalled();
  });

  it('UNE requete bornee pour N destinataires', async () => {
    // Le piege evident de ce genre de filtre : une requete par destinataire, payee sur
    // chacune des ~500 alertes du jour, multipliee par le nombre d'admins.
    const t = await build();
    await t.service.evaluate(['u1', 'u2', 'u3'], { alertType: 'POWER_CUT', vehicleId: 'v1' });

    expect(t.deliveryFindMany).toHaveBeenCalledTimes(1);
    const args = t.deliveryFindMany.mock.calls[0][0];
    expect(args.where.userId.in).toEqual(['u1', 'u2', 'u3']);
    expect(args.where.channel).toBe('WEB_PUSH');
    expect(args.take).toBeLessThanOrEqual(500);
    // Fenetre glissante d'une heure : la requete ne peut pas se mettre a scanner tout
    // l'historique le jour ou la table aura grossi.
    expect(Date.now() - args.where.createdAt.gte.getTime()).toBeLessThanOrEqual(60 * 60_000 + 5_000);
    // Seules les lignes qui ont fait vibrer un telephone comptent : SENT, plus les
    // GROUPED du meme type pour le report « ×N ». Une ligne SUPPRESSED ou FAILED ne doit
    // ni consommer le plafond ni ouvrir un cooldown — sinon un appareil desabonne
    // suffirait a rendre quelqu'un muet.
    const statuses = (args.where.OR as Array<{ status: string }>).map((o) => o.status);
    expect(statuses).toEqual(['SENT', 'GROUPED']);
  });

  it('doublons de destinataires — dedoublonnes avant la requete', async () => {
    const t = await build();
    await t.service.evaluate(['u1', 'u1', 'u2'], { alertType: 'SOS', vehicleId: null });

    expect(t.deliveryFindMany.mock.calls[0][0].where.userId.in).toEqual(['u1', 'u2']);
  });

  it('aucun historique — tout le monde passe', async () => {
    const t = await build({ rows: [] });
    const decisions = await t.service.evaluate(['u1', 'u2'], { alertType: 'POWER_CUT', vehicleId: 'v1' });

    expect(decisions.get('u1')).toEqual({ allowed: true, reason: null, groupedCount: 0 });
    expect(decisions.get('u2')).toEqual({ allowed: true, reason: null, groupedCount: 0 });
    // Aucune ligne a qualifier => on ne va meme pas chercher les vehicules.
    expect(t.alertFindMany).not.toHaveBeenCalled();
  });

  it('les decisions sont INDIVIDUELLES — le bruit d un utilisateur ne rend pas les autres muets', async () => {
    const t = await build({
      rows: [
        { userId: 'u1', status: 'SENT', alertId: 'a-old', alertType: 'POWER_CUT', createdAt: minutesAgo(2) },
      ],
      alertVehicles: { 'a-old': 'v1' },
    });
    const decisions = await t.service.evaluate(['u1', 'u2'], { alertType: 'POWER_CUT', vehicleId: 'v1' });

    expect(decisions.get('u1')).toMatchObject({ allowed: false, reason: 'cooldown' });
    expect(decisions.get('u2')).toMatchObject({ allowed: true });
  });

  it('cooldown expire (> 15 min) — le push repasse', async () => {
    const t = await build({
      rows: [
        { userId: 'u1', status: 'SENT', alertId: 'a-old', alertType: 'POWER_CUT', createdAt: minutesAgo(16) },
      ],
      alertVehicles: { 'a-old': 'v1' },
    });
    const decisions = await t.service.evaluate(['u1'], { alertType: 'POWER_CUT', vehicleId: 'v1' });

    expect(decisions.get('u1')).toMatchObject({ allowed: true });
  });

  it('report du compte — les GROUPED en attente sont rendus a l envoi qui les solde', async () => {
    const t = await build({
      rows: [
        { userId: 'u1', status: 'GROUPED', alertId: 'g1', alertType: 'POWER_CUT', createdAt: minutesAgo(10) },
        { userId: 'u1', status: 'GROUPED', alertId: 'g2', alertType: 'POWER_CUT', createdAt: minutesAgo(6) },
        { userId: 'u1', status: 'GROUPED', alertId: 'g3', alertType: 'POWER_CUT', createdAt: minutesAgo(1) },
      ],
      alertVehicles: { g1: 'v1', g2: 'v1', g3: 'v1' },
    });
    const decisions = await t.service.evaluate(['u1'], { alertType: 'POWER_CUT', vehicleId: 'v1' });

    expect(decisions.get('u1')).toEqual({ allowed: true, reason: null, groupedCount: 3 });
  });

  it('les GROUPED DEJA SOLDES par un envoi ne recomptent pas — le rang repart a zero', async () => {
    // ⚠️ Regression. Les GROUPED restent en base 15 minutes, mais un push parti ENTRE-TEMPS
    // les a deja soldes avec son « ×N ». Les recompter faisait repartir le rang du repli
    // suivant a 15 au lieu de 1 : le centre de notifications affichait « 15 evenements
    // replies » pour UN seul evenement retenu. Le libelle pousse, lui, restait juste (quand
    // le cooldown expire, le dernier envoi est par construction hors fenetre) — d'ou un
    // ecart invisible ailleurs que dans le journal.
    const t = await build({
      rows: [
        { userId: 'u1', status: 'GROUPED', alertId: 'g1', alertType: 'POWER_CUT', createdAt: minutesAgo(9) },
        { userId: 'u1', status: 'GROUPED', alertId: 'g2', alertType: 'POWER_CUT', createdAt: minutesAgo(5) },
        // Ce push est parti APRES les deux replis : il les a annonces (« ×3 »).
        { userId: 'u1', status: 'SENT', alertId: 'a-sent', alertType: 'POWER_CUT', createdAt: minutesAgo(2) },
      ],
      alertVehicles: { g1: 'v1', g2: 'v1', 'a-sent': 'v1' },
    });
    const decisions = await t.service.evaluate(['u1'], { alertType: 'POWER_CUT', vehicleId: 'v1' });

    // Retenu par le cooldown (envoi il y a 2 min), et PREMIER de la nouvelle serie.
    expect(decisions.get('u1')).toEqual({ allowed: false, reason: 'cooldown', groupedCount: 0 });
  });

  it('les GROUPED POSTERIEURS au dernier envoi comptent, eux', async () => {
    // Contrepartie du test precedent : on ne doit pas jeter le bebe avec l'eau du bain.
    const t = await build({
      rows: [
        { userId: 'u1', status: 'SENT', alertId: 'a-sent', alertType: 'POWER_CUT', createdAt: minutesAgo(10) },
        { userId: 'u1', status: 'GROUPED', alertId: 'g1', alertType: 'POWER_CUT', createdAt: minutesAgo(6) },
        { userId: 'u1', status: 'GROUPED', alertId: 'g2', alertType: 'POWER_CUT', createdAt: minutesAgo(3) },
      ],
      alertVehicles: { g1: 'v1', g2: 'v1', 'a-sent': 'v1' },
    });
    const decisions = await t.service.evaluate(['u1'], { alertType: 'POWER_CUT', vehicleId: 'v1' });

    expect(decisions.get('u1')).toEqual({ allowed: false, reason: 'cooldown', groupedCount: 2 });
  });

  it('les GROUPED d un AUTRE vehicule ne gonflent pas le compte', async () => {
    const t = await build({
      rows: [
        { userId: 'u1', status: 'GROUPED', alertId: 'g1', alertType: 'POWER_CUT', createdAt: minutesAgo(5) },
        { userId: 'u1', status: 'GROUPED', alertId: 'g2', alertType: 'POWER_CUT', createdAt: minutesAgo(4) },
      ],
      alertVehicles: { g1: 'v1', g2: 'v2' },
    });
    const decisions = await t.service.evaluate(['u1'], { alertType: 'POWER_CUT', vehicleId: 'v1' });

    expect(decisions.get('u1')).toMatchObject({ groupedCount: 1 });
  });

  it('plafond horaire — atteint a PUSH_MAX_PER_HOUR, tous types confondus', async () => {
    // Le plafond est le DERNIER rempart : il ne regarde ni le type ni le vehicule, il
    // borne le nombre de vibrations. Ici les envois portent sur d'autres vehicules et
    // d'autres types — ils comptent quand meme.
    const rows = Array.from({ length: PUSH_MAX_PER_HOUR }, (_, i) => ({
      userId: 'u1',
      status: 'SENT',
      alertId: `a${i}`,
      alertType: 'GEOFENCE_ENTER',
      createdAt: minutesAgo(55 - i),
    }));
    const t = await build({ rows, alertVehicles: {} });
    const decisions = await t.service.evaluate(['u1'], { alertType: 'POWER_CUT', vehicleId: 'v1' });

    expect(decisions.get('u1')).toMatchObject({ allowed: false, reason: 'hourly_cap' });
  });

  it('un push de moins que le plafond — ca passe encore', async () => {
    const rows = Array.from({ length: PUSH_MAX_PER_HOUR - 1 }, (_, i) => ({
      userId: 'u1',
      status: 'SENT',
      alertId: `a${i}`,
      alertType: 'GEOFENCE_ENTER',
      createdAt: minutesAgo(55 - i),
    }));
    const t = await build({ rows, alertVehicles: {} });
    const decisions = await t.service.evaluate(['u1'], { alertType: 'POWER_CUT', vehicleId: 'v1' });

    expect(decisions.get('u1')).toMatchObject({ allowed: true });
  });

  it.each([['SOS'], ['ACCIDENT'], ['COLLISION'], ['TOW'], ['TAMPER'], ['ILLEGAL_IGNITION']])(
    '%s traverse le plafond horaire — mieux vaut une notification de trop',
    async (alertType) => {
      const rows = Array.from({ length: PUSH_MAX_PER_HOUR + 8 }, (_, i) => ({
        userId: 'u1',
        status: 'SENT',
        alertId: `a${i}`,
        alertType: 'OVERSPEED',
        createdAt: minutesAgo(55 - i),
      }));
      const t = await build({ rows, alertVehicles: {} });
      const decisions = await t.service.evaluate(['u1'], { alertType, vehicleId: 'v1' });

      expect(decisions.get('u1')).toMatchObject({ allowed: true });
    },
  );

  it('une ligne sans alertId (push de test) consomme le plafond mais n ouvre aucun cooldown', async () => {
    // Un push de test ou une notification hors alerte a bien fait vibrer le telephone :
    // il compte. Mais il ne se rattache a aucun vehicule, donc il ne peut pas rendre
    // muette une alerte reelle.
    const t = await build({
      rows: [{ userId: 'u1', status: 'SENT', alertId: null, alertType: 'POWER_CUT', createdAt: minutesAgo(1) }],
    });
    const decisions = await t.service.evaluate(['u1'], { alertType: 'POWER_CUT', vehicleId: 'v1' });

    expect(decisions.get('u1')).toMatchObject({ allowed: true });
    expect(t.alertFindMany).not.toHaveBeenCalled();
  });

  it('escalade — bypassCooldown ignore le cooldown mais PAS le plafond', async () => {
    const rows = [
      { userId: 'u1', status: 'SENT', alertId: 'a-old', alertType: 'POWER_CUT', createdAt: minutesAgo(1) },
      ...Array.from({ length: PUSH_MAX_PER_HOUR }, (_, i) => ({
        userId: 'u2',
        status: 'SENT',
        alertId: `b${i}`,
        alertType: 'POWER_CUT',
        createdAt: minutesAgo(50 - i),
      })),
    ];
    const t = await build({ rows, alertVehicles: { 'a-old': 'v1' } });
    const decisions = await t.service.evaluate(['u1', 'u2'], {
      alertType: 'POWER_CUT',
      vehicleId: 'v1',
      bypassCooldown: true,
    });

    expect(decisions.get('u1')).toMatchObject({ allowed: true });
    // u2 a deja recu 12 push dans l'heure : le plafond, lui, reste arme. C'est ce qui
    // borne le scenario « 330 coupures non acquittees par jour ».
    expect(decisions.get('u2')).toMatchObject({ allowed: false, reason: 'hourly_cap' });
  });

  it('alerte SANS vehicule — le cooldown se reduit a (utilisateur, type)', async () => {
    const t = await build({
      rows: [{ userId: 'u1', status: 'SENT', alertId: 'a-old', alertType: 'MAINTENANCE_DUE', createdAt: minutesAgo(2) }],
      alertVehicles: { 'a-old': null },
    });
    const decisions = await t.service.evaluate(['u1'], { alertType: 'MAINTENANCE_DUE', vehicleId: null });

    expect(t.alertFindMany.mock.calls[0][0]?.where?.vehicleId).toBeNull();
    expect(decisions.get('u1')).toMatchObject({ allowed: false, reason: 'cooldown' });
  });

  it('journal illisible — FAIL-OPEN : on notifie, et on trace la panne', async () => {
    // ⚠️ Decision structurante : le bug qu'on repare etait un silence invisible. Un
    // garde-fou en panne qui bloquerait tout en recreerait un, en pire — cause par notre
    // propre code anti-spam.
    const t = await build({
      findManyImpl: jest.fn().mockRejectedValue(new Error('relation "notification_deliveries" does not exist')),
    });
    const decisions = await t.service.evaluate(['u1', 'u2'], { alertType: 'POWER_CUT', vehicleId: 'v1' });

    expect(decisions.get('u1')).toMatchObject({ allowed: true });
    expect(decisions.get('u2')).toMatchObject({ allowed: true });
    // La panne ne doit pas etre silencieuse pour autant : elle remonte au centre d'erreur.
    expect(t.recordBackground).toHaveBeenCalled();
  });

  it('qualification vehicule en panne — le cooldown est neutralise, pas inverse', async () => {
    const t = await build({
      rows: [{ userId: 'u1', status: 'SENT', alertId: 'a-old', alertType: 'POWER_CUT', createdAt: minutesAgo(1) }],
    });
    (t.alertFindMany as jest.Mock).mockRejectedValue(new Error('timeout'));

    const decisions = await t.service.evaluate(['u1'], { alertType: 'POWER_CUT', vehicleId: 'v1' });

    expect(decisions.get('u1')).toMatchObject({ allowed: true });
  });
});
