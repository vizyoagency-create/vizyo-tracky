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
import PDFDocument from 'pdfkit';
import { UserRole } from '@prisma/client';
import { AutomationDisabledException } from '../common/automation-disabled.exception';
import { buildUnattributedNote, EmailService } from '../email/email.service';
import { ReportPdfService } from './report-pdf.service';
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
  const email = { send, buildWeeklyReportEmail: jest.fn().mockReturnValue('<html>rapport</html>') };

  const svc = new ReportScheduleService(prisma, stats, pdf, email as never);
  return { svc, prisma, compute, genererPdf, send, dispatchCreate, scheduleUpsert, email };
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

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════
   * LE BOUTON DU COURRIER DOIT OUVRIR LA SOCIÉTÉ DONT LE COURRIER PARLE
   * ══════════════════════════════════════════════════════════════════════════════════════
   *
   * La page Rapports prend sa société dans le sélecteur du haut, PERSISTÉ d'une visite à
   * l'autre. Le lien ne disait que la période : un super-admin — le nôtre reçoit celui de la
   * société d'essai — l'ouvrait et lisait les chiffres de la société sur laquelle son
   * sélecteur était resté, sous le titre de la semaine annoncée ici.
   *
   * ⚠️ RIEN NE L'AURAIT SIGNALÉ. Deux sociétés donnent deux jeux de nombres également
   * plausibles ; l'écran affiche un total de trajets, pas une preuve d'origine. C'est
   * exactement le mélange de données que le lot des rapports par société interdit, arrivé par
   * la porte d'un lien.
   */
  it('le lien du courrier nomme la société ET la période du document', async () => {
    const { svc, email } = build(REGLAGE_DU);

    await svc.runDue(new Date('2026-07-06T06:05:00.000Z'));

    const opts = email.buildWeeklyReportEmail.mock.calls[0]![0] as { lienRapport?: string };
    expect(opts.lienRapport).toBe(`/reports?fleet=${FLEET_ID}&from=2026-06-29&to=2026-07-06`);
  });

  /**
   * ⚠️ `to` EST EXCLUSIVE DES DEUX CÔTÉS. Le document annonce « du 29 juin au 5 juillet
   * inclus » ; le lien porte `to=2026-07-06` parce que la page Rapports, elle, lit une borne
   * exclusive — comme les trajets, comme les exports, comme le rapport lui-même. Écrire la
   * date affichée décalerait la page d'un jour sur le document qu'elle prétend rouvrir.
   */
  it('la borne haute du lien est exclusive, comme partout ailleurs dans le produit', async () => {
    const { svc, email, send } = build(REGLAGE_DU);

    await svc.runDue(new Date('2026-07-06T06:05:00.000Z'));

    const opts = email.buildWeeklyReportEmail.mock.calls[0]![0] as { lienRapport?: string; toStr?: string };
    expect(opts.toStr).toContain('05'); // le document dit « au 5 juillet »
    expect(opts.lienRapport).toContain('to=2026-07-06'); // la page en veut la borne exclusive
    // Et la pièce jointe garde, elle, le dernier jour INCLUS dans son nom.
    const envoi = send.mock.calls[0]![0] as { attachments?: { filename: string }[] };
    expect(envoi.attachments![0]!.filename).toBe('tracky-rapport-2026-06-29_2026-07-05.pdf');
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

/**
 * ══ CE QUE LE COURRIER DU LUNDI EMPORTE VRAIMENT ═══════════════════════════════════════
 *
 * Le rapport hebdomadaire part automatiquement le lundi à 8 h pour TOUTES les sociétés, et
 * c'est le seul document que la plupart des clients lisent. Il lisait `FleetStatsReport` sans
 * rendre le bloc « par conducteur ou groupe » : le client voyait à l'écran ce que son PDF ne
 * disait pas — et le PDF, lui, n'a pas d'écran à côté pour le compléter six mois plus tard.
 *
 * ⚠️ CES TESTS MONTENT LE VRAI `ReportPdfService`, pas un espion. Vérifier que le service a
 * bien été appelé n'aurait rien prouvé : c'est le CONTENU de la pièce jointe qui manquait.
 * Le PDF étant compressé, on capture ce que pdfkit écrit sur la page.
 */
describe('ReportScheduleService — le bloc « par conducteur ou groupe » dans le courrier du lundi', () => {
  /** mh cars, mesuré le 2026-09-05 : presque aucun trajet n'est imputé à quiconque. */
  const RAPPORT_MH_CARS = {
    fleet: { id: FLEET_ID, name: 'MH Cars' },
    period: { from: '2026-06-29T00:00:00.000Z', to: '2026-07-06T00:00:00.000Z', days: 7 },
    vehicles: {
      total: 41, activeDuringPeriod: 38, exploited: 38, dormant: 0, withoutTracker: 3,
      dormantVehicles: [], idleVehicles: [], idleTotal: 0,
    },
    trips: {
      count: 1886, totalKm: 12040.5, totalDurationHours: 401.2,
      avgKmPerVehicle: 316.9, avgKmBasisVehicles: 38, avgKmBasisKm: 12040.5,
      avgSpeedKmh: 30, maxSpeedKmh: 128,
    },
    alerts: { total: 3, byType: [], bySeverity: [] },
    consumption: {
      estimatedLiters: 842.8, estimatedCostEur: 1559.2, fuelPriceEurL: 1.85,
      observedPriceEurL: null, estimatedCostAtObservedEur: null, observedSampleCount: 0,
      estimatedCo2Kg: 2200, idleSecondsTotal: 90000,
    },
    topVehicles: [{
      vehicleId: 'v1', plate: 'AB-123-CD', distanceKm: 1200, tripCount: 90,
      estimatedConsumptionL: 84, group: null, durationHours: 40, avgSpeedKmh: 30,
      speedingCount: 2, speedingTripCount: 2, worstOverKmh: 14.5, idleSeconds: 3000,
    }],
    byAttribution: [
      { key: 'driver:d1', label: 'Sohaib Hamanni', kind: 'driver' as const, tripCount: 22, distanceKm: 240.5, durationHours: 8.1, avgSpeedKmh: 30, speedingCount: 1, speedingTripCount: 1, worstOverKmh: 11.2, idleSeconds: 600 },
    ],
    byAttributionTotal: 1,
    unattributedTrips: { tripCount: 1864, distanceKm: 11800, durationHours: 393.1 },
    recentTrips: [],
  };

  /** Le même passage hebdomadaire que les tests ci-dessus, mais avec le VRAI générateur PDF. */
  function buildAvecVraiPdf(sections: string[]) {
    const fleet = {
      id: FLEET_ID, name: 'MH Cars', weeklyReportEmail: null,
      reportSchedule: {
        enabled: true, weekday: 1, hour: 8, recipients: ['patron@societe.fr'],
        sections, vehicleIds: [], maxTrips: 30, topN: 10,
        lastRunAt: null, lastStatus: null, lastError: null,
        updatedAt: new Date('2026-06-01T00:00:00Z'), updatedByUserId: 'u1',
      },
    };
    const prisma = {
      fleet: { findUnique: jest.fn().mockResolvedValue(fleet), findMany: jest.fn().mockResolvedValue([fleet]) },
      fleetReportSchedule: { upsert: jest.fn().mockResolvedValue({}) },
      fleetReportDispatch: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data, id: 'd1', createdAt: new Date() })),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      user: { findMany: jest.fn().mockResolvedValue([{ email: 'patron@societe.fr', id: 'u', firstName: null, lastName: null }]) },
      vehicle: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    } as never;
    const stats = { compute: jest.fn().mockResolvedValue(RAPPORT_MH_CARS) } as never;
    const send = jest.fn().mockResolvedValue({ ok: true });
    const email = { send, buildWeeklyReportEmail: jest.fn().mockReturnValue('<html>rapport</html>') } as never;
    // Le VRAI service : c'est sa sortie qu'on inspecte.
    const svc = new ReportScheduleService(prisma, stats, new ReportPdfService() as never, email);
    return { svc, send };
  }

  /** Capture ce que pdfkit écrit pendant le passage hebdomadaire. */
  async function texteDuPdfHebdo(sections: string[]): Promise<{ texte: string; octets: number }> {
    const real = (PDFDocument.prototype as never as { text: (...a: unknown[]) => unknown }).text;
    const capture: string[] = [];
    const espion = jest.spyOn(PDFDocument.prototype as never as { text: (...a: unknown[]) => unknown }, 'text')
      .mockImplementation(function (this: unknown, ...args: unknown[]) {
        if (typeof args[0] === 'string') capture.push(args[0]);
        return (real as (...a: unknown[]) => unknown).apply(this, args);
      });
    try {
      const { svc, send } = buildAvecVraiPdf(sections);
      const res = await svc.runDue(new Date('2026-07-06T06:05:00.000Z'));
      expect(res.sent).toBe(1);
      const envoi = send.mock.calls[0]![0] as { attachments?: { content: Buffer }[] };
      return { texte: capture.join('\n'), octets: envoi.attachments![0]!.content.length };
    } finally {
      espion.mockRestore();
    }
  }

  /**
   * ⚠️ LE CHIFFRE QUI FAIT LA VALEUR DE CE BLOC : 1 864 trajets sur 1 886. Un rapport qui
   * classerait 22 trajets sans dire que 1 864 n'appartiennent à personne laisserait lire une
   * image complète alors qu'il en manque 99 %.
   */
  it('le PDF joint porte le classement ET les trajets que rien ne rattache à personne', async () => {
    const { texte, octets } = await texteDuPdfHebdo(['kpi', 'topVehicles', 'trips']);

    expect(octets).toBeGreaterThan(0);
    expect(texte).toContain('Par conducteur ou groupe');
    expect(texte).toContain('Sohaib Hamanni');
    // Le dénominateur est le total RÉEL de la semaine, pas les 22 trajets classés.
    expect(texte).toContain('1864 trajets sur 1886 de la période');
    expect(texte).toContain('ni conducteur, ni groupe');
  });

  /**
   * Le bloc est la SECONDE FACE de la carte « récapitulatif » : il suit la section « Top
   * véhicules », que la société peut décocher. Un rapport raccourci exprès ne se voit pas
   * rallonger d'un tableau que personne n'a demandé.
   */
  it('une société qui a décoché le récapitulatif ne reçoit pas le bloc', async () => {
    const { texte } = await texteDuPdfHebdo(['kpi', 'trips']);

    expect(texte).toContain('Indicateurs clés');
    expect(texte).not.toContain('Par conducteur ou groupe');
  });
});

/**
 * ══ LES TRAJETS NON ATTRIBUÉS DANS LE CORPS DU COURRIER DU LUNDI (F13) ═════════════════
 *
 * Le PDF joint le dit depuis ce lot. Le CORPS du message, lui, résumait trajets, kilomètres,
 * alertes et consommation sans jamais dire que ces nombres pouvaient n'appartenir à personne
 * — et c'est le corps qui se lit sur un téléphone, à 8 h, sans ouvrir la pièce jointe.
 *
 * ⚠️ CE COURRIER PART VRAIMENT, chaque lundi, à TOUTES les sociétés — sociétés d'essai
 * comprises. Ces tests tiennent donc les quatre populations réelles :
 *   1. mh cars, 1 864 trajets sur 1 886 sans NI conducteur NI groupe (mesuré le 2026-09-05) ;
 *   2. une société qui a renseigné ses conducteurs : rien à signaler, donc RIEN d'écrit ;
 *   3. une société sans un seul trajet (« Envoyer maintenant » sur une société d'essai) ;
 *   4. un producteur de statistiques qui ne fabrique pas le champ — il est optionnel au contrat.
 *
 * ⚠️ ET SURTOUT : LES DEUX PARTIES MIME DU MÊME MESSAGE. Un client sous Outlook lit le HTML
 * pendant qu'un client en texte brut lit le texte. Ces tests montent le VRAI `EmailService`
 * pour fabriquer le HTML — un espion aurait prouvé qu'on l'appelle, pas que les deux corps
 * disent la même chose.
 */
describe('ReportScheduleService — les non attribués dans les DEUX corps du courrier hebdomadaire', () => {
  /** Rapport minimal ; `unattributedTrips` est le seul champ que ces tests font varier. */
  function rapport(over: Record<string, unknown> = {}) {
    return {
      fleet: { id: FLEET_ID, name: 'MH Cars' },
      period: { from: '2026-06-29T00:00:00.000Z', to: '2026-07-06T00:00:00.000Z', days: 7 },
      vehicles: {
        total: 41, activeDuringPeriod: 38, exploited: 38, dormant: 0, withoutTracker: 3,
        dormantVehicles: [], idleVehicles: [], idleTotal: 0,
      },
      trips: {
        count: 1886, totalKm: 12040.5, totalDurationHours: 401.2,
        avgKmPerVehicle: 316.9, avgKmBasisVehicles: 38, avgKmBasisKm: 12040.5,
        avgSpeedKmh: 30, maxSpeedKmh: 128,
      },
      alerts: { total: 3, byType: [], bySeverity: [] },
      consumption: {
        estimatedLiters: 842.8, estimatedCostEur: 1559.2, fuelPriceEurL: 1.85,
        observedPriceEurL: null, estimatedCostAtObservedEur: null, observedSampleCount: 0,
        estimatedCo2Kg: 2200, idleSecondsTotal: 90000,
      },
      topVehicles: [],
      byAttribution: [],
      byAttributionTotal: 0,
      unattributedTrips: { tripCount: 1864, distanceKm: 11800.4, durationHours: 393.1 },
      recentTrips: [],
      ...over,
    };
  }

  /**
   * Le VRAI `EmailService` fabrique le HTML ; seul `send` est un espion, pour attraper les
   * deux corps du message tel qu'il part. Sans clé Resend, le service est en mode inerte.
   */
  async function courrierHebdo(report: Record<string, unknown>) {
    const fleet = {
      id: FLEET_ID, name: 'MH Cars', weeklyReportEmail: null,
      reportSchedule: {
        enabled: true, weekday: 1, hour: 8, recipients: ['patron@societe.fr'],
        sections: ['kpi', 'alerts', 'topVehicles', 'trips'], vehicleIds: [], maxTrips: 30, topN: 10,
        lastRunAt: null, lastStatus: null, lastError: null,
        updatedAt: new Date('2026-06-01T00:00:00Z'), updatedByUserId: 'u1',
      },
    };
    const prisma = {
      fleet: { findUnique: jest.fn().mockResolvedValue(fleet), findMany: jest.fn().mockResolvedValue([fleet]) },
      fleetReportSchedule: { upsert: jest.fn().mockResolvedValue({}) },
      fleetReportDispatch: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data, id: 'd1', createdAt: new Date() })),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      user: { findMany: jest.fn().mockResolvedValue([{ email: 'patron@societe.fr', id: 'u', firstName: null, lastName: null }]) },
      vehicle: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    } as never;
    const stats = { compute: jest.fn().mockResolvedValue(report) } as never;
    const vraiEmail = new EmailService(
      { get: () => 'https://app.test' } as never, {} as never, {} as never, {} as never,
    );
    const send = jest.fn().mockResolvedValue({ ok: true });
    const email = {
      send,
      buildWeeklyReportEmail: (o: Parameters<EmailService['buildWeeklyReportEmail']>[0]) =>
        vraiEmail.buildWeeklyReportEmail(o),
    } as never;
    const svc = new ReportScheduleService(prisma, stats, new ReportPdfService() as never, email);
    const res = await svc.runDue(new Date('2026-07-06T06:05:00.000Z'));
    const envoi = send.mock.calls[0]?.[0] as { html: string; text: string } | undefined;
    return { res, html: envoi?.html ?? '', text: envoi?.text ?? '' };
  }

  /**
   * ⚠️ LA MÊME PHRASE, AU CARACTÈRE PRÈS, DANS LES DEUX CORPS. C'est l'assertion qui compte :
   * mettre la ligne dans une seule des deux parties MIME ferait lire deux semaines
   * différentes selon le client de messagerie, et personne ne s'en apercevrait jamais.
   */
  it('écrit la MÊME phrase dans le corps texte et dans le corps HTML', async () => {
    const { res, html, text } = await courrierHebdo(rapport());

    expect(res.sent).toBe(1);
    const phrase = '1864 trajets sur 1886 de la semaine (99 %, 11800.4 km) n’ont ni conducteur, '
      + 'ni groupe : ils ne peuvent être attribués à personne. Renseignez un conducteur ou un '
      + 'groupe sur ces véhicules, depuis la page Véhicules, pour que leurs kilomètres comptent '
      + 'pour quelqu’un.';
    expect(text).toContain(phrase);
    expect(html).toContain(phrase);
    /**
     * Le dénominateur est le total RÉEL de la semaine, jamais la somme des lignes classées —
     * et un total à zéro rend la note MUETTE au lieu d'écrire « sur 0 ».
     *
     * ⚠️ ASSERTION DIRECTE, ET C'EST UNE CORRECTION. Elle s'écrivait
     * `expect(text).not.toContain('sur 0 de la semaine')` : elle ne pouvait JAMAIS tomber.
     * `expect` lève à la première assertion fausse, donc cette ligne ne s'exécutait que si
     * celle du dessus avait passé — c'est-à-dire si `text` portait déjà « sur 1886 de la
     * semaine ». Or `buildUnattributedNote` est le seul producteur de « de la semaine » dans
     * tout le dépôt et sa chaîne n'est insérée qu'une fois dans le corps : une seule
     * occurrence possible, donc « sur 0 » mécaniquement exclu. La sentinelle cherchait une
     * chaîne que le code ne peut pas produire, sur la seule surface où il ne la produit pas.
     * Appelée directement, la garde `totalTrips <= 0` est enfin éprouvée — aucun autre test
     * du dépôt ne l'atteint, `dispatch` coupant en amont dès qu'il n'y a aucun trajet.
     */
    expect(buildUnattributedNote({ tripCount: 1864, distanceKm: 11800.4 }, 0)).toBeNull();
  });

  /**
   * Le cas d'une société qui a fait le travail : ses trajets sont tous imputés. Une ligne
   * « 0 trajet non attribué » serait un reproche sans objet, envoyé chaque lundi.
   */
  it('rien à signaler : aucune ligne, ni dans l’un ni dans l’autre corps', async () => {
    const { html, text } = await courrierHebdo(rapport({
      unattributedTrips: { tripCount: 0, distanceKm: 0, durationHours: 0 },
    }));

    expect(text).not.toContain('ni conducteur, ni groupe');
    expect(html).not.toContain('ni conducteur, ni groupe');
    expect(html).not.toContain('Trajets non attribués');
    // Le reste du courrier est intact.
    expect(text).toContain('1886 trajets');
  });

  /**
   * Le champ est OPTIONNEL au contrat : un producteur qui ne le fabrique pas rend un courrier
   * MUET sur ce point — et un courrier quand même.
   *
   * ⚠️ `res.sent` EST L'ASSERTION QUI COMPTE. Sans elle, ce test serait satisfait par un
   * courrier qui n'est jamais parti : une lecture de `distanceKm` sur un champ absent lève,
   * `dispatch` attrape, le passage tombe en FAILED, et les deux corps sont vides — donc
   * « aucune ligne », donc vert. Le silence doit être un choix, pas un plantage rattrapé.
   */
  it('champ absent du rapport : aucune ligne inventée, et le courrier part quand même', async () => {
    const sans = rapport();
    delete (sans as Record<string, unknown>).unattributedTrips;
    const { res, html, text } = await courrierHebdo(sans);

    expect(res.sent).toBe(1);
    expect(text).toContain('1886 trajets');
    expect(text).not.toContain('ni conducteur, ni groupe');
    expect(html).not.toContain('ni conducteur, ni groupe');
  });

  /**
   * Société sans un seul trajet : le cron n'envoie rien (il l'écrit au journal), donc aucun
   * corps à comparer — mais surtout aucune division par zéro n'a pu être mise en forme.
   */
  it('société sans aucun trajet : pas de courrier, donc pas de « sur 0 »', async () => {
    const { res, html, text } = await courrierHebdo(rapport({
      trips: {
        count: 0, totalKm: 0, totalDurationHours: 0,
        avgKmPerVehicle: 0, avgKmBasisVehicles: 0, avgKmBasisKm: 0,
        avgSpeedKmh: 0, maxSpeedKmh: 0,
      },
      unattributedTrips: { tripCount: 0, distanceKm: 0, durationHours: 0 },
    }));

    expect(res.sent).toBe(0);
    expect(res.skipped).toBe(1);
    expect(text).toBe('');
    expect(html).toBe('');
  });

  /**
   * ⚠️ LA PART SUIT LA RÈGLE DU CONTRAT PARTAGÉ, comme à l'écran, dans le PDF et dans le
   * classeur : « 1 sur 1 000 » ne peut pas s'écrire « 0 % » dans un courrier dont l'objet
   * est justement de signaler ce qui manque.
   */
  it('un trajet sur mille s’écrit « < 1 % », pas « 0 % »', async () => {
    const { text, html } = await courrierHebdo(rapport({
      trips: {
        count: 1000, totalKm: 12040.5, totalDurationHours: 401.2,
        avgKmPerVehicle: 316.9, avgKmBasisVehicles: 38, avgKmBasisKm: 12040.5,
        avgSpeedKmh: 30, maxSpeedKmh: 128,
      },
      unattributedTrips: { tripCount: 1, distanceKm: 8.2, durationHours: 0.4 },
    }));

    expect(text).toContain('1 trajet sur 1000 de la semaine (< 1 %, 8.2 km) n’a ni conducteur, ni groupe');
    // Accord au singulier : « il ne peut être attribué », pas « ils ne peuvent ».
    expect(text).toContain('il ne peut être attribué à personne');
    // ⚠️ Le corps HTML porte la MÊME phrase, correctement encodée pour SON support : le
    // « < » de « < 1 % » y est échappé. C'est ce que doit faire un modèle d'e-mail qui reçoit
    // du texte — l'oublier ouvrirait un début de balise au milieu d'une phrase.
    expect(html).toContain('(&lt; 1 %, 8.2 km)');
    expect(text).not.toContain('(0 %,');
  });
});
