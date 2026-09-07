import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Fleet, FleetReportDispatch, FleetReportSchedule, UserRole } from '@prisma/client';
import type {
  FleetReportDispatchDto,
  FleetReportDispatchStatus,
  FleetReportScheduleDto,
  FleetReportSection,
  FleetReportTrigger,
  SetFleetReportScheduleDto,
} from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { AutomationDisabledException } from '../common/automation-disabled.exception';
import { formatFleetDate, parisDayKey, parisDayStart } from '../common/utils/datetime';
import { buildUnattributedNote, EmailService } from '../email/email.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReportPdfService } from './report-pdf.service';
import { ReportsStatsService } from './reports-stats.service';

const ALL_SECTIONS: FleetReportSection[] = ['kpi', 'alerts', 'topVehicles', 'trips'];
const DAY_MS = 24 * 3600 * 1000;
const PARIS = 'Europe/Paris';

/** Réglage EFFECTIF d'une société : la ligne enregistrée, sinon l'ancien comportement. */
interface EffectiveSchedule {
  enabled: boolean;
  weekday: number;
  hour: number;
  recipients: string[];
  sections: FleetReportSection[];
  vehicleIds: string[];
  maxTrips: number;
  topN: number;
  lastRunAt: Date | null;
  lastStatus: FleetReportDispatchStatus | null;
  lastError: string | null;
  updatedAt: Date | null;
  isDefault: boolean;
}

type FleetWithSchedule = Fleet & { reportSchedule: FleetReportSchedule | null };

/**
 * Rapport hebdomadaire — réglage par société, échéances en heure de Paris, envoi avec le PDF
 * JOINT, et journal de chaque passage.
 *
 * ── Pourquoi ce service existe (audit du 2026-09-02) ─────────────────────────────────────
 *
 * Le cron historique tournait le lundi à 08:00 UTC (09:00 ou 10:00 à Paris selon la saison),
 * envoyait à UN destinataire, un contenu figé, et le courrier disait « PDF en pièce jointe »
 * alors que rien n'était joint — le paramètre n'existait pas dans EmailService. Personne ne
 * pouvait le régler ni voir s'il était parti.
 *
 * ── Règles ───────────────────────────────────────────────────────────────────────────────
 *
 *  · Une société SANS ligne `FleetReportSchedule` garde l'ancien comportement (lundi 08:00
 *    Paris, administrateurs actifs, toutes les sections) ; `Fleet.weeklyReportEmail` reste
 *    honoré : '-' = coupé, une adresse = ce destinataire. C'est `effective()`.
 *  · Échéance = jour + heure choisis, en heure de Paris. Le cron passe chaque heure et envoie
 *    si l'échéance la plus récente est postérieure au dernier passage. Une API arrêtée à
 *    l'heure dite rattrape donc l'envoi à son redémarrage — sans doublon (le journal fait foi).
 *  · Période couverte = les 7 jours civils qui précèdent le jour d'envoi (lundi → dimanche
 *    pour un envoi le lundi).
 *  · Chaque passage écrit une ligne de journal, y compris SKIPPED (aucun trajet, aucun
 *    destinataire) : une absence de courrier doit s'expliquer sans ouvrir les logs.
 */
@Injectable()
export class ReportScheduleService {
  private readonly logger = new Logger(ReportScheduleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stats: ReportsStatsService,
    private readonly pdf: ReportPdfService,
    private readonly email: EmailService,
    @Optional() private readonly errorLogger?: ErrorLogger,
  ) {}

  // ─── Périmètre ──────────────────────────────────────────────────────────────────────

  /** Société visée : la sienne, ou celle demandée par un super-admin. */
  resolveFleetId(user: AuthUser, fleetIdQ?: string): string {
    if (user.role === UserRole.SUPER_ADMIN) {
      const id = fleetIdQ || user.fleetId;
      // Message lisible : un super-admin qui regarde « toutes les sociétés » n'a pas de
      // société courante, et le réglage d'un rapport hebdomadaire n'a de sens que pour une.
      if (!id) throw new BadRequestException('Choisissez une société pour régler son rapport hebdomadaire.');
      return id;
    }
    if (fleetIdQ && fleetIdQ !== user.fleetId) throw new ForbiddenException('Société hors périmètre');
    if (!user.fleetId) throw new ForbiddenException('Aucune société rattachée');
    return user.fleetId;
  }

  private async loadFleet(fleetId: string): Promise<FleetWithSchedule> {
    const fleet = await this.prisma.fleet.findUnique({ where: { id: fleetId }, include: { reportSchedule: true } });
    if (!fleet) throw new NotFoundException('Société introuvable');
    return fleet;
  }

  // ─── Lecture / écriture ─────────────────────────────────────────────────────────────

  async get(user: AuthUser, fleetIdQ?: string): Promise<FleetReportScheduleDto> {
    const fleet = await this.loadFleet(this.resolveFleetId(user, fleetIdQ));
    return this.toDto(fleet, this.effective(fleet), await this.adminEmails(fleet.id));
  }

  async set(user: AuthUser, body: SetFleetReportScheduleDto, fleetIdQ?: string): Promise<FleetReportScheduleDto> {
    const fleetId = this.resolveFleetId(user, fleetIdQ);
    await this.loadFleet(fleetId);

    const sections = ALL_SECTIONS.filter((s) => body.sections.includes(s));
    if (sections.length === 0) throw new BadRequestException('Choisissez au moins une section');

    const vehicleIds = Array.from(new Set(body.vehicleIds));
    if (vehicleIds.length > 0) {
      const owned = await this.prisma.vehicle.count({ where: { id: { in: vehicleIds }, fleetId } });
      if (owned !== vehicleIds.length) throw new BadRequestException("Un des véhicules n'appartient pas à la société");
    }
    const recipients = Array.from(new Set(body.recipients.map((r) => r.trim().toLowerCase()).filter(Boolean)));

    const data = {
      enabled: body.enabled,
      weekday: body.weekday,
      hour: body.hour,
      recipients,
      sections,
      vehicleIds,
      maxTrips: body.maxTrips,
      topN: body.topN,
      updatedByUserId: user.id,
    };
    await this.prisma.fleetReportSchedule.upsert({
      where: { fleetId },
      create: { fleetId, ...data },
      update: data,
    });
    this.logger.log(`Rapport hebdo réglé pour ${fleetId} par ${user.email}: ${body.enabled ? 'actif' : 'coupé'}, jour ${body.weekday} ${body.hour}h Paris, ${recipients.length || 'admins'} destinataire(s)`);
    return this.get(user, fleetId);
  }

  /**
   * ══ LE RÉGLAGE DE TOUTES LES SOCIÉTÉS, EN UNE LECTURE ═════════════════════════════
   *
   * ── POURQUOI ────────────────────────────────────────────────────────────────────────
   *
   * Le réglage hebdomadaire ne se lisait QUE société par société : pour savoir si le rapport
   * d'un client était coupé, il fallait le sélectionner dans le sélecteur du haut, attendre
   * le chargement, lire, recommencer. Personne ne fait ça pour vingt sociétés — donc un
   * rapport coupé, ou dont l'envoi échoue chaque semaine, se découvrait par hasard, souvent
   * parce que le client finissait par le signaler.
   *
   * ⚠️ RÉSERVÉ AU SUPER-ADMINISTRATEUR. Un administrateur de société n'a rien à apprendre du
   * réglage des autres — et le nom d'une société cliente est déjà une information.
   *
   * ⚠️ DEUX requêtes, pas deux par société : les destinataires par défaut (les administrateurs
   * actifs) sont chargés d'un coup et regroupés en mémoire. Sur vingt sociétés, la version
   * naïve aurait fait vingt-et-une requêtes pour un écran de consultation.
   */
  async listAll(user: AuthUser): Promise<FleetReportScheduleDto[]> {
    if (user.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Vue d’ensemble réservée à l’administration de la plateforme');
    }
    const [fleets, admins] = await Promise.all([
      this.prisma.fleet.findMany({ include: { reportSchedule: true }, orderBy: { name: 'asc' } }),
      this.prisma.user.findMany({
        where: { role: UserRole.FLEET_ADMIN, isActive: true },
        orderBy: { createdAt: 'asc' },
        select: { fleetId: true, email: true },
      }),
    ]);
    const parFlotte = new Map<string, string[]>();
    for (const a of admins) {
      if (!a.fleetId) continue;
      const liste = parFlotte.get(a.fleetId) ?? [];
      const email = a.email.trim().toLowerCase();
      if (email && !liste.includes(email)) liste.push(email);
      parFlotte.set(a.fleetId, liste);
    }
    return fleets.map((f) => this.toDto(f, this.effective(f), parFlotte.get(f.id) ?? []));
  }

  /** Journal des envois — une société, ou toutes pour un super-admin sans fleetId. */
  async listDispatches(user: AuthUser, fleetIdQ?: string, limit = 20): Promise<FleetReportDispatchDto[]> {
    const where =
      user.role === UserRole.SUPER_ADMIN && !fleetIdQ
        ? {}
        : { fleetId: this.resolveFleetId(user, fleetIdQ) };
    const rows = await this.prisma.fleetReportDispatch.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(100, Math.max(1, limit)),
      include: { fleet: { select: { name: true } } },
    });
    const userIds = Array.from(new Set(rows.map((r) => r.requestedByUserId).filter((x): x is string => !!x)));
    const users = userIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, lastName: true, email: true } })
      : [];
    const nameOf = new Map(users.map((u) => [u.id, [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email]));
    return rows.map((r) => this.dispatchToDto(r, r.fleet.name, r.requestedByUserId ? nameOf.get(r.requestedByUserId) ?? null : null));
  }

  /**
   * Envoi immédiat : les 7 derniers jours civils révolus, aux destinataires réglés.
   *
   * ⚠️ Refusé (409) quand l'envoi automatique est coupé (design/C3 point 2, 2026-09-05). Le
   * bouton partait vers de vraies boîtes aux lettres — actif par défaut pour TOUTES les
   * sociétés, sociétés d'essai comprises — alors que l'exploitant avait coupé l'envoi : un
   * réglage qu'un bouton contourne n'est pas un réglage. Le refus tombe AVANT tout calcul et
   * n'écrit aucune ligne de journal d'envoi (rien n'est parti) ; c'est le contrôleur qui
   * consigne le refus dans l'activité système. Le cron (`runDue`) ignorait déjà ces sociétés.
   */
  async sendNow(user: AuthUser, fleetIdQ?: string): Promise<FleetReportDispatchDto> {
    const fleet = await this.loadFleet(this.resolveFleetId(user, fleetIdQ));
    const eff = this.effective(fleet);
    if (!eff.enabled) {
      throw new AutomationDisabledException(
        "L'envoi automatique est coupé pour cette société : réactivez-le avant d'envoyer.",
      );
    }
    const todayKey = parisDayKey(new Date());
    const to = parisDayStart(todayKey);
    const from = parisDayStart(this.shiftDayKey(todayKey, -7));
    const row = await this.dispatch(fleet, eff, from, to, 'manual', user);
    return this.dispatchToDto(row, fleet.name, [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email);
  }

  // ─── Cron ───────────────────────────────────────────────────────────────────────────

  /** Passage horaire : envoie les rapports dont l'échéance est passée depuis le dernier envoi. */
  async runDue(now = new Date()): Promise<{ sent: number; failed: number; skipped: number }> {
    const out = { sent: 0, failed: 0, skipped: 0 };
    const fleets = await this.prisma.fleet.findMany({ include: { reportSchedule: true } });
    for (const fleet of fleets) {
      try {
        const eff = this.effective(fleet);
        if (!eff.enabled) continue;
        const dueAt = this.lastOccurrence(eff.weekday, eff.hour, now);
        if (!dueAt) continue;

        /**
         * ⚠️ JAMAIS DE RATTRAPAGE DU PASSÉ.
         *
         * Une société sans ligne de réglage n'a ni dernier passage ni date de configuration :
         * la dernière échéance est donc, mécaniquement, dans le passé. Sans ce garde-fou, la
         * toute première exécution après une mise en ligne aurait envoyé d'un coup, à TOUTES
         * les sociétés, le rapport du lundi précédent — un courrier de masse déclenché par un
         * déploiement, ce que personne n'a demandé.
         *
         * On enregistre donc le passage sans rien envoyer : l'échéance SUIVANTE partira
         * normalement. Même règle pour une société qui vient de régler son rapport (`updatedAt`
         * postérieur à l'échéance) : elle ne reçoit pas rétroactivement la semaine d'avant.
         */
        const reference = eff.lastRunAt ?? eff.updatedAt;
        if (!reference) {
          await this.touch(fleet.id, eff, { lastRunAt: now });
          continue;
        }
        if (reference.getTime() >= dueAt.getTime()) continue;

        const dueKey = parisDayKey(dueAt);
        const to = parisDayStart(dueKey);
        const from = parisDayStart(this.shiftDayKey(dueKey, -7));

        // Le journal fait foi contre un doublon (ligne de réglage absente ou remise à zéro).
        const already = await this.prisma.fleetReportDispatch.findFirst({
          where: { fleetId: fleet.id, trigger: 'cron', periodFrom: from, status: { in: ['SENT', 'SKIPPED'] } },
          select: { id: true },
        });
        if (already) {
          await this.touch(fleet.id, eff, { lastRunAt: now });
          continue;
        }

        const row = await this.dispatch(fleet, eff, from, to, 'cron', null);
        if (row.status === 'SENT') out.sent++;
        else if (row.status === 'FAILED') out.failed++;
        else out.skipped++;
      } catch (err) {
        out.failed++;
        this.logger.warn(`Rapport hebdo — société ${fleet.id} : ${err instanceof Error ? err.message : err}`);
        this.errorLogger?.recordBackground(err instanceof Error ? err : new Error(String(err)), 'cron:reports', { fleetId: fleet.id });
      }
    }
    if (out.sent || out.failed || out.skipped) {
      this.logger.log(`Rapport hebdo — passage : ${out.sent} envoyé(s), ${out.skipped} sans objet, ${out.failed} en échec`);
    }
    return out;
  }

  // ─── Envoi ──────────────────────────────────────────────────────────────────────────

  private async dispatch(
    fleet: FleetWithSchedule,
    eff: EffectiveSchedule,
    from: Date,
    to: Date,
    trigger: FleetReportTrigger,
    requestedBy: AuthUser | null,
  ): Promise<FleetReportDispatch> {
    const recipients = eff.recipients.length ? eff.recipients : await this.adminEmails(fleet.id);
    let status: FleetReportDispatchStatus = 'FAILED';
    let error: string | null = null;
    let tripsCount = 0;
    let pdfBytes = 0;

    try {
      if (recipients.length === 0) {
        status = 'SKIPPED';
        error = 'Aucun destinataire : aucun administrateur actif et aucune adresse réglée';
      } else {
        const report = await this.stats.compute(fleet.id, from, to, undefined, {
          vehicleIds: eff.vehicleIds,
          maxRecentTrips: eff.maxTrips,
          topN: eff.topN,
        });
        tripsCount = report.trips.count;
        if (tripsCount === 0 && trigger === 'cron') {
          // Pas de courrier vide chaque semaine — mais une ligne de journal, pour que
          // « je n'ai rien reçu » ait une réponse.
          status = 'SKIPPED';
          error = 'Aucun trajet sur la période';
        } else {
          const scopeLabel = await this.scopeLabel(eff.vehicleIds);
          const pdf = await this.pdf.generate(report, {
            sections: eff.sections,
            maxTrips: eff.maxTrips,
            topN: eff.topN,
            scopeLabel,
            title: 'Rapport hebdomadaire',
          });
          pdfBytes = pdf.length;
          const lastDay = new Date(to.getTime() - 1);
          const fromStr = formatFleetDate(from);
          const toStr = formatFleetDate(lastDay);
          const pdfName = `tracky-rapport-${parisDayKey(from)}_${parisDayKey(lastDay)}.pdf`;
          const subject = `Rapport hebdomadaire — ${fleet.name}`;
          /**
           * ⚠️ LA MÊME PHRASE DANS LES DEUX PARTIES MIME DU MÊME MESSAGE (F13).
           *
           * Elle est calculée UNE fois — `buildUnattributedNote`, du côté e-mail — puis posée
           * ici dans le corps texte et passée là dans le corps HTML. La rédiger deux fois
           * aurait fini par faire lire deux semaines différentes au client sous Outlook et au
           * client en texte brut, sur le seul document que la plupart des gestionnaires
           * ouvrent vraiment. `null` quand il n'y a rien à signaler : ce courrier part
           * automatiquement à TOUTES les sociétés, une ligne à zéro serait un reproche
           * sans objet.
           */
          const nonAttribues = buildUnattributedNote(report.unattributedTrips, report.trips.count);
          /**
           * ── UNE LIGNE POUR LES EXCÈS, ET UNE SEULE ──────────────────────────────────
           *
           * C'est le chiffre qu'un gestionnaire cherche le lundi matin, et il n'existait que
           * dans la pièce jointe — invisible sur un téléphone, là où ce courrier se lit.
           *
           * ⚠️ ELLE DISPARAÎT QUAND IL N'Y EN A PAS. Ce courrier part automatiquement à toutes
           * les sociétés : une ligne « 0 excès » chaque lundi serait un reproche sans objet —
           * la même raison qui fait taire la ligne des non attribués.
           *
           * ⚠️ ET LE COMPTE VIENT DE `trips`, PAS DE `topVehicles`. Ces listes s'arrêtent à
           * `topN` : les sommer donnerait un total silencieusement trop bas dès qu'une société
           * dépasse dix véhicules — « cdef31 » en a trente.
           */
          const exces = report.trips.speedingCount > 0
            ? `- ${report.trips.speedingCount} excès de vitesse`
            : null;
          const text = `Bonjour,\n\nVotre rapport Vizyo Tracky pour la semaine du ${fromStr} au ${toStr} (inclus) est en pièce jointe.\n\nRésumé :\n- ${report.trips.count} trajets, ${report.trips.totalKm.toFixed(1)} km\n- ${report.alerts.total} alertes\n${exces ? `${exces}\n` : ''}- Conso estimée : ${report.consumption.estimatedLiters.toFixed(1)} L (${report.consumption.estimatedCostEur.toFixed(2)} EUR)\n${nonAttribues ? `\nTrajets non attribués : ${nonAttribues}\n` : ''}\nL'équipe Vizyo`;
          const html = this.email.buildWeeklyReportEmail({
            fromStr,
            toStr,
            tripsCount: report.trips.count,
            totalKm: report.trips.totalKm,
            alertsTotal: report.alerts.total,
            speedingCount: report.trips.speedingCount,
            liters: report.consumption.estimatedLiters,
            costEur: report.consumption.estimatedCostEur,
            pdfName,
            unattributedNote: nonAttribues,
            /**
             * ── LE BOUTON MÈNE AU RAPPORT, PLUS AU TABLEAU DE BORD ────────────────────
             *
             * Un courrier qui s'appelle « rapport hebdomadaire » et dont le seul bouton ouvre
             * le tableau de bord oblige à refaire à la main la période qu'on vient de lire.
             * Les deux bornes sont celles du document, à l'identique — `to` est EXCLUSIVE des
             * deux côtés, donc la page ouvre exactement la semaine de la pièce jointe.
             *
             * ⚠️ ET LA SOCIÉTÉ VOYAGE AVEC. La page Rapports prend la sienne dans le sélecteur
             * du haut, persisté d'une visite à l'autre : un super-admin qui ouvrait ce bouton
             * lisait les chiffres de la société sur laquelle son sélecteur était resté, sous le
             * titre de la semaine annoncée ici. Le document dit « ${fleet.name} » ; le lien doit
             * dire la même chose, sinon il vaut mieux ne pas en mettre.
             *
             * Un destinataire d'une seule société ne voit pas la différence — son périmètre est
             * posé par le serveur — et c'est très bien : le paramètre ne fait rien pour lui.
             */
            lienRapport: `/reports?fleet=${fleet.id}&from=${parisDayKey(from)}&to=${parisDayKey(to)}`,
          });

          const failures: string[] = [];
          for (const to of recipients) {
            const r = await this.email.send({
              to,
              subject,
              html,
              text,
              template: 'weekly_report',
              fleetId: fleet.id,
              context: { fleetId: fleet.id, weekly: true, trigger, pdfBytes, requestedByUserId: requestedBy?.id },
              attachments: [{ filename: pdfName, content: pdf }],
            });
            if (!r.ok) failures.push(`${to} : ${r.error ?? 'échec'}`);
          }
          if (failures.length === recipients.length) {
            status = 'FAILED';
            error = failures.join(' ; ');
          } else {
            status = 'SENT';
            error = failures.length ? `Envoi partiel — ${failures.join(' ; ')}` : null;
          }
        }
      }
    } catch (err) {
      status = 'FAILED';
      error = err instanceof Error ? err.message : String(err);
      this.errorLogger?.recordBackground(err instanceof Error ? err : new Error(error), 'cron:reports', { fleetId: fleet.id, trigger });
    }

    const row = await this.prisma.fleetReportDispatch.create({
      data: {
        fleetId: fleet.id,
        trigger,
        status,
        periodFrom: from,
        periodTo: to,
        recipients,
        tripsCount,
        pdfBytes,
        error,
        requestedByUserId: requestedBy?.id ?? null,
      },
    });
    await this.touch(fleet.id, eff, { lastRunAt: row.createdAt, lastStatus: status, lastError: error });
    this.logger.log(`Rapport hebdo ${fleet.name} (${trigger}) : ${status}${error ? ` — ${error}` : ''} → ${recipients.join(', ') || 'personne'} (${pdfBytes} octets, ${tripsCount} trajets)`);
    return row;
  }

  /** Mémorise le dernier passage — crée la ligne avec le réglage effectif si elle n'existe pas. */
  private async touch(
    fleetId: string,
    eff: EffectiveSchedule,
    patch: { lastRunAt: Date; lastStatus?: FleetReportDispatchStatus; lastError?: string | null },
  ): Promise<void> {
    await this.prisma.fleetReportSchedule.upsert({
      where: { fleetId },
      create: {
        fleetId,
        enabled: eff.enabled,
        weekday: eff.weekday,
        hour: eff.hour,
        recipients: eff.recipients,
        sections: eff.sections,
        vehicleIds: eff.vehicleIds,
        maxTrips: eff.maxTrips,
        topN: eff.topN,
        ...patch,
      },
      update: patch,
    });
  }

  private async scopeLabel(vehicleIds: string[]): Promise<string | undefined> {
    if (vehicleIds.length === 0) return undefined;
    const plates = await this.prisma.vehicle.findMany({
      where: { id: { in: vehicleIds } },
      select: { plate: true, brand: true, model: true },
      orderBy: { plate: 'asc' },
    });
    if (plates.length === 1) {
      const v = plates[0]!;
      return [v.plate, [v.brand, v.model].filter(Boolean).join(' ')].filter(Boolean).join(' — ');
    }
    if (plates.length <= 5) return `${plates.length} véhicules : ${plates.map((v) => v.plate).join(', ')}`;
    return `${plates.length} véhicules sélectionnés`;
  }

  private async adminEmails(fleetId: string): Promise<string[]> {
    const admins = await this.prisma.user.findMany({
      where: { fleetId, role: UserRole.FLEET_ADMIN, isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { email: true },
    });
    return Array.from(new Set(admins.map((a) => a.email.trim().toLowerCase()).filter(Boolean)));
  }

  // ─── Réglage effectif & DTO ─────────────────────────────────────────────────────────

  /** Ligne enregistrée, sinon l'ancien comportement (cf. en-tête). */
  effective(fleet: FleetWithSchedule): EffectiveSchedule {
    const row = fleet.reportSchedule;
    if (row) {
      return {
        enabled: row.enabled,
        weekday: row.weekday,
        hour: row.hour,
        recipients: row.recipients,
        sections: ALL_SECTIONS.filter((s) => row.sections.includes(s)),
        vehicleIds: row.vehicleIds,
        maxTrips: row.maxTrips,
        topN: row.topN,
        lastRunAt: row.lastRunAt,
        lastStatus: (row.lastStatus as FleetReportDispatchStatus | null) ?? null,
        lastError: row.lastError,
        updatedAt: row.updatedAt,
        // Une ligne créée par le cron pour mémoriser un passage n'est pas un réglage choisi.
        isDefault: row.updatedByUserId == null,
      };
    }
    const legacy = fleet.weeklyReportEmail;
    return {
      enabled: legacy !== '-',
      weekday: 1,
      hour: 8,
      recipients: legacy && legacy !== '-' ? [legacy.trim().toLowerCase()] : [],
      sections: ALL_SECTIONS,
      vehicleIds: [],
      maxTrips: 30,
      topN: 10,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      updatedAt: null,
      isDefault: true,
    };
  }

  private toDto(fleet: FleetWithSchedule, eff: EffectiveSchedule, adminEmails: string[]): FleetReportScheduleDto {
    const now = new Date();
    const next = this.nextOccurrence(eff.weekday, eff.hour, now) ?? now;
    const nextKey = parisDayKey(next);
    return {
      fleetId: fleet.id,
      fleetName: fleet.name,
      enabled: eff.enabled,
      weekday: eff.weekday,
      hour: eff.hour,
      recipients: eff.recipients,
      effectiveRecipients: eff.recipients.length ? eff.recipients : adminEmails,
      sections: eff.sections,
      vehicleIds: eff.vehicleIds,
      maxTrips: eff.maxTrips,
      topN: eff.topN,
      lastRunAt: eff.lastRunAt?.toISOString() ?? null,
      lastStatus: eff.lastStatus,
      lastError: eff.lastError,
      nextDueAt: next.toISOString(),
      nextPeriodFrom: this.shiftDayKey(nextKey, -7),
      nextPeriodTo: this.shiftDayKey(nextKey, -1),
      isDefault: eff.isDefault,
      updatedAt: eff.updatedAt?.toISOString() ?? null,
    };
  }

  private dispatchToDto(r: FleetReportDispatch, fleetName: string, requestedByName: string | null): FleetReportDispatchDto {
    return {
      id: r.id,
      fleetId: r.fleetId,
      fleetName,
      createdAt: r.createdAt.toISOString(),
      trigger: r.trigger as FleetReportTrigger,
      status: r.status as FleetReportDispatchStatus,
      periodFrom: parisDayKey(r.periodFrom),
      periodTo: parisDayKey(new Date(r.periodTo.getTime() - 1)),
      recipients: r.recipients,
      tripsCount: r.tripsCount,
      pdfBytes: r.pdfBytes,
      error: r.error,
      requestedByName,
    };
  }

  // ─── Calendrier (heure de Paris) ────────────────────────────────────────────────────

  /** Instant d'une heure pleine d'un jour civil de Paris — juste aussi le jour du changement d'heure. */
  private wallToInstant(dayKey: string, hour: number): Date {
    const base = parisDayStart(dayKey);
    let cand = new Date(base.getTime() + hour * 3600 * 1000);
    const seen = this.parisHour(cand);
    if (seen !== hour) cand = new Date(cand.getTime() + (hour - seen) * 3600 * 1000);
    return cand;
  }

  private parisHour(d: Date): number {
    const h = new Intl.DateTimeFormat('en-US', { timeZone: PARIS, hour: '2-digit', hourCycle: 'h23' }).format(d);
    return Number(h) % 24;
  }

  /** 1 = lundi … 7 = dimanche. */
  private parisWeekday(d: Date): number {
    const w = new Intl.DateTimeFormat('en-US', { timeZone: PARIS, weekday: 'short' }).format(d);
    return { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[w] ?? 1;
  }

  /** Jour civil décalé de `days` — calculé à midi pour ignorer les changements d'heure. */
  private shiftDayKey(dayKey: string, days: number): string {
    return parisDayKey(new Date(parisDayStart(dayKey).getTime() + days * DAY_MS + 12 * 3600 * 1000));
  }

  /** Échéance la plus récente ≤ now (dans les 7 derniers jours). */
  private lastOccurrence(weekday: number, hour: number, now: Date): Date | null {
    for (let d = 0; d <= 7; d++) {
      const key = parisDayKey(new Date(now.getTime() - d * DAY_MS));
      const inst = this.wallToInstant(key, hour);
      if (this.parisWeekday(inst) === weekday && inst.getTime() <= now.getTime()) return inst;
    }
    return null;
  }

  /** Prochaine échéance > now (dans les 7 prochains jours). */
  private nextOccurrence(weekday: number, hour: number, now: Date): Date | null {
    for (let d = 0; d <= 7; d++) {
      const key = parisDayKey(new Date(now.getTime() + d * DAY_MS));
      const inst = this.wallToInstant(key, hour);
      if (this.parisWeekday(inst) === weekday && inst.getTime() > now.getTime()) return inst;
    }
    return null;
  }
}
