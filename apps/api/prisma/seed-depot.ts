/**
 * Espace dépôt (2026-08) — jeu d'essai local pour le bloc A.
 *
 * Recrée le CAS DE RÉFÉRENCE du livrable (A0 § Le besoin) : un transporteur, sept
 * camions, et un dépôt qui ne doit en voir que quelques-uns — jamais les autres.
 *
 * C'est ce scénario précis qui permet de vérifier l'isolation autrement que par des
 * mocks : avec sept camions en base, un dépôt qui en verrait huit, ou zéro, se
 * remarque immédiatement.
 *
 *   pnpm --filter @vizyo/tracky-api exec ts-node prisma/seed-depot.ts
 *
 * Idempotent : relançable sans dupliquer. Ne touche QUE la flotte de démonstration.
 */
import { MissionStatus, PrismaClient, UserRole, VehicleEventStatus, VehicleEventType } from '@prisma/client';

const prisma = new PrismaClient();

const PLAQUES = ['FR-482-BX', 'FR-119-TD', 'FR-207-QM', 'FR-556-KZ', 'FR-731-VL', 'FR-864-RN', 'FR-903-HC'];

async function main(): Promise<void> {
  const fleet = await prisma.fleet.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!fleet) throw new Error('Aucune flotte — lance d\'abord `prisma/seed.ts`.');
  console.log(`Flotte : ${fleet.name} (${fleet.id})`);

  // ── Les 7 camions du cas de référence ─────────────────────────────────────
  const vehicules = [];
  for (const [i, plate] of PLAQUES.entries()) {
    const v = await prisma.vehicle.upsert({
      where: { fleetId_plate: { fleetId: fleet.id, plate } },
      update: {},
      create: {
        fleetId: fleet.id,
        plate,
        brand: i % 2 === 0 ? 'Renault' : 'Iveco',
        model: i % 2 === 0 ? 'D 12 t' : 'Daily',
        type: 'TRUCK',
      },
    });
    // Un boîtier avec une position fraîche : sans lui, aucune mission ne démarre.
    await prisma.tracker.upsert({
      where: { imei: `86000000000${String(i).padStart(4, '0')}` },
      update: { lastPositionAt: new Date(), lastLat: 43.6 + i * 0.01, lastLng: 1.44 + i * 0.01 },
      create: {
        imei: `86000000000${String(i).padStart(4, '0')}`,
        vehicleId: v.id,
        lastPositionAt: new Date(),
        lastLat: 43.6 + i * 0.01,
        lastLng: 1.44 + i * 0.01,
        lastSpeedKmh: 0,
      },
    });
    vehicules.push(v);
  }
  console.log(`${vehicules.length} camions prêts (avec boîtier et position fraîche)`);

  // ── Deux comptes dépôt : le nôtre, et un CONCURRENT ───────────────────────
  // Le second est essentiel : sans lui, on ne peut pas vérifier qu'un dépôt ne voit
  // pas les missions d'un autre — le test le plus important d'A1 § 8 (critère 5).
  const depotA = await prisma.user.upsert({
    where: { email: 'depot.fenouillet@exemple.fr' },
    update: { role: UserRole.DEPOT, fleetId: fleet.id, isActive: true },
    create: {
      authUserId: 'seed-depot-a',
      email: 'depot.fenouillet@exemple.fr',
      firstName: 'Dépôt',
      lastName: 'Fenouillet',
      role: UserRole.DEPOT,
      fleetId: fleet.id,
    },
  });
  const depotB = await prisma.user.upsert({
    where: { email: 'depot.muret@exemple.fr' },
    update: { role: UserRole.DEPOT, fleetId: fleet.id, isActive: true },
    create: {
      authUserId: 'seed-depot-b',
      email: 'depot.muret@exemple.fr',
      firstName: 'Dépôt',
      lastName: 'Muret',
      role: UserRole.DEPOT,
      fleetId: fleet.id,
    },
  });
  console.log(`2 dépôts : ${depotA.email} et ${depotB.email}`);

  // Invariant A1 § 7, vérifié plutôt que supposé : un DEPOT n'a JAMAIS de scope véhicule.
  const scopes = await prisma.userVehicleAccess.count({
    where: { userId: { in: [depotA.id, depotB.id] } },
  });
  if (scopes > 0) throw new Error(`INVARIANT VIOLÉ : ${scopes} ligne(s) UserVehicleAccess sur un dépôt`);

  // ── Les missions, calées pour couvrir les 4 cas de la fenêtre ─────────────
  const maintenant = Date.now();
  const h = (decalage: number) => new Date(maintenant + decalage * 3_600_000);

  const scenarios = [
    // Dépôt A : en cours → sa position DOIT être servie.
    { veh: 0, depot: depotA.id, debut: h(-1), fin: h(2), statut: MissionStatus.IN_PROGRESS, ref: 'M-0001', de: 'Fenouillet', vers: 'Muret' },
    // Dépôt A : planifiée → visible dans la liste, position REFUSÉE (A1 § 8, critère 2).
    { veh: 1, depot: depotA.id, debut: h(4), fin: h(7), statut: MissionStatus.PLANNED, ref: 'M-0002', de: 'Fenouillet', vers: 'Colomiers' },
    // Dépôt A : terminée → dans l'historique, position REFUSÉE (critère 4).
    { veh: 2, depot: depotA.id, debut: h(-8), fin: h(-5), statut: MissionStatus.DONE, ref: 'M-0003', de: 'Fenouillet', vers: 'Blagnac' },
    // Dépôt A : en retard → position TOUJOURS servie (l'invariant contre-intuitif).
    { veh: 3, depot: depotA.id, debut: h(-4), fin: h(-1), statut: MissionStatus.LATE, ref: 'M-0004', de: 'Fenouillet', vers: 'Tournefeuille' },
    // Dépôt B : en cours → INVISIBLE du dépôt A (critère 5).
    { veh: 4, depot: depotB.id, debut: h(-1), fin: h(2), statut: MissionStatus.IN_PROGRESS, ref: 'M-0005', de: 'Muret', vers: 'Portet' },
    // Mission interne, sans dépôt → invisible de TOUS les dépôts.
    { veh: 5, depot: null, debut: h(-1), fin: h(2), statut: MissionStatus.IN_PROGRESS, ref: 'M-0006', de: 'Dépôt central', vers: 'Atelier' },
    // Le 7e camion (index 6) n'a AUCUNE mission : c'est le témoin. Aucun dépôt ne
    // doit jamais le voir, sous aucun angle.
  ];

  for (const s of scenarios) {
    const v = vehicules[s.veh];
    const mission = await prisma.mission.upsert({
      where: { fleetId_ref: { fleetId: fleet.id, ref: s.ref } },
      update: { status: s.statut, startAt: s.debut, endAt: s.fin, depotUserId: s.depot },
      create: {
        ref: s.ref,
        fleetId: fleet.id,
        originLabel: s.de,
        destLabel: s.vers,
        startAt: s.debut,
        endAt: s.fin,
        vehicleId: v.id,
        depotUserId: s.depot,
        status: s.statut,
        ...(s.statut === MissionStatus.DONE ? { actualEndAt: s.fin } : {}),
      },
    });

    // L'événement d'agenda — c'est LUI qui rend le véhicule indisponible.
    const dejaPose = await prisma.vehicleEvent.findFirst({
      where: { type: VehicleEventType.MISSION, metadata: { path: ['missionId'], equals: mission.id } },
      select: { id: true },
    });
    if (!dejaPose) {
      await prisma.vehicleEvent.create({
        data: {
          fleetId: fleet.id,
          vehicleId: v.id,
          type: VehicleEventType.MISSION,
          status:
            s.statut === MissionStatus.DONE
              ? VehicleEventStatus.DONE
              : s.statut === MissionStatus.PLANNED
                ? VehicleEventStatus.PLANNED
                : VehicleEventStatus.IN_PROGRESS,
          title: `Mission ${s.ref} · ${s.de} → ${s.vers}`,
          startAt: s.debut,
          endAt: s.fin,
          allDay: false,
          blocksVehicle: true,
          createdBy: depotA.id,
          source: 'SYSTEM',
          metadata: { missionId: mission.id, missionRef: s.ref },
        },
      });
    }
    console.log(`  ${s.ref} · ${v.plate} · ${s.statut} · dépôt ${s.depot ? (s.depot === depotA.id ? 'A' : 'B') : 'aucun (interne)'}`);
  }

  console.log('\n── Ce qu\'on doit observer ──────────────────────────────────');
  console.log(`  Dépôt A (${depotA.email}) : 4 missions, 2 positions servies (M-0001 en cours, M-0004 en retard)`);
  console.log(`  Dépôt B (${depotB.email}) : 1 mission`);
  console.log(`  ${PLAQUES[6]} : AUCUNE mission — invisible de tout dépôt, c'est le témoin`);
  console.log(`  Véhicules indisponibles attendus dans l'onglet Missions : 5 (M-0003 est terminée)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
