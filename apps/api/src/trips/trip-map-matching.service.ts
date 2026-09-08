import { Injectable, Logger } from '@nestjs/common';
import type { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MapMatchingService } from './map-matching.service';
import { TripsService } from './trips.service';

/** Le même périmètre que `TripsService.findOne` : c'est lui qui décide qui voit le trajet. */
export interface DemandeurRecalage {
  userId: string;
  role: UserRole;
  fleetId: string | null;
  accessibleVehicleIds?: string[] | 'ALL';
}

export interface ResultatRecalage {
  /** Le tracé recalé, tel que stocké (JSON de `{lat, lng}[]`), ou null s'il n'a pas pu l'être. */
  polylineMatched: string | null;
  /** Un recalage de CE trajet est déjà en cours : rien de neuf, revenir plus tard. */
  enCours: boolean;
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * RECALER UN TRAJET SUR LES ROUTES, À LA DEMANDE
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Le recalage se fait à la clôture du trajet, en tâche de fond (`TripsService`). Il a échoué
 * pendant des mois pour tout trajet de plus de dix points (cf. `map-matching.service.ts`) :
 * 89 % des trajets en base n'ont pas de tracé recalé, et le rejeu y coupe les virages.
 *
 * Plutôt qu'un rattrapage de masse contre un service public gratuit, on recale QUAND ON
 * REGARDE : le rejeu d'un trajet sans tracé recalé le demande, une fois, et le résultat est
 * rangé pour tous les rejeux suivants. Un trajet jamais rejoué ne coûte rien à personne.
 *
 * ⚠️ Le périmètre est celui de `findOne` — un trajet qu'on n'a pas le droit de voir répond
 * 404, jamais 403, et n'est jamais recalé.
 */
@Injectable()
export class TripMapMatchingService {
  private readonly logger = new Logger(TripMapMatchingService.name);
  /** Trajets en cours de recalage : deux rejeux ouverts en même temps ne lancent qu'un passage. */
  private readonly enCours = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly trips: TripsService,
    private readonly mapMatching: MapMatchingService,
  ) {}

  async recaler(tripId: string, demandeur: DemandeurRecalage): Promise<ResultatRecalage> {
    const trip = await this.trips.findOne(tripId, demandeur);
    if (trip.polylineMatched) return { polylineMatched: trip.polylineMatched, enCours: false };
    if (this.enCours.has(tripId)) return { polylineMatched: null, enCours: true };

    const brut = TripMapMatchingService.lirePolyligne(trip.polyline);
    if (brut.length < 2) return { polylineMatched: null, enCours: false };

    this.enCours.add(tripId);
    try {
      const recale = await this.mapMatching.match(brut);
      if (!recale || recale.length < 2) {
        this.logger.warn(`Recalage à la demande refusé pour le trajet ${tripId} (${brut.length} points) : tracé brut conservé.`);
        return { polylineMatched: null, enCours: false };
      }
      const json = JSON.stringify(recale);
      await this.prisma.trip.update({ where: { id: tripId }, data: { polylineMatched: json } });
      this.logger.log(`Recalage à la demande : trajet ${tripId}, ${brut.length} -> ${recale.length} points.`);
      return { polylineMatched: json, enCours: false };
    } finally {
      this.enCours.delete(tripId);
    }
  }

  private static lirePolyligne(json: string | null | undefined): Array<{ lat: number; lng: number }> {
    if (!json) return [];
    try {
      const brut: unknown = JSON.parse(json);
      if (!Array.isArray(brut)) return [];
      return brut.filter(
        (p): p is { lat: number; lng: number } =>
          !!p && typeof p === 'object' && Number.isFinite((p as { lat: unknown }).lat) && Number.isFinite((p as { lng: unknown }).lng),
      );
    } catch {
      return [];
    }
  }
}
