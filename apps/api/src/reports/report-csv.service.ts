import { Injectable } from '@nestjs/common';
import Papa from 'papaparse';
import { PrismaService } from '../prisma/prisma.service';
import { formatFleetDateTime, parisDayKey } from '../common/utils/datetime';
import { VEHICLE_GROUP_SELECT, vehicleGroupOf } from '../common/vehicle-group';
import { resolveReportVehicleScope } from '../common/report-vehicle-scope';
import type { PorteeConducteur } from '../common/driver-scope';
import { libelleGraviteAlerte, libelleTypeAlerte } from '@vizyo/tracky-shared';

/**
 * V1.5 (Sprint L) — Export CSV brut.
 *
 * Format Excel-friendly : BOM UTF-8 + separateur ';' (les Excel FR/EU utilisent
 * ';' par defaut, ',' rentre en conflit avec la virgule decimale).
 *
 * 🔒 Sprint 5 — chaque export est borne au PERIMETRE UTILISATEUR : un VIEWER /
 * FLEET_MANAGER scope groupe ou vehicules ne peut exporter QUE ses vehicules
 * accessibles (pas toute la flotte). `accessibleVehicleIds === 'ALL'` (admins)
 * => comportement historique (toute la flotte). Le filtre `fleetId` est conserve
 * en defense en profondeur dans tous les cas.
 */

const BOM = '﻿';

@Injectable()
export class ReportCsvService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retourne la liste des vehicleIds qui bornent un export, ou null quand
   * l'appelant a acces a tout (=> pas de borne vehicule, seulement le fleetId).
   */
  private scopedVehicleIds(accessibleVehicleIds: string[] | 'ALL'): string[] | null {
    const scope = resolveReportVehicleScope(accessibleVehicleIds);
    return scope === 'ALL' ? null : scope;
  }

  private wrap(
    rows: Record<string, string | number | null | undefined>[],
    filename: string,
    truncated = false,
    fields: string[] = [],
  ): {
    filename: string;
    contentType: string;
    body: string;
  } {
    // ⚠️ Colonnes EXPLICITES : sans elles, un export vide (aucune alerte sur la période)
    //    produisait un fichier de trois octets — le BOM seul, pas même l'en-tête — que
    //    l'utilisateur prenait pour un téléchargement raté.
    const csv = fields.length > 0
      ? Papa.unparse({ fields, data: rows.map((r) => fields.map((f) => r[f] ?? '')) }, { delimiter: ';', header: true })
      : Papa.unparse(rows, { delimiter: ';', header: true });
    // #23 — troncature VISIBLE : si l'export a atteint son cap memoire (tout est
    // bufferise en RAM), on suffixe le nom `-PARTIEL` pour que l'utilisateur sache
    // qu'il manque des lignes (avant : troncature silencieuse) et resserre la periode.
    const finalName = truncated ? filename.replace(/\.csv$/, '-PARTIEL.csv') : filename;
    return {
      filename: finalName,
      contentType: 'text/csv; charset=utf-8',
      body: BOM + csv,
    };
  }

  async positions(fleetId: string, from: Date, to: Date, accessibleVehicleIds: string[] | 'ALL' = 'ALL') {
    const ids = this.scopedVehicleIds(accessibleVehicleIds);
    const positions = await this.prisma.position.findMany({
      where: {
        timestamp: { gte: from, lt: to },
        // Borne flotte (defense en profondeur) + perimetre user via le vehicule
        // du tracker. `positions`/`commands` n'ont pas de vehicleId direct.
        // Mode vie privée (RGPD) : on exclut les véhicules actuellement en mode privé.
        tracker: { vehicle: ids ? { fleetId, id: { in: ids }, privacyModeEnabled: false } : { fleetId, privacyModeEnabled: false } },
      },
      orderBy: { timestamp: 'asc' },
      include: { tracker: { include: { vehicle: { select: { plate: true } } } } },
      take: 100_000,
    });
    const rows = positions.map((p) => ({
      timestamp: p.timestamp.toISOString(),
      plate: p.tracker.vehicle?.plate ?? '',
      lat: p.lat,
      lng: p.lng,
      speed_kmh: p.speedKmh,
      heading: p.heading,
      ignition: p.ignition === null ? '' : p.ignition ? 'on' : 'off',
      valid: p.valid ? 'yes' : 'no',
      timestamp_local: formatFleetDateTime(p.timestamp),
    }));
    // Colonnes déclarées : sans elles, une période SANS position produisait un fichier de
    // 3 octets (le seul marqueur d'encodage), sans même une ligne d'en-tête — illisible.
    return this.wrap(rows, `tracky-positions-${this.dateSuffix(from, to)}.csv`, rows.length >= 100_000, [
      'timestamp', 'timestamp_local', 'plate', 'lat', 'lng', 'speed_kmh', 'heading', 'ignition', 'valid',
    ]);
  }

  /**
   * ── LE NOM DU FICHIER DIT LE FILTRE, PARCE QUE LE CSV N'A PAS D'AUTRE ENDROIT OÙ LE DIRE ──
   *
   * Le PDF écrit le conducteur en gras sous le nom de la société, l'Excel le met dans le titre
   * de sa feuille et dans une ligne « Filtre conducteur ». Le CSV, lui, n'a que son nom : une
   * ligne de prose au-dessus des colonnes serait lue comme l'en-tête par Excel et par tout
   * analyseur.
   *
   * ⚠️ SANS CETTE MARQUE, DEUX EXPORTS DE LA MÊME PÉRIODE PORTENT LE MÊME NOM. Et sous
   * « none » ils sont indiscernables : chez « mh cars », 1 905 trajets sur 1 956 n'ont aucun
   * conducteur, donc le fichier filtré a `driver_id` et `driver_name` vides sur TOUTES ses
   * lignes — exactement comme la quasi-totalité de l'export complet. Le navigateur suffixe
   * « (1) », le gestionnaire envoie le second par courriel, et le destinataire lit le mois
   * entier là où il manque 51 trajets que rien ne signale.
   *
   * ── TROIS CHOIX, ET POURQUOI CEUX-LÀ ──────────────────────────────────────────────────
   *
   *  1. LE NOM PLUTÔT QU'UNE COLONNE `filtre_conducteur`. Les 23 colonnes déclarées sont un
   *     contrat (cf. `wrap`) : en ajouter une changerait la forme de TOUS les exports, filtrés
   *     ou non, pour marquer une minorité. Sans filtre, le nom reste celui d'avant au caractère
   *     près — c'est ce que fige le test.
   *  2. L'IDENTIFIANT TRONQUÉ PLUTÔT QUE LE NOM DE LA PERSONNE. Sous un conducteur nommé, la
   *     colonne `driver_name` porte déjà la trace sur chaque ligne : le nom du fichier n'a qu'à
   *     dire QU'IL est filtré. Huit caractères y suffisent, sans faire voyager un nom propre
   *     dans un intitulé de pièce jointe, et sans la lecture en base qu'il faudrait pour lui.
   *  3. LE SUFFIXE APRÈS LES DATES, à côté de `-PARTIEL`. Même canal et même idiome que la
   *     troncature (« ce fichier ne contient pas ce que son nom laisserait croire »), et les
   *     deux exports restent voisins dans le dossier de téléchargement, où on les compare.
   */
  private marqueConducteur(driverScope: PorteeConducteur): string {
    if (driverScope === undefined) return '';
    // La portée est déjà canonique (minuscules) : deux exports du même conducteur portent donc
    // le même nom, quelle que soit la casse écrite dans l'URL (cf. `resolveDriverScope`).
    return driverScope === null ? '-sans-conducteur' : `-conducteur-${driverScope.slice(0, 8)}`;
  }

  /**
   * ── LE SEUL EXPORT CSV QUI PEUT SUIVRE UN CONDUCTEUR (F13) ─────────────────────────────
   *
   * Un trajet PORTE son conducteur (`Trip.driverId`) : c'est ce qui rend ce filtre possible
   * ici, et impossible pour les positions, les alertes et les commandes — la route les refuse
   * explicitement plutôt que de leur laisser rendre une autre population (cf.
   * `reports.controller`, `csvDownload`).
   *
   * @param driverScope `undefined` = aucun filtre, `null` = trajets SANS conducteur (le
   *   mot-clé `none`), sinon l'identifiant demandé. Résolu par `resolveDriverScope` en amont :
   *   ce service ne revalide rien, il POSE ce qu'on lui donne.
   *
   *   ⚠️ Le test est `!== undefined`, jamais une vérité simple. Écrire `where.driverId = null`
   *   quand aucun filtre n'est demandé ne rendrait que les trajets orphelins — l'inverse de
   *   « pas de filtre », et un CSV silencieusement amputé de presque tout.
   *
   *   La portée sert DEUX fois : elle borne le `where`, et elle marque le NOM du fichier
   *   (cf. `marqueConducteur`) — un fichier filtré et muet est le piège que ce lot répare,
   *   déplacé dans un document qui survivra à l'écran qui l'a produit.
   */
  async trips(
    fleetId: string,
    from: Date,
    to: Date,
    accessibleVehicleIds: string[] | 'ALL' = 'ALL',
    driverScope: PorteeConducteur = undefined,
  ) {
    const ids = this.scopedVehicleIds(accessibleVehicleIds);
    const trips = await this.prisma.trip.findMany({
      // Mode vie privée (RGPD) : exclut les trajets d'un véhicule actuellement en mode privé.
      where: {
        fleetId,
        startedAt: { gte: from, lt: to },
        ...(ids ? { vehicleId: { in: ids } } : {}),
        ...(driverScope === undefined ? {} : { driverId: driverScope }),
        NOT: { vehicle: { privacyModeEnabled: true } },
      },
      orderBy: { startedAt: 'desc' },
      include: {
        vehicle: { select: { plate: true, ...VEHICLE_GROUP_SELECT } },
        notesUpdatedBy: { select: { firstName: true, lastName: true, email: true } },
        driver: { select: { id: true, firstName: true, lastName: true } },
      },
      take: 50_000,
    });
    const rows = trips.map((t) => ({
      trip_id: t.id,
      plate: t.vehicle?.plate ?? '',
      group: vehicleGroupOf(t.vehicle)?.name ?? '',
      // Heure de Paris lisible pour Excel FR, à côté de l'ISO (UTC) qui reste la référence.
      started_at_local: formatFleetDateTime(t.startedAt),
      ended_at_local: t.endedAt ? formatFleetDateTime(t.endedAt) : '',
      started_at: t.startedAt.toISOString(),
      ended_at: t.endedAt?.toISOString() ?? '',
      duration_seconds: t.durationSeconds,
      distance_km: t.distanceKm.toFixed(2),
      max_speed_kmh: t.maxSpeed.toFixed(1),
      avg_speed_kmh: t.avgSpeed.toFixed(1),
      position_count: t.positionCount,
      start_lat: t.startLat,
      start_lng: t.startLng,
      end_lat: t.endLat ?? '',
      end_lng: t.endLng ?? '',
      driver_id: t.driverId ?? '',
      driver_name: t.driver ? `${t.driver.firstName} ${t.driver.lastName}` : '',
      driver_source: t.driverSource ?? '',
      notes: t.notes ?? '',
      notes_author: this.formatAuthor(t.notesUpdatedBy),
      notes_updated_at: t.notesUpdatedAt?.toISOString() ?? '',
      notes_updated_at_local: t.notesUpdatedAt ? formatFleetDateTime(t.notesUpdatedAt) : '',
    }));
    // ⚠️ La marque est posée ICI, pas dans `wrap` : `wrap` sert les quatre types de CSV et
    // trois d'entre eux ne peuvent PAS porter de conducteur (la route les refuse sous filtre).
    // Lui passer un nom déjà marqué laisse sa seule règle — le `-PARTIEL` de la troncature —
    // intacte, et les deux suffixes se composent dans l'ordre où ils se lisent.
    return this.wrap(rows, `tracky-trips-${this.dateSuffix(from, to)}${this.marqueConducteur(driverScope)}.csv`, rows.length >= 50_000, [
      'trip_id', 'plate', 'group', 'started_at_local', 'ended_at_local', 'started_at', 'ended_at',
      'duration_seconds', 'distance_km', 'max_speed_kmh', 'avg_speed_kmh', 'position_count',
      'start_lat', 'start_lng', 'end_lat', 'end_lng', 'driver_id', 'driver_name', 'driver_source',
      'notes', 'notes_author', 'notes_updated_at', 'notes_updated_at_local',
    ]);
  }

  /** Formate l'auteur de note pour l'export : "Prenom Nom" sinon email sinon vide. */
  private formatAuthor(
    author: { firstName: string | null; lastName: string | null; email: string } | null,
  ): string {
    if (!author) return '';
    const fn = author.firstName ?? '';
    const ln = author.lastName ?? '';
    const full = `${fn} ${ln}`.trim();
    return full || author.email;
  }

  async alerts(fleetId: string, from: Date, to: Date, accessibleVehicleIds: string[] | 'ALL' = 'ALL') {
    const ids = this.scopedVehicleIds(accessibleVehicleIds);
    const alerts = await this.prisma.alert.findMany({
      // Quand un perimetre est actif, les alertes sans vehicleId (tracker isole)
      // sont exclues par definition du sous-ensemble (cf. reports-stats).
      // Mode vie privée (RGPD) : exclut les alertes d'un véhicule en mode privé (garde les alertes flotte sans véhicule).
      where: { fleetId, createdAt: { gte: from, lt: to }, ...(ids ? { vehicleId: { in: ids } } : {}), NOT: { vehicle: { privacyModeEnabled: true } } },
      orderBy: { createdAt: 'desc' },
      include: { vehicle: { select: { plate: true, ...VEHICLE_GROUP_SELECT } } },
      take: 50_000,
    });
    const rows = alerts.map((a) => ({
      created_at_local: formatFleetDateTime(a.createdAt),
      created_at: a.createdAt.toISOString(),
      plate: a.vehicle?.plate ?? '',
      group: vehicleGroupOf(a.vehicle)?.name ?? '',
      type: a.type,
      /**
       * ⚠️ Le CODE reste la première colonne : c'est lui qui se filtre et se trie sans
       * ambiguïté. Le LIBELLÉ vient à côté, tiré de la MÊME table que le PDF et l'écran.
       * Jusqu'ici seul le PDF traduisait : un client qui ouvrait les deux lisait
       * « Excès de vitesse » d'un côté, « OVERSPEED » de l'autre, et pouvait légitimement
       * se demander s'il s'agissait de la même chose.
       */
      type_label: libelleTypeAlerte(a.type),
      severity: a.severity,
      severity_label: libelleGraviteAlerte(a.severity),
      title: a.title,
      message: a.message ?? '',
      acknowledged_at: a.acknowledgedAt?.toISOString() ?? '',
      // Heure de Paris lisible pour Excel FR, comme la date de création juste au-dessus.
      acknowledged_at_local: a.acknowledgedAt ? formatFleetDateTime(a.acknowledgedAt) : '',
      latitude: a.latitude ?? '',
      longitude: a.longitude ?? '',
    }));
    return this.wrap(rows, `tracky-alerts-${this.dateSuffix(from, to)}.csv`, rows.length >= 50_000, [
      'created_at_local', 'created_at', 'plate', 'group', 'type', 'type_label', 'severity',
      'severity_label', 'title', 'message', 'acknowledged_at', 'acknowledged_at_local',
      'latitude', 'longitude',
    ]);
  }

  async commands(fleetId: string, from: Date, to: Date, accessibleVehicleIds: string[] | 'ALL' = 'ALL') {
    const ids = this.scopedVehicleIds(accessibleVehicleIds);
    const commands = await this.prisma.engineControlCommand.findMany({
      where: {
        createdAt: { gte: from, lt: to },
        tracker: { vehicle: ids ? { fleetId, id: { in: ids } } : { fleetId } },
      },
      orderBy: { createdAt: 'desc' },
      include: { tracker: { include: { vehicle: { select: { plate: true } } } } },
      take: 20_000,
    });
    const rows = commands.map((c) => ({
      created_at: c.createdAt.toISOString(),
      plate: c.tracker.vehicle?.plate ?? '',
      action: c.action,
      status: c.status,
      source: c.source,
      sent_at: c.sentAt?.toISOString() ?? '',
      sent_at_local: c.sentAt ? formatFleetDateTime(c.sentAt) : '',
      acked_at: c.ackedAt?.toISOString() ?? '',
      acked_at_local: c.ackedAt ? formatFleetDateTime(c.ackedAt) : '',
      reason: c.reason ?? '',
      last_error: c.lastError ?? '',
      created_at_local: formatFleetDateTime(c.createdAt),
    }));
    // Idem : l'en-tête doit exister même sans une seule commande sur la période.
    return this.wrap(rows, `tracky-commands-${this.dateSuffix(from, to)}.csv`, rows.length >= 20_000, [
      'created_at', 'created_at_local', 'plate', 'action', 'status', 'source',
      'sent_at', 'sent_at_local', 'acked_at', 'acked_at_local', 'reason', 'last_error',
    ]);
  }

  /** Jours civils de Paris, fin INCLUSE (la borne `to` de l'API est le lendemain minuit). */
  private dateSuffix(from: Date, to: Date): string {
    return `${parisDayKey(from)}_${parisDayKey(new Date(to.getTime() - 1))}`;
  }
}
