import { VehicleEventType } from '@prisma/client';
import {
  etatIndisponibilite,
  IMMOBILIZING_STATUSES,
  immobilisationAgendaEnCours,
  type EtatIndisponibilite,
  type ImmobilisationAgendaDto,
} from '@vizyo/tracky-shared';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Émis quand une maintenance ou un incident de l'agenda est créé, modifié ou supprimé : l'état de
 * disponibilité du véhicule peut avoir changé. `VehiclesService` y vide le cache de l'instantané
 * (15 s) — sans quoi la carte ouverte juste après l'agenda montrerait encore l'ancien état.
 */
export const DISPONIBILITE_MODIFIEE_EVENT = 'vehicule.disponibilite.modifiee';
export interface DisponibiliteModifieeEvent {
  fleetId: string;
  vehicleId: string;
}

/**
 * Les immobilisations d'AGENDA en cours (maintenance ou incident « Immobilise le véhicule »),
 * EN LOT : une requête pour toute une liste de véhicules, jamais une par véhicule.
 *
 * Une fonction et non un service, comme le dépôt (`depot.module.ts`) : l'instantané, les horaires
 * et l'alerte « sortie hors horaire » en ont besoin, et aucun d'eux ne doit importer
 * `AgendaModule` (cycles, et un graphe d'injection qui grossit pour une requête).
 *
 * La RÈGLE n'est pas ici : elle est dans `immobilisationAgendaEnCours` (module partagé), la même
 * que celle de la réservation et du panneau du jour de l'agenda. Cette requête ne fait que
 * pré-filtrer en SQL ce que la règle tranchera — index `[vehicleId, startAt DESC]`.
 */
export async function immobilisationsAgendaEnCours(
  prisma: Pick<PrismaService, 'vehicleEvent'>,
  vehicleIds: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, ImmobilisationAgendaDto>> {
  const out = new Map<string, ImmobilisationAgendaDto>();
  if (vehicleIds.length === 0) return out;
  const rows = await prisma.vehicleEvent.findMany({
    where: {
      vehicleId: { in: [...vehicleIds] },
      type: { in: [VehicleEventType.MAINTENANCE, VehicleEventType.INCIDENT] },
      blocksVehicle: true,
      status: { in: IMMOBILIZING_STATUSES },
      startAt: { lte: now },
      // Sans date de fin, une maintenance couvre 24 h et un incident court jusqu'à sa clôture
      // (`effectiveBlockingEndMs`) : on les garde ici, la règle partagée tranche.
      OR: [{ endAt: null }, { endAt: { gt: now } }],
    },
    select: { id: true, vehicleId: true, type: true, status: true, blocksVehicle: true, title: true, startAt: true, endAt: true },
  });
  const parVehicule = new Map<string, typeof rows>();
  for (const r of rows) {
    const liste = parVehicule.get(r.vehicleId);
    if (liste) liste.push(r);
    else parVehicule.set(r.vehicleId, [r]);
  }
  for (const [vehicleId, evenements] of parVehicule) {
    const im = immobilisationAgendaEnCours(evenements, now.getTime());
    if (im) out.set(vehicleId, im);
  }
  return out;
}

/**
 * L'état d'indisponibilité d'UN véhicule, lu en base : le motif déclaré sur la fiche, puis
 * l'immobilisation d'agenda à `now`. `null` = disponible. Pour les chemins qui n'ont pas déjà la
 * ligne du véhicule en main (activation d'un planning, sortie hors horaire).
 */
export async function etatIndisponibiliteVehicule(
  prisma: Pick<PrismaService, 'vehicle' | 'vehicleEvent'>,
  vehicleId: string,
  now: Date = new Date(),
): Promise<EtatIndisponibilite | null> {
  const [vehicule, immobilisations] = await Promise.all([
    prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { outOfServiceReason: true } }),
    immobilisationsAgendaEnCours(prisma, [vehicleId], now),
  ]);
  return etatIndisponibilite({
    outOfServiceReason: vehicule?.outOfServiceReason ?? null,
    immobilisationAgenda: immobilisations.get(vehicleId) ?? null,
  });
}
