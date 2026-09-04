import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { FleetSpeedAlertSettingsDto, SpeedAlertSimulationDto, SpeedingSegmentDto } from '@vizyo/tracky-shared';
import { decideAlerteExces, reglageEffectif, resolveReceivesFleetAlerts } from '@vizyo/tracky-shared';
import { messageExcesTrajet } from './alerts.service';
import type { AuthUser } from '../auth/types/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import type { SetSpeedAlertSettingsDto, SetVehicleSpeedAlertOverrideDto } from './dto/set-speed-alert-settings.dto';

/**
 * Lot V5 — RÉGLAGE des alertes de vitesse : par société, surchargeable par véhicule.
 *
 * Mêmes règles d'accès que le rapport hebdomadaire : un super-admin règle la société qu'il
 * a choisie dans le sélecteur ; un administrateur ou gestionnaire de flotte règle la sienne,
 * et seulement la sienne. Le droit `alerts_configure` est exigé par le contrôleur pour
 * écrire ; lire demande `alerts_view`.
 *
 * Chaque écriture porte son auteur et sa date, et s'inscrit au journal serveur : un seuil
 * d'alerte qui change doit avoir un nom en face.
 */
/** Analyses lues au plus par essai à blanc. Un outil de réglage ne doit pas peser. */
const MAX_ANALYSES_SIMULEES = 2000;
/** Exemples rendus — assez pour juger le ton et le seuil, pas de quoi noyer l'écran. */
const MAX_EXEMPLES = 10;

@Injectable()
export class SpeedAlertSettingsService {
  private readonly logger = new Logger(SpeedAlertSettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  private resolveFleetId(user: AuthUser, fleetIdQ?: string): string {
    if (user.role === UserRole.SUPER_ADMIN) {
      if (!fleetIdQ) throw new BadRequestException('Choisissez une société');
      return fleetIdQ;
    }
    if (fleetIdQ && fleetIdQ !== user.fleetId) throw new ForbiddenException('Société hors périmètre');
    if (!user.fleetId) throw new ForbiddenException('Aucune société rattachée');
    return user.fleetId;
  }

  async get(user: AuthUser, fleetIdQ?: string): Promise<FleetSpeedAlertSettingsDto> {
    return this.toDto(this.resolveFleetId(user, fleetIdQ));
  }

  async set(user: AuthUser, body: SetSpeedAlertSettingsDto, fleetIdQ?: string): Promise<FleetSpeedAlertSettingsDto> {
    const fleetId = this.resolveFleetId(user, fleetIdQ);
    const fleet = await this.prisma.fleet.findUnique({ where: { id: fleetId }, select: { id: true, name: true } });
    if (!fleet) throw new NotFoundException('Société introuvable');

    await this.prisma.fleet.update({
      where: { id: fleetId },
      data: {
        speedAlertEnabled: body.enabled,
        speedAlertOverKmh: body.overKmh,
        speedAlertAbsoluteKmh: body.absoluteKmh,
        speedAlertUpdatedAt: new Date(),
        speedAlertUpdatedById: user.id,
      },
    });
    this.logger.log(
      `Alertes de vitesse réglées pour ${fleet.name} par ${user.email} : ${body.enabled ? 'actives' : 'coupées'}, ` +
        `dépassement ≥ ${body.overKmh} km/h, plafond ${body.absoluteKmh ?? 'aucun'}`,
    );
    return this.toDto(fleetId);
  }

  async setVehicle(
    user: AuthUser,
    vehicleId: string,
    body: SetVehicleSpeedAlertOverrideDto,
    fleetIdQ?: string,
  ): Promise<FleetSpeedAlertSettingsDto> {
    const fleetId = this.resolveFleetId(user, fleetIdQ);
    // 404 et non 403 : ne pas révéler qu'un véhicule existe hors périmètre.
    const vehicle = await this.prisma.vehicle.findFirst({ where: { id: vehicleId, fleetId }, select: { id: true, plate: true } });
    if (!vehicle) throw new NotFoundException('Véhicule introuvable');

    await this.prisma.vehicle.update({
      where: { id: vehicleId },
      data: { speedAlertEnabled: body.enabled, speedAlertOverKmh: body.overKmh },
    });
    // La société porte la date : une dérogation véhicule EST une modification du réglage.
    await this.prisma.fleet.update({
      where: { id: fleetId },
      data: { speedAlertUpdatedAt: new Date(), speedAlertUpdatedById: user.id },
    });
    const resume = body.enabled === null && body.overKmh === null
      ? 'dérogation retirée'
      : `${body.enabled === null ? 'activation héritée' : body.enabled ? 'activé' : 'coupé'}, seuil ${body.overKmh ?? 'hérité'}`;
    this.logger.log(`Alertes de vitesse de ${vehicle.plate} réglées par ${user.email} : ${resume}`);
    return this.toDto(fleetId);
  }

  /**
   * ══ ESSAI À BLANC — ce que le réglage PRODUIRAIT, sans rien produire ══════════════════
   *
   * ── LA LEÇON QUI L'A FAIT ÉCRIRE (2026-09-04) ───────────────────────────────────────
   *
   * Les alertes de vitesse ont été activées sur deux sociétés CLIENTES pour éprouver la
   * chaîne. Elle a parfaitement fonctionné : quatre alertes en deux minutes, et **trois
   * notifications sont arrivées sur les téléphones de clients** avant qu'on ne coupe. Les
   * alertes ont pu être retirées de l'écran ; les notifications déjà remises, non.
   *
   * Le défaut n'était pas dans le seuil : il était dans l'absence d'un moyen de l'essayer.
   * Un réglage qu'on ne peut vérifier qu'en le subissant n'est pas un réglage, c'est un pari.
   *
   * ── LA GARANTIE ─────────────────────────────────────────────────────────────────────
   *
   * ⚠️ AUCUNE ÉCRITURE. Cette méthode lit des analyses, applique la MÊME décision partagée que
   * le producteur (`decideAlerteExces`) et la MÊME phrase (`messageExcesTrajet`), puis rend le
   * résultat. Elle ne touche ni `alerts`, ni `notification_deliveries`, ni le réglage. C'est
   * ce qui la rend utilisable sur une société en production, un mardi après-midi.
   *
   * ⚠️ Le compte de destinataires est un MAJORANT : il ignore le regroupement anti-rafale de
   * quinze minutes et le plafond horaire, qui ne peuvent que le réduire. Devant un choix de
   * seuil, mieux vaut surestimer le bruit que le découvrir sur le téléphone d'un client.
   */
  async simuler(
    user: AuthUser,
    fleetIdQ: string | undefined,
    essai: { overKmh: number; absoluteKmh: number | null; heures: number },
  ): Promise<SpeedAlertSimulationDto> {
    const fleetId = this.resolveFleetId(user, fleetIdQ);
    const fleet = await this.prisma.fleet.findUnique({ where: { id: fleetId }, select: { id: true, name: true } });
    if (!fleet) throw new NotFoundException('Société introuvable');

    const heures = Math.min(Math.max(1, Math.round(essai.heures)), 720);
    const depuis = new Date(Date.now() - heures * 3_600_000);

    const analyses = await this.prisma.tripAnalysis.findMany({
      where: { fleetId, computedAt: { gte: depuis } },
      select: { tripId: true, vehicleId: true, maxSpeedKmh: true, detail: true },
      orderBy: { computedAt: 'desc' },
      take: MAX_ANALYSES_SIMULEES,
    });

    const vehicules = await this.prisma.vehicle.findMany({
      where: { id: { in: [...new Set(analyses.map((a) => a.vehicleId))] } },
      select: { id: true, plate: true, speedAlertEnabled: true, speedAlertOverKmh: true },
    });
    const parVehicule = new Map(vehicules.map((v) => [v.id, v]));
    const trajets = await this.prisma.trip.findMany({
      where: { id: { in: analyses.map((a) => a.tripId) } },
      select: { id: true, startedAt: true, endedAt: true },
    });
    const parTrajet = new Map(trajets.map((t) => [t.id, t]));

    /**
     * ⚠️ Le réglage ESSAYÉ est forcé à `enabled: true` : la question posée est « et si on
     * l'allumait ? ». Les dérogations de véhicule, elles, sont respectées — un véhicule
     * explicitement coupé doit rester muet dans la simulation comme dans la réalité.
     */
    const alertes: SpeedAlertSimulationDto['exemples'] = [];
    let critiques = 0;
    for (const a of analyses) {
      const veh = parVehicule.get(a.vehicleId);
      const trip = parTrajet.get(a.tripId);
      if (!trip) continue;
      const reglage = reglageEffectif(
        { speedAlertEnabled: true, speedAlertOverKmh: essai.overKmh, speedAlertAbsoluteKmh: essai.absoluteKmh },
        veh ? { speedAlertEnabled: veh.speedAlertEnabled, speedAlertOverKmh: veh.speedAlertOverKmh } : null,
      );
      if (!reglage.enabled) continue;

      const detail = (a.detail ?? {}) as { speeding?: SpeedingSegmentDto[]; track?: { lat: number; lng: number; t: string; speedKmh: number }[] };
      const decision = decideAlerteExces(
        { maxSpeedKmh: a.maxSpeedKmh, speeding: detail.speeding ?? [], track: detail.track },
        reglage,
      );
      if (!decision) continue;

      if (decision.severity === 'CRITICAL') critiques++;
      alertes.push({
        plate: veh?.plate ?? a.vehicleId,
        severity: decision.severity,
        message: messageExcesTrajet(decision, trip, reglage),
        tripId: a.tripId,
      });
    }

    return {
      fleetId: fleet.id,
      fleetName: fleet.name,
      essai: { overKmh: essai.overKmh, absoluteKmh: essai.absoluteKmh },
      heures,
      trajetsExamines: analyses.length,
      alertes: alertes.length,
      critiques,
      destinataires: await this.destinatairesProbables(fleetId, alertes.length),
      exemples: alertes.slice(0, MAX_EXEMPLES),
    };
  }

  /**
   * Qui serait réveillé, et combien de fois.
   *
   * Reproduit la règle de `resolveRecipients` : les membres actifs de la société dont le
   * réglage `receivesFleetAlerts` — ou, à défaut, le défaut de leur rôle — les désigne. Le
   * nombre d'appareils abonnés figure à côté : un destinataire sans appareil ne reçoit rien,
   * et c'est une information qui vaut autant que le compte lui-même.
   */
  private async destinatairesProbables(
    fleetId: string,
    alertes: number,
  ): Promise<SpeedAlertSimulationDto['destinataires']> {
    const membres = await this.prisma.user.findMany({
      where: { fleetId, isActive: true },
      select: {
        id: true, email: true, role: true,
        notificationPreference: { select: { receivesFleetAlerts: true, pushEnabled: true, mutedTypes: true } },
      },
    });
    const sortie: SpeedAlertSimulationDto['destinataires'] = [];
    for (const m of membres) {
      if (!resolveReceivesFleetAlerts(m.notificationPreference?.receivesFleetAlerts, m.role)) continue;
      const pref = m.notificationPreference;
      // Sans ligne de préférence, le défaut du système s'applique — et il laisse passer les
      // excès de vitesse. Une ligne existante est prise telle quelle.
      if (pref && (!pref.pushEnabled || (pref.mutedTypes ?? []).includes('OVERSPEED'))) continue;
      const appareils = await this.prisma.pushSubscription.count({ where: { userId: m.id } });
      sortie.push({ email: m.email, role: String(m.role), notifications: alertes, appareils });
    }
    return sortie;
  }

  private async toDto(fleetId: string): Promise<FleetSpeedAlertSettingsDto> {
    const fleet = await this.prisma.fleet.findUnique({
      where: { id: fleetId },
      select: {
        id: true, name: true,
        speedAlertEnabled: true, speedAlertOverKmh: true, speedAlertAbsoluteKmh: true,
        speedAlertUpdatedAt: true, speedAlertUpdatedById: true,
      },
    });
    if (!fleet) throw new NotFoundException('Société introuvable');

    const [vehicles, auteur] = await Promise.all([
      this.prisma.vehicle.findMany({
        where: { fleetId, OR: [{ speedAlertEnabled: { not: null } }, { speedAlertOverKmh: { not: null } }] },
        select: { id: true, plate: true, speedAlertEnabled: true, speedAlertOverKmh: true },
        orderBy: { plate: 'asc' },
      }),
      fleet.speedAlertUpdatedById
        ? this.prisma.user.findUnique({
            where: { id: fleet.speedAlertUpdatedById },
            select: { firstName: true, lastName: true, email: true },
          })
        : Promise.resolve(null),
    ]);

    return {
      fleetId: fleet.id,
      fleetName: fleet.name,
      enabled: fleet.speedAlertEnabled,
      overKmh: fleet.speedAlertOverKmh,
      absoluteKmh: fleet.speedAlertAbsoluteKmh,
      updatedAt: fleet.speedAlertUpdatedAt?.toISOString() ?? null,
      updatedBy: auteur ? ([auteur.firstName, auteur.lastName].filter(Boolean).join(' ') || auteur.email) : null,
      vehicles: vehicles.map((v) => ({
        vehicleId: v.id, plate: v.plate, enabled: v.speedAlertEnabled, overKmh: v.speedAlertOverKmh,
      })),
    };
  }
}
