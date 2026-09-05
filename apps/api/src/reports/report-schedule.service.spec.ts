/**
 * Rapport hebdomadaire réglable — garde du calendrier et de l'envoi.
 *
 * Ce que ces tests protègent, et pourquoi :
 *
 *  1. L'HEURE EST CELLE DE PARIS. L'ancien cron partait à 08:00 UTC, donc 10:00 à Paris l'été
 *     et 09:00 l'hiver : le rapport « du lundi matin » arrivait à une heure différente selon
 *     la saison. Un test en juillet ET un test en janvier valent mieux qu'un commentaire.
 *  2. LA PÉRIODE EST INCLUSE ET COMPLÈTE. Sept jours civils révolus, jamais le jour d'envoi
 *     lui-même (qui n'est pas fini).
 *  3. UNE ABSENCE D'ENVOI S'EXPLIQUE. Aucun destinataire, aucun trajet : une ligne de journal
 *     est écrite quand même, sinon « je n'ai rien reçu » n'a aucune réponse.
 *  4. LE PDF EST VRAIMENT JOINT. Le courrier annonçait « en pièce jointe » depuis des mois
 *     sans que rien ne le soit — le paramètre n'existait pas.
 *  5. PAS DE DOUBLON. Deux passages du cron dans la même heure ne doivent pas envoyer deux fois.
 */
import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AutomationDisabledException } from '../common/automation-disabled.exception';
import { ReportScheduleService } from './report-schedule.service';
import type { AuthUser } from '../auth/types/auth-user';

const FLEET_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function admin(): AuthUser {
  return {
    id: 'user-1', authUserId: 'auth-1', email: 'patron@societe.fr',
    firstName: 'Ada', lastName: 'Lovelace', role: UserRole.FLEET_ADMIN,
    fleetId: FLEET_ID, isActive: true, isOwner: true, permissions: null,
  };
}

const RAPPORT = {
  trips: { count: 12, totalKm: 340.5 },
  alerts: { total: 3 },
  consumption: { estimatedLiters: 28.4, estimatedCostEur: 52.1 },
};

/**
 * @param schedule ligne de réglage de la société (null = jamais réglé).
 * @param opts trajets renvoyés par les stats, administrateurs actifs, issue de l'envoi.
 */
function build(
  schedule: Record<string, unknown> | null,
  opts: { rapport?: typeof RAPPORT; admins?: string[]; envoiOk?: boolean; dispatchExistant?: boolean; weeklyReportEmail?: string | null } = {},
) {
  const fleet = {
    id: FLEET_ID,
    name: 'MH Cars',
    weeklyReportEmail: opts.weeklyReportEmail ?? null,
    reportSchedule: schedule,
  };
  const dispatchCreate = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    ...data,
    id: 'dispatch-1',
    createdAt: new Date('2026-07-06T06:00:05.000Z'),
  }));
  const scheduleUpsert = jest.fn().mockResolvedValue({});
  const prisma = {
    fleet: {
      findUnique: jest.fn().mockResolvedValue(fleet),
      findMany: jest.fn().mockResolvedValue([fleet]),
    },
    fleetReportSchedule: { upsert: scheduleUpsert },
    fleetReportDispatch: {
      create: dispatchCreate,
      findFirst: jest.fn().mockResolvedValue(opts.dispatchExistant ? { id: 'deja' } : null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: {
      findMany: jest.fn().mockResolvedValue((opts.admins ?? ['admin@societe.fr']).map((email) => ({ email, id: 'u', firstName: null, lastName: null }))),
    },
    vehicle: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
  } as never;

  const compute = jest.fn().mockResolvedValue(opts.rapport ?? RAPPORT);
  const stats = { compute } as never;
  const genererPdf = jest.fn().mockResolvedValue(Buffer.from('%PDF-1.7 faux rapport'));
  const pdf = { generate: genererPdf } as never;
  const send = jest.fn().mockResolvedValue({ ok: opts.envoiOk !== false, error: opts.envoiOk === false ? 'boîte pleine' : undefined });
  const email = { send, buildWeeklyReportEmail: jest.fn().mockReturnValue('<html>rapport</html>') } as never;

  const svc = new ReportScheduleService(prisma, stats, pdf, email);
  return { svc, prisma, compute, genererPdf, send, dispatchCreate, scheduleUpsert };
}

describe('ReportScheduleService — calendrier en heure de Paris', () => {
  it('l’échéance de 08:00 tombe à 06:00 UTC en ÉTÉ (heure d’été française)', async () => {
    const { svc } = build({ enabled: true, weekday: 1, hour: 8, recipients: [], sections: ['kpi'], vehicleIds: [], maxTrips: 30, topN: 10, lastRunAt: null, lastStatus: null, lastError: null, updatedAt: new Date('2026-06-01T00:00:00Z'), updatedByUserId: 'u1' });
    jest.useFakeTimers().setSystemTime(new Date('2026-07-01T12:00:00.000Z').getTime()); // mercredi 1er juillet
    try {
      const dto = await svc.get(admin());
      // Prochain lundi = 6 juillet ; 08:00 à Paris = 06:00 UTC (UTC+2 l'été).
      expect(dto.nextDueAt).toBe('2026-07-06T06:00:00.000Z');
      // Période couverte : les 7 jours civils qui précèdent, fin INCLUSE.
      expect(dto.nextPeriodFrom).toBe('2026-06-29');
      expect(dto.nextPeriodTo).toBe('2026-07-05');
    } finally {
      jest.useRealTimers();
    }
  });

  it('la même échéance de 08:00 tombe à 07:00 UTC en HIVER — l’ancien cron UTC dérivait d’une heure', async () => {
    const { svc } = build({ enabled: true, weekday: 1, hour: 8, recipients: [], sections: ['kpi'], vehicleIds: [], maxTrips: 30, topN: 10, lastRunAt: null, lastStatus: null, lastError: null, updatedAt: new Date('2026-01-01T00:00:00Z'), updatedByUserId: 'u1' });
    jest.useFakeTimers().setSystemTime(new Date('2026-01-07T12:00:00.000Z').getTime()); // mercredi 7 janvier
    try {
      const dto = await svc.get(admin());
      expect(dto.nextDueAt).toBe('2026-01-12T07:00:00.000Z'); // lundi 12 janvier, 08:00 Paris
    } finally {
      jest.useRealTimers();
    }
  });

  it('une société sans réglage garde l’ancien comportement : lundi 08:00, toutes les sections, admins actifs', async () => {
    const { svc } = build(null);
    jest.useFakeTimers().setSystemTime(new Date('2026-07-01T12:00:00.000Z').getTime());
    try {
      const dto = await svc.get(admin());
      expect(dto.isDefault).toBe(true);
      expect(dto.enabled).toBe(true);
      expect(dto.weekday).toBe(1);
      expect(dto.hour).toBe(8);
      expect(dto.sections).toEqual(['kpi', 'alerts', 'topVehicles', 'trips']);
      // Aucune adresse choisie : ce sont les administrateurs actifs qui reçoivent.
      expect(dto.recipients).toEqual([]);
      expect(dto.effectiveRecipients).toEqual(['admin@societe.fr']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('la sentinelle historique « - » sur la fiche société coupe toujours l’envoi', async () => {
    const { svc } = build(null, { weeklyReportEmail: '-' });
    jest.useFakeTimers().setSystemTime(new Date('2026-07-01T12:00:00.000Z').getTime());
    try {
      expect((await svc.get(admin())).enabled).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('ReportScheduleService — qui peut régler', () => {
  /**
   * ⚠️ Le gestionnaire de flotte règle le rapport de SA société — c'est de la gestion de
   * flotte, pas de l'administration de plateforme. Mais il ne doit jamais pouvoir viser une
   * autre société : le périmètre est verrouillé ici, pas seulement à l'écran.
   */
  function gestionnaire(fleetId: string | null = FLEET_ID): AuthUser {
    return { ...admin(), id: 'user-2', role: UserRole.FLEET_MANAGER, fleetId };
  }

  it('un gestionnaire de flotte règle le rapport de SA société', async () => {
    const { svc, scheduleUpsert } = build(null);
    await svc.set(gestionnaire(), {
      enabled: true, weekday: 5, hour: 18, recipients: [], sections: ['kpi'], vehicleIds: [], maxTrips: 30, topN: 10,
    });
    // On vérifie ce qui est ÉCRIT : le DTO rendu relit la base, que le mock fige.
    expect(scheduleUpsert).toHaveBeenCalledTimes(1);
    const ecrit = scheduleUpsert.mock.calls[0]![0] as { where: { fleetId: string }; update: Record<string, unknown> };
    expect(ecrit.where.fleetId).toBe(FLEET_ID);
    expect(ecrit.update['weekday']).toBe(5);
    expect(ecrit.update['hour']).toBe(18);
    // La signature de l'auteur : c'est elle qui distingue un réglage CHOISI d'une ligne
    // créée par le passage du cron (cf. `isDefault`).
    expect(ecrit.update['updatedByUserId']).toBe('user-2');
  });

  it('un gestionnaire ne peut PAS viser une autre société, même en la nommant', async () => {
    const { svc } = build(null);
    await expect(
      svc.get(gestionnaire(), 'bbbbbbbb-0000-4000-8000-000000000002'),
    ).rejects.toThrow(/hors périmètre/i);
  });

  it('un utilisateur sans société rattachée est refusé', async () => {
    const { svc } = build(null);
    await expect(svc.get(gestionnaire(null))).rejects.toThrow(/société/i);
  });

  it('un super-admin sans société courante reçoit une consigne lisible, pas un code', async () => {
    const { svc } = build(null);
    const sansFlotte = { ...admin(), role: UserRole.SUPER_ADMIN, fleetId: null };
    await expect(svc.get(sansFlotte)).rejects.toThrow(/Choisissez une société/i);
  });
});

describe('ReportScheduleService — envoi', () => {
  const REGLAGE_DU = {
    enabled: true, weekday: 1, hour: 8, recipients: ['patron@societe.fr'],
    sections: ['kpi', 'trips'], vehicleIds: [], maxTrips: 30, topN: 10,
    lastRunAt: null, lastStatus: null, lastError: null,
    updatedAt: new Date('2026-06-01T00:00:00Z'), updatedByUserId: 'u1',
  };

  it('envoie le rapport dû AVEC le PDF joint, et journalise le passage', async () => {
    const { svc, send, dispatchCreate, genererPdf } = build(REGLAGE_DU);
    // Lundi 6 juillet 2026, 06:05 UTC = 08:05 à Paris : l'échéance de 08:00 vient de passer.
    const res = await svc.runDue(new Date('2026-07-06T06:05:00.000Z'));

    expect(res).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(genererPdf).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);

    const envoi = send.mock.calls[0]![0] as { to: string; attachments?: { filename: string; content: Buffer }[] };
    expect(envoi.to).toBe('patron@societe.fr');
    // LE point qui manquait : le courrier annonçait un PDF qui n'était jamais joint.
    expect(envoi.attachments).toHaveLength(1);
    expect(envoi.attachments![0]!.content.length).toBeGreaterThan(0);
    expect(envoi.attachments![0]!.filename).toBe('tracky-rapport-2026-06-29_2026-07-05.pdf');

    const journal = dispatchCreate.mock.calls[0]![0].data as Record<string, unknown>;
    expect(journal['status']).toBe('SENT');
    expect(journal['trigger']).toBe('cron');
    expect(journal['tripsCount']).toBe(12);
    expect(journal['pdfBytes']).toBeGreaterThan(0);
  });

  it('n’envoie rien si l’échéance a déjà été traitée (pas de doublon d’une heure à l’autre)', async () => {
    const { svc, send } = build({ ...REGLAGE_DU, lastRunAt: new Date('2026-07-06T06:00:30.000Z') });
    const res = await svc.runDue(new Date('2026-07-06T07:05:00.000Z'));
    expect(res).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('journalise SKIPPED — et n’envoie pas de courrier vide — quand la semaine n’a aucun trajet', async () => {
    const { svc, send, dispatchCreate } = build(REGLAGE_DU, {
      rapport: { ...RAPPORT, trips: { count: 0, totalKm: 0 } },
    });
    const res = await svc.runDue(new Date('2026-07-06T06:05:00.000Z'));

    expect(res).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(send).not.toHaveBeenCalled();
    const journal = dispatchCreate.mock.calls[0]![0].data as Record<string, unknown>;
    expect(journal['status']).toBe('SKIPPED');
    expect(String(journal['error'])).toContain('Aucun trajet');
  });

  it('journalise SKIPPED quand personne ne peut recevoir le rapport', async () => {
    const { svc, send, dispatchCreate } = build({ ...REGLAGE_DU, recipients: [] }, { admins: [] });
    const res = await svc.runDue(new Date('2026-07-06T06:05:00.000Z'));

    expect(res).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(String((dispatchCreate.mock.calls[0]![0].data as Record<string, unknown>)['error'])).toContain('Aucun destinataire');
  });

  it('journalise FAILED quand le courrier est refusé, avec la raison', async () => {
    const { svc, dispatchCreate } = build(REGLAGE_DU, { envoiOk: false });
    const res = await svc.runDue(new Date('2026-07-06T06:05:00.000Z'));

    expect(res).toEqual({ sent: 0, failed: 1, skipped: 0 });
    const journal = dispatchCreate.mock.calls[0]![0].data as Record<string, unknown>;
    expect(journal['status']).toBe('FAILED');
    expect(String(journal['error'])).toContain('boîte pleine');
  });

  it('ne rattrape JAMAIS le passé : une société jamais réglée n’est pas arrosée dès la mise en ligne', async () => {
    // Le cas exact d'une mise en production un mercredi : aucune ligne de réglage, donc la
    // dernière échéance (lundi 08:00) est dans le passé. Sans garde-fou, TOUTES les sociétés
    // recevaient d'un coup le rapport de la semaine écoulée, déclenché par un déploiement.
    const { svc, send, dispatchCreate, scheduleUpsert } = build(null);
    const res = await svc.runDue(new Date('2026-07-08T10:05:00.000Z')); // mercredi

    expect(res).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(dispatchCreate).not.toHaveBeenCalled();
    // Le passage est tout de même enregistré : l'échéance SUIVANTE partira normalement.
    expect(scheduleUpsert).toHaveBeenCalledTimes(1);
  });

  it('une société qui vient de régler son rapport ne reçoit pas rétroactivement la semaine d’avant', async () => {
    // Réglé mardi, échéance du lundi déjà passée : on n'envoie pas le passé.
    const { svc, send } = build({ ...REGLAGE_DU, lastRunAt: null, updatedAt: new Date('2026-07-07T09:00:00.000Z') });
    const res = await svc.runDue(new Date('2026-07-08T10:05:00.000Z'));
    expect(res).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('une société dont l’envoi est coupé est ignorée', async () => {
    const { svc, send, dispatchCreate } = build({ ...REGLAGE_DU, enabled: false });
    const res = await svc.runDue(new Date('2026-07-06T06:05:00.000Z'));
    expect(res).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(dispatchCreate).not.toHaveBeenCalled();
  });

  /**
   * design/C3 point 2 (2026-09-05) — « Envoyer maintenant » ne contourne plus l'interrupteur.
   * Le bouton partait vers de vraies boîtes aux lettres alors que la société avait coupé
   * l'envoi. Le refus est un 409 lisible, rien n'est calculé, rien n'est envoyé, et aucune
   * ligne de journal d'envoi n'est écrite : rien n'est parti.
   */
  describe('envoi immédiat quand l’envoi automatique est coupé', () => {
    it('refuse en 409 (AutomationDisabledException) : aucun envoi, aucun journal, aucun calcul', async () => {
      const { svc, send, dispatchCreate, compute, genererPdf, scheduleUpsert } = build({ ...REGLAGE_DU, enabled: false });

      const refus = await svc.sendNow(admin()).catch((e: unknown) => e);

      expect(refus).toBeInstanceOf(AutomationDisabledException);
      expect((refus as AutomationDisabledException).getStatus()).toBe(409);
      expect((refus as Error).message).toMatch(/coupé pour cette société/);
      expect(send).not.toHaveBeenCalled();
      expect(dispatchCreate).not.toHaveBeenCalled();
      expect(compute).not.toHaveBeenCalled();
      expect(genererPdf).not.toHaveBeenCalled();
      expect(scheduleUpsert).not.toHaveBeenCalled(); // pas de « dernier passage » pour un refus
    });

    it('la sentinelle historique « - » (société jamais réglée, envoi coupé) refuse pareil', async () => {
      const { svc, send, dispatchCreate } = build(null, { weeklyReportEmail: '-' });

      await expect(svc.sendNow(admin())).rejects.toBeInstanceOf(AutomationDisabledException);
      expect(send).not.toHaveBeenCalled();
      expect(dispatchCreate).not.toHaveBeenCalled();
    });
  });

  it('l’envoi immédiat part même sans trajet — c’est un geste manuel, pas un courrier automatique', async () => {
    const { svc, send, dispatchCreate } = build(REGLAGE_DU, {
      rapport: { ...RAPPORT, trips: { count: 0, totalKm: 0 } },
    });
    jest.useFakeTimers().setSystemTime(new Date('2026-07-08T10:00:00.000Z').getTime()); // mercredi
    try {
      const dispatch = await svc.sendNow(admin());
      expect(dispatch.status).toBe('SENT');
      expect(send).toHaveBeenCalledTimes(1);
      const journal = dispatchCreate.mock.calls[0]![0].data as Record<string, unknown>;
      expect(journal['trigger']).toBe('manual');
      // Les 7 jours civils révolus, jour courant exclu.
      expect(dispatch.periodFrom).toBe('2026-07-01');
      expect(dispatch.periodTo).toBe('2026-07-07');
    } finally {
      jest.useRealTimers();
    }
  });
});

/**
 * ══ LA VUE D'ENSEMBLE : LE RÉGLAGE DE TOUTES LES SOCIÉTÉS ═══════════════════════════
 *
 * Le réglage ne se lisait QUE société par société. Personne ne fait ça pour vingt
 * sociétés — donc un rapport coupé, ou dont l'envoi échoue chaque semaine, se découvrait
 * par hasard, souvent parce que le client finissait par le signaler.
 */
describe("ReportScheduleService.listAll — la vue d'ensemble", () => {
  const superAdmin = { id: 'sa', role: UserRole.SUPER_ADMIN, fleetId: null, email: 'sa@vizyo.fr' } as never;

  it('rend une ligne par société, réglée ou non', async () => {
    const { svc } = build(null);
    const lignes = await svc.listAll(superAdmin);
    expect(lignes).toHaveLength(1);
    expect(lignes[0]!.fleetName).toBe('MH Cars');
    // Jamais réglée : le DTO le DIT (`isDefault`), au lieu de faire passer le défaut
    // du produit pour un choix de l'exploitant.
    expect(lignes[0]!.isDefault).toBe(true);
  });

  /**
   * ⚠️ Le point que cette vue existe pour montrer : « Actif » et destinataires VIDES.
   * Le rapport part chaque lundi et n'arrive nulle part — et rien, avant, ne le disait.
   */
  it('laisse voir une société active dont PERSONNE ne reçoit le rapport', async () => {
    const { svc } = build({ enabled: true, weekday: 1, hour: 8, recipients: [], sections: ['kpi'], vehicleIds: [], maxTrips: 30, topN: 10 }, { admins: [] });
    const lignes = await svc.listAll(superAdmin);
    expect(lignes[0]!.enabled).toBe(true);
    expect(lignes[0]!.effectiveRecipients).toEqual([]);
  });

  it('refuse un administrateur de société — le nom d’un client est déjà une information', async () => {
    const { svc } = build(null);
    await expect(
      svc.listAll({ id: 'a', role: UserRole.FLEET_ADMIN, fleetId: FLEET_ID, email: 'a@societe.fr' } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  /**
   * ⚠️ DEUX requêtes, pas deux PAR SOCIÉTÉ. Sur vingt sociétés, la version naïve aurait
   * fait vingt-et-une requêtes pour un écran de consultation.
   */
  it('ne fait pas une requête de destinataires par société', async () => {
    const { svc, prisma } = build(null);
    await svc.listAll(superAdmin);
    expect((prisma as never as { user: { findMany: jest.Mock } }).user.findMany).toHaveBeenCalledTimes(1);
  });
});
