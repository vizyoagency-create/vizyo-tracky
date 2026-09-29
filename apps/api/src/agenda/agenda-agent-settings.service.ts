import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type {
  AgendaAgentAutonomy,
  AgendaAgentFrequency,
  AgendaAgentSettingsDto,
  DestinatairesAvisDto,
  FleetMetier,
  SetAgendaAgentSettingsDto,
} from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { DestinatairesAvisService } from './destinataires-avis.service';

const FREQUENCIES: AgendaAgentFrequency[] = ['daily', 'weekly'];
const AUTONOMIES: AgendaAgentAutonomy[] = ['suggest', 'auto_high_confidence'];

/**
 * Valeurs d'une société qui n'a jamais enregistré de réglage — les MÊMES que `toDto` et que les
 * défauts du schéma. Un premier enregistrement se compare à elles : « activé : non → oui », et non
 * dix lignes pour des valeurs que l'écran affichait déjà.
 */
const DEFAUTS: Required<EditableFieldsBase> = {
  enabled: false,
  nightlyHour: 2,
  frequency: 'daily',
  autonomy: 'suggest',
  confidenceThreshold: 80,
  autoCompleteAfterReservation: false,
  triggerNightly: true,
  triggerIncident: true,
  triggerMaintenance: true,
  triggerReservation: false,
};

/** Libellé lisible d'un champ et de sa valeur — ce que le fil « Agenda » affiche. */
const oui = (b: unknown) => (b ? 'oui' : 'non');
const CHAMPS: Record<keyof EditableFieldsBase, { libelle: string; valeur: (v: unknown) => string }> = {
  enabled: { libelle: 'agent activé', valeur: oui },
  nightlyHour: { libelle: 'heure du passage de nuit', valeur: (v) => `${String(v)} h` },
  frequency: { libelle: 'fréquence', valeur: (v) => (v === 'weekly' ? 'chaque semaine' : 'chaque nuit') },
  autonomy: {
    libelle: 'autonomie',
    valeur: (v) => (v === 'auto_high_confidence' ? 'réserve au-dessus du seuil' : 'propose seulement'),
  },
  confidenceThreshold: { libelle: 'seuil de confiance', valeur: (v) => `${String(v)} %` },
  autoCompleteAfterReservation: { libelle: 'optimiser après une réservation', valeur: oui },
  triggerNightly: { libelle: 'passage de nuit', valeur: oui },
  triggerIncident: { libelle: 'relance après un incident', valeur: oui },
  triggerMaintenance: { libelle: 'relance après une maintenance', valeur: oui },
  triggerReservation: { libelle: 'relance après une réservation', valeur: oui },
};

type SettingsRow = {
  enabled: boolean;
  nightlyHour: number;
  frequency: string;
  autonomy: string;
  confidenceThreshold: number;
  autoCompleteAfterReservation: boolean;
  triggerNightly: boolean;
  triggerIncident: boolean;
  triggerMaintenance: boolean;
  triggerReservation: boolean;
  lastRunAt: Date | null;
};
type EditableFieldsBase = Omit<SettingsRow, 'lastRunAt'>;
type EditableFields = Partial<EditableFieldsBase>;

/**
 * Refonte agenda/IA (2026-07) — Réglages de l'agent d'optimisation d'agenda, PAR FLOTTE.
 * Une ligne par flotte (opt-in), lue/écrite depuis la ⚙️ « Paramètres de l'agenda ».
 * L'agent nocturne (P3) consommera ces réglages. Scoping tenant STRICT : un super-admin doit
 * préciser la flotte ; un non-SA règle toujours la sienne (le `fleetId` qu'il envoie est ignoré, et
 * un compte d'une autre société lui est refusé). Métier lu de la flotte (édité via
 * l'endpoint dédié `/ai/fleet-metier`) ; coût IA du mois lu via `AiUsageService`.
 */
@Injectable()
export class AgendaAgentSettingsService {
  private readonly logger = new Logger(AgendaAgentSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiUsage: AiUsageService,
    // La règle « qui peut valider / qui est prévenu » vit dans UN seul service, partagé avec le
    // notifieur. La redéfinir ici, c'est se condamner à ce que les deux divergent un jour.
    private readonly destinataires: DestinatairesAvisService,
    // Journal métier (29/09, @Global) — en dernier et @Optional : sans lui, rien ne casse.
    @Optional() private readonly systemActivity?: SystemActivityService,
  ) {}

  /**
   * Une ligne `reglages_agent_modifies` (catégorie AGENDA) — les SEULS champs qui ont changé,
   * « avant → après », sur la société RÉGLÉE (pas celle de l'utilisateur : un super-admin règle
   * celle d'un client). Un enregistrement qui ne change rien n'écrit rien.
   */
  private journaliserReglages(user: AuthUser, fleetId: string, avant: SettingsRow | null, data: EditableFields): void {
    if (!this.systemActivity) return;
    try {
      const base: EditableFieldsBase = { ...DEFAUTS, ...(avant ?? {}) };
      const champs = (Object.keys(data) as (keyof EditableFieldsBase)[]).filter(
        (k) => data[k] !== undefined && data[k] !== base[k],
      );
      if (champs.length === 0) return;
      const detail = champs
        .map((k) => `${CHAMPS[k].libelle} : ${CHAMPS[k].valeur(base[k])} → ${CHAMPS[k].valeur(data[k])}`)
        .join(' ; ');
      this.systemActivity.record({
        category: 'AGENDA',
        action: 'reglages_agent_modifies',
        actor: 'utilisateur',
        target: null,
        detail: `Réglages de l'agent — ${detail}`,
        fleetId,
        triggeredByUserId: user.id,
        meta: {
          champs,
          avant: Object.fromEntries(champs.map((k) => [k, base[k]])),
          apres: Object.fromEntries(champs.map((k) => [k, data[k]])),
          premierReglage: avant === null,
        },
      });
    } catch (e) {
      this.logger.warn(`journal réglages de l'agent non écrit : ${(e as Error)?.message ?? e}`);
    }
  }

  /**
   * La société réglée DEPUIS L'ÉCRAN. Super-admin : celle qu'il vise (`fleetId`, le bandeau), à préciser
   * s'il n'en a pas. Tout autre rôle : LA SIENNE — le `fleetId` qu'il envoie est ignoré (29/09) : il
   * vient du filtre société relu du navigateur, qui porte après une session super-admin la société d'un
   * autre client. La feuille Paramètres ne l'envoie qu'à un super-admin ; un écran moins prudent aurait
   * privé l'administrateur de ses propres réglages (403). Même règle que
   * `AgendaAgentRunnerService.resolveFleetId`.
   */
  private resolveFleetId(user: AuthUser, fleetId?: string): string {
    if (user.role !== UserRole.SUPER_ADMIN) {
      if (!user.fleetId) throw new ForbiddenException('Aucune flotte associée');
      return user.fleetId;
    }
    const id = fleetId ?? user.fleetId ?? undefined;
    if (!id) throw new BadRequestException('Préciser la flotte (fleetId).');
    return id;
  }

  /**
   * ── QUI EST PRÉVENU QUAND UN CONDUCTEUR DEMANDE UN VÉHICULE ────────────────────────────
   *
   * On rend TOUS ceux qui peuvent valider, chacun avec son réglage. Montrer seulement les
   * destinataires cacherait le geste utile : c'est en voyant les autres qu'on décide d'en
   * ajouter un. L'écran sert autant à comprendre qu'à régler.
   */
  async destinatairesAvis(user: AuthUser, fleetId?: string): Promise<DestinatairesAvisDto> {
    const id = this.resolveFleetId(user, fleetId);
    const comptes = await this.destinataires.possibles(id);
    return {
      fleetId: id,
      comptes: comptes.map((c) => ({
        userId: c.id,
        email: c.email ?? '—',
        role: c.role,
        notifie: c.notifie,
      })),
    };
  }

  /**
   * Bascule l'avis pour UN compte.
   *
   * ⚠️ ON REFUSE DE COUPER LE DERNIER. Une demande de conducteur qui n'atteint personne reste
   * en plan sans que quiconque le sache — le même raisonnement que l'interrupteur des alertes
   * d'exploitation, qui refuse de fermer ses deux canaux. Couper volontairement TOUT le monde
   * se fait donc en retirant `reservations_manage`, un geste qui dit ce qu'il fait.
   */
  async reglerAvis(user: AuthUser, dto: { userId: string; notifie: boolean }): Promise<DestinatairesAvisDto> {
    const cible = await this.prisma.user.findUnique({
      where: { id: dto?.userId ?? '' },
      select: { id: true, fleetId: true, email: true },
    });
    if (!cible?.fleetId) throw new NotFoundException('Compte introuvable.');
    // Ici la société vient du COMPTE visé, pas de l'écran : pour un non-super-admin, une société qui
    // n'est pas la sienne est un vrai hors-périmètre — `resolveFleetId`, qui l'ignorerait, écrirait sur
    // le compte d'un autre client.
    if (user.role !== UserRole.SUPER_ADMIN && cible.fleetId !== user.fleetId) {
      throw new ForbiddenException('Flotte hors périmètre.');
    }
    const id = cible.fleetId;

    if (dto.notifie === false) {
      const restants = (await this.destinataires.possibles(id)).filter(
        (c) => c.notifie && c.id !== cible.id,
      );
      if (restants.length === 0) {
        throw new BadRequestException(
          "Impossible de couper le dernier destinataire : une demande de conducteur n'atteindrait plus personne et attendrait sans que quiconque le sache. Ouvrez l'avis à quelqu'un d'autre d'abord.",
        );
      }
    }

    await this.prisma.user.update({
      where: { id: cible.id },
      data: { reservationNoticeEnabled: dto.notifie === true },
    });
    return this.destinatairesAvis(user, id);
  }

  async get(user: AuthUser, fleetId?: string): Promise<AgendaAgentSettingsDto> {
    const id = this.resolveFleetId(user, fleetId);
    const fleet = await this.prisma.fleet.findUnique({
      where: { id },
      select: { id: true, name: true, metier: true },
    });
    if (!fleet) throw new NotFoundException('Flotte introuvable.');
    const row = await this.prisma.agendaAgentSettings.findUnique({ where: { fleetId: id } });
    const monthCostEur = await this.aiUsage.monthCostEur(id, user);
    return this.toDto(fleet, row, monthCostEur);
  }

  async set(user: AuthUser, dto: SetAgendaAgentSettingsDto): Promise<AgendaAgentSettingsDto> {
    const id = this.resolveFleetId(user, dto?.fleetId);
    const fleet = await this.prisma.fleet.findUnique({
      where: { id },
      select: { id: true, name: true, metier: true },
    });
    if (!fleet) throw new NotFoundException('Flotte introuvable.');

    const data = this.sanitize(dto);
    // L'état AVANT, pour ne journaliser que ce qui change. Une lecture qui échoue ne bloque pas
    // l'enregistrement : le journal comparera alors aux défauts.
    let avant: SettingsRow | null = null;
    if (this.systemActivity) {
      try {
        avant = (await this.prisma.agendaAgentSettings.findUnique({ where: { fleetId: id } })) as SettingsRow | null;
      } catch {
        avant = null;
      }
    }
    const row = await this.prisma.agendaAgentSettings.upsert({
      where: { fleetId: id },
      create: { fleetId: id, updatedByUserId: user.id, ...data },
      update: { updatedByUserId: user.id, ...data },
    });
    this.journaliserReglages(user, id, avant, data);
    const monthCostEur = await this.aiUsage.monthCostEur(id, user);
    return this.toDto(fleet, row, monthCostEur);
  }

  /** Valide + borne les champs éditables (mise à jour partielle). */
  private sanitize(dto: SetAgendaAgentSettingsDto): EditableFields {
    const out: EditableFields = {};
    if (dto.enabled !== undefined) out.enabled = !!dto.enabled;
    if (dto.nightlyHour !== undefined) {
      const h = Math.trunc(Number(dto.nightlyHour));
      if (!Number.isFinite(h) || h < 0 || h > 23) throw new BadRequestException('Heure invalide (0-23).');
      out.nightlyHour = h;
    }
    if (dto.frequency !== undefined) {
      if (!FREQUENCIES.includes(dto.frequency)) throw new BadRequestException('Fréquence invalide.');
      out.frequency = dto.frequency;
    }
    if (dto.autonomy !== undefined) {
      if (!AUTONOMIES.includes(dto.autonomy)) throw new BadRequestException('Autonomie invalide.');
      out.autonomy = dto.autonomy;
    }
    if (dto.confidenceThreshold !== undefined) {
      const c = Math.trunc(Number(dto.confidenceThreshold));
      if (!Number.isFinite(c) || c < 0 || c > 100) throw new BadRequestException('Seuil invalide (0-100).');
      out.confidenceThreshold = c;
    }
    if (dto.autoCompleteAfterReservation !== undefined) out.autoCompleteAfterReservation = !!dto.autoCompleteAfterReservation;
    if (dto.triggerNightly !== undefined) out.triggerNightly = !!dto.triggerNightly;
    if (dto.triggerIncident !== undefined) out.triggerIncident = !!dto.triggerIncident;
    if (dto.triggerMaintenance !== undefined) out.triggerMaintenance = !!dto.triggerMaintenance;
    if (dto.triggerReservation !== undefined) out.triggerReservation = !!dto.triggerReservation;
    return out;
  }

  /** Mappe la ligne (ou les défauts si absente) vers le DTO exposé. */
  private toDto(
    fleet: { id: string; name: string | null; metier: string },
    row: SettingsRow | null,
    monthCostEur: number,
  ): AgendaAgentSettingsDto {
    return {
      fleetId: fleet.id,
      fleetName: fleet.name,
      enabled: row?.enabled ?? false,
      nightlyHour: row?.nightlyHour ?? 2,
      frequency: (row?.frequency as AgendaAgentFrequency) ?? 'daily',
      autonomy: (row?.autonomy as AgendaAgentAutonomy) ?? 'suggest',
      confidenceThreshold: row?.confidenceThreshold ?? 80,
      autoCompleteAfterReservation: row?.autoCompleteAfterReservation ?? false,
      triggerNightly: row?.triggerNightly ?? true,
      triggerIncident: row?.triggerIncident ?? true,
      triggerMaintenance: row?.triggerMaintenance ?? true,
      triggerReservation: row?.triggerReservation ?? false,
      metier: fleet.metier as FleetMetier,
      lastRunAt: row?.lastRunAt ? row.lastRunAt.toISOString() : null,
      monthCostEur: Math.round(monthCostEur * 10000) / 10000,
    };
  }
}
