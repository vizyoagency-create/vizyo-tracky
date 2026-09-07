import type { Prisma, PrismaClient } from '@prisma/client';
import { FLEET_TIME_ZONE, parisDayKey, parisDayStart } from '../../common/utils/datetime';
import { JOURNAL_DEMO } from '../journal-demo';
import { identiteDemo, imeiDemo, plaqueDemo } from './pseudonymes';
import {
  Assainisseur,
  Correspondances,
  abonnementDemo,
  planningRapportDemo,
  transformerAffectation,
  transformerAlerte,
  transformerAnalyse,
  transformerArretCarburant,
  transformerBoitier,
  transformerConducteur,
  transformerFlotte,
  transformerGeofence,
  transformerGeofenceVehicule,
  transformerGroupe,
  transformerLieu,
  transformerPlanning,
  transformerPlanningTravail,
  transformerPlein,
  transformerPosition,
  transformerPrix,
  transformerProfilSurveillance,
  transformerStation,
  transformerTrajet,
  transformerTrameRejeu,
  transformerVehicule,
  type Contexte,
  type TrameSemaine,
} from './transformations';

export interface OptionsImport {
  /** La production, par un rôle SELECT SEULEMENT. */
  source: PrismaClient;
  /** La base de démonstration, marquée comme telle par le seed. */
  cible: PrismaClient;
  urlSource: string;
  urlCible: string;
  sel: string;
  idsFlottesSource: string[];
  nomFlotte: string;
  joursPositions: number;
  moisTrajets: number;
  maintenant?: Date;
  journal?: (message: string) => void;
}

export interface BilanImport {
  flotte: string;
  societesSource: number;
  vehicules: number;
  boitiers: number;
  conducteurs: number;
  groupes: number;
  geofences: number;
  lieux: number;
  stations: number;
  trajets: number;
  analyses: number;
  alertes: number;
  positions: number;
  tramesRejeu: number;
  dureeMs: number;
  fenetre: {
    trajetsDepuis: string;
    positionsDepuis: string;
    jusqua: string;
    semaineRejeuDepuis: string;
  };
}

/** Taille des lots d'écriture (`createMany`) et de lecture des positions. */
const LOT = 5_000;
const PAGE_POSITIONS = 20_000;

/**
 * ═══ GARDE-FOUS — AVANT de lire quoi que ce soit ═══════════════════════════════════════════
 *
 * 1. Source et cible ne sont pas la même base.
 * 2. Le rôle de lecture NE PEUT PAS écrire dans la production : c'est Postgres qui le dit
 *    (`has_table_privilege`), pas ce script. Un superutilisateur passe ce test à `true` et
 *    est donc REFUSÉ — c'est voulu : l'import exige le rôle `tracky_ro`, rien d'autre.
 * 3. La cible porte le marqueur « base de démonstration » posé par le seed. Sans lui, on
 *    n'écrit pas : pointer DATABASE_URL sur la production par mégarde doit échouer ici,
 *    avant la première suppression.
 */
export async function verifierGardeFous(
  source: PrismaClient,
  cible: PrismaClient,
  urls: { source: string; cible: string },
): Promise<void> {
  if (normaliserUrl(urls.source) === normaliserUrl(urls.cible)) {
    throw new Error('Source et cible désignent la même base : refus.');
  }
  const droits = await source.$queryRaw<Array<{ insert: boolean; update: boolean; delete: boolean }>>`
    SELECT has_table_privilege(current_user, 'positions', 'INSERT') AS "insert",
           has_table_privilege(current_user, 'fleets', 'UPDATE')    AS "update",
           has_table_privilege(current_user, 'positions', 'DELETE') AS "delete"`;
  const d = droits[0];
  if (!d || d.insert || d.update || d.delete) {
    throw new Error(
      "Le rôle de lecture de la production PEUT écrire (INSERT/UPDATE/DELETE) : refus. L'import exige un rôle SELECT seulement (tracky_ro), et c'est Postgres qui doit le garantir, pas ce script.",
    );
  }
  const marqueur = await cible.systemActivityLog.findFirst({
    where: { category: JOURNAL_DEMO.categorie, action: JOURNAL_DEMO.marqueur },
    select: { id: true },
  });
  if (!marqueur) {
    throw new Error(
      "La base cible n'est pas marquée « base de démonstration » (aucune ligne DEMO / base_de_demonstration dans system_activity_logs) : refus d'écrire. Lancer d'abord le seed de démo sur la base cible.",
    );
  }
}

function normaliserUrl(url: string): string {
  return url.trim().replace(/\?.*$/, '').toLowerCase();
}

/** Minuit local, `n` jours civils avant un minuit local donné — sans se laisser piéger par le changement d'heure. */
function joursAvant(minuitLocal: Date, n: number): Date {
  return parisDayStart(parisDayKey(new Date(minuitLocal.getTime() - n * 86_400_000 + 12 * 3_600_000)));
}

function moisAvant(minuitLocal: Date, n: number): Date {
  const cle = parisDayKey(new Date(minuitLocal.getTime() + 12 * 3_600_000));
  const [a, m, j] = cle.split('-').map(Number) as [number, number, number];
  const d = new Date(Date.UTC(a, m - 1 - n, j, 12));
  return parisDayStart(d.toISOString().slice(0, 10));
}

function unique<T>(valeurs: Array<T | null | undefined>): T[] {
  return Array.from(new Set(valeurs.filter((v): v is T => v != null)));
}

function lots<T>(valeurs: readonly T[], taille = LOT): T[][] {
  const resultat: T[][] = [];
  for (let i = 0; i < valeurs.length; i += taille) resultat.push(valeurs.slice(i, i + taille));
  return resultat;
}

async function parLotsDIds<T>(ids: string[], lire: (lot: string[]) => Promise<T[]>): Promise<T[]> {
  const resultat: T[] = [];
  for (const lot of lots(ids, 1_000)) resultat.push(...(await lire(lot)));
  return resultat;
}

/**
 * ═══ L'IMPORT ═══════════════════════════════════════════════════════════════════════════════
 *
 * Lit UNE ou plusieurs sociétés de la production (fusionnées en une société de démo),
 * pseudonymise, et écrit dans la base de démo en UNE transaction : un échec à mi-chemin ne
 * laisse pas la démo à moitié vide — elle garde l'état précédent.
 *
 * Deux régimes selon les tables :
 *   · IDENTITÉ (société, véhicules, boîtiers, conducteurs, groupes, zones, lieux, plannings) :
 *     UPSERT par identifiant déterministe, puis suppression de ce qui n'est plus dans la source.
 *     Les droits d'accès, liens et comptes posés côté démo survivent ainsi au rafraîchissement.
 *   · VOLUME (trajets, analyses, alertes, positions, trames de rejeu) : vidé puis recréé.
 *
 * Fenêtres, en jours civils Europe/Paris : l'historique s'arrête HIER ; aujourd'hui appartient
 * au rejeu (la semaine de trames = les 7 jours pleins qui précèdent aujourd'hui).
 */
export async function importerDemo(o: OptionsImport): Promise<BilanImport> {
  const debut = Date.now();
  const log = o.journal ?? (() => undefined);
  const maintenant = o.maintenant ?? new Date();

  if (o.sel.length < 16) throw new Error('DEMO_SALT doit faire au moins 16 caractères.');
  if (o.idsFlottesSource.length === 0) throw new Error('DEMO_SOURCE_FLEET_IDS est vide : aucune société source.');
  if (!(o.joursPositions > 0) || !(o.moisTrajets > 0)) throw new Error('Fenêtres invalides (jours de positions, mois de trajets).');

  await verifierGardeFous(o.source, o.cible, { source: o.urlSource, cible: o.urlCible });

  const aujourdhui = parisDayStart(parisDayKey(maintenant));
  const depuisRejeu = joursAvant(aujourdhui, 7);
  const depuisPositions = joursAvant(aujourdhui, o.joursPositions);
  const depuisTrajets = moisAvant(aujourdhui, o.moisTrajets);
  log(`Fenêtres : trajets ≥ ${depuisTrajets.toISOString()}, positions ≥ ${depuisPositions.toISOString()}, rejeu ≥ ${depuisRejeu.toISOString()}, tout < ${aujourdhui.toISOString()}`);

  try {
    // ── 1. Lecture de la source ──────────────────────────────────────────────────────────
    const src = o.source;
    const flottes = await src.fleet.findMany({ where: { id: { in: o.idsFlottesSource } }, orderBy: { createdAt: 'asc' } });
    const manquantes = o.idsFlottesSource.filter((id) => !flottes.some((f) => f.id === id));
    if (manquantes.length > 0) throw new Error(`Sociétés source introuvables : ${manquantes.join(', ')}`);
    const flotteIds = flottes.map((f) => f.id);

    const vehicules = await src.vehicle.findMany({ where: { fleetId: { in: flotteIds } }, orderBy: { createdAt: 'asc' } });
    const vehiculeIds = vehicules.map((v) => v.id);
    const boitiers = await src.tracker.findMany({ where: { vehicleId: { in: vehiculeIds } } });
    const conducteurs = await src.driver.findMany({ where: { fleetId: { in: flotteIds } }, orderBy: { createdAt: 'asc' } });
    const groupes = await src.vehicleGroup.findMany({ where: { fleetId: { in: flotteIds } }, orderBy: { createdAt: 'asc' } });
    const affectations = await src.vehicleGroupAssignment.findMany({ where: { groupId: { in: groupes.map((g) => g.id) } } });
    const geofences = await src.geofence.findMany({ where: { fleetId: { in: flotteIds } }, orderBy: { createdAt: 'asc' } });
    const geofenceVehicules = await src.geofenceVehicle.findMany({ where: { geofenceId: { in: geofences.map((g) => g.id) } } });
    const lieux = await src.fleetPlace.findMany({ where: { fleetId: { in: flotteIds } }, orderBy: { createdAt: 'asc' } });
    const plannings = await src.vehicleSchedule.findMany({ where: { vehicleId: { in: vehiculeIds } } });
    const planningsTravail = await src.vehicleWorkSchedule.findMany({ where: { vehicleId: { in: vehiculeIds } } });
    const profils = await src.surveillanceProfile.findMany({ where: { vehicleId: { in: vehiculeIds } } });
    const trajets = await src.trip.findMany({
      where: { vehicleId: { in: vehiculeIds }, startedAt: { gte: depuisTrajets }, endedAt: { not: null, lt: aujourdhui } },
      orderBy: { startedAt: 'asc' },
    });
    const trajetIds = trajets.map((t) => t.id);
    const analyses = await parLotsDIds(trajetIds, (lot) => src.tripAnalysis.findMany({ where: { tripId: { in: lot } } }));
    const arrets = await parLotsDIds(trajetIds, (lot) => src.tripFuelStop.findMany({ where: { tripId: { in: lot } } }));
    const pleins = await src.fuelFillUp.findMany({ where: { fleetId: { in: flotteIds }, filledAt: { gte: depuisTrajets, lt: aujourdhui } } });
    const stationIds = unique([...arrets.map((a) => a.stationId), ...pleins.map((p) => p.stationId), ...lieux.map((l) => l.stationId)]);
    const stations = await parLotsDIds(stationIds, (lot) => src.fuelStation.findMany({ where: { id: { in: lot } } }));
    const prix = await parLotsDIds(stationIds, (lot) =>
      src.fuelStationPrice.findMany({ where: { stationId: { in: lot }, capturedAt: { gte: depuisPositions } } }),
    );
    const alertes = await src.alert.findMany({
      where: { fleetId: { in: flotteIds }, createdAt: { gte: depuisTrajets, lt: aujourdhui } },
      orderBy: { createdAt: 'asc' },
    });
    log(`Source : ${flottes.length} société(s), ${vehicules.length} véhicules, ${boitiers.length} boîtiers, ${conducteurs.length} conducteurs, ${trajets.length} trajets, ${alertes.length} alertes`);

    // ── 2. Correspondances et pseudonymes ────────────────────────────────────────────────
    const ids = new Correspondances(o.sel);
    const assainisseur = new Assainisseur();
    const idFlotteDemo = ids.marquer('Fleet', flottes[0]!.id);
    const ctx: Contexte = { sel: o.sel, nomFlotte: o.nomFlotte, idFlotteDemo, maintenant, ids, assainisseur };
    for (const f of flottes) assainisseur.ajouter(f.name, o.nomFlotte);

    const plaques = new Map<string, string>();
    const plaquesPrises = new Set<string>();
    for (const v of vehicules) {
      let plaque = plaqueDemo(o.sel, v.plate);
      for (let t = 1; plaquesPrises.has(plaque); t++) plaque = plaqueDemo(o.sel, v.plate, t);
      plaquesPrises.add(plaque);
      plaques.set(v.id, plaque);
      assainisseur.ajouter(v.plate, plaque);
    }
    const imeis = new Map<string, string>();
    const imeisPris = new Set<string>();
    for (const b of boitiers) {
      let imei = imeiDemo(o.sel, b.imei);
      for (let t = 1; imeisPris.has(imei); t++) imei = imeiDemo(o.sel, b.imei, t);
      imeisPris.add(imei);
      imeis.set(b.id, imei);
      assainisseur.ajouter(b.imei, imei);
    }
    const identites = new Map<string, { firstName: string; lastName: string }>();
    const identitesPrises = new Set<string>();
    for (const c of conducteurs) {
      let identite = identiteDemo(o.sel, c.id);
      for (let t = 1; identitesPrises.has(`${identite.firstName} ${identite.lastName}`); t++) identite = identiteDemo(o.sel, c.id, t);
      identitesPrises.add(`${identite.firstName} ${identite.lastName}`);
      identites.set(c.id, identite);
      assainisseur.ajouter(`${c.firstName} ${c.lastName}`, `${identite.firstName} ${identite.lastName}`);
    }

    for (const c of conducteurs) ids.marquer('Driver', c.id);
    for (const v of vehicules) ids.marquer('Vehicle', v.id);
    for (const b of boitiers) ids.marquer('Tracker', b.id);
    for (const g of groupes) ids.marquer('VehicleGroup', g.id);
    for (const g of geofences) ids.marquer('Geofence', g.id);
    for (const s of stations) ids.marquer('FuelStation', s.id, s.id);
    for (const l of lieux) ids.marquer('FleetPlace', l.id);
    for (const t of trajets) ids.marquer('Trip', t.id);

    // Les groupes portent une contrainte d'unicité (société, nom) : deux sociétés source fusionnées
    // peuvent avoir « Nuit » toutes les deux. La seconde devient « Nuit (2) ».
    const nomsGroupes = new Map<string, string>();
    const nomsPris = new Set<string>();
    for (const g of groupes) {
      let nom = g.name;
      for (let n = 2; nomsPris.has(nom.toLowerCase()); n++) nom = `${g.name} (${n})`;
      nomsPris.add(nom.toLowerCase());
      nomsGroupes.set(g.id, nom);
    }
    // Même contrainte sur (société, station) pour les lieux : la seconde occurrence perd son lien.
    const stationsDeLieu = new Map<string, string | null>();
    const stationsPrises = new Set<string>();
    for (const l of lieux) {
      const station = ids.siImporte('FuelStation', l.stationId);
      if (station && stationsPrises.has(station)) stationsDeLieu.set(l.id, null);
      else {
        if (station) stationsPrises.add(station);
        stationsDeLieu.set(l.id, station);
      }
    }

    // ── 3. Écriture dans la cible — une seule transaction ─────────────────────────────────
    const bilan = await o.cible.$transaction(
      async (tx) => {
        // Le lien conducteur → compte (posé par le seed pour le compte « conducteur » de la démo)
        // est préservé : on le lit avant d'écrire, on ne le recopie jamais depuis la source.
        const liensComptes = new Map(
          (await tx.driver.findMany({ where: { userId: { not: null } }, select: { id: true, userId: true } })).map((d) => [d.id, d.userId]),
        );

        const flotte = transformerFlotte(flottes[0]!, ctx);
        await tx.fleet.upsert({ where: { id: idFlotteDemo }, create: flotte, update: sansId(flotte) });
        const abo = abonnementDemo(ctx);
        await tx.fleetSubscription.upsert({ where: { fleetId: idFlotteDemo }, create: abo, update: sansId(abo) });
        const rapport = planningRapportDemo(ctx);
        await tx.fleetReportSchedule.upsert({ where: { fleetId: idFlotteDemo }, create: rapport, update: rapport });

        for (const c of conducteurs) {
          const ligne = transformerConducteur(c, ctx, identites.get(c.id)!);
          const { id, userId: _ignore, ...maj } = ligne;
          void _ignore;
          await tx.driver.upsert({ where: { id: id as string }, create: ligne, update: maj });
        }
        for (const v of vehicules) {
          const ligne = transformerVehicule(v, ctx, plaques.get(v.id)!);
          await tx.vehicle.upsert({ where: { id: ligne.id as string }, create: ligne, update: sansId(ligne) });
        }
        for (const b of boitiers) {
          const ligne = transformerBoitier(b, ctx, imeis.get(b.id)!);
          await tx.tracker.upsert({ where: { id: ligne.id as string }, create: ligne, update: sansId(ligne) });
        }
        for (const g of groupes) {
          const ligne = transformerGroupe(g, ctx, nomsGroupes.get(g.id)!);
          await tx.vehicleGroup.upsert({ where: { id: ligne.id as string }, create: ligne, update: sansId(ligne) });
        }
        let indexZone = 0;
        for (const g of geofences) {
          const ligne = transformerGeofence(g, ctx, ++indexZone);
          await tx.geofence.upsert({ where: { id: ligne.id as string }, create: ligne, update: sansId(ligne) });
        }
        for (const lot of lots(stations)) await tx.fuelStation.createMany({ data: lot.map(transformerStation), skipDuplicates: true });
        for (const lot of lots(prix)) await tx.fuelStationPrice.createMany({ data: lot.map(transformerPrix), skipDuplicates: true });
        const indexParGenre = new Map<string, number>();
        for (const l of lieux) {
          const index = (indexParGenre.get(l.kind) ?? 0) + 1;
          indexParGenre.set(l.kind, index);
          const ligne = transformerLieu(l, ctx, index, stationsDeLieu.get(l.id) ?? null);
          await tx.fleetPlace.upsert({ where: { id: ligne.id as string }, create: ligne, update: sansId(ligne) });
        }
        for (const p of plannings) {
          const ligne = transformerPlanning(p, ctx);
          await tx.vehicleSchedule.upsert({ where: { id: ligne.id as string }, create: ligne, update: sansId(ligne) });
        }
        for (const p of planningsTravail) {
          const ligne = transformerPlanningTravail(p, ctx);
          await tx.vehicleWorkSchedule.upsert({ where: { id: ligne.id as string }, create: ligne, update: sansId(ligne) });
        }
        for (const p of profils) {
          const ligne = transformerProfilSurveillance(p, ctx);
          await tx.surveillanceProfile.upsert({ where: { id: ligne.id as string }, create: ligne, update: sansId(ligne) });
        }

        // Ce que la source n'a plus, la démo ne l'a plus — sauf les comptes et leurs droits.
        const vehiculesDemo = ids.idsImportes('Vehicle');
        const disparus = await tx.vehicle.findMany({ where: { fleetId: idFlotteDemo, id: { notIn: vehiculesDemo } }, select: { id: true } });
        if (disparus.length > 0) {
          const idsDisparus = disparus.map((d) => d.id);
          // `Mission.vehicle` est en `Restrict` : une mission créée sur la démo bloquerait la suppression.
          await tx.mission.deleteMany({ where: { vehicleId: { in: idsDisparus } } });
          await tx.vehicle.deleteMany({ where: { id: { in: idsDisparus } } });
        }
        await tx.tracker.deleteMany({ where: { id: { notIn: ids.idsImportes('Tracker') } } });
        await tx.driver.deleteMany({ where: { fleetId: idFlotteDemo, id: { notIn: ids.idsImportes('Driver') } } });
        await tx.vehicleGroup.deleteMany({ where: { fleetId: idFlotteDemo, id: { notIn: ids.idsImportes('VehicleGroup') } } });
        await tx.geofence.deleteMany({ where: { fleetId: idFlotteDemo, id: { notIn: ids.idsImportes('Geofence') } } });
        await tx.fleetPlace.deleteMany({ where: { fleetId: idFlotteDemo, id: { notIn: ids.idsImportes('FleetPlace') } } });
        await tx.vehicleSchedule.deleteMany({
          where: { vehicleId: { in: vehiculesDemo }, id: { notIn: plannings.map((p) => ids.id('VehicleSchedule', p.id)) } },
        });
        await tx.vehicleWorkSchedule.deleteMany({
          where: { vehicleId: { in: vehiculesDemo }, id: { notIn: planningsTravail.map((p) => ids.id('VehicleWorkSchedule', p.id)) } },
        });
        await tx.surveillanceProfile.deleteMany({
          where: { vehicleId: { in: vehiculesDemo }, id: { notIn: profils.map((p) => ids.id('SurveillanceProfile', p.id)) } },
        });

        // Rattachements : vidés puis recréés (clés composites, pas d'upsert utile).
        await tx.vehicleGroupAssignment.deleteMany({ where: { vehicleId: { in: vehiculesDemo } } });
        for (const lot of lots(affectations)) await tx.vehicleGroupAssignment.createMany({ data: lot.map((a) => transformerAffectation(a, ctx)), skipDuplicates: true });
        await tx.geofenceVehicle.deleteMany({ where: { vehicleId: { in: vehiculesDemo } } });
        for (const lot of lots(geofenceVehicules)) await tx.geofenceVehicle.createMany({ data: lot.map((g) => transformerGeofenceVehicule(g, ctx)), skipDuplicates: true });

        // Les liens conducteur → compte, remis tels qu'ils étaient.
        for (const [driverId, userId] of liensComptes) {
          if (userId && ids.idsImportes('Driver').includes(driverId)) {
            await tx.driver.update({ where: { id: driverId }, data: { userId } });
          }
        }

        // ── VOLUME : la base de démo ne contient que de la démo ; on vide, puis on recrée. ──
        await tx.tripFuelStop.deleteMany({});
        await tx.tripAnalysis.deleteMany({});
        await tx.alert.deleteMany({});
        await tx.engineControlCommand.deleteMany({});
        await tx.trackerCommand.deleteMany({});
        await tx.trip.deleteMany({});
        await tx.fuelFillUp.deleteMany({});
        await tx.positionSamplingDecision.deleteMany({});
        await tx.position.deleteMany({});
        await tx.demoReplayFrame.deleteMany({});

        for (const lot of lots(trajets)) await tx.trip.createMany({ data: lot.map((t) => transformerTrajet(t, ctx)) });
        for (const lot of lots(analyses)) await tx.tripAnalysis.createMany({ data: lot.map((a) => transformerAnalyse(a, ctx)) });
        for (const lot of lots(arrets)) await tx.tripFuelStop.createMany({ data: lot.map((a) => transformerArretCarburant(a, ctx)) });
        for (const lot of lots(pleins)) await tx.fuelFillUp.createMany({ data: lot.map((p) => transformerPlein(p, ctx)) });
        for (const lot of lots(alertes)) await tx.alert.createMany({ data: lot.map((a) => transformerAlerte(a, ctx)) });

        // Positions : lues page par page dans la source, écrites au fil de l'eau.
        let positions = 0;
        for (const b of boitiers) {
          const trackerIdDemo = ids.id('Tracker', b.id);
          let borne = depuisPositions;
          let premiere = true;
          for (;;) {
            const page = await src.position.findMany({
              where: { trackerId: b.id, timestamp: { [premiere ? 'gte' : 'gt']: borne, lt: aujourdhui } },
              orderBy: { timestamp: 'asc' },
              take: PAGE_POSITIONS,
            });
            if (page.length === 0) break;
            for (const lot of lots(page)) await tx.position.createMany({ data: lot.map((p) => transformerPosition(p, trackerIdDemo)) });
            positions += page.length;
            borne = page[page.length - 1]!.timestamp;
            premiere = false;
            if (page.length < PAGE_POSITIONS) break;
          }
        }

        // La semaine de rejeu : les 7 jours pleins avant aujourd'hui, réindexés en heure locale.
        // Jour par jour et boîtier par boîtier : une requête bornée à une journée, jamais la
        // semaine entière d'un coup en mémoire.
        let tramesRejeu = 0;
        for (const b of boitiers) {
          const imei = imeis.get(b.id)!;
          for (let jour = 7; jour >= 1; jour--) {
            const de = joursAvant(aujourdhui, jour);
            const a = joursAvant(aujourdhui, jour - 1);
            const lignes = await src.$queryRaw<TrameSemaine[]>`
              SELECT EXTRACT(ISODOW FROM (("timestamp" AT TIME ZONE 'UTC') AT TIME ZONE ${FLEET_TIME_ZONE}))::int AS "weekday",
                     (EXTRACT(EPOCH FROM ((("timestamp" AT TIME ZONE 'UTC') AT TIME ZONE ${FLEET_TIME_ZONE})::time)))::int AS "secondOfDay",
                     "lat", "lng", "speedKmh", "heading", "altitude", "ignition", "valid"
              FROM "positions"
              WHERE "trackerId" = ${b.id}::uuid AND "timestamp" >= ${de} AND "timestamp" < ${a}
              ORDER BY "timestamp"`;
            for (const lot of lots(lignes)) await tx.demoReplayFrame.createMany({ data: lot.map((l) => transformerTrameRejeu(l, imei)) });
            tramesRejeu += lignes.length;
          }
        }

        const resultat: BilanImport = {
          flotte: o.nomFlotte,
          societesSource: flottes.length,
          vehicules: vehicules.length,
          boitiers: boitiers.length,
          conducteurs: conducteurs.length,
          groupes: groupes.length,
          geofences: geofences.length,
          lieux: lieux.length,
          stations: stations.length,
          trajets: trajets.length,
          analyses: analyses.length,
          alertes: alertes.length,
          positions,
          tramesRejeu,
          dureeMs: Date.now() - debut,
          fenetre: {
            trajetsDepuis: depuisTrajets.toISOString(),
            positionsDepuis: depuisPositions.toISOString(),
            jusqua: aujourdhui.toISOString(),
            semaineRejeuDepuis: depuisRejeu.toISOString(),
          },
        };
        return resultat;
      },
      { timeout: 45 * 60_000, maxWait: 30_000 },
    );

    await journaliser(o.cible, 'SUCCESS', resumer(bilan), bilan as unknown as Prisma.InputJsonValue);
    log(`Import terminé en ${bilan.dureeMs} ms — ${resumer(bilan)}`);
    return bilan;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Les garde-fous sont passés (on est après eux) : la cible est bien la démo, on peut y consigner
    // l'échec. La première ligne utile dans `detail` (c'est elle que la carte affiche), le message
    // entier dans `meta`.
    const premiereLigne = message.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? 'erreur sans message';
    await journaliser(o.cible, 'FAILURE', `Import en échec : ${premiereLigne}`.slice(0, 500), {
      dureeMs: Date.now() - debut,
      message: message.slice(0, 4000),
    }).catch(() => undefined);
    throw err;
  }
}

function sansId<T extends { id?: unknown }>(ligne: T): Omit<T, 'id'> {
  const { id: _id, ...reste } = ligne;
  void _id;
  return reste;
}

function resumer(b: BilanImport): string {
  return `${b.vehicules} véhicules, ${b.boitiers} boîtiers, ${b.conducteurs} conducteurs, ${b.trajets} trajets, ${b.alertes} alertes, ${b.positions} positions, ${b.tramesRejeu} trames de rejeu (${b.societesSource} société(s) source)`;
}

async function journaliser(cible: PrismaClient, status: 'SUCCESS' | 'FAILURE', detail: string, meta: Prisma.InputJsonValue): Promise<void> {
  await cible.systemActivityLog.create({
    data: {
      category: JOURNAL_DEMO.categorie,
      action: JOURNAL_DEMO.passage,
      status,
      actor: 'importeur',
      target: 'base de démonstration',
      detail,
      meta,
    },
  });
}
