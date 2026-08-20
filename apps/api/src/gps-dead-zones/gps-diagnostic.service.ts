import { Injectable, NotFoundException } from '@nestjs/common';
import type { GpsZoneDiagnosticDto, TraiterZoneDto } from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Lecture et qualification des diagnostics de zone morte.
 *
 * L'agent ECRIT ces lignes ; ce service ne fait que les rendre lisibles et enregistrer la
 * decision humaine. Il ne recalcule jamais un diagnostic : la logique vit dans le module pur
 * `gps-diagnostic.shared`, partage avec l'agent, et une seconde implementation ici finirait par
 * en diverger.
 */
@Injectable()
export class GpsDiagnosticService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Diagnostics, les non traites d'abord.
   *
   * Cet ordre n'est pas cosmetique : un ecran de supervision doit ouvrir sur ce qui attend une
   * decision, pas sur l'archive de ce qui est deja regle.
   */
  async liste(fleetId?: string, inclureTraites = false): Promise<GpsZoneDiagnosticDto[]> {
    const rows = await this.prisma.gpsZoneDiagnostic.findMany({
      where: {
        ...(fleetId ? { fleetId } : {}),
        ...(inclureTraites ? {} : { traiteAt: null }),
      },
      // `nulls: 'first'` n'est pas un detail : Postgres range les NULL en DERNIER sur un tri
      // ascendant. Sans lui, les diagnostics NON TRAITES — les seuls qui attendent une decision —
      // se retrouveraient sous l'archive de ce qui est deja regle.
      orderBy: [{ traiteAt: { sort: 'asc', nulls: 'first' } }, { episodes: 'desc' }],
      take: 200,
    });
    return this.enrichir(rows);
  }

  /** Marque un diagnostic traite (ou le rouvre), avec ce qui a ete constate. */
  async traiter(user: AuthUser, id: string, dto: TraiterZoneDto): Promise<GpsZoneDiagnosticDto> {
    const existe = await this.prisma.gpsZoneDiagnostic.findUnique({ where: { id } });
    if (!existe) throw new NotFoundException('Diagnostic introuvable.');
    const rouvre = dto.traite === false;
    await this.prisma.gpsZoneDiagnostic.update({
      where: { id },
      data: {
        traiteAt: rouvre ? null : new Date(),
        traiteParUserId: rouvre ? null : user.id,
        // La note n'est ecrite que si l'appelant en fournit une. Une reouverture n'en envoie pas,
        // et ecraser par `null` detruirait sans retour ce qu'un humain avait constate sur place.
        ...(dto.note !== undefined ? { note: dto.note.trim().slice(0, 2000) || null } : {}),
      },
    });
    const row = await this.prisma.gpsZoneDiagnostic.findUnique({ where: { id } });
    return (await this.enrichir([row!]))[0];
  }

  /** Resout les noms (societe, relecteur) en une passe, jamais dans une boucle. */
  private async enrichir(
    rows: Array<{
      id: string; createdAt: Date; updatedAt: Date; lat: number; lng: number;
      placeLabel: string | null; fleetId: string; vehicules: string[]; episodes: number;
      etalementM: number; constat: string; recommandation: string;
      traiteAt: Date | null; traiteParUserId: string | null; note: string | null;
    }>,
  ): Promise<GpsZoneDiagnosticDto[]> {
    if (rows.length === 0) return [];
    const fleetIds = [...new Set(rows.map((r) => r.fleetId))];
    const userIds = [...new Set(rows.map((r) => r.traiteParUserId).filter((x): x is string => !!x))];
    const [fleets, users] = await Promise.all([
      this.prisma.fleet.findMany({ where: { id: { in: fleetIds } }, select: { id: true, name: true } }),
      userIds.length
        ? this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } })
        : Promise.resolve([]),
    ]);
    const nomFlotte = new Map(fleets.map((f) => [f.id, f.name]));
    const email = new Map(users.map((u) => [u.id, u.email]));
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      lat: r.lat,
      lng: r.lng,
      placeLabel: r.placeLabel,
      fleetId: r.fleetId,
      fleetName: nomFlotte.get(r.fleetId) ?? null,
      vehicules: r.vehicules,
      episodes: r.episodes,
      etalementM: r.etalementM,
      constat: r.constat,
      recommandation: r.recommandation,
      traiteAt: r.traiteAt?.toISOString() ?? null,
      traiteParEmail: r.traiteParUserId ? (email.get(r.traiteParUserId) ?? null) : null,
      note: r.note,
    }));
  }
}
