/* eslint-disable no-console */
/**
 * Seed JETABLE de données de vérif visuelle (instance isolée uniquement).
 * NE PAS lancer en prod. Crée une petite flotte réaliste (véhicules, conducteurs,
 * trackers+positions autour de Toulouse, assignations de groupes, alertes, users
 * multi-rôles, événements agenda) pour rendre les écrans reconstruits avec des vraies lignes.
 *
 * Usage : npx ts-node -r dotenv/config prisma/seed-verify-data.ts
 */
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  UserRole,
  VehicleType,
  InstallationEnergy,
  TrackerStatus,
  AlertType,
  AlertSeverity,
  VehicleEventType,
  VehicleEventStatus,
} from '@prisma/client';
import { randomUUID } from 'crypto';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const TLS = { lat: 43.6045, lng: 1.4442 }; // Toulouse centre
const now = Date.now();
const minsAgo = (m: number) => new Date(now - m * 60_000);
const daysFrom = (d: number) => new Date(now + d * 86_400_000);

async function main(): Promise<void> {
  const fleet = await prisma.fleet.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!fleet) throw new Error('Aucune flotte — lance prisma db seed d’abord.');
  const fleetId = fleet.id;
  const admin = await prisma.user.findFirst({
    where: { role: UserRole.SUPER_ADMIN, isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!admin) throw new Error('Aucun admin.');

  // --- reset idempotent (fleet-scopé + users de démo) ---
  await prisma.alert.deleteMany({ where: { fleetId } });
  await prisma.vehicleEvent.deleteMany({ where: { fleetId } });
  await prisma.vehicleGroupAssignment.deleteMany({ where: { vehicle: { fleetId } } });
  const oldVeh = await prisma.vehicle.findMany({ where: { fleetId }, select: { id: true } });
  await prisma.tracker.deleteMany({ where: { vehicleId: { in: oldVeh.map((v) => v.id) } } });
  await prisma.vehicle.deleteMany({ where: { fleetId } });
  await prisma.driver.deleteMany({ where: { fleetId } });
  await prisma.user.deleteMany({ where: { email: { endsWith: '@demo.tracky' } } });

  // --- groupes (créés par seed-test-fleet, sinon on les fait) ---
  const grpNames = ['Nuit', 'Jour'];
  const groups: Record<string, string> = {};
  for (const name of grpNames) {
    const g = await prisma.vehicleGroup.upsert({
      where: { fleetId_name: { fleetId, name } },
      update: {},
      create: { fleetId, name },
    });
    groups[name] = g.id;
  }

  // --- conducteurs ---
  const drivers = await Promise.all(
    [
      { firstName: 'Karim', lastName: 'Benali', color: '#10E0A0' },
      { firstName: 'Sophie', lastName: 'Laurent', color: '#38BDF8' },
      { firstName: 'Marc', lastName: 'Dubois', color: '#F59E0B' },
    ].map((d) => prisma.driver.create({ data: { fleetId, ...d, isActive: true } })),
  );

  // --- véhicules + trackers + positions ---
  const spec = [
    { plate: 'GA-114-AA', brand: 'Renault', model: 'Trafic', type: VehicleType.VAN, energy: InstallationEnergy.DIESEL, seats: 3, driver: 0, group: 'Jour', st: TrackerStatus.ONLINE, speed: 52, mins: 1, dLat: 0.004, dLng: 0.006 },
    { plate: 'FT-880-QP', brand: 'Peugeot', model: 'Boxer', type: VehicleType.VAN, energy: InstallationEnergy.DIESEL, seats: 3, driver: 1, group: 'Jour', st: TrackerStatus.IDLE, speed: 0, mins: 4, dLat: -0.008, dLng: 0.011 },
    { plate: 'EJ-402-XR', brand: 'Citroën', model: 'Berlingo', type: VehicleType.VAN, energy: InstallationEnergy.ELECTRIQUE, seats: 2, driver: 2, group: 'Nuit', st: TrackerStatus.ONLINE, speed: 31, mins: 2, dLat: 0.012, dLng: -0.004 },
    { plate: 'DK-771-ZL', brand: 'Ford', model: 'Transit', type: VehicleType.TRUCK, energy: InstallationEnergy.DIESEL, seats: 3, driver: null, group: 'Nuit', st: TrackerStatus.OFFLINE, speed: 0, mins: 320, dLat: -0.02, dLng: -0.015 },
    { plate: 'HB-259-MC', brand: 'Toyota', model: 'ProAce', type: VehicleType.VAN, energy: InstallationEnergy.HYBRIDE, seats: 2, driver: null, group: 'Jour', st: TrackerStatus.ONLINE, speed: 18, mins: 3, dLat: 0.006, dLng: 0.02 },
    { plate: 'IC-633-VB', brand: 'Mercedes', model: 'Sprinter', type: VehicleType.TRUCK, energy: InstallationEnergy.DIESEL, seats: 3, driver: 0, group: 'Nuit', st: TrackerStatus.IDLE, speed: 0, mins: 12, dLat: -0.003, dLng: 0.009 },
  ];

  const vehicles: { id: string; plate: string; trackerId: string; group: string }[] = [];
  for (const s of spec) {
    const v = await prisma.vehicle.create({
      data: {
        fleetId,
        plate: s.plate,
        brand: s.brand,
        model: s.model,
        type: s.type,
        energy: s.energy,
        seats: s.seats,
        childSeats: s.group === 'Nuit' ? 1 : 0,
        features: s.energy === InstallationEnergy.ELECTRIQUE ? ['clim', 'gps'] : ['gps'],
        currentDriverId: s.driver != null ? drivers[s.driver].id : null,
        lastOdometerKm: 40000 + Math.round(s.dLat * 100000),
      },
    });
    const lat = TLS.lat + s.dLat;
    const lng = TLS.lng + s.dLng;
    const tr = await prisma.tracker.create({
      data: {
        imei: '86000000000' + (1000 + vehicles.length),
        status: s.st,
        vehicleId: v.id,
        lastSeenAt: minsAgo(s.mins),
        lastPositionAt: minsAgo(s.mins),
        lastLat: lat,
        lastLng: lng,
        lastSpeedKmh: s.speed,
        lastIgnition: s.speed > 0,
        lastValid: true,
      },
    });
    // quelques positions récentes
    for (let i = 0; i < 3; i++) {
      await prisma.position.create({
        data: {
          trackerId: tr.id,
          lat: lat + i * 0.0006,
          lng: lng + i * 0.0006,
          speedKmh: Math.max(0, s.speed - i * 5),
          heading: 90,
          valid: true,
          ignition: s.speed > 0,
          timestamp: minsAgo(s.mins + i * 2),
        },
      });
    }
    await prisma.vehicleGroupAssignment.create({ data: { vehicleId: v.id, groupId: groups[s.group] } });
    vehicles.push({ id: v.id, plate: s.plate, trackerId: tr.id, group: s.group });
  }

  // --- alertes variées ---
  const alertSpec = [
    { v: 0, type: AlertType.OVERSPEED, sev: AlertSeverity.WARNING, title: 'Excès de vitesse', msg: '92 km/h en zone 50', mins: 8, ack: false },
    { v: 3, type: AlertType.POWER_CUT, sev: AlertSeverity.CRITICAL, title: 'Coupure d’alimentation', msg: 'Batterie débranchée', mins: 45, ack: false },
    { v: 2, type: AlertType.GEOFENCE_EXIT, sev: AlertSeverity.INFO, title: 'Sortie de zone', msg: 'Sortie de « Dépôt Nord »', mins: 120, ack: true },
    { v: 5, type: AlertType.MOVEMENT_IDLE, sev: AlertSeverity.WARNING, title: 'Mouvement à l’arrêt', msg: 'Déplacement moteur coupé', mins: 20, ack: false },
    { v: 1, type: AlertType.LOW_BATTERY, sev: AlertSeverity.WARNING, title: 'Batterie faible', msg: 'Boîtier 11 %', mins: 200, ack: true },
    { v: 0, type: AlertType.HARSH_BRAKING, sev: AlertSeverity.INFO, title: 'Freinage brusque', msg: 'Décélération forte', mins: 15, ack: false },
  ];
  for (const a of alertSpec) {
    const veh = vehicles[a.v];
    await prisma.alert.create({
      data: {
        fleetId,
        vehicleId: veh.id,
        trackerId: veh.trackerId,
        type: a.type,
        severity: a.sev,
        title: a.title,
        message: a.msg,
        latitude: TLS.lat,
        longitude: TLS.lng,
        createdAt: minsAgo(a.mins),
        acknowledgedAt: a.ack ? minsAgo(a.mins - 5) : null,
        acknowledgedBy: a.ack ? admin.id : null,
      },
    });
  }

  // --- users multi-rôles (pour la table + matrice de permissions) ---
  const userSpec = [
    { email: 'admin.flotte@demo.tracky', firstName: 'Nadia', lastName: 'Réault', role: UserRole.FLEET_ADMIN },
    { email: 'manager.jour@demo.tracky', firstName: 'Thomas', lastName: 'Girard', role: UserRole.FLEET_MANAGER },
    { email: 'manager.nuit@demo.tracky', firstName: 'Lucie', lastName: 'Moreau', role: UserRole.FLEET_MANAGER },
    { email: 'observateur@demo.tracky', firstName: 'Paul', lastName: 'Simon', role: UserRole.VIEWER },
    { email: 'veilleur@demo.tracky', firstName: 'Yassine', lastName: 'Amrani', role: UserRole.NIGHT_WATCHMAN },
  ];
  for (const u of userSpec) {
    await prisma.user.create({
      data: { authUserId: randomUUID(), fleetId, isActive: true, ...u },
    });
  }

  // --- événements agenda (maintenance / incident / réservation) ---
  const eventSpec = [
    { v: 1, type: VehicleEventType.MAINTENANCE, status: VehicleEventStatus.PLANNED, title: 'Révision 40 000 km', cat: 'OIL_CHANGE', start: daysFrom(3), block: false, sev: null },
    { v: 3, type: VehicleEventType.INCIDENT, status: VehicleEventStatus.OPEN, title: 'Pneu crevé AV droit', cat: 'TIRE', start: minsAgo(90), block: true, sev: 'HIGH' },
    { v: 4, type: VehicleEventType.RESERVATION, status: VehicleEventStatus.CONFIRMED, title: 'Réservation chantier Blagnac', cat: null, start: daysFrom(1), block: false, sev: null },
    { v: 0, type: VehicleEventType.MAINTENANCE, status: VehicleEventStatus.DONE, title: 'Contrôle technique', cat: 'TECHNICAL_INSPECTION', start: daysFrom(-5), block: false, sev: null },
  ];
  for (const e of eventSpec) {
    await prisma.vehicleEvent.create({
      data: {
        fleetId,
        vehicleId: vehicles[e.v].id,
        type: e.type,
        category: e.cat,
        status: e.status,
        severity: e.sev,
        title: e.title,
        startAt: e.start,
        endAt: e.type === VehicleEventType.RESERVATION ? new Date(e.start.getTime() + 6 * 3600_000) : null,
        allDay: e.type !== VehicleEventType.RESERVATION,
        blocksVehicle: e.block,
        createdBy: admin.id,
        source: 'MANUAL',
      },
    });
  }

  const counts = {
    vehicles: vehicles.length,
    drivers: drivers.length,
    alerts: alertSpec.length,
    users: userSpec.length,
    events: eventSpec.length,
  };
  console.log('OK seed-verify-data →', JSON.stringify(counts));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
